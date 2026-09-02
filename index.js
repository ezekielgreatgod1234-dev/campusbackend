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

// =====================================================
// PAYSTACK SECRET
// =====================================================

const PAYSTACK_SECRET =
  process.env.PAYSTACK_SECRET;

// =====================================================
// RESET SECRET
// =====================================================
//
// Add this to your .env:
//
// RESET_EARNINGS_SECRET=your-very-secret-value
//
// DO NOT put this value in your frontend or GitHub.
//

const RESET_EARNINGS_SECRET =
  process.env.RESET_EARNINGS_SECRET;

// =====================================================
// 1. INITIALIZE PAYMENT
// =====================================================

app.post("/initialize-payment", async (req, res) => {
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

    const numericAmount = Number(amount);

    if (
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        error: "Invalid payment amount",
      });
    }

    const amountInKobo = Math.round(
      numericAmount * 100
    );

    const response = await axios.post(
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
            productName || "CampusMart Order",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.data.status) {
      return res.status(400).json({
        error:
          response.data.message ||
          "Could not initialize payment",
      });
    }

    res.json({
      success: true,
      authorization_url:
        response.data.data.authorization_url,
      reference:
        response.data.data.reference,
    });
  } catch (error) {
    console.error(
      "Initialize payment error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      error: "Could not start payment",
    });
  }
});

// =====================================================
// 2. PAYSTACK WEBHOOK
// =====================================================
//
// Buyer pays
//
// Example:
//
// ₦10,000
//
// CampusMart fee = ₦500
// Seller gets     = ₦9,500
//
// This updates:
//
// users/{sellerId}
//   totalEarnings
//   availableBalance
//   totalPlatformFees
//
// And creates:
//
// earnings/{earningId}
// platformFees/{feeId}
//
// It also protects against duplicate webhooks.
// =====================================================

