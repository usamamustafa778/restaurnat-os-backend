const express = require('express');
const Category = require('../models/Category');
const MenuItem = require('../models/MenuItem');
const InventoryItem = require('../models/InventoryItem');
const BranchMenuItem = require('../models/BranchMenuItem');
const Customer = require('../models/Customer');
const Restaurant = require('../models/Restaurant');
const Order = require('../models/Order');
const Branch = require('../models/Branch');

const router = express.Router();

// @route   GET /api/
// @desc    Simple API root
// @access  Public
router.get('/', (req, res) => {
  res.json({ message: 'RestaurantOS public API is working' });
});

// Helper to resolve restaurant from subdomain or id
const resolveRestaurant = async (req) => {
  const { subdomain, restaurantId } = req.query;

  if (restaurantId) {
    return Restaurant.findById(restaurantId);
  }

  if (subdomain) {
    return Restaurant.findOne({ 'website.subdomain': subdomain.toLowerCase().trim() });
  }

  return null;
};

// @route   GET /api/menu
// @desc    Public menu for a restaurant website
// @access  Public
router.get('/menu', async (req, res, next) => {
  try {
    const restaurant = await resolveRestaurant(req);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    // Block public website for suspended subscriptions
    if (restaurant.subscription?.status === 'SUSPENDED') {
      return res.status(403).json({ message: 'Subscription inactive or expired' });
    }

    if (!restaurant.website?.isPublic) {
      return res.status(403).json({ message: 'Restaurant website is not public' });
    }

    const [categories, allItems, inventoryItems] = await Promise.all([
      Category.find({ restaurant: restaurant._id, isActive: true }).sort({ createdAt: 1 }),
      MenuItem.find({ restaurant: restaurant._id, available: true, showOnWebsite: true }).populate('category'),
      InventoryItem.find({ restaurant: restaurant._id }),
    ]);

    // Build inventory lookup for sufficiency check
    const inventoryMap = new Map();
    for (const inv of inventoryItems) {
      inventoryMap.set(inv._id.toString(), inv);
    }

    // Filter out items with insufficient inventory
    function hasEnoughInventory(menuItem) {
      if (!menuItem.inventoryConsumptions || menuItem.inventoryConsumptions.length === 0) return true;
      for (const consumption of menuItem.inventoryConsumptions) {
        const invId = consumption.inventoryItem ? consumption.inventoryItem.toString() : null;
        if (!invId) continue;
        const inv = inventoryMap.get(invId);
        if (!inv) continue;
        const needed = consumption.quantity || 0;
        if (needed > 0 && inv.currentStock < needed) return false;
      }
      return true;
    }

    const items = allItems.filter(hasEnoughInventory);

    // Populate website sections with full menu item data
    const rawSections = restaurant.website?.websiteSections || [];
    const websiteSections = [];
    for (const section of rawSections) {
      if (!section.isActive) continue;
      const sectionItemIds = (section.items || []).map((id) => id.toString());
      const sectionItems = await MenuItem.find({
        _id: { $in: sectionItemIds },
        restaurant: restaurant._id,
        available: true,
        showOnWebsite: true,
      }).populate('category');

      // Also filter section items by inventory sufficiency
      const filteredSectionItems = sectionItems.filter(hasEnoughInventory);

      websiteSections.push({
        title: section.title || '',
        subtitle: section.subtitle || '',
        items: filteredSectionItems.map((item) => ({
          id: item._id.toString(),
          name: item.name,
          description: item.description || item.category?.description || '',
          price: item.price,
          category: item.category?.name || 'Uncategorized',
          imageUrl: item.imageUrl,
        })),
      });
    }

    // Apply branch overrides if branchId query param is present
    const requestedBranchId = req.query.branchId;
    let overrideMap = new Map();
    if (requestedBranchId) {
      const overrides = await BranchMenuItem.find({ branch: requestedBranchId }).lean();
      for (const o of overrides) {
        overrideMap.set(o.menuItem.toString(), o);
      }
    }

    // Filter items by branch availability if a branch is selected
    const branchFilteredItems = requestedBranchId
      ? items.filter((item) => {
          const override = overrideMap.get(item._id.toString());
          return override ? override.available !== false : true;
        })
      : items;

    const response = branchFilteredItems.map((item) => {
      const override = overrideMap.get(item._id.toString());
      return {
        id: item._id.toString(),
        name: item.name,
        description: item.description || item.category?.description || '',
        price: override?.priceOverride != null ? override.priceOverride : item.price,
        category: item.category?.name || 'Uncategorized',
        imageUrl: item.imageUrl,
        isFeatured: item.isFeatured || false,
        isBestSeller: item.isBestSeller || false,
        tags: [],
      };
    });

    const branches = await Branch.find({ restaurant: restaurant._id, status: 'active' })
      .sort({ sortOrder: 1, createdAt: 1 })
      .select('name code address contactPhone contactEmail openingHours')
      .lean();
    const branchesPayload = branches.map((b) => ({
      id: b._id.toString(),
      name: b.name,
      code: b.code || '',
      address: b.address || '',
      contactPhone: b.contactPhone || '',
      contactEmail: b.contactEmail || '',
      openingHours: b.openingHours || {},
    }));

    res.json({
      restaurant: {
        name: restaurant.website?.name,
        description: restaurant.website?.description,
        tagline: restaurant.website?.tagline,
        logoUrl: restaurant.website?.logoUrl,
        bannerUrl: restaurant.website?.bannerUrl,
        contactPhone: restaurant.website?.contactPhone,
        contactEmail: restaurant.website?.contactEmail,
        address: restaurant.website?.address,
        subdomain: restaurant.website?.subdomain,
        heroSlides: restaurant.website?.heroSlides || [],
        socialMedia: restaurant.website?.socialMedia || {},
        themeColors: restaurant.website?.themeColors || { primary: '#EF4444', secondary: '#FFA500' },
        openingHoursText: restaurant.website?.openingHoursText || '',
        websiteSections,
        allowWebsiteOrders: restaurant.website?.allowWebsiteOrders !== false,
      },
      menu: response,
      categories: categories.map((c) => ({
        id: c._id.toString(),
        name: c.name,
        description: c.description || '',
      })),
      branches: branchesPayload,
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/orders/website
// @desc    Place an order from the public website (Cash on Delivery); branchId required when restaurant has branches
// @access  Public
router.post('/orders/website', async (req, res, next) => {
  try {
    const { subdomain, customerName, customerPhone, deliveryAddress, items, branchId } = req.body;

    if (!subdomain) {
      return res.status(400).json({ message: 'Restaurant subdomain is required' });
    }
    if (!customerPhone || !customerPhone.trim()) {
      return res.status(400).json({ message: 'Phone number is required' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'At least one item is required' });
    }

    const restaurant = await Restaurant.findOne({ 'website.subdomain': subdomain.toLowerCase().trim() });
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    let branch = null;
    const branchCount = await Branch.countDocuments({ restaurant: restaurant._id });
    if (branchCount > 0) {
      if (!branchId) {
        return res.status(400).json({ message: 'branchId is required when restaurant has branches' });
      }
      branch = await Branch.findOne({ _id: branchId, restaurant: restaurant._id });
      if (!branch) {
        return res.status(400).json({ message: 'Invalid branchId for this restaurant' });
      }
    } else if (branchId) {
      branch = await Branch.findOne({ _id: branchId, restaurant: restaurant._id });
    }

    if (restaurant.subscription?.status === 'SUSPENDED') {
      return res.status(403).json({ message: 'Subscription inactive or expired' });
    }

    if (restaurant.website?.allowWebsiteOrders === false) {
      return res.status(403).json({ message: 'Online ordering is temporarily unavailable. Please contact the restaurant directly.' });
    }

    // Validate and build order items
    const menuItemIds = items.map(i => i.menuItemId);
    const menuItems = await MenuItem.find({
      _id: { $in: menuItemIds },
      restaurant: restaurant._id,
      available: true,
    });

    const menuItemMap = {};
    for (const mi of menuItems) {
      menuItemMap[mi._id.toString()] = mi;
    }

    let subtotal = 0;
    const orderItems = [];

    for (const cartItem of items) {
      const mi = menuItemMap[cartItem.menuItemId];
      if (!mi) {
        return res.status(400).json({ message: `Menu item not found or unavailable: ${cartItem.menuItemId}` });
      }
      const qty = Math.max(1, parseInt(cartItem.quantity) || 1);
      const lineTotal = mi.price * qty;
      subtotal += lineTotal;
      orderItems.push({
        menuItem: mi._id,
        name: mi.name,
        quantity: qty,
        unitPrice: mi.price,
        lineTotal,
      });
    }

    // Generate order number using local date
    const now = new Date();
    const todayStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const count = await Order.countDocuments({ restaurant: restaurant._id });
    const orderNumber = `WEB-${todayStr}-${String(count + 1).padStart(4, '0')}`;

    // Upsert customer record
    try {
      await Customer.findOneAndUpdate(
        { restaurant: restaurant._id, branch: branch ? branch._id : null, phone: customerPhone.trim() },
        {
          $set: {
            name: (customerName || '').trim() || 'Website Customer',
            address: (deliveryAddress || '').trim(),
            lastOrderAt: new Date(),
          },
          $inc: { totalOrders: 1, totalSpent: subtotal },
          $setOnInsert: {
            restaurant: restaurant._id,
            branch: branch ? branch._id : null,
            phone: customerPhone.trim(),
          },
        },
        { upsert: true }
      );
    } catch (_) { /* non-critical */ }

    const order = await Order.create({
      restaurant: restaurant._id,
      branch: branch ? branch._id : undefined,
      orderType: 'DELIVERY',
      paymentMethod: 'CASH',
      source: 'WEBSITE',
      status: 'UNPROCESSED',
      customerName: (customerName || '').trim() || 'Website Customer',
      customerPhone: customerPhone.trim(),
      deliveryAddress: (deliveryAddress || '').trim(),
      items: orderItems,
      subtotal,
      discountAmount: 0,
      total: subtotal,
      orderNumber,
    });

    res.status(201).json({
      message: 'Order placed successfully!',
      orderNumber: order.orderNumber,
      total: order.total,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

