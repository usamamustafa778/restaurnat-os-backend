const express = require('express');
const mongoose = require('mongoose');
const MenuItem = require('../models/MenuItem');
const InventoryItem = require('../models/InventoryItem');
const BranchInventory = require('../models/BranchInventory');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Branch = require('../models/Branch');
const Table = require('../models/Table');
const PosDraft = require('../models/PosDraft');
const DaySession = require('../models/DaySession');
const Deal = require('../models/Deal');
const { protect, requireRole, requireRestaurant, checkSubscriptionStatus } = require('../middleware/authMiddleware');
const { generateOrderNumber } = require('../utils/orderNumber');
const { mergedDeliveryLocations, pickDeliveryLocation } = require('../utils/deliveryLocations');
const { getOrderRooms } = require('../utils/socketRooms');
const CLOSED_ORDER_STATUSES = ['DELIVERED', 'COMPLETED'];
const PAID_ORDER_MATCH = {
  $or: [
    { source: 'FOODPANDA' },
    {
      $expr: {
        $gte: [
          {
            $subtract: [
              { $ifNull: ['$paymentAmountReceived', 0] },
              { $ifNull: ['$paymentAmountReturned', 0] },
            ],
          },
          {
            $add: [
              { $ifNull: ['$total', 0] },
              { $ifNull: ['$deliveryCharges', 0] },
            ],
          },
        ],
      },
    },
    { paymentMethod: { $in: ['CASH', 'CARD', 'ONLINE', 'SPLIT', 'FOODPANDA'] } },
    { $and: [{ orderType: 'DELIVERY' }, { deliveryPaymentCollected: true }] },
  ],
};

function getExpectedSessionEndAt(startAt, cutoffHour = 4) {
  const start = new Date(startAt);
  const end = new Date(start);
  end.setHours(cutoffHour, 0, 0, 0);
  if (start >= end) end.setDate(end.getDate() + 1);
  return end;
}

