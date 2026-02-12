const mongoose = require('mongoose');

/**
 * Branch-level overrides for a menu item.
 * If a BranchMenuItem row exists for a branch+menuItem, the override fields apply.
 * If no row exists, the base MenuItem values are used.
 */
const branchMenuItemSchema = new mongoose.Schema(
  {
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    menuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      required: true,
      index: true,
    },
    // Override availability for this branch (null = use base)
    available: {
      type: Boolean,
      default: true,
    },
    // Override price for this branch (null = use base price)
    priceOverride: {
      type: Number,
      default: null,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

branchMenuItemSchema.index({ branch: 1, menuItem: 1 }, { unique: true });

const BranchMenuItem = mongoose.model('BranchMenuItem', branchMenuItemSchema);

module.exports = BranchMenuItem;
