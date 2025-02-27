require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bodyParser = require("body-parser");

// For on-chain validation
const { Connection, PublicKey } = require("@solana/web3.js");

// For Cloudinary integration
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

// 1) Create a connection to Solana
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const solanaConnection = new Connection(SOLANA_RPC_URL, "confirmed");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(bodyParser.json());
app.use(cors());

// Serve the images folder (so /images/avatarmain.png is accessible)
app.use("/images", express.static("images"));

// 2) Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log("✅ Connected to MongoDB"))
.catch(err => console.error("❌ MongoDB Connection Error:", err));

// 3) Models
//    A) Purchase
const purchaseSchema = new mongoose.Schema({
  walletAddress: String,
  usdSpent: Number,
  tokensReceived: Number,
  transactionId: String,
  referralCodeUsed: String, // store which code was used
  timestamp: { type: Date, default: Date.now },
});
const Purchase = mongoose.model("Purchase", purchaseSchema);

//    B) User
const User = require('./models/user'); // Must match your user.js model

// ------------------------------------------------------
// Cloudinary Configuration & Multer Storage for Avatars
// ------------------------------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, // from your .env
  api_key: process.env.CLOUDINARY_API_KEY,       // from your .env
  api_secret: process.env.CLOUDINARY_API_SECRET  // from your .env
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "avatars", // Folder in Cloudinary
    allowed_formats: ["jpg", "png", "jpeg", "gif"],
  },
});

// 500 KB limit; only image files allowed
const upload = multer({ 
  storage,
  limits: { fileSize: 500 * 1024 }, // 500 KB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed!"), false);
    } else {
      cb(null, true);
    }
  }
});

// 4) GET /raised-amount
app.get("/raised-amount", async (req, res) => {
  try {
    const totalRaised = await Purchase.aggregate([
      { $group: { _id: null, totalUSD: { $sum: "$usdSpent" } } }
    ]);
    const sum = totalRaised.length > 0 ? totalRaised[0].totalUSD : 0;
    res.json({ totalUSD: sum });
  } catch (err) {
    console.error("Error in /raised-amount:", err);
    res.status(500).json({ error: "Failed to fetch raised amount" });
  }
});

// 5) GET /user/:walletAddress
//    - Return the user's referral info (code, earnings, avatar).
//    - If user doesn't exist, auto-create them with a random code.
app.get("/user/:walletAddress", async (req, res) => {
  try {
    const { walletAddress } = req.params;
    let user = await User.findOne({ walletAddress });
    if (!user) {
      // Optionally generate a random code or custom logic
      const randomCode = "REF" + Math.floor(Math.random() * 100000);
      user = new User({
        walletAddress,
        referralCode: randomCode,
        referralEarnings: 0
      });
      await user.save();
    }

    // Provide a fallback avatar if user.avatarUrl not set
    const defaultAvatar = "/images/avatarmain.png";

    return res.json({
      walletAddress: user.walletAddress,
      referralCode: user.referralCode || null,
      referralEarnings: user.referralEarnings || 0,
      avatarUrl: user.avatarUrl || defaultAvatar
    });
  } catch (err) {
    console.error("Error in GET /user:", err);
    res.status(500).json({ error: "Failed to get user info" });
  }
});

// 6) POST /purchase
//    - Validate on-chain
//    - Check for duplicates
//    - Save purchase
//    - If referralCode => find the user & add 5% of usdSpent to referralEarnings
app.post("/purchase", async (req, res) => {
  const { walletAddress, usdSpent, tokensReceived, transactionId, referralCode } = req.body;

  // Basic checks
  if (!walletAddress || !usdSpent || !tokensReceived || !transactionId) {
    return res.status(400).json({ error: "Missing data" });
  }

  // Validate transaction
  try {
    const isValid = await validateSignatureOnChain(transactionId, walletAddress, usdSpent);
    if (!isValid) {
      return res.status(400).json({ error: "Invalid or fake transaction." });
    }
  } catch (err) {
    console.error("Signature validation error:", err);
    return res.status(400).json({ error: "Unable to validate transaction." });
  }

  // Prevent duplicates
  const existingTx = await Purchase.findOne({ transactionId });
  if (existingTx) {
    return res.status(400).json({ error: "Duplicate transaction detected" });
  }

  // Save new purchase
  const newPurchase = new Purchase({
    walletAddress,
    usdSpent,
    tokensReceived,
    transactionId,
    referralCodeUsed: referralCode || null
  });
  await newPurchase.save();

  // If there's a referralCode => 5% bonus
  if (referralCode) {
    const refUser = await User.findOne({ referralCode });
    if (refUser) {
      const bonus = 0.05 * parseFloat(usdSpent);
      refUser.referralEarnings += bonus;
      await refUser.save();
      console.log(`✅ Awarded $${bonus} to referrer with code ${referralCode}`);
    }
  }

  res.json({ message: "✅ Purchase recorded successfully" });
});

