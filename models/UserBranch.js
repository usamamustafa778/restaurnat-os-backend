const mongoose = require('mongoose');

const userBranchSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['manager', 'cashier', 'kitchen_staff', 'admin', 'product_manager', 'order_taker'],
      default: 'manager',
    },
  },
  {
    timestamps: true,
  }
);

userBranchSchema.index({ user: 1, branch: 1 }, { unique: true });

const UserBranch = mongoose.model('UserBranch', userBranchSchema);

module.exports = UserBranch;
