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
      enum: ['CASH', 'CARD', 'ONLINE', 'OTHER'],
      required: true,
    },
    status: {
      type: String,
      enum: ['UNPROCESSED', 'PENDING', 'READY', 'COMPLETED', 'CANCELLED'],
      default: 'UNPROCESSED',
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
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    orderNumber: {
      type: String,
      required: true,
      unique: true,
    },
  },
  {
    timestamps: true,
  }
);

const Order = mongoose.model('Order', orderSchema);

module.exports = Order;

