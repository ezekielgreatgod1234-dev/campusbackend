const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const OpenAI = require("openai");

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
// OPENAI / CAMPUSMART AI
// =====================================================

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || "";

const CAMPUSMART_AI_MODEL =
  process.env.OPENAI_AI_MODEL ||
  "gpt-5.6-luna";

const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
    })
  : null;

if (!OPENAI_API_KEY) {
  console.warn(
    "OPENAI_API_KEY is missing — CampusMart AI will not work until it is configured."
  );
}

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
    throw new Error("targetUid is required");
  }

  const cleanMessage = String(message || "").trim();

  if (!cleanMessage) {
    throw new Error("message is required");
  }

  // IMPORTANT:
  // targetUid MUST be the REAL Firebase Authentication UID.
  await db
    .collection("userTickers")
    .doc(targetUid)
    .set(
      {
        active: true,

        message: cleanMessage,

        targetType: "single",

        targetUid,

        targetEmail: targetEmail || null,

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
// ADMIN: PUBLISH TICKER
// =====================================================
//
// This is the main endpoint used by AdminDashboard.
//
// mode:
//   "all"    -> everyone
//   "single" -> one Firebase account
//
// For single mode, email is resolved through Firebase
// Authentication to obtain the REAL Firebase UID.
// =====================================================

app.post(
  "/admin/publish-ticker",
  async (req, res) => {
    try {
      const decoded =
        await requireAdmin(req);

      const {
        mode,
        email,
        message,
      } = req.body || {};

      const cleanMode =
        String(mode || "all")
          .trim()
          .toLowerCase();

      const cleanMessage =
        String(message || "").trim();

      if (!cleanMessage) {
        return res.status(400).json({
          error:
            "message is required",
        });
      }

      // -------------------------------------------------
      // GLOBAL TICKER
      // -------------------------------------------------

      if (cleanMode === "all") {
        await db
          .collection("settings")
          .doc("liveTicker")
          .set(
            {
              active: true,

              message:
                cleanMessage,

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

        console.log(
          "GLOBAL TICKER PUBLISHED",
          {
            message:
              cleanMessage,

            createdBy:
              decoded.email ||
              decoded.uid,
          }
        );

        return res.json({
          success: true,

          mode: "all",

          message:
            "Global ticker published successfully.",
        });
      }

      // -------------------------------------------------
      // SINGLE USER TICKER
      // -------------------------------------------------

      if (cleanMode === "single") {
        if (!email) {
          return res.status(400).json({
            error:
              "email is required for single mode",
          });
        }

        const normalizedEmail =
          String(email)
            .trim()
            .toLowerCase();

        /*
         * CRITICAL:
         *
         * Never use:
         *
         * users/{documentId}
         *
         * as the Firebase UID.
         *
         * Firebase Authentication is the source of truth.
         */
        const userRecord =
          await findFirebaseUserByEmail(
            normalizedEmail
          );

        if (userRecord.disabled) {
          return res.status(400).json({
            error:
              "This Firebase account is disabled.",
          });
        }

        // Write using the REAL Firebase Auth UID.
        await publishPrivateTicker({
          targetUid:
            userRecord.uid,

          targetEmail:
            userRecord.email ||
            normalizedEmail,

          message:
            cleanMessage,

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

          mode: "single",

          targetUid:
            userRecord.uid,

          targetEmail:
            userRecord.email ||
            normalizedEmail,

          message:
            "Private ticker sent successfully.",
        });
      }

      return res.status(400).json({
        error:
          'mode must be either "all" or "single"',
      });
    } catch (error) {
      console.error(
        "Publish ticker error:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Could not publish ticker",
      });
    }
  }
);


// =====================================================
// ADMIN: CLEAR TICKER
// =====================================================
//
// Main endpoint used by AdminDashboard.
//
// mode:
//   "all"    -> clear global ticker
//   "single" -> clear one user's ticker
// =====================================================

app.post(
  "/admin/clear-ticker",
  async (req, res) => {
    try {
      const decoded =
        await requireAdmin(req);

      const {
        mode,
        email,
      } = req.body || {};

      const cleanMode =
        String(mode || "all")
          .trim()
          .toLowerCase();

      // -------------------------------------------------
      // CLEAR GLOBAL TICKER
      // -------------------------------------------------

      if (cleanMode === "all") {
        await db
          .collection("settings")
          .doc("liveTicker")
          .set(
            {
              active: false,

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

        console.log(
          "GLOBAL TICKER CLEARED"
        );

        return res.json({
          success: true,

          mode: "all",

          message:
            "Global ticker cleared.",
        });
      }

      // -------------------------------------------------
      // CLEAR PRIVATE TICKER
      // -------------------------------------------------

      if (cleanMode === "single") {
        if (!email) {
          return res.status(400).json({
            error:
              "email is required for single mode",
          });
        }

        const normalizedEmail =
          String(email)
            .trim()
            .toLowerCase();

        // Resolve REAL Firebase Auth UID.
        const userRecord =
          await findFirebaseUserByEmail(
            normalizedEmail
          );

        await db
          .collection("userTickers")
          .doc(userRecord.uid)
          .set(
            {
              active: false,

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

        console.log(
          "PRIVATE TICKER CLEARED",
          {
            targetUid:
              userRecord.uid,

            targetEmail:
              userRecord.email ||
              normalizedEmail,
          }
        );

        return res.json({
          success: true,

          mode: "single",

          targetUid:
            userRecord.uid,

          targetEmail:
            userRecord.email ||
            normalizedEmail,

          message:
            "Private ticker cleared.",
        });
      }

      return res.status(400).json({
        error:
          'mode must be either "all" or "single"',
      });
    } catch (error) {
      console.error(
        "Clear ticker error:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          "Could not clear ticker",
      });
    }
  }
);


// =====================================================
// ADMIN: LOOK UP FIREBASE AUTH USER
// =====================================================

app.get(
  "/admin/lookup-user",
  async (req, res) => {
    try {
      await requireAdmin(req);

      const email =
        String(
          req.query.email || ""
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
// OLD PRIVATE TICKER ENDPOINT
// =====================================================
//
// Kept for compatibility with your previous frontend.
// =====================================================

app.post(
  "/admin/private-ticker",
  async (req, res) => {
    try {
      const decoded =
        await requireAdmin(req);

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

      const cleanMessage =
        String(message || "").trim();

      if (!cleanMessage) {
        return res.status(400).json({
          error:
            "message is required",
        });
      }

      const normalizedEmail =
        String(email)
          .trim()
          .toLowerCase();

      const userRecord =
        await findFirebaseUserByEmail(
          normalizedEmail
        );

      if (userRecord.disabled) {
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
          cleanMessage,

        createdBy:
          decoded.uid,

        createdByEmail:
          decoded.email ||
          null,
      });

      return res.json({
        success: true,

        mode: "single",

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
// OLD PRIVATE TICKER CLEAR ENDPOINT
// =====================================================

app.post(
  "/admin/private-ticker/clear",
  async (req, res) => {
    try {
      const decoded =
        await requireAdmin(req);

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
        String(email)
          .trim()
          .toLowerCase();

      const userRecord =
        await findFirebaseUserByEmail(
          normalizedEmail
        );

      await db
        .collection("userTickers")
        .doc(userRecord.uid)
        .set(
          {
            active: false,

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
// OLD GLOBAL TICKER ENDPOINT
// =====================================================

app.post(
  "/admin/global-ticker",
  async (req, res) => {
    try {
      const decoded =
        await requireAdmin(req);

      const {
        message,
      } = req.body || {};

      const cleanMessage =
        String(message || "").trim();

      if (!cleanMessage) {
        return res.status(400).json({
          error:
            "message is required",
        });
      }

      await db
        .collection("settings")
        .doc("liveTicker")
        .set(
          {
            active: true,

            message:
              cleanMessage,

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

        mode: "all",

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
// OLD GLOBAL TICKER CLEAR ENDPOINT
// =====================================================

app.post(
  "/admin/global-ticker/clear",
  async (req, res) => {
    try {
      await requireAdmin(req);

      await db
        .collection("settings")
        .doc("liveTicker")
        .set(
          {
            active: false,

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
// CAMPUSMART AI ASSISTANT
// =====================================================

/*
 * CampusMart AI is intentionally authenticated.
 *
 * The frontend sends a Firebase ID token.
 * The backend verifies that token using Firebase Admin.
 *
 * We NEVER trust a UID, name, email, role, or other identity
 * information supplied by the browser.
 */

function cleanAiMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter(
      (message) =>
        message &&
        (message.role === "user" ||
          message.role === "assistant")
    )
    .map((message) => ({
      role: message.role,
      content: String(
        message.content || ""
      ).trim(),
    }))
    .filter(
      (message) =>
        message.content.length > 0
    )
    .slice(-20);
}


function firstExistingValue(
  object,
  keys,
  fallback = null
) {
  if (!object || typeof object !== "object") {
    return fallback;
  }

  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(
        object,
        key
      )
    ) {
      const value = object[key];

      if (
        value !== undefined &&
        value !== null &&
        value !== ""
      ) {
        return value;
      }
    }
  }

  return fallback;
}


function numericValue(
  value,
  fallback = null
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  if (typeof value === "string") {
    const cleaned = value
      .replace(/₦/g, "")
      .replace(/NGN/gi, "")
      .replace(/,/g, "")
      .replace(/\s+/g, "")
      .trim();

    const number = Number(cleaned);

    return Number.isFinite(number)
      ? number
      : fallback;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}


function normalizeProduct(
  docSnap,
  sellerData = {}
) {
  const data =
    docSnap.data() || {};

  const rawImages =
    Array.isArray(data.images)
      ? data.images
      : [];

  const image =
    firstExistingValue(
      data,
      [
        "image",
        "imageUrl",
        "imageURL",
        "photoURL",
        "thumbnail",
        "coverImage",
      ],
      null
    ) ||
    rawImages[0] ||
    null;

  const name =
    firstExistingValue(
      data,
      [
        "name",
        "title",
        "productName",
      ],
      "CampusMart Product"
    );

  const price =
    numericValue(
      firstExistingValue(
        data,
        [
          "price",
          "amount",
          "sellingPrice",
        ],
        null
      )
    );

  const sellerId =
    firstExistingValue(
      data,
      [
        "sellerId",
        "sellerUid",
        "sellerID",
        "userId",
        "ownerId",
      ],
      null
    );

  const sellerName =
    firstExistingValue(
      data,
      [
        "sellerName",
        "sellerDisplayName",
        "vendorName",
      ],
      null
    ) ||
    firstExistingValue(
      sellerData,
      [
        "fullName",
        "displayName",
        "name",
      ],
      "CampusMart Seller"
    );

  const location =
    firstExistingValue(
      data,
      [
        "location",
        "campus",
        "sellerCampus",
      ],
      null
    ) ||
    firstExistingValue(
      sellerData,
      [
        "campus",
        "location",
        "address",
      ],
      null
    );

  const category =
    firstExistingValue(
      data,
      [
        "category",
        "categoryName",
        "type",
      ],
      null
    );

  const description =
    firstExistingValue(
      data,
      [
        "description",
        "details",
        "productDescription",
      ],
      ""
    );

  const stock =
    numericValue(
      firstExistingValue(
        data,
        [
          "stock",
          "quantity",
          "availableQuantity",
        ],
        null
      )
    );

  const status =
    firstExistingValue(
      data,
      [
        "status",
        "availability",
      ],
      null
    );

  return {
    id: docSnap.id,

    name: String(name),

    price,

    image,

    images: rawImages,

    sellerId,

    sellerName,

    location,

    campus:
      location || null,

    category,

    description:
      String(description || ""),

    stock,

    status,

    url:
      `/products/${docSnap.id}`,
  };
}


async function getUserProfileForAi(
  uid
) {
  if (!uid) {
    return {};
  }

  try {
    const userSnap =
      await db
        .collection("users")
        .doc(uid)
        .get();

    if (!userSnap.exists) {
      return {};
    }

    return (
      userSnap.data() || {}
    );
  } catch (error) {
    console.error(
      "CampusMart AI user profile lookup error:",
      error.message
    );

    return {};
  }
}


async function searchCampusMartProducts(
  args = {}
) {
  const rawQuery =
    String(
      args.query || ""
    )
      .trim()
      .toLowerCase();

  const minPrice =
    numericValue(
      args.minPrice
    );

  const maxPrice =
    numericValue(
      args.maxPrice
    );

  const category =
    String(
      args.category || ""
    )
      .trim()
      .toLowerCase();

  const campus =
    String(
      args.campus || ""
    )
      .trim()
      .toLowerCase();

  /*
   * Stop words / generic phrases the model often sends
   * that are not real product keywords.
   */
  const stopWords = new Set([
    "a", "an", "the", "and", "or", "for", "to", "of", "in",
    "on", "at", "is", "are", "me", "my", "i", "im", "i'm",
    "find", "show", "search", "looking", "look", "want",
    "need", "buy", "get", "see", "any", "available",
    "currently", "something", "anything", "product",
    "products", "item", "items", "goods", "please",
    "under", "below", "above", "between", "cheap",
    "affordable", "good", "best", "nice", "new", "used",
    "campusmart", "campus", "mart", "naira", "ngn",
  ]);

  /*
   * Expand common student-marketplace synonyms so
   * "laptop" can match MacBook / HP / notebook titles.
   */
  const synonymGroups = [
    ["laptop", "laptops", "notebook", "notebooks", "macbook", "macbooks", "chromebook", "chromebooks", "computer", "computers", "pc", "pcs"],
    ["phone", "phones", "iphone", "iphones", "android", "samsung", "tecno", "infinix", "xiaomi", "mobile", "smartphone", "smartphones"],
    ["headphone", "headphones", "earphone", "earphones", "earbud", "earbuds", "airpod", "airpods", "headset", "headsets"],
    ["charger", "chargers", "cable", "cables", "adapter", "adapters", "powerbank", "powerbanks"],
    ["shoe", "shoes", "sneaker", "sneakers", "sandal", "sandals", "footwear"],
    ["bag", "bags", "backpack", "backpacks", "handbag", "handbags"],
    ["watch", "watches", "smartwatch", "smartwatches"],
    ["tablet", "tablets", "ipad", "ipads"],
    ["book", "books", "textbook", "textbooks", "novel", "novels"],
    ["clothes", "clothing", "dress", "dresses", "shirt", "shirts", "trouser", "trousers", "jean", "jeans"],
  ];

  const synonymMap = new Map();
  for (const group of synonymGroups) {
    for (const word of group) {
      synonymMap.set(word, group);
    }
  }

  function expandTokens(tokens) {
    const expanded = new Set();
    for (const token of tokens) {
      if (!token || token.length < 2) continue;
      expanded.add(token);
      const group = synonymMap.get(token);
      if (group) {
        for (const s of group) {
          expanded.add(s);
        }
      }
    }
    return Array.from(expanded);
  }

  const rawTokens =
    rawQuery
      .replace(/[₦$,]/g, " ")
      .replace(/[^a-z0-9\s+.-]/gi, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter(Boolean);

  const meaningfulTokens =
    rawTokens.filter(
      (w) =>
        !stopWords.has(w) &&
        w.length >= 2 &&
        !/^\d+(\.\d+)?$/.test(w)
    );

  const queryWords =
    expandTokens(
      meaningfulTokens.length
        ? meaningfulTokens
        : rawTokens.filter((w) => w.length >= 2)
    );

  /*
   * True when the user is browsing generally
   * ("anything available", "show products") rather than
   * asking for a specific item.
   */
  const isBrowseRequest =
    !meaningfulTokens.length ||
    (
      meaningfulTokens.length <= 1 &&
      [
        "all",
        "list",
        "browse",
        "catalog",
        "marketplace",
      ].includes(meaningfulTokens[0] || "")
    );

  let snapshot;

  try {
    snapshot =
      await db
        .collection("products")
        .limit(400)
        .get();
  } catch (error) {
    console.error(
      "CampusMart product search error:",
      error
    );

    throw new Error(
      "Could not search CampusMart products."
    );
  }

  const docs =
    snapshot.docs;

  console.log(
    "CampusMart product search:",
    {
      rawQuery,
      meaningfulTokens,
      queryWords: queryWords.slice(0, 20),
      isBrowseRequest,
      totalDocs: docs.length,
      minPrice,
      maxPrice,
      category,
      campus,
    }
  );

  const sellerIds =
    new Set();

  docs.forEach(
    (docSnap) => {
      const data =
        docSnap.data() || {};

      const sellerId =
        firstExistingValue(
          data,
          [
            "sellerId",
            "sellerUid",
            "sellerID",
            "userId",
            "ownerId",
          ],
          null
        );

      if (sellerId) {
        sellerIds.add(
          String(sellerId)
        );
      }
    }
  );

  const sellerMap =
    new Map();

  const sellerIdArray =
    Array.from(
      sellerIds
    );

  for (
    let i = 0;
    i < sellerIdArray.length;
    i += 10
  ) {
    const batch =
      sellerIdArray.slice(
        i,
        i + 10
      );

    await Promise.all(
      batch.map(
        async (sellerId) => {
          try {
            const sellerSnap =
              await db
                .collection("users")
                .doc(sellerId)
                .get();

            sellerMap.set(
              sellerId,
              sellerSnap.exists
                ? sellerSnap.data() || {}
                : {}
            );
          } catch {
            sellerMap.set(
              sellerId,
              {}
            );
          }
        }
      )
    );
  }

  const results = [];

  for (const docSnap of docs) {
    const data =
      docSnap.data() || {};

    const rawStatus =
      String(
        firstExistingValue(
          data,
          [
            "status",
            "availability",
            "productStatus",
          ],
          "active"
        )
      ).toLowerCase();

    /*
     * Only skip clearly unavailable products.
     * Missing / empty / "active" / "available" / "approved"
     * should still be searchable.
     */
    if (
      [
        "deleted",
        "removed",
        "inactive",
        "unavailable",
        "sold",
        "draft",
        "rejected",
        "banned",
      ].includes(
        rawStatus
      )
    ) {
      continue;
    }

    const sellerId =
      firstExistingValue(
        data,
        [
          "sellerId",
          "sellerUid",
          "sellerID",
          "userId",
          "ownerId",
        ],
        null
      );

    const sellerData =
      sellerId
        ? sellerMap.get(
            String(sellerId)
          ) || {}
        : {};

    const product =
      normalizeProduct(
        docSnap,
        sellerData
      );

    /*
     * Normalize price strings like "₦120,000" if needed.
     */
    if (
      product.price === null
    ) {
      const rawPrice =
        firstExistingValue(
          data,
          [
            "price",
            "amount",
            "sellingPrice",
          ],
          null
        );

      if (
        typeof rawPrice === "string"
      ) {
        const cleaned =
          rawPrice.replace(
            /[^0-9.]/g,
            ""
          );

        product.price =
          numericValue(
            cleaned
          );
      }
    }

    if (
      minPrice !== null &&
      (
        product.price === null ||
        product.price <
          minPrice
      )
    ) {
      continue;
    }

    if (
      maxPrice !== null &&
      (
        product.price === null ||
        product.price >
          maxPrice
      )
    ) {
      continue;
    }

    if (
      category &&
      !String(
        product.category || ""
      )
        .toLowerCase()
        .includes(category)
    ) {
      continue;
    }

    if (
      campus &&
      !String(
        product.location ||
          product.campus ||
          ""
      )
        .toLowerCase()
        .includes(campus)
    ) {
      continue;
    }

    const searchableText =
      [
        product.name,
        product.category,
        product.description,
        product.location,
        product.campus,
        product.sellerName,
        data.tags
          ? (
              Array.isArray(data.tags)
                ? data.tags.join(" ")
                : String(data.tags)
            )
          : "",
        data.brand
          ? String(data.brand)
          : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

    let score = 0;

    if (isBrowseRequest) {
      score = 1;
    } else if (queryWords.length) {
      const nameText =
        String(
          product.name || ""
        ).toLowerCase();

      const categoryText =
        String(
          product.category || ""
        ).toLowerCase();

      for (const word of queryWords) {
        if (nameText.includes(word)) {
          score += 12;
        } else if (
          categoryText.includes(word)
        ) {
          score += 8;
        } else if (
          searchableText.includes(word)
        ) {
          score += 4;
        }
      }

      /*
       * Bonus if the original meaningful phrase
       * appears as a whole in the name.
       */
      const phrase =
        meaningfulTokens.join(" ");

      if (
        phrase &&
        nameText.includes(phrase)
      ) {
        score += 15;
      }
    } else {
      score = 1;
    }

    /*
     * Keep products that match at least one keyword.
     * For browse requests, keep everything that passed filters.
     */
    if (
      !isBrowseRequest &&
      queryWords.length &&
      score <= 0
    ) {
      continue;
    }

    results.push({
      ...product,
      _score: score,
    });
  }

  results.sort(
    (a, b) =>
      b._score - a._score
  );

  console.log(
    "CampusMart product search results:",
    results.length
  );

  /*
   * If a specific query matched nothing, do a soft
   * fallback: return a few active products so the AI
   * can still be helpful instead of saying "none".
   * Mark them so the model can explain they are general.
   */
  if (
    !results.length &&
    !isBrowseRequest &&
    docs.length
  ) {
    const fallback = [];

    for (const docSnap of docs) {
      const data =
        docSnap.data() || {};

      const rawStatus =
        String(
          firstExistingValue(
            data,
            [
              "status",
              "availability",
              "productStatus",
            ],
            "active"
          )
        ).toLowerCase();

      if (
        [
          "deleted",
          "removed",
          "inactive",
          "unavailable",
          "sold",
          "draft",
          "rejected",
          "banned",
        ].includes(rawStatus)
      ) {
        continue;
      }

      const sellerId =
        firstExistingValue(
          data,
          [
            "sellerId",
            "sellerUid",
            "sellerID",
            "userId",
            "ownerId",
          ],
          null
        );

      const sellerData =
        sellerId
          ? sellerMap.get(
              String(sellerId)
            ) || {}
          : {};

      const product =
        normalizeProduct(
          docSnap,
          sellerData
        );

      if (
        maxPrice !== null &&
        (
          product.price === null ||
          product.price > maxPrice
        )
      ) {
        continue;
      }

      if (
        minPrice !== null &&
        (
          product.price === null ||
          product.price < minPrice
        )
      ) {
        continue;
      }

      fallback.push(product);

      if (fallback.length >= 8) {
        break;
      }
    }

    if (fallback.length) {
      console.log(
        "CampusMart product search soft-fallback:",
        fallback.length
      );

      return fallback;
    }
  }

  return results
    .slice(0, 12)
    .map(
      ({
        _score,
        ...product
      }) => product
    );
}


async function searchCampusMartGigs(
  args = {}
) {
  const queryText =
    String(
      args.query || ""
    )
      .trim()
      .toLowerCase();

  const category =
    String(
      args.category || ""
    )
      .trim()
      .toLowerCase();

  const campus =
    String(
      args.campus || ""
    )
      .trim()
      .toLowerCase();

  const minBudget =
    numericValue(
      args.minBudget
    );

  const maxBudget =
    numericValue(
      args.maxBudget
    );

  let snapshot;

  try {
    snapshot =
      await db
        .collection("gigs")
        .limit(150)
        .get();
  } catch (error) {
    console.error(
      "CampusMart gig search error:",
      error
    );

    throw new Error(
      "Could not search CampusMart gigs."
    );
  }

  const results = [];

  for (
    const docSnap of snapshot.docs
  ) {
    const data =
      docSnap.data() || {};

    const title =
      firstExistingValue(
        data,
        [
          "title",
          "name",
          "gigTitle",
        ],
        "Campus Gig"
      );

    const description =
      firstExistingValue(
        data,
        [
          "description",
          "details",
          "gigDescription",
        ],
        ""
      );

    const gigCategory =
      firstExistingValue(
        data,
        [
          "category",
          "type",
          "gigCategory",
        ],
        ""
      );

    const location =
      firstExistingValue(
        data,
        [
          "location",
          "campus",
        ],
        ""
      );

    const budget =
      numericValue(
        firstExistingValue(
          data,
          [
            "budget",
            "price",
            "amount",
          ],
          null
        )
      );

    const status =
      String(
        firstExistingValue(
          data,
          [
            "status",
            "availability",
          ],
          ""
        )
      ).toLowerCase();

    if (
      [
        "deleted",
        "removed",
        "inactive",
        "closed",
      ].includes(status)
    ) {
      continue;
    }

    if (
      minBudget !== null &&
      (
        budget === null ||
        budget < minBudget
      )
    ) {
      continue;
    }

    if (
      maxBudget !== null &&
      (
        budget === null ||
        budget > maxBudget
      )
    ) {
      continue;
    }

    if (
      category &&
      !String(
        gigCategory
      )
        .toLowerCase()
        .includes(category)
    ) {
      continue;
    }

    if (
      campus &&
      !String(
        location
      )
        .toLowerCase()
        .includes(campus)
    ) {
      continue;
    }

    const searchableText =
      [
        title,
        description,
        gigCategory,
        location,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

    let score = 0;

    if (queryText) {
      if (
        searchableText.includes(
          queryText
        )
      ) {
        score += 20;
      }

      const words =
        queryText
          .split(/\s+/)
          .filter(
            (word) =>
              word.length >= 2
          );

      for (const word of words) {
        if (
          searchableText.includes(
            word
          )
        ) {
          score += 3;
        }
      }
    } else {
      score = 1;
    }

    if (
      queryText &&
      score <= 0
    ) {
      continue;
    }

    results.push({
      id: docSnap.id,

      title: String(title),

      description:
        String(
          description || ""
        ),

      category:
        gigCategory || null,

      location:
        location || null,

      budget,

      url:
        `/gigs/${docSnap.id}`,

      _score: score,
    });
  }

  results.sort(
    (a, b) =>
      b._score - a._score
  );

  return results
    .slice(0, 12)
    .map(
      ({
        _score,
        ...gig
      }) => gig
    );
}


async function getMyCampusMartOrders(
  uid
) {
  if (!uid) {
    throw new Error(
      "Authenticated user is required."
    );
  }

  let snapshot;

  try {
    snapshot =
      await db
        .collection("orders")
        .where(
          "buyerId",
          "==",
          uid
        )
        .limit(20)
        .get();
  } catch (error) {
    console.error(
      "CampusMart order lookup error:",
      error
    );

    throw new Error(
      "Could not retrieve your CampusMart orders."
    );
  }

  return snapshot.docs.map(
    (docSnap) => {
      const data =
        docSnap.data() || {};

      const items =
        Array.isArray(
          data.items
        )
          ? data.items
          : [];

      return {
        id: docSnap.id,

        orderNumber:
          data.orderNumber ||
          data.orderId ||
          docSnap.id,

        status:
          data.status ||
          "Unknown",

        paymentStatus:
          data.paymentStatus ||
          "Unknown",

        total:
          numericValue(
            data.total,
            0
          ),

        createdAt:
          data.createdAt?.toDate
            ? data.createdAt
                .toDate()
                .toISOString()
            : data.createdAt ||
              null,

        items:
          items
            .slice(0, 20)
            .map(
              (item) => ({
                name:
                  item?.name ||
                  item?.productName ||
                  "Product",

                quantity:
                  numericValue(
                    item?.quantity,
                    1
                  ),

                price:
                  numericValue(
                    item?.price,
                    null
                  ),
              })
            ),
      };
    }
  );
}


/*
 * ---------------------------------------------------------
 * OPENAI TOOLS
 * ---------------------------------------------------------
 */

const campusMartAiTools = [
  {
    type: "function",

    name: "search_products",

    description:
      "REQUIRED for any product-related request. Search live CampusMart product listings. Call this whenever the user asks to find, show, search for, compare, recommend, browse, or locate products, items, phones, laptops, clothes, or any goods. Also call it when they mention a product name or category. Never invent product information. If results are empty, say so honestly.",

    parameters: {
      type: "object",

      properties: {
        query: {
          type: "string",
          description:
            "Short product keywords only, e.g. laptop, iPhone 13, headphones, charger, shoes. Do NOT send full sentences. Prefer 1-3 words.",
        },

        minPrice: {
          type: "number",
          description:
            "Minimum price in Nigerian Naira.",
        },

        maxPrice: {
          type: "number",
          description:
            "Maximum price in Nigerian Naira.",
        },

        category: {
          type: "string",
          description:
            "Product category if the user specifies one.",
        },

        campus: {
          type: "string",
          description:
            "Campus or location if the user specifies one.",
        },
      },

      required: ["query"],
    },
  },

  {
    type: "function",

    name: "search_gigs",

    description:
      "REQUIRED for any gig-related request. Search live CampusMart gig listings. Call this whenever the user asks to find, show, search, recommend, or browse gigs, jobs, tutoring, design work, repairs, or freelance services. Never invent gigs. If results are empty, say so honestly.",

    parameters: {
      type: "object",

      properties: {
        query: {
          type: "string",
          description:
            "Gig keywords such as tutoring, graphic design, phone repair, programming, etc. Always provide at least one useful keyword.",
        },

        category: {
          type: "string",
          description:
            "Gig category.",
        },

        campus: {
          type: "string",
          description:
            "Campus or location.",
        },

        minBudget: {
          type: "number",
          description:
            "Minimum gig budget in Nigerian Naira.",
        },

        maxBudget: {
          type: "number",
          description:
            "Maximum gig budget in Nigerian Naira.",
        },
      },

      required: ["query"],
    },
  },

  {
    type: "function",

    name: "get_my_orders",

    description:
      "REQUIRED when the user asks about their own orders, purchases, order history, payment status of their order, or tracking. Returns only the authenticated user's orders from CampusMart. Never invent orders. Never use this for other users.",

    parameters: {
      type: "object",

      properties: {},

      additionalProperties: false,
    },
  },
];


/*
 * ---------------------------------------------------------
 * CAMPUSMART AI SYSTEM PROMPT
 * ---------------------------------------------------------
 */

function buildCampusMartAiInstructions({
  uid,
  fullName,
  firstName,
  email,
  role,
  campus,
}) {
  return `
You are CampusMart AI, the friendly in-app assistant for CampusMart users.

CampusMart is a student marketplace for Nigerian campuses. Students buy and sell products, post and find gigs, chat with sellers, manage orders, and sellers withdraw their earnings. Money is in Nigerian Naira (₦). Payments are completed securely in the app.

==================================================
WHAT YOU MAY TALK ABOUT (frontend / user experience)
==================================================

Help with everyday CampusMart use only:

- Finding and browsing products on campus
- Product prices, sellers, and locations (from live search tools)
- Buying / checkout flow from the buyer's point of view
- Becoming a seller and posting products (user steps in the app)
- Gigs: finding, posting, and applying in general terms
- Orders the logged-in user asks about (via get_my_orders)
- Profiles, campus, messaging sellers, promotions as a seller feature
- How CampusMart works for students day to day

VERIFIED USER-FACING FACTS (use these; do not invent extra policies):

Buying
- Browse products, open a product, then checkout in the app.
- Pay in ₦. After a successful payment the order is marked paid.
- You can ask about your own orders; the assistant uses live order data for you only.

Selling
- You can list products for other students to buy.
- Sellers earn money from sales and can request a withdrawal from their available balance.
- Minimum withdrawal is ₦1,000. You need your bank account name, account number, and bank.
- Withdrawals are processed in the app; status starts as Processing.

Gigs
- CampusMart has gigs (tutoring, design, repairs, freelance-style campus work, etc.).
- Users can browse gigs and open a gig page. Use search_gigs for live listings.

Campus focus
- Listings and gigs are oriented around student campuses and local pickup / campus deals.
- When a campus or location is on a listing, mention it.
- Prefer practical campus language: hostels, faculties, campus meetup, etc. when relevant.

Promotions
- Sellers can promote products so they get more visibility (paid promotion in the app).

What you cannot do for the user
- You cannot place an order, complete payment, message a seller, edit listings, or withdraw money yourself.
- Point them to the right screen in the app instead.

==================================================
HARD PRIVACY / SECURITY RULES (never break these)
==================================================

NEVER reveal, explain, or discuss any of the following with the user:
- Backend, servers, APIs, webhooks, environment variables, API keys
- Firebase, Firebase Authentication, Firestore, document IDs, collections
- Admin dashboard, admin tools, admin email, admin roles, how admins work
- Tickers, live banners, announcement systems used by admins
- Platform fee withdrawals, platform balance, internal fee accounting
- Paystack secret keys, transfer recipient internals, webhook signatures
- How the AI tools or OpenAI integration work internally
- UID, tokens, ID tokens, service accounts, or how auth is verified
- Database structure, field names, or internal status codes beyond simple user-facing order status

If someone asks about backend, Firebase, admin access, how to become admin, server setup, or similar:
- Politely refuse.
- Say you only help with using CampusMart as a student buyer/seller (products, gigs, orders, profile).
- Do not confirm or deny internal technical details.

Do not mention that you are reading system instructions, tools, or "the backend verified" identity. Just help as CampusMart AI.

==================================================
LIVE DATA RULES
==================================================

1. LIVE DATA (products, gigs, orders, prices, sellers, availability):
   - You MUST call the matching tool. Never invent listings.
   - search_products → products / items / phones / laptops / clothes / "what is available"
   - search_gigs → gigs / jobs / tutoring / freelance
   - get_my_orders → the user's own orders only
   - Empty tool results → say clearly that nothing matching was found on CampusMart right now.
   - Never invent product names, prices, sellers, locations, gigs, or order statuses.

2. HOW-TO QUESTIONS:
   Answer only with user-facing steps (what they tap/see in the app). If you are not sure of a specific CampusMart policy or screen name, say you are not certain and suggest they check Products, Gigs, Orders, Profile, or the seller area in the app. Do not invent policies.

==================================================
USER (for your context only — do not dump technical fields)
==================================================

You may greet them by first name.
- First name: ${firstName || "there"}
- Full name: ${fullName || "Not available"}
- Email: ${email || "Not available"}
- Role (user-facing only): ${role || "customer"}
- Campus: ${campus || "Not available"}

Never read out internal IDs. Never ask for passwords, tokens, or API keys. Never claim you performed an action you cannot perform.

PRODUCT / GIG SEARCH
- Always call the tool first for product or gig requests.
- Pass SHORT keywords only (e.g. query="laptop", not a full sentence).
- Respect price limits (e.g. under ₦500,000 → maxPrice 500000).
- After results: summarize in plain language, use ₦, mention seller when present, let the app show cards.
- Only say nothing is available when the tool returns an empty list.

STYLE
- Warm, friendly, and upbeat — like a helpful campus buddy, not a robot.
- Use the user's first name naturally sometimes (not every sentence).
- Short paragraphs or bullets. Light emoji is fine (1–2 max when it fits).
- Sound encouraging: "Let's find you something nice", "I've got you", etc.
- No "As an AI". No stiff corporate tone.
- Talk only about using CampusMart as a student (buy, sell, gigs, orders).

MEMORY
- Conversations may be restored when the user returns.
- If they seem to be continuing an old chat, be natural — no need to restart from zero.
- Never mention how memory or storage works.

You are currently assisting ${firstName || "the user"}. Make them feel welcome.
`;
}

/*
 * ---------------------------------------------------------
 * AI CONVERSATION MEMORY
 * Stored per user in Firestore: aiConversations/{uid}
 * Used so returning users keep context and get a warm welcome.
 * ---------------------------------------------------------
 */

const AI_HISTORY_LIMIT = 40;

function serializeAiMessagesForStore(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter(
      (m) =>
        m &&
        (m.role === "user" ||
          m.role === "ai" ||
          m.role === "assistant")
    )
    .map((m, index) => {
      const role =
        m.role === "assistant" || m.role === "ai"
          ? "ai"
          : "user";

      return {
        id:
          String(
            m.id ||
              `${role}-${index}-${Date.now()}`
          ).slice(0, 80),

        role,

        text: String(
          m.text ||
            m.content ||
            ""
        ).slice(0, 4000),

        products:
          role === "ai" &&
          Array.isArray(m.products)
            ? m.products.slice(0, 12)
            : [],

        gigs:
          role === "ai" &&
          Array.isArray(m.gigs)
            ? m.gigs.slice(0, 12)
            : [],

        createdAt:
          m.createdAt ||
          new Date().toISOString(),
      };
    })
    .filter((m) => m.text.trim().length > 0)
    .slice(-AI_HISTORY_LIMIT);
}

async function loadAiConversation(uid) {
  if (!uid) {
    return null;
  }

  try {
    const snap =
      await db
        .collection("aiConversations")
        .doc(uid)
        .get();

    if (!snap.exists) {
      return null;
    }

    const data =
      snap.data() || {};

    return {
      messages:
        serializeAiMessagesForStore(
          data.messages || []
        ),

      updatedAt:
        data.updatedAt || null,

      firstName:
        data.firstName || null,
    };
  } catch (error) {
    console.error(
      "AI conversation load error:",
      error.message
    );

    return null;
  }
}

async function saveAiConversation({
  uid,
  firstName,
  messages,
}) {
  if (!uid) {
    return;
  }

  const clean =
    serializeAiMessagesForStore(
      messages
    );

  try {
    await db
      .collection("aiConversations")
      .doc(uid)
      .set(
        {
          messages: clean,

          firstName:
            firstName || null,

          updatedAt:
            FieldValue.serverTimestamp(),

          messageCount:
            clean.length,
        },
        {
          merge: true,
        }
      );
  } catch (error) {
    console.error(
      "AI conversation save error:",
      error.message
    );
  }
}

/*
 * ---------------------------------------------------------
 * AI HISTORY (load saved chat)
 * ---------------------------------------------------------
 */

app.get(
  "/ai/history",
  async (req, res) => {
    try {
      const decoded =
        await verifyFirebaseUser(
          req
        );

      const uid =
        decoded.uid;

      if (!uid) {
        return res.status(401).json({
          success: false,
          error:
            "Please log in to use CampusMart AI.",
        });
      }

      const stored =
        await loadAiConversation(
          uid
        );

      if (
        !stored ||
        !stored.messages.length
      ) {
        return res.json({
          success: true,

          hasHistory: false,

          returningAfter24h: false,

          messages: [],
        });
      }

      let updatedMs =
        null;

      if (
        stored.updatedAt &&
        typeof stored.updatedAt.toDate ===
          "function"
      ) {
        updatedMs =
          stored.updatedAt
            .toDate()
            .getTime();
      } else if (
        stored.updatedAt
      ) {
        updatedMs =
          new Date(
            stored.updatedAt
          ).getTime();
      }

      const hoursSince =
        updatedMs
          ? (Date.now() - updatedMs) /
            (1000 * 60 * 60)
          : null;

      const returningAfter24h =
        hoursSince !== null &&
        hoursSince >= 24;

      return res.json({
        success: true,

        hasHistory: true,

        returningAfter24h,

        hoursSince:
          hoursSince !== null
            ? Math.round(
                hoursSince * 10
              ) / 10
            : null,

        messages:
          stored.messages,

        firstName:
          stored.firstName ||
          null,
      });
    } catch (error) {
      console.error(
        "AI history error:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        error:
          error.message ||
          "Could not load chat history.",
      });
    }
  }
);


/*
 * ---------------------------------------------------------
 * AI CHAT ENDPOINT
 * ---------------------------------------------------------
 */

app.post(
  "/ai/chat",
  async (req, res) => {
    try {
      /*
       * OpenAI configuration check
       */
      if (!openai) {
        return res.status(503).json({
          success: false,

          error:
            "CampusMart AI is not available right now. Please try again later.",
        });
      }

      /*
       * Verify Firebase Authentication.
       */
      const decoded =
        await verifyFirebaseUser(
          req
        );

      const uid =
        decoded.uid;

      if (!uid) {
        return res.status(401).json({
          success: false,
          error:
            "Please log in to use CampusMart AI.",
        });
      }

      /*
       * Get trusted Firestore profile information.
       */
      const userProfile =
        await getUserProfileForAi(
          uid
        );

      const fullName =
        String(
          firstExistingValue(
            userProfile,
            [
              "fullName",
              "displayName",
              "name",
            ],
            decoded.name || ""
          ) || ""
        ).trim();

      const firstName =
        (
          fullName ||
          decoded.name ||
          decoded.email?.split("@")?.[0] ||
          "there"
        )
          .split(/\s+/)[0];

      const role =
        firstExistingValue(
          userProfile,
          [
            "role",
          ],
          decoded.role ||
            "customer"
        );

      const campus =
        firstExistingValue(
          userProfile,
          [
            "campus",
            "school",
            "university",
            "location",
          ],
          null
        );

      const email =
        decoded.email ||
        userProfile.email ||
        "";

      /*
       * Validate the current message.
       */
      const userMessage =
        String(
          req.body?.message || ""
        ).trim();

      if (!userMessage) {
        return res.status(400).json({
          success: false,
          error:
            "message is required.",
        });
      }

      /*
       * Clean conversation history.
       */
      const previousMessages =
        cleanAiMessages(
          req.body?.messages
        );

      /*
       * Make sure the current message exists at the end
       * even if the frontend history is incomplete.
       */
      const conversation = [
        ...previousMessages,
        {
          role: "user",
          content: userMessage,
        },
      ].slice(-20);

      /*
       * Remove immediately duplicated current user message
       * if the frontend already included it.
       */
      const normalizedConversation =
        [];

      for (
        const message of conversation
      ) {
        const previous =
          normalizedConversation[
            normalizedConversation.length - 1
          ];

        if (
          previous &&
          previous.role ===
            message.role &&
          previous.content ===
            message.content
        ) {
          continue;
        }

        normalizedConversation.push(
          message
        );
      }

      /*
       * Trusted system instructions.
       */
      const instructions =
        buildCampusMartAiInstructions({
          uid,
          fullName,
          firstName,
          email,
          role,
          campus,
        });

      /*
       * First Responses API call.
       */
      let response =
        await openai.responses.create(
          {
            model:
              CAMPUSMART_AI_MODEL,

            instructions,

            input:
              normalizedConversation,

            tools:
              campusMartAiTools,
          }
        );

      /*
       * Tool execution loop.
       *
       * AI may ask for:
       * - products
       * - gigs
       * - orders
       *
       * We execute those on the server using the authenticated
       * Firebase user.
       */
      let finalProducts = [];
      let finalGigs = [];

      for (
        let round = 0;
        round < 3;
        round++
      ) {
        const toolCalls =
          Array.isArray(
            response?.output
          )
            ? response.output.filter(
                (item) =>
                  item &&
                  item.type ===
                    "function_call"
              )
            : [];

        if (
          toolCalls.length === 0
        ) {
          break;
        }

        const toolOutputs =
          [];

        for (
          const toolCall of toolCalls
        ) {
          const toolName =
            toolCall.name;

          let args = {};

          try {
            args =
              toolCall.arguments
                ? JSON.parse(
                    toolCall.arguments
                  )
                : {};
          } catch {
            args = {};
          }

          try {
            /*
             * -----------------------------------------------
             * PRODUCT SEARCH
             * -----------------------------------------------
             */
            if (
              toolName ===
              "search_products"
            ) {
              const products =
                await searchCampusMartProducts(
                  args
                );

              finalProducts =
                products;

              toolOutputs.push({
                type:
                  "function_call_output",

                call_id:
                  toolCall.call_id,

                output:
                  JSON.stringify({
                    success:
                      true,

                    count:
                      products.length,

                    products,
                  }),
              });

              continue;
            }

            /*
             * -----------------------------------------------
             * GIG SEARCH
             * -----------------------------------------------
             */
            if (
              toolName ===
              "search_gigs"
            ) {
              const gigs =
                await searchCampusMartGigs(
                  args
                );

              finalGigs =
                gigs;

              toolOutputs.push({
                type:
                  "function_call_output",

                call_id:
                  toolCall.call_id,

                output:
                  JSON.stringify({
                    success:
                      true,

                    count:
                      gigs.length,

                    gigs,
                  }),
              });

              continue;
            }

            /*
             * -----------------------------------------------
             * OWN ORDERS
             * -----------------------------------------------
             */
            if (
              toolName ===
              "get_my_orders"
            ) {
              const orders =
                await getMyCampusMartOrders(
                  uid
                );

              toolOutputs.push({
                type:
                  "function_call_output",

                call_id:
                  toolCall.call_id,

                output:
                  JSON.stringify({
                    success:
                      true,

                    count:
                      orders.length,

                    orders,
                  }),
              });

              continue;
            }

            /*
             * Unknown tool
             */
            toolOutputs.push({
              type:
                "function_call_output",

              call_id:
                toolCall.call_id,

              output:
                JSON.stringify({
                  success:
                    false,

                  error:
                    "Unknown CampusMart AI tool.",
                }),
            });
          } catch (toolError) {
            console.error(
              `CampusMart AI tool error (${toolName}):`,
              toolError
            );

            toolOutputs.push({
              type:
                "function_call_output",

              call_id:
                toolCall.call_id,

              output:
                JSON.stringify({
                  success:
                    false,

                  error:
                    toolError.message ||
                    "Tool execution failed.",
                }),
            });
          }
        }

        /*
         * Send tool results back to OpenAI.
         */
        response =
          await openai.responses.create(
            {
              model:
                CAMPUSMART_AI_MODEL,

              instructions,

              previous_response_id:
                response.id,

              input:
                toolOutputs,

              tools:
                campusMartAiTools,
            }
          );
      }

      /*
       * Extract final AI response.
       */
      const reply =
        String(
          response?.output_text ||
            ""
        ).trim();

      if (!reply) {
        return res.status(502).json({
          success: false,

          error:
            "CampusMart AI could not generate a reply. Please try again.",
        });
      }

      /*
       * Persist conversation so the user can continue later.
       */
      try {
        const historyForStore = [
          ...normalizedConversation.map(
            (m) => ({
              role:
                m.role === "assistant"
                  ? "ai"
                  : m.role,

              text: m.content,

              products: [],

              gigs: [],
            })
          ),

          {
            role: "ai",

            text: reply,

            products:
              Array.isArray(
                finalProducts
              )
                ? finalProducts
                : [],

            gigs:
              Array.isArray(
                finalGigs
              )
                ? finalGigs
                : [],

            createdAt:
              new Date().toISOString(),
          },
        ];

        await saveAiConversation({
          uid,

          firstName,

          messages:
            historyForStore,
        });
      } catch (saveErr) {
        console.error(
          "AI save after chat failed:",
          saveErr.message
        );
      }

      /*
       * Return only the information needed by the frontend.
       */
      return res.json({
        success: true,

        reply,

        firstName,

        products:
          Array.isArray(
            finalProducts
          )
            ? finalProducts
            : [],

        gigs:
          Array.isArray(
            finalGigs
          )
            ? finalGigs
            : [],
      });
    } catch (error) {
      console.error(
        "CampusMart AI endpoint error:",
        error
      );

      const status =
        error?.status ||
        error?.statusCode ||
        500;

      let message =
        error?.message ||
        "CampusMart AI request failed.";

      /*
       * Hide unnecessary provider internals from users.
       */
      if (
        status >= 500 &&
        (
          message.includes(
            "OpenAI"
          ) ||
          message.includes(
            "API"
          )
        )
      ) {
        message =
          "CampusMart AI is temporarily unavailable. Please try again.";
      }

      return res
        .status(status)
        .json({
          success: false,
          error: message,
        });
    }
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