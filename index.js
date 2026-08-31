const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// =====================================================
// Firebase Admin
// =====================================================
const serviceAccount = require("./serviceAccountKey.json");

if (!serviceAccount || !serviceAccount.private_key) {
  console.error("serviceAccountKey.json is missing or invalid");
  process.exit(1);
}

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

// =====================================================
// Paystack Secret
// =====================================================
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;

// =====================================================
// 1. INITIALIZE PAYMENT
// =====================================================
app.post("/initialize-payment", async (req, res) => {
  try {
    const { email, amount, sellerId, orderId, productName } = req.body;

    if (!email || !amount || !sellerId) {
      return res
        .status(400)
        .json({ error: "email, amount and sellerId are required" });
    }

    const amountInKobo = Math.round(Number(amount) * 100);

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amountInKobo,
        currency: "NGN",
        callback_url: "https://yourdomain.com/payment/callback", // change later
        metadata: {
          sellerId,
          orderId: orderId || null,
          productName: productName || "CampusMart Order",
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
      return res.status(400).json({ error: response.data.message });
    }

    res.json({
      success: true,
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: "Could not start payment" });
  }
});

// =====================================================
// 2. PAYSTACK WEBHOOK (5% CampusMart + 95% Seller)
// =====================================================
app.post("/paystack-webhook", async (req, res) => {
  try {
    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(401).send("Invalid signature");
    }

    const event = req.body;

    if (event.event === "charge.success") {
      const data = event.data;
      const metadata = data.metadata || {};
      const sellerId = metadata.sellerId;
      const orderId = metadata.orderId;
      const totalAmount = data.amount / 100;

      if (!sellerId) {
        return res.status(200).send("OK");
      }

      const platformFee = Number((totalAmount * 0.05).toFixed(2)); // 5%
      const sellerAmount = Number((totalAmount * 0.95).toFixed(2)); // 95%

      const batch = db.batch();

      // Credit seller 95%
      batch.update(db.collection("users").doc(sellerId), {
        availableBalance: FieldValue.increment(sellerAmount),
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Record CampusMart 5%
      batch.set(db.collection("platformFees").doc(), {
        sellerId,
        orderId: orderId || null,
        totalAmount,
        platformFee,
        sellerAmount,
        paystackReference: data.reference,
        createdAt: FieldValue.serverTimestamp(),
      });

      if (orderId) {
        batch.update(db.collection("orders").doc(orderId), {
          paymentStatus: "paid",
          paidAt: FieldValue.serverTimestamp(),
        });
      }

      await batch.commit();
      console.log(`Seller ${sellerId} credited ₦${sellerAmount}`);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error(error);
    res.status(500).send("Error");
  }
});

// =====================================================
// Start server
// =====================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});