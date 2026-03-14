const mongoose = require('mongoose');

const paymentAccountSchema = new mongoose.Schema(
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
    description: {
      type: String,
      trim: true,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

paymentAccountSchema.index({ restaurant: 1, name: 1 }, { unique: true });

const PaymentAccount = mongoose.model('PaymentAccount', paymentAccountSchema);

module.exports = PaymentAccount;
