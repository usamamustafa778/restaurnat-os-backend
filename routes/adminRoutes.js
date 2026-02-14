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
    'kitchen_staff'
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
// @desc    List branches for the tenant (filtered by allowedBranchIds for non-owners)
// @access  Restaurant Admin / Staff / Super Admin
router.get('/branches', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    let query = { restaurant: restaurantId };
    if (req.user.role !== 'super_admin' && req.user.role !== 'restaurant_admin' && req.user.allowedBranchIds?.length) {
      query._id = { $in: req.user.allowedBranchIds };
    }
    const branches = await Branch.find(query).sort({ sortOrder: 1, createdAt: 1 }).lean();
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
    const branch = await Branch.findOne({ _id: req.params.id, restaurant: restaurantId });
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
    const branch = await Branch.findOne({ _id: req.params.id, restaurant: restaurantId });
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
// @desc    Soft-delete / deactivate branch (prefer not hard-delete so orders remain valid)
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
    branch.status = 'inactive';
    await branch.save();
    res.status(204).send();
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

const mapMenuItem = (item) => ({
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
  inventoryConsumptions: (item.inventoryConsumptions || []).map((c) => ({
    inventoryItem: c.inventoryItem.toString(),
    quantity: c.quantity,
  })),
});

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

  const paymentLabels = { CASH: 'Cash', CARD: 'Card', ONLINE: 'Online', OTHER: 'Other' };

  return {
    id: order.orderNumber || order._id.toString(),
    _id: order._id.toString(),
    customerName,
    customerPhone: order.customerPhone || '',
    deliveryAddress: order.deliveryAddress || '',
    tableNumber: order.tableNumber || '',
    tableId: order.table ? order.table.toString() : null,
    total: order.total,
    subtotal: order.subtotal,
    discountAmount: order.discountAmount || 0,
    status: order.status,
    createdAt: order.createdAt,
    items: (order.items || []).map((i) => ({
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
    paymentMethod: paymentLabels[order.paymentMethod] || order.paymentMethod || 'Cash',
    paymentStatus: order.status === 'COMPLETED' ? 'PAID' : 'UNPAID',
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
    const branchId = getBranchIdForRequest(req);

    const [categories, items, inventoryItems] = await Promise.all([
      Category.find({ restaurant: restaurantId }).sort({ createdAt: 1 }),
      MenuItem.find({ restaurant: restaurantId }),
      InventoryItem.find({ restaurant: restaurantId }),
    ]);

    // Build inventory lookup map
    const inventoryMap = new Map();
    for (const inv of inventoryItems) {
      inventoryMap.set(inv._id.toString(), inv);
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
      const base = mapMenuItem(item);
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

// @route   PUT /api/admin/orders/:id/status
// @desc    Update order status (find by restaurant; branch optional for legacy orders)
// @access  Restaurant Admin / Staff / Super Admin
router.put('/orders/:id/status', async (req, res, next) => {
  try {
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

    res.json(mapOrder(order));
  } catch (error) {
    next(error);
  }
});

// CATEGORY ROUTES

// @route   POST /api/admin/categories
// @desc    Create a new category
// @access  Restaurant Admin / Super Admin
router.post('/categories', async (req, res, next) => {
  try {
    const { name, description } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Category name is required' });
    }

    const existing = await Category.findOne({ restaurant: restaurantId, name: name.trim() });
    if (existing) {
      return res.status(400).json({ message: 'Category with this name already exists for this restaurant' });
    }

    const category = await Category.create({
      restaurant: restaurantId,
      name: name.trim(),
      description: description || '',
    });

    res.status(201).json(mapCategory(category));
  } catch (error) {
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

    const category = await Category.findOne({ _id: id, restaurant: restaurantId });
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    // Check for duplicate name within the same restaurant (if name is being changed)
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (trimmedName !== category.name) {
        const duplicate = await Category.findOne({
          restaurant: restaurantId,
          name: trimmedName,
          _id: { $ne: category._id },
        });
        if (duplicate) {
          return res.status(400).json({ message: 'A category with this name already exists' });
        }
        category.name = trimmedName;
      }
    }

    if (description !== undefined) category.description = description;
    if (typeof isActive === 'boolean') category.isActive = isActive;

    await category.save();

    res.json(mapCategory(category));
  } catch (error) {
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

const normalizeInventoryConsumptions = async (restaurantId, rawConsumptions) => {
  if (!Array.isArray(rawConsumptions) || rawConsumptions.length === 0) {
    return [];
  }

  const inventoryIds = rawConsumptions.map((c) => c.inventoryItemId).filter(Boolean);
  if (inventoryIds.length === 0) {
    return [];
  }

  const inventoryItems = await InventoryItem.find({
    _id: { $in: inventoryIds },
    restaurant: restaurantId,
  });

  if (inventoryItems.length !== inventoryIds.length) {
    throw new Error('One or more inventory items are invalid for this restaurant');
  }

  const validIds = new Set(inventoryItems.map((i) => i._id.toString()));

  return rawConsumptions
    .filter((c) => c.inventoryItemId && validIds.has(c.inventoryItemId))
    .map((c) => ({
      inventoryItem: c.inventoryItemId,
      quantity: Number(c.quantity) || 0,
    }))
    .filter((c) => c.quantity > 0);
};

// @route   POST /api/admin/items
// @desc    Create a new menu item
// @access  Restaurant Admin / Super Admin
router.post('/items', async (req, res, next) => {
  try {
    const { name, description, price, categoryId, showOnWebsite, imageUrl, inventoryConsumptions } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);

    if (!name || !name.trim() || price === undefined || !categoryId) {
      return res.status(400).json({ message: 'Name, price and categoryId are required' });
    }

    const category = await Category.findOne({ _id: categoryId, restaurant: restaurantId });
    if (!category) {
      return res.status(400).json({ message: 'Invalid categoryId' });
    }

    let normalizedConsumptions = [];
    if (inventoryConsumptions) {
      try {
        normalizedConsumptions = await normalizeInventoryConsumptions(restaurantId, inventoryConsumptions);
      } catch (err) {
        return res.status(400).json({ message: err.message });
      }
    }

    const item = await MenuItem.create({
      restaurant: restaurantId,
      name: name.trim(),
      description: description || '',
      price,
      category: categoryId,
      showOnWebsite: showOnWebsite !== undefined ? !!showOnWebsite : true,
      imageUrl,
      inventoryConsumptions: normalizedConsumptions,
    });

    res.status(201).json(mapMenuItem(item));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/items/:id
// @desc    Update a menu item (including availability and website visibility)
// @access  Restaurant Admin / Super Admin
router.put('/items/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, price, categoryId, available, showOnWebsite, imageUrl, isFeatured, isBestSeller, inventoryConsumptions } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);

    const item = await MenuItem.findOne({ _id: id, restaurant: restaurantId });
    if (!item) {
      return res.status(404).json({ message: 'Menu item not found' });
    }

    if (name !== undefined) item.name = name.trim();
    if (description !== undefined) item.description = description;
    if (price !== undefined) item.price = price;
    if (typeof available === 'boolean') item.available = available;
    if (typeof showOnWebsite === 'boolean') item.showOnWebsite = showOnWebsite;
    if (imageUrl !== undefined) item.imageUrl = imageUrl;
    if (typeof isFeatured === 'boolean') item.isFeatured = isFeatured;
    if (typeof isBestSeller === 'boolean') item.isBestSeller = isBestSeller;

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

// @route   POST /api/admin/inventory
// @desc    Create an inventory item (restaurant-level definition). If x-branch-id is set, also create BranchInventory row.
// @access  Restaurant Admin / Super Admin
router.post('/inventory', async (req, res, next) => {
  try {
    const { name, unit, initialStock, lowStockThreshold, costPrice } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);
    const branchId = getBranchIdForRequest(req);

    if (!name || !unit) {
      return res.status(400).json({ message: 'Name and unit are required' });
    }

    // Prevent duplicate inventory item names within the same restaurant
    const existing = await InventoryItem.findOne({
      restaurant: restaurantId,
      name: { $regex: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    });
    if (existing) {
      return res.status(400).json({ message: `An inventory item named "${name.trim()}" already exists` });
    }

    const item = await InventoryItem.create({
      restaurant: restaurantId,
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

    // Update restaurant-level definition (name, unit) regardless
    if (name !== undefined && name.trim() !== item.name) {
      const duplicate = await InventoryItem.findOne({
        restaurant: restaurantId,
        _id: { $ne: item._id },
        name: { $regex: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      });
      if (duplicate) {
        return res.status(400).json({ message: `An inventory item named "${name.trim()}" already exists` });
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
// @desc    Get website settings for current restaurant
// @access  Restaurant Admin / Super Admin
router.get('/website', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    const raw = restaurant.website || {};
    const website = typeof raw.toObject === 'function' ? raw.toObject() : { ...raw };
    delete website.openingHours;
    res.json(website);
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/website
// @desc    Update website branding/content
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

    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    if (!restaurant.website) {
      restaurant.website = {};
    }

    // Basic fields
    if (name !== undefined) restaurant.website.name = name;
    if (logoUrl !== undefined) restaurant.website.logoUrl = logoUrl;
    if (bannerUrl !== undefined) restaurant.website.bannerUrl = bannerUrl;
    if (description !== undefined) restaurant.website.description = description;
    if (tagline !== undefined) restaurant.website.tagline = tagline;
    if (contactPhone !== undefined) restaurant.website.contactPhone = contactPhone;
    if (contactEmail !== undefined) restaurant.website.contactEmail = contactEmail;
    if (address !== undefined) restaurant.website.address = address;
    if (typeof isPublic === 'boolean') restaurant.website.isPublic = isPublic;

    // Dynamic content fields
    if (heroSlides !== undefined) restaurant.website.heroSlides = heroSlides;
    if (socialMedia !== undefined) restaurant.website.socialMedia = socialMedia;
    if (themeColors !== undefined) restaurant.website.themeColors = themeColors;
    if (openingHoursText !== undefined) {
      restaurant.website.openingHoursText = openingHoursText;
      restaurant.website.openingHours = {};
    }
    if (websiteSections !== undefined) restaurant.website.websiteSections = websiteSections;
    if (typeof allowWebsiteOrders === 'boolean') restaurant.website.allowWebsiteOrders = allowWebsiteOrders;

    restaurant.markModified('website');
    await restaurant.save();

    const updated = restaurant.website || {};
    const out = typeof updated.toObject === 'function' ? updated.toObject() : { ...updated };
    delete out.openingHours;
    res.json(out);
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
    let totalOrders = orders.length;
    const itemStats = new Map();

    for (const order of orders) {
      totalRevenue += order.total;
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

    res.json({
      from: fromDate,
      to: toDate,
      totalRevenue,
      totalOrders,
      topItems: Array.from(itemStats.values()).sort((a, b) => b.quantity - a.quantity),
    });
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

    const orderFilter = { restaurant: restaurantId, createdAt: { $gte: startOfDay, $lte: endOfDay } };
    if (branchId) orderFilter.branch = branchId;

    const [allTodayOrders, inventoryItems, allMenuItems, categories] = await Promise.all([
      Order.find(orderFilter),
      InventoryItem.find({ restaurant: restaurantId }),
      MenuItem.find({ restaurant: restaurantId }),
      Category.find({ restaurant: restaurantId }),
    ]);

    const completedOrders = allTodayOrders.filter(o => o.status === 'COMPLETED');
    const pendingOrders = allTodayOrders.filter(o => ['UNPROCESSED', 'PENDING', 'READY'].includes(o.status));
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

    // Sales type distribution
    const salesTypeDistribution = {};
    for (const o of completedOrders) {
      const t = o.orderType || 'DINE_IN';
      salesTypeDistribution[t] = (salesTypeDistribution[t] || 0) + 1;
    }

    // Payment method distribution
    const paymentDistribution = {};
    for (const o of completedOrders) {
      const m = o.paymentMethod || 'CASH';
      paymentDistribution[m] = (paymentDistribution[m] || 0) + 1;
    }

    // Order source distribution
    const sourceDistribution = {};
    for (const o of completedOrders) {
      const s = o.source || 'POS';
      sourceDistribution[s] = (sourceDistribution[s] || 0) + 1;
    }

    // Top products
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

    const productsPerformance = topProducts.map(p => ({
      name: p.name,
      category: p.menuItemId ? (menuItemCategoryMap.get(p.menuItemId) || 'Uncategorized') : 'Uncategorized',
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

    // Allow descriptive UI roles; they are display-only and do not affect auth
    const allowedRoles = [
      'admin',
      'product_manager',
      'cashier',
      'manager',
      'kitchen_staff'
    ];
    if (role && !allowedRoles.includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
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
      const allowedRoles = [
        'admin',
        'product_manager',
        'cashier',
        'manager',
        'kitchen_staff'
      ];
      if (!allowedRoles.includes(role)) {
        return res.status(400).json({ message: 'Invalid role' });
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
// @desc    Delete a user for this restaurant (and branch assignments)
// @access  Restaurant Admin / Super Admin
router.delete('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const restaurantId = getRestaurantIdForRequest(req);

    const user = await User.findOne({ _id: id, restaurant: restaurantId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
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

    res.json({
      id: order._id.toString(),
      orderNumber: order.orderNumber,
      status: order.status,
    });
  } catch (error) {
    next(error);
  }
});

// TABLE MANAGEMENT ROUTES

const mapTable = (table) => ({
  id: table._id.toString(),
  tableNumber: table.tableNumber,
  capacity: table.capacity,
  location: table.location || '',
  status: table.status,
  qrCode: table.qrCode || '',
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

    const tables = await Table.find(query).sort({ tableNumber: 1 }).lean();
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
    const { tableNumber, capacity, location, status, qrCode } = req.body;

    if (!tableNumber || !tableNumber.trim()) {
      return res.status(400).json({ message: 'Table number is required' });
    }

    // Check for duplicate table number in same restaurant/branch
    const existing = await Table.findOne({
      restaurant: restaurantId,
      branch: branchId || null,
      tableNumber: tableNumber.trim(),
    });
    if (existing) {
      return res.status(400).json({ message: 'Table number already exists for this branch' });
    }

    const table = await Table.create({
      restaurant: restaurantId,
      branch: branchId || null,
      tableNumber: tableNumber.trim(),
      capacity: capacity || 4,
      location: (location || '').trim(),
      status: status || 'available',
      qrCode: (qrCode || '').trim(),
    });

    res.status(201).json(mapTable(table));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/tables/:id
// @desc    Update a table
// @access  Restaurant Admin
router.put('/tables/:id', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const table = await Table.findOne({ _id: req.params.id, restaurant: restaurantId });
    if (!table) {
      return res.status(404).json({ message: 'Table not found' });
    }

    const { tableNumber, capacity, location, status, qrCode } = req.body;
    if (tableNumber !== undefined) {
      const trimmed = tableNumber.trim();
      if (trimmed && trimmed !== table.tableNumber) {
        const duplicate = await Table.findOne({
          restaurant: restaurantId,
          branch: table.branch,
          tableNumber: trimmed,
          _id: { $ne: table._id },
        });
        if (duplicate) {
          return res.status(400).json({ message: 'Table number already exists for this branch' });
        }
        table.tableNumber = trimmed;
      }
    }
    if (capacity !== undefined) table.capacity = capacity;
    if (location !== undefined) table.location = (location || '').trim();
    if (status !== undefined) table.status = status;
    if (qrCode !== undefined) table.qrCode = (qrCode || '').trim();

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
