const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

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

// =====================================================
// IMPORTANT: capture the RAW request body for the
// webhook route so we can verify Paystack's signature
// against the exact bytes they sent (not a re-serialized
// copy of the parsed JSON, which can mismatch).
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
// PAYSTACK SECRET
// =====================================================

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "https://campus-mart-ashen.vercel.app";

// =====================================================
// EMAIL (Nodemailer + SMTP)
// Env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
// =====================================================

function createMailer() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    console.warn(
      "SMTP_USER / SMTP_PASS missing — email endpoints will fail until set"
    );
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
}

const mailer = createMailer();

const MAIL_FROM =
  process.env.MAIL_FROM ||
  process.env.SMTP_USER ||
  "CampusMart <noreply@campusmart.app>";

async function sendMail({ to, subject, html, text }) {
  if (!to) throw new Error("Missing recipient");

  const info = await mailer.sendMail({
    from: MAIL_FROM,
    to,
    subject,
    html,
    text: text || String(html).replace(/<[^>]+>/g, " "),
  });

  return info;
}

function emailLayout({ title, bodyHtml }) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f7faf8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7faf8;padding:24px 12px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="background:#008236;padding:20px 24px;">
            <div style="color:#fff;font-size:20px;font-weight:800;">Campus<span style="color:#86efac;">Mart</span></div>
            <div style="color:#d1fae5;font-size:12px;margin-top:4px;">Your Campus Marketplace</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 24px;">
            <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${title}</h1>
            <div style="font-size:14px;line-height:1.6;color:#374151;">${bodyHtml}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #f3f4f6;font-size:11px;color:#9ca3af;">
            © CampusMart · You received this because you have a CampusMart account.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// =====================================================
// HELPER: VERIFY FIREBASE USER
// =====================================================

async function verifyFirebaseUser(req) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    throw new Error("Missing Firebase authentication token");
  }

  const idToken = authorization.replace("Bearer ", "");
  const decodedToken = await adminAuth.verifyIdToken(idToken);

  return decodedToken;
}

async function requireAdmin(req) {
  const decoded = await verifyFirebaseUser(req);
  const adminEmail = (decoded.email || "").toLowerCase();
  const isMainAdmin = adminEmail === "campusmart1234@gmail.com";

  let isAdmin = isMainAdmin;
  if (!isAdmin) {
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    const data = userDoc.exists ? userDoc.data() : {};
    isAdmin =
      data.role === "admin" ||
      data.isAdmin === true ||
      (Array.isArray(data.roles) && data.roles.includes("admin"));
  }

  if (!isAdmin) {
    const err = new Error("Admin only");
    err.status = 403;
    throw err;
  }

  return decoded;
}

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
      type, // "order" | "promotion"
      productIds,
      planId,
      planDays,
      callback_url,
    } = req.body;

    if (!email || !amount || !sellerId) {
      return res.status(400).json({
        error: "email, amount and sellerId are required",
      });
    }

    const amountInKobo = Math.round(Number(amount) * 100);

    if (!Number.isFinite(amountInKobo) || amountInKobo <= 0) {
      return res.status(400).json({
        error: "Invalid payment amount",
      });
    }

    const paymentType = type === "promotion" ? "promotion" : "order";

    const finalCallback =
      callback_url ||
      (paymentType === "promotion"
        ? `${FRONTEND_URL}/seller/promotions`
        : `${FRONTEND_URL}/order-success`);

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amountInKobo,
        currency: "NGN",
        callback_url: finalCallback,
        metadata: {
          sellerId,
          orderId: orderId || null,
          productName: productName || "CampusMart Order",
          type: paymentType,
          productIds: Array.isArray(productIds) ? productIds : [],
          planId: planId || null,
          planDays: planDays || null,
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
          response.data.message || "Payment initialization failed",
      });
    }

    const authUrl = response.data.data.authorization_url;
    const reference = response.data.data.reference;

    return res.json({
      success: true,
      authorization_url: authUrl,
      reference,
      data: {
        authorization_url: authUrl,
        reference,
        access_code: response.data.data.access_code,
      },
    });
  } catch (error) {
    console.error(
      "Initialize payment error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      error: "Could not start payment",
    });
  }
});

