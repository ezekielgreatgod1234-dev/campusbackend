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

// =====================================================
// CONFIG
// =====================================================

const PORT = process.env.PORT || 5000;

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "https://campus-mart-ashen.vercel.app";

const ADMIN_EMAIL = "campusmart1234@gmail.com";

// =====================================================
// CORS
// =====================================================

const allowedOrigins = [
  FRONTEND_URL,
  "http://localhost:5173",
  "http://localhost:5174",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server requests / tools with no origin.
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn("Blocked CORS origin:", origin);

      return callback(
        new Error("Not allowed by CORS")
      );
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
  })
);

// =====================================================
// BODY PARSER
// =====================================================

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

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
// PAYSTACK
// =====================================================

const PAYSTACK_SECRET =
  process.env.PAYSTACK_SECRET;

if (!PAYSTACK_SECRET) {
  console.warn(
    "PAYSTACK_SECRET is missing."
  );
}

// =====================================================
// BREVO EMAIL
// =====================================================

const BREVO_API_KEY =
  process.env.BREVO_API_KEY;

const MAIL_FROM =
  process.env.MAIL_FROM ||
  "noreply@campusmart.app";

const MAIL_FROM_NAME =
  process.env.MAIL_FROM_NAME ||
  "CampusMart";

if (!BREVO_API_KEY) {
  console.warn(
    "BREVO_API_KEY missing — email endpoints will fail until it's set"
  );
}

// =====================================================
// EMAIL HELPER
// =====================================================

async function sendMail({
  to,
  subject,
  html,
  text,
}) {
  if (!to) {
    throw new Error(
      "Missing recipient"
    );
  }

  if (!BREVO_API_KEY) {
    throw new Error(
      "Email provider not configured (missing BREVO_API_KEY)"
    );
  }

  const response = await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender: {
        name: MAIL_FROM_NAME,
        email: MAIL_FROM,
      },

      to: [
        {
          email: to,
        },
      ],

      subject,

      htmlContent: html,

      textContent:
        text ||
        String(html).replace(
          /<[^>]+>/g,
          " "
        ),
    },
    {
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },

      timeout: 15000,
    }
  );

  return response.data;
}

// =====================================================
// EMAIL LAYOUT
// =====================================================

function emailLayout({
  title,
  bodyHtml,
}) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  />
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#f7faf8;
    font-family:Arial,sans-serif;
  "
>

  <table
    width="100%"
    cellpadding="0"
    cellspacing="0"
    style="
      background:#f7faf8;
      padding:24px 12px;
    "
  >

    <tr>
      <td align="center">

        <table
          width="100%"
          style="
            max-width:560px;
            background:#ffffff;
            border-radius:16px;
            overflow:hidden;
            border:1px solid #e5e7eb;
          "
        >

          <tr>
            <td
              style="
                background:#008236;
                padding:20px 24px;
              "
            >

              <div
                style="
                  color:#fff;
                  font-size:20px;
                  font-weight:800;
                "
              >
                Campus<span
                  style="color:#86efac;"
                >Mart</span>
              </div>

              <div
                style="
                  color:#d1fae5;
                  font-size:12px;
                  margin-top:4px;
                "
              >
                Your Campus Marketplace
              </div>

            </td>
          </tr>

          <tr>
            <td
              style="
                padding:28px 24px;
              "
            >

              <h1
                style="
                  margin:0 0 12px;
                  font-size:20px;
                  color:#111827;
                "
              >
                ${title}
              </h1>

              <div
                style="
                  font-size:14px;
                  line-height:1.6;
                  color:#374151;
                "
              >
                ${bodyHtml}
              </div>

            </td>
          </tr>

          <tr>
            <td
              style="
                padding:16px 24px;
                background:#f9fafb;
                border-top:1px solid #f3f4f6;
                font-size:11px;
                color:#9ca3af;
              "
            >
              © CampusMart · You received this because
              you have a CampusMart account.
            </td>
          </tr>

        </table>

      </td>
    </tr>

  </table>

