const express = require('express');
const Order = require('../models/Order');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const { protect, requireRole } = require('../middleware/authMiddleware');
const { getOrderRooms } = require('../utils/socketRooms');

const router = express.Router();

// All rider routes require a valid JWT and delivery_rider role
// (restaurant_admin and admin can also call these for testing/support)
router.use(protect, requireRole('delivery_rider', 'restaurant_admin', 'super_admin', 'admin'));

// Resolve the restaurant from the authenticated user
router.use(async (req, res, next) => {
  try {
    if (req.user.role === 'super_admin') {
      const tenantSlug = req.headers['x-tenant-slug'];
      if (tenantSlug) {
        const restaurant = await Restaurant.findOne({ 'website.subdomain': tenantSlug });
        if (restaurant) req.restaurant = restaurant;
      }
      return next();
    }
    if (!req.user.restaurant) {
      return res.status(400).json({ message: 'User is not linked to any restaurant' });
    }
    const restaurant = await Restaurant.findById(req.user.restaurant);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }
    req.restaurant = restaurant;
    next();
  } catch (error) {
    next(error);
  }
});

const mapRiderOrder = (order) => ({
  id: order.orderNumber || order._id.toString(),
  _id: order._id.toString(),
  orderNumber: order.orderNumber,
  status: order.status,
  customerName: order.customerName || '',
  customerPhone: order.customerPhone || '',
  deliveryAddress: order.deliveryAddress || '',
  total: order.total,
  grandTotal: order.grandTotal ?? order.total,
  paymentMethod: order.paymentMethod,
  deliveryCharges: order.deliveryCharges ?? 0,
  deliveryPaymentCollected: order.deliveryPaymentCollected ?? false,
  assignedRiderId: order.assignedRiderId ? order.assignedRiderId.toString() : null,
  assignedRiderName: order.assignedRiderName || '',
  assignedRiderPhone: order.assignedRiderPhone || '',
  items: (order.items || []).map((i) => ({
    name: i.name,
    qty: i.quantity,
    unitPrice: i.unitPrice,
    lineTotal: i.lineTotal,
  })),
  createdAt: order.createdAt,
});

// @route   GET /api/rider/me
// @desc    Get authenticated rider's profile
// @access  delivery_rider
router.get('/me', async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password -emailVerificationOtp -emailVerificationOtpExpires -resetPasswordOtp -resetPasswordOtpExpires');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone || '',
      role: user.role,
      vehicleType: user.vehicleType || null,
      profileImageUrl: user.profileImageUrl || null,
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/rider/orders
// @desc    Get orders assigned to the authenticated rider
// @access  delivery_rider
router.get('/orders', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant ? req.restaurant._id : req.user.restaurant;
    if (!restaurantId) {
      return res.status(400).json({ message: 'Restaurant context missing' });
    }

    const filter = {
      restaurant: restaurantId,
      assignedRiderId: req.user.id,
    };

    // Optionally filter by status via ?status=OUT_FOR_DELIVERY
    if (req.query.status) {
      filter.status = req.query.status;
    } else {
      // By default return active (non-cancelled) assigned orders
      filter.status = { $in: ['OUT_FOR_DELIVERY', 'DELIVERED'] };
    }

    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(100);
    res.json(orders.map(mapRiderOrder));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/rider/orders/:id/delivered
// @desc    Rider marks their assigned order as DELIVERED
// @access  delivery_rider
router.put('/orders/:id/delivered', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant ? req.restaurant._id : req.user.restaurant;
    if (!restaurantId) {
      return res.status(400).json({ message: 'Restaurant context missing' });
    }

    let order;
    if (/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      order = await Order.findOne({ _id: req.params.id, restaurant: restaurantId });
    }
    if (!order) {
      order = await Order.findOne({ orderNumber: req.params.id, restaurant: restaurantId });
    }
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Only the assigned rider may mark it delivered (admins bypass this check)
    const isAdmin = ['restaurant_admin', 'super_admin', 'admin'].includes(req.user.role);
    if (!isAdmin && (!order.assignedRiderId || order.assignedRiderId.toString() !== req.user.id)) {
      return res.status(403).json({ message: 'You are not assigned to this order' });
    }

    if (order.status !== 'OUT_FOR_DELIVERY') {
      return res.status(400).json({ message: `Order must be OUT_FOR_DELIVERY to mark as delivered (current: ${order.status})` });
    }

    order.status = 'DELIVERED';
    await order.save();

    const io = req.app.get('io');
    if (io) {
      const rooms = getOrderRooms(order.restaurant, order.branch);
      const payload = { id: order._id.toString(), orderNumber: order.orderNumber, status: order.status };
      rooms.forEach((room) => io.to(room).emit('order:updated', payload));
    }

    res.json(mapRiderOrder(order));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
