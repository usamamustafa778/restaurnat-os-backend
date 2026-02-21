const express = require('express');
const Category = require('../models/Category');
const MenuItem = require('../models/MenuItem');
const InventoryItem = require('../models/InventoryItem');
const BranchInventory = require('../models/BranchInventory');
const BranchMenuItem = require('../models/BranchMenuItem');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const User = require('../models/User');
const UserBranch = require('../models/UserBranch');
const Restaurant = require('../models/Restaurant');
const Branch = require('../models/Branch');
const Table = require('../models/Table');
const Reservation = require('../models/Reservation');
const { protect, requireRole, requireRestaurant, checkSubscriptionStatus, resolveBranch } = require('../middleware/authMiddleware');

const router = express.Router();

// Allow restaurant owner and staff roles to access tenant admin APIs
router.use(
  protect,
  requireRole(
    'restaurant_admin',
    'super_admin',
    'admin',
    'product_manager',
    'cashier',
    'manager',
    'kitchen_staff',
    'order_taker'
  )
);

// If not super admin, load the restaurant linked to the user and enforce active subscription
router.use(async (req, res, next) => {
  try {
    if (req.user.role === 'super_admin') {
      return next();
    }

    if (!req.user.restaurant) {
      return res.status(400).json({ message: 'User is not linked to any restaurant' });
    }

    const restaurant = await Restaurant.findById(req.user.restaurant);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    // Prevent cross-tenant access: verify the x-tenant-slug header matches the user's restaurant
    const tenantSlug = req.headers['x-tenant-slug'];
    if (tenantSlug && restaurant.website?.subdomain && tenantSlug !== restaurant.website.subdomain) {
      return res.status(403).json({ message: 'Access denied: you do not have permission to access this restaurant' });
    }

    req.restaurant = restaurant;
    return checkSubscriptionStatus(req, res, next);
  } catch (error) {
    return next(error);
  }
});

// Resolve branch from x-branch-id (sets req.branch when valid)
router.use(resolveBranch);

const getRestaurantIdForRequest = (req) => {
  if (req.user.role === 'super_admin' && req.query.restaurantId) {
    return req.query.restaurantId;
  }
  return req.restaurant?._id || req.user.restaurant;
};

const getBranchIdForRequest = (req) => req.branch?._id || null;

const mapBranch = (branch) => ({
  id: branch._id.toString(),
  name: branch.name,
  code: branch.code || '',
  address: branch.address || '',
  contactPhone: branch.contactPhone || '',
  contactEmail: branch.contactEmail || '',
  openingHours: branch.openingHours || {},
  status: branch.status || 'active',
  sortOrder: branch.sortOrder ?? 0,
  createdAt: branch.createdAt?.toISOString?.(),
  updatedAt: branch.updatedAt?.toISOString?.(),
});

const slugify = (value) =>
  value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);

const generateUniqueBranchCode = async (restaurantId, baseName) => {
  let base = slugify(baseName);
  if (!base) base = 'branch';
  let candidate = base;
  let counter = 2;
  // Loop until a unique code is found for this restaurant
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // sparse index allows null/undefined, but we never store empty string
    // so we only check for existing non-null codes
    const existing = await Branch.findOne({ restaurant: restaurantId, code: candidate }).select('_id').lean();
    if (!existing) return candidate;
    candidate = `${base}-${counter++}`;
  }
};

