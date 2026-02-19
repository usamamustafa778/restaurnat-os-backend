const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    // Optional branch scoping: when set, this category belongs to a single branch
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
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

categorySchema.index({ restaurant: 1, branch: 1, name: 1 }, { unique: true });

const Category = mongoose.model('Category', categorySchema);

module.exports = Category;


