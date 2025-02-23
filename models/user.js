// models/User.js

const mongoose = require("mongoose");

/**
 * Each 'User' record represents a distinct wallet user in your system.
 * - 'walletAddress': The user’s Solana address
 * - 'referralCode': The code they share with others, e.g. "ABC123"
 * - 'referralEarnings': The total USD they've earned from referrals
 */
const userSchema = new mongoose.Schema({
  walletAddress: {
    type: String,
    unique: true,
    required: true
  },
  referralCode: {
    type: String,
    unique: true,
    required: false
  },
  referralEarnings: {
    type: Number,
    default: 0
  }
});

module.exports = mongoose.model("User", userSchema);