// =====================================================
// 1b. VERIFY PAYMENT (read-only — never credits seller)
// =====================================================

app.get("/verify-payment/:reference", async (req, res) => {
  try {
    const { reference } = req.params;

    if (!reference) {
      return res.status(400).json({ error: "reference is required" });
    }

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(
        reference
      )}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
        },
      }
    );

    return res.json(response.data);
  } catch (error) {
    console.error(
      "Verify payment error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      error: "Could not verify payment",
    });
  }
});

// =====================================================
// 2. PAYSTACK WEBHOOK
// =====================================================

app.post("/paystack-webhook", async (req, res) => {
  try {
    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(req.rawBody)
      .digest("hex");

    const signature = req.headers["x-paystack-signature"];

    if (!signature || hash !== signature) {
      console.error("Invalid Paystack webhook signature");
      return res.status(401).send("Invalid signature");
    }

    const event = req.body;

    if (event.event !== "charge.success") {
      return res.status(200).send("OK");
    }

    const data = event.data;
    const metadata = data.metadata || {};
    const sellerId = metadata.sellerId;
    const orderId = metadata.orderId;
    const paymentType = metadata.type || "order";
    const totalAmount = Number(data.amount || 0) / 100;
    const reference = data.reference;

    if (!reference || totalAmount <= 0) {
      return res.status(200).send("OK");
    }

    // -------------------------------------------------
    // PROMOTION PAYMENT
    // -------------------------------------------------
    if (paymentType === "promotion") {
      const promoPayRef = db.collection("promotionPayments").doc(reference);

      const result = await db.runTransaction(async (tx) => {
        const existing = await tx.get(promoPayRef);
        if (existing.exists) {
          return "already-processed";
        }

        tx.set(promoPayRef, {
          sellerId: sellerId || null,
          productIds: metadata.productIds || [],
          planId: metadata.planId || null,
          planDays: metadata.planDays || null,
          totalAmount,
          paystackReference: reference,
          productName: metadata.productName || "Promotion",
          status: "paid",
          createdAt: FieldValue.serverTimestamp(),
        });

        return "processed";
      });

      if (result === "already-processed") {
        console.log(`Promotion ${reference} already recorded.`);
        return res.status(200).send("Already processed");
      }

      console.log("PROMOTION PAYMENT SUCCESSFUL", reference, sellerId, totalAmount);
      return res.status(200).send("OK");
    }

    // -------------------------------------------------
    // NORMAL ORDER PAYMENT (5% / 95%)
    // -------------------------------------------------

    if (!sellerId) {
      console.warn("Payment has no sellerId:", reference);
      return res.status(200).send("OK");
    }

    const platformFee = Number((totalAmount * 0.05).toFixed(2));
    const sellerAmount = Number((totalAmount * 0.95).toFixed(2));

    const earningRef = db.collection("earnings").doc(reference);
    const sellerRef = db.collection("users").doc(sellerId);
    const platformFeeRef = db.collection("platformFees").doc(reference);
    const orderRef = orderId ? db.collection("orders").doc(orderId) : null;

    const result = await db.runTransaction(async (tx) => {
      const existingEarning = await tx.get(earningRef);

      if (existingEarning.exists) {
        return "already-processed";
      }

      tx.set(
        sellerRef,
        {
          availableBalance: FieldValue.increment(sellerAmount),
          totalEarnings: FieldValue.increment(sellerAmount),
          totalPlatformFees: FieldValue.increment(platformFee),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.set(earningRef, {
        sellerId,
        orderId: orderId || null,
        type: "sale",
        title: orderId
          ? `Order #${String(orderId).slice(0, 6).toUpperCase()}`
          : "CampusMart Sale",
        description: metadata.productName || "Sale",
        amount: sellerAmount,
        gross: totalAmount,
        platformFee,
        status: "Completed",
        paystackReference: reference,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      tx.set(
        platformFeeRef,
        {
          sellerId,
          orderId: orderId || null,
          totalAmount,
          platformFee,
          sellerAmount,
          paystackReference: reference,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (orderRef) {
        tx.set(
          orderRef,
          {
            paymentStatus: "paid",
            paidAt: FieldValue.serverTimestamp(),
            paystackReference: reference,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      return "processed";
    });

    if (result === "already-processed") {
      console.log(`Payment ${reference} already processed.`);
      return res.status(200).send("Already processed");
    }

    console.log("PAYMENT SUCCESSFUL", reference, sellerId, totalAmount, sellerAmount);
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Paystack webhook error:", error);
    return res.status(500).send("Error");
  }
});

// =====================================================
// 3. RESET SELLER EARNINGS
// =====================================================

app.post("/reset-earnings", async (req, res) => {
  try {
    const decodedUser = await verifyFirebaseUser(req);
    const sellerId = decodedUser.uid;

    console.log(`Resetting earnings for seller: ${sellerId}`);

    const earningsSnapshot = await db
      .collection("earnings")
      .where("sellerId", "==", sellerId)
      .get();

    const docs = earningsSnapshot.docs;
    const chunkSize = 400;

    for (let i = 0; i < docs.length; i += chunkSize) {
      const chunk = docs.slice(i, i + chunkSize);
      const batch = db.batch();
      chunk.forEach((earningDoc) => {
        batch.delete(earningDoc.ref);
      });
      await batch.commit();
    }

    await db.collection("users").doc(sellerId).set(
      {
        totalEarnings: 0,
        availableBalance: 0,
        totalPlatformFees: 0,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({
      success: true,
      message: "Seller earnings have been reset.",
      deletedEarnings: earningsSnapshot.size,
    });
  } catch (error) {
    console.error("Reset earnings error:", error);
    return res.status(500).json({
      error: error.message || "Could not reset earnings.",
    });
  }
});

// =====================================================
// 4. REAL SELLER WITHDRAWAL
// =====================================================

app.post("/process-withdrawal", async (req, res) => {
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
        error: "Missing required fields",
      });
    }

    if (Number(amount) < 1000) {
      return res.status(400).json({
        error: "Minimum withdrawal is ₦1,000",
      });
    }

    const sellerRef = db.collection("users").doc(sellerId);

    const deduction = await db
      .runTransaction(async (tx) => {
        const sellerSnap = await tx.get(sellerRef);

        if (!sellerSnap.exists) {
          throw new Error("SELLER_NOT_FOUND");
        }

        const availableBalance = Number(
          sellerSnap.data().availableBalance || 0
        );

        if (availableBalance < Number(amount)) {
          throw new Error("INSUFFICIENT_BALANCE");
        }

        tx.update(sellerRef, {
          availableBalance: FieldValue.increment(-Number(amount)),
          updatedAt: FieldValue.serverTimestamp(),
        });

        return true;
      })
      .catch((err) => {
        if (err.message === "SELLER_NOT_FOUND") {
          return { error: "Seller not found", status: 404 };
        }
        if (err.message === "INSUFFICIENT_BALANCE") {
          return { error: "Insufficient balance", status: 400 };
        }
        throw err;
      });

    if (deduction && deduction.error) {
      return res.status(deduction.status).json({ error: deduction.error });
    }

    let recipientRes;
    try {
      recipientRes = await axios.post(
        "https://api.paystack.co/transferrecipient",
        {
          type: "nuban",
          name: accountName,
          account_number: accountNumber,
          bank_code: bankCode,
          currency: "NGN",
        },
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (err) {
      await sellerRef.update({
        availableBalance: FieldValue.increment(Number(amount)),
        updatedAt: FieldValue.serverTimestamp(),
      });
      throw err;
    }

    if (!recipientRes.data.status) {
      await sellerRef.update({
        availableBalance: FieldValue.increment(Number(amount)),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return res.status(400).json({
        error:
          recipientRes.data.message || "Could not create recipient",
      });
    }

    const recipientCode = recipientRes.data.data.recipient_code;
    const transferReference = `WD_${sellerId}_${Date.now()}`;

    let transferRes;
    try {
      transferRes = await axios.post(
        "https://api.paystack.co/transfer",
        {
          source: "balance",
          amount: Math.round(Number(amount) * 100),
          recipient: recipientCode,
          reason: `CampusMart seller withdrawal - ${sellerId}`,
          reference: transferReference,
        },
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (err) {
      await sellerRef.update({
        availableBalance: FieldValue.increment(Number(amount)),
        updatedAt: FieldValue.serverTimestamp(),
      });
      throw err;
    }

    if (!transferRes.data.status) {
      await sellerRef.update({
        availableBalance: FieldValue.increment(Number(amount)),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return res.status(400).json({
        error: transferRes.data.message || "Transfer failed",
      });
    }

    const withdrawalRef = db.collection("withdrawals").doc();

    await withdrawalRef.set({
      sellerId,
      amount: Number(amount),
      bankName: bankName || "",
      bankCode,
      accountNumber,
      accountName,
      status: "Processing",
      paystackTransferCode: transferRes.data.data.transfer_code,
      paystackReference: transferRes.data.data.reference,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      message:
        "Transfer initiated. Money will arrive in the seller's bank shortly.",
      transferCode: transferRes.data.data.transfer_code,
    });
  } catch (error) {
    console.error(
      "Withdrawal error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      error:
        error.response?.data?.message ||
        "Could not process withdrawal. Please try again.",
    });
  }
});

// =====================================================
// 5. PLATFORM FEE WITHDRAWAL
// =====================================================

app.post("/process-platform-withdrawal", async (req, res) => {
  try {
    const {
      amount,
      bankName,
      bankCode,
      accountNumber,
      accountName,
      adminId,
    } = req.body;

    if (!amount || !bankCode || !accountNumber || !accountName) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    if (Number(amount) < 1000) {
      return res.status(400).json({
        error: "Minimum withdrawal is ₦1,000",
      });
    }

    const feesSnap = await db.collection("platformFees").get();
    let totalFees = 0;
    feesSnap.forEach((d) => {
      totalFees += Number(d.data().platformFee) || 0;
    });

    const promoSnap = await db.collection("promotionPayments").get();
    promoSnap.forEach((d) => {
      totalFees += Number(d.data().totalAmount) || 0;
    });

    const withdrawnSnap = await db
      .collection("platformWithdrawals")
      .where("status", "in", ["Successful", "Processing", "Pending"])
      .get();

    let alreadyWithdrawn = 0;
    withdrawnSnap.forEach((d) => {
      alreadyWithdrawn += Number(d.data().amount) || 0;
    });

    const available = totalFees - alreadyWithdrawn;

    if (Number(amount) > available) {
      return res.status(400).json({
        error: `Insufficient platform balance. Available: ₦${available.toLocaleString()}`,
      });
    }

    const recipientRes = await axios.post(
      "https://api.paystack.co/transferrecipient",
      {
        type: "nuban",
        name: accountName,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: "NGN",
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!recipientRes.data.status) {
      return res.status(400).json({
        error:
          recipientRes.data.message || "Could not create recipient",
      });
    }

    const recipientCode = recipientRes.data.data.recipient_code;

    const transferRes = await axios.post(
      "https://api.paystack.co/transfer",
      {
        source: "balance",
        amount: Math.round(Number(amount) * 100),
        recipient: recipientCode,
        reason: "CampusMart platform fee withdrawal",
        reference: `PFEE_${Date.now()}`,
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!transferRes.data.status) {
      return res.status(400).json({
        error: transferRes.data.message || "Transfer failed",
      });
    }

    await db.collection("platformWithdrawals").add({
      amount: Number(amount),
      bankName: bankName || "",
      bankCode,
      accountNumber,
      accountName,
      adminId: adminId || null,
      status: "Processing",
      paystackTransferCode: transferRes.data.data.transfer_code,
      paystackReference: transferRes.data.data.reference,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      message: "Platform fee withdrawal initiated",
      transferCode: transferRes.data.data.transfer_code,
    });
  } catch (error) {
    console.error(
      "Platform withdrawal error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      error:
        error.response?.data?.message ||
        "Could not process platform withdrawal",
    });
  }
});

// =====================================================
// 6. WELCOME EMAIL (new registration)
// POST /send-welcome-email
// Body: { email, fullName }
// =====================================================

app.post("/send-welcome-email", async (req, res) => {
  try {
    const { email, fullName } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    let title = "Welcome to CampusMart 👋";
    let body =
      "Thanks for joining CampusMart! Browse products, chat sellers, and enjoy secure campus shopping.";
    let enabled = true;

    try {
      const snap = await db.collection("settings").doc("welcomeMessage").get();
      if (snap.exists) {
        const w = snap.data() || {};
        if (w.enabled === false) enabled = false;
        if (w.title) title = String(w.title);
        if (w.body) body = String(w.body);
      }
    } catch (e) {
      console.warn("welcome settings:", e.message);
    }

    if (!enabled) {
      return res.json({
        success: true,
        skipped: true,
        message: "Welcome emails disabled",
      });
    }

    const name = (fullName || "").trim().split(/\s+/)[0] || "there";
    const finalTitle = title.replace(/\{name\}/g, name);
    const finalBody = body.replace(/\{name\}/g, name);
    const bodyHtml = finalBody
      .split("\n")
      .map((line) => `<p style="margin:0 0 10px;">${line}</p>`)
      .join("");

    await sendMail({
      to: String(email).trim().toLowerCase(),
      subject: finalTitle,
      html: emailLayout({ title: finalTitle, bodyHtml }),
    });

    return res.json({ success: true, message: "Welcome email sent" });
  } catch (error) {
    console.error("Welcome email error:", error);
    return res.status(500).json({
      error: error.message || "Could not send welcome email",
    });
  }
});

// =====================================================
// 7. ANNOUNCEMENT EMAIL (admin)
// POST /send-announcement-email
// Headers: Authorization: Bearer <Firebase ID token>
// Body: { title, body, mode: "all" | "single", email? }
// =====================================================

app.post("/send-announcement-email", async (req, res) => {
  try {
    let decoded;
    try {
      decoded = await requireAdmin(req);
    } catch (e) {
      const status = e.status || 401;
      return res.status(status).json({
        error: e.message || "Unauthorized",
      });
    }

    const { title, body, mode, email } = req.body || {};

    if (!title || !body) {
      return res.status(400).json({
        error: "title and body are required",
      });
    }

    const bodyHtml = String(body)
      .split("\n")
      .map((line) => `<p style="margin:0 0 10px;">${line}</p>`)
      .join("");
    const html = emailLayout({
      title: String(title),
      bodyHtml,
    });

    // ---- single email ----
    if (mode === "single") {
      if (!email) {
        return res.status(400).json({
          error: "email is required for single mode",
        });
      }

      await sendMail({
        to: String(email).trim().toLowerCase(),
        subject: String(title),
        html,
      });

      await db.collection("announcements").add({
        title: String(title),
        body: String(body),
        audience: "single",
        targetEmail: String(email).trim().toLowerCase(),
        type: "email",
        active: true,
        createdBy: decoded.uid,
        createdByEmail: decoded.email || null,
        createdAt: FieldValue.serverTimestamp(),
      });

      return res.json({ success: true, sent: 1, mode: "single" });
    }

    // ---- all registered emails ----
    const snap = await db.collection("users").get();
    const emails = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data() || {};
      const e = (d.email || "").trim().toLowerCase();
      if (e && e.includes("@")) emails.push(e);
    });

    const unique = [...new Set(emails)];
    let sent = 0;
    let failed = 0;

    for (const to of unique) {
      try {
        await sendMail({ to, subject: String(title), html });
        sent += 1;
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        console.error("Failed to", to, err.message);
        failed += 1;
      }
    }

    await db.collection("announcements").add({
      title: String(title),
      body: String(body),
      audience: "all",
      type: "email",
      active: true,
      sentCount: sent,
      failedCount: failed,
      createdBy: decoded.uid,
      createdByEmail: decoded.email || null,
      createdAt: FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      mode: "all",
      total: unique.length,
      sent,
      failed,
    });
  } catch (error) {
    console.error("Announcement email error:", error);
    return res.status(500).json({
      error: error.message || "Could not send announcement emails",
    });
  }
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "CampusMart payment server is running",
  });
});

// =====================================================
// START SERVER
// =====================================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});