const mongoose = require('mongoose');

const integrationSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ['FOODPANDA'],
      required: true,
    },
    storeId: {
      type: String,
      default: '',
    },
    apiKey: {
      type: String,
      default: '',
    },
    apiSecret: {
      type: String,
      default: '',
    },
    isActive: {
      type: Boolean,
      default: false,
    },
    lastSyncAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// One integration per platform per restaurant
integrationSchema.index({ restaurant: 1, platform: 1 }, { unique: true });

const Integration = mongoose.model('Integration', integrationSchema);

module.exports = Integration;