// ————— Branch CRUD —————
// @route   GET /api/admin/branches
// @desc    List branches for the tenant (filtered by allowedBranchIds for non-owners; admin/restaurant_admin see all)
// @access  Restaurant Admin / Staff / Super Admin
router.get('/branches', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    let query = { restaurant: restaurantId, isDeleted: { $ne: true } };
    const canSeeAllBranches = req.user.role === 'super_admin' || req.user.role === 'restaurant_admin' || req.user.role === 'admin';
    if (!canSeeAllBranches && req.user.allowedBranchIds?.length) {
      query._id = { $in: req.user.allowedBranchIds };
    }
    const branches = await Branch.find(query).sort({ sortOrder: 1, createdAt: 1 }).lean();
    res.json({ branches: branches.map((b) => mapBranch(b)) });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/branches/deleted
// @desc    List soft-deleted branches from the last 48 hours (owner only)
// @access  Restaurant Admin / Super Admin
router.get('/branches/deleted', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    if (req.user.role !== 'super_admin' && req.user.role !== 'restaurant_admin') {
      return res.status(403).json({ message: 'Only restaurant owner can view deleted branches' });
    }
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const branches = await Branch.find({
      restaurant: restaurantId,
      isDeleted: true,
      deletedAt: { $gte: cutoff },
    })
      .sort({ deletedAt: -1 })
      .lean();
    res.json({ branches: branches.map((b) => mapBranch(b)) });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/branches
// @desc    Create a branch (owner/restaurant_admin only)
// @access  Restaurant Admin / Super Admin
router.post('/branches', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    if (req.user.role !== 'super_admin' && req.user.role !== 'restaurant_admin') {
      return res.status(403).json({ message: 'Only restaurant owner can create branches' });
    }
    const { name, code, address, contactPhone, contactEmail, openingHours, status, sortOrder } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Branch name is required' });
    }
    let finalCode = null;
    if (code && code.trim()) {
      finalCode = code.trim();
      const duplicate = await Branch.findOne({ restaurant: restaurantId, code: finalCode }).select('_id').lean();
      if (duplicate) {
        return res.status(400).json({ message: 'Branch code already exists for this restaurant' });
      }
    } else {
      finalCode = await generateUniqueBranchCode(restaurantId, name);
    }

    const branch = await Branch.create({
      restaurant: restaurantId,
      name: name.trim(),
      code: finalCode,
      address: (address || '').trim(),
      contactPhone: (contactPhone || '').trim(),
      contactEmail: (contactEmail || '').trim(),
      openingHours: openingHours || {},
      status: status || 'active',
      sortOrder: sortOrder ?? 0,
    });
    res.status(201).json(mapBranch(branch));
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/branches/:id
// @desc    Get single branch
// @access  Restaurant Admin / Staff (if allowed)
router.get('/branches/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branch = await Branch.findOne({ _id: req.params.id, restaurant: restaurantId, isDeleted: { $ne: true } });
    if (!branch) {
      return res.status(404).json({ message: 'Branch not found' });
    }
    if (req.user.role !== 'super_admin' && req.user.role !== 'restaurant_admin' && req.user.allowedBranchIds?.length && !req.user.allowedBranchIds.includes(branch._id.toString())) {
      return res.status(403).json({ message: 'Access denied to this branch' });
    }
    res.json(mapBranch(branch));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/branches/:id
// @desc    Update branch
// @access  Restaurant Admin / Super Admin (or manager of branch)
router.put('/branches/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branch = await Branch.findOne({ _id: req.params.id, restaurant: restaurantId, isDeleted: { $ne: true } });
    if (!branch) {
      return res.status(404).json({ message: 'Branch not found' });
    }
    if (req.user.role !== 'super_admin' && req.user.role !== 'restaurant_admin' && (!req.user.allowedBranchIds || !req.user.allowedBranchIds.includes(branch._id.toString()))) {
      return res.status(403).json({ message: 'Access denied to this branch' });
    }
    const { name, code, address, contactPhone, contactEmail, openingHours, status, sortOrder } = req.body;
    if (name !== undefined) branch.name = name.trim();
    if (code !== undefined) {
      const trimmed = code ? code.trim() : null;
      if (!trimmed) {
        branch.code = await generateUniqueBranchCode(restaurantId, branch.name);
      } else if (trimmed !== branch.code) {
        const duplicate = await Branch.findOne({ restaurant: restaurantId, code: trimmed, _id: { $ne: branch._id } })
          .select('_id')
          .lean();
        if (duplicate) {
          return res.status(400).json({ message: 'Branch code already exists for this restaurant' });
        }
        branch.code = trimmed;
      }
    }
    if (address !== undefined) branch.address = (address || '').trim();
    if (contactPhone !== undefined) branch.contactPhone = (contactPhone || '').trim();
    if (contactEmail !== undefined) branch.contactEmail = (contactEmail || '').trim();
    if (openingHours !== undefined) branch.openingHours = openingHours;
    if (status !== undefined) branch.status = status;
    if (sortOrder !== undefined) branch.sortOrder = sortOrder;
    await branch.save();
    res.json(mapBranch(branch));
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/admin/branches/:id
// @desc    Soft-delete branch (mark as deleted, recoverable within 48 hours)
// @access  Restaurant Admin / Super Admin
router.delete('/branches/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    if (req.user.role !== 'super_admin' && req.user.role !== 'restaurant_admin') {
      return res.status(403).json({ message: 'Only restaurant owner can delete branches' });
    }
    const branch = await Branch.findOne({ _id: req.params.id, restaurant: restaurantId });
    if (!branch) {
      return res.status(404).json({ message: 'Branch not found' });
    }
    if (branch.isDeleted) {
      return res.status(400).json({ message: 'Branch is already deleted' });
    }
    branch.status = 'inactive';
    branch.isDeleted = true;
    branch.deletedAt = new Date();
    await branch.save();
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/branches/:id/restore
// @desc    Restore a soft-deleted branch within 48 hours
// @access  Restaurant Admin / Super Admin
router.post('/branches/:id/restore', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    if (req.user.role !== 'super_admin' && req.user.role !== 'restaurant_admin') {
      return res.status(403).json({ message: 'Only restaurant owner can restore branches' });
    }
    const branch = await Branch.findOne({ _id: req.params.id, restaurant: restaurantId });
    if (!branch) {
      return res.status(404).json({ message: 'Branch not found' });
    }
    if (!branch.isDeleted || !branch.deletedAt) {
      return res.status(400).json({ message: 'Branch is not deleted' });
    }
    const now = Date.now();
    const deletedAtMs = branch.deletedAt.getTime();
    const diffHours = (now - deletedAtMs) / (1000 * 60 * 60);
    if (diffHours > 48) {
      return res.status(400).json({ message: 'Restore window (48 hours) has expired for this branch' });
    }
    branch.isDeleted = false;
    branch.deletedAt = null;
    branch.status = 'active';
    await branch.save();
    res.json(mapBranch(branch));
  } catch (error) {
    next(error);
  }
});

// Helper to normalize MongoDB documents to frontend shape
const mapCategory = (category) => ({
  id: category._id.toString(),
  name: category.name,
  description: category.description || '',
  createdAt: category.createdAt.toISOString().slice(0, 10),
});

const mapMenuItem = (item, options) => {
  const invUnitMap = options?.invUnitMap;
  return {
  id: item._id.toString(),
  name: item.name,
  price: item.price,
  categoryId: item.category.toString(),
  available: item.available,
  showOnWebsite: item.showOnWebsite,
  imageUrl: item.imageUrl || '',
  description: item.description || '',
  isFeatured: item.isFeatured || false,
  isBestSeller: item.isBestSeller || false,
  isTrending: item.isTrending || false,
  isMustTry: item.isMustTry || false,
  dietaryType: item.dietaryType || 'non_veg',
    inventoryConsumptions: (item.inventoryConsumptions || []).map((c) => {
      const invId = c.inventoryItem?.toString?.();
      return {
        inventoryItem: invId,
    quantity: c.quantity,
        ...(invUnitMap && invId ? { unit: invUnitMap.get(invId) || 'gram' } : {}),
      };
    }),
  };
};

const mapUser = (user, branchAssignments) => {
  const base = {
  id: user._id.toString(),
  name: user.name,
  email: user.email,
  role: user.role,
  profileImageUrl: user.profileImageUrl || null,
  createdAt: user.createdAt.toISOString(),
  };
  if (branchAssignments) {
    base.branches = branchAssignments.map((a) => ({
      branchId: a.branch?._id?.toString?.() || a.branch?.toString?.() || '',
      branchName: a.branch?.name || '',
      role: a.role,
    }));
  }
  return base;
};

const mapCustomer = (customer) => ({
  id: customer._id.toString(),
  name: customer.name,
  phone: customer.phone,
  email: customer.email || '',
  address: customer.address || '',
  notes: customer.notes || '',
  branchId: customer.branch ? customer.branch.toString() : null,
  totalOrders: customer.totalOrders || 0,
  totalSpent: customer.totalSpent || 0,
  lastOrderAt: customer.lastOrderAt || null,
  createdAt: customer.createdAt?.toISOString?.(),
});

const mapOrder = (order) => {
  // Derive customer name from different sources
  let customerName = order.customerName || '';
  if (!customerName && order.createdBy && typeof order.createdBy === 'object' && order.createdBy.name) {
    customerName = order.createdBy.name;
  }
  if (!customerName) {
    customerName = order.source === 'FOODPANDA' ? 'Foodpanda Customer' : 'Walk\u2011in Customer';
  }

  const paymentLabels = { PENDING: 'To be paid', CASH: 'Cash', CARD: 'Card', ONLINE: 'Online', OTHER: 'Other' };

  return {
    id: order.orderNumber || order._id.toString(),
    _id: order._id.toString(),
    customerName,
    customerPhone: order.customerPhone || '',
    deliveryAddress: order.deliveryAddress || '',
    tableNumber: order.tableNumber || '',
    tableName: order.tableName || '',
    tableId: order.table ? order.table.toString() : null,
    total: order.total,
    subtotal: order.subtotal,
    discountAmount: order.discountAmount || 0,
    status: order.status,
    createdAt: order.createdAt,
    items: (order.items || []).map((i) => ({
      menuItemId: i.menuItem ? i.menuItem.toString() : null,
      name: i.name,
      qty: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
    })),
    type:
      order.orderType === 'DINE_IN'
        ? 'dine-in'
        : order.orderType === 'TAKEAWAY'
        ? 'takeaway'
        : order.orderType === 'DELIVERY'
        ? 'delivery'
        : 'dine-in',
    source: order.source || 'POS',
    externalOrderId: order.externalOrderId || '',
    paymentMethod: paymentLabels[order.paymentMethod] || order.paymentMethod || 'To be paid',
    isPaid: order.paymentMethod !== 'PENDING',
    paymentStatus: order.status === 'COMPLETED' ? 'PAID' : 'UNPAID',
    paymentAmountReceived: order.paymentAmountReceived ?? null,
    paymentAmountReturned: order.paymentAmountReturned ?? null,
  };
};

/**
 * Check whether a menu item has sufficient inventory for at least one sale.
 * Returns { sufficient: boolean, insufficientItems: string[] }
 */
function checkInventorySufficiency(menuItem, inventoryMap) {
  const insufficientItems = [];
  if (!menuItem.inventoryConsumptions || menuItem.inventoryConsumptions.length === 0) {
    return { sufficient: true, insufficientItems };
  }
  for (const consumption of menuItem.inventoryConsumptions) {
    const invId = consumption.inventoryItem ? consumption.inventoryItem.toString() : null;
    if (!invId) continue;
    const inv = inventoryMap.get(invId);
    if (!inv) {
      insufficientItems.push('Unknown ingredient');
      continue;
    }
    const needed = consumption.quantity || 0;
    if (needed > 0 && inv.currentStock < needed) {
      insufficientItems.push(inv.name);
    }
  }
  return { sufficient: insufficientItems.length === 0, insufficientItems };
}

// @route   GET /api/admin/menu
// @desc    Get all categories and menu items for a restaurant.
//          When x-branch-id is set, merge BranchMenuItem overrides (availability, priceOverride).
// @access  Restaurant Admin / Super Admin
router.get('/menu', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    // Prefer explicit ?branchId query param (frontend passes currentBranch.id directly)
    // so the displayed list always matches what duplicate checks query.
    let branchId = getBranchIdForRequest(req);
    if (req.query.branchId && req.query.branchId !== 'all') {
      const branchDoc = await Branch.findOne({ _id: req.query.branchId, restaurant: restaurantId });
      if (branchDoc) branchId = branchDoc._id;
    }

    // When a branch is selected, show only data scoped to that branch.
    // Legacy items/categories/inventory without branch set will appear only when no branch is selected.
    const categoryQuery = { restaurant: restaurantId };
    const itemQuery = { restaurant: restaurantId };
    const inventoryQuery = { restaurant: restaurantId };
    if (branchId) {
      categoryQuery.branch = branchId;
      itemQuery.branch = branchId;
      inventoryQuery.branch = branchId;
    } else {
      categoryQuery.branch = null;
      itemQuery.branch = null;
      inventoryQuery.branch = null;
    }

    const [categories, items, inventoryItems] = await Promise.all([
      Category.find(categoryQuery).sort({ createdAt: 1 }),
      MenuItem.find(itemQuery),
      InventoryItem.find(inventoryQuery),
    ]);

    const invUnitMap = new Map(inventoryItems.map((inv) => [inv._id.toString(), inv.unit || 'gram']));

    // Build inventory lookup map: use branch-level stock when a branch is selected
    const inventoryMap = new Map();
    if (branchId) {
      const branchRows = await BranchInventory.find({ branch: branchId }).lean();
      const branchStockByInv = new Map();
      for (const row of branchRows) {
        branchStockByInv.set(row.inventoryItem.toString(), row.currentStock);
      }
      for (const inv of inventoryItems) {
        const currentStock = branchStockByInv.get(inv._id.toString()) ?? 0;
        inventoryMap.set(inv._id.toString(), { name: inv.name, currentStock });
      }
    } else {
      for (const inv of inventoryItems) {
        inventoryMap.set(inv._id.toString(), inv);
      }
    }

    // Load branch overrides if a branch is selected
    let overrideMap = new Map();
    if (branchId) {
      const overrides = await BranchMenuItem.find({ branch: branchId }).lean();
      for (const o of overrides) {
        overrideMap.set(o.menuItem.toString(), o);
      }
    }

    // Map items with inventory sufficiency info + branch overrides
    const mappedItems = items.map((item) => {
      const base = mapMenuItem(item, { invUnitMap });
      const { sufficient, insufficientItems } = checkInventorySufficiency(item, inventoryMap);
      const result = {
        ...base,
        inventorySufficient: sufficient,
        insufficientIngredients: insufficientItems,
      };

      // Merge branch overrides when viewing a specific branch
      if (branchId) {
        const override = overrideMap.get(item._id.toString());
        
        // Calculate branch availability:
        // 1. If item is NOT available at all branches, start with false
        // 2. Override takes precedence if it exists
        let branchAvailable = item.availableAtAllBranches !== false ? item.available : false;
        if (override) {
          branchAvailable = override.available;
        }
        
        result.branchAvailable = branchAvailable;
        result.branchPriceOverride = override?.priceOverride ?? null;
        // effective price for this branch
        result.effectivePrice = override?.priceOverride != null ? override.priceOverride : item.price;
      }

      return result;
    });

    // Filter out items not available at this branch
    let filteredItems = mappedItems;
    if (branchId) {
      // When viewing a specific branch, only show items that are available at that branch
      // This means:
      // 1. Items with availableAtAllBranches=true (unless overridden to false)
      // 2. Items with availableAtAllBranches=false AND a branch override with available=true
      filteredItems = mappedItems.filter(item => {
        // If branchAvailable is false, don't show it
        return item.branchAvailable !== false;
      });
    }

    res.json({
      categories: categories.map(mapCategory),
      items: filteredItems,
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/orders
// @desc    List recent orders for this restaurant (optionally scoped by x-branch-id)
// @access  Restaurant Admin / Staff / Super Admin
router.get('/orders', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);

    const query = { restaurant: restaurantId };
    if (branchId) {
      query.branch = branchId;
    }
    if (req.query.status) {
      query.status = req.query.status;
    }
    if (req.query.source) {
      query.source = req.query.source;
    }

    const orders = await Order.find(query)
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .limit(200);

    res.json(orders.map(mapOrder));
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/orders/:id
// @desc    Get single order by _id or orderNumber (for edit)
// @access  Restaurant Admin / Staff / Super Admin
router.get('/orders/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const restaurantId = getRestaurantIdForRequest(req);

    let order = null;
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      order = await Order.findOne({ _id: id, restaurant: restaurantId }).populate('createdBy', 'name');
    }
    if (!order) {
      order = await Order.findOne({ orderNumber: id, restaurant: restaurantId }).populate('createdBy', 'name');
    }
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    res.json(mapOrder(order));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/orders/:id
// @desc    Update order (items, discount, customer, orderType, tableName) – for edit from POS
// @access  Restaurant Admin / Admin / Manager / Cashier (order_taker view-only on orders)
router.put('/orders/:id', async (req, res, next) => {
  try {
    if (req.user.role === 'order_taker') {
      return res.status(403).json({ message: 'Order takers can only view orders' });
    }
    const { id } = req.params;
    const { items, discountAmount, customerName, customerPhone, deliveryAddress, orderType, tableName } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);

    let order = await Order.findOne({ _id: id, restaurant: restaurantId });
    if (!order) {
      order = await Order.findOne({ orderNumber: id, restaurant: restaurantId });
    }
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    if (order.status === 'CANCELLED') {
      return res.status(400).json({ message: 'Cannot update cancelled order' });
    }

    if (Array.isArray(items) && items.length > 0) {
      const menuItemIds = items.map((i) => i.menuItemId).filter(Boolean);
      const dbMenuItems = await MenuItem.find({
        _id: { $in: menuItemIds },
        restaurant: restaurantId,
      }).lean();
      const menuMap = new Map(dbMenuItems.map((m) => [m._id.toString(), m]));

      const orderItems = [];
      let subtotal = 0;
      for (const i of items) {
        const menu = i.menuItemId ? menuMap.get(i.menuItemId) : null;
        const qty = Math.max(1, Number(i.quantity) || 1);
        const unitPrice = menu ? menu.price : (Number(i.unitPrice) || 0);
        const lineTotal = unitPrice * qty;
        subtotal += lineTotal;
        orderItems.push({
          menuItem: i.menuItemId || null,
          name: menu ? menu.name : (i.name || 'Item'),
          quantity: qty,
          unitPrice,
          lineTotal,
        });
      }
      const discount = Math.max(0, Number(discountAmount) ?? order.discountAmount ?? 0);
      const total = Math.max(0, subtotal - discount);

      order.items = orderItems;
      order.subtotal = subtotal;
      order.discountAmount = discount;
      order.total = total;
    }

    if (discountAmount !== undefined && !(Array.isArray(items) && items.length > 0)) {
      order.discountAmount = Math.max(0, Number(discountAmount) || 0);
      order.total = Math.max(0, (order.subtotal || 0) - order.discountAmount);
    }
    if (customerName !== undefined) order.customerName = String(customerName || '').trim();
    if (customerPhone !== undefined) order.customerPhone = String(customerPhone || '').trim();
    if (deliveryAddress !== undefined) order.deliveryAddress = String(deliveryAddress || '').trim();
    if (orderType !== undefined && ['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(orderType)) order.orderType = orderType;
    if (tableName !== undefined) order.tableName = String(tableName || '').trim();

    await order.save();
    const updated = await Order.findById(order._id).populate('createdBy', 'name');
    res.json(mapOrder(updated));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/orders/:id/status
// @desc    Update order status (find by restaurant; branch optional for legacy orders)
// @access  Restaurant Admin / Admin / Manager / Cashier (order_taker view-only)
router.put('/orders/:id/status', async (req, res, next) => {
  try {
    if (req.user.role === 'order_taker') {
      return res.status(403).json({ message: 'Order takers can only view orders' });
    }
    const { id } = req.params;
    const { status } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);

    if (!['UNPROCESSED', 'PENDING', 'READY', 'COMPLETED', 'CANCELLED'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    // Try finding by _id first, then by orderNumber
    let order;
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      order = await Order.findOne({ _id: id, restaurant: restaurantId }).populate('createdBy', 'name');
    }
    if (!order) {
      order = await Order.findOne({ orderNumber: id, restaurant: restaurantId }).populate('createdBy', 'name');
    }
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    order.status = status;
    await order.save();

    // When order is completed or cancelled, free the table (set isAvailable = true)
    if ((status === 'COMPLETED' || status === 'CANCELLED') && order.tableName && order.tableName.trim()) {
      await Table.findOneAndUpdate(
        { restaurant: order.restaurant, branch: order.branch || null, name: order.tableName.trim() },
        { $set: { isAvailable: true } }
      );
    }

    res.json(mapOrder(order));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/orders/:id/payment
// @desc    Record payment (cashier): set paymentMethod, for CASH record amountReceived and change returned; set status to COMPLETED
// @access  Restaurant Admin / Admin / Manager / Cashier (order_taker cannot record payment)
router.put('/orders/:id/payment', async (req, res, next) => {
  try {
    if (req.user.role === 'order_taker') {
      return res.status(403).json({ message: 'Order takers cannot record payment' });
    }
    const { id } = req.params;
    const { paymentMethod, amountReceived, amountReturned } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);

    if (!['CASH', 'CARD'].includes(paymentMethod)) {
      return res.status(400).json({ message: 'Invalid paymentMethod; use CASH or CARD' });
    }

    let order;
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      order = await Order.findOne({ _id: id, restaurant: restaurantId }).populate('createdBy', 'name');
    }
    if (!order) {
      order = await Order.findOne({ orderNumber: id, restaurant: restaurantId }).populate('createdBy', 'name');
    }
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.status === 'CANCELLED') {
      return res.status(400).json({ message: 'Cannot record payment for cancelled order' });
    }

    const billTotal = order.total;
    let received = amountReceived != null ? Number(amountReceived) : null;
    let returned = amountReturned != null ? Number(amountReturned) : null;

    if (paymentMethod === 'CASH') {
      if (received == null || isNaN(received) || received < 0) {
        return res.status(400).json({ message: 'For cash payment, amountReceived is required and must be >= 0' });
      }
      if (received < billTotal) {
        return res.status(400).json({ message: `Amount received (${received}) is less than bill total (${billTotal})` });
      }
      returned = returned != null && !isNaN(returned) ? returned : (received - billTotal);
    } else {
      received = null;
      returned = null;
    }

    const wasAlreadyCompleted = order.status === 'COMPLETED';
    order.paymentMethod = paymentMethod;
    order.paymentAmountReceived = received;
    order.paymentAmountReturned = returned;
    if (!wasAlreadyCompleted) {
      order.status = 'COMPLETED';
    }
    await order.save();

    if (!wasAlreadyCompleted && order.tableName && order.tableName.trim()) {
      await Table.findOneAndUpdate(
        { restaurant: order.restaurant, branch: order.branch || null, name: order.tableName.trim() },
        { $set: { isAvailable: true } }
      );
    }

    res.json(mapOrder(order));
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/admin/orders/:id
// @desc    Delete an order (find by _id or orderNumber; restaurant-scoped)
// @access  Restaurant Admin / Admin / Manager / Cashier (order_taker cannot delete)
router.delete('/orders/:id', async (req, res, next) => {
  try {
    if (req.user.role === 'order_taker') {
      return res.status(403).json({ message: 'Order takers can only view orders' });
    }
    const { id } = req.params;
    const restaurantId = getRestaurantIdForRequest(req);

    let order = null;
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      order = await Order.findOne({ _id: id, restaurant: restaurantId });
    }
    if (!order) {
      order = await Order.findOne({ orderNumber: id, restaurant: restaurantId });
    }
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    await Order.deleteOne({ _id: order._id });
    res.json({ message: 'Order deleted', id: order.orderNumber || order._id.toString() });
  } catch (error) {
    next(error);
  }
});

// CATEGORY ROUTES

// @route   POST /api/admin/categories
// @desc    Create a new category (branch from x-branch-id header or body.branchId)
// @access  Restaurant Admin / Super Admin
router.post('/categories', async (req, res, next) => {
  try {
    const { name, description, branchId: bodyBranchId } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);
    const headerBranchId = getBranchIdForRequest(req);
    // Prefer body.branchId over header so the branch user is creating in wins (avoids header/localStorage being stale)
    let branchId = null;
    if (bodyBranchId && bodyBranchId !== 'all') {
      const branchDoc = await Branch.findOne({ _id: bodyBranchId, restaurant: restaurantId });
      if (branchDoc) branchId = branchDoc._id;
      console.log('[CREATE CATEGORY] body branch lookup:', bodyBranchId, 'found:', !!branchDoc, 'restaurantId:', restaurantId?.toString?.());
    }
    if (branchId == null) branchId = headerBranchId || null;

    console.log('[CREATE CATEGORY] headerBranchId:', headerBranchId?.toString?.());
    console.log('[CREATE CATEGORY] bodyBranchId:', bodyBranchId);
    console.log('[CREATE CATEGORY] resolved branchId for create/duplicate check:', branchId?.toString?.());
    console.log('[CREATE CATEGORY] restaurantId:', restaurantId?.toString?.());

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Category name is required' });
    }
    if (!branchId) {
      return res.status(400).json({ message: 'Please select a specific branch before creating a category.' });
    }

    const escapedName = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const duplicateQuery = { restaurant: restaurantId, branch: branchId, name: { $regex: new RegExp(`^${escapedName}$`, 'i') } };
    console.log('[CREATE CATEGORY] duplicate check query:', { restaurant: restaurantId?.toString?.(), branch: branchId?.toString?.(), name: name?.trim?.() });
    const existing = await Category.findOne(duplicateQuery);
    console.log('[CREATE CATEGORY] existing (duplicate) found?', existing ? { id: existing._id?.toString?.(), branch: existing.branch?.toString?.(), name: existing.name } : null);
    if (existing) {
      return res.status(400).json({ message: 'A category with this name already exists in this branch.' });
    }

    const category = await Category.create({
      restaurant: restaurantId,
      branch: branchId,
      name: name.trim(),
      description: description || '',
    });

    res.status(201).json(mapCategory(category));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'A category with this name already exists in this branch.' });
    }
    next(error);
  }
});

// @route   PUT /api/admin/categories/:id
// @desc    Update a category
// @access  Restaurant Admin / Super Admin
router.put('/categories/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, isActive } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);

    const category = await Category.findOne({ _id: id, restaurant: restaurantId });
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    // Check for duplicate name within the same branch (case-insensitive, same as create)
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (trimmedName !== category.name) {
        const branchForCheck = category.branch || branchId || null;
        const escapedName = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const duplicate = await Category.findOne({
          restaurant: restaurantId,
          branch: branchForCheck,
          name: { $regex: new RegExp(`^${escapedName}$`, 'i') },
          _id: { $ne: category._id },
        });
        if (duplicate) {
          return res.status(400).json({ message: 'A category with this name already exists in this branch.' });
        }
        category.name = trimmedName;
      }
    }

    if (description !== undefined) category.description = description;
    if (typeof isActive === 'boolean') category.isActive = isActive;

    await category.save();

    res.json(mapCategory(category));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'A category with this name already exists in this branch.' });
    }
    next(error);
  }
});

