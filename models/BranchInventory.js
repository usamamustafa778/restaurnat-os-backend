const mongoose = require('mongoose');

/**
 * Per-branch inventory stock. InventoryItem is the restaurant-level definition (name, unit);
 * BranchInventory holds currentStock, lowStockThreshold, costPrice per branch.
 */
const branchInventorySchema = new mongoose.Schema(
  {
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    inventoryItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryItem',
      required: true,
      index: true,
    },
    currentStock: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    lowStockThreshold: {
      type: Number,
      min: 0,
      default: 0,
    },
    costPrice: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

branchInventorySchema.index({ branch: 1, inventoryItem: 1 }, { unique: true });

const BranchInventory = mongoose.model('BranchInventory', branchInventorySchema);

module.exports = BranchInventory;
