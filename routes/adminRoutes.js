const express = require('express');
const Category = require('../models/Category');
const MenuItem = require('../models/MenuItem');
const InventoryItem = require('../models/InventoryItem');
const Order = require('../models/Order');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const { protect, requireRole, requireRestaurant, requireActiveSubscription } = require('../middleware/authMiddleware');

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

    req.restaurant = restaurant;
    return requireActiveSubscription(req, res, next);
  } catch (error) {
    return next(error);
  }
});

const getRestaurantIdForRequest = (req) => {
  if (req.user.role === 'super_admin' && req.query.restaurantId) {
    return req.query.restaurantId;
  }
  return req.restaurant?._id || req.user.restaurant;
};

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
  inventoryConsumptions: (item.inventoryConsumptions || []).map((c) => ({
    inventoryItem: c.inventoryItem.toString(),
    quantity: c.quantity,
  })),
});

const mapUser = (user) => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email,
  role: user.role,
  createdAt: user.createdAt.toISOString(),
});

// @route   GET /api/admin/menu
// @desc    Get all categories and menu items for a restaurant
// @access  Restaurant Admin / Super Admin
router.get('/menu', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);

    const [categories, items] = await Promise.all([
      Category.find({ restaurant: restaurantId }).sort({ createdAt: 1 }),
      MenuItem.find({ restaurant: restaurantId }),
    ]);

    res.json({
      categories: categories.map(mapCategory),
      items: items.map(mapMenuItem),
    });
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

    if (name !== undefined) category.name = name.trim();
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

// INVENTORY ROUTES

// @route   GET /api/admin/inventory
// @desc    List inventory items for a restaurant
// @access  Restaurant Admin / Super Admin
router.get('/inventory', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const items = await InventoryItem.find({ restaurant: restaurantId }).sort({ name: 1 });
    res.json(
      items.map((i) => ({
        id: i._id.toString(),
        name: i.name,
        unit: i.unit,
        currentStock: i.currentStock,
        lowStockThreshold: i.lowStockThreshold,
      }))
    );
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/inventory
// @desc    Create an inventory item
// @access  Restaurant Admin / Super Admin
router.post('/inventory', async (req, res, next) => {
  try {
    const { name, unit, initialStock, lowStockThreshold } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);

    if (!name || !unit) {
      return res.status(400).json({ message: 'Name and unit are required' });
    }

    const item = await InventoryItem.create({
      restaurant: restaurantId,
      name: name.trim(),
      unit,
      currentStock: initialStock ?? 0,
      lowStockThreshold: lowStockThreshold ?? 0,
    });

    res.status(201).json({
      id: item._id.toString(),
      name: item.name,
      unit: item.unit,
      currentStock: item.currentStock,
      lowStockThreshold: item.lowStockThreshold,
    });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/inventory/:id
// @desc    Update inventory item and/or adjust stock
// @access  Restaurant Admin / Super Admin
router.put('/inventory/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, unit, lowStockThreshold, stockAdjustment } = req.body;
    const restaurantId = getRestaurantIdForRequest(req);

    const item = await InventoryItem.findOne({ _id: id, restaurant: restaurantId });
    if (!item) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }

    if (name !== undefined) item.name = name.trim();
    if (unit !== undefined) item.unit = unit;
    if (lowStockThreshold !== undefined) item.lowStockThreshold = lowStockThreshold;
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
    });
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

    res.json(restaurant.website);
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
      openingHours,
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
    if (openingHours !== undefined) restaurant.website.openingHours = openingHours;

    await restaurant.save();

    res.json(restaurant.website);
  } catch (error) {
    next(error);
  }
});

// REPORTING & DASHBOARD ROUTES

// @route   GET /api/admin/reports/sales
// @desc    Get sales report for a date range
// @access  Restaurant Admin / Super Admin
router.get('/reports/sales', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const { from, to } = req.query;

    const fromDate = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
    const toDate = to ? new Date(to) : new Date(new Date().setHours(23, 59, 59, 999));

    const orders = await Order.find({
      restaurant: restaurantId,
      status: 'COMPLETED',
      createdAt: { $gte: fromDate, $lte: toDate },
    });

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

// @route   GET /api/admin/dashboard/summary
// @desc    Dashboard widgets: today’s revenue, orders count, low-stock items
// @access  Restaurant Admin / Super Admin
router.get('/dashboard/summary', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const [todayOrders, inventoryItems] = await Promise.all([
      Order.find({
        restaurant: restaurantId,
        status: 'COMPLETED',
        createdAt: { $gte: startOfDay, $lte: endOfDay },
      }),
      InventoryItem.find({ restaurant: restaurantId }),
    ]);

    const todaysRevenue = todayOrders.reduce((sum, o) => sum + o.total, 0);
    const todaysOrdersCount = todayOrders.length;

    const lowStockItems = inventoryItems
      .filter((i) => i.lowStockThreshold > 0 && i.currentStock <= i.lowStockThreshold)
      .map((i) => ({
        id: i._id.toString(),
        name: i.name,
        unit: i.unit,
        currentStock: i.currentStock,
        lowStockThreshold: i.lowStockThreshold,
      }));

    res.json({
      todaysRevenue,
      todaysOrdersCount,
      lowStockItems,
    });
  } catch (error) {
    next(error);
  }
});

// USER MANAGEMENT ROUTES

// @route   GET /api/admin/users
// @desc    List users for this restaurant
// @access  Restaurant Admin / Super Admin
router.get('/users', async (req, res, next) => {
  try {
    const restaurantId = getRestaurantIdForRequest(req);
    const users = await User.find({ restaurant: restaurantId }).sort({ createdAt: -1 });
    res.json(users.map(mapUser));
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/users
// @desc    Create a new staff user for this restaurant
// @access  Restaurant Admin / Super Admin
router.post('/users', async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
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
      restaurant: restaurantId,
    });

    res.status(201).json(mapUser(user));
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/users/:id
// @desc    Update a user for this restaurant
// @access  Restaurant Admin / Super Admin
router.put('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, email, password, role } = req.body;
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

    await user.save();

    res.json(mapUser(user));
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/admin/users/:id
// @desc    Delete a user for this restaurant
// @access  Restaurant Admin / Super Admin
router.delete('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const restaurantId = getRestaurantIdForRequest(req);

    const user = await User.findOne({ _id: id, restaurant: restaurantId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    await User.deleteOne({ _id: id, restaurant: restaurantId });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;

