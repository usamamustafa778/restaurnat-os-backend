const mongoose = require('mongoose');

const voucherLineSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    accountName: { type: String },
    partyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Party', default: null },
    partyName: { type: String },
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    description: { type: String },
    sequence: { type: Number, default: 0 },
  },
  { _id: true }
);

const voucherSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    type: {
      type: String,
      enum: ['cash_payment', 'cash_receipt', 'bank_payment', 'bank_receipt', 'journal', 'card_transfer'],
      required: true,
    },
    voucherNumber: { type: String, required: true },
    date: { type: Date, required: true },
    referenceNo: { type: String },
    notes: { type: String },
    status: { type: String, enum: ['draft', 'posted', 'cancelled'], default: 'draft' },
    totalAmount: { type: Number, required: true },
    autoPosted: { type: Boolean, default: false },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lines: [voucherLineSchema],
  },
  { timestamps: true }
);

voucherSchema.index({ tenantId: 1, date: -1 });
voucherSchema.index({ tenantId: 1, type: 1 });
voucherSchema.index({ tenantId: 1, sourceId: 1 });
voucherSchema.index({ tenantId: 1, voucherNumber: 1 }, { unique: true });

const Voucher = mongoose.model('Voucher', voucherSchema);

module.exports = Voucher;