// @route   DELETE /api/admin/categories/:id
// @desc    Delete a category and its items
// @access  Restaurant Admin / Super Admin
router.delete('/categories/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const restaurantId = getRestaurantIdForRequest(req);

    const category = await Category.findOne({ _id: id, restaurant: restaurantId });
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    await Promise.all([
      Category.deleteOne({ _id: id, restaurant: restaurantId }),
      MenuItem.deleteMany({ category: id, restaurant: restaurantId }),
    ]);

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// MENU ITEM ROUTES

const VALID_OBJECTID = /^[a-f0-9]{24}$/i;

const normalizeInventoryConsumptions = async (restaurantId, rawConsumptions) => {
  if (!Array.isArray(rawConsumptions) || rawConsumptions.length === 0) {
    return [];
  }

  // Normalize and merge duplicate inventoryItemIds (sum quantities); only accept valid ObjectId strings
  const merged = new Map();
  for (const c of rawConsumptions) {
    const id = c.inventoryItemId != null ? String(c.inventoryItemId).trim() : '';
    if (!id || !VALID_OBJECTID.test(id)) continue;
    const qty = Number(c.quantity) || 0;
    if (qty <= 0) continue;
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  const uniqueIds = [...merged.keys()];
  if (uniqueIds.length === 0) return [];

  const inventoryItems = await InventoryItem.find({
    _id: { $in: uniqueIds },
    restaurant: restaurantId,
  });

  const foundIds = new Set(inventoryItems.map((i) => i._id.toString()));
  const missing = uniqueIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new Error('One or more inventory items are invalid for this restaurant');
  }

  return uniqueIds
    .map((id) => ({
      inventoryItem: id,
      quantity: parseFloat(Number(merged.get(id)).toFixed(6)),
    }))
    .filter((c) => c.quantity > 0);
};

// @route   POST /api/admin/items
// @desc    Create a new menu item
// @access  Restaurant Admin / Super Admin
router.post('/items', async (req, res, next) => {
  try {
    const { name, description, price, categoryId, showOnWebsite, imageUrl, dietaryType, inventoryConsumptions, branchId: bodyBranchId } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);
    const headerBranchId = getBranchIdForRequest(req);
    // Prefer body.branchId over header so the branch user is creating in wins
    let branchId = null;
    if (bodyBranchId && bodyBranchId !== 'all') {
      const branchDoc = await Branch.findOne({ _id: bodyBranchId, restaurant: restaurantId });
      if (branchDoc) branchId = branchDoc._id;
      console.log('[CREATE MENU ITEM] body branch lookup:', bodyBranchId, 'found:', !!branchDoc, 'restaurantId:', restaurantId?.toString?.());
    }
    if (branchId == null) branchId = headerBranchId || null;

    console.log('[CREATE MENU ITEM] headerBranchId:', headerBranchId?.toString?.());
    console.log('[CREATE MENU ITEM] bodyBranchId:', bodyBranchId);
    console.log('[CREATE MENU ITEM] resolved branchId for create/duplicate check:', branchId?.toString?.());
    console.log('[CREATE MENU ITEM] restaurantId:', restaurantId?.toString?.());

    if (!name || !name.trim() || price === undefined || !categoryId) {
      return res.status(400).json({ message: 'Name, price and categoryId are required' });
    }
    if (!branchId) {
      return res.status(400).json({ message: 'Please select a specific branch before adding a menu item.' });
    }

    const categoryQuery = { _id: categoryId, restaurant: restaurantId };
    if (branchId) categoryQuery.branch = branchId;
    const category = await Category.findOne(categoryQuery);
    if (!category) {
      return res.status(400).json({ message: 'Invalid categoryId' });
    }

    const escapedItemName = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const itemDuplicateQuery = { restaurant: restaurantId, branch: branchId, name: { $regex: new RegExp(`^${escapedItemName}$`, 'i') } };
    console.log('[CREATE MENU ITEM] duplicate check query:', { restaurant: restaurantId?.toString?.(), branch: branchId?.toString?.(), name: name?.trim?.() });
    const existingItem = await MenuItem.findOne(itemDuplicateQuery);
    console.log('[CREATE MENU ITEM] existing (duplicate) found?', existingItem ? { id: existingItem._id?.toString?.(), branch: existingItem.branch?.toString?.(), name: existingItem.name } : null);
    if (existingItem) {
      return res.status(400).json({ message: 'A menu item with this name already exists in this branch.' });
    }

    let normalizedConsumptions = [];
    if (inventoryConsumptions) {
      try {
        normalizedConsumptions = await normalizeInventoryConsumptions(restaurantId, inventoryConsumptions);
      } catch (err) {
        return res.status(400).json({ message: err.message });
      }
    }

    const { isTrending, isMustTry } = req.body;
    const item = await MenuItem.create({
      restaurant: restaurantId,
      branch: branchId,
      name: name.trim(),
      description: description || '',
      price,
      category: categoryId,
      showOnWebsite: showOnWebsite !== undefined ? !!showOnWebsite : true,
      imageUrl,
      dietaryType: ['veg', 'non_veg', 'egg'].includes(dietaryType) ? dietaryType : 'non_veg',
      isTrending: typeof isTrending === 'boolean' ? isTrending : false,
      isMustTry: typeof isMustTry === 'boolean' ? isMustTry : false,
      inventoryConsumptions: normalizedConsumptions,
    });

    res.status(201).json(mapMenuItem(item));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'A menu item with this name already exists in this branch.' });
    }
    next(error);
  }
});