app.post("/paystack-webhook", async (req, res) => {
  try {
    // -------------------------------------------------
    // VERIFY PAYSTACK SIGNATURE
    // -------------------------------------------------

    const hash = crypto
      .createHmac(
        "sha512",
        PAYSTACK_SECRET
      )
      .update(JSON.stringify(req.body))
      .digest("hex");

    const signature =
      req.headers["x-paystack-signature"];

    if (!signature || hash !== signature) {
      console.error(
        "Invalid Paystack webhook signature"
      );

      return res
        .status(401)
        .send("Invalid signature");
    }

    const event = req.body;

    // -------------------------------------------------
    // ONLY PROCESS SUCCESSFUL CHARGES
    // -------------------------------------------------

    if (event.event !== "charge.success") {
      return res.status(200).send("OK");
    }

    const data = event.data || {};

    const metadata = data.metadata || {};

    const sellerId = metadata.sellerId;
    const orderId = metadata.orderId;

    const reference = data.reference;

    const totalAmount = Number(
      data.amount || 0
    ) / 100;

    // -------------------------------------------------
    // VALIDATION
    // -------------------------------------------------

    if (!sellerId) {
      console.warn(
        "Paystack payment has no sellerId:",
        reference
      );

      return res.status(200).send("OK");
    }

    if (!reference) {
      console.warn(
        "Paystack payment has no reference"
      );

      return res.status(200).send("OK");
    }

    if (
      !Number.isFinite(totalAmount) ||
      totalAmount <= 0
    ) {
      console.warn(
        "Invalid Paystack amount:",
        totalAmount
      );

      return res.status(200).send("OK");
    }

    // -------------------------------------------------
    // CALCULATE 5% / 95%
    // -------------------------------------------------

    const platformFee = Number(
      (totalAmount * 0.05).toFixed(2)
    );

    const sellerAmount = Number(
      (totalAmount * 0.95).toFixed(2)
    );

    // -------------------------------------------------
    // DUPLICATE PAYMENT PROTECTION
    // -------------------------------------------------
    //
    // We use the Paystack reference as the unique
    // payment identifier.
    //
    // If Paystack sends the webhook again,
    // the seller will NOT be credited twice.
    //

    const paymentRef = db
      .collection("processedPayments")
      .doc(reference);

    const sellerRef = db
      .collection("users")
      .doc(sellerId);

    const earningsRef = db
      .collection("earnings")
      .doc();

    const platformFeeRef = db
      .collection("platformFees")
      .doc();

    let alreadyProcessed = false;

    await db.runTransaction(
      async (transaction) => {
        // -------------------------------------------------
        // CHECK IF PAYMENT WAS ALREADY PROCESSED
        // -------------------------------------------------

        const paymentSnap =
          await transaction.get(paymentRef);

        if (paymentSnap.exists) {
          alreadyProcessed = true;
          return;
        }

        // -------------------------------------------------
        // GET SELLER
        // -------------------------------------------------

        const sellerSnap =
          await transaction.get(sellerRef);

        if (!sellerSnap.exists) {
          throw new Error(
            `Seller ${sellerId} does not exist`
          );
        }

        // -------------------------------------------------
        // UPDATE SELLER BALANCE
        // -------------------------------------------------

        transaction.set(
          sellerRef,
          {
            totalEarnings:
              FieldValue.increment(
                sellerAmount
              ),

            availableBalance:
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

        transaction.set(
          earningsRef,
          {
            sellerId,

            orderId:
              orderId || null,

            type: "sale",

            title:
              metadata.productName
                ? metadata.productName
                : orderId
                  ? `Order #${String(
                      orderId
                    )
                      .slice(0, 6)
                      .toUpperCase()}`
                  : `Order #${String(
                      reference
                    )
                      .slice(0, 6)
                      .toUpperCase()}`,

            description:
              metadata.productName ||
              "Sale",

            gross: totalAmount,

            platformFee,

            amount: sellerAmount,

            status: "Completed",

            paystackReference:
              reference,

            createdAt:
              FieldValue.serverTimestamp(),
          }
        );

        // -------------------------------------------------
        // CREATE PLATFORM FEE RECORD
        // -------------------------------------------------

        transaction.set(
          platformFeeRef,
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
          }
        );

        // -------------------------------------------------
        // MARK ORDER AS PAID
        // -------------------------------------------------

        if (orderId) {
          const orderRef = db
            .collection("orders")
            .doc(orderId);

          transaction.set(
            orderRef,
            {
              paymentStatus: "paid",

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
        // MARK PAYMENT AS PROCESSED
        // -------------------------------------------------

        transaction.set(paymentRef, {
          reference,

          sellerId,

          orderId:
            orderId || null,

          totalAmount,

          platformFee,

          sellerAmount,

          processedAt:
            FieldValue.serverTimestamp(),
        });
      }
    );

    // -------------------------------------------------
    // DUPLICATE WEBHOOK
    // -------------------------------------------------

    if (alreadyProcessed) {
      console.log(
        `Payment ${reference} was already processed.`
      );

      return res.status(200).send("OK");
    }

    // -------------------------------------------------
    // SUCCESS
    // -------------------------------------------------

    console.log(
      `Payment successful: ${reference}`
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
      `Seller credited: ₦${sellerAmount}`
    );

    return res.status(200).send("OK");
  } catch (error) {
    console.error(
      "Paystack webhook error:",
      error.response?.data ||
        error.message ||
        error
    );

    return res
      .status(500)
      .send("Error");
  }
});

// =====================================================
// 3. ONE-TIME SELLER EARNINGS RESET
// =====================================================
//
// THIS IS FOR YOUR CURRENT RESET ONLY.
//
// It:
//
// 1. Sets totalEarnings to 0
// 2. Sets availableBalance to 0
// 3. Sets totalPlatformFees to 0
// 4. Deletes the seller's earnings records
//
// IMPORTANT:
//
// It DOES NOT delete platformFees.
//
// Why?
//
// Because platformFees belongs to CampusMart's
// financial records and may be needed for admin
// accounting.
//
// If you specifically want to erase those too,
// I can give you a separate controlled reset.
// =====================================================

app.post(
  "/reset-seller-earnings",
  async (req, res) => {
    try {
      // -------------------------------------------------
      // SECURITY CHECK
      // -------------------------------------------------

      const providedSecret =
        req.headers["x-reset-secret"];

      if (
        !RESET_EARNINGS_SECRET ||
        providedSecret !==
          RESET_EARNINGS_SECRET
      ) {
        return res.status(401).json({
          error: "Unauthorized",
        });
      }

      const { sellerId } = req.body;

      if (!sellerId) {
        return res.status(400).json({
          error: "sellerId is required",
        });
      }

      // -------------------------------------------------
      // SELLER REFERENCE
      // -------------------------------------------------

      const sellerRef = db
        .collection("users")
        .doc(sellerId);

      const sellerSnap =
        await sellerRef.get();

      if (!sellerSnap.exists) {
        return res.status(404).json({
          error: "Seller not found",
        });
      }

      // -------------------------------------------------
      // RESET SELLER BALANCE
      // -------------------------------------------------

      await sellerRef.set(
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

      // -------------------------------------------------
      // FIND OLD EARNINGS
      // -------------------------------------------------

      const earningsSnap =
        await db
          .collection("earnings")
          .where(
            "sellerId",
            "==",
            sellerId
          )
          .get();

      // -------------------------------------------------
      // DELETE IN BATCHES
      // -------------------------------------------------

      let batch = db.batch();

      let deletedCount = 0;

      for (
        const earningDoc of
          earningsSnap.docs
      ) {
        batch.delete(
          earningDoc.ref
        );

        deletedCount++;

        // Firestore batch limit safety
        if (
          deletedCount % 400 === 0
        ) {
          await batch.commit();

          batch = db.batch();
        }
      }

      // Commit remaining deletions
      if (
        deletedCount % 400 !== 0
      ) {
        await batch.commit();
      }

      console.log(
        `Reset seller ${sellerId}`
      );

      console.log(
        `Deleted ${deletedCount} earnings records`
      );

      return res.json({
        success: true,

        message:
          "Seller earnings successfully reset.",

        sellerId,

        deletedEarnings:
          deletedCount,

        totalEarnings: 0,

        availableBalance: 0,

        totalPlatformFees: 0,
      });
    } catch (error) {
      console.error(
        "Reset earnings error:",
        error
      );

      return res.status(500).json({
        error:
          "Could not reset seller earnings",
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

      const withdrawalAmount =
        Number(amount);

      if (
        !Number.isFinite(
          withdrawalAmount
        ) ||
        withdrawalAmount <= 0
      ) {
        return res.status(400).json({
          error:
            "Invalid withdrawal amount",
        });
      }

      if (
        withdrawalAmount < 1000
      ) {
        return res.status(400).json({
          error:
            "Minimum withdrawal is ₦1,000",
        });
      }

      // -------------------------------------------------
      // CHECK SELLER BALANCE
      // -------------------------------------------------

      const sellerRef = db
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
        withdrawalAmount
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
            recipientRes.data.message ||
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

            amount: Math.round(
              withdrawalAmount * 100
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
      // DEDUCT BALANCE + SAVE WITHDRAWAL
      // -------------------------------------------------

      const batch = db.batch();

      batch.update(sellerRef, {
        availableBalance:
          FieldValue.increment(
            -withdrawalAmount
          ),

        updatedAt:
          FieldValue.serverTimestamp(),
      });

      const withdrawalRef =
        db
          .collection("withdrawals")
          .doc();

      batch.set(
        withdrawalRef,
        {
          sellerId,

          amount:
            withdrawalAmount,

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

      const withdrawalAmount =
        Number(amount);

      if (
        !Number.isFinite(
          withdrawalAmount
        ) ||
        withdrawalAmount <= 0
      ) {
        return res.status(400).json({
          error:
            "Invalid withdrawal amount",
        });
      }

      if (
        withdrawalAmount < 1000
      ) {
        return res.status(400).json({
          error:
            "Minimum withdrawal is ₦1,000",
        });
      }

      // -------------------------------------------------
      // CALCULATE AVAILABLE PLATFORM FEES
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
      // CHECK ALREADY WITHDRAWN
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
        withdrawalAmount >
        available
      ) {
        return res.status(400).json({
          error:
            `Insufficient platform balance. Available: ₦${available.toLocaleString()}`,
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
            recipientRes.data.message ||
            "Could not create recipient",
        });
      }

      const recipientCode =
        recipientRes.data.data
          .recipient_code;

      // -------------------------------------------------
      // INITIATE TRANSFER
      // -------------------------------------------------

      const transferRes =
        await axios.post(
          "https://api.paystack.co/transfer",
          {
            source: "balance",

            amount: Math.round(
              withdrawalAmount * 100
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
      // SAVE PLATFORM WITHDRAWAL
      // -------------------------------------------------

      await db
        .collection(
          "platformWithdrawals"
        )
        .add({
          amount:
            withdrawalAmount,

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

app.get("/", (req, res) => {
  res.json({
    success: true,
    message:
      "CampusMart payment server is running",
  });
});

// =====================================================
// START SERVER
// =====================================================

const PORT =
  process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});