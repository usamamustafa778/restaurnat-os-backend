const express = require('express');
const Integration = require('../models/Integration');
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const InventoryItem = require('../models/InventoryItem');
const Restaurant = require('../models/Restaurant');
const { protect, requireRole, requireRestaurant, requireActiveSubscription } = require('../middleware/authMiddleware');

const router = express.Router();

// ────────────────────────────────────────────────────────────────────────────────
// AUTHENTICATED ROUTES – restaurant_admin only
// ────────────────────────────────────────────────────────────────────────────────

const authMiddleware = [
  protect,
  requireRole('restaurant_admin', 'admin'),
  requireRestaurant,
  requireActiveSubscription,
];

const mapIntegration = (doc) => ({
  id: doc._id.toString(),
  restaurantId: doc.restaurant.toString(),
  platform: doc.platform,
  storeId: doc.storeId || '',
  apiKey: doc.apiKey ? '••••' + doc.apiKey.slice(-4) : '',
  apiSecret: doc.apiSecret ? '••••' + doc.apiSecret.slice(-4) : '',
  isActive: doc.isActive,
  lastSyncAt: doc.lastSyncAt,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

// @route   GET /api/integrations
// @desc    List all integrations for this restaurant
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const docs = await Integration.find({ restaurant: req.restaurant._id }).sort({ platform: 1 });
    res.json(docs.map(mapIntegration));
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/integrations
// @desc    Create or update an integration
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const { platform, storeId, apiKey, apiSecret } = req.body;

    if (!platform || !['FOODPANDA'].includes(platform)) {
      return res.status(400).json({ message: 'Invalid platform. Supported: FOODPANDA' });
    }

    let doc = await Integration.findOne({
      restaurant: req.restaurant._id,
      platform,
    });

    if (doc) {
      // Update existing
      if (storeId !== undefined) doc.storeId = storeId;
      if (apiKey !== undefined) doc.apiKey = apiKey;
      if (apiSecret !== undefined) doc.apiSecret = apiSecret;
      await doc.save();
    } else {
      doc = await Integration.create({
        restaurant: req.restaurant._id,
        platform,
        storeId: storeId || '',
        apiKey: apiKey || '',
        apiSecret: apiSecret || '',
        isActive: false,
      });
    }

    res.json(mapIntegration(doc));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Integration for this platform already exists' });
    }
    next(error);
  }
});

