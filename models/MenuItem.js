const mongoose = require('mongoose');

const inventoryConsumptionSchema = new mongoose.Schema(
  {
    inventoryItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryItem',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const menuItemSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    // Optional branch scoping: when set, this item belongs to a single branch
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
    description: {
      type: String,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    available: {
      type: Boolean,
      default: true,
    },
    availableAtAllBranches: {
      type: Boolean,
      default: true,
      // If true, item is available at all branches by default (unless branch override disables it)
      // If false, item must be explicitly enabled at each branch
    },
    showOnWebsite: {
      type: Boolean,
      default: true,
    },
    imageUrl: {
      type: String,
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
    isBestSeller: {
      type: Boolean,
      default: false,
    },
    isTrending: {
      type: Boolean,
      default: false,
    },
    isMustTry: {
      type: Boolean,
      default: false,
    },
    dietaryType: {
      type: String,
      enum: ['veg', 'non_veg', 'egg'],
      default: 'non_veg',
    },
    inventoryConsumptions: [inventoryConsumptionSchema],
  },
  {
    timestamps: true,
  }
);

menuItemSchema.index({ restaurant: 1, branch: 1, name: 1 }, { unique: true });

const MenuItem = mongoose.model('MenuItem', menuItemSchema);

module.exports = MenuItem;


