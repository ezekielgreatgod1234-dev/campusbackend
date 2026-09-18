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

const {
  getMessaging,
} = require("firebase-admin/messaging");

require("dotenv").config();

const app = express();




// =====================================================
// GOOGLE GEMINI / CAMPUSMART AI
// OpenAI-compatible client → Gemini free tier
// Docs: https://ai.google.dev/gemini-api/docs/openai
// =====================================================

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.XAI_API_KEY ||
  process.env.OPENAI_API_KEY ||
  "";

const CAMPUSMART_AI_MODEL =
  process.env.GEMINI_AI_MODEL ||
  process.env.GROK_AI_MODEL ||
  process.env.OPENAI_AI_MODEL ||
  "gemini-3.6-flash";

/*
 * If the configured model is unavailable, try these free-tier
 * Flash models in order (Google currently points new keys to 3.6+).
 */
const GEMINI_MODEL_FALLBACKS = [
  CAMPUSMART_AI_MODEL,
  "gemini-3.6-flash",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
].filter(
  (name, index, arr) =>
    name && arr.indexOf(name) === index
);

const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ||
  process.env.XAI_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai/";

const openai = GEMINI_API_KEY
  ? new OpenAI({
      apiKey: GEMINI_API_KEY,
      baseURL: GEMINI_BASE_URL,
    })
  : null;

if (!GEMINI_API_KEY) {
  console.warn(
    "GEMINI_API_KEY is missing — CampusMart AI will not work until it is configured. Get a free key at https://aistudio.google.com/apikey"
  );
}

/*
 * =====================================================
 * AI QUOTA COOLDOWN CACHE
 * =====================================================
 * Once Gemini tells us we're rate-limited / out of quota,
 * remember that in memory for a short cooldown window. Any
 * /ai/chat request that comes in during that window gets the
 * "limit reached" message back immediately (no auth lookup,
 * no Firestore read, no call to Gemini) instead of waiting
 * on another slow round-trip that's just going to fail the
 * same way. This is what makes the limit message "show fast".
 */
const AI_QUOTA_COOLDOWN_MS = 60 * 1000; // 1 minute

let aiQuotaCooldownUntil = 0;

function markAiQuotaExceeded() {
  aiQuotaCooldownUntil =
    Date.now() + AI_QUOTA_COOLDOWN_MS;
}

function getAiQuotaCooldownSecondsLeft() {
  return Math.max(
    0,
    Math.ceil(
      (aiQuotaCooldownUntil - Date.now()) / 1000
    )
  );
}

