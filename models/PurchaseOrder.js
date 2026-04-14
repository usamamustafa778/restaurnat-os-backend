const mongoose = require('mongoose');

const poLineSchema = new mongoose.Schema(
  {
    inventoryItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryItem',
      required: true,
    },
    itemName: { type: String, required: true, trim: true },
    unit: { type: String, required: true, trim: true },
    orderedQty: { type: Number, required: true, min: 0.001 },
    receivedQty: { type: Number, default: 0, min: 0 },
    estimatedUnitCost: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '' },
  },
  { _id: false }
);

const purchaseOrderSchema = new mongoose.Schema(
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
    poNumber: { type: String, trim: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supplierName: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['draft', 'sent', 'partially_received', 'received', 'cancelled'],
      default: 'draft',
      index: true,
    },
    expectedDeliveryDate: { type: Date, default: null },
    notes: { type: String, default: '' },
    lines: { type: [poLineSchema], default: [] },
    totalEstimatedCost: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

purchaseOrderSchema.index({ restaurant: 1, poNumber: 1 }, { unique: true });

purchaseOrderSchema.pre('save', async function autoGeneratePoNumber(next) {
  try {
    if (this.isNew && !this.poNumber) {
      const count = await this.constructor.countDocuments({ restaurant: this.restaurant });
      this.poNumber = `PO-${String(count + 1).padStart(4, '0')}`;
    }
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
