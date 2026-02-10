const express = require('express');
const MenuItem = require('../models/MenuItem');
const InventoryItem = require('../models/InventoryItem');
const Order = require('../models/Order');
const { protect, requireRole, requireRestaurant, requireActiveSubscription } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect, requireRole('staff', 'restaurant_admin'), requireRestaurant, requireActiveSubscription);

const generateOrderNumber = () => {
  const now = new Date();
  return `ORD-${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now
    .getDate()
    .toString()
    .padStart(2, '0')}-${now.getTime().toString().slice(-6)}`;
};

// @route   POST /api/pos/orders
// @desc    Create and complete a new POS order
// @access  Staff / Restaurant Admin
router.post('/orders', async (req, res, next) => {
  try {
    const { items, orderType, paymentMethod, discountAmount = 0 } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Order items are required' });
    }

    if (!['DINE_IN', 'TAKEAWAY'].includes(orderType)) {
      return res.status(400).json({ message: 'Invalid orderType' });
    }

    if (!['CASH', 'CARD'].includes(paymentMethod)) {
      return res.status(400).json({ message: 'Invalid paymentMethod' });
    }

    const menuItemIds = items.map((i) => i.menuItemId);
    const dbMenuItems = await MenuItem.find({
      _id: { $in: menuItemIds },
      restaurant: req.restaurant._id,
      available: true,
    });

    if (dbMenuItems.length !== items.length) {
      return res.status(400).json({ message: 'One or more items are invalid or unavailable' });
    }

    // Map for quick lookup
    const menuMap = new Map(dbMenuItems.map((m) => [m._id.toString(), m]));

    let subtotal = 0;
    const orderItems = items.map((i) => {
      const menu = menuMap.get(i.menuItemId);
      const quantity = Number(i.quantity) || 0;
      if (quantity <= 0) {
        throw new Error('Quantity must be greater than zero');
      }
      const lineTotal = menu.price * quantity;
      subtotal += lineTotal;

      return {
        menuItem: menu._id,
        name: menu.name,
        quantity,
        unitPrice: menu.price,
        lineTotal,
      };
    });

    const discount = Math.max(0, Number(discountAmount) || 0);
    const total = Math.max(0, subtotal - discount);

    // Inventory deduction
    const consumptionByInventoryId = new Map();
    for (const orderItem of orderItems) {
      const menu = menuMap.get(orderItem.menuItem.toString());
      if (!menu.inventoryConsumptions || menu.inventoryConsumptions.length === 0) continue;

      for (const cons of menu.inventoryConsumptions) {
        const needed = cons.quantity * orderItem.quantity;
        const key = cons.inventoryItem.toString();
        consumptionByInventoryId.set(key, (consumptionByInventoryId.get(key) || 0) + needed);
      }
    }

    if (consumptionByInventoryId.size > 0) {
      const inventoryIds = Array.from(consumptionByInventoryId.keys());
      const inventoryItems = await InventoryItem.find({
        _id: { $in: inventoryIds },
        restaurant: req.restaurant._id,
      });

      if (inventoryItems.length !== inventoryIds.length) {
        return res.status(400).json({ message: 'Inventory configuration invalid for one or more items' });
      }

      const insufficient = [];
      for (const inv of inventoryItems) {
        const required = consumptionByInventoryId.get(inv._id.toString());
        if (inv.currentStock < required && !req.restaurant.settings.allowOrderWhenOutOfStock) {
          insufficient.push({ itemId: inv._id, name: inv.name, required, available: inv.currentStock });
        }
      }

      if (insufficient.length > 0) {
        return res.status(400).json({
          message: 'Insufficient stock for one or more items',
          details: insufficient,
        });
      }

      // Deduct stock
      await Promise.all(
        inventoryItems.map((inv) => {
          const required = consumptionByInventoryId.get(inv._id.toString());
          inv.currentStock = Math.max(0, inv.currentStock - required);
          return inv.save();
        })
      );
    }

    const order = await Order.create({
      restaurant: req.restaurant._id,
      createdBy: req.user.id,
      orderType,
      paymentMethod,
      status: 'COMPLETED',
      items: orderItems,
      subtotal,
      discountAmount: discount,
      total,
      orderNumber: generateOrderNumber(),
    });

    res.status(201).json({
      id: order._id,
      orderNumber: order.orderNumber,
      subtotal: order.subtotal,
      discountAmount: order.discountAmount,
      total: order.total,
      createdAt: order.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/pos/orders/:id/cancel
// @desc    Cancel an order and reverse inventory deduction
// @access  Staff / Restaurant Admin
router.post('/orders/:id/cancel', async (req, res, next) => {
  try {
    const { id } = req.params;

    const order = await Order.findOne({
      _id: id,
      restaurant: req.restaurant._id,
      status: { $in: ['COMPLETED'] },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found or already cancelled' });
    }

    // Rebuild inventory consumption from the order items and current menu configuration
    const menuItemIds = Array.from(new Set(order.items.map((i) => i.menuItem.toString())));
    const menuItems = await MenuItem.find({
      _id: { $in: menuItemIds },
      restaurant: req.restaurant._id,
    });
    const menuMap = new Map(menuItems.map((m) => [m._id.toString(), m]));

    const consumptionByInventoryId = new Map();
    for (const orderItem of order.items) {
      const menu = menuMap.get(orderItem.menuItem.toString());
      if (!menu || !menu.inventoryConsumptions || menu.inventoryConsumptions.length === 0) continue;

      for (const cons of menu.inventoryConsumptions) {
        const qty = cons.quantity * orderItem.quantity;
        const key = cons.inventoryItem.toString();
        consumptionByInventoryId.set(key, (consumptionByInventoryId.get(key) || 0) + qty);
      }
    }

    if (consumptionByInventoryId.size > 0) {
      const inventoryIds = Array.from(consumptionByInventoryId.keys());
      const inventoryItems = await InventoryItem.find({
        _id: { $in: inventoryIds },
        restaurant: req.restaurant._id,
      });

      await Promise.all(
        inventoryItems.map((inv) => {
          const qty = consumptionByInventoryId.get(inv._id.toString()) || 0;
          inv.currentStock += qty;
          return inv.save();
        })
      );
    }

    order.status = 'CANCELLED';
    await order.save();

    res.json({
      id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