</body>
</html>
`;
}

// =====================================================
// AUTH HELPERS
// =====================================================

async function verifyFirebaseUser(req) {
  const authorization =
    req.headers.authorization || "";

  if (
    !authorization.startsWith(
      "Bearer "
    )
  ) {
    const error = new Error(
      "Missing Firebase authentication token"
    );

    error.status = 401;

    throw error;
  }

  const idToken =
    authorization.substring(7);

  if (!idToken) {
    const error = new Error(
      "Missing Firebase authentication token"
    );

    error.status = 401;

    throw error;
  }

  try {
    const decodedToken =
      await adminAuth.verifyIdToken(
        idToken
      );

    return decodedToken;
  } catch (error) {
    console.error(
      "Firebase token verification failed:",
      error.message
    );

    const authError = new Error(
      "Invalid or expired Firebase authentication token"
    );

    authError.status = 401;

    throw authError;
  }
}

// =====================================================
// ADMIN AUTHORIZATION
// =====================================================

async function requireAdmin(req) {
  const decoded =
    await verifyFirebaseUser(req);

  const adminEmail =
    String(
      decoded.email || ""
    )
      .trim()
      .toLowerCase();

  const isMainAdmin =
    adminEmail ===
    ADMIN_EMAIL.toLowerCase();

  let isAdmin =
    isMainAdmin;

  if (!isAdmin) {
    /*
     * IMPORTANT:
     *
     * This lookup uses the Firebase Auth UID.
     *
     * If your users collection is not keyed by Firebase
     * UID, the main admin email check still works.
     *
     * For other admins, we also check a query below.
     */

    const userDoc =
      await db
        .collection("users")
        .doc(decoded.uid)
        .get();

    if (userDoc.exists) {
      const data =
        userDoc.data() || {};

      isAdmin =
        data.role === "admin" ||
        data.isAdmin === true ||
        (
          Array.isArray(
            data.roles
          ) &&
          data.roles.includes(
            "admin"
          )
        );
    }

    /*
     * Fallback for installations where the users
     * collection document ID isn't the Firebase UID.
     */
    if (!isAdmin && decoded.email) {
      const emailSnapshot =
        await db
          .collection("users")
          .where(
            "email",
            "==",
            decoded.email
          )
          .limit(5)
          .get();

      emailSnapshot.forEach(
        (docSnap) => {
          const data =
            docSnap.data() || {};

          if (
            data.role === "admin" ||
            data.isAdmin === true ||
            (
              Array.isArray(
                data.roles
              ) &&
              data.roles.includes(
                "admin"
              )
            )
          ) {
            isAdmin = true;
          }
        }
      );
    }
  }

  if (!isAdmin) {
    const error =
      new Error(
        "Admin only"
      );

    error.status = 403;

    throw error;
  }

  return decoded;
}

// =====================================================
// FIND FIREBASE AUTH USER BY EMAIL
// =====================================================

/**
 * Firebase Authentication is the source of truth
 * for the user's real Firebase UID.
 *
 * DO NOT use the Firestore users document ID here.
 */
async function findFirebaseUserByEmail(
  email
) {
  const normalizedEmail =
    String(email || "")
      .trim()
      .toLowerCase();

  if (!normalizedEmail) {
    const error =
      new Error(
        "email is required"
      );

    error.status = 400;

    throw error;
  }

  try {
    const userRecord =
      await adminAuth.getUserByEmail(
        normalizedEmail
      );

    return userRecord;
  } catch (error) {
    if (
      error.code ===
      "auth/user-not-found"
    ) {
      const notFound =
        new Error(
          "No Firebase Auth account was found for that email."
        );

      notFound.status = 404;

      throw notFound;
    }

    throw error;
  }
}

// =====================================================
// LIVE BANNER
// =====================================================

async function activateLiveBanner({
  announcementId,
  title,
  body,
  createdBy,
  createdByEmail,
}) {
  await db
    .collection("settings")
    .doc("liveBanner")
    .set(
      {
        active: true,

        announcementId:
          announcementId || null,

        title:
          title ||
          "CampusMart Announcement",

        body:
          body || "",

        bannerMessage:
          "We've sent an announcement to your email. Please also check your Junk / Spam folder if you don't see it in your inbox.",

        createdBy:
          createdBy || null,

        createdByEmail:
          createdByEmail || null,

        createdAt:
          FieldValue.serverTimestamp(),

        updatedAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      }
    );
}

// =====================================================
// PRIVATE TICKER HELPER
// =====================================================

async function publishPrivateTicker({
  targetUid,
  targetEmail,
  message,
  createdBy,
  createdByEmail,
}) {
  if (!targetUid) {
    throw new Error(
      "targetUid is required"
    );
  }

  if (!message) {
    throw new Error(
      "message is required"
    );
  }

  /*
   * IMPORTANT:
   *
   * The document ID is the REAL Firebase Authentication UID.
   */
  await db
    .collection("userTickers")
    .doc(targetUid)
    .set(
      {
        active: true,

        message:
          String(message).trim(),

        targetType:
          "single",

        targetUid,

        targetEmail:
          targetEmail || null,

        updatedAt:
          FieldValue.serverTimestamp(),

        createdBy:
          createdBy || null,

        createdByEmail:
          createdByEmail || null,
      },
      {
        merge: true,
      }
    );
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
        type,
        productIds,
        planId,
        planDays,
        callback_url,
      } = req.body;

      if (
        !email ||
        !amount ||
        !sellerId
      ) {
        return res.status(400).json({
          error:
            "email, amount and sellerId are required",
        });
      }

      const amountInKobo =
        Math.round(
          Number(amount) * 100
        );

      if (
        !Number.isFinite(
          amountInKobo
        ) ||
        amountInKobo <= 0
      ) {
        return res.status(400).json({
          error:
            "Invalid payment amount",
        });
      }

      const paymentType =
        type === "promotion"
          ? "promotion"
          : "order";

      const finalCallback =
        callback_url ||
        (
          paymentType ===
          "promotion"
            ? `${FRONTEND_URL}/seller/promotions`
            : `${FRONTEND_URL}/order-success`
        );

      const response =
        await axios.post(
          "https://api.paystack.co/transaction/initialize",
          {
            email,

            amount:
              amountInKobo,

            currency:
              "NGN",

            callback_url:
              finalCallback,

            metadata: {
              sellerId,

              orderId:
                orderId || null,

              productName:
                productName ||
                "CampusMart Order",

              type:
                paymentType,

              productIds:
                Array.isArray(
                  productIds
                )
                  ? productIds
                  : [],

              planId:
                planId || null,

              planDays:
                planDays || null,
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

      if (
        !response.data.status
      ) {
        return res.status(400).json({
          error:
            response.data.message ||
            "Payment initialization failed",
        });
      }

      const authUrl =
        response.data.data
          .authorization_url;

      const reference =
        response.data.data
          .reference;

      return res.json({
        success: true,

        authorization_url:
          authUrl,

        reference,

        data: {
          authorization_url:
            authUrl,

          reference,

          access_code:
            response.data.data
              .access_code,
        },
      });
    } catch (error) {
      console.error(
        "Initialize payment error:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        error:
          "Could not start payment",
      });
    }
  }
);

// =====================================================
// 1B. VERIFY PAYMENT
// =====================================================

app.get(
  "/verify-payment/:reference",
  async (req, res) => {
    try {
      const {
        reference,
      } = req.params;

      if (!reference) {
        return res.status(400).json({
          error:
            "reference is required",
        });
      }

      const response =
        await axios.get(
          `https://api.paystack.co/transaction/verify/${encodeURIComponent(
            reference
          )}`,
          {
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET}`,
            },
          }
        );

      return res.json(
        response.data
      );
    } catch (error) {
      console.error(
        "Verify payment error:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        error:
          "Could not verify payment",
      });
    }
  }
);

