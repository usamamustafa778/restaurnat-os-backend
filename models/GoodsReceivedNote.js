const mongoose = require('mongoose');

const grnLineSchema = new mongoose.Schema(
  {
    inventoryItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryItem',
      required: true,
    },
    itemName: { type: String, required: true, trim: true },
    unit: { type: String, required: true, trim: true },
    receivedQty: { type: Number, required: true, min: 0.001 },
    unitCost: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const goodsReceivedNoteSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    grnNumber: { type: String, trim: true },
    purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', default: null },
    poNumber: { type: String, default: null },
    supplierId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supplierName: { type: String, required: true, trim: true },
    invoiceNumber: { type: String, default: '', trim: true },
    invoiceDate: { type: Date, default: null },
    receivedDate: { type: Date, default: Date.now },
    paymentType: { type: String, enum: ['cash', 'credit'], required: true },
    paymentAccountId: { type: mongoose.Schema.Types.ObjectId, default: null },
    paymentAccountCode: { type: String, default: null },
    status: { type: String, enum: ['draft', 'posted'], default: 'draft', index: true },
    lines: { type: [grnLineSchema], default: [] },
    totalCost: { type: Number, required: true, min: 0 },
    accountingVoucherId: { type: mongoose.Schema.Types.ObjectId, default: null },
    accountingVoucherNumber: { type: String, default: null },
    accountingError: { type: String, default: null },
    notes: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    postedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

goodsReceivedNoteSchema.index({ restaurant: 1, grnNumber: 1 }, { unique: true });

goodsReceivedNoteSchema.pre('save', async function autoGenerateGrnNumber(next) {
  try {
    if (this.isNew && !this.grnNumber) {
      const count = await this.constructor.countDocuments({ restaurant: this.restaurant });
      this.grnNumber = `GRN-${String(count + 1).padStart(4, '0')}`;
    }
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('GoodsReceivedNote', goodsReceivedNoteSchema);