// @route   PUT /api/admin/items/:id
// @desc    Update a menu item (including availability and website visibility)
// @access  Restaurant Admin / Super Admin
router.put('/items/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, price, categoryId, available, showOnWebsite, imageUrl, isFeatured, isBestSeller, isTrending, isMustTry, dietaryType, inventoryConsumptions } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);

    const item = await MenuItem.findOne({ _id: id, restaurant: restaurantId });
    if (!item) {
      return res.status(404).json({ message: 'Menu item not found' });
    }

    if (name !== undefined && name.trim() !== item.name) {
      const duplicate = await MenuItem.findOne({
        restaurant: restaurantId,
        branch: item.branch || null,
        name: name.trim(),
        _id: { $ne: id },
      });
      if (duplicate) {
        return res.status(400).json({ message: 'A menu item with this name already exists in this branch.' });
      }
      item.name = name.trim();
    } else if (name !== undefined) {
      item.name = name.trim();
    }
    if (description !== undefined) item.description = description;
    if (price !== undefined) item.price = price;
    if (typeof available === 'boolean') item.available = available;
    if (typeof showOnWebsite === 'boolean') item.showOnWebsite = showOnWebsite;
    if (imageUrl !== undefined) item.imageUrl = imageUrl;
    if (typeof isFeatured === 'boolean') item.isFeatured = isFeatured;
    if (typeof isBestSeller === 'boolean') item.isBestSeller = isBestSeller;
    if (typeof isTrending === 'boolean') item.isTrending = isTrending;
    if (typeof isMustTry === 'boolean') item.isMustTry = isMustTry;
    if (dietaryType !== undefined && ['veg', 'non_veg', 'egg'].includes(dietaryType)) item.dietaryType = dietaryType;

    if (categoryId) {
      const category = await Category.findOne({ _id: categoryId, restaurant: restaurantId });
      if (!category) {
        return res.status(400).json({ message: 'Invalid categoryId' });
      }
      item.category = categoryId;
    }

    if (inventoryConsumptions !== undefined) {
      try {
        item.inventoryConsumptions = await normalizeInventoryConsumptions(restaurantId, inventoryConsumptions);
      } catch (err) {
        return res.status(400).json({ message: err.message });
      }
    }

    await item.save();

    res.json(mapMenuItem(item));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'A menu item with this name already exists in this branch.' });
    }
    next(error);
  }
});

