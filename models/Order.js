const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    menuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      default: null,
    },
    name: {
      // name snapshot for historical reporting even if menu item changes
      type: String,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    lineTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    note: {
      type: String,
      default: '',
    },
  },
  { _id: false }
);

const appliedDealSchema = new mongoose.Schema(
  {
    deal: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Deal',
      required: true,
    },
    dealName: {
      type: String,
      required: true,
      // Snapshot of deal name for historical records
    },
    dealType: {
      type: String,
      required: true,
    },
    discountAmount: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
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
    table: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Table',
      default: null,
    },
    tableNumber: {
      type: String,
      default: '',
    },
    tableName: {
      type: String,
      default: '',
    },
    daySession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DaySession',
      default: null,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    orderType: {
      type: String,
      enum: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'],
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: ['PENDING', 'CASH', 'CARD', 'ONLINE', 'SPLIT', 'OTHER'],
      default: 'PENDING',
    },
    paymentProvider: {
      type: String,
      default: null,
    },
    paymentAmountReceived: { type: Number, default: null },
    paymentAmountReturned: { type: Number, default: null },
    splitCashAmount: { type: Number, default: null, min: 0 },
    splitCardAmount: { type: Number, default: null, min: 0 },
    splitOnlineAmount: { type: Number, default: null, min: 0 },
    splitOnlineProvider: { type: String, default: null },
    assignedRiderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignedRiderName: { type: String, default: '' },
    assignedRiderPhone: { type: String, default: '' },
    deliveryCharges: { type: Number, default: 0, min: 0 },
    /** Matched zone from website.branch deliveryLocations (optional). */
    deliveryLocationId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    deliveryLocationName: { type: String, default: '' },
    deliveryPaymentCollected: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['NEW_ORDER', 'PROCESSING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'],
      default: 'NEW_ORDER',
    },
    source: {
      type: String,
      enum: ['POS', 'FOODPANDA', 'WEBSITE'],
      default: 'POS',
    },
    externalOrderId: {
      type: String,
      default: '',
    },
    customerName: {
      type: String,
      default: '',
    },
    customerPhone: {
      type: String,
      default: '',
    },
    /** Digits-only normalization for WEBSITE orders (guest ↔ account linking). */
    customerPhoneDigits: {
      type: String,
      default: '',
    },
    customerEmail: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
    },
    storefrontCustomer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StorefrontCustomer',
      default: null,
      index: true,
    },
    deliveryAddress: {
      type: String,
      default: '',
    },
    items: [orderItemSchema],
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    discountAmount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    appliedDeals: [appliedDealSchema],
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    orderNumber: {
      type: String,
      required: true,
    },
    grandTotal: {
      type: Number,
      default: null,
    },
    cancelReason: {
      type: String,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    statusHistory: [
      {
        status: { type: String, required: true },
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
    ingredientCost: {
      type: Number,
      min: 0,
      default: 0,
    },
    profit: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Uniqueness per branch (and per restaurant when branch is null)
orderSchema.index({ restaurant: 1, branch: 1, orderNumber: 1 }, { unique: true });

const Order = mongoose.model('Order', orderSchema);

module.exports = Order;