// =====================================================
// 2. PAYSTACK WEBHOOK
// =====================================================

app.post(
  "/paystack-webhook",
  async (req, res) => {
    try {
      const hash =
        crypto
          .createHmac(
            "sha512",
            PAYSTACK_SECRET
          )
          .update(
            req.rawBody
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
          .send(
            "Invalid signature"
          );
      }

      const event =
        req.body;

      if (
        event.event !==
        "charge.success"
      ) {
        return res
          .status(200)
          .send("OK");
      }

      const data =
        event.data;

      const metadata =
        data.metadata || {};

      const sellerId =
        metadata.sellerId;

      const orderId =
        metadata.orderId;

      const paymentType =
        metadata.type ||
        "order";

      const totalAmount =
        Number(
          data.amount || 0
        ) / 100;

      const reference =
        data.reference;

      if (
        !reference ||
        totalAmount <= 0
      ) {
        return res
          .status(200)
          .send("OK");
      }

      // -------------------------------------------------
      // PROMOTION PAYMENT
      // -------------------------------------------------

      if (
        paymentType ===
        "promotion"
      ) {
        const promoPayRef =
          db
            .collection(
              "promotionPayments"
            )
            .doc(reference);

        const result =
          await db.runTransaction(
            async (tx) => {
              const existing =
                await tx.get(
                  promoPayRef
                );

              if (
                existing.exists
              ) {
                return "already-processed";
              }

              tx.set(
                promoPayRef,
                {
                  sellerId:
                    sellerId ||
                    null,

                  productIds:
                    metadata.productIds ||
                    [],

                  planId:
                    metadata.planId ||
                    null,

                  planDays:
                    metadata.planDays ||
                    null,

                  totalAmount,

                  paystackReference:
                    reference,

                  productName:
                    metadata.productName ||
                    "Promotion",

                  status:
                    "paid",

                  createdAt:
                    FieldValue.serverTimestamp(),
                }
              );

              return "processed";
            }
          );

        if (
          result ===
          "already-processed"
        ) {
          console.log(
            `Promotion ${reference} already recorded.`
          );

          return res
            .status(200)
            .send(
              "Already processed"
            );
        }

        console.log(
          "PROMOTION PAYMENT SUCCESSFUL",
          reference,
          sellerId,
          totalAmount
        );

        return res
          .status(200)
          .send("OK");
      }

      // -------------------------------------------------
      // NORMAL ORDER PAYMENT
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

      const platformFee =
        0;

      const sellerAmount =
        Number(
          totalAmount.toFixed(2)
        );

      const earningRef =
        db
          .collection("earnings")
          .doc(reference);

      const sellerRef =
        db
          .collection("users")
          .doc(sellerId);

      const platformFeeRef =
        db
          .collection(
            "platformFees"
          )
          .doc(reference);

      const orderRef =
        orderId
          ? db
              .collection(
                "orders"
              )
              .doc(orderId)
          : null;

      const result =
        await db.runTransaction(
          async (tx) => {
            const existingEarning =
              await tx.get(
                earningRef
              );

            if (
              existingEarning.exists
            ) {
              return "already-processed";
            }

            tx.set(
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

            tx.set(
              earningRef,
              {
                sellerId,

                orderId:
                  orderId || null,

                type:
                  "sale",

                title:
                  orderId
                    ? `Order #${String(
                        orderId
                      )
                        .slice(
                          0,
                          6
                        )
                        .toUpperCase()}`
                    : "CampusMart Sale",

                description:
                  metadata.productName ||
                  "Sale",

                amount:
                  sellerAmount,

                gross:
                  totalAmount,

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

            tx.set(
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
              },
              {
                merge: true,
              }
            );

            if (orderRef) {
              tx.set(
                orderRef,
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

            return "processed";
          }
        );

      if (
        result ===
        "already-processed"
      ) {
        console.log(
          `Payment ${reference} already processed.`
        );

        return res
          .status(200)
          .send(
            "Already processed"
          );
      }

      console.log(
        "PAYMENT SUCCESSFUL",
        reference,
        sellerId,
        totalAmount,
        sellerAmount
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

app.post(
  "/reset-earnings",
  async (req, res) => {
    try {
      const decodedUser =
        await verifyFirebaseUser(
          req
        );

      const sellerId =
        decodedUser.uid;

      console.log(
        `Resetting earnings for seller: ${sellerId}`
      );

      const earningsSnapshot =
        await db
          .collection(
            "earnings"
          )
          .where(
            "sellerId",
            "==",
            sellerId
          )
          .get();

      const docs =
        earningsSnapshot.docs;

      const chunkSize =
        400;

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

      return res.status(
        error.status || 500
      ).json({
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
      /*
       * SECURITY:
       *
       * Never trust sellerId supplied by the browser.
       * Firebase Auth is the source of truth.
       */
      const decoded =
        await verifyFirebaseUser(
          req
        );

      const sellerId =
        decoded.uid;

      const {
        amount,
        bankName,
        bankCode,
        accountNumber,
        accountName,
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

      const numericAmount =
        Number(amount);

      if (
        !Number.isFinite(
          numericAmount
        ) ||
        numericAmount < 1000
      ) {
        return res.status(400).json({
          error:
            "Minimum withdrawal is ₦1,000",
        });
      }

      const sellerRef =
        db
          .collection("users")
          .doc(sellerId);

      const deduction =
        await db
          .runTransaction(
            async (tx) => {
              const sellerSnap =
                await tx.get(
                  sellerRef
                );

              if (
                !sellerSnap.exists
              ) {
                throw new Error(
                  "SELLER_NOT_FOUND"
                );
              }

              const availableBalance =
                Number(
                  sellerSnap.data()
                    .availableBalance ||
                    0
                );

              if (
                availableBalance <
                numericAmount
              ) {
                throw new Error(
                  "INSUFFICIENT_BALANCE"
                );
              }

              tx.update(
                sellerRef,
                {
                  availableBalance:
                    FieldValue.increment(
                      -numericAmount
                    ),

                  updatedAt:
                    FieldValue.serverTimestamp(),
                }
              );

              return true;
            }
          )
          .catch((err) => {
            if (
              err.message ===
              "SELLER_NOT_FOUND"
            ) {
              return {
                error:
                  "Seller not found",
                status: 404,
              };
            }

            if (
              err.message ===
              "INSUFFICIENT_BALANCE"
            ) {
              return {
                error:
                  "Insufficient balance",
                status: 400,
              };
            }

            throw err;
          });

      if (
        deduction &&
        deduction.error
      ) {
        return res
          .status(
            deduction.status
          )
          .json({
            error:
              deduction.error,
          });
      }

      let recipientRes;

      try {
        recipientRes =
          await axios.post(
            "https://api.paystack.co/transferrecipient",
            {
              type: "nuban",

              name:
                accountName,

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
      } catch (err) {
        await sellerRef.update({
          availableBalance:
            FieldValue.increment(
              numericAmount
            ),

          updatedAt:
            FieldValue.serverTimestamp(),
        });

        throw err;
      }

      if (
        !recipientRes.data.status
      ) {
        await sellerRef.update({
          availableBalance:
            FieldValue.increment(
              numericAmount
            ),

          updatedAt:
            FieldValue.serverTimestamp(),
        });

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

      const transferReference =
        `WD_${sellerId}_${Date.now()}`;

      let transferRes;

      try {
        transferRes =
          await axios.post(
            "https://api.paystack.co/transfer",
            {
              source:
                "balance",

              amount:
                Math.round(
                  numericAmount * 100
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
      } catch (err) {
        await sellerRef.update({
          availableBalance:
            FieldValue.increment(
              numericAmount
            ),

          updatedAt:
            FieldValue.serverTimestamp(),
        });

        throw err;
      }

      if (
        !transferRes.data.status
      ) {
        await sellerRef.update({
          availableBalance:
            FieldValue.increment(
              numericAmount
            ),

          updatedAt:
            FieldValue.serverTimestamp(),
        });

        return res.status(400).json({
          error:
            transferRes.data
              .message ||
            "Transfer failed",
        });
      }

      const withdrawalRef =
        db
          .collection(
            "withdrawals"
          )
          .doc();

      await withdrawalRef.set({
        sellerId,

        amount:
          numericAmount,

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
      });

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

      return res.status(
        error.status || 500
      ).json({
        error:
          error.response?.data
            ?.message ||
          error.message ||
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
      /*
       * SECURITY:
       *
       * This endpoint moves platform money.
       * It MUST be admin-only.
       */
      const decoded =
        await requireAdmin(
          req
        );

      const {
        amount,
        bankName,
        bankCode,
        accountNumber,
        accountName,
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

      const numericAmount =
        Number(amount);

      if (
        !Number.isFinite(
          numericAmount
        ) ||
        numericAmount < 1000
      ) {
        return res.status(400).json({
          error:
            "Minimum withdrawal is ₦1,000",
        });
      }

      const feesSnap =
        await db
          .collection(
            "platformFees"
          )
          .get();

      let totalFees =
        0;

      feesSnap.forEach(
        (d) => {
          totalFees +=
            Number(
              d.data()
                .platformFee
            ) || 0;
        }
      );

      const promoSnap =
        await db
          .collection(
            "promotionPayments"
          )
          .get();

      promoSnap.forEach(
        (d) => {
          totalFees +=
            Number(
              d.data()
                .totalAmount
            ) || 0;
        }
      );

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

      let alreadyWithdrawn =
        0;

      withdrawnSnap.forEach(
        (d) => {
          alreadyWithdrawn +=
            Number(
              d.data()
                .amount
            ) || 0;
        }
      );

      const available =
        totalFees -
        alreadyWithdrawn;

      if (
        numericAmount >
        available
      ) {
        return res.status(400).json({
          error:
            `Insufficient platform balance. Available: ₦${available.toLocaleString()}`,
        });
      }

      const recipientRes =
        await axios.post(
          "https://api.paystack.co/transferrecipient",
          {
            type: "nuban",

            name:
              accountName,

            account_number:
              accountNumber,

            bank_code:
              bankCode,

            currency:
              "NGN",
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

      const transferReference =
        `PFEE_${Date.now()}`;

      const transferRes =
        await axios.post(
          "https://api.paystack.co/transfer",
          {
            source:
              "balance",

            amount:
              Math.round(
                numericAmount * 100
              ),

            recipient:
              recipientCode,

            reason:
              "CampusMart platform fee withdrawal",

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
            transferRes.data
              .message ||
            "Transfer failed",
        });
      }

      await db
        .collection(
          "platformWithdrawals"
        )
        .add({
          amount:
            numericAmount,

          bankName:
            bankName || "",

          bankCode,

          accountNumber,

          accountName,

          adminId:
            decoded.uid,

          adminEmail:
            decoded.email || null,

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

      return res.status(
        error.status || 500
      ).json({
        error:
          error.response?.data
            ?.message ||
          error.message ||
          "Could not process platform withdrawal",
      });
    }
  }
);

// =====================================================
// 6. WELCOME EMAIL
// =====================================================

app.post(
  "/send-welcome-email",
  async (req, res) => {
    try {
      const {
        email,
        fullName,
      } = req.body || {};

      if (!email) {
        return res.status(400).json({
          error:
            "email is required",
        });
      }

      let title =
        "Welcome to CampusMart 👋";

      let body =
        "Thanks for joining CampusMart! Browse products, chat sellers, and enjoy secure campus shopping.";

      let enabled =
        true;

      try {
        const snap =
          await db
            .collection(
              "settings"
            )
            .doc(
              "welcomeMessage"
            )
            .get();

        if (snap.exists) {
          const w =
            snap.data() || {};

          if (
            w.enabled ===
            false
          ) {
            enabled =
              false;
          }

          if (w.title) {
            title =
              String(
                w.title
              );
          }

          if (w.body) {
            body =
              String(
                w.body
              );
          }
        }
      } catch (e) {
        console.warn(
          "welcome settings:",
          e.message
        );
      }

      if (!enabled) {
        return res.json({
          success: true,

          skipped: true,

          message:
            "Welcome emails disabled",
        });
      }

      const name =
        (
          fullName ||
          ""
        )
          .trim()
          .split(/\s+/)[0] ||
        "there";

      const finalTitle =
        title.replace(
          /\{name\}/g,
          name
        );

      const finalBody =
        body.replace(
          /\{name\}/g,
          name
        );

      const bodyHtml =
        finalBody
          .split("\n")
          .map(
            (line) =>
              `<p style="margin:0 0 10px;">${line}</p>`
          )
          .join("");

      try {
        await sendMail({
          to: String(
            email
          )
            .trim()
            .toLowerCase(),

          subject:
            finalTitle,

          html:
            emailLayout({
              title:
                finalTitle,

              bodyHtml,
            }),
        });
      } catch (mailErr) {
        console.error(
          "Welcome email send failed:",
          mailErr.response
            ?.data ||
            mailErr.message
        );

        return res.json({
          success: true,

          emailSent: false,

          message:
            "Account created, but welcome email could not be sent",
        });
      }

      return res.json({
        success: true,

        emailSent: true,

        message:
          "Welcome email sent",
      });
    } catch (error) {
      console.error(
        "Welcome email error:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Could not send welcome email",
      });
    }
  }
);

// =====================================================
// 7. ADMIN: LOOK UP FIREBASE AUTH USER
// =====================================================

/**
 * This is the FIX for your UID problem.
 *
 * Example:
 *
 * GET /admin/lookup-user?email=greatgodezekiel123@gmail.com
 *
 * The backend asks Firebase Authentication directly.
 *
 * It does NOT use:
 * users/{documentId}
 */
app.get(
  "/admin/lookup-user",
  async (req, res) => {
    try {
      await requireAdmin(
        req
      );

      const email =
        String(
          req.query.email ||
          ""
        )
          .trim()
          .toLowerCase();

      if (!email) {
        return res.status(400).json({
          error:
            "email is required",
        });
      }

      const userRecord =
        await findFirebaseUserByEmail(
          email
        );

      return res.json({
        success: true,

        uid:
          userRecord.uid,

        email:
          userRecord.email ||
          email,

        displayName:
          userRecord.displayName ||
          "",

        disabled:
          !!userRecord.disabled,
      });
    } catch (error) {
      console.error(
        "Admin user lookup error:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Could not find user",
      });
    }
  }
);

// =====================================================
// 8. ADMIN: PUBLISH PRIVATE TICKER
// =====================================================

app.post(
  "/admin/private-ticker",
  async (req, res) => {
    try {
      const decoded =
        await requireAdmin(
          req
        );

      const {
        email,
        message,
      } = req.body || {};

      if (!email) {
        return res.status(400).json({
          error:
            "email is required",
        });
      }

      if (
        !message ||
        !String(
          message
        ).trim()
      ) {
        return res.status(400).json({
          error:
            "message is required",
        });
      }

      const normalizedEmail =
        String(
          email
        )
          .trim()
          .toLowerCase();

      /*
       * THIS is the critical part.
       *
       * Firebase Authentication returns the
       * actual UID.
       */
      const userRecord =
        await findFirebaseUserByEmail(
          normalizedEmail
        );

      if (
        userRecord.disabled
      ) {
        return res.status(400).json({
          error:
            "This Firebase account is disabled.",
        });
      }

      await publishPrivateTicker({
        targetUid:
          userRecord.uid,

        targetEmail:
          userRecord.email ||
          normalizedEmail,

        message:
          String(
            message
          ).trim(),

        createdBy:
          decoded.uid,

        createdByEmail:
          decoded.email ||
          null,
      });

      console.log(
        "PRIVATE TICKER PUBLISHED",
        {
          targetEmail:
            userRecord.email ||
            normalizedEmail,

          targetUid:
            userRecord.uid,

          createdBy:
            decoded.email ||
            decoded.uid,
        }
      );

      return res.json({
        success: true,

        mode:
          "single",

        targetUid:
          userRecord.uid,

        targetEmail:
          userRecord.email ||
          normalizedEmail,

        message:
          "Private ticker sent successfully.",
      });
    } catch (error) {
      console.error(
        "Private ticker error:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Could not publish private ticker",
      });
    }
  }
);

// =====================================================
// 9. ADMIN: CLEAR PRIVATE TICKER
// =====================================================

app.post(
  "/admin/private-ticker/clear",
  async (req, res) => {
    try {
      const decoded =
        await requireAdmin(
          req
        );

      const {
        email,
      } = req.body || {};

      if (!email) {
        return res.status(400).json({
          error:
            "email is required",
        });
      }

      const normalizedEmail =
        String(
          email
        )
          .trim()
          .toLowerCase();

      const userRecord =
        await findFirebaseUserByEmail(
          normalizedEmail
        );

      await db
        .collection(
          "userTickers"
        )
        .doc(
          userRecord.uid
        )
        .set(
          {
            active:
              false,

            updatedAt:
              FieldValue.serverTimestamp(),

            clearedBy:
              decoded.uid,

            clearedByEmail:
              decoded.email ||
              null,
          },
          {
            merge: true,
          }
        );

      return res.json({
        success: true,

        message:
          "Private ticker cleared.",
      });
    } catch (error) {
      console.error(
        "Clear private ticker error:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Could not clear private ticker",
      });
    }
  }
);

// =====================================================
// 10. ADMIN: PUBLISH GLOBAL TICKER
// =====================================================

app.post(
  "/admin/global-ticker",
  async (req, res) => {
    try {
      const decoded =
        await requireAdmin(
          req
        );

      const {
        message,
      } = req.body || {};

      if (
        !message ||
        !String(
          message
        ).trim()
      ) {
        return res.status(400).json({
          error:
            "message is required",
        });
      }

      await db
        .collection(
          "settings"
        )
        .doc(
          "liveTicker"
        )
        .set(
          {
            active:
              true,

            message:
              String(
                message
              ).trim(),

            targetType:
              "all",

            updatedAt:
              FieldValue.serverTimestamp(),

            createdBy:
              decoded.uid,

            createdByEmail:
              decoded.email ||
              null,
          },
          {
            merge: true,
          }
        );

      return res.json({
        success: true,

        mode:
          "all",

        message:
          "Global ticker published successfully.",
      });
    } catch (error) {
      console.error(
        "Global ticker error:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Could not publish global ticker",
      });
    }
  }
);

// =====================================================
// 11. ADMIN: CLEAR GLOBAL TICKER
// =====================================================

app.post(
  "/admin/global-ticker/clear",
  async (req, res) => {
    try {
      await requireAdmin(
        req
      );

      await db
        .collection(
          "settings"
        )
        .doc(
          "liveTicker"
        )
        .set(
          {
            active:
              false,

            updatedAt:
              FieldValue.serverTimestamp(),
          },
          {
            merge: true,
          }
        );

      return res.json({
        success: true,

        message:
          "Global ticker cleared.",
      });
    } catch (error) {
      console.error(
        "Clear global ticker error:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Could not clear global ticker",
      });
    }
  }
);

// =====================================================
// 12. ANNOUNCEMENT EMAIL + LIVE BANNER
// =====================================================

app.post(
  "/send-announcement-email",
  async (req, res) => {
    try {
      let decoded;

      try {
        decoded =
          await requireAdmin(
            req
          );
      } catch (e) {
        return res
          .status(
            e.status || 401
          )
          .json({
            error:
              e.message ||
              "Unauthorized",
          });
      }

      const {
        title,
        body,
        mode,
        email,
        showBanner = true,
      } = req.body || {};

      if (
        !title ||
        !body
      ) {
        return res.status(400).json({
          error:
            "title and body are required",
        });
      }

      const bodyHtml =
        String(body)
          .split("\n")
          .map(
            (line) =>
              `<p style="margin:0 0 10px;">${line}</p>`
          )
          .join("");

      const html =
        emailLayout({
          title:
            String(title),

          bodyHtml,
        });

      // -------------------------------------------------
      // SINGLE EMAIL
      // -------------------------------------------------

      if (
        mode ===
        "single"
      ) {
        if (!email) {
          return res.status(400).json({
            error:
              "email is required for single mode",
          });
        }

        const normalizedEmail =
          String(
            email
          )
            .trim()
            .toLowerCase();

        /*
         * Resolve the real Firebase account first.
         * This also prevents sending to an arbitrary
         * fake/non-CampusMart Firebase email.
         */
        const targetUser =
          await findFirebaseUserByEmail(
            normalizedEmail
          );

        await sendMail({
          to:
            targetUser.email ||
            normalizedEmail,

          subject:
            String(title),

          html,
        });

        const annRef =
          await db
            .collection(
              "announcements"
            )
            .add({
              title:
                String(title),

              body:
                String(body),

              audience:
                "single",

              targetEmail:
                targetUser.email ||
                normalizedEmail,

              targetUid:
                targetUser.uid,

              type:
                "email",

              active:
                true,

              showBanner:
                !!showBanner,

              createdBy:
                decoded.uid,

              createdByEmail:
                decoded.email ||
                null,

              createdAt:
                FieldValue.serverTimestamp(),
            });

        /*
         * IMPORTANT:
         *
         * Do NOT activate the global liveBanner
         * for a single-account announcement.
         *
         * Instead, publish to userTickers/{realUid}.
         */
        if (showBanner) {
          await publishPrivateTicker({
            targetUid:
              targetUser.uid,

            targetEmail:
              targetUser.email ||
              normalizedEmail,

            message:
              String(body),

            createdBy:
              decoded.uid,

            createdByEmail:
              decoded.email ||
              null,
          });
        }

        return res.json({
          success:
            true,

          sent:
            1,

          mode:
            "single",

          bannerActive:
            !!showBanner,

          announcementId:
            annRef.id,

          targetUid:
            targetUser.uid,

          targetEmail:
            targetUser.email ||
            normalizedEmail,
        });
      }

      // -------------------------------------------------
      // ALL REGISTERED EMAILS
      // -------------------------------------------------

      const snap =
        await db
          .collection(
            "users"
          )
          .get();

      const emails =
        [];

      snap.forEach(
        (docSnap) => {
          const d =
            docSnap.data() ||
            {};

          const e =
            String(
              d.email || ""
            )
              .trim()
              .toLowerCase();

          if (
            e &&
            e.includes("@")
          ) {
            emails.push(e);
          }
        }
      );

      const unique =
        [
          ...new Set(
            emails
          ),
        ];

      let sent =
        0;

      let failed =
        0;

      for (
        const to of unique
      ) {
        try {
          await sendMail({
            to,

            subject:
              String(title),

            html,
          });

          sent +=
            1;

          await new Promise(
            (r) =>
              setTimeout(
                r,
                200
              )
          );
        } catch (err) {
          console.error(
            "Failed to",
            to,
            err.response
              ?.data ||
              err.message
          );

          failed +=
            1;
        }
      }

      const annRef =
        await db
          .collection(
            "announcements"
          )
          .add({
            title:
              String(title),

            body:
              String(body),

            audience:
              "all",

            type:
              "email",

            active:
              true,

            showBanner:
              !!showBanner,

            sentCount:
              sent,

            failedCount:
              failed,

            createdBy:
              decoded.uid,

            createdByEmail:
              decoded.email ||
              null,

            createdAt:
              FieldValue.serverTimestamp(),
          });

      /*
       * ALL = global banner.
       */
      if (showBanner) {
        await activateLiveBanner({
          announcementId:
            annRef.id,

          title:
            String(title),

          body:
            String(body),

          createdBy:
            decoded.uid,

          createdByEmail:
            decoded.email ||
            null,
        });
      }

      return res.json({
        success:
          true,

        mode:
          "all",

        total:
          unique.length,

        sent,

        failed,

        bannerActive:
          !!showBanner,

        announcementId:
          annRef.id,
      });
    } catch (error) {
      console.error(
        "Announcement email error:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Could not send announcement emails",
      });
    }
  }
);

// =====================================================
// 13. CLEAR OLD LIVE BANNER
// =====================================================

app.post(
  "/clear-live-banner",
  async (req, res) => {
    try {
      await requireAdmin(
        req
      );

      await db
        .collection(
          "settings"
        )
        .doc(
          "liveBanner"
        )
        .set(
          {
            active:
              false,

            updatedAt:
              FieldValue.serverTimestamp(),
          },
          {
            merge: true,
          }
        );

      return res.json({
        success:
          true,

        message:
          "Banner cleared",
      });
    } catch (error) {
      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Could not clear banner",
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
      success:
        true,

      message:
        "CampusMart payment server is running",
    });
  }
);

// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  () => {
    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `Frontend URL: ${FRONTEND_URL}`
    );
  }
);