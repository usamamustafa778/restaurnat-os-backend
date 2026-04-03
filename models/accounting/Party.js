const mongoose = require('mongoose');

const partySchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['supplier', 'customer', 'employee', 'director', 'other'],
      required: true,
    },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    openingBalance: { type: Number, default: 0 },
    balanceType: { type: String, enum: ['debit', 'credit'], default: 'credit' },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

partySchema.index({ tenantId: 1, type: 1 });
partySchema.index({ tenantId: 1, name: 'text' });

const Party = mongoose.model('Party', partySchema);

module.exports = Party;