// 7) GET /user-purchases/:walletAddress
//    - Return total user invested & tokens
app.get("/user-purchases/:walletAddress", async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const purchases = await Purchase.find({ walletAddress });
    const totalInvested = purchases.reduce((sum, p) => sum + p.usdSpent, 0);
    const totalTokens = purchases.reduce((sum, p) => sum + p.tokensReceived, 0);

    res.json({ totalInvested, totalTokens });
  } catch (err) {
    console.error("Error in /user-purchases:", err);
    res.status(500).json({ error: "Failed to fetch user purchases" });
  }
});

// 8) GET /leaderboard
//    - Return the top 1000 users sorted by referralEarnings desc
app.get("/leaderboard", async (req, res) => {
  try {
    const topUsers = await User.find().sort({ referralEarnings: -1 }).limit(1000);
    res.json({ leaderboard: topUsers });
  } catch (err) {
    console.error("Leaderboard error:", err);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

// 9) POST /upload-avatar using Cloudinary
//    - Restrict file size to 500 KB
app.post("/upload-avatar", (req, res) => {
  upload.single("avatar")(req, res, async function(err) {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File size too large. Please resize your image to under 500KB." });
      }
      return res.status(400).json({ error: err.message });
    }
    try {
      const { walletAddress } = req.body;
      if (!req.file || !walletAddress) {
        return res.status(400).json({ error: "Missing wallet address or image." });
      }
      // Cloudinary returns the URL in req.file.path
      const finalUrl = req.file.path;

      // Update user doc
      const user = await User.findOne({ walletAddress });
      if (!user) return res.status(404).json({ error: "User not found" });

      // Overwrite or set the new avatar
      user.avatarUrl = finalUrl;
      await user.save();

      res.json({ message: "Avatar uploaded successfully", avatarUrl: finalUrl });
    } catch (err) {
      console.error("Avatar upload error:", err);
      res.status(500).json({ error: "Avatar upload failed" });
    }
  });
});

// 10) Webhook from Helius (optional)
app.post("/webhook/solana-inbound", async (req, res) => {
  console.log("🔔 Webhook received from Helius!");
  try {
    const transactions = req.body || [];
    for (let tx of transactions) {
      const transactionId = tx.signature;
      const instructions = tx.instructions || [];

      console.log(`🔹 Processing Transaction: ${transactionId}`);
      for (let inst of instructions) {
        if (inst.parsed && inst.parsed.info) {
          const { destination, amount } = inst.parsed.info;
          if (destination === process.env.PRESALE_WALLET) {
            const walletAddress = tx.signers[0];
            const usdSpent = parseFloat(amount) / 1e6;
            const tokensReceived = usdSpent / 0.00851;

            // duplicates check
            const existingTx = await Purchase.findOne({ transactionId });
            if (!existingTx) {
              const newPurchase = new Purchase({
                walletAddress,
                usdSpent,
                tokensReceived,
                transactionId
              });
              await newPurchase.save();
              console.log(`✅ Helius: Saved Purchase from ${walletAddress}: $${usdSpent}`);
            } else {
              console.log(`⚠️ Helius: Duplicate transaction ignored: ${transactionId}`);
            }
          }
        }
      }
    }
    res.status(200).json({ message: "Webhook processed" });
  } catch (error) {
    console.error("❌ Webhook Processing Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 11) Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// 12) Validate signature on Solana
async function validateSignatureOnChain(txSignature, fromWallet, expectedUsdSpent) {
  try {
    const txInfo = await solanaConnection.getTransaction(txSignature, {
      commitment: "confirmed"
    });
    if (!txInfo) {
      console.log("No transaction found for signature:", txSignature);
      return false;
    }

    const fromPubKey = new PublicKey(fromWallet);
    const { transaction } = txInfo;
    const accountKeys = transaction.message.accountKeys;

    // Check signer
    if (!accountKeys[0].equals(fromPubKey)) {
      console.log("Signature signer does not match fromWallet:", fromWallet);
      return false;
    }

    // Check presale wallet is present
    const presaleWalletKey = process.env.PRESALE_WALLET || "4qdqnmNxUTjKTJMhVztPxtgwVuU7p2aoJMCJVFEQ6Wzw";
    const presaleWallet = new PublicKey(presaleWalletKey);
    const hasPresaleWallet = accountKeys.find(k => k.equals(presaleWallet));
    if (!hasPresaleWallet) {
      console.log("Presale wallet not found in tx's account keys");
      return false;
    }

    // Additional checks if you want to parse amounts precisely
    return true;
  } catch (err) {
    console.error("Error in validateSignatureOnChain:", err);
    return false;
  }
}
