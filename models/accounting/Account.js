const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['asset', 'liability', 'capital', 'revenue', 'cogs', 'expense'],
      required: true,
    },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    isActive: { type: Boolean, default: true },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true }
);

accountSchema.index({ tenantId: 1, code: 1 }, { unique: true });
accountSchema.index({ tenantId: 1, type: 1 });

const Account = mongoose.model('Account', accountSchema);

module.exports = Account;
