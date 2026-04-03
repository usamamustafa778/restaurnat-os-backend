const mongoose = require('mongoose');

const bankAccountSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    name: { type: String, required: true, trim: true },
    bankName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    openingBalance: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

bankAccountSchema.index({ tenantId: 1 });

const BankAccount = mongoose.model('BankAccount', bankAccountSchema);

module.exports = BankAccount;
