const mongoose = require('mongoose');

const dailyCurrencySchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },
    /** Date as YYYY-MM-DD (start of day in local/store time) */
    date: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    /** Note value (Rs) -> quantity, e.g. { "5000": 10, "1000": 5, "500": 20 } */
    quantities: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

dailyCurrencySchema.index({ restaurant: 1, branch: 1, date: 1 }, { unique: true });

const DailyCurrency = mongoose.model('DailyCurrency', dailyCurrencySchema);
module.exports = DailyCurrency;
