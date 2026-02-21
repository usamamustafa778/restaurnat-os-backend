const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      trim: true,
      default: null,
    },
    address: {
      type: String,
      default: '',
    },
    contactPhone: {
      type: String,
      default: '',
    },
    contactEmail: {
      type: String,
      default: '',
    },
    openingHours: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Optional branch-specific website overrides (hero slides, sections, colors, etc.)
    websiteOverrides: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'closed_today'],
      default: 'active',
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    // POS: show table (and optional) section in POS for this branch
    showTablePos: {
      type: Boolean,
      default: true,
    },
    // POS: show waiter dropdown for this branch
    showWaiterPos: {
      type: Boolean,
      default: true,
    },
    // POS: show customer (Select Customer) field for this branch
    showCustomerPos: {
      type: Boolean,
      default: true,
    },
    // Soft delete flags for safe recovery
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

branchSchema.index({ restaurant: 1, code: 1 }, { unique: true, sparse: true });

const Branch = mongoose.model('Branch', branchSchema);

module.exports = Branch;
