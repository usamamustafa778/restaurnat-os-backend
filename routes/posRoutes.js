const express = require('express');
const MenuItem = require('../models/MenuItem');
const InventoryItem = require('../models/InventoryItem');
const BranchInventory = require('../models/BranchInventory');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Branch = require('../models/Branch');
const Table = require('../models/Table');
const PosDraft = require('../models/PosDraft');
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
    const { items, orderType, paymentMethod, discountAmount = 0, customerName = '', customerPhone = '', deliveryAddress = '', branchId, tableNumber, tableId, tableName } = req.body;

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

    // Payment taken at counter (Orders page); POS creates order with PENDING
    const orderPaymentMethod = (paymentMethod === 'CASH' || paymentMethod === 'CARD') ? paymentMethod : 'PENDING';

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
    const profit = Math.round((total - ingredientCost) * 100) / 100;

    const tableNameTrimmed = (tableName || '').trim();

    // When DINE_IN order has a table name, mark that table as occupied (isAvailable = false)
    if (orderType === 'DINE_IN' && tableNameTrimmed) {
      await Table.findOneAndUpdate(
        { restaurant: req.restaurant._id, branch: branch ? branch._id : null, name: tableNameTrimmed },
        { $set: { isAvailable: false } }
      );
    }

    const order = await Order.create({
      restaurant: req.restaurant._id,
      branch: branch ? branch._id : undefined,
      table: tableId || undefined,
      tableNumber: (tableNumber || '').trim(),
      tableName: tableNameTrimmed,
      createdBy: req.user.id,
      orderType,
      paymentMethod: orderPaymentMethod,
      status: 'UNPROCESSED',
      items: orderItems,
      subtotal,
      discountAmount: discount,
      total,
      ingredientCost,
      profit,
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
      filter.status = { $in: ['COMPLETED', 'READY', 'UNPROCESSED'] };
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
    if (!['restaurant_admin', 'manager', 'admin'].includes(req.user.role)) {
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

    // Soft delete by marking as CANCELLED (this will also reverse inventory via the existing cancel endpoint)
    transaction.status = 'CANCELLED';
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

module.exports = router;

