const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");

const {
  initializeApp,
  cert,
} = require("firebase-admin/app");

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

const {
  getAuth,
} = require("firebase-admin/auth");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

// =====================================================
// FIREBASE ADMIN
// =====================================================

let serviceAccount;

try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );
} catch (err) {
  console.error(
    "FIREBASE_SERVICE_ACCOUNT is missing or invalid"
  );

  process.exit(1);
}

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();
const adminAuth = getAuth();

// =====================================================
// PAYSTACK SECRET
// =====================================================

const PAYSTACK_SECRET =
  process.env.PAYSTACK_SECRET;

// =====================================================
// HELPER: VERIFY FIREBASE USER
// =====================================================

async function verifyFirebaseUser(req) {
  const authorization =
    req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    throw new Error(
      "Missing Firebase authentication token"
    );
  }

  const idToken =
    authorization.replace("Bearer ", "");

  const decodedToken =
    await adminAuth.verifyIdToken(idToken);

  return decodedToken;
}

// =====================================================
// 1. INITIALIZE PAYMENT
// =====================================================

app.post(
  "/initialize-payment",
  async (req, res) => {
    try {
      const {
        email,
        amount,
        sellerId,
        orderId,
        productName,
      } = req.body;

      if (!email || !amount || !sellerId) {
        return res.status(400).json({
          error:
            "email, amount and sellerId are required",
        });
      }

      const amountInKobo =
        Math.round(Number(amount) * 100);

      if (
        !Number.isFinite(amountInKobo) ||
        amountInKobo <= 0
      ) {
        return res.status(400).json({
          error: "Invalid payment amount",
        });
      }

      const response =
        await axios.post(
          "https://api.paystack.co/transaction/initialize",
          {
            email,
            amount: amountInKobo,
            currency: "NGN",

            callback_url:
              "https://campus-mart-ashen.vercel.app/order-success",

            metadata: {
              sellerId,
              orderId: orderId || null,
              productName:
                productName ||
                "CampusMart Order",
            },
          },
          {
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET}`,

              "Content-Type":
                "application/json",
            },
          }
        );

      if (!response.data.status) {
        return res.status(400).json({
          error:
            response.data.message ||
            "Payment initialization failed",
        });
      }

      return res.json({
        success: true,

        authorization_url:
          response.data.data.authorization_url,

        reference:
          response.data.data.reference,
      });
    } catch (error) {
      console.error(
        "Initialize payment error:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        error: "Could not start payment",
      });
    }
  }
);

// =====================================================
// 2. PAYSTACK WEBHOOK
// =====================================================
//
// 5% CampusMart
// 95% Seller
//
// ALSO CREATES:
// earnings/{paystackReference}
//
// This means your Seller Earnings page can
// listen to the earnings collection in real time.
// =====================================================

app.post(
  "/paystack-webhook",
  async (req, res) => {
    try {
      // -------------------------------------------------
      // VERIFY PAYSTACK SIGNATURE
      // -------------------------------------------------

      const hash =
        crypto
          .createHmac(
            "sha512",
            PAYSTACK_SECRET
          )
          .update(
            JSON.stringify(req.body)
          )
          .digest("hex");

      const signature =
        req.headers[
          "x-paystack-signature"
        ];

      if (
        !signature ||
        hash !== signature
      ) {
        console.error(
          "Invalid Paystack webhook signature"
        );

        return res
          .status(401)
          .send("Invalid signature");
      }

      const event = req.body;

      // -------------------------------------------------
      // ONLY PROCESS SUCCESSFUL PAYMENTS
      // -------------------------------------------------

      if (
        event.event !==
        "charge.success"
      ) {
        return res
          .status(200)
          .send("OK");
      }

      const data = event.data;

      const metadata =
        data.metadata || {};

      const sellerId =
        metadata.sellerId;

      const orderId =
        metadata.orderId;

      const totalAmount =
        Number(data.amount || 0) / 100;

      const reference =
        data.reference;

      // -------------------------------------------------
      // SELLER MUST EXIST
      // -------------------------------------------------

      if (!sellerId) {
        console.warn(
          "Payment has no sellerId:",
          reference
        );

        return res
          .status(200)
          .send("OK");
      }

      if (
        !reference ||
        totalAmount <= 0
      ) {
        return res
          .status(200)
          .send("OK");
      }

      // -------------------------------------------------
      // CALCULATE COMMISSION
      // -------------------------------------------------

      const platformFee =
        Number(
          (
            totalAmount * 0.05
          ).toFixed(2)
        );

      const sellerAmount =
        Number(
          (
            totalAmount * 0.95
          ).toFixed(2)
        );

      // -------------------------------------------------
      // USE PAYSTACK REFERENCE AS DOCUMENT ID
      //
      // This prevents duplicate webhook processing.
      // -------------------------------------------------

      const earningRef =
        db
          .collection("earnings")
          .doc(reference);

      const existingEarning =
        await earningRef.get();

      if (existingEarning.exists) {
        console.log(
          `Payment ${reference} already processed.`
        );

        return res
          .status(200)
          .send("Already processed");
      }

      // -------------------------------------------------
      // SELLER DOCUMENT
      // -------------------------------------------------

      const sellerRef =
        db
          .collection("users")
          .doc(sellerId);

      // -------------------------------------------------
      // CREATE BATCH
      // -------------------------------------------------

      const batch =
        db.batch();

      // -------------------------------------------------
      // UPDATE SELLER BALANCE
      //
      // IMPORTANT:
      // Previously your code only updated
      // availableBalance.
      //
      // Now all three values update.
      // -------------------------------------------------

      batch.set(
        sellerRef,
        {
          availableBalance:
            FieldValue.increment(
              sellerAmount
            ),

          totalEarnings:
            FieldValue.increment(
              sellerAmount
            ),

          totalPlatformFees:
            FieldValue.increment(
              platformFee
            ),

          updatedAt:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      // -------------------------------------------------
      // CREATE EARNINGS RECORD
      // -------------------------------------------------

      batch.set(
        earningRef,
        {
          sellerId,

          orderId:
            orderId || null,

          type: "sale",

          title:
            orderId
              ? `Order #${String(
                  orderId
                )
                  .slice(0, 6)
                  .toUpperCase()}`
              : "CampusMart Sale",

          description:
            metadata.productName ||
            "Sale",

          amount:
            sellerAmount,

          gross:
            totalAmount,

          platformFee:
            platformFee,

          status:
            "Completed",

          paystackReference:
            reference,

          createdAt:
            FieldValue.serverTimestamp(),

          updatedAt:
            FieldValue.serverTimestamp(),
        }
      );

      // -------------------------------------------------
      // RECORD PLATFORM FEE
      // -------------------------------------------------

      batch.set(
        db
          .collection("platformFees")
          .doc(reference),
        {
          sellerId,

          orderId:
            orderId || null,

          totalAmount,

          platformFee,

          sellerAmount,

          paystackReference:
            reference,

          createdAt:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      // -------------------------------------------------
      // UPDATE ORDER
      // -------------------------------------------------

      if (orderId) {
        batch.set(
          db
            .collection("orders")
            .doc(orderId),
          {
            paymentStatus:
              "paid",

            paidAt:
              FieldValue.serverTimestamp(),

            paystackReference:
              reference,

            updatedAt:
              FieldValue.serverTimestamp(),
          },
          {
            merge: true,
          }
        );
      }

      // -------------------------------------------------
      // COMMIT EVERYTHING
      // -------------------------------------------------

      await batch.commit();

      console.log(
        "================================"
      );

      console.log(
        "PAYMENT SUCCESSFUL"
      );

      console.log(
        `Reference: ${reference}`
      );

      console.log(
        `Seller: ${sellerId}`
      );

      console.log(
        `Gross: ₦${totalAmount}`
      );

      console.log(
        `Platform fee: ₦${platformFee}`
      );

      console.log(
        `Seller receives: ₦${sellerAmount}`
      );

      console.log(
        "================================"
      );

      return res
        .status(200)
        .send("OK");
    } catch (error) {
      console.error(
        "Paystack webhook error:",
        error
      );

      return res
        .status(500)
        .send("Error");
    }
  }
);

// =====================================================
// 3. RESET SELLER EARNINGS
// =====================================================
//
// THIS WILL:
//
// DELETE:
// earnings/{sellerEarnings}
//
// RESET:
// users/{sellerId}.totalEarnings = 0
// users/{sellerId}.availableBalance = 0
// users/{sellerId}.totalPlatformFees = 0
//
// IT DOES NOT DELETE:
// withdrawals
// platformFees
// orders
//
// The seller must be authenticated and can only
// reset their own earnings.
// =====================================================

app.post(
  "/reset-earnings",
  async (req, res) => {
    try {
      // -------------------------------------------------
      // VERIFY LOGGED-IN SELLER
      // -------------------------------------------------

      const decodedUser =
        await verifyFirebaseUser(req);

      const authenticatedUid =
        decodedUser.uid;

      // -------------------------------------------------
      // NEVER TRUST sellerId FROM THE BODY
      //
      // The logged-in Firebase UID is used.
      // -------------------------------------------------

      const sellerId =
        authenticatedUid;

      console.log(
        `Resetting earnings for seller: ${sellerId}`
      );

      // -------------------------------------------------
      // FIND SELLER EARNINGS
      // -------------------------------------------------

      const earningsSnapshot =
        await db
          .collection("earnings")
          .where(
            "sellerId",
            "==",
            sellerId
          )
          .get();

      console.log(
        `Found ${earningsSnapshot.size} earnings records.`
      );

      // -------------------------------------------------
      // FIRESTORE BATCH LIMIT
      //
      // Firestore allows max 500 writes per batch.
      // We use 400 to stay safe.
      // -------------------------------------------------

      const docs =
        earningsSnapshot.docs;

      const chunkSize = 400;

      for (
        let i = 0;
        i < docs.length;
        i += chunkSize
      ) {
        const chunk =
          docs.slice(
            i,
            i + chunkSize
          );

        const batch =
          db.batch();

        chunk.forEach(
          (earningDoc) => {
            batch.delete(
              earningDoc.ref
            );
          }
        );

        await batch.commit();
      }

      // -------------------------------------------------
      // RESET SELLER BALANCES
      // -------------------------------------------------

      await db
        .collection("users")
        .doc(sellerId)
        .set(
          {
            totalEarnings: 0,

            availableBalance: 0,

            totalPlatformFees: 0,

            updatedAt:
              FieldValue.serverTimestamp(),
          },
          {
            merge: true,
          }
        );

      console.log(
        `Earnings reset completed for ${sellerId}`
      );

      return res.json({
        success: true,

        message:
          "Seller earnings have been reset.",

        deletedEarnings:
          earningsSnapshot.size,
      });
    } catch (error) {
      console.error(
        "Reset earnings error:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Could not reset earnings.",
      });
    }
  }
);

// =====================================================
// 4. REAL SELLER WITHDRAWAL
// =====================================================

app.post(
  "/process-withdrawal",
  async (req, res) => {
    try {
      const {
        sellerId,
        amount,
        bankName,
        bankCode,
        accountNumber,
        accountName,
      } = req.body;

      if (
        !sellerId ||
        !amount ||
        !bankCode ||
        !accountNumber ||
        !accountName
      ) {
        return res.status(400).json({
          error:
            "Missing required fields",
        });
      }

      if (
        Number(amount) < 1000
      ) {
        return res.status(400).json({
          error:
            "Minimum withdrawal is ₦1,000",
        });
      }

      // -------------------------------------------------
      // CHECK SELLER
      // -------------------------------------------------

      const sellerRef =
        db
          .collection("users")
          .doc(sellerId);

      const sellerSnap =
        await sellerRef.get();

      if (!sellerSnap.exists) {
        return res.status(404).json({
          error:
            "Seller not found",
        });
      }

      const sellerData =
        sellerSnap.data();

      const availableBalance =
        Number(
          sellerData.availableBalance ||
            0
        );

      if (
        availableBalance <
        Number(amount)
      ) {
        return res.status(400).json({
          error:
            "Insufficient balance",
        });
      }

      // -------------------------------------------------
      // CREATE PAYSTACK RECIPIENT
      // -------------------------------------------------

      const recipientRes =
        await axios.post(
          "https://api.paystack.co/transferrecipient",
          {
            type: "nuban",

            name: accountName,

            account_number:
              accountNumber,

            bank_code:
              bankCode,

            currency: "NGN",
          },
          {
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET}`,

              "Content-Type":
                "application/json",
            },
          }
        );

      if (
        !recipientRes.data.status
      ) {
        return res.status(400).json({
          error:
            recipientRes.data
              .message ||
            "Could not create recipient",
        });
      }

      const recipientCode =
        recipientRes.data.data
          .recipient_code;

      // -------------------------------------------------
      // INITIATE TRANSFER
      // -------------------------------------------------

      const transferReference =
        `WD_${sellerId}_${Date.now()}`;

      const transferRes =
        await axios.post(
          "https://api.paystack.co/transfer",
          {
            source: "balance",

            amount:
              Math.round(
                Number(amount) * 100
              ),

            recipient:
              recipientCode,

            reason:
              `CampusMart seller withdrawal - ${sellerId}`,

            reference:
              transferReference,
          },
          {
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET}`,

              "Content-Type":
                "application/json",
            },
          }
        );

      if (
        !transferRes.data.status
      ) {
        return res.status(400).json({
          error:
            transferRes.data.message ||
            "Transfer failed",
        });
      }

      // -------------------------------------------------
      // DEDUCT BALANCE
      // -------------------------------------------------

      const batch =
        db.batch();

      batch.update(
        sellerRef,
        {
          availableBalance:
            FieldValue.increment(
              -Number(amount)
            ),

          updatedAt:
            FieldValue.serverTimestamp(),
        }
      );

      // -------------------------------------------------
      // CREATE WITHDRAWAL RECORD
      // -------------------------------------------------

      const withdrawalRef =
        db
          .collection("withdrawals")
          .doc();

      batch.set(
        withdrawalRef,
        {
          sellerId,

          amount:
            Number(amount),

          bankName:
            bankName || "",

          bankCode,

          accountNumber,

          accountName,

          status:
            "Processing",

          paystackTransferCode:
            transferRes.data.data
              .transfer_code,

          paystackReference:
            transferRes.data.data
              .reference,

          createdAt:
            FieldValue.serverTimestamp(),

          updatedAt:
            FieldValue.serverTimestamp(),
        }
      );

      await batch.commit();

      return res.json({
        success: true,

        message:
          "Transfer initiated. Money will arrive in the seller's bank shortly.",

        transferCode:
          transferRes.data.data
            .transfer_code,
      });
    } catch (error) {
      console.error(
        "Withdrawal error:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        error:
          error.response?.data?.message ||
          "Could not process withdrawal. Please try again.",
      });
    }
  }
);

// =====================================================
// 5. PLATFORM FEE WITHDRAWAL
// =====================================================

app.post(
  "/process-platform-withdrawal",
  async (req, res) => {
    try {
      const {
        amount,
        bankName,
        bankCode,
        accountNumber,
        accountName,
        adminId,
      } = req.body;

      if (
        !amount ||
        !bankCode ||
        !accountNumber ||
        !accountName
      ) {
        return res.status(400).json({
          error:
            "Missing required fields",
        });
      }

      if (
        Number(amount) < 1000
      ) {
        return res.status(400).json({
          error:
            "Minimum withdrawal is ₦1,000",
        });
      }

      // -------------------------------------------------
      // CALCULATE PLATFORM FEES
      // -------------------------------------------------

      const feesSnap =
        await db
          .collection("platformFees")
          .get();

      let totalFees = 0;

      feesSnap.forEach((d) => {
        totalFees +=
          Number(
            d.data().platformFee
          ) || 0;
      });

      // -------------------------------------------------
      // ALREADY WITHDRAWN
      // -------------------------------------------------

      const withdrawnSnap =
        await db
          .collection(
            "platformWithdrawals"
          )
          .where(
            "status",
            "in",
            [
              "Successful",
              "Processing",
              "Pending",
            ]
          )
          .get();

      let alreadyWithdrawn = 0;

      withdrawnSnap.forEach(
        (d) => {
          alreadyWithdrawn +=
            Number(
              d.data().amount
            ) || 0;
        }
      );

      const available =
        totalFees -
        alreadyWithdrawn;

      if (
        Number(amount) >
        available
      ) {
        return res.status(400).json({
          error:
            `Insufficient platform balance. Available: ₦${available.toLocaleString()}`,
        });
      }

      // -------------------------------------------------
      // CREATE RECIPIENT
      // -------------------------------------------------

      const recipientRes =
        await axios.post(
          "https://api.paystack.co/transferrecipient",
          {
            type: "nuban",

            name: accountName,

            account_number:
              accountNumber,

            bank_code:
              bankCode,

            currency: "NGN",
          },
          {
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET}`,

              "Content-Type":
                "application/json",
            },
          }
        );

      if (
        !recipientRes.data.status
      ) {
        return res.status(400).json({
          error:
            recipientRes.data.message ||
            "Could not create recipient",
        });
      }

      const recipientCode =
        recipientRes.data.data
          .recipient_code;

      // -------------------------------------------------
      // TRANSFER
      // -------------------------------------------------

      const transferRes =
        await axios.post(
          "https://api.paystack.co/transfer",
          {
            source: "balance",

            amount:
              Math.round(
                Number(amount) * 100
              ),

            recipient:
              recipientCode,

            reason:
              "CampusMart platform fee withdrawal",

            reference:
              `PFEE_${Date.now()}`,
          },
          {
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET}`,

              "Content-Type":
                "application/json",
            },
          }
        );

      if (
        !transferRes.data.status
      ) {
        return res.status(400).json({
          error:
            transferRes.data.message ||
            "Transfer failed",
        });
      }

      // -------------------------------------------------
      // RECORD WITHDRAWAL
      // -------------------------------------------------

      await db
        .collection(
          "platformWithdrawals"
        )
        .add({
          amount:
            Number(amount),

          bankName:
            bankName || "",

          bankCode,

          accountNumber,

          accountName,

          adminId:
            adminId || null,

          status:
            "Processing",

          paystackTransferCode:
            transferRes.data.data
              .transfer_code,

          paystackReference:
            transferRes.data.data
              .reference,

          createdAt:
            FieldValue.serverTimestamp(),

          updatedAt:
            FieldValue.serverTimestamp(),
        });

      return res.json({
        success: true,

        message:
          "Platform fee withdrawal initiated",

        transferCode:
          transferRes.data.data
            .transfer_code,
      });
    } catch (error) {
      console.error(
        "Platform withdrawal error:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        error:
          error.response?.data?.message ||
          "Could not process platform withdrawal",
      });
    }
  }
);

// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,
      message:
        "CampusMart payment server is running",
    });
  }
);

// =====================================================
// START SERVER
// =====================================================

const PORT =
  process.env.PORT || 5000;

app.listen(
  PORT,
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);