const mongoose = require('mongoose');

const paymentMethodSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Dynamic key-value fields for account details
    // e.g. { accountTitle: "John", accountNumber: "03001234567" }
    fields: [
      {
        label: { type: String, required: true }, // e.g. "Account Number"
        value: { type: String, required: true }, // e.g. "03001234567"
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

const PaymentMethod = mongoose.model('PaymentMethod', paymentMethodSchema);

module.exports = PaymentMethod;