function isAiQuotaOnCooldown() {
  return Date.now() < aiQuotaCooldownUntil;
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
  "http://localhost:5175",
  "http://localhost:5176",
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
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
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
const messaging = getMessaging();

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
// FCM PUSH NOTIFICATIONS
// =====================================================

/**
 * Send a web/mobile push to a single user by Firebase Auth UID.
 * Reads fcmToken from users/{uid}. Skips quietly if missing/disabled.
 */
async function sendPushToUser(uid, { title, body, data } = {}) {
  if (!uid) {
    return { ok: false, reason: "missing_uid" };
  }

  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) {
    return { ok: false, reason: "user_not_found" };
  }

  const user = snap.data() || {};

  if (user.notificationsEnabled === false) {
    return { ok: false, reason: "disabled" };
  }

  // Support multiple devices: fcmTokens[] + legacy single fcmToken
  const tokenSet = new Set();
  if (Array.isArray(user.fcmTokens)) {
    user.fcmTokens.forEach((t) => {
      const s = String(t || "").trim();
      if (s) tokenSet.add(s);
    });
  }
  const legacy = String(user.fcmToken || "").trim();
  if (legacy) tokenSet.add(legacy);

  const tokens = Array.from(tokenSet);
  if (!tokens.length) {
    return { ok: false, reason: "no_token" };
  }

  const notification = {
    title: String(title || "CampusMart"),
    body: String(body || "You have a new update"),
  };

  const dataPayload = Object.fromEntries(
    Object.entries(data || {}).map(([k, v]) => [
      String(k),
      v == null ? "" : String(v),
    ])
  );

  const link =
    process.env.FRONTEND_URL || "https://campus-mart-ashen.vercel.app";

  let sent = 0;
  let failed = 0;
  const invalidTokens = [];
  let lastMessageId = null;

  const iconUrl = `${String(link).replace(/\/$/, "")}/pwa-192x192.png`;

  for (const token of tokens) {
    try {
      lastMessageId = await messaging.send({
        token,
        // Top-level notification helps many clients show a system banner
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data: {
          ...dataPayload,
          title: notification.title,
          body: notification.body,
        },
        webpush: {
          headers: {
            Urgency: "high",
            TTL: "86400",
          },
          notification: {
            title: notification.title,
            body: notification.body,
            icon: iconUrl,
            badge: iconUrl,
            vibrate: [200, 100, 200],
            tag: dataPayload.type || "campusmart",
            renotify: true,
          },
          fcmOptions: {
            link,
          },
        },
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      const code = err?.code || err?.errorInfo?.code || "";
      console.error("FCM send error:", code, err.message);

      if (
        String(code).includes("registration-token-not-registered") ||
        String(code).includes("invalid-registration-token") ||
        String(code).includes("invalid-argument") ||
        String(err.message || "").toLowerCase().includes("not a valid fcm")
      ) {
        invalidTokens.push(token);
      }
    }
  }

  // Remove dead tokens, keep the rest
  if (invalidTokens.length) {
    try {
      const remaining = tokens.filter((t) => !invalidTokens.includes(t));
      await db.collection("users").doc(uid).set(
        {
          fcmTokens: remaining,
          fcmToken: remaining[0] || null,
          notificationsEnabled: remaining.length > 0,
          fcmTokenUpdatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (_) {}
  }

  if (sent === 0) {
    return {
      ok: false,
      reason: "fcm_error",
      error: "No device accepted the push",
      failed,
    };
  }

  return {
    ok: true,
    messageId: lastMessageId,
    sent,
    failed,
  };
}

/**
 * Send the same push to many UIDs (best-effort).
 */
async function sendPushToUsers(uids, payload) {
  const list = Array.isArray(uids) ? uids.filter(Boolean) : [];
  let sent = 0;
  let failed = 0;

  for (const uid of list) {
    const result = await sendPushToUser(uid, payload);
    if (result.ok) sent += 1;
    else failed += 1;
  }

  return { sent, failed, total: list.length };
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

      // Notify seller of new paid order (best-effort, don't fail webhook)
      try {
        if (sellerId) {
          const orderLabel = orderId
            ? `Order #${String(orderId).slice(0, 8).toUpperCase()}`
            : "New order";
          const amountLabel = `₦${Number(sellerAmount || 0).toLocaleString("en-NG")}`;
          await sendPushToUser(sellerId, {
            title: "New order on CampusMart",
            body: `${orderLabel} — you earned ${amountLabel} (95% after fee). Open Orders to fulfill it.`,
            data: {
              type: "order",
              orderId: orderId ? String(orderId) : "",
              path: "/seller/orders",
            },
          });
        }
      } catch (pushErr) {
        console.error("Order push notify error:", pushErr.message);
      }

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
// IMPORTANT:
// This email is sent ONLY after the user has verified
// their email address. The frontend (Login.jsx) calls
// this endpoint with the user's Firebase ID token right
// after a successful, verified login. The endpoint is
// idempotent: it checks users/{uid}.welcomeEmailSent so
// a user can never receive the welcome email twice.
//
// POST /send-welcome-email
// Auth: Bearer <firebase id token>
// Body: {} (nothing required)
// =====================================================

const WELCOME_EMAIL_SUBJECT =
  "Welcome to CampusMart 2.0";

const WELCOME_SUPPORT_EMAIL =
  "campusmart1234@gmail.com";

function buildWelcomeEmailHtml(name) {
  const safeName =
    String(name || "there").replace(
      /[<>]/g,
      ""
    );

  const bullet = (label, text) => `
    <tr>
      <td
        style="
          padding:0 0 10px;
          font-size:14px;
          line-height:1.6;
          color:#374151;
        "
      >
        <strong style="color:#111827;">${label}</strong>
        &mdash; ${text}
      </td>
    </tr>`;

  return `
    <p style="margin:0 0 14px;">
      Hi ${safeName},
    </p>

    <p style="margin:0 0 14px;">
      Welcome to CampusMart 2.0! We&rsquo;re excited to have
      you join our campus community.
    </p>

    <p style="margin:0 0 14px;">
      CampusMart is designed to make campus life easier by
      giving students a simple and convenient way to discover
      products from verified campus sellers, post or apply for
      gigs, communicate with other users, and make secure
      payments through Paystack.
    </p>

    <p style="margin:0 0 10px; font-weight:bold; color:#111827;">
      With your CampusMart account, you can:
    </p>

    <table
      width="100%"
      cellpadding="0"
      cellspacing="0"
      style="margin:0 0 6px;"
    >
      ${bullet(
        "Shop on Campus",
        "Discover products and services offered by campus sellers."
      )}
      ${bullet(
        "Find &amp; Post Gigs",
        "Connect with students for opportunities, tasks, and services."
      )}
      ${bullet(
        "Chat &amp; Connect",
        "Communicate directly with buyers, sellers, and gig participants."
      )}
      ${bullet(
        "Pay Securely",
        "Enjoy secure payments powered by Paystack."
      )}
      ${bullet(
        "Track Your Orders",
        "Keep up with your purchases and order status in one place."
      )}
      ${bullet(
        "Stay Updated",
        "Receive important announcements and updates from CampusMart."
      )}
    </table>

    <table
      width="100%"
      cellpadding="0"
      cellspacing="0"
      style="
        margin:8px 0 16px;
        background:#f0fdf4;
        border:1px solid #bbf7d0;
        border-radius:12px;
      "
    >
      <tr>
        <td style="padding:14px 16px;">
          <p
            style="
              margin:0 0 8px;
              font-weight:bold;
              color:#065f46;
              font-size:14px;
            "
          >
            A quick safety reminder
          </p>

          <p
            style="
              margin:0 0 8px;
              font-size:13px;
              line-height:1.6;
              color:#047857;
            "
          >
            Your safety matters to us. Whenever possible, meet in
            safe, public places on campus when completing
            transactions or exchanging products.
          </p>

          <p
            style="
              margin:0;
              font-size:13px;
              line-height:1.6;
              color:#047857;
            "
          >
            Also, please check your email inbox and Spam/Junk
            folder regularly so you don&rsquo;t miss important
            CampusMart notifications.
          </p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 14px;">
      We&rsquo;re constantly improving CampusMart to make buying,
      selling, and connecting on campus easier and more reliable.
    </p>

    <p style="margin:0 0 14px;">
      Thank you for joining us, and welcome to CampusMart 2.0!
    </p>

    <table
      align="center"
      cellpadding="0"
      cellspacing="0"
      style="margin:4px 0 18px;"
    >
      <tr>
        <td
          style="
            background:#008236;
            border-radius:10px;
          "
        >
          <a
            href="${FRONTEND_URL}/dashboard"
            style="
              display:inline-block;
              padding:12px 22px;
              font-size:14px;
              font-weight:bold;
              color:#ffffff;
              text-decoration:none;
            "
          >
            Start exploring CampusMart
          </a>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 4px;">
      Best regards,
    </p>

    <p style="margin:0; font-weight:bold; color:#111827;">
      The CampusMart Team
    </p>

    <p style="margin:6px 0 0; font-size:13px;">
      <a
        href="mailto:${WELCOME_SUPPORT_EMAIL}"
        style="color:#008236; text-decoration:none;"
      >
        ${WELCOME_SUPPORT_EMAIL}
      </a>
    </p>
  `;
}

function buildWelcomeEmailText(name) {
  const safeName = String(name || "there");

  return [
    `Hi ${safeName},`,
    "",
    "Welcome to CampusMart 2.0! We're excited to have you join our campus community.",
    "",
    "CampusMart is designed to make campus life easier by giving students a simple and convenient way to discover products from verified campus sellers, post or apply for gigs, communicate with other users, and make secure payments through Paystack.",
    "",
    "With your CampusMart account, you can:",
    "- Shop on Campus: Discover products and services offered by campus sellers.",
    "- Find & Post Gigs: Connect with students for opportunities, tasks, and services.",
    "- Chat & Connect: Communicate directly with buyers, sellers, and gig participants.",
    "- Pay Securely: Enjoy secure payments powered by Paystack.",
    "- Track Your Orders: Keep up with your purchases and order status in one place.",
    "- Stay Updated: Receive important announcements and updates from CampusMart.",
    "",
    "A quick safety reminder",
    "Your safety matters to us. Whenever possible, meet in safe, public places on campus when completing transactions or exchanging products.",
    "Also, please check your email inbox and Spam/Junk folder regularly so you don't miss important CampusMart notifications.",
    "",
    "We're constantly improving CampusMart to make buying, selling, and connecting on campus easier and more reliable.",
    "",
    "Thank you for joining us, and welcome to CampusMart 2.0!",
    "",
    "Best regards,",
    "The CampusMart Team",
    WELCOME_SUPPORT_EMAIL,
  ].join("\n");
}

app.post(
  "/send-welcome-email",
  async (req, res) => {
    try {
      // 1. Must be a logged-in user
      const decoded =
        await verifyFirebaseUser(req);

      const uid = decoded.uid;

      // 2. Must have a VERIFIED email.
      //    We read from Firebase Auth (not the token) so a
      //    user who just verified does not have to wait for
      //    a fresh token.
      let userRecord;

      try {
        userRecord =
          await adminAuth.getUser(uid);
      } catch (err) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      const email = String(
        userRecord.email || ""
      )
        .trim()
        .toLowerCase();

      if (!email) {
        return res.status(400).json({
          error:
            "This account has no email address",
        });
      }

      const isAdminAccount =
        email ===
        ADMIN_EMAIL.toLowerCase();

      if (
        !userRecord.emailVerified &&
        !isAdminAccount
      ) {
        return res.status(403).json({
          success: false,

          emailSent: false,

          reason: "email_not_verified",

          error:
            "Welcome email is only sent after the email address is verified",
        });
      }

      // 3. Never send it twice
      const userRef = db
        .collection("users")
        .doc(uid);

      let userData = {};

      try {
        const userSnap =
          await userRef.get();

        if (userSnap.exists) {
          userData =
            userSnap.data() || {};
        }
      } catch (err) {
        console.warn(
          "welcome email: could not read user doc:",
          err.message
        );
      }

      if (userData.welcomeEmailSent === true) {
        return res.json({
          success: true,

          emailSent: false,

          skipped: true,

          reason: "already_sent",

          message:
            "Welcome email was already sent to this account",
        });
      }

      // 4. Admin can switch welcome emails off, or
      //    override the subject / body in Firestore at
      //    settings/welcomeMessage
      let enabled = true;
      let customTitle = "";
      let customBody = "";

      try {
        const snap = await db
          .collection("settings")
          .doc("welcomeMessage")
          .get();

        if (snap.exists) {
          const w = snap.data() || {};

          if (w.enabled === false) {
            enabled = false;
          }

          if (w.title) {
            customTitle = String(w.title);
          }

          if (w.body) {
            customBody = String(w.body);
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

          emailSent: false,

          skipped: true,

          reason: "disabled",

          message: "Welcome emails disabled",
        });
      }

      // 5. Personalise
      const fullName = String(
        userData.fullName ||
          userRecord.displayName ||
          ""
      ).trim();

      const name =
        fullName.split(/\s+/)[0] || "there";

      const subject = (
        customTitle || WELCOME_EMAIL_SUBJECT
      ).replace(/\{\{?name\}?\}/g, name);

      const bodyHtml = customBody
        ? customBody
            .replace(/\{\{?name\}?\}/g, name)
            .split("\n")
            .map(
              (line) =>
                `<p style="margin:0 0 10px;">${line}</p>`
            )
            .join("")
        : buildWelcomeEmailHtml(name);

      const bodyText = customBody
        ? customBody.replace(
            /\{\{?name\}?\}/g,
            name
          )
        : buildWelcomeEmailText(name);

      // 6. Send
      try {
        await sendMail({
          to: email,

          subject,

          html: emailLayout({
            title: subject,
            bodyHtml,
          }),

          text: bodyText,
        });
      } catch (mailErr) {
        console.error(
          "Welcome email send failed:",
          mailErr.response?.data ||
            mailErr.message
        );

        return res.json({
          success: true,

          emailSent: false,

          reason: "mail_failed",

          message:
            "Could not send the welcome email right now",
        });
      }

      // 7. Mark as sent so it never repeats
      try {
        await userRef.set(
          {
            emailVerified: true,
            welcomeEmailSent: true,
            welcomeEmailSentAt:
              FieldValue.serverTimestamp(),
            updatedAt:
              FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } catch (err) {
        console.warn(
          "welcome email: could not flag user doc:",
          err.message
        );
      }

      return res.json({
        success: true,

        emailSent: true,

        message: "Welcome email sent",
      });
    } catch (error) {
      console.error(
        "Welcome email error:",
        error
      );

      return res
        .status(error.status || 500)
        .json({
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
    .slice(-10);
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
    ["clothes", "clothing", "dress", "dresses", "shirt", "shirts", "trouser", "trousers", "jean", "jeans", "fashion", "apparel"],
    ["food", "foods", "meal", "meals", "snack", "snacks", "drink", "drinks", "beverage", "beverages", "grocery", "groceries", "edible", "cuisine", "cooking", "restaurant", "rice", "beans", "soup", "bread", "chicken", "fish", "meat", "fruit", "fruits", "vegetable", "vegetables", "shawarma", "pizza", "burger", "noodles", "pasta", "jollof", "swallow", "semo", "pounded", "yam", "plantain", "egg", "eggs", "milk", "juice", "water", "softdrink", "soft-drink"],
    ["cosmetic", "cosmetics", "makeup", "skincare", "beauty", "cream", "lotion", "perfume", "perfumes"],
    ["furniture", "chair", "chairs", "table", "tables", "bed", "mattress"],
    ["appliance", "appliances", "fridge", "freezer", "kettle", "blender", "microwave", "iron", "fan", "fans"],
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

    /*
     * Match ONLY on product content — never on seller name alone.
     * Otherwise a food query can pull phones from a seller who also sells food.
     */
    const nameText =
      String(
        product.name || ""
      ).toLowerCase();

    const categoryText =
      String(
        product.category || ""
      ).toLowerCase();

    const descriptionText =
      String(
        product.description || ""
      ).toLowerCase();

    const tagsText =
      data.tags
        ? (
            Array.isArray(data.tags)
              ? data.tags.join(" ")
              : String(data.tags)
          ).toLowerCase()
        : "";

    const brandText =
      data.brand
        ? String(data.brand).toLowerCase()
        : "";

    const productText =
      [
        nameText,
        categoryText,
        descriptionText,
        tagsText,
        brandText,
      ]
        .filter(Boolean)
        .join(" ");

    let score = 0;
    let matchedOnProduct = false;

    if (isBrowseRequest) {
      score = 1;
      matchedOnProduct = true;
    } else if (queryWords.length) {
      for (const word of queryWords) {
        if (!word || word.length < 2) {
          continue;
        }

        if (nameText.includes(word)) {
          score += 20;
          matchedOnProduct = true;
        }

        if (categoryText.includes(word)) {
          score += 18;
          matchedOnProduct = true;
        }

        if (tagsText.includes(word)) {
          score += 14;
          matchedOnProduct = true;
        }

        if (descriptionText.includes(word)) {
          score += 8;
          matchedOnProduct = true;
        }

        if (brandText.includes(word)) {
          score += 10;
          matchedOnProduct = true;
        }
      }

      const phrase =
        meaningfulTokens.join(" ");

      if (
        phrase &&
        nameText.includes(phrase)
      ) {
        score += 25;
        matchedOnProduct = true;
      }

      if (
        phrase &&
        categoryText.includes(phrase)
      ) {
        score += 22;
        matchedOnProduct = true;
      }
    } else {
      score = 1;
      matchedOnProduct = true;
    }

    /*
     * Strict filter: product fields must match the query.
     * Do not include unrelated items just because the seller sells something else.
     */
    if (
      !isBrowseRequest &&
      queryWords.length &&
      !matchedOnProduct
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
   * No soft-fallback of unrelated products.
   * If the user asked for food, only food (or nothing) is returned.
   */
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
  const rawQuery =
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

  const stopWords = new Set([
    "a", "an", "the", "and", "or", "for", "to", "of", "in",
    "on", "at", "is", "are", "me", "my", "i", "im", "i'm",
    "find", "show", "search", "looking", "look", "want",
    "need", "get", "see", "any", "available", "currently",
    "something", "anything", "please", "all", "list",
    "campusmart", "campus", "mart",
  ]);

  /*
   * Generic words that mean "browse gigs", not a topic keyword.
   */
  const browseWords = new Set([
    "gig",
    "gigs",
    "job",
    "jobs",
    "work",
    "service",
    "services",
    "freelance",
    "opportunity",
    "opportunities",
  ]);

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

  const topicTokens =
    meaningfulTokens.filter(
      (w) => !browseWords.has(w)
    );

  /*
   * "show me gigs" / "find gigs" / empty topic → browse all open gigs.
   */
  const isBrowseRequest =
    topicTokens.length === 0;

  const queryWords =
    topicTokens.length
      ? topicTokens
      : [];

  let snapshot;

  try {
    /*
     * Support both common collection names.
     */
    snapshot =
      await db
        .collection("gigs")
        .limit(300)
        .get();

    if (snapshot.empty) {
      const alt =
        await db
          .collection("gig")
          .limit(300)
          .get();

      if (!alt.empty) {
        snapshot = alt;
      }
    }
  } catch (error) {
    console.error(
      "CampusMart gig search error:",
      error
    );

    throw new Error(
      "Could not search CampusMart gigs."
    );
  }

  console.log(
    "CampusMart gig search:",
    {
      rawQuery,
      topicTokens,
      isBrowseRequest,
      totalDocs: snapshot.docs.length,
      category,
      campus,
      minBudget,
      maxBudget,
    }
  );

  const results = [];

  for (const docSnap of snapshot.docs) {
    const data =
      docSnap.data() || {};

    const title =
      firstExistingValue(
        data,
        [
          "title",
          "name",
          "gigTitle",
          "gigName",
          "jobTitle",
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
          "about",
          "summary",
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
          "jobType",
          "skill",
          "skills",
        ],
        ""
      );

    const location =
      firstExistingValue(
        data,
        [
          "location",
          "campus",
          "school",
          "university",
          "address",
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
            "pay",
            "payment",
            "rate",
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
            "gigStatus",
          ],
          "active"
        )
      ).toLowerCase();

    if (
      [
        "deleted",
        "removed",
        "inactive",
        "closed",
        "draft",
        "rejected",
        "banned",
        "expired",
        "completed",
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
      !String(gigCategory)
        .toLowerCase()
        .includes(category)
    ) {
      continue;
    }

    if (
      campus &&
      !String(location)
        .toLowerCase()
        .includes(campus)
    ) {
      continue;
    }

    const titleText =
      String(title).toLowerCase();

    const categoryText =
      String(gigCategory).toLowerCase();

    const descriptionText =
      String(description).toLowerCase();

    const tagsText =
      data.tags
        ? (
            Array.isArray(data.tags)
              ? data.tags.join(" ")
              : String(data.tags)
          ).toLowerCase()
        : "";

    const productText =
      [
        titleText,
        categoryText,
        descriptionText,
        tagsText,
        String(location).toLowerCase(),
      ]
        .filter(Boolean)
        .join(" ");

    let score = 0;
    let matched = false;

    if (isBrowseRequest) {
      score = 1;
      matched = true;
    } else {
      for (const word of queryWords) {
        if (titleText.includes(word)) {
          score += 20;
          matched = true;
        }

        if (categoryText.includes(word)) {
          score += 16;
          matched = true;
        }

        if (tagsText.includes(word)) {
          score += 12;
          matched = true;
        }

        if (descriptionText.includes(word)) {
          score += 8;
          matched = true;
        }
      }

      const phrase =
        queryWords.join(" ");

      if (
        phrase &&
        titleText.includes(phrase)
      ) {
        score += 25;
        matched = true;
      }
    }

    if (!matched) {
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

  console.log(
    "CampusMart gig search results:",
    results.length
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
    function: {
      name: "search_products",
      description:
        "REQUIRED for any product-related request. Search live CampusMart product listings. Call this whenever the user asks to find, show, search for, compare, recommend, browse, or locate products. Never invent product information.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Short product keywords only, e.g. laptop, food, iPhone 13. Prefer 1-3 words.",
          },
          minPrice: {
            type: "number",
            description: "Minimum price in Nigerian Naira.",
          },
          maxPrice: {
            type: "number",
            description: "Maximum price in Nigerian Naira.",
          },
          category: {
            type: "string",
            description: "Product category if the user specifies one.",
          },
          campus: {
            type: "string",
            description: "Campus or location if the user specifies one.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_gigs",
      description:
        "REQUIRED for any gig-related request. Search live CampusMart gig listings. For general requests like show gigs or find jobs, use query=\"gigs\". For specific topics use short keywords like tutoring or design. Never invent gigs.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Short gig keywords, e.g. tutoring, design, repair.",
          },
          category: {
            type: "string",
            description: "Gig category.",
          },
          campus: {
            type: "string",
            description: "Campus or location.",
          },
          minBudget: {
            type: "number",
            description: "Minimum gig budget in Nigerian Naira.",
          },
          maxBudget: {
            type: "number",
            description: "Maximum gig budget in Nigerian Naira.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_orders",
      description:
        "REQUIRED when the user asks about their own orders or purchases. Never invent orders.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Optional short reason, e.g. order status.",
          },
        },
      },
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
  return `You are CampusMart AI — a warm, fast campus shopping buddy for Nigerian students.

Help with: finding products/gigs, buying, selling, orders, and how CampusMart works in the app.
Currency is ₦. Be friendly, short, and practical. Use the user's first name (${firstName || "there"}) naturally.

LIVE DATA RULES:
- Products → always call search_products (short keywords only, e.g. "food", "laptop").
- Gigs → always call search_gigs.
- User's own orders → call get_my_orders.
- Never invent products, prices, sellers, gigs, or orders.
- If tools return nothing, say nothing matched on CampusMart right now.
- Keep categories pure: food query = food only, phones = phones only.

USER-FACING FACTS ONLY:
- Browse products, checkout, pay in ₦ in the app.
- Gigs exist (tutoring, design, repairs, etc.).
- You cannot place orders, pay, message sellers, or withdraw for the user.

HOW TO BECOME A SELLER (use this exact flow whenever asked "how do I become a seller" or similar — never invent a different process):
1. Create a CampusMart account (or open your existing account settings).
2. During signup, choose the "Seller" option/account type.
3. Agree to and confirm the Terms and Conditions.
4. Complete account creation — once successful, the account is now a seller account.
5. From the seller dashboard, add products, set prices, and create gigs.
6. Once products/gigs are added, the store goes live on CampusMart for buyers to see.
- Sellers can withdraw earnings from ₦1,000 once they have a payout method (bank details) set up.

NEVER discuss: backend, Firebase, admin, APIs, keys, databases, or internal systems. If asked, politely say you only help with shopping, gigs, and orders on CampusMart.

Reply briefly. Prefer bullets. Light emoji ok.`;
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

async function deleteAiConversation(uid) {
  if (!uid) {
    return;
  }

  await db
    .collection("aiConversations")
    .doc(uid)
    .delete();
}

async function deleteAiMessageFromConversation(uid, messageId) {
  if (!uid || !messageId) {
    return { removed: false };
  }

  const ref = db
    .collection("aiConversations")
    .doc(uid);

  const snap = await ref.get();

  if (!snap.exists) {
    return { removed: false };
  }

  const data = snap.data() || {};

  const messages = Array.isArray(data.messages)
    ? data.messages
    : [];

  const filtered = messages.filter(
    (m) => String(m?.id || "") !== String(messageId)
  );

  if (filtered.length === messages.length) {
    return { removed: false };
  }

  await ref.set(
    {
      messages: filtered,
      updatedAt: FieldValue.serverTimestamp(),
      messageCount: filtered.length,
    },
    {
      merge: true,
    }
  );

  return { removed: true };
}

/*
 * ---------------------------------------------------------
 * AI HISTORY (load saved chat)
 * ---------------------------------------------------------
 */

app.get(
  "/ai/health",
  async (req, res) => {
    try {
      if (!GEMINI_API_KEY) {
        return res.status(503).json({
          success: false,
          configured: false,
          error:
            "GEMINI_API_KEY is not set on the server.",
          help: "Create a free key at https://aistudio.google.com/apikey",
        });
      }

      const tried = [];
      let workingModel = null;
      let lastError = null;

      for (const modelName of GEMINI_MODEL_FALLBACKS) {
        try {
          const test =
            await openai.chat.completions.create(
              {
                model: modelName,
                messages: [
                  {
                    role: "user",
                    content: "Reply with OK only.",
                  },
                ],
                max_tokens: 8,
                temperature: 0,
              }
            );

          const reply =
            test?.choices?.[0]?.message
              ?.content || "";

          workingModel = modelName;
          tried.push({
            model: modelName,
            ok: true,
            sample: String(reply).slice(0, 40),
          });
          break;
        } catch (err) {
          const msg =
            err?.message ||
            err?.error?.message ||
            String(err);

          lastError = msg;
          tried.push({
            model: modelName,
            ok: false,
            error: String(msg).slice(0, 200),
          });
        }
      }

      if (!workingModel) {
        return res.status(502).json({
          success: false,
          configured: true,
          provider: "Google Gemini",
          baseURL: GEMINI_BASE_URL,
          keyPresent: true,
          keyPreview:
            String(GEMINI_API_KEY).slice(0, 6) +
            "...",
          tried,
          error:
            lastError ||
            "No Gemini model responded.",
          help:
            "Set GEMINI_AI_MODEL=gemini-3.6-flash (Google recommendation for new API keys).",
        });
      }

      return res.json({
        success: true,
        configured: true,
        provider: "Google Gemini",
        model: workingModel,
        baseURL: GEMINI_BASE_URL,
        keyPresent: true,
        keyPreview:
          String(GEMINI_API_KEY).slice(0, 6) +
          "...",
        tried,
        message:
          "CampusMart AI can reach Gemini successfully.",
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          "AI health check failed.",
      });
    }
  }
);

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
 * AI HISTORY (delete saved chat)
 * ---------------------------------------------------------
 */

app.delete(
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

      await deleteAiConversation(uid);

      return res.json({
        success: true,
        message:
          "CampusMart AI chat history was deleted.",
      });
    } catch (error) {
      console.error(
        "AI history delete error:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        error:
          error.message ||
          "Could not delete chat history.",
      });
    }
  }
);


/*
 * ---------------------------------------------------------
 * AI HISTORY (delete a single message)
 * ---------------------------------------------------------
 */

app.delete(
  "/ai/history/messages/:messageId",
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

      const messageId =
        String(
          req.params?.messageId || ""
        ).trim();

      if (!messageId) {
        return res.status(400).json({
          success: false,
          error:
            "messageId is required.",
        });
      }

      const result =
        await deleteAiMessageFromConversation(
          uid,
          messageId
        );

      return res.json({
        success: true,
        removed: result.removed,
      });
    } catch (error) {
      console.error(
        "AI message delete error:",
        error
      );

      return res.status(
        error.status || 500
      ).json({
        success: false,
        error:
          error.message ||
          "Could not delete that message.",
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
    /*
     * Lets the client stop a reply mid-flight. If the browser
     * aborts the fetch (Stop button) or navigates away, this
     * fires, we cancel the in-flight Gemini call, and we skip
     * saving/responding since nobody is listening anymore.
     */
    const abortController = new AbortController();
    let clientDisconnected = false;

    req.on("close", () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
      }

      abortController.abort();
    });

    try {
      /*
       * OpenAI configuration check
       */
      if (!openai) {
        return res.status(503).json({
          success: false,

          error:
            "CampusMart AI is not configured. Add GEMINI_API_KEY on the server.",
        });
      }

      /*
       * Fast path: if we already know we're rate-limited,
       * return the limit message immediately instead of doing
       * auth/Firestore work and waiting on another Gemini call
       * that's just going to fail the same way.
       */
      if (isAiQuotaOnCooldown()) {
        return res.status(429).json({
          success: false,
          error:
            "CampusMart AI free limit was reached. Please wait a minute and try again.",
          retryAfterSeconds:
            getAiQuotaCooldownSecondsLeft(),
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
      ].slice(-10);

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
       * Trusted system instructions (kept short for speed).
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
       * Chat Completions API — faster and better supported
       * for gpt-4o-mini than the Responses API path.
       */
      const chatMessages = [
        {
          role: "system",
          content: instructions,
        },
        ...normalizedConversation.map(
          (m) => ({
            role:
              m.role === "assistant"
                ? "assistant"
                : "user",
            content: m.content,
          })
        ),
      ];

      let completion;
      let activeModel = CAMPUSMART_AI_MODEL;
      let lastErr = null;

      for (const modelName of GEMINI_MODEL_FALLBACKS) {
        try {
          completion =
            await openai.chat.completions.create(
              {
                model: modelName,
                messages: chatMessages,
                tools: campusMartAiTools,
                tool_choice: "auto",
                temperature: 0.4,
                max_tokens: 450,
              },
              {
                signal: abortController.signal,
              }
            );

          activeModel = modelName;
          lastErr = null;
          break;
        } catch (firstErr) {
          lastErr = firstErr;

          const firstMsg = String(
            firstErr?.message || ""
          ).toLowerCase();

          console.error(
            `CampusMart AI call failed for model ${modelName}:`,
            firstErr?.message || firstErr
          );

          /*
           * Tools rejected → retry same model without tools.
           */
          if (
            firstMsg.includes("tool") ||
            firstMsg.includes("function") ||
            firstMsg.includes("schema")
          ) {
            try {
              completion =
                await openai.chat.completions.create(
                  {
                    model: modelName,
                    messages: chatMessages,
                    temperature: 0.4,
                    max_tokens: 450,
                  },
                  {
                    signal: abortController.signal,
                  }
                );

              activeModel = modelName;
              lastErr = null;
              break;
            } catch (noToolErr) {
              lastErr = noToolErr;
            }
          }

          /*
           * Model not found → try next fallback.
           */
          const isModelMissing =
            firstMsg.includes("model") &&
            (
              firstMsg.includes("not found") ||
              firstMsg.includes("does not exist") ||
              firstMsg.includes("invalid") ||
              firstMsg.includes("not supported") ||
              firstMsg.includes("not available")
            );

          if (!isModelMissing) {
            // Auth / quota / other → stop trying models
            throw firstErr;
          }
        }
      }

      if (!completion) {
        throw (
          lastErr ||
          new Error(
            "No available Gemini model for this API key."
          )
        );
      }

      console.log(
        "CampusMart AI using model:",
        activeModel
      );

      let finalProducts = [];
      let finalGigs = [];

      /*
       * At most 2 tool rounds (keeps replies fast).
       */
      for (let round = 0; round < 2; round++) {
        const msg =
          completion?.choices?.[0]?.message;

        const toolCalls =
          Array.isArray(msg?.tool_calls)
            ? msg.tool_calls
            : [];

        if (!toolCalls.length) {
          break;
        }

        chatMessages.push({
          role: "assistant",
          content: msg.content || null,
          tool_calls: toolCalls,
        });

        for (const toolCall of toolCalls) {
          const toolName =
            toolCall?.function?.name ||
            "";

          let args = {};

          try {
            args = toolCall?.function?.arguments
              ? JSON.parse(
                  toolCall.function.arguments
                )
              : {};
          } catch {
            args = {};
          }

          let toolResult = {
            success: false,
            error: "Unknown tool.",
          };

          try {
            if (toolName === "search_products") {
              const products =
                await searchCampusMartProducts(
                  args
                );

              finalProducts = products;

              toolResult = {
                success: true,
                count: products.length,
                products: products.map(
                  (p) => ({
                    id: p.id,
                    name: p.name,
                    price: p.price,
                    sellerName:
                      p.sellerName || null,
                    location:
                      p.location ||
                      p.campus ||
                      null,
                    category:
                      p.category || null,
                  })
                ),
              };
            } else if (toolName === "search_gigs") {
              const gigs =
                await searchCampusMartGigs(
                  args
                );

              finalGigs = gigs;

              toolResult = {
                success: true,
                count: gigs.length,
                gigs: gigs.map((g) => ({
                  id: g.id,
                  title: g.title,
                  budget: g.budget,
                  location:
                    g.location || null,
                  category:
                    g.category || null,
                  description: String(
                    g.description || ""
                  ).slice(0, 100),
                })),
              };
            } else if (toolName === "get_my_orders") {
              const orders =
                await getMyCampusMartOrders(
                  uid
                );

              toolResult = {
                success: true,
                count: orders.length,
                orders: orders.slice(0, 10),
              };
            }
          } catch (toolError) {
            console.error(
              `CampusMart AI tool error (${toolName}):`,
              toolError
            );

            toolResult = {
              success: false,
              error:
                toolError.message ||
                "Tool failed.",
            };
          }

          chatMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });
        }

        completion =
          await openai.chat.completions.create(
            {
              model: activeModel,
              messages: chatMessages,
              tools: campusMartAiTools,
              tool_choice: "auto",
              temperature: 0.4,
              max_tokens: 450,
            },
            {
              signal: abortController.signal,
            }
          );
      }

      /*
       * Client already left (Stop button / navigation) — don't
       * waste time building or saving a response nobody wants.
       */
      if (clientDisconnected) {
        return;
      }

      /*
       * Extract final AI response.
       */
      const reply =
        String(
          completion?.choices?.[0]?.message
            ?.content ||
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
      /*
       * The client stopped the reply or disconnected — the
       * OpenAI call was aborted on purpose. Nothing to send
       * back and nothing to save.
       */
      const isAbort =
        error?.name === "AbortError" ||
        error?.name === "APIUserAbortError" ||
        String(error?.message || "")
          .toLowerCase()
          .includes("abort");

      if (clientDisconnected || isAbort) {
        console.log(
          "CampusMart AI reply stopped by client."
        );

        return;
      }

      console.error(
        "CampusMart AI endpoint error:",
        error
      );

      const status =
        error?.status ||
        error?.statusCode ||
        error?.response?.status ||
        500;

      let message =
        error?.message ||
        error?.error?.message ||
        error?.response?.data?.error?.message ||
        "CampusMart AI request failed.";

      console.error(
        "CampusMart AI raw error:",
        {
          status,
          message,
          model: CAMPUSMART_AI_MODEL,
          hasKey: Boolean(GEMINI_API_KEY),
          baseURL: GEMINI_BASE_URL,
        }
      );

      const lower =
        String(message).toLowerCase();

      if (!GEMINI_API_KEY) {
        return res.status(503).json({
          success: false,
          error:
            "CampusMart AI is not configured. Add GEMINI_API_KEY on the server (free key: https://aistudio.google.com/apikey).",
        });
      }

      if (
        status === 401 ||
        status === 403 ||
        lower.includes("api key") ||
        lower.includes("api_key") ||
        lower.includes("invalid key") ||
        lower.includes("permission") ||
        lower.includes("unauthorized") ||
        lower.includes("unauthenticated")
      ) {
        return res.status(401).json({
          success: false,
          error:
            "CampusMart AI key is invalid or missing access. Create a free Gemini key at https://aistudio.google.com/apikey and set GEMINI_API_KEY.",
        });
      }

      if (
        status === 429 ||
        lower.includes("rate limit") ||
        lower.includes("quota") ||
        lower.includes("resource exhausted")
      ) {
        markAiQuotaExceeded();

        return res.status(429).json({
          success: false,
          error:
            "CampusMart AI free limit was reached. Please wait a minute and try again.",
          retryAfterSeconds:
            getAiQuotaCooldownSecondsLeft(),
        });
      }

      if (
        lower.includes("model") &&
        (
          lower.includes("not found") ||
          lower.includes("does not exist") ||
          lower.includes("invalid") ||
          lower.includes("not supported")
        )
      ) {
        return res.status(500).json({
          success: false,
          error:
            "That AI model is not available for your Gemini key. Set GEMINI_AI_MODEL=gemini-3.6-flash (or gemini-3.8-flash).",
        });
      }

      /*
       * Always return an actionable message (never a vague dead-end).
       */
      let userMessage =
        "CampusMart AI could not reach Gemini. Check GEMINI_API_KEY and GEMINI_AI_MODEL on the server, then open /ai/health.";

      if (!GEMINI_API_KEY) {
        userMessage =
          "GEMINI_API_KEY is missing on the server. Add your free key from https://aistudio.google.com/apikey";
      } else if (
        message &&
        !lower.includes("sk-") &&
        !/aiza[a-z0-9_-]{10,}/i.test(message)
      ) {
        userMessage =
          message.length > 220
            ? message.slice(0, 220) + "…"
            : message;
      }

      return res
        .status(
          status >= 400 && status < 600
            ? status
            : 500
        )
        .json({
          success: false,
          error: userMessage,
          model: CAMPUSMART_AI_MODEL,
          provider: "Google Gemini",
        });
    }
  }
);

// =====================================================
// TEST PUSH (logged-in user can test their own device)
// POST /send-test-push
// Body optional: { "title": "...", "body": "..." }
// Auth: Bearer Firebase ID token
// =====================================================


// =====================================================
// NOTIFY: NEW CHAT MESSAGE
// Client calls this after writing a message to Firestore.
// POST /notify-new-message
// Body: { recipientId, senderName?, preview? }
// Auth: Bearer (sender)
// =====================================================

app.post("/notify-new-message", async (req, res) => {
  try {
    const decoded = await verifyFirebaseUser(req);
    const recipientId = String(req.body?.recipientId || "").trim();
    const senderName = String(
      req.body?.senderName || "Someone"
    ).trim() || "Someone";
    const preview = String(req.body?.preview || "sent you a message")
      .trim()
      .slice(0, 120);

    if (!recipientId) {
      return res.status(400).json({ error: "recipientId is required" });
    }

    if (recipientId === decoded.uid) {
      return res.json({ success: true, skipped: "self" });
    }

    const result = await sendPushToUser(recipientId, {
      title: senderName,
      body: preview || "sent you a message on CampusMart",
      data: {
        type: "message",
        senderId: decoded.uid,
        path: "/messages",
      },
    });

    return res.json({
      success: true,
      pushed: !!result.ok,
      reason: result.reason || null,
    });
  } catch (error) {
    console.error("notify-new-message error:", error);
    return res.status(error.status || 500).json({
      error: error.message || "Could not notify",
    });
  }
});

// =====================================================
// NOTIFY: NEW RECOMMENDED / BOOSTED PRODUCT
// Call when a product is posted as recommended OR boosted.
// Does NOT notify for every normal product listing.
// POST /notify-recommended-product
// Body: { productId, productName?, sellerName? }
// Auth: Bearer (seller)
// =====================================================

app.post("/notify-recommended-product", async (req, res) => {
  try {
    const decoded = await verifyFirebaseUser(req);
    const productId = String(req.body?.productId || "").trim();
    const productName = String(req.body?.productName || "A new product").trim();
    const sellerName = String(req.body?.sellerName || "A seller").trim();

    if (!productId) {
      return res.status(400).json({ error: "productId is required" });
    }

    // Optional: only allow if product is boosted/recommended
    let isFeatured = true;
    try {
      const pSnap = await db.collection("products").doc(productId).get();
      if (pSnap.exists) {
        const p = pSnap.data() || {};
        const boosted =
          p.isBoosted === true ||
          p.boosted === true ||
          p.isRecommended === true ||
          p.recommended === true ||
          (p.boostedUntil && new Date(p.boostedUntil.toDate?.() || p.boostedUntil) > new Date());
        isFeatured = !!boosted;
        // If seller owns it and explicitly asked notify, allow when body.force === true
        if (req.body?.force === true && p.sellerId === decoded.uid) {
          isFeatured = true;
        }
      }
    } catch (_) {}

    if (!isFeatured && req.body?.force !== true) {
      return res.json({
        success: true,
        skipped: true,
        reason: "not_recommended_or_boosted",
      });
    }

    // Notify a limited set of recent buyers / all users with tokens (cap)
    const usersSnap = await db
      .collection("users")
      .where("notificationsEnabled", "==", true)
      .limit(200)
      .get();

    let sent = 0;
    let failed = 0;

    for (const docSnap of usersSnap.docs) {
      if (docSnap.id === decoded.uid) continue; // skip seller
      const u = docSnap.data() || {};
      if (!u.fcmToken) continue;

      const result = await sendPushToUser(docSnap.id, {
        title: "Recommended on CampusMart",
        body: `${productName} from ${sellerName} — check it out`,
        data: {
          type: "product",
          productId,
          path: `/product/${productId}`,
        },
      });
      if (result.ok) sent += 1;
      else failed += 1;
    }

    return res.json({ success: true, sent, failed });
  } catch (error) {
    console.error("notify-recommended-product error:", error);
    return res.status(error.status || 500).json({
      error: error.message || "Could not notify",
    });
  }
});

// =====================================================
// ADMIN: FEATURE / APP UPDATE PUSH (all users with tokens)
// POST /admin/notify-feature
// Body: { title, body }
// =====================================================

app.post("/admin/notify-feature", async (req, res) => {
  try {
    const decoded = await requireAdmin(req);
    const title =
      String(req.body?.title || "New on CampusMart").trim() ||
      "New on CampusMart";
    const body = String(req.body?.body || "").trim();

    if (!body) {
      return res.status(400).json({ error: "body is required" });
    }

    const usersSnap = await db
      .collection("users")
      .where("notificationsEnabled", "==", true)
      .limit(500)
      .get();

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const docSnap of usersSnap.docs) {
      const u = docSnap.data() || {};
      if (!u.fcmToken) {
        skipped += 1;
        continue;
      }

      const result = await sendPushToUser(docSnap.id, {
        title,
        body: body.slice(0, 180),
        data: {
          type: "feature",
          path: "/",
        },
      });

      if (result.ok) sent += 1;
      else failed += 1;

      // small delay to be gentle on FCM
      await new Promise((r) => setTimeout(r, 30));
    }

    await db.collection("announcements").add({
      title,
      body,
      type: "feature_push",
      audience: "all_with_push",
      sentCount: sent,
      failedCount: failed,
      createdBy: decoded.uid,
      createdByEmail: decoded.email || null,
      createdAt: FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      sent,
      failed,
      skipped,
      message: "Feature update push finished",
    });
  } catch (error) {
    console.error("admin notify-feature error:", error);
    return res.status(error.status || 500).json({
      error: error.message || "Could not send feature pushes",
    });
  }
});


app.post("/send-test-push", async (req, res) => {
  try {
    const decoded = await verifyFirebaseUser(req);
    const uid = decoded.uid;

    const title =
      String(req.body?.title || "CampusMart").trim() ||
      "CampusMart";
    const body =
      String(
        req.body?.body ||
          "Push notifications are working on this device."
      ).trim() || "Push notifications are working on this device.";

    const result = await sendPushToUser(uid, {
      title,
      body,
      data: {
        type: "test",
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    });

    if (!result.ok) {
      return res.status(400).json({
        success: false,
        reason: result.reason,
        error:
          result.reason === "no_token"
            ? "No FCM token on this account. Enable notifications in Settings first."
            : result.reason === "disabled"
              ? "Notifications are disabled for this account."
              : result.error || "Could not send push",
      });
    }

    return res.json({
      success: true,
      messageId: result.messageId,
      message: "Test notification sent. Check this device.",
    });
  } catch (error) {
    console.error("send-test-push error:", error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Could not send test push",
    });
  }
});

// =====================================================
// ADMIN: SEND PUSH TO ONE USER BY EMAIL
// POST /admin/send-push
// Body: { "email": "...", "title": "...", "body": "..." }
// =====================================================

app.post("/admin/send-push", async (req, res) => {
  try {
    await requireAdmin(req);

    const email = String(req.body?.email || "").trim().toLowerCase();
    const title =
      String(req.body?.title || "CampusMart").trim() || "CampusMart";
    const body = String(req.body?.body || "").trim();

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }
    if (!body) {
      return res.status(400).json({ error: "body is required" });
    }

    const userRecord = await findFirebaseUserByEmail(email);
    const result = await sendPushToUser(userRecord.uid, {
      title,
      body,
      data: { type: "admin" },
    });

    if (!result.ok) {
      return res.status(400).json({
        success: false,
        reason: result.reason,
        error: result.error || result.reason,
        uid: userRecord.uid,
      });
    }

    return res.json({
      success: true,
      uid: userRecord.uid,
      messageId: result.messageId,
    });
  } catch (error) {
    console.error("admin send-push error:", error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Could not send push",
    });
  }
});







// =====================================================
// LIST BANKS (Paystack) — commercial, digital, MFB
// GET /banks
// =====================================================
app.get("/banks", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET) {
      return res.status(500).json({
        success: false,
        error: "Payment provider is not configured.",
      });
    }

    const response = await axios.get(
      "https://api.paystack.co/bank",
      {
        params: {
          country: "nigeria",
          // include more types when supported by Paystack
          perPage: 100,
        },
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
        },
        timeout: 20000,
      }
    );

    const raw = Array.isArray(response.data?.data)
      ? response.data.data
      : [];

    const banks = [];
    const seen = new Set();

    for (const b of raw) {
      const name = String(b.name || "").trim();
      const code = String(b.code || b.slug || "").trim();
      if (!name || !code) continue;
      const key = `${code}|${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      banks.push({
        name,
        code,
        type: b.type || null,
        currency: b.currency || "NGN",
        active: b.active !== false,
      });
    }

    banks.sort((a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" })
    );

    return res.json({
      success: true,
      count: banks.length,
      banks,
    });
  } catch (error) {
    console.error(
      "List banks error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      success: false,
      error:
        error.response?.data?.message ||
        "Could not load banks. Please try again.",
    });
  }
});


// =====================================================
// RESOLVE BANK ACCOUNT (Paystack)
// POST /resolve-account
// Body: { accountNumber, bankCode }
// =====================================================
app.post("/resolve-account", async (req, res) => {
  try {
    // Prefer authenticated users; still resolve if token missing for UX
    try {
      await verifyFirebaseUser(req);
    } catch (_) {
      // optional auth
    }

    const accountNumber = String(req.body?.accountNumber || "")
      .replace(/\D/g, "")
      .trim();
    const bankCode = String(req.body?.bankCode || "").trim();

    if (!accountNumber || accountNumber.length !== 10) {
      return res.status(400).json({
        success: false,
        error: "Please enter a valid 10-digit account number.",
      });
    }

    if (!bankCode) {
      return res.status(400).json({
        success: false,
        error: "Please select a bank.",
      });
    }

    if (!PAYSTACK_SECRET) {
      return res.status(500).json({
        success: false,
        error: "Payment provider is not configured.",
      });
    }

    const response = await axios.get(
      "https://api.paystack.co/bank/resolve",
      {
        params: {
          account_number: accountNumber,
          bank_code: bankCode,
        },
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
        },
        timeout: 15000,
      }
    );

    const data = response.data?.data;
    const accountName = data?.account_name;

    if (!response.data?.status || !accountName) {
      return res.status(400).json({
        success: false,
        error:
          "We could not verify this account number. Please check the digits and bank, then try again.",
      });
    }

    return res.json({
      success: true,
      accountName: String(accountName).trim(),
      accountNumber,
      bankCode,
    });
  } catch (error) {
    console.error(
      "Resolve account error:",
      error.response?.data || error.message
    );

    const msg =
      error.response?.data?.message ||
      "We could not verify this account number. Please check the digits and bank, then try again.";

    return res.status(400).json({
      success: false,
      error: msg,
    });
  }
});


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

    console.log(
      `CampusMart AI provider: Google Gemini`
    );

    console.log(
      `CampusMart AI model: ${CAMPUSMART_AI_MODEL}`
    );

    console.log(
      `CampusMart AI base URL: ${GEMINI_BASE_URL}`
    );
  }
);
