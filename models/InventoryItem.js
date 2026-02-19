const mongoose = require('mongoose');

const inventoryItemSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    // Optional branch scoping: when set, this inventory item definition belongs to a single branch
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    unit: {
      type: String,
      enum: ['kg', 'liter', 'gram', 'ml', 'piece'],
      required: true,
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
    // Cost price per bulk unit:
    //   gram  -> price per 1000 grams
    //   ml    -> price per 1000 ml
    //   piece -> price per 12 pieces (dozen)
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

inventoryItemSchema.index({ restaurant: 1, branch: 1, name: 1 }, { unique: true });

const InventoryItem = mongoose.model('InventoryItem', inventoryItemSchema);

module.exports = InventoryItem;

