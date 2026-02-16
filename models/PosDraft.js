const mongoose = require('mongoose');

const draftItemSchema = new mongoose.Schema(
  {
    menuItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    imageUrl: {
      type: String,
      default: '',
    },
  },
  { _id: false }
);

const posDraftSchema = new mongoose.Schema(
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
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    ref: {
      type: String,
      unique: true,
      sparse: true,
    },
    orderNumber: {
      type: String,
      default: '',
    },
    items: [draftItemSchema],
    orderType: {
      type: String,
      enum: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'],
      default: 'DINE_IN',
    },
    customerName: {
      type: String,
      default: '',
    },
    customerPhone: {
      type: String,
      default: '',
    },
    deliveryAddress: {
      type: String,
      default: '',
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    itemNotes: {
      type: Map,
      of: String,
      default: {},
    },
    tableNumber: {
      type: String,
      default: '',
    },
    tableName: {
      type: String,
      default: '',
    },
    selectedWaiter: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Auto-generate ref number before saving
posDraftSchema.pre('save', async function (next) {
  if (!this.ref) {
    // Generate a random 5-digit reference number
    const randomRef = Math.floor(10000 + Math.random() * 90000).toString();
    this.ref = randomRef;
  }
  next();
});

// Index for efficient querying
posDraftSchema.index({ restaurant: 1, branch: 1, createdAt: -1 });
posDraftSchema.index({ createdBy: 1, createdAt: -1 });

const PosDraft = mongoose.model('PosDraft', posDraftSchema);

module.exports = PosDraft;