function buildSessionKey(startAt, endAt) {
  const fmt = (d) =>
    d.toLocaleString('en-PK', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  return `${fmt(startAt)} - ${fmt(endAt)}`;
}

function isOrderPaid(order) {
  if (!order) return false;
  if (order.source === 'FOODPANDA') return true;
  if (order.paymentAmountReceived != null) {
    const gross = Number(order.paymentAmountReceived) || 0;
    const returned = Number(order.paymentAmountReturned) || 0;
    const totalDue = Number(order.grandTotal ?? order.total ?? 0) || 0;
    if (gross - returned >= totalDue) return true;
  }
  const pm = String(order.paymentMethod || '').toUpperCase();
  if (pm === 'CASH' || pm === 'CARD' || pm === 'ONLINE' || pm === 'SPLIT' || pm === 'FOODPANDA') return true;
  if (String(order.orderType || '').toUpperCase() === 'DELIVERY' && order.deliveryPaymentCollected === true) return true;
  return false;
}

async function closeSessionIfPastCutoff(session, cutoffHour, closedBy = null, now = new Date()) {
  if (!session || session.status !== 'OPEN') return { closed: false, session };
  const expectedEndAt = getExpectedSessionEndAt(session.startAt, cutoffHour);
  if (now < expectedEndAt) return { closed: false, session };
  session.status = 'CLOSED';
  session.endAt = expectedEndAt;
  session.closedBy = closedBy || null;
  session.sessionKey = buildSessionKey(session.startAt, session.endAt);
  await session.save();
  return { closed: true, session };
}

async function resolveBranchAndCutoff(restaurantId, branchId) {
  if (!branchId) return { branch: null, cutoffHour: 4 };
  const branch = await Branch.findOne({ _id: branchId, restaurant: restaurantId });
  if (!branch) return { branch: null, cutoffHour: 4, invalid: true };
  return { branch, cutoffHour: branch.businessDayCutoffHour ?? 4 };
}

async function getLastCompletedOrderAt({ restaurantId, sessionId }) {
  const last = await Order.findOne({
    restaurant: restaurantId,
    daySession: sessionId,
    status: { $in: ['DELIVERED', 'COMPLETED'] },
  })
    .sort({ createdAt: -1 })
    .select({ createdAt: 1 })
    .lean();
  return last?.createdAt ? new Date(last.createdAt) : null;
}

// Returns existing OPEN session or auto-creates a new one (no manual start needed)
async function getOrCreateCurrentSession(restaurantId, branch, userId) {
  const branchId = branch ? branch._id : null;
  const cutoffHour = branch?.businessDayCutoffHour ?? 4;
  let session = await DaySession.findOne({ restaurant: restaurantId, branch: branchId, status: 'OPEN' });
  if (session) {
    await closeSessionIfPastCutoff(session, cutoffHour, null);
    if (session.status === 'CLOSED') session = null;
  }
  if (!session) {
    session = await DaySession.create({
      restaurant: restaurantId,
      branch: branchId,
      status: 'OPEN',
      startAt: new Date(),
      openedBy: userId || null,
    });
  }
  return session;
}

const router = express.Router();

router.use(protect, requireRole('super_admin', 'staff', 'restaurant_admin', 'admin', 'cashier', 'manager', 'product_manager', 'kitchen_staff', 'order_taker', 'delivery_rider'), requireRestaurant, checkSubscriptionStatus);

// Cost per single unit of a menu item from inventory consumptions (costPrice per 1000g/1000ml/12pc)
function getMenuItemIngredientCost(menuItem, inventoryMap) {
  if (!menuItem?.inventoryConsumptions?.length) return 0;
  let cost = 0;
  for (const c of menuItem.inventoryConsumptions) {
    const invId = c.inventoryItem?.toString?.();
    if (!invId) continue;
    const inv = inventoryMap.get(invId);
    if (!inv || inv.costPrice == null) continue;
    const qty = c.quantity || 0;
    const unit = (inv.unit || '').toLowerCase();
    if (unit === 'gram' || unit === 'kg') cost += (qty / 1000) * inv.costPrice;
    else if (unit === 'ml' || unit === 'liter') cost += (qty / 1000) * inv.costPrice;
    else if (unit === 'piece') cost += (qty / 12) * inv.costPrice;
  }
  return cost;
}

// @route   POST /api/pos/orders
// @desc    Create and complete a new POS order (branchId required when restaurant has branches)
// @access  Staff / Restaurant Admin
router.post('/orders', async (req, res, next) => {
  try {
    const {
      items,
      orderType,
      paymentMethod,
      paymentProvider,
      discountAmount = 0,
      customerName = '',
      customerPhone = '',
      deliveryAddress = '',
      deliveryLocationId,
      branchId,
      tableNumber,
      tableId,
      tableName,
      amountReceived,
    } = req.body;

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

    if (!['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(orderType)) {
      return res.status(400).json({ message: 'Invalid orderType' });
    }

    // Payment taken at counter: CASH, CARD, or ONLINE => paid at creation; otherwise PENDING
    const orderPaymentMethod = (paymentMethod === 'CASH' || paymentMethod === 'CARD' || paymentMethod === 'ONLINE') ? paymentMethod : 'PENDING';
    if (orderPaymentMethod === 'ONLINE' && (!paymentProvider || !String(paymentProvider).trim())) {
      return res.status(400).json({ message: 'paymentProvider is required when paymentMethod is ONLINE' });
    }

    // Separate regular menu items from deal items (deal items have a "deal-" prefix)
    const regularItems = items.filter((i) => !String(i.menuItemId).startsWith('deal-'));
    const dealLineItems = items.filter((i) => String(i.menuItemId).startsWith('deal-'));

    // Fetch regular menu items
    const menuItemIds = regularItems.map((i) => i.menuItemId);
    const dbMenuItems = menuItemIds.length > 0
      ? await MenuItem.find({ _id: { $in: menuItemIds }, restaurant: req.restaurant._id, available: true })
      : [];

    if (dbMenuItems.length !== regularItems.length) {
      return res.status(400).json({ message: 'One or more items are invalid or unavailable' });
    }

    // Fetch and expand deal items
    const appliedDeals = [];
    let dealDiscount = 0;
    const dealExpandedMenuItems = []; // MenuItem docs from deal expansions (for inventory)

    if (dealLineItems.length > 0) {
      const dealIds = dealLineItems.map((i) => String(i.menuItemId).replace(/^deal-/, ''));
      const dbDeals = await Deal.find({
        _id: { $in: dealIds },
        restaurant: req.restaurant._id,
        isActive: true,
      }).populate({
        path: 'comboItems.menuItem',
        model: 'MenuItem',
        select: '_id name price inventoryConsumptions available',
      });

      const dealMap = new Map(dbDeals.map((d) => [d._id.toString(), d]));

      for (const dealLine of dealLineItems) {
        const dealId = String(dealLine.menuItemId).replace(/^deal-/, '');
        const deal = dealMap.get(dealId);
        const dealQty = Number(dealLine.quantity) || 1;

        if (!deal) {
          return res.status(400).json({ message: `Deal not found or inactive: ${dealLine.menuItemId}` });
        }
        if (!deal.isCurrentlyValid) {
          return res.status(400).json({ message: `Deal "${deal.name}" is not currently available` });
        }
        if (deal.dealType !== 'COMBO') {
          return res.status(400).json({ message: `Only COMBO deals can be added as order line items (deal: "${deal.name}")` });
        }
        if (!deal.comboItems || deal.comboItems.length === 0) {
          return res.status(400).json({ message: `Combo deal "${deal.name}" has no items configured` });
        }

        // Calculate normal total price and collect combo menu items
        let normalPrice = 0;
        for (const ci of deal.comboItems) {
          const menuItem = ci.menuItem;
          if (!menuItem || !menuItem.available) {
            return res.status(400).json({ message: `An item in combo deal "${deal.name}" is unavailable` });
          }
          normalPrice += menuItem.price * ci.quantity * dealQty;
          dealExpandedMenuItems.push({ menuItem, quantity: ci.quantity * dealQty });
        }

        const comboTotal = (deal.comboPrice || 0) * dealQty;
        const savings = Math.max(0, normalPrice - comboTotal);
        dealDiscount += savings;

        appliedDeals.push({
          deal: deal._id,
          dealName: deal.name,
          dealType: deal.dealType,
          discountAmount: savings,
        });
      }
    }

    // Unified map for inventory and cost lookups
    const menuMap = new Map(dbMenuItems.map((m) => [m._id.toString(), m]));
    for (const { menuItem } of dealExpandedMenuItems) {
      menuMap.set(menuItem._id.toString(), menuItem);
    }

    let subtotal = 0;

    // Build order items for regular menu items
    const regularOrderItems = regularItems.map((i) => {
      const menu = menuMap.get(i.menuItemId);
      const quantity = Number(i.quantity) || 0;
      if (quantity <= 0) throw new Error('Quantity must be greater than zero');
      const lineTotal = menu.price * quantity;
      subtotal += lineTotal;
      return { menuItem: menu._id, name: menu.name, quantity, unitPrice: menu.price, lineTotal };
    });

    // Build order items for deal (combo) expansions — items at full price, discount tracked in appliedDeals
    const dealOrderItems = dealExpandedMenuItems.map(({ menuItem, quantity }) => {
      const lineTotal = menuItem.price * quantity;
      subtotal += lineTotal;
      return { menuItem: menuItem._id, name: menuItem.name, quantity, unitPrice: menuItem.price, lineTotal };
    });

    const orderItems = [...regularOrderItems, ...dealOrderItems];

    // Total discount = manual discount from request + auto-savings from deal prices
    const discount = Math.max(0, (Number(discountAmount) || 0) + dealDiscount);
    const foodTotal = Math.max(0, subtotal - discount);

    const deliveryZones = orderType === 'DELIVERY' ? mergedDeliveryLocations(req.restaurant, branch) : [];
    let deliveryCharges = 0;
    let deliveryLocationName = '';
    let deliveryLocationObjectId = null;
    if (orderType === 'DELIVERY' && deliveryZones.length > 0) {
      const picked = pickDeliveryLocation(deliveryZones, deliveryLocationId);
      if (!picked) {
        return res.status(400).json({ message: 'deliveryLocationId is required and must match a configured delivery zone' });
      }
      deliveryCharges = Math.round(Math.max(0, picked.fee) * 100) / 100;
      deliveryLocationName = picked.name;
      const rawLocId = deliveryLocationId != null ? String(deliveryLocationId).trim() : '';
      if (rawLocId && mongoose.Types.ObjectId.isValid(rawLocId)) {
        deliveryLocationObjectId = new mongoose.Types.ObjectId(rawLocId);
      }
    }

    const total = foodTotal;
    const amountDue = Math.round((foodTotal + deliveryCharges) * 100) / 100;

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
            $inc: { totalOrders: 1, totalSpent: amountDue },
            $setOnInsert: { restaurant: req.restaurant._id, branch: branch ? branch._id : null, phone: customerPhone.trim() },
          },
          { upsert: true }
        );
      } catch (_) { /* non-critical */ }
    }

    // Compute ingredient cost and profit (sale price - ingredient cost at time of order)
    let ingredientCost = 0;
    const invIds = Array.from(consumptionByInventoryId.keys());
    if (invIds.length > 0) {
      const itemDefs = await InventoryItem.find({ _id: { $in: invIds }, restaurant: req.restaurant._id })
        .select('_id unit costPrice')
        .lean();
      const invCostMap = new Map();
      for (const d of itemDefs) {
        invCostMap.set(d._id.toString(), { costPrice: d.costPrice || 0, unit: d.unit || 'gram' });
      }
      if (branch) {
        const branchInvRows = await BranchInventory.find({ branch: branch._id, inventoryItem: { $in: invIds } })
          .select('inventoryItem costPrice')
          .lean();
        for (const r of branchInvRows) {
          const id = r.inventoryItem.toString();
          if (invCostMap.has(id)) invCostMap.set(id, { ...invCostMap.get(id), costPrice: r.costPrice ?? 0 });
        }
      }
      for (const orderItem of orderItems) {
        const menu = menuMap.get(orderItem.menuItem.toString());
        if (!menu) continue;
        ingredientCost += getMenuItemIngredientCost(menu, invCostMap) * orderItem.quantity;
      }
    }
    const profit = Math.round((foodTotal - ingredientCost) * 100) / 100;

    const tableNameTrimmed = (tableName || '').trim();

    const addrNotes = (deliveryAddress || '').trim();
    let deliveryAddressFinal = addrNotes;
    if (orderType === 'DELIVERY' && deliveryZones.length > 0 && deliveryLocationName) {
      deliveryAddressFinal = addrNotes ? `${deliveryLocationName} — ${addrNotes}` : deliveryLocationName;
    }

    // When DINE_IN order has a table name, mark that table as occupied (isAvailable = false)
    if (orderType === 'DINE_IN' && tableNameTrimmed) {
      await Table.findOneAndUpdate(
        { restaurant: req.restaurant._id, branch: branch ? branch._id : null, name: tableNameTrimmed },
        { $set: { isAvailable: false } }
      );
    }

    const paidAtCreation = orderPaymentMethod === 'CASH' || orderPaymentMethod === 'CARD' || orderPaymentMethod === 'ONLINE';
    let paymentAmountReceived = null;
    let paymentAmountReturned = null;
    if (paidAtCreation && orderPaymentMethod === 'CASH' && amountReceived != null) {
      const received = Number(amountReceived);
      if (!isNaN(received) && received >= amountDue) {
        paymentAmountReceived = received;
        paymentAmountReturned = received - amountDue;
      }
    }

    const session = await getOrCreateCurrentSession(req.restaurant._id, branch, req.user.id);

    // Auto-assign rider when a delivery_rider creates the order
    const isRiderCreated = req.user.role === 'delivery_rider' && orderType === 'DELIVERY';
    const riderFields = {};
    if (isRiderCreated) {
      riderFields.assignedRiderId = req.user.id;
      riderFields.assignedRiderName = req.user.name || '';
      riderFields.assignedRiderPhone = req.user.phone || '';
    }

    const order = await Order.create({
      restaurant: req.restaurant._id,
      branch: branch ? branch._id : undefined,
      daySession: session._id,
      table: tableId || undefined,
      tableNumber: (tableNumber || '').trim(),
      tableName: tableNameTrimmed,
      createdBy: req.user.id,
      orderType,
      paymentMethod: orderPaymentMethod,
      paymentProvider: orderPaymentMethod === 'ONLINE' && paymentProvider ? String(paymentProvider).trim() : undefined,
      status: 'NEW_ORDER',
      statusHistory: [{ status: 'NEW_ORDER', at: new Date() }],
      paymentAmountReceived: paymentAmountReceived ?? undefined,
      paymentAmountReturned: paymentAmountReturned ?? undefined,
      items: orderItems,
      subtotal,
      discountAmount: discount,
      appliedDeals,
      total,
      ingredientCost,
      profit,
      customerName: customerName || '',
      customerPhone: customerPhone || '',
      deliveryAddress: deliveryAddressFinal,
      deliveryCharges,
      deliveryLocationId: deliveryLocationObjectId || undefined,
      deliveryLocationName: deliveryLocationName || undefined,
      grandTotal: amountDue,
      orderNumber: await generateOrderNumber(req.restaurant._id, branch ? branch._id : null, 'ORD'),
      ...riderFields,
    });

    const io = req.app.get('io');
    if (io) {
      const rooms = getOrderRooms(order.restaurant, order.branch);
      const payload = { id: order._id.toString(), orderNumber: order.orderNumber, status: order.status, createdAt: order.createdAt };
      rooms.forEach((room) => io.to(room).emit('order:created', payload));
    }

    res.status(201).json({
      id: order._id,
      orderNumber: order.orderNumber,
      subtotal: order.subtotal,
      discountAmount: order.discountAmount,
      deliveryCharges: order.deliveryCharges ?? 0,
      total: order.total,
      amountDue: amountDue,
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
      status: { $in: ['NEW_ORDER', 'PROCESSING', 'READY', 'DELIVERED'] },
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

    const { cancelReason } = req.body;
    order.status = 'CANCELLED';
    if (cancelReason && String(cancelReason).trim()) {
      order.cancelReason = String(cancelReason).trim();
    }
    order.cancelledAt = new Date();
    order.cancelledBy = req.user.id;
    if (!order.statusHistory) order.statusHistory = [];
    order.statusHistory.push({ status: 'CANCELLED', at: new Date() });
    await order.save();

    res.json({
      id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      cancelReason: order.cancelReason || null,
      cancelledAt: order.cancelledAt,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// POS DRAFT ENDPOINTS
// ============================================

// @route   GET /api/pos/drafts
// @desc    Get all drafts for the current user/restaurant/branch
// @access  Staff / Restaurant Admin / Cashier
router.get('/drafts', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const branchId = req.headers['x-branch-id'];

    // Build query filter
    const filter = {
      restaurant: restaurantId,
    };

    // Filter by branch if provided
    if (branchId) {
      const branch = await Branch.findOne({ _id: branchId, restaurant: restaurantId });
      if (!branch) {
        return res.status(400).json({ message: 'Invalid branchId for this restaurant' });
      }
      filter.branch = branchId;
    }

    // Fetch drafts sorted by newest first
    const drafts = await PosDraft.find(filter)
      .sort({ createdAt: -1 })
      .populate('createdBy', 'name email')
      .lean();

    // Transform to match frontend expectations
    const transformedDrafts = drafts.map((draft) => ({
      id: draft._id.toString(),
      _id: draft._id.toString(),
      ref: draft.ref,
      orderNumber: draft.orderNumber || draft.ref,
      items: draft.items,
      orderType: draft.orderType,
      customerName: draft.customerName,
      customerPhone: draft.customerPhone,
      deliveryAddress: draft.deliveryAddress,
      subtotal: draft.subtotal,
      total: draft.total,
      discountAmount: draft.discountAmount,
      itemNotes: draft.itemNotes ? Object.fromEntries(draft.itemNotes) : {},
      tableNumber: draft.tableNumber,
      tableName: draft.tableName || '',
      selectedWaiter: draft.selectedWaiter,
      branchId: draft.branch ? draft.branch.toString() : null,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    }));

    res.json(transformedDrafts);
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/pos/drafts
// @desc    Create a new draft
// @access  Staff / Restaurant Admin / Cashier
router.post('/drafts', async (req, res, next) => {
  try {
    const {
      items,
      orderType = 'DINE_IN',
      customerName = '',
      customerPhone = '',
      deliveryAddress = '',
      subtotal,
      total,
      discountAmount = 0,
      itemNotes = {},
      tableNumber = '',
      selectedWaiter = '',
      branchId,
    } = req.body;

    // Validate required fields
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Draft items are required' });
    }

    if (subtotal === undefined || total === undefined) {
      return res.status(400).json({ message: 'Subtotal and total are required' });
    }

    const restaurantId = req.restaurant._id;

    // Validate branch if provided
    let branch = null;
    if (branchId) {
      branch = await Branch.findOne({ _id: branchId, restaurant: restaurantId });
      if (!branch) {
        return res.status(400).json({ message: 'Invalid branchId for this restaurant' });
      }
    }

    // Validate orderType
    if (!['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(orderType)) {
      return res.status(400).json({ message: 'Invalid orderType' });
    }

    const tableNameVal = (req.body.tableName || '').trim();

    // Create the draft
    const draft = await PosDraft.create({
      restaurant: restaurantId,
      branch: branch ? branch._id : null,
      createdBy: req.user.id,
      items,
      orderType,
      customerName,
      customerPhone,
      deliveryAddress,
      subtotal,
      total,
      discountAmount,
      itemNotes,
      tableNumber,
      tableName: tableNameVal,
      selectedWaiter,
    });

    // Transform response
    const response = {
      id: draft._id.toString(),
      _id: draft._id.toString(),
      ref: draft.ref,
      orderNumber: draft.orderNumber || draft.ref,
      items: draft.items,
      orderType: draft.orderType,
      customerName: draft.customerName,
      customerPhone: draft.customerPhone,
      deliveryAddress: draft.deliveryAddress,
      subtotal: draft.subtotal,
      total: draft.total,
      discountAmount: draft.discountAmount,
      itemNotes: draft.itemNotes ? Object.fromEntries(draft.itemNotes) : {},
      tableNumber: draft.tableNumber,
      tableName: draft.tableName || '',
      selectedWaiter: draft.selectedWaiter,
      branchId: draft.branch ? draft.branch.toString() : null,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    };

    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/pos/drafts/:id
// @desc    Get a specific draft by ID
// @access  Staff / Restaurant Admin / Cashier
router.get('/drafts/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const restaurantId = req.restaurant._id;

    const draft = await PosDraft.findOne({
      _id: id,
      restaurant: restaurantId,
    }).lean();

    if (!draft) {
      return res.status(404).json({ message: 'Draft not found' });
    }

    // Transform response
    const response = {
      id: draft._id.toString(),
      _id: draft._id.toString(),
      ref: draft.ref,
      orderNumber: draft.orderNumber || draft.ref,
      items: draft.items,
      orderType: draft.orderType,
      customerName: draft.customerName,
      customerPhone: draft.customerPhone,
      deliveryAddress: draft.deliveryAddress,
      subtotal: draft.subtotal,
      total: draft.total,
      discountAmount: draft.discountAmount,
      itemNotes: draft.itemNotes ? Object.fromEntries(draft.itemNotes) : {},
      tableNumber: draft.tableNumber,
      tableName: draft.tableName || '',
      selectedWaiter: draft.selectedWaiter,
      branchId: draft.branch ? draft.branch.toString() : null,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    };

    res.json(response);
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/pos/drafts/:id
// @desc    Update an existing draft
// @access  Staff / Restaurant Admin / Cashier
router.put('/drafts/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      items,
      orderType,
      customerName,
      customerPhone,
      deliveryAddress,
      subtotal,
      total,
      discountAmount,
      itemNotes,
      tableNumber,
      tableName: tableNameBody,
      selectedWaiter,
      branchId,
    } = req.body;

    const restaurantId = req.restaurant._id;

    // Find the draft
    const draft = await PosDraft.findOne({
      _id: id,
      restaurant: restaurantId,
    });

    if (!draft) {
      return res.status(404).json({ message: 'Draft not found' });
    }

    // Validate branch if provided
    if (branchId) {
      const branch = await Branch.findOne({ _id: branchId, restaurant: restaurantId });
      if (!branch) {
        return res.status(400).json({ message: 'Invalid branchId for this restaurant' });
      }
      draft.branch = branchId;
    }

    // Validate orderType if provided
    if (orderType && !['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(orderType)) {
      return res.status(400).json({ message: 'Invalid orderType' });
    }

    // Update fields
    if (items !== undefined) draft.items = items;
    if (orderType !== undefined) draft.orderType = orderType;
    if (customerName !== undefined) draft.customerName = customerName;
    if (customerPhone !== undefined) draft.customerPhone = customerPhone;
    if (deliveryAddress !== undefined) draft.deliveryAddress = deliveryAddress;
    if (subtotal !== undefined) draft.subtotal = subtotal;
    if (total !== undefined) draft.total = total;
    if (discountAmount !== undefined) draft.discountAmount = discountAmount;
    if (itemNotes !== undefined) draft.itemNotes = itemNotes;
    if (tableNumber !== undefined) draft.tableNumber = tableNumber;
    if (tableNameBody !== undefined) draft.tableName = String(tableNameBody || '').trim();
    if (selectedWaiter !== undefined) draft.selectedWaiter = selectedWaiter;

    await draft.save();

    // Transform response
    const response = {
      id: draft._id.toString(),
      _id: draft._id.toString(),
      ref: draft.ref,
      orderNumber: draft.orderNumber || draft.ref,
      items: draft.items,
      orderType: draft.orderType,
      customerName: draft.customerName,
      customerPhone: draft.customerPhone,
      deliveryAddress: draft.deliveryAddress,
      subtotal: draft.subtotal,
      total: draft.total,
      discountAmount: draft.discountAmount,
      itemNotes: draft.itemNotes ? Object.fromEntries(draft.itemNotes) : {},
      tableNumber: draft.tableNumber,
      tableName: draft.tableName || '',
      selectedWaiter: draft.selectedWaiter,
      branchId: draft.branch ? draft.branch.toString() : null,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    };

    res.json(response);
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/pos/drafts/:id
// @desc    Delete a draft
// @access  Staff / Restaurant Admin / Cashier
router.delete('/drafts/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const restaurantId = req.restaurant._id;

    const draft = await PosDraft.findOneAndDelete({
      _id: id,
      restaurant: restaurantId,
    });

    if (!draft) {
      return res.status(404).json({ message: 'Draft not found' });
    }

    res.status(200).json({ message: 'Draft deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// ============================================
// POS TRANSACTION ENDPOINTS
// ============================================

// @route   GET /api/pos/transactions
// @desc    Get all completed sales/transactions for the current restaurant/branch
// @access  Staff / Restaurant Admin / Cashier
router.get('/transactions', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const branchId = req.headers['x-branch-id'];
    
    // Query parameters for filtering and pagination
    const {
      status,
      paymentMethod,
      orderType,
      startDate,
      endDate,
      limit = 50,
      offset = 0,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    // Build query filter
    const filter = {
      restaurant: restaurantId,
    };

    // Filter by branch if provided
    if (branchId) {
      const branch = await Branch.findOne({ _id: branchId, restaurant: restaurantId });
      if (!branch) {
        return res.status(400).json({ message: 'Invalid branchId for this restaurant' });
      }
      filter.branch = branchId;
    }

    // Filter by status (default to completed/ready orders)
    if (status) {
      filter.status = status;
    } else {
      // Default: show completed orders (sales transactions)
      filter.status = { $in: ['DELIVERED', 'READY', 'NEW_ORDER'] };
    }

    // Filter by payment method
    if (paymentMethod) {
      filter.paymentMethod = paymentMethod;
    }

    // Filter by order type
    if (orderType) {
      filter.orderType = orderType;
    }

    // Filter by date range
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.createdAt.$lte = new Date(endDate);
      }
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Fetch transactions with pagination
    const [transactions, totalCount] = await Promise.all([
      Order.find(filter)
        .sort(sort)
        .limit(parseInt(limit))
        .skip(parseInt(offset))
        .populate('createdBy', 'name email')
        .populate('branch', 'name')
        .lean(),
      Order.countDocuments(filter),
    ]);

    // Transform to match frontend expectations
    const transformedTransactions = transactions.map((order) => ({
      id: order._id.toString(),
      _id: order._id.toString(),
      orderNumber: order.orderNumber,
      items: order.items,
      orderType: order.orderType,
      paymentMethod: order.paymentMethod,
      status: order.status,
      source: order.source || 'POS',
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      deliveryAddress: order.deliveryAddress,
      subtotal: order.subtotal,
      total: order.total,
      deliveryCharges: order.deliveryCharges ?? 0,
      grandTotal: order.grandTotal ?? order.total,
      discountAmount: order.discountAmount,
      appliedDeals: order.appliedDeals || [],
      tableNumber: order.tableNumber,
      tableName: order.tableName || '',
      branchId: order.branch ? order.branch._id?.toString() : null,
      branchName: order.branch ? order.branch.name : null,
      createdBy: order.createdBy ? {
        id: order.createdBy._id?.toString(),
        name: order.createdBy.name,
        email: order.createdBy.email,
      } : null,
      cancelReason: order.cancelReason || null,
      cancelledAt: order.cancelledAt || null,
      cancelledBy: order.cancelledBy ? order.cancelledBy.toString() : null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    }));

    res.json({
      transactions: transformedTransactions,
      pagination: {
        total: totalCount,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + transactions.length < totalCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/pos/transactions/:id
// @desc    Get a specific transaction by ID
// @access  Staff / Restaurant Admin / Cashier
router.get('/transactions/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const restaurantId = req.restaurant._id;

    const transaction = await Order.findOne({
      _id: id,
      restaurant: restaurantId,
    })
      .populate('createdBy', 'name email')
      .populate('branch', 'name address')
      .populate('table', 'name isAvailable')
      .lean();

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    // Transform response
    const response = {
      id: transaction._id.toString(),
      _id: transaction._id.toString(),
      orderNumber: transaction.orderNumber,
      items: transaction.items,
      orderType: transaction.orderType,
      paymentMethod: transaction.paymentMethod,
      status: transaction.status,
      source: transaction.source || 'POS',
      externalOrderId: transaction.externalOrderId,
      customerName: transaction.customerName,
      customerPhone: transaction.customerPhone,
      deliveryAddress: transaction.deliveryAddress,
      subtotal: transaction.subtotal,
      total: transaction.total,
      deliveryCharges: transaction.deliveryCharges ?? 0,
      grandTotal: transaction.grandTotal ?? transaction.total,
      discountAmount: transaction.discountAmount,
      appliedDeals: transaction.appliedDeals || [],
      tableNumber: transaction.tableNumber,
      tableName: transaction.tableName || '',
      table: transaction.table ? {
        id: transaction.table._id?.toString(),
        name: transaction.table.name,
        isAvailable: transaction.table.isAvailable,
      } : null,
      branchId: transaction.branch ? transaction.branch._id?.toString() : null,
      branch: transaction.branch ? {
        id: transaction.branch._id?.toString(),
        name: transaction.branch.name,
        address: transaction.branch.address,
      } : null,
      createdBy: transaction.createdBy ? {
        id: transaction.createdBy._id?.toString(),
        name: transaction.createdBy.name,
        email: transaction.createdBy.email,
      } : null,
      cancelReason: transaction.cancelReason || null,
      cancelledAt: transaction.cancelledAt || null,
      cancelledBy: transaction.cancelledBy ? transaction.cancelledBy.toString() : null,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
    };

    res.json(response);
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/pos/transactions/:id
// @desc    Delete a transaction (soft delete by marking as CANCELLED)
// @access  Restaurant Admin / Manager
router.delete('/transactions/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const restaurantId = req.restaurant._id;

    // Only allow restaurant_admin and manager to delete transactions
    if (!['super_admin', 'restaurant_admin', 'manager', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ 
        message: 'Only restaurant admins and managers can delete transactions' 
      });
    }

    const transaction = await Order.findOne({
      _id: id,
      restaurant: restaurantId,
    });

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    // Prevent deletion of already cancelled orders
    if (transaction.status === 'CANCELLED') {
      return res.status(400).json({ message: 'Transaction is already cancelled' });
    }

    transaction.status = 'CANCELLED';
    transaction.cancelledAt = new Date();
    transaction.cancelledBy = req.user.id;
    await transaction.save();

    // Optionally reverse inventory (similar to cancel order endpoint)
    const menuItemIds = Array.from(new Set(transaction.items.map((i) => i.menuItem.toString())));
    const menuItems = await MenuItem.find({
      _id: { $in: menuItemIds },
      restaurant: restaurantId,
    });
    const menuMap = new Map(menuItems.map((m) => [m._id.toString(), m]));

    const consumptionByInventoryId = new Map();
    for (const orderItem of transaction.items) {
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

      if (transaction.branch) {
        // Reverse BranchInventory
        await Promise.all(
          Array.from(consumptionByInventoryId.entries()).map(async ([invId, qty]) => {
            await BranchInventory.findOneAndUpdate(
              { branch: transaction.branch, inventoryItem: invId },
              { $inc: { currentStock: qty } },
              { upsert: false }
            );
          })
        );
      } else {
        // Reverse restaurant-level InventoryItem
        const inventoryItems = await InventoryItem.find({
          _id: { $in: inventoryIds },
          restaurant: restaurantId,
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

    res.json({
      message: 'Transaction deleted successfully',
      id: transaction._id.toString(),
      orderNumber: transaction.orderNumber,
      status: transaction.status,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// DAY SESSION ENDPOINTS
// ============================================

// @route   GET /api/pos/day-session/current
// @desc    Get the current OPEN day session for this restaurant/branch
// @access  Staff / Cashier / Admin
router.get('/day-session/current', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const branchId = req.headers['x-branch-id'] || req.query.branchId || null;
    const { cutoffHour, invalid } = await resolveBranchAndCutoff(restaurantId, branchId);
    if (invalid) {
      return res.status(400).json({ message: 'Invalid branchId for this restaurant' });
    }

    const session = await DaySession.findOne({
      restaurant: restaurantId,
      branch: branchId || null,
      status: 'OPEN',
    });

    if (!session) {
      return res.json(null);
    }

    await closeSessionIfPastCutoff(session, cutoffHour, null);
    if (session.status === 'CLOSED') return res.json(null);

    // Aggregate sales and order count for the active session (exclude cancelled)
    const agg = await Order.aggregate([
      {
        $match: {
          daySession: session._id,
          status: { $in: CLOSED_ORDER_STATUSES },
          ...PAID_ORDER_MATCH,
        },
      },
      { $group: { _id: null, totalSales: { $sum: { $ifNull: ['$grandTotal', '$total'] } }, totalOrders: { $sum: 1 } } },
    ]);
    const { totalSales = 0, totalOrders = 0 } = agg[0] || {};

    return res.json({
      id: session._id.toString(),
      startAt: session.startAt,
      endAt: session.endAt || null,
      totalSales,
      totalOrders,
    });
  } catch (err) {
    next(err);
  }
});

// @route   POST /api/pos/day-session/end
// @desc    End the current OPEN day session; next order auto-starts a new one
// @access  Staff / Cashier / Admin
router.post('/day-session/end', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const branchId = req.body.branchId || req.headers['x-branch-id'] || null;
    const { cutoffHour, invalid } = await resolveBranchAndCutoff(restaurantId, branchId);
    if (invalid) {
      return res.status(400).json({ message: 'Invalid branchId for this restaurant' });
    }
    const endMode = String(req.body.endMode || 'cutoff');
    const selectedOrderId = req.body.selectedOrderId || null;
    const normalizedEndMode =
      endMode === 'lastOrder' ||
      endMode === 'cutoff' ||
      endMode === 'now' ||
      endMode === 'selectedOrder'
        ? endMode
        : 'cutoff';

    let targetSession = await DaySession.findOne({
      restaurant: restaurantId,
      branch: branchId || null,
      status: 'OPEN',
    });

    if (!targetSession) {
      // If the session was auto-closed already, allow adjusting the most recent closed session.
      targetSession = await DaySession.findOne({
        restaurant: restaurantId,
        branch: branchId || null,
        status: 'CLOSED',
      }).sort({ startAt: -1 });
    }

    if (!targetSession) {
      return res.status(400).json({ message: 'No day session found' });
    }

    const now = new Date();
    const expectedEndAt = getExpectedSessionEndAt(targetSession.startAt, cutoffHour);

    let endAt = expectedEndAt;
    if (normalizedEndMode === 'now') {
      endAt = now;
    } else if (normalizedEndMode === 'selectedOrder') {
      if (!selectedOrderId) {
        return res.status(400).json({ message: 'selectedOrderId is required for selectedOrder endMode' });
      }
      const selectedOrder = await Order.findOne({
        _id: selectedOrderId,
        restaurant: restaurantId,
      })
        .select({ createdAt: 1, daySession: 1 })
        .lean();

      if (!selectedOrder?.createdAt) {
        return res.status(400).json({ message: 'Invalid selected order' });
      }
      if (!selectedOrder.daySession) {
        return res.status(400).json({ message: 'Selected order is not linked to a day session' });
      }

      // If the selected order belongs to a different session than the guessed target,
      // use the order's own session as source of truth.
      if (String(selectedOrder.daySession) !== String(targetSession._id)) {
        const selectedOrderSession = await DaySession.findOne({
          _id: selectedOrder.daySession,
          restaurant: restaurantId,
        });
        if (!selectedOrderSession) {
          return res.status(400).json({ message: 'Selected order session not found' });
        }
        targetSession = selectedOrderSession;
      }

      endAt = new Date(selectedOrder.createdAt);
    } else if (normalizedEndMode === 'lastOrder') {
      const lastOrderAt = await getLastCompletedOrderAt({ restaurantId, sessionId: targetSession._id });
      // If the last delivered/completed order happened after the cutoff, extend endAt
      // so the report range includes those orders.
      endAt = lastOrderAt && lastOrderAt > expectedEndAt ? lastOrderAt : expectedEndAt;
    } // else 'cutoff' => keep expectedEndAt

    targetSession.status = 'CLOSED';
    targetSession.endAt = endAt;
    targetSession.closedBy = req.user._id;
    targetSession.sessionKey = buildSessionKey(targetSession.startAt, targetSession.endAt);

    await targetSession.save();

    if (normalizedEndMode === 'selectedOrder') {
      // Create/reuse a new OPEN session and move orders created after endAt.
      const nextOpenSession =
        (await DaySession.findOne({
          restaurant: restaurantId,
          branch: branchId || null,
          status: 'OPEN',
        }).lean()) ||
        (await DaySession.create({
          restaurant: restaurantId,
          branch: branchId || null,
          status: 'OPEN',
          startAt: endAt,
          openedBy: req.user._id,
        }));

      // Move non-cancelled orders after selected cutoff into the new OPEN session.
      await Order.updateMany(
        {
          restaurant: restaurantId,
          daySession: targetSession._id,
          createdAt: { $gt: endAt },
          status: { $nin: ['CANCELLED'] },
        },
        { $set: { daySession: nextOpenSession._id } },
      );

      return res.json({
        success: true,
        session: {
          id: targetSession._id.toString(),
          startAt: targetSession.startAt,
          endAt: targetSession.endAt,
        },
        nextOpenSession: {
          id: nextOpenSession._id.toString(),
          startAt: nextOpenSession.startAt,
          endAt: nextOpenSession.endAt || null,
        },
      });
    }

    return res.json({
      success: true,
      session: {
        id: targetSession._id.toString(),
        startAt: targetSession.startAt,
        endAt: targetSession.endAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

// @route   POST /api/pos/day-session/reassign-to-current
// @desc    Repair tool: move misplaced orders from a past session into current OPEN session
// @access  Staff / Cashier / Admin
router.post('/day-session/reassign-to-current', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const branchId = req.body.branchId || req.headers['x-branch-id'] || null;
    const { invalid } = await resolveBranchAndCutoff(restaurantId, branchId);
    if (invalid) {
      return res.status(400).json({ message: 'Invalid branchId for this restaurant' });
    }

    const {
      sourceSessionId,
      // Default repair behavior: only move records that happened after the source end.
      onlyAfterSourceEnd = true,
      includeCancelled = false,
      orderNumbers = [],
    } = req.body || {};

    const hasOrderNumbers = Array.isArray(orderNumbers) && orderNumbers.length > 0;
    if (!sourceSessionId && !hasOrderNumbers) {
      return res.status(400).json({ message: 'sourceSessionId or orderNumbers is required' });
    }

    let sourceSession = null;
    if (sourceSessionId) {
      sourceSession = await DaySession.findOne({
        _id: sourceSessionId,
        restaurant: restaurantId,
        branch: branchId || null,
      });
      if (!sourceSession) {
        return res.status(404).json({ message: 'Source day session not found' });
      }
    }

    let currentOpen = await DaySession.findOne({
      restaurant: restaurantId,
      branch: branchId || null,
      status: 'OPEN',
    });

    if (!currentOpen) {
      currentOpen = await DaySession.create({
        restaurant: restaurantId,
        branch: branchId || null,
        status: 'OPEN',
        startAt: new Date(),
        openedBy: req.user?._id || null,
      });
    }

    if (sourceSession && String(currentOpen._id) === String(sourceSession._id)) {
      return res.status(400).json({ message: 'Source session is already the current OPEN session' });
    }

    const filter = {
      restaurant: restaurantId,
    };
    if (branchId) filter.branch = branchId;
    if (sourceSession) {
      filter.daySession = sourceSession._id;
    }
    if (hasOrderNumbers) {
      filter.orderNumber = { $in: orderNumbers.map((n) => String(n || '').trim()).filter(Boolean) };
    }
    if (!includeCancelled) {
      filter.status = { $nin: ['CANCELLED'] };
    }
    if (sourceSession && onlyAfterSourceEnd && sourceSession.endAt) {
      filter.createdAt = { $gt: sourceSession.endAt };
    }

    const before = await Order.find(filter).select({ _id: 1, orderNumber: 1 }).lean();
    const result = await Order.updateMany(filter, { $set: { daySession: currentOpen._id } });

    return res.json({
      success: true,
      movedOrders: result.modifiedCount || 0,
      movedOrderNumbers: before.map((o) => o.orderNumber),
      sourceSession: sourceSession
        ? {
            id: sourceSession._id.toString(),
            startAt: sourceSession.startAt,
            endAt: sourceSession.endAt || null,
          }
        : null,
      targetSession: {
        id: currentOpen._id.toString(),
        startAt: currentOpen.startAt,
        endAt: currentOpen.endAt || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// @route   POST /api/pos/day-session/reassign-orders
// @desc    Move selected orders into a target day session (bulk fix tool)
// @access  Staff / Cashier / Admin
router.post('/day-session/reassign-orders', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const branchId = req.body.branchId || req.headers['x-branch-id'] || null;
    const { invalid } = await resolveBranchAndCutoff(restaurantId, branchId);
    if (invalid) {
      return res.status(400).json({ message: 'Invalid branchId for this restaurant' });
    }

    const { orderIds, targetSessionId } = req.body || {};
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ message: 'orderIds array is required' });
    }
    if (!targetSessionId) {
      return res.status(400).json({ message: 'targetSessionId is required' });
    }

    const targetSession = await DaySession.findOne({
      _id: targetSessionId,
      restaurant: restaurantId,
      branch: branchId || null,
    });
    if (!targetSession) {
      return res.status(404).json({ message: 'Target day session not found' });
    }

    const filter = {
      _id: { $in: orderIds },
      restaurant: restaurantId,
    };
    if (branchId) filter.branch = branchId;

    const before = await Order.find(filter).select({ _id: 1, orderNumber: 1, daySession: 1 }).lean();
    if (before.length === 0) {
      return res.status(404).json({ message: 'No matching orders found' });
    }

    const result = await Order.updateMany(filter, { $set: { daySession: targetSession._id } });

    return res.json({
      success: true,
      movedOrders: result.modifiedCount || 0,
      movedOrderIds: before.map((o) => o._id.toString()),
      movedOrderNumbers: before.map((o) => o.orderNumber),
      targetSession: {
        id: targetSession._id.toString(),
        startAt: targetSession.startAt,
        endAt: targetSession.endAt || null,
        status: targetSession.status,
      },
    });
  } catch (err) {
    next(err);
  }
});

// @route   GET /api/pos/day-session/list
// @desc    List all day sessions (history) for this restaurant/branch
// @access  Staff / Cashier / Admin
router.get('/day-session/list', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const branchId = req.query.branchId || req.headers['x-branch-id'] || null;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    // When branchId is provided filter to that branch only;
    // when null/omitted (All branches view) return sessions for all branches.
    const filter = { restaurant: restaurantId };
    if (branchId) filter.branch = branchId;

    const [sessions, total] = await Promise.all([
      DaySession.find(filter)
        .sort({ startAt: -1 })
        .limit(limit)
        .skip(offset)
        .populate('openedBy', 'name')
        .populate('closedBy', 'name')
        .populate('branch', 'name')
        .lean(),
      DaySession.countDocuments(filter),
    ]);

    const formatted = await Promise.all(
      sessions.map(async (s) => {
        const orderCount = await Order.countDocuments({
          daySession: s._id,
        });
        const totalsAgg = await Order.aggregate([
          {
            $match: {
              daySession: s._id,
              status: { $in: CLOSED_ORDER_STATUSES },
              ...PAID_ORDER_MATCH,
            },
          },
          { $group: { _id: null, totalSales: { $sum: { $ifNull: ['$grandTotal', '$total'] } }, totalOrders: { $sum: 1 } } },
        ]);
        const agg = totalsAgg[0] || { totalSales: 0, totalOrders: 0 };
        return {
          id: s._id.toString(),
          status: s.status,
          startAt: s.startAt,
          endAt: s.endAt,
          sessionKey: s.sessionKey || '',
          branchName: s.branch ? s.branch.name : null,
          openedBy: s.openedBy ? { id: s.openedBy._id?.toString(), name: s.openedBy.name } : null,
          closedBy: s.closedBy ? { id: s.closedBy._id?.toString(), name: s.closedBy.name } : null,
          orderCount,
          totalSales: agg.totalSales,
          totalOrders: agg.totalOrders,
        };
      })
    );

    return res.json({ sessions: formatted, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// @route   POST /api/pos/day-session/bulk-orders
// @desc    Get aggregated orders + summary for multiple day sessions in one call
// @access  Staff / Cashier / Admin
router.post('/day-session/bulk-orders', async (req, res, next) => {
  try {
    const { sessionIds } = req.body;
    const restaurantId = req.restaurant._id;

    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ message: 'sessionIds array is required' });
    }

    const mongoose = require('mongoose');
    const objectIds = sessionIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (objectIds.length === 0) {
      return res.status(400).json({ message: 'No valid session IDs provided' });
    }

    // Verify all sessions belong to this restaurant
    const sessions = await DaySession.find({
      _id: { $in: objectIds },
      restaurant: restaurantId,
    }).lean();

    if (sessions.length === 0) {
      return res.status(404).json({ message: 'No sessions found' });
    }

    const validIds = sessions.map((s) => s._id);

    const [orders, totalsAgg] = await Promise.all([
      Order.find({
        restaurant: restaurantId,
        daySession: { $in: validIds },
      })
        .sort({ createdAt: -1 })
        .populate('createdBy', 'name')
        .lean(),

      Order.aggregate([
        {
          $match: {
            restaurant: restaurantId,
            daySession: { $in: validIds },
            status: { $in: CLOSED_ORDER_STATUSES },
            ...PAID_ORDER_MATCH,
          },
        },
        {
          $group: {
            _id: null,
            totalSales: { $sum: { $ifNull: ['$grandTotal', '$total'] } },
            totalOrders: { $sum: 1 },
            totalDiscount: { $sum: '$discountAmount' },
            totalProfit: { $sum: '$profit' },
            totalDeliveryCharges: { $sum: { $ifNull: ['$deliveryCharges', 0] } },
            cashSales: {
              $sum: {
                $add: [
                  { $cond: [{ $eq: ['$paymentMethod', 'CASH'] }, { $ifNull: ['$grandTotal', '$total'] }, 0] },
                  { $cond: [{ $eq: ['$paymentMethod', 'SPLIT'] }, { $ifNull: ['$splitCashAmount', 0] }, 0] },
                ],
              },
            },
            cardSales: {
              $sum: {
                $add: [
                  { $cond: [{ $eq: ['$paymentMethod', 'CARD'] }, { $ifNull: ['$grandTotal', '$total'] }, 0] },
                  { $cond: [{ $eq: ['$paymentMethod', 'SPLIT'] }, { $ifNull: ['$splitCardAmount', 0] }, 0] },
                ],
              },
            },
          },
        },
      ]),
    ]);

    const summary = totalsAgg[0] || {
      totalSales: 0,
      totalOrders: 0,
      totalDiscount: 0,
      totalProfit: 0,
      totalDeliveryCharges: 0,
      cashSales: 0,
      cardSales: 0,
    };

    return res.json({
      summary,
      orders: orders.map((o) => ({
        id: o._id.toString(),
        sessionId: o.daySession ? o.daySession.toString() : null,
        orderNumber: o.orderNumber,
        orderType: o.orderType,
        paymentMethod: o.paymentMethod,
        isPaid: isOrderPaid(o),
        paymentProvider: o.paymentProvider ?? null,
        splitCashAmount: o.splitCashAmount ?? null,
        splitCardAmount: o.splitCardAmount ?? null,
        splitOnlineAmount: o.splitOnlineAmount ?? null,
        splitOnlineProvider: o.splitOnlineProvider ?? null,
        status: o.status,
        customerName: o.customerName,
        customerPhone: o.customerPhone || '',
        tableName: o.tableName || '',
        source: o.source || 'POS',
        orderTakerName: o.createdBy?.name || '',
        assignedRiderName: o.assignedRiderName || '',
        assignedRiderPhone: o.assignedRiderPhone || '',
        deliveryAddress: o.deliveryAddress || '',
        subtotal: o.subtotal,
        discountAmount: o.discountAmount,
        total: o.total,
        deliveryCharges: o.deliveryCharges ?? 0,
        grandTotal: o.grandTotal ?? o.total,
        profit: o.profit,
        items: (o.items || []).map((i) => ({
          name: i.name,
          qty: i.quantity,
          lineTotal: i.lineTotal,
        })),
        createdAt: o.createdAt,
        createdBy: o.createdBy
          ? { id: o.createdBy._id?.toString(), name: o.createdBy.name }
          : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// @route   GET /api/pos/day-session/:sessionId/orders
// @desc    Get all orders for a specific day session
// @access  Staff / Cashier / Admin
router.get('/day-session/:sessionId/orders', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const restaurantId = req.restaurant._id;

    const session = await DaySession.findOne({ _id: sessionId, restaurant: restaurantId });
    if (!session) {
      return res.status(404).json({ message: 'Day session not found' });
    }

    const orders = await Order.find({
      daySession: sessionId,
      restaurant: restaurantId,
    })
      .sort({ createdAt: -1 })
      .populate('createdBy', 'name')
      .lean();

    const totalsAgg = await Order.aggregate([
      {
        $match: {
          daySession: session._id,
          status: { $in: CLOSED_ORDER_STATUSES },
          ...PAID_ORDER_MATCH,
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: { $ifNull: ['$grandTotal', '$total'] } },
          totalOrders: { $sum: 1 },
          totalDiscount: { $sum: '$discountAmount' },
          totalProfit: { $sum: '$profit' },
          totalDeliveryCharges: { $sum: { $ifNull: ['$deliveryCharges', 0] } },
          cashSales: {
            $sum: {
              $add: [
                { $cond: [{ $eq: ['$paymentMethod', 'CASH'] }, { $ifNull: ['$grandTotal', '$total'] }, 0] },
                { $cond: [{ $eq: ['$paymentMethod', 'SPLIT'] }, { $ifNull: ['$splitCashAmount', 0] }, 0] },
              ],
            },
          },
          cardSales: {
            $sum: {
              $add: [
                { $cond: [{ $eq: ['$paymentMethod', 'CARD'] }, { $ifNull: ['$grandTotal', '$total'] }, 0] },
                { $cond: [{ $eq: ['$paymentMethod', 'SPLIT'] }, { $ifNull: ['$splitCardAmount', 0] }, 0] },
              ],
            },
          },
        },
      },
    ]);
    const summary = totalsAgg[0] || { totalSales: 0, totalOrders: 0, totalDiscount: 0, totalProfit: 0, totalDeliveryCharges: 0, cashSales: 0, cardSales: 0 };

    return res.json({
      session: {
        id: session._id.toString(),
        status: session.status,
        startAt: session.startAt,
        endAt: session.endAt,
        sessionKey: session.sessionKey || '',
      },
      summary,
      orders: orders.map((o) => ({
        id: o._id.toString(),
        orderNumber: o.orderNumber,
        orderType: o.orderType,
        paymentMethod: o.paymentMethod,
        isPaid: isOrderPaid(o),
        paymentProvider: o.paymentProvider ?? null,
        splitCashAmount: o.splitCashAmount ?? null,
        splitCardAmount: o.splitCardAmount ?? null,
        splitOnlineAmount: o.splitOnlineAmount ?? null,
        splitOnlineProvider: o.splitOnlineProvider ?? null,
        status: o.status,
        customerName: o.customerName,
        customerPhone: o.customerPhone || '',
        tableName: o.tableName || '',
        source: o.source || 'POS',
        orderTakerName: o.createdBy?.name || '',
        assignedRiderName: o.assignedRiderName || '',
        assignedRiderPhone: o.assignedRiderPhone || '',
        deliveryAddress: o.deliveryAddress || '',
        subtotal: o.subtotal,
        discountAmount: o.discountAmount,
        total: o.total,
        deliveryCharges: o.deliveryCharges ?? 0,
        grandTotal: o.grandTotal ?? o.total,
        profit: o.profit,
        items: (o.items || []).map((i) => ({
          name: i.name,
          qty: i.quantity,
          lineTotal: i.lineTotal,
        })),
        createdAt: o.createdAt,
        createdBy: o.createdBy ? { id: o.createdBy._id?.toString(), name: o.createdBy.name } : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