// @route   PUT /api/integrations/:id/toggle
// @desc    Toggle integration active/inactive
router.put('/:id/toggle', authMiddleware, async (req, res, next) => {
  try {
    const doc = await Integration.findOne({
      _id: req.params.id,
      restaurant: req.restaurant._id,
    });

    if (!doc) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    // Validate credentials before activating
    if (!doc.isActive) {
      if (!doc.storeId || !doc.apiKey || !doc.apiSecret) {
        return res.status(400).json({
          message: 'Please provide Store ID, API Key, and API Secret before activating',
        });
      }
    }

    doc.isActive = !doc.isActive;
    await doc.save();

    res.json(mapIntegration(doc));
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/integrations/:id
// @desc    Delete an integration
router.delete('/:id', authMiddleware, async (req, res, next) => {
  try {
    const doc = await Integration.findOneAndDelete({
      _id: req.params.id,
      restaurant: req.restaurant._id,
    });

    if (!doc) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/integrations/test-order
// @desc    Create a test Foodpanda order (uses JWT auth, no API key needed)
router.post('/test-order', authMiddleware, async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;

    const integration = await Integration.findOne({
      restaurant: restaurantId,
      platform: 'FOODPANDA',
      isActive: true,
    });

    if (!integration) {
      return res.status(404).json({ message: 'No active Foodpanda integration found' });
    }

    const {
      externalOrderId,
      customerName,
      customerPhone,
      deliveryAddress,
      items,
      paymentMethod,
      total,
      subtotal,
      discountAmount,
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'items are required' });
    }

    const extId = externalOrderId || `FP-TEST-${Date.now()}`;

    // Check duplicate
    const existing = await Order.findOne({ restaurant: restaurantId, externalOrderId: extId, source: 'FOODPANDA' });
    if (existing) {
      return res.status(409).json({ message: 'Order already exists', orderNumber: existing.orderNumber });
    }

    // Map items
    const menuItems = await MenuItem.find({ restaurant: restaurantId }).lean();
    const orderItems = items.map((extItem) => {
      const match = menuItems.find(
        (m) => m.name.toLowerCase().trim() === (extItem.name || '').toLowerCase().trim()
      );
      return {
        menuItem: match ? match._id : null,
        name: extItem.name || 'Unknown item',
        quantity: extItem.quantity || 1,
        unitPrice: extItem.unitPrice || 0,
        lineTotal: (extItem.unitPrice || 0) * (extItem.quantity || 1),
      };
    });

    const computedSubtotal = subtotal || orderItems.reduce((s, i) => s + i.lineTotal, 0);
    const computedTotal = total || computedSubtotal - (discountAmount || 0);

    // Deduct inventory
    for (const oi of orderItems) {
      if (!oi.menuItem) continue;
      const mi = menuItems.find((m) => m._id.toString() === oi.menuItem.toString());
      if (!mi || !mi.inventoryConsumptions) continue;
      for (const c of mi.inventoryConsumptions) {
        await InventoryItem.findByIdAndUpdate(c.inventoryItem, {
          $inc: { currentStock: -(c.quantity * oi.quantity) },
        });
      }
    }

    const order = await Order.create({
      restaurant: restaurantId,
      createdBy: null,
      orderType: 'DELIVERY',
      paymentMethod: paymentMethod || 'ONLINE',
      status: 'UNPROCESSED',
      source: 'FOODPANDA',
      externalOrderId: extId,
      customerName: customerName || 'Test Customer',
      customerPhone: customerPhone || '',
      deliveryAddress: deliveryAddress || '',
      items: orderItems,
      subtotal: computedSubtotal,
      discountAmount: discountAmount || 0,
      total: computedTotal,
      orderNumber: await generateOrderNumber(restaurantId),
    });

    integration.lastSyncAt = new Date();
    await integration.save();

    res.status(201).json({
      message: 'Test order created',
      orderNumber: order.orderNumber,
      orderId: order._id.toString(),
    });
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// WEBHOOK – Foodpanda pushes orders here (no JWT auth, uses apiKey verification)
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Generate a sequential order number: ORD-YYYYMMDD-0001, 0002, etc.
 */
const generateOrderNumber = async (restaurantId) => {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${(now.getMonth() + 1)
    .toString()
    .padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
  const prefix = `ORD-${dateStr}-`;

  const lastOrder = await Order.findOne({
    restaurant: restaurantId,
    orderNumber: { $regex: `^${prefix}` },
  })
    .sort({ orderNumber: -1 })
    .select('orderNumber')
    .lean();

  let nextSeq = 1;
  if (lastOrder && lastOrder.orderNumber) {
    const lastSeq = parseInt(lastOrder.orderNumber.split('-').pop(), 10);
    if (!isNaN(lastSeq)) {
      nextSeq = lastSeq + 1;
    }
  }

  return `${prefix}${nextSeq.toString().padStart(4, '0')}`;
};

// @route   POST /api/webhooks/foodpanda/:restaurantId
// @desc    Receive a Foodpanda order (webhook / manual sync)
// @access  Verified by API key in header
router.post('/webhooks/foodpanda/:restaurantId', async (req, res, next) => {
  try {
    const { restaurantId } = req.params;

    // Find active Foodpanda integration for this restaurant
    const integration = await Integration.findOne({
      restaurant: restaurantId,
      platform: 'FOODPANDA',
      isActive: true,
    });

    if (!integration) {
      return res.status(404).json({ message: 'Foodpanda integration not found or inactive' });
    }

    // Verify API key (sent in x-api-key header)
    const providedKey = req.headers['x-api-key'] || '';
    if (providedKey !== integration.apiKey) {
      return res.status(401).json({ message: 'Invalid API key' });
    }

    const {
      externalOrderId,
      customerName,
      customerPhone,
      deliveryAddress,
      items,         // [{ name, quantity, unitPrice }]
      paymentMethod, // "CASH" | "ONLINE" | "CARD"
      total,
      subtotal,
      discountAmount,
    } = req.body;

    if (!externalOrderId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'externalOrderId and items are required' });
    }

    // Prevent duplicates
    const existing = await Order.findOne({
      restaurant: restaurantId,
      externalOrderId,
      source: 'FOODPANDA',
    });

    if (existing) {
      return res.status(409).json({
        message: 'Order already exists',
        orderNumber: existing.orderNumber,
      });
    }

    // Try to map items to local menu items by name (best-effort)
    const menuItems = await MenuItem.find({ restaurant: restaurantId }).lean();
    const orderItems = items.map((extItem) => {
      const match = menuItems.find(
        (m) => m.name.toLowerCase().trim() === (extItem.name || '').toLowerCase().trim()
      );
      return {
        menuItem: match ? match._id : null,
        name: extItem.name || 'Unknown item',
        quantity: extItem.quantity || 1,
        unitPrice: extItem.unitPrice || 0,
        lineTotal: (extItem.unitPrice || 0) * (extItem.quantity || 1),
      };
    });

    const computedSubtotal = subtotal || orderItems.reduce((s, i) => s + i.lineTotal, 0);
    const computedTotal = total || computedSubtotal - (discountAmount || 0);

    // Deduct inventory for matched items
    for (const oi of orderItems) {
      if (!oi.menuItem) continue;
      const menuItem = menuItems.find((m) => m._id.toString() === oi.menuItem.toString());
      if (!menuItem || !menuItem.inventoryConsumptions) continue;

      for (const consumption of menuItem.inventoryConsumptions) {
        const deduction = consumption.quantity * oi.quantity;
        await InventoryItem.findByIdAndUpdate(consumption.inventoryItem, {
          $inc: { currentStock: -deduction },
        });
      }
    }

    const order = await Order.create({
      restaurant: restaurantId,
      createdBy: null,
      orderType: 'DELIVERY',
      paymentMethod: paymentMethod || 'ONLINE',
      status: 'UNPROCESSED',
      source: 'FOODPANDA',
      externalOrderId,
      customerName: customerName || '',
      customerPhone: customerPhone || '',
      deliveryAddress: deliveryAddress || '',
      items: orderItems,
      subtotal: computedSubtotal,
      discountAmount: discountAmount || 0,
      total: computedTotal,
      orderNumber: await generateOrderNumber(restaurantId),
    });

    // Update last sync time
    integration.lastSyncAt = new Date();
    await integration.save();

    res.status(201).json({
      message: 'Order created',
      orderNumber: order.orderNumber,
      orderId: order._id.toString(),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
