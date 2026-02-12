const express = require('express');
const MenuItem = require('../models/MenuItem');
const InventoryItem = require('../models/InventoryItem');
const BranchInventory = require('../models/BranchInventory');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Branch = require('../models/Branch');
const { protect, requireRole, requireRestaurant, checkSubscriptionStatus } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect, requireRole('staff', 'restaurant_admin', 'admin', 'cashier', 'manager', 'product_manager', 'kitchen_staff'), requireRestaurant, checkSubscriptionStatus);

/**
 * Generate a sequential order number: ORD-YYYYMMDD-0001, 0002, etc.
 * Resets to 0001 each new day per restaurant.
 */
const generateOrderNumber = async (restaurantId) => {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${(now.getMonth() + 1)
    .toString()
    .padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
  const prefix = `ORD-${dateStr}-`;

  // Find the last order for this restaurant with today's date prefix
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

// @route   POST /api/pos/orders
// @desc    Create and complete a new POS order (branchId required when restaurant has branches)
// @access  Staff / Restaurant Admin
router.post('/orders', async (req, res, next) => {
  try {
    const { items, orderType, paymentMethod, discountAmount = 0, customerName = '', customerPhone = '', deliveryAddress = '', branchId, tableNumber, tableId } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Order items are required' });
    }

    const restaurantId = req.restaurant._id;
    const branchCount = await Branch.countDocuments({ restaurant: restaurantId });
    let branch = null;
    if (branchCount > 0) {
      if (!branchId) {
        return res.status(400).json({ message: 'branchId is required when restaurant has branches' });
      }
      branch = await Branch.findOne({ _id: branchId, restaurant: restaurantId });
      if (!branch) {
        return res.status(400).json({ message: 'Invalid branchId for this restaurant' });
      }
    } else if (branchId) {
      branch = await Branch.findOne({ _id: branchId, restaurant: restaurantId });
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

    // Inventory deduction (branch-aware)
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

      if (branch) {
        // Branch-level stock deduction
        const branchInvRows = await BranchInventory.find({ branch: branch._id, inventoryItem: { $in: inventoryIds } });
        const branchInvMap = new Map(branchInvRows.map((r) => [r.inventoryItem.toString(), r]));
        // Also load item names for error messages
        const itemDefs = await InventoryItem.find({ _id: { $in: inventoryIds }, restaurant: req.restaurant._id });
        const itemNameMap = new Map(itemDefs.map((d) => [d._id.toString(), d.name]));

        const insufficient = [];
        for (const [invId, required] of consumptionByInventoryId.entries()) {
          const brRow = branchInvMap.get(invId);
          const available = brRow ? brRow.currentStock : 0;
          if (available < required && !req.restaurant.settings.allowOrderWhenOutOfStock) {
            insufficient.push({ itemId: invId, name: itemNameMap.get(invId) || 'Unknown', required, available });
          }
        }
        if (insufficient.length > 0) {
          return res.status(400).json({ message: 'Insufficient stock for one or more items', details: insufficient });
        }
        // Deduct from BranchInventory
        await Promise.all(
          Array.from(consumptionByInventoryId.entries()).map(async ([invId, required]) => {
            await BranchInventory.findOneAndUpdate(
              { branch: branch._id, inventoryItem: invId },
              { $inc: { currentStock: -required } },
              { upsert: false }
            );
          })
        );
      } else {
        // Restaurant-level stock deduction (legacy/no branches)
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
          return res.status(400).json({ message: 'Insufficient stock for one or more items', details: insufficient });
        }
        // Deduct stock from InventoryItem
        await Promise.all(
          inventoryItems.map((inv) => {
            const required = consumptionByInventoryId.get(inv._id.toString());
            inv.currentStock = Math.max(0, inv.currentStock - required);
            return inv.save();
          })
        );
      }
    }

    // Upsert customer record for this order
    if (customerPhone && customerPhone.trim()) {
      try {
        await Customer.findOneAndUpdate(
          { restaurant: req.restaurant._id, branch: branch ? branch._id : null, phone: customerPhone.trim() },
          {
            $set: { name: customerName || 'Walk-in Customer', lastOrderAt: new Date() },
            $inc: { totalOrders: 1, totalSpent: total },
            $setOnInsert: { restaurant: req.restaurant._id, branch: branch ? branch._id : null, phone: customerPhone.trim() },
          },
          { upsert: true }
        );
      } catch (_) { /* non-critical */ }
    }

    const order = await Order.create({
      restaurant: req.restaurant._id,
      branch: branch ? branch._id : undefined,
      table: tableId || undefined,
      tableNumber: (tableNumber || '').trim(),
      createdBy: req.user.id,
      orderType,
      paymentMethod,
      status: 'UNPROCESSED',
      items: orderItems,
      subtotal,
      discountAmount: discount,
      total,
      customerName: customerName || '',
      customerPhone: customerPhone || '',
      deliveryAddress: deliveryAddress || '',
      orderNumber: await generateOrderNumber(req.restaurant._id),
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
      status: { $in: ['UNPROCESSED', 'PENDING', 'READY', 'COMPLETED'] },
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

      if (order.branch) {
        // Reverse BranchInventory
        await Promise.all(
          Array.from(consumptionByInventoryId.entries()).map(async ([invId, qty]) => {
            await BranchInventory.findOneAndUpdate(
              { branch: order.branch, inventoryItem: invId },
              { $inc: { currentStock: qty } },
              { upsert: false }
            );
          })
        );
      } else {
        // Reverse restaurant-level InventoryItem
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

