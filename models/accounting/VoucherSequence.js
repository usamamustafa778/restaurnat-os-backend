const mongoose = require('mongoose');

const voucherSequenceSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    type: { type: String, required: true },
    lastNumber: { type: Number, default: 0 },
  },
  { timestamps: true }
);

voucherSequenceSchema.index({ tenantId: 1, type: 1 }, { unique: true });

const VoucherSequence = mongoose.model('VoucherSequence', voucherSequenceSchema);

module.exports = VoucherSequence;
