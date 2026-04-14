const express = require('express');
const Order = require('../models/Order');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const DaySession = require('../models/DaySession');
const Branch = require('../models/Branch');
const Customer = require('../models/Customer');
const Category = require('../models/Category');
const MenuItem = require('../models/MenuItem');
const InventoryItem = require('../models/InventoryItem');
const BranchInventory = require('../models/BranchInventory');
const BranchMenuItem = require('../models/BranchMenuItem');
const { checkInventorySufficiency } = require('../utils/checkInventorySufficiency');
const { protect, requireRole, resolveBranch } = require('../middleware/authMiddleware');
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

// Same as admin routes: resolve req.branch from x-branch-id so inventory matches POS
router.use(resolveBranch);

const mapRiderOrder = (order) => ({
  id: order.orderNumber || order._id.toString(),
  _id: order._id.toString(),
  orderNumber: order.orderNumber,
  orderType: order.orderType || 'DELIVERY',
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
// @desc    Menu for rider new orders — matches POS: branch-aware stock (inventorySufficient), optional ?branchId=
// @access  delivery_rider
router.get('/menu', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant ? req.restaurant._id : req.user.restaurant;
    if (!restaurantId) {
      return res.status(400).json({ message: 'Restaurant context missing' });
    }

    // Match GET /api/admin/menu: prefer ?branchId=, else branch from resolveBranch (x-branch-id header)
    let branchId = req.branch?._id || null;
    if (req.query.branchId && req.query.branchId !== 'all') {
      const branchDoc = await Branch.findOne({
        _id: req.query.branchId,
        restaurant: restaurantId,
        isDeleted: { $ne: true },
      }).select('_id');
      if (branchDoc) branchId = branchDoc._id;
    }

    let categories;
    let rawItems;
    let inventoryItems;

    if (branchId) {
      const categoryQuery = { restaurant: restaurantId, branch: branchId };
      const itemQuery = { restaurant: restaurantId, branch: branchId };
      const inventoryQuery = { restaurant: restaurantId, branch: branchId };
      [categories, rawItems, inventoryItems] = await Promise.all([
        Category.find(categoryQuery).sort({ createdAt: 1 }),
        MenuItem.find(itemQuery),
        InventoryItem.find(inventoryQuery),
      ]);
    } else {
      // Legacy: same broad catalog as before (no branch filter on items/categories)
      [categories, rawItems, inventoryItems] = await Promise.all([
        Category.find({ restaurant: restaurantId }).sort({ createdAt: 1 }),
        MenuItem.find({ restaurant: restaurantId, available: true }),
        InventoryItem.find({ restaurant: restaurantId }),
      ]);
    }

    const inventoryMap = new Map();
    if (branchId) {
      const branchRows = await BranchInventory.find({ branch: branchId }).lean();
      const branchStockByInv = new Map();
      for (const row of branchRows) {
        branchStockByInv.set(row.inventoryItem.toString(), row.currentStock);
      }
      for (const inv of inventoryItems) {
        const currentStock = branchStockByInv.get(inv._id.toString()) ?? 0;
        inventoryMap.set(inv._id.toString(), { name: inv.name, unit: inv.unit, currentStock });
      }
    } else {
      for (const inv of inventoryItems) {
        inventoryMap.set(inv._id.toString(), inv);
      }
    }

    let overrideMap = new Map();
    if (branchId) {
      const overrides = await BranchMenuItem.find({ branch: branchId }).lean();
      for (const o of overrides) {
        overrideMap.set(o.menuItem.toString(), o);
      }
    }

    const activeCategoryIdSet = new Set(
      categories.filter((c) => c.isActive !== false).map((c) => c._id.toString()),
    );

    const itemsPayload = [];
    for (const item of rawItems) {
      if (!item.available) continue;

      const catId = item.category ? item.category.toString() : null;
      if (catId && !activeCategoryIdSet.has(catId)) continue;

      // Legacy (no branch): items that require per-branch enablement are not sellable here
      if (!branchId && item.availableAtAllBranches === false) continue;

      const { sufficient } = checkInventorySufficiency(item, inventoryMap);

      let finalAvailable = item.available;
      let finalPrice = item.price;

      if (branchId) {
        const override = overrideMap.get(item._id.toString());
        let branchAvailable = item.availableAtAllBranches !== false ? item.available : false;
        if (override) {
          branchAvailable = override.available;
        }
        finalAvailable = branchAvailable;
        if (override?.priceOverride != null) {
          finalPrice = override.priceOverride;
        }
      }

      if (!finalAvailable) continue;

      itemsPayload.push({
        id: item._id.toString(),
        _id: item._id.toString(),
        name: item.name,
        price: item.price,
        finalPrice,
        categoryId: item.category ? item.category.toString() : null,
        available: item.available,
        finalAvailable,
        imageUrl: item.imageUrl || '',
        inventorySufficient: sufficient,
      });
    }

    const categoriesPayload = categories
      .filter((c) => c.isActive !== false)
      .map((c) => ({
        id: c._id.toString(),
        _id: c._id.toString(),
        name: c.name,
        description: c.description || '',
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

    const range = String(req.query.range || 'today').toLowerCase();
    const now = new Date();
    const toStartOfDay = (d) => {
      const v = new Date(d);
      v.setHours(0, 0, 0, 0);
      return v;
    };
    const addDays = (d, days) => {
      const v = new Date(d);
      v.setDate(v.getDate() + days);
      return v;
    };
    const parseDateOnly = (value) => {
      if (!value || typeof value !== 'string') return null;
      const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const da = Number(m[3]);
      const v = new Date(y, mo - 1, da);
      if (Number.isNaN(v.getTime())) return null;
      return toStartOfDay(v);
    };

    let dayStart = toStartOfDay(now);
    let dayEnd = addDays(dayStart, 1);
    if (range === 'yesterday') {
      dayStart = addDays(dayStart, -1);
      dayEnd = addDays(dayStart, 1);
    } else if (range === 'week') {
      const day = dayStart.getDay(); // 0=Sun
      const diffToMonday = day === 0 ? 6 : day - 1;
      dayStart = addDays(dayStart, -diffToMonday);
      dayEnd = addDays(dayStart, 7);
    } else if (range === 'month') {
      dayStart = new Date(dayStart.getFullYear(), dayStart.getMonth(), 1);
      dayEnd = new Date(dayStart.getFullYear(), dayStart.getMonth() + 1, 1);
    } else if (range === 'custom') {
      const from = parseDateOnly(req.query.from);
      const to = parseDateOnly(req.query.to);
      if (!from || !to || to < from) {
        return res.status(400).json({ message: 'For custom range, valid from/to dates are required (YYYY-MM-DD).' });
      }
      dayStart = from;
      dayEnd = addDays(to, 1); // inclusive "to" date
    }

    const openSessions = await DaySession.find({ restaurant: restaurantId, status: 'OPEN' }).select('_id').lean();
    const openSessionIds = openSessions.map((s) => s._id);

    // Rider should only see their own assigned deliveries.
    const riderMatch = { assignedRiderId: req.user.id };

    const isToday = range === 'today';
    const businessDayConstraint = isToday
      ? (openSessionIds.length > 0
          ? {
              $or: [
                { daySession: { $in: openSessionIds } },
                // Some orders can be created without daySession linkage.
                { daySession: null, createdAt: { $gte: dayStart, $lt: dayEnd } },
              ],
            }
          : { createdAt: { $gte: dayStart, $lt: dayEnd } })
      : { createdAt: { $gte: dayStart, $lt: dayEnd } };

    const orders = await Order.find({
      restaurant: restaurantId,
      ...riderMatch,
      status: { $in: ['NEW_ORDER', 'PROCESSING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'] },
      ...businessDayConstraint,
    }).sort({ createdAt: -1 }).limit(200).lean();

    res.json(orders.map(mapRiderOrder));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/rider/orders/:id/collect
// @desc    Rider picks up a READY order → status becomes OUT_FOR_DELIVERY, rider is assigned
// @access  delivery_rider
router.put('/orders/:id/collect', async (req, res, next) => {
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

    if (order.status !== 'READY') {
      return res.status(400).json({ message: `Order must be READY to collect (current: ${order.status})` });
    }

    // Only the assigned rider may collect when a rider is already assigned.
    // If assignedRiderId is null, allow the first rider who presses collect.
    if (order.assignedRiderId && order.assignedRiderId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You are not assigned to collect this order' });
    }

    order.status = 'OUT_FOR_DELIVERY';
    order.assignedRiderId = req.user.id;
    order.assignedRiderName = req.user.name || '';
    order.assignedRiderPhone = req.user.phone || '';
    if (!order.statusHistory) order.statusHistory = [];
    order.statusHistory.push({ status: 'OUT_FOR_DELIVERY', at: new Date() });
    await order.save();

    const io = req.app.get('io');
    if (io) {
      const rooms = getOrderRooms(order.restaurant, order.branch);
      const payload = { id: order._id.toString(), orderNumber: order.orderNumber, status: order.status, assignedRiderId: req.user.id, assignedRiderName: req.user.name || '' };
      rooms.forEach((room) => io.to(room).emit('order:updated', payload));
    }

    res.json(mapRiderOrder(order));
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
    if (!order.statusHistory) order.statusHistory = [];
    order.statusHistory.push({ status: 'DELIVERED', at: new Date() });
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
