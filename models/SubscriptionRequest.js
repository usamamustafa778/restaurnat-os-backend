const mongoose = require('mongoose');

const subscriptionRequestSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
    },
    planType: {
      type: String,
      enum: ['1_month', '3_month', '6_month'],
      required: true,
    },
    durationInDays: {
      type: Number,
      required: true,
    },
    paymentScreenshot: {
      type: String, // Cloudinary URL
      required: true,
    },
    paymentMethod: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentMethod',
    },
    paymentMethodName: {
      type: String, // snapshot of payment method name at time of request
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    approvedAt: {
      type: Date,
    },
    rejectedAt: {
      type: Date,
    },
  },
  {
    timestamps: true, // adds createdAt and updatedAt
  }
);

const SubscriptionRequest = mongoose.model('SubscriptionRequest', subscriptionRequestSchema);

module.exports = SubscriptionRequest;
