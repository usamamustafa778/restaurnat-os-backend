const mongoose = require('mongoose');

const daySessionSchema = new mongoose.Schema(
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
    status: {
      type: String,
      enum: ['OPEN', 'CLOSED'],
      default: 'OPEN',
      index: true,
    },
    startAt: {
      type: Date,
      required: true,
    },
    endAt: {
      type: Date,
      default: null,
    },
    // Human-readable key filled when day is closed: "startAt - endAt"
    sessionKey: {
      type: String,
      default: '',
      index: true,
    },
    openedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

// Only one OPEN session per restaurant+branch at a time
daySessionSchema.index(
  { restaurant: 1, branch: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'OPEN' },
  }
);

module.exports = mongoose.model('DaySession', daySessionSchema);
