const express = require('express');
const Order = require('../models/Order');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const Branch = require('../models/Branch');
const Customer = require('../models/Customer');
const Category = require('../models/Category');
const MenuItem = require('../models/MenuItem');
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

// @route   GET /api/rider/branches
// @desc    List active branches so rider can select one when placing orders
// @access  delivery_rider
router.get('/branches', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant ? req.restaurant._id : req.user.restaurant;
    if (!restaurantId) {
      return res.status(400).json({ message: 'Restaurant context missing' });
    }
    const branches = await Branch.find({ restaurant: restaurantId, isDeleted: { $ne: true } })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    res.json({
      branches: branches.map((b) => ({
        id: b._id.toString(),
        name: b.name,
        address: b.address || '',
      })),
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/rider/customers
// @desc    List / search customers for autofill. Without ?q returns all (up to 500).
// @access  delivery_rider
router.get('/customers', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant ? req.restaurant._id : req.user.restaurant;
    if (!restaurantId) {
      return res.status(400).json({ message: 'Restaurant context missing' });
    }

    const query = { restaurant: restaurantId };

    const customers = await Customer.find(query)
      .sort({ lastOrderAt: -1, createdAt: -1 })
      .limit(500)
      .lean();

    res.json(
      customers.map((c) => ({
        id: c._id.toString(),
        name: c.name,
        phone: c.phone,
        address: c.address || '',
      }))
    );
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/rider/customers
// @desc    Quick-add a new customer from the rider flow
// @access  delivery_rider
router.post('/customers', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant ? req.restaurant._id : req.user.restaurant;
    if (!restaurantId) {
      return res.status(400).json({ message: 'Restaurant context missing' });
    }

    const { name, phone, address } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ message: 'Name and phone are required' });
    }

    const customer = await Customer.create({
      restaurant: restaurantId,
      branch: null,
      name: name.trim(),
      phone: phone.trim(),
      address: (address || '').trim(),
    });

    res.status(201).json({
      id: customer._id.toString(),
      name: customer.name,
      phone: customer.phone,
      address: customer.address || '',
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/rider/menu
// @desc    Get menu (categories + items) for rider to create delivery orders. No branch scope.
// @access  delivery_rider
router.get('/menu', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant ? req.restaurant._id : req.user.restaurant;
    if (!restaurantId) {
      return res.status(400).json({ message: 'Restaurant context missing' });
    }

    // Include both restaurant-level (branch null) and any branch-level menu so riders see full catalog
    const [categories, items] = await Promise.all([
      Category.find({ restaurant: restaurantId }).sort({ createdAt: 1 }),
      MenuItem.find({ restaurant: restaurantId, available: true }),
    ]);

    const categoriesPayload = categories.map((c) => ({
      id: c._id.toString(),
      _id: c._id.toString(),
      name: c.name,
      description: c.description || '',
    }));

    const itemsPayload = items.map((item) => ({
      id: item._id.toString(),
      _id: item._id.toString(),
      name: item.name,
      price: item.price,
      finalPrice: item.price,
      categoryId: item.category ? item.category.toString() : null,
      available: item.available,
      finalAvailable: item.available,
      imageUrl: item.imageUrl || '',
    }));

    res.json({ categories: categoriesPayload, items: itemsPayload });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/rider/orders
// @desc    Get orders assigned to OR created by the authenticated rider
// @access  delivery_rider
router.get('/orders', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant ? req.restaurant._id : req.user.restaurant;
    if (!restaurantId) {
      return res.status(400).json({ message: 'Restaurant context missing' });
    }

    const statusFilter = req.query.status
      ? req.query.status
      : { $in: ['NEW_ORDER', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED'] };

    const filter = {
      restaurant: restaurantId,
      $or: [
        { assignedRiderId: req.user.id },
        { createdBy: req.user.id },
      ],
      status: statusFilter,
    };

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