// @route   DELETE /api/admin/items/:id
// @desc    Delete a menu item
// @access  Restaurant Admin / Super Admin
router.delete('/items/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const restaurantId = getRestaurantIdForRequest(req);

    const item = await MenuItem.findOne({ _id: id, restaurant: restaurantId });
    if (!item) {
      return res.status(404).json({ message: 'Menu item not found' });
    }

    await MenuItem.deleteOne({ _id: id, restaurant: restaurantId });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// BRANCH MENU OVERRIDE ROUTES

// @route   PUT /api/admin/branch-menu/:menuItemId
// @desc    Set or update branch override for a menu item (requires x-branch-id)
// @access  Restaurant Admin / Super Admin / Branch Manager
router.put('/branch-menu/:menuItemId', async (req, res, next) => {
  try {
    const branchId = getBranchIdForRequest(req);
    if (!branchId) {
      return res.status(400).json({ message: 'x-branch-id header is required for branch menu overrides' });
    }
    const restaurantId = getRestaurantIdForRequest(req);
    const { menuItemId } = req.params;
    const { available, priceOverride } = req.body;

    // Validate menu item belongs to this restaurant
    const menuItem = await MenuItem.findOne({ _id: menuItemId, restaurant: restaurantId });
    if (!menuItem) {
      return res.status(404).json({ message: 'Menu item not found' });
    }

    const update = {};
    if (typeof available === 'boolean') update.available = available;
    if (priceOverride !== undefined) update.priceOverride = priceOverride;

    const override = await BranchMenuItem.findOneAndUpdate(
      { branch: branchId, menuItem: menuItemId },
      { $set: update, $setOnInsert: { branch: branchId, menuItem: menuItemId } },
      { upsert: true, new: true, runValidators: true }
    );

    res.json({
      menuItemId: override.menuItem.toString(),
      branchId: override.branch.toString(),
      available: override.available,
      priceOverride: override.priceOverride,
    });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/admin/branch-menu/:menuItemId
// @desc    Remove branch override for a menu item (revert to base)
// @access  Restaurant Admin / Super Admin / Branch Manager
router.delete('/branch-menu/:menuItemId', async (req, res, next) => {
  try {
    const branchId = getBranchIdForRequest(req);
    if (!branchId) {
      return res.status(400).json({ message: 'x-branch-id header is required' });
    }
    await BranchMenuItem.findOneAndDelete({ branch: branchId, menuItem: req.params.menuItemId });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/branch-menu
// @desc    List all branch overrides for current branch (requires x-branch-id)
// @access  Restaurant Admin / Staff
router.get('/branch-menu', async (req, res, next) => {
  try {
    const branchId = getBranchIdForRequest(req);
    if (!branchId) {
      return res.status(400).json({ message: 'x-branch-id header is required' });
    }
    const overrides = await BranchMenuItem.find({ branch: branchId }).populate('menuItem', 'name price').lean();
    res.json(
      overrides.map((o) => ({
        menuItemId: o.menuItem?._id?.toString() || o.menuItem?.toString(),
        menuItemName: o.menuItem?.name || '',
        basePrice: o.menuItem?.price ?? null,
        available: o.available,
        priceOverride: o.priceOverride,
      }))
    );
  } catch (error) {
    next(error);
  }
});

// BRANCH COPY (bulk copy categories/items from another branch)
// Admin can copy from any branch; manager only from assigned branches.

function canAccessBranchAsSource(req, branchId) {
  if (!branchId) return false;
  const role = req.user.role;
  if (role === 'super_admin' || role === 'restaurant_admin' || role === 'admin') return true;
  const allowed = req.user.allowedBranchIds || [];
  return allowed.some((id) => String(id) === String(branchId));
}

// @route   GET /api/admin/branch-copy/menu
// @desc    List categories and items from a source branch (for copy UI). Admin: any branch; manager: assigned only.
// @access  Restaurant Admin / Admin / Manager
router.get('/branch-copy/menu', async (req, res, next) => {
  try {
    const sourceBranchId = req.query.sourceBranchId;
    if (!sourceBranchId) {
      return res.status(400).json({ message: 'sourceBranchId is required' });
    }
    const restaurantId = getRestaurantIdForRequest(req);
    const branchDoc = await Branch.findOne({ _id: sourceBranchId, restaurant: restaurantId });
    if (!branchDoc) {
      return res.status(404).json({ message: 'Source branch not found' });
    }
    if (!canAccessBranchAsSource(req, sourceBranchId)) {
      return res.status(403).json({ message: 'You can only copy from branches you have access to' });
    }
    const categories = await Category.find({ restaurant: restaurantId, branch: sourceBranchId }).sort({ createdAt: 1 }).lean();
    const items = await MenuItem.find({ restaurant: restaurantId, branch: sourceBranchId }).populate('category', 'name').lean();
    res.json({
      categories: categories.map((c) => ({ id: c._id.toString(), name: c.name, description: c.description || '' })),
      items: items.map((i) => ({
        id: i._id.toString(),
        name: i.name,
        price: i.price,
        categoryId: (i.category && i.category._id) ? i.category._id.toString() : i.category?.toString?.() || '',
        categoryName: i.category?.name || '',
        description: i.description || '',
        imageUrl: i.imageUrl || '',
        dietaryType: i.dietaryType || 'non_veg',
        showOnWebsite: i.showOnWebsite !== false,
        inventoryConsumptions: (i.inventoryConsumptions || []).map((c) => ({
          inventoryItemId: c.inventoryItem?.toString?.(),
          quantity: c.quantity,
        })),
      })),
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/branch-copy/menu
// @desc    Copy selected categories and items from source branch to current branch (x-branch-id).
// @access  Restaurant Admin / Admin / Manager
router.post('/branch-copy/menu', async (req, res, next) => {
  try {
    const targetBranchId = getBranchIdForRequest(req);
    if (!targetBranchId) {
      return res.status(400).json({ message: 'Select the current branch (x-branch-id) as copy destination' });
    }
    const { sourceBranchId, categoryIds = [], itemIds = [] } = req.body;
    if (!sourceBranchId) {
      return res.status(400).json({ message: 'sourceBranchId is required' });
    }
    const restaurantId = getRestaurantIdForRequest(req);
    const branchDoc = await Branch.findOne({ _id: sourceBranchId, restaurant: restaurantId });
    if (!branchDoc) {
      return res.status(404).json({ message: 'Source branch not found' });
    }
    const targetBranchDoc = await Branch.findOne({ _id: targetBranchId, restaurant: restaurantId });
    if (!targetBranchDoc) {
      return res.status(404).json({ message: 'Target branch not found' });
    }
    if (!canAccessBranchAsSource(req, sourceBranchId)) {
      return res.status(403).json({ message: 'You can only copy from branches you have access to' });
    }
    const allowedTarget = req.user.role === 'super_admin' || req.user.role === 'restaurant_admin' || req.user.role === 'admin' ||
      (req.user.allowedBranchIds || []).some((id) => String(id) === String(targetBranchId));
    if (!allowedTarget) {
      return res.status(403).json({ message: 'You do not have access to the target branch' });
    }

    const categoryIdList = Array.isArray(categoryIds) ? categoryIds : [];
    const itemIdList = Array.isArray(itemIds) ? itemIds : [];
    if (categoryIdList.length === 0 && itemIdList.length === 0) {
      return res.status(400).json({ message: 'Select at least one category or item to copy' });
    }

    const sourceCategories = await Category.find({ _id: { $in: categoryIdList }, restaurant: restaurantId, branch: sourceBranchId }).lean();
    const sourceItems = await MenuItem.find({ _id: { $in: itemIdList }, restaurant: restaurantId, branch: sourceBranchId }).lean();
    const categoryMap = new Map();
    for (const cat of sourceCategories) {
      const existing = await Category.findOne({ restaurant: restaurantId, branch: targetBranchId, name: cat.name.trim() });
      if (existing) {
        categoryMap.set(cat._id.toString(), existing._id);
      } else {
        const created = await Category.create({
          restaurant: restaurantId,
          branch: targetBranchId,
          name: cat.name,
          description: cat.description || '',
        });
        categoryMap.set(cat._id.toString(), created._id);
      }
    }
    const sourceInvIds = new Set();
    sourceItems.forEach((item) => {
      (item.inventoryConsumptions || []).forEach((c) => {
        if (c.inventoryItem) sourceInvIds.add(c.inventoryItem.toString());
      });
    });
    const sourceInvItems = await InventoryItem.find({ _id: { $in: [...sourceInvIds] }, restaurant: restaurantId }).lean();
    // Ensure branch-level inventory rows exist for the target branch with zero stock
    if (sourceInvItems.length > 0) {
      const existingBranchInv = await BranchInventory.find({
        branch: targetBranchId,
        inventoryItem: { $in: [...sourceInvIds] },
      }).lean();
      const existingInvSet = new Set(existingBranchInv.map((r) => r.inventoryItem.toString()));
      for (const inv of sourceInvItems) {
        if (!existingInvSet.has(inv._id.toString())) {
          await BranchInventory.create({
            branch: targetBranchId,
            inventoryItem: inv._id,
            currentStock: 0,
            lowStockThreshold: 0,
            costPrice: inv.costPrice || 0,
          });
        }
      }
    }

    let copiedItems = 0;
    for (const item of sourceItems) {
      const sourceCatId = (item.category && item.category.toString) ? item.category.toString() : (item.category || '').toString();
      let targetCategoryId = categoryMap.get(sourceCatId);
      if (!targetCategoryId && sourceCatId) {
        const sourceCat = await Category.findById(sourceCatId).lean();
        if (sourceCat) {
          const existing = await Category.findOne({ restaurant: restaurantId, branch: targetBranchId, name: sourceCat.name });
          if (existing) targetCategoryId = existing._id;
          else {
            const created = await Category.create({
              restaurant: restaurantId,
              branch: targetBranchId,
              name: sourceCat.name,
              description: sourceCat.description || '',
            });
            targetCategoryId = created._id;
            categoryMap.set(sourceCatId, targetCategoryId);
          }
        }
      }
      if (!targetCategoryId) continue;
      const consumptions = [];
      for (const c of item.inventoryConsumptions || []) {
        const invId = c.inventoryItem?.toString?.();
        if (invId) {
          consumptions.push({ inventoryItem: invId, quantity: c.quantity || 0 });
        }
      }
      await MenuItem.create({
        restaurant: restaurantId,
        branch: targetBranchId,
        name: item.name,
        description: item.description || '',
        price: item.price,
        category: targetCategoryId,
        available: item.available !== false,
        showOnWebsite: item.showOnWebsite !== false,
        imageUrl: item.imageUrl || null,
        isFeatured: item.isFeatured || false,
        isBestSeller: item.isBestSeller || false,
        dietaryType: item.dietaryType || 'non_veg',
        inventoryConsumptions: consumptions,
      });
      copiedItems += 1;
    }

    res.json({
      message: 'Copy completed',
      copiedCategories: categoryMap.size,
      copiedItems,
    });
  } catch (error) {
    next(error);
  }
});

// INVENTORY ROUTES
// When x-branch-id is set, inventory reads/writes go through BranchInventory.
// When no branch (owner global view or no branches yet), falls back to InventoryItem.

// @route   GET /api/admin/inventory
// @desc    List inventory items. With x-branch-id: per-branch stock. Without: restaurant-level.
// @access  Restaurant Admin / Super Admin
router.get('/inventory', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);

    // Always load restaurant-level items (definitions)
    const items = await InventoryItem.find({ restaurant: restaurantId }).sort({ name: 1 });

    if (branchId) {
      // Load branch stock rows
      const branchRows = await BranchInventory.find({ branch: branchId }).lean();
      const branchMap = new Map();
      for (const row of branchRows) {
        branchMap.set(row.inventoryItem.toString(), row);
      }

      res.json(
        items.map((i) => {
          const br = branchMap.get(i._id.toString());
          return {
            id: i._id.toString(),
            name: i.name,
            unit: i.unit,
            currentStock: br ? br.currentStock : 0,
            lowStockThreshold: br ? br.lowStockThreshold : i.lowStockThreshold,
            costPrice: br ? br.costPrice : i.costPrice || 0,
            hasBranchRecord: !!br,
          };
        })
      );
    } else {
      // Fallback: restaurant-level stock (legacy / owner overview)
    res.json(
      items.map((i) => ({
        id: i._id.toString(),
        name: i.name,
        unit: i.unit,
        currentStock: i.currentStock,
        lowStockThreshold: i.lowStockThreshold,
          costPrice: i.costPrice || 0,
      }))
    );
    }
  } catch (error) {
    next(error);
  }
});

// BRANCH INVENTORY COPY ROUTES
// @route   GET /api/admin/branch-copy/inventory
// @desc    List inventory items that have stock rows in a source branch (for copy UI)
// @access  Restaurant Admin / Admin / Manager
router.get('/branch-copy/inventory', async (req, res, next) => {
  try {
    const sourceBranchId = req.query.sourceBranchId;
    if (!sourceBranchId) {
      return res.status(400).json({ message: 'sourceBranchId is required' });
    }
    const restaurantId = getRestaurantIdForRequest(req);
    const branchDoc = await Branch.findOne({ _id: sourceBranchId, restaurant: restaurantId });
    if (!branchDoc) {
      return res.status(404).json({ message: 'Source branch not found' });
    }
    if (!canAccessBranchAsSource(req, sourceBranchId)) {
      return res.status(403).json({ message: 'You can only copy from branches you have access to' });
    }
    const branchRows = await BranchInventory.find({ branch: sourceBranchId }).populate('inventoryItem').lean();
    const items = branchRows
      .filter((row) => row.inventoryItem)
      .map((row) => ({
        id: row.inventoryItem._id.toString(),
        name: row.inventoryItem.name,
        unit: row.inventoryItem.unit,
        costPrice: row.inventoryItem.costPrice || 0,
      }));
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/branch-copy/inventory
// @desc    Copy inventory items from source branch to current branch: create BranchInventory rows with stock 0
// @access  Restaurant Admin / Admin / Manager
router.post('/branch-copy/inventory', async (req, res, next) => {
  try {
    const targetBranchId = getBranchIdForRequest(req);
    if (!targetBranchId) {
      return res.status(400).json({ message: 'Select a target branch (x-branch-id) to copy inventory into' });
    }
    const { sourceBranchId, itemIds = [] } = req.body;
    if (!sourceBranchId) {
      return res.status(400).json({ message: 'sourceBranchId is required' });
    }
    const restaurantId = getRestaurantIdForRequest(req);
    const branchDoc = await Branch.findOne({ _id: sourceBranchId, restaurant: restaurantId });
    if (!branchDoc) {
      return res.status(404).json({ message: 'Source branch not found' });
    }
    if (!canAccessBranchAsSource(req, sourceBranchId)) {
      return res.status(403).json({ message: 'You can only copy from branches you have access to' });
    }
    const allowedTarget = req.user.role === 'super_admin' || req.user.role === 'restaurant_admin' || req.user.role === 'admin' ||
      (req.user.allowedBranchIds || []).some((id) => String(id) === String(targetBranchId));
    if (!allowedTarget) {
      return res.status(403).json({ message: 'You do not have access to the target branch' });
    }
    const itemIdList = Array.isArray(itemIds) ? itemIds : [];
    if (itemIdList.length === 0) {
      return res.status(400).json({ message: 'Select at least one inventory item to copy' });
    }
    const invItems = await InventoryItem.find({ _id: { $in: itemIdList }, restaurant: restaurantId }).lean();
    const existing = await BranchInventory.find({
      branch: targetBranchId,
      inventoryItem: { $in: itemIdList },
    }).lean();
    const existingSet = new Set(existing.map((r) => r.inventoryItem.toString()));
    let createdCount = 0;
    for (const inv of invItems) {
      if (existingSet.has(inv._id.toString())) continue;
      await BranchInventory.create({
        branch: targetBranchId,
        inventoryItem: inv._id,
        currentStock: 0,
        lowStockThreshold: 0,
        costPrice: inv.costPrice || 0,
      });
      createdCount += 1;
    }
    res.json({ message: 'Inventory copied', created: createdCount });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/inventory
// @desc    Create an inventory item (restaurant-level definition). If x-branch-id is set, also create BranchInventory row.
// @access  Restaurant Admin / Super Admin
router.post('/inventory', async (req, res, next) => {
  try {
    const { name, unit, initialStock, lowStockThreshold, costPrice, branchId: bodyBranchId } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);
    const headerBranchId = getBranchIdForRequest(req);
    // Prefer body.branchId over header so the branch user is creating in wins
    let branchId = null;
    if (bodyBranchId && bodyBranchId !== 'all') {
      const branchDoc = await Branch.findOne({ _id: bodyBranchId, restaurant: restaurantId });
      if (branchDoc) branchId = branchDoc._id;
      console.log('[CREATE INVENTORY] body branch lookup:', bodyBranchId, 'found:', !!branchDoc, 'restaurantId:', restaurantId?.toString?.());
    }
    if (branchId == null) branchId = headerBranchId || null;

    console.log('[CREATE INVENTORY] headerBranchId:', headerBranchId?.toString?.());
    console.log('[CREATE INVENTORY] bodyBranchId:', bodyBranchId);
    console.log('[CREATE INVENTORY] resolved branchId for create/duplicate check:', branchId?.toString?.());
    console.log('[CREATE INVENTORY] restaurantId:', restaurantId?.toString?.());

    if (!name || !unit) {
      return res.status(400).json({ message: 'Name and unit are required' });
    }
    if (!branchId) {
      return res.status(400).json({ message: 'Please select a specific branch before adding inventory.' });
    }

    const escapedInvName = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const invDuplicateQuery = { restaurant: restaurantId, branch: branchId, name: { $regex: new RegExp(`^${escapedInvName}$`, 'i') } };
    console.log('[CREATE INVENTORY] duplicate check query:', { restaurant: restaurantId?.toString?.(), branch: branchId?.toString?.(), name: name?.trim?.() });
    const existing = await InventoryItem.findOne(invDuplicateQuery);
    console.log('[CREATE INVENTORY] existing (duplicate) found?', existing ? { id: existing._id?.toString?.(), branch: existing.branch?.toString?.(), name: existing.name } : null);
    if (existing) {
      return res.status(400).json({ message: 'An inventory item with this name already exists in this branch.' });
    }

    const item = await InventoryItem.create({
      restaurant: restaurantId,
      branch: branchId,
      name: name.trim(),
      unit,
      currentStock: branchId ? 0 : (initialStock ?? 0),
      lowStockThreshold: branchId ? 0 : (lowStockThreshold ?? 0),
      costPrice: branchId ? 0 : (costPrice ?? 0),
    });

    let branchRecord = null;
    if (branchId) {
      branchRecord = await BranchInventory.create({
        branch: branchId,
        inventoryItem: item._id,
      currentStock: initialStock ?? 0,
      lowStockThreshold: lowStockThreshold ?? 0,
        costPrice: costPrice ?? 0,
    });
    }

    res.status(201).json({
      id: item._id.toString(),
      name: item.name,
      unit: item.unit,
      currentStock: branchRecord ? branchRecord.currentStock : item.currentStock,
      lowStockThreshold: branchRecord ? branchRecord.lowStockThreshold : item.lowStockThreshold,
      costPrice: branchRecord ? branchRecord.costPrice : item.costPrice || 0,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'An inventory item with this name already exists in this branch.' });
    }
    next(error);
  }
});

// @route   PUT /api/admin/inventory/:id
// @desc    Update inventory item and/or adjust stock. With x-branch-id: update BranchInventory.
// @access  Restaurant Admin / Super Admin
router.put('/inventory/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, unit, lowStockThreshold, stockAdjustment, costPrice } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);

    const item = await InventoryItem.findOne({ _id: id, restaurant: restaurantId });
    if (!item) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }

    // Update definition (name, unit); duplicate name check is per branch
    if (name !== undefined && name.trim() !== item.name) {
      const branchForDuplicate = item.branch || branchId || null;
      const duplicate = await InventoryItem.findOne({
        restaurant: restaurantId,
        branch: branchForDuplicate,
        name: name.trim(),
        _id: { $ne: item._id },
      });
      if (duplicate) {
        return res.status(400).json({ message: 'An inventory item with this name already exists in this branch.' });
      }
      item.name = name.trim();
    }
    if (unit !== undefined) item.unit = unit;

    if (branchId) {
      // Save any restaurant-level definition changes
      await item.save();

      // Update or create BranchInventory row
      let branchRow = await BranchInventory.findOne({ branch: branchId, inventoryItem: item._id });
      if (!branchRow) {
        branchRow = new BranchInventory({ branch: branchId, inventoryItem: item._id, currentStock: 0, lowStockThreshold: 0, costPrice: 0 });
      }
      if (lowStockThreshold !== undefined) branchRow.lowStockThreshold = lowStockThreshold;
      if (costPrice !== undefined) branchRow.costPrice = costPrice;
      if (stockAdjustment !== undefined) {
        const adj = Number(stockAdjustment) || 0;
        branchRow.currentStock = Math.max(0, branchRow.currentStock + adj);
      }
      await branchRow.save();

      res.json({
        id: item._id.toString(),
        name: item.name,
        unit: item.unit,
        currentStock: branchRow.currentStock,
        lowStockThreshold: branchRow.lowStockThreshold,
        costPrice: branchRow.costPrice || 0,
      });
    } else {
      // No branch: update restaurant-level stock (legacy)
    if (lowStockThreshold !== undefined) item.lowStockThreshold = lowStockThreshold;
      if (costPrice !== undefined) item.costPrice = costPrice;
    if (stockAdjustment !== undefined) {
      const adj = Number(stockAdjustment) || 0;
      item.currentStock = Math.max(0, item.currentStock + adj);
    }
    await item.save();

    res.json({
      id: item._id.toString(),
      name: item.name,
      unit: item.unit,
      currentStock: item.currentStock,
      lowStockThreshold: item.lowStockThreshold,
        costPrice: item.costPrice || 0,
    });
    }
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'An inventory item with this name already exists in this branch.' });
    }
    next(error);
  }
});

// @route   DELETE /api/admin/inventory/:id
// @desc    Delete an inventory item (and all its BranchInventory rows)
// @access  Restaurant Admin / Super Admin
router.delete('/inventory/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const restaurantId = getRestaurantIdForRequest(req);

    const item = await InventoryItem.findOneAndDelete({ _id: id, restaurant: restaurantId });
    if (!item) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }

    // Clean up all branch inventory rows for this item
    await BranchInventory.deleteMany({ inventoryItem: id });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// WEBSITE SETTINGS ROUTES

// @route   GET /api/admin/website
// @desc    Get website settings for current restaurant (optionally branch-specific)
// @access  Restaurant Admin / Super Admin
router.get('/website', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);
    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    const raw = restaurant.website || {};
    const base = typeof raw.toObject === 'function' ? raw.toObject() : { ...raw };
    delete base.openingHours;

    let merged = { ...base };

    // When a branch is selected, apply branch-specific overrides if present
    if (branchId) {
      const branch = await Branch.findOne({ _id: branchId, restaurant: restaurantId }).lean();
      const overrides = (branch && branch.websiteOverrides) || {};
      const overrideKeys = [
        'heroSlides',
        'socialMedia',
        'themeColors',
        'openingHoursText',
        'websiteSections',
        'allowWebsiteOrders',
      ];
      overrideKeys.forEach((key) => {
        if (overrides[key] !== undefined) {
          merged[key] = overrides[key];
        }
      });
    }

    res.json(merged);
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/website
// @desc    Update website branding/content (global + branch-specific parts)
// @access  Restaurant Admin / Super Admin
router.put('/website', async (req, res, next) => {
  try {
    const {
      name,
      logoUrl,
      bannerUrl,
      description,
      tagline,
      contactPhone,
      contactEmail,
      address,
      isPublic,
      heroSlides,
      socialMedia,
      themeColors,
      openingHoursText,
      websiteSections,
      allowWebsiteOrders,
    } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);

    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    if (!restaurant.website) {
      restaurant.website = {};
    }

    // Basic fields (always global across branches)
    if (name !== undefined) restaurant.website.name = name;
    if (logoUrl !== undefined) restaurant.website.logoUrl = logoUrl;
    if (bannerUrl !== undefined) restaurant.website.bannerUrl = bannerUrl;
    if (description !== undefined) restaurant.website.description = description;
    if (tagline !== undefined) restaurant.website.tagline = tagline;
    if (contactPhone !== undefined) restaurant.website.contactPhone = contactPhone;
    if (contactEmail !== undefined) restaurant.website.contactEmail = contactEmail;
    if (address !== undefined) restaurant.website.address = address;
    if (typeof isPublic === 'boolean') restaurant.website.isPublic = isPublic;

    // Branch-aware dynamic fields
    const dynamicKeys = [
      'heroSlides',
      'socialMedia',
      'themeColors',
      'openingHoursText',
      'websiteSections',
      'allowWebsiteOrders',
    ];

    // Helper to assign either globally or into branch overrides
    let branch = null;
    let overrides = null;
    if (branchId) {
      branch = await Branch.findOne({ _id: branchId, restaurant: restaurantId });
      if (!branch) {
        return res.status(404).json({ message: 'Branch not found' });
      }
      if (!branch.websiteOverrides) {
        branch.websiteOverrides = {};
      }
      overrides = branch.websiteOverrides;
    }

    const assignField = (key, value) => {
      if (value === undefined) return;
      if (branchId && overrides) {
        overrides[key] = value;
      } else {
        if (key === 'openingHoursText') {
          restaurant.website.openingHoursText = value;
          restaurant.website.openingHours = {};
        } else {
          restaurant.website[key] = value;
        }
      }
    };

    assignField('heroSlides', heroSlides);
    assignField('socialMedia', socialMedia);
    assignField('themeColors', themeColors);
    assignField('openingHoursText', openingHoursText);
    assignField('websiteSections', websiteSections);
    assignField('allowWebsiteOrders', typeof allowWebsiteOrders === 'boolean' ? allowWebsiteOrders : undefined);

    restaurant.markModified('website');
    await restaurant.save();
    if (branch) {
      branch.markModified('websiteOverrides');
      await branch.save();
    }

    // Return merged config for this branch (or global if no branch)
    const raw = restaurant.website || {};
    const base = typeof raw.toObject === 'function' ? raw.toObject() : { ...raw };
    delete base.openingHours;

    let merged = { ...base };
    if (branchId && overrides) {
      dynamicKeys.forEach((key) => {
        if (overrides[key] !== undefined) {
          merged[key] = overrides[key];
        }
      });
    }

    res.json(merged);
  } catch (error) {
    next(error);
  }
});

// REPORTING & DASHBOARD ROUTES

// Helper: compute cost of a single menu item based on its inventory consumptions
// costPrice is stored per bulk unit: per 1000g, per 1000ml, per 12 pieces
function computeItemCost(menuItem, inventoryMap) {
  if (!menuItem.inventoryConsumptions || menuItem.inventoryConsumptions.length === 0) return 0;
  let cost = 0;
  for (const consumption of menuItem.inventoryConsumptions) {
    const invId = consumption.inventoryItem ? consumption.inventoryItem.toString() : null;
    if (!invId) continue;
    const inv = inventoryMap.get(invId);
    if (!inv || !inv.costPrice) continue;
    const qty = consumption.quantity || 0;
    if (inv.unit === 'gram' || inv.unit === 'kg') {
      cost += (qty / 1000) * inv.costPrice;
    } else if (inv.unit === 'ml' || inv.unit === 'liter') {
      cost += (qty / 1000) * inv.costPrice;
    } else if (inv.unit === 'piece') {
      cost += (qty / 12) * inv.costPrice;
    }
  }
  return cost;
}

// @route   GET /api/admin/reports/sales
// @desc    Get sales report for a date range
// @access  Restaurant Admin / Super Admin
router.get('/reports/sales', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);
    const { from, to } = req.query;

    const fromDate = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
    const toDate = to ? new Date(to) : new Date(new Date().setHours(23, 59, 59, 999));

    const orderFilter = { restaurant: restaurantId, status: 'COMPLETED', createdAt: { $gte: fromDate, $lte: toDate } };
    if (branchId) orderFilter.branch = branchId;
    const orders = await Order.find(orderFilter);

    let totalRevenue = 0;
    let totalProfit = 0;
    let totalOrders = orders.length;
    const itemStats = new Map();
    const dailyMap = new Map(); // date YYYY-MM-DD -> total sales
    const paymentDistribution = {};
    const isSingleDay = toDate.getTime() - fromDate.getTime() <= 24 * 60 * 60 * 1000;
    const hourlySales = isSingleDay ? new Array(24).fill(0) : null;

    // Always recompute profit from revenue and cost so report is consistent (not relying on possibly wrong stored order.profit)
    const menuItemIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.menuItem)).filter(Boolean))];
    let menuMapForCost = new Map();
    let invCostMapForReport = new Map();
    if (menuItemIds.length > 0) {
      const menuItems = await MenuItem.find({ _id: { $in: menuItemIds }, restaurant: restaurantId });
      for (const m of menuItems) menuMapForCost.set(m._id.toString(), m);
      const invIds = [...new Set(menuItems.flatMap((m) => (m.inventoryConsumptions || []).map((c) => c.inventoryItem?.toString?.()).filter(Boolean)))];
      if (invIds.length > 0) {
        const itemDefs = await InventoryItem.find({ _id: { $in: invIds }, restaurant: restaurantId }).select('_id unit costPrice').lean();
        for (const d of itemDefs) invCostMapForReport.set(d._id.toString(), { costPrice: d.costPrice || 0, unit: d.unit || 'gram' });
        if (branchId) {
          const branchRows = await BranchInventory.find({ branch: branchId, inventoryItem: { $in: invIds } }).select('inventoryItem costPrice').lean();
          for (const r of branchRows) {
            const id = r.inventoryItem.toString();
            if (invCostMapForReport.has(id)) invCostMapForReport.set(id, { ...invCostMapForReport.get(id), costPrice: r.costPrice ?? 0 });
          }
        }
      }
    }

    for (const order of orders) {
      totalRevenue += order.total;
      const dateKey = new Date(order.createdAt).toISOString().slice(0, 10);
      dailyMap.set(dateKey, (dailyMap.get(dateKey) || 0) + order.total);
      const pm = order.paymentMethod || 'CASH';
      paymentDistribution[pm] = (paymentDistribution[pm] || 0) + order.total;
      if (hourlySales) hourlySales[new Date(order.createdAt).getHours()] += order.total;
      // Profit = revenue - cost (always recomputed for report consistency)
      let orderCost = 0;
      if (invCostMapForReport.size > 0) {
        for (const orderItem of order.items) {
          const menu = menuMapForCost.get(orderItem.menuItem?.toString?.());
          if (!menu) continue;
          orderCost += computeItemCost(menu, invCostMapForReport) * orderItem.quantity;
        }
      }
      totalProfit += order.total - orderCost;
      for (const item of order.items) {
        const key = item.menuItem.toString();
        const existing = itemStats.get(key) || {
          menuItemId: item.menuItem,
          name: item.name,
          quantity: 0,
          revenue: 0,
        };
        existing.quantity += item.quantity;
        existing.revenue += item.lineTotal;
        itemStats.set(key, existing);
      }
    }

    // Daily sales for chart: one entry per day in [fromDate, toDate)
    const dailySales = [];
    const dayMs = 24 * 60 * 60 * 1000;
    for (let t = fromDate.getTime(); t < toDate.getTime(); t += dayMs) {
      const d = new Date(t);
      const dateKey = d.toISOString().slice(0, 10);
      dailySales.push({
        day: d.getUTCDate(),
        date: dateKey,
        sales: Math.round(dailyMap.get(dateKey) || 0),
      });
    }

    const sortedTopItems = Array.from(itemStats.values()).sort((a, b) => b.quantity - a.quantity);
    const menuItemIdsForCategory = [...new Set(sortedTopItems.map((p) => p.menuItemId).filter(Boolean))];
    const menuItemCategoryMap = new Map();
    if (menuItemIdsForCategory.length > 0) {
      const menuItemsWithCat = await MenuItem.find({ _id: { $in: menuItemIdsForCategory }, restaurant: restaurantId })
        .populate('category', 'name')
        .lean();
      for (const mi of menuItemsWithCat) {
        menuItemCategoryMap.set(mi._id.toString(), mi.category?.name || 'Uncategorized');
      }
    }
    const topItems = sortedTopItems.map((p) => ({
      name: p.name,
      menuItemId: p.menuItemId,
      quantity: p.quantity,
      revenue: p.revenue,
      category: menuItemCategoryMap.get(p.menuItemId?.toString?.() || '') || 'Uncategorized',
    }));

    const payload = {
      from: fromDate,
      to: toDate,
      totalRevenue,
      totalProfit: Math.round(totalProfit),
      totalOrders,
      topItems,
      dailySales,
      paymentDistribution,
    };
    if (hourlySales) payload.hourlySales = hourlySales;
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/reports/day
// @desc    Full day report with cost & profit
// @access  Restaurant Admin / Super Admin
router.get('/reports/day', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);
    const { date } = req.query;
    const reportDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(reportDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(reportDate);
    endOfDay.setHours(23, 59, 59, 999);

    const orderFilter = { restaurant: restaurantId, createdAt: { $gte: startOfDay, $lte: endOfDay } };
    if (branchId) orderFilter.branch = branchId;
    const [allOrders, invItems, mItems] = await Promise.all([
      Order.find(orderFilter),
      InventoryItem.find({ restaurant: restaurantId }),
      MenuItem.find({ restaurant: restaurantId }),
    ]);

    const iMap = new Map();
    for (const i of invItems) iMap.set(i._id.toString(), i);
    const mcMap = new Map();
    for (const m of mItems) mcMap.set(m._id.toString(), computeItemCost(m, iMap));

    const completed = allOrders.filter(o => o.status === 'COMPLETED');
    const cancelled = allOrders.filter(o => o.status === 'CANCELLED');
    const grossSales = completed.reduce((s, o) => s + o.subtotal, 0);
    const totalDisc = completed.reduce((s, o) => s + (o.discountAmount || 0), 0);
    const totalRev = completed.reduce((s, o) => s + o.total, 0);

    let budgetCost = 0;
    for (const o of completed) {
      for (const it of o.items) {
        const mid = it.menuItem ? it.menuItem.toString() : null;
        budgetCost += (mid ? (mcMap.get(mid) || 0) : 0) * it.quantity;
      }
    }

    // Payment-wise breakdown
    const pm = {};
    for (const o of completed) {
      const m = o.paymentMethod || 'CASH';
      if (!pm[m]) pm[m] = { orders: 0, amount: 0 };
      pm[m].orders++;
      pm[m].amount += o.total;
    }
    const pmLabels = { CASH: 'Cash', CARD: 'Card', ONLINE: 'Online', OTHER: 'Foodpanda' };
    const paymentRows = Object.entries(pm).map(([m, d]) => ({
      method: pmLabels[m] || m,
      orders: d.orders,
      amount: Math.round(d.amount),
      percent: completed.length > 0 ? ((d.orders / completed.length) * 100).toFixed(1) + '%' : '0%',
    }));
    paymentRows.push({ method: 'Total', orders: completed.length, amount: Math.round(totalRev), percent: '100%' });

    // Order type breakdown
    const tm = {};
    for (const o of completed) {
      const t = o.orderType || 'DINE_IN';
      if (!tm[t]) tm[t] = { orders: 0, amount: 0 };
      tm[t].orders++;
      tm[t].amount += o.total;
    }
    const otLabels = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };
    const orderTypeRows = Object.entries(tm).map(([t, d]) => ({
      type: otLabels[t] || t,
      orders: d.orders,
      amount: Math.round(d.amount),
      percent: completed.length > 0 ? ((d.orders / completed.length) * 100).toFixed(1) + '%' : '0%',
    }));

    res.json({
      date: startOfDay.toISOString(),
      salesDetails: {
        grossSales: Math.round(grossSales),
        netSales: Math.round(grossSales - totalDisc),
        discounts: Math.round(totalDisc),
        deliveryCharges: 0,
        totalRevenue: Math.round(totalRev),
        taxAmount: 0,
        budgetCost: Math.round(budgetCost),
        profit: Math.round(totalRev - budgetCost),
      },
      insights: {
        totalOrders: allOrders.length,
        completedSales: completed.length,
        paidSales: completed.length,
        cancelledToday: cancelled.length,
      },
      paymentRows,
      orderTypeRows,
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/dashboard/summary
// @desc    Dashboard: revenue, orders, charts, cost & profit (scoped by x-branch-id when set)
// @access  Restaurant Admin / Super Admin
router.get('/dashboard/summary', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // For monthly product performance we look at the current month up to today
    const startOfMonth = new Date(startOfDay);
    startOfMonth.setDate(1);

    const orderFilter = { restaurant: restaurantId, createdAt: { $gte: startOfDay, $lte: endOfDay } };
    if (branchId) orderFilter.branch = branchId;

    const pendingFilter = { restaurant: restaurantId, status: { $in: ['UNPROCESSED', 'PENDING', 'READY'] } };
    if (branchId) pendingFilter.branch = branchId;

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    const orderFilterLast7 = { restaurant: restaurantId, status: 'COMPLETED', createdAt: { $gte: sevenDaysAgo, $lte: endOfDay } };
    if (branchId) orderFilterLast7.branch = branchId;

    // Orders for the current month (completed only) for products performance
    const monthlyCompletedFilter = {
      restaurant: restaurantId,
      status: 'COMPLETED',
      createdAt: { $gte: startOfMonth, $lte: endOfDay },
    };
    if (branchId) monthlyCompletedFilter.branch = branchId;

    const [
      allTodayOrders,
      pendingOrdersList,
      completedLast7,
      completedThisMonth,
      inventoryItems,
      allMenuItems,
      categories,
    ] = await Promise.all([
      Order.find(orderFilter),
      Order.find(pendingFilter),
      Order.find(orderFilterLast7),
      Order.find(monthlyCompletedFilter),
      InventoryItem.find({ restaurant: restaurantId }),
      MenuItem.find({ restaurant: restaurantId }),
      Category.find({ restaurant: restaurantId }),
    ]);

    const completedOrders = allTodayOrders.filter(o => o.status === 'COMPLETED');
    const pendingOrders = pendingOrdersList;
    const todaysRevenue = completedOrders.reduce((s, o) => s + o.total, 0);
    const todaysOrdersCount = completedOrders.length;

    // Build inventory map for cost calculations
    const invMap = new Map();
    for (const inv of inventoryItems) invMap.set(inv._id.toString(), inv);
    const miCostMap = new Map();
    for (const mi of allMenuItems) miCostMap.set(mi._id.toString(), computeItemCost(mi, invMap));

    let totalBudgetCost = 0;
    for (const order of completedOrders) {
      for (const item of order.items) {
        const mid = item.menuItem ? item.menuItem.toString() : null;
        totalBudgetCost += (mid ? (miCostMap.get(mid) || 0) : 0) * item.quantity;
      }
    }

    // Low stock: use BranchInventory when a branch is selected
    let lowStockItems = [];
    if (branchId) {
      const branchInvRows = await BranchInventory.find({ branch: branchId }).populate('inventoryItem', 'name unit').lean();
      lowStockItems = branchInvRows
        .filter((r) => r.lowStockThreshold > 0 && r.currentStock <= r.lowStockThreshold && r.inventoryItem)
        .map((r) => ({
          id: r.inventoryItem._id.toString(),
          name: r.inventoryItem.name,
          unit: r.inventoryItem.unit,
          currentStock: r.currentStock,
          lowStockThreshold: r.lowStockThreshold,
        }));
    } else {
      lowStockItems = inventoryItems
      .filter((i) => i.lowStockThreshold > 0 && i.currentStock <= i.lowStockThreshold)
        .map((i) => ({ id: i._id.toString(), name: i.name, unit: i.unit, currentStock: i.currentStock, lowStockThreshold: i.lowStockThreshold }));
    }

    // Hourly sales (0-23)
    const hourlySales = new Array(24).fill(0);
    for (const o of completedOrders) hourlySales[new Date(o.createdAt).getHours()] += o.total;

    // Sales type, payment, and source distribution from last 7 days so charts show data (avoids timezone/today-only empty state)
    const salesTypeDistribution = {};
    const paymentDistribution = {};
    const sourceDistribution = {};
    for (const o of completedLast7) {
      const t = o.orderType || 'DINE_IN';
      salesTypeDistribution[t] = (salesTypeDistribution[t] || 0) + 1;
      const m = o.paymentMethod || 'CASH';
      paymentDistribution[m] = (paymentDistribution[m] || 0) + 1;
      const s = o.source || 'POS';
      sourceDistribution[s] = (sourceDistribution[s] || 0) + 1;
    }

    // Top products - for charts we still use today's completed orders
    const productMap = new Map();
    for (const o of completedOrders) {
      for (const item of o.items) {
        const key = item.name;
        const ex = productMap.get(key) || { name: item.name, qty: 0, revenue: 0, menuItemId: item.menuItem ? item.menuItem.toString() : null };
        ex.qty += item.quantity;
        ex.revenue += item.lineTotal;
        productMap.set(key, ex);
      }
    }
    const topProducts = Array.from(productMap.values()).sort((a, b) => b.qty - a.qty).slice(0, 10);

    // Category map for product performance
    const categoryMap = new Map();
    for (const cat of categories) categoryMap.set(cat._id.toString(), cat.name);
    const menuItemCategoryMap = new Map();
    for (const mi of allMenuItems) {
      menuItemCategoryMap.set(mi._id.toString(), categoryMap.get(mi.category ? mi.category.toString() : '') || 'Uncategorized');
    }

    // Products performance: this month (completed orders only) so the table is richer
    const monthlyProductMap = new Map();
    for (const o of completedThisMonth) {
      for (const item of o.items) {
        const key = item.menuItem ? item.menuItem.toString() : item.name;
        const existing = monthlyProductMap.get(key) || {
          name: item.name,
          menuItemId: item.menuItem ? item.menuItem.toString() : null,
          qty: 0,
          revenue: 0,
        };
        existing.qty += item.quantity;
        existing.revenue += item.lineTotal;
        monthlyProductMap.set(key, existing);
      }
    }

    const productsPerformance = Array.from(monthlyProductMap.values())
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 50)
      .map((p) => ({
        name: p.name,
        category: p.menuItemId ? menuItemCategoryMap.get(p.menuItemId) || 'Uncategorized' : 'Uncategorized',
        qtySold: p.qty,
        priceSold: Math.round(p.revenue),
      }));

    res.json({
      todaysRevenue,
      todaysOrdersCount,
      pendingOrdersCount: pendingOrders.length,
      totalBudgetCost: Math.round(totalBudgetCost),
      totalProfit: Math.round(todaysRevenue - totalBudgetCost),
      lowStockItems,
      hourlySales,
      salesTypeDistribution,
      paymentDistribution,
      sourceDistribution,
      topProducts: topProducts.slice(0, 5),
      productsPerformance,
    });
  } catch (error) {
    next(error);
  }
});

// USER MANAGEMENT ROUTES

// @route   GET /api/admin/users
// @desc    List users for this restaurant (with branch assignments)
// @access  Restaurant Admin / Super Admin
router.get('/users', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const users = await User.find({ restaurant: restaurantId }).sort({ createdAt: -1 });

    // Load branch assignments for all users
    const userIds = users.map((u) => u._id);
    const allAssignments = await UserBranch.find({ user: { $in: userIds } }).populate('branch', 'name').lean();
    const assignmentsByUser = new Map();
    for (const a of allAssignments) {
      if (!assignmentsByUser.has(a.user.toString())) assignmentsByUser.set(a.user.toString(), []);
      assignmentsByUser.get(a.user.toString()).push(a);
    }

    res.json(users.map((u) => mapUser(u, assignmentsByUser.get(u._id.toString()) || [])));
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/users
// @desc    Create a new staff user for this restaurant (with optional branchIds)
// @access  Restaurant Admin / Super Admin
router.post('/users', async (req, res, next) => {
  try {
    const { name, email, password, role, profileImageUrl, branchIds } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }

    // Manager can only add non-admin, non-manager roles. Admin/restaurant_admin can add any role.
    const isManagerRequester = req.user.role === 'manager';
    const allowedRoles = isManagerRequester
      ? ['product_manager', 'cashier', 'kitchen_staff', 'order_taker']
      : ['admin', 'product_manager', 'cashier', 'manager', 'kitchen_staff', 'order_taker'];
    if (role && !allowedRoles.includes(role)) {
      return res.status(400).json({
        message: isManagerRequester
          ? 'Managers can only add Product Manager, Cashier, Kitchen Staff, or Order Taker'
          : 'Invalid role',
      });
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password,
      role: role || 'manager',
      profileImageUrl: profileImageUrl || null,
      restaurant: restaurantId,
    });

    // Create branch assignments if provided
    let assignments = [];
    if (Array.isArray(branchIds) && branchIds.length > 0) {
      const validBranches = await Branch.find({ _id: { $in: branchIds }, restaurant: restaurantId }).select('_id name').lean();
      const docs = validBranches.map((b) => ({
        user: user._id,
        branch: b._id,
        role: role || 'manager',
      }));
      if (docs.length > 0) {
        await UserBranch.insertMany(docs);
        assignments = await UserBranch.find({ user: user._id }).populate('branch', 'name').lean();
      }
    }

    res.status(201).json(mapUser(user, assignments));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/users/:id
// @desc    Update a user for this restaurant (including branch assignments)
// @access  Restaurant Admin / Super Admin
router.put('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, email, password, role, profileImageUrl, branchIds } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);

    const user = await User.findOne({ _id: id, restaurant: restaurantId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (name !== undefined) user.name = name.trim();
    if (email !== undefined) user.email = email.toLowerCase().trim();
    if (role !== undefined) {
      const isManagerRequester = req.user.role === 'manager';
      const allowedRoles = isManagerRequester
        ? ['product_manager', 'cashier', 'kitchen_staff', 'order_taker']
        : ['admin', 'product_manager', 'cashier', 'manager', 'kitchen_staff', 'order_taker'];
      if (!allowedRoles.includes(role)) {
        return res.status(400).json({
          message: isManagerRequester
            ? 'Managers cannot assign Admin or Manager role'
            : 'Invalid role',
        });
      }
      user.role = role;
    }
    if (password) {
      user.password = password; // will be hashed by pre-save hook
    }
    if (profileImageUrl !== undefined) {
      user.profileImageUrl = profileImageUrl || null;
    }

    await user.save();

    // Update branch assignments if provided
    if (Array.isArray(branchIds)) {
      // Remove all existing assignments
      await UserBranch.deleteMany({ user: user._id });
      // Re-create with new branch list
      if (branchIds.length > 0) {
        const validBranches = await Branch.find({ _id: { $in: branchIds }, restaurant: restaurantId }).select('_id').lean();
        const docs = validBranches.map((b) => ({
          user: user._id,
          branch: b._id,
          role: user.role || 'manager',
        }));
        if (docs.length > 0) {
          await UserBranch.insertMany(docs);
        }
      }
    }

    const assignments = await UserBranch.find({ user: user._id }).populate('branch', 'name').lean();
    res.json(mapUser(user, assignments));
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/admin/users/:id
// @desc    Delete a user for this restaurant (and branch assignments). Manager cannot delete self; only admin can delete manager.
// @access  Restaurant Admin / Admin (Manager cannot delete self or other managers)
router.delete('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const restaurantId = getRestaurantIdForRequest(req);

    const user = await User.findOne({ _id: id, restaurant: restaurantId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const requesterId = req.user._id?.toString?.() ?? req.user.id;
    const targetId = user._id.toString();
    if (requesterId === targetId) {
      return res.status(403).json({ message: 'You cannot delete yourself' });
    }
    if (user.role === 'manager' && req.user.role !== 'restaurant_admin' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only an admin can delete a manager' });
    }

    await Promise.all([
      User.deleteOne({ _id: id, restaurant: restaurantId }),
      UserBranch.deleteMany({ user: id }),
    ]);

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// CUSTOMER ROUTES

// @route   GET /api/admin/customers
// @desc    List customers. With x-branch-id: customers for that branch. ?allBranches=true: all (owner only).
// @access  Restaurant Admin / Super Admin
router.get('/customers', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);
    const allBranches = req.query.allBranches === 'true';

    const query = { restaurant: restaurantId };
    if (branchId && !allBranches) {
      query.branch = branchId;
    }

    const customers = await Customer.find(query).sort({ lastOrderAt: -1, createdAt: -1 }).limit(500).lean();
    res.json(customers.map(mapCustomer));
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/customers/:id
// @desc    Get a single customer
// @access  Restaurant Admin / Super Admin
router.get('/customers/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const customer = await Customer.findOne({ _id: req.params.id, restaurant: restaurantId }).lean();
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    res.json(mapCustomer(customer));
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/customers
// @desc    Create a new customer (scoped to current branch if x-branch-id is set)
// @access  Restaurant Admin / Super Admin
router.post('/customers', async (req, res, next) => {
  try {
    const { name, phone, email, address, notes } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);

    if (!name || !phone) {
      return res.status(400).json({ message: 'Name and phone are required' });
    }

    const customer = await Customer.create({
      restaurant: restaurantId,
      branch: branchId || null,
      name: name.trim(),
      phone: phone.trim(),
      email: (email || '').trim(),
      address: (address || '').trim(),
      notes: (notes || '').trim(),
    });

    res.status(201).json(mapCustomer(customer));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/customers/:id
// @desc    Update a customer
// @access  Restaurant Admin / Super Admin
router.put('/customers/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const customer = await Customer.findOne({ _id: req.params.id, restaurant: restaurantId });
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const { name, phone, email, address, notes } = req.body;
    if (name !== undefined) customer.name = name.trim();
    if (phone !== undefined) customer.phone = phone.trim();
    if (email !== undefined) customer.email = (email || '').trim();
    if (address !== undefined) customer.address = (address || '').trim();
    if (notes !== undefined) customer.notes = (notes || '').trim();

    await customer.save();
    res.json(mapCustomer(customer));
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/admin/customers/:id
// @desc    Delete a customer
// @access  Restaurant Admin / Super Admin
router.delete('/customers/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const customer = await Customer.findOneAndDelete({ _id: req.params.id, restaurant: restaurantId });
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// KITCHEN DISPLAY SYSTEM (KDS) ROUTES

// @route   GET /api/admin/kitchen/orders
// @desc    Get orders for kitchen display, grouped by status (scoped by x-branch-id)
// @access  Restaurant Admin / Kitchen Staff
router.get('/kitchen/orders', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);

    const query = { 
      restaurant: restaurantId,
      status: { $in: ['UNPROCESSED', 'PENDING', 'READY'] },
    };
    if (branchId) query.branch = branchId;

    const orders = await Order.find(query)
      .populate('createdBy', 'name')
      .sort({ createdAt: 1 })
      .lean();

    // Group by status for KDS columns
    const grouped = {
      newOrders: orders.filter(o => o.status === 'UNPROCESSED'),
      inKitchen: orders.filter(o => o.status === 'PENDING'),
      ready: orders.filter(o => o.status === 'READY'),
    };

    // Detect delayed orders (older than 20 minutes and still in kitchen)
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    const delayed = orders.filter(o => 
      o.status === 'PENDING' && new Date(o.createdAt) < twentyMinutesAgo
    ).map(o => o._id.toString());

    const mapKitchenOrder = (o) => ({
      id: o._id.toString(),
      orderNumber: o.orderNumber,
      status: o.status,
      orderType: o.orderType,
      source: o.source || 'POS',
      tableNumber: o.tableNumber || '',
      customerName: o.customerName || 'Walk-in',
      items: (o.items || []).map(i => ({ name: i.name, quantity: i.quantity })),
      createdAt: o.createdAt,
      isDelayed: delayed.includes(o._id.toString()),
    });

    res.json({
      newOrders: grouped.newOrders.map(mapKitchenOrder),
      inKitchen: grouped.inKitchen.map(mapKitchenOrder),
      ready: grouped.ready.map(mapKitchenOrder),
      delayed: delayed.length,
    });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/kitchen/orders/:id/status
// @desc    Update order status from KDS (UNPROCESSED -> PENDING -> READY -> COMPLETED)
// @access  Restaurant Admin / Kitchen Staff
router.put('/kitchen/orders/:id/status', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);

    const allowedStatuses = ['UNPROCESSED', 'PENDING', 'READY', 'COMPLETED', 'CANCELLED'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const query = { restaurant: restaurantId };
    if (branchId) query.branch = branchId;

    let order;
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      order = await Order.findOne({ _id: id, ...query });
    }
    if (!order) {
      order = await Order.findOne({ orderNumber: id, ...query });
    }
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    order.status = status;
    await order.save();

    // When order is completed or cancelled, free the table (set isAvailable = true)
    if ((status === 'COMPLETED' || status === 'CANCELLED') && order.tableName && order.tableName.trim()) {
      await Table.findOneAndUpdate(
        { restaurant: order.restaurant, branch: order.branch || null, name: order.tableName.trim() },
        { $set: { isAvailable: true } }
      );
    }

    res.json({
      id: order._id.toString(),
      orderNumber: order.orderNumber,
      status: order.status,
    });
  } catch (error) {
    next(error);
  }
});

// TABLE MANAGEMENT ROUTES (simple: name + isAvailable)

const mapTable = (table) => ({
  id: table._id.toString(),
  name: table.name || '',
  isAvailable: table.isAvailable !== false,
  branchId: table.branch ? table.branch.toString() : null,
  createdAt: table.createdAt?.toISOString?.(),
});

// @route   GET /api/admin/tables
// @desc    List tables (scoped by x-branch-id when set)
// @access  Restaurant Admin / Staff
router.get('/tables', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);

    const query = { restaurant: restaurantId };
    if (branchId) query.branch = branchId;

    const tables = await Table.find(query).sort({ name: 1 }).lean();
    res.json({ tables: tables.map(mapTable) });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/tables
// @desc    Create a table (assigned to current branch if x-branch-id is set)
// @access  Restaurant Admin
router.post('/tables', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);
    const { name } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'Table name is required' });
    }

    const trimmedName = String(name).trim();
    const existing = await Table.findOne({
      restaurant: restaurantId,
      branch: branchId || null,
      name: trimmedName,
    });
    if (existing) {
      return res.status(400).json({ message: 'A table with this name already exists for this branch' });
    }

    const table = await Table.create({
      restaurant: restaurantId,
      branch: branchId || null,
      name: trimmedName,
      isAvailable: true,
    });

    res.status(201).json(mapTable(table));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/tables/:id
// @desc    Update a table (name, isAvailable)
// @access  Restaurant Admin
router.put('/tables/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const table = await Table.findOne({ _id: req.params.id, restaurant: restaurantId });
    if (!table) {
      return res.status(404).json({ message: 'Table not found' });
    }

    const { name, isAvailable } = req.body;
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) {
        return res.status(400).json({ message: 'Table name cannot be empty' });
      }
      if (trimmed !== table.name) {
        const duplicate = await Table.findOne({
          restaurant: restaurantId,
          branch: table.branch,
          name: trimmed,
          _id: { $ne: table._id },
        });
        if (duplicate) {
          return res.status(400).json({ message: 'A table with this name already exists for this branch' });
        }
        table.name = trimmed;
      }
    }
    if (typeof isAvailable === 'boolean') table.isAvailable = isAvailable;

    await table.save();
    res.json(mapTable(table));
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/admin/tables/:id
// @desc    Delete a table
// @access  Restaurant Admin
router.delete('/tables/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const table = await Table.findOneAndDelete({ _id: req.params.id, restaurant: restaurantId });
    if (!table) {
      return res.status(404).json({ message: 'Table not found' });
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// RESERVATION ROUTES

const mapReservation = (reservation) => ({
  id: reservation._id.toString(),
  customerName: reservation.customerName,
  customerPhone: reservation.customerPhone,
  customerEmail: reservation.customerEmail || '',
  date: reservation.date,
  time: reservation.time,
  guestCount: reservation.guestCount,
  tableNumber: reservation.tableNumber || '',
  tableId: reservation.table ? reservation.table.toString() : null,
  status: reservation.status,
  notes: reservation.notes || '',
  specialRequests: reservation.specialRequests || '',
  branchId: reservation.branch ? reservation.branch.toString() : null,
  createdAt: reservation.createdAt?.toISOString?.(),
});

// @route   GET /api/admin/reservations
// @desc    List reservations (scoped by x-branch-id; optional ?date=YYYY-MM-DD filter)
// @access  Restaurant Admin / Staff
router.get('/reservations', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);

    const query = { restaurant: restaurantId };
    if (branchId) query.branch = branchId;

    // Optional date filter
    if (req.query.date) {
      const filterDate = new Date(req.query.date);
      const startOfDay = new Date(filterDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(filterDate);
      endOfDay.setHours(23, 59, 59, 999);
      query.date = { $gte: startOfDay, $lte: endOfDay };
    }

    const reservations = await Reservation.find(query).sort({ date: 1, time: 1 }).lean();
    res.json({ reservations: reservations.map(mapReservation) });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/reservations
// @desc    Create a new reservation (assigned to current branch if x-branch-id is set)
// @access  Restaurant Admin / Staff
router.post('/reservations', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);
    const { customerName, customerPhone, customerEmail, date, time, guestCount, tableNumber, tableId, notes, specialRequests } = req.body;

    if (!customerName || !customerPhone || !date || !time || !guestCount) {
      return res.status(400).json({ message: 'Customer name, phone, date, time, and guest count are required' });
    }

    // Optionally link to customer record
    let customerId = null;
    if (customerPhone) {
      const customer = await Customer.findOne({
        restaurant: restaurantId,
        branch: branchId || null,
        phone: customerPhone.trim(),
      });
      if (customer) customerId = customer._id;
    }

    const reservation = await Reservation.create({
      restaurant: restaurantId,
      branch: branchId || null,
      customer: customerId,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerEmail: (customerEmail || '').trim(),
      date: new Date(date),
      time: time.trim(),
      guestCount: parseInt(guestCount) || 2,
      tableNumber: (tableNumber || '').trim(),
      table: tableId || null,
      status: 'pending',
      notes: (notes || '').trim(),
      specialRequests: (specialRequests || '').trim(),
    });

    res.status(201).json(mapReservation(reservation));
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/reservations/:id
// @desc    Get single reservation
// @access  Restaurant Admin / Staff
router.get('/reservations/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const reservation = await Reservation.findOne({ _id: req.params.id, restaurant: restaurantId }).lean();
    if (!reservation) {
      return res.status(404).json({ message: 'Reservation not found' });
    }
    res.json(mapReservation(reservation));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/reservations/:id
// @desc    Update a reservation
// @access  Restaurant Admin / Staff
router.put('/reservations/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const reservation = await Reservation.findOne({ _id: req.params.id, restaurant: restaurantId });
    if (!reservation) {
      return res.status(404).json({ message: 'Reservation not found' });
    }

    const { customerName, customerPhone, customerEmail, date, time, guestCount, tableNumber, tableId, status, notes, specialRequests } = req.body;

    if (customerName !== undefined) reservation.customerName = customerName.trim();
    if (customerPhone !== undefined) reservation.customerPhone = customerPhone.trim();
    if (customerEmail !== undefined) reservation.customerEmail = (customerEmail || '').trim();
    if (date !== undefined) reservation.date = new Date(date);
    if (time !== undefined) reservation.time = time.trim();
    if (guestCount !== undefined) reservation.guestCount = parseInt(guestCount) || 2;
    if (tableNumber !== undefined) reservation.tableNumber = (tableNumber || '').trim();
    if (tableId !== undefined) reservation.table = tableId || null;
    if (status !== undefined) reservation.status = status;
    if (notes !== undefined) reservation.notes = (notes || '').trim();
    if (specialRequests !== undefined) reservation.specialRequests = (specialRequests || '').trim();

    await reservation.save();
    res.json(mapReservation(reservation));
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/admin/reservations/:id
// @desc    Delete a reservation
// @access  Restaurant Admin / Staff
router.delete('/reservations/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const reservation = await Reservation.findOneAndDelete({ _id: req.params.id, restaurant: restaurantId });
    if (!reservation) {
      return res.status(404).json({ message: 'Reservation not found' });
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
