const express = require('express');
const mongoose = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const BranchInventory = require('../models/BranchInventory');
const InventoryItem = require('../models/InventoryItem');
const Branch = require('../models/Branch');
const { createVoucher } = require('../services/accounting/voucherService');
const { protect, requireRole, requireRestaurant, checkSubscriptionStatus } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(
  protect,
  requireRole('super_admin', 'staff', 'restaurant_admin', 'admin', 'cashier', 'manager', 'product_manager', 'kitchen_staff', 'order_taker', 'delivery_rider'),
  requireRestaurant,
  checkSubscriptionStatus
);

async function getAccountIdByCode(code, tenantId) {
  const { Account } = require('../models/accounting');
  const acct = await Account.findOne({ tenantId, code, isActive: true }).lean();
  return acct?._id || null;
}

function ensureObjectId(id) {
  return id && mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function sanitizeOrderLines(lines = []) {
  return lines.map((line) => ({
    inventoryItem: line.inventoryItem,
    itemName: String(line.itemName || '').trim(),
    unit: String(line.unit || '').trim(),
    orderedQty: Number(line.orderedQty || 0),
    receivedQty: Number(line.receivedQty || 0),
    estimatedUnitCost: Math.max(0, Number(line.estimatedUnitCost || 0)),
    notes: String(line.notes || ''),
  }));
}

function sanitizeGrnLines(lines = []) {
  return lines.map((line) => {
    const receivedQty = Number(line.receivedQty || 0);
    const unitCost = Math.max(0, Number(line.unitCost || 0));
    return {
      inventoryItem: line.inventoryItem,
      itemName: String(line.itemName || '').trim(),
      unit: String(line.unit || '').trim(),
      receivedQty,
      unitCost,
      totalCost: Math.round(receivedQty * unitCost * 100) / 100,
    };
  });
}

function buildGrnPrintHtml({ grn, restaurantName, userName }) {
  const receivedAt = grn.receivedDate ? new Date(grn.receivedDate) : new Date();
  const fmt = (d) =>
    new Date(d).toLocaleString('en-PK', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  const rowsHtml = (grn.lines || [])
    .map((line) => `
      <tr>
        <td>${line.itemName || '-'}</td>
        <td>${line.unit || '-'}</td>
        <td class="num">${line.receivedQty ?? 0}</td>
        <td class="num">Rs ${Number(line.unitCost || 0).toLocaleString()}</td>
        <td class="num">Rs ${Number(line.totalCost || 0).toLocaleString()}</td>
      </tr>
    `)
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>GRN ${grn.grnNumber}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 28px; color: #1f2937; }
    .title { text-align: center; font-size: 28px; font-weight: 800; margin: 0; }
    .subtitle { text-align: center; margin: 4px 0 16px; font-size: 14px; color: #4b5563; }
    .doc-title { text-align: center; font-size: 17px; font-weight: 700; margin: 0 0 16px; letter-spacing: .08em; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; margin-bottom: 12px; }
    .cell { border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 10px; font-size: 12px; }
    .k { color: #6b7280; font-weight: 600; margin-bottom: 4px; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; }
    .v { font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border: 1px solid #e5e7eb; padding: 8px 10px; font-size: 12px; }
    th { background: #f9fafb; text-align: left; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .total td { font-weight: 800; background: #fff7ed; }
    .notes { margin-top: 10px; padding: 10px; border: 1px dashed #d1d5db; border-radius: 6px; font-size: 12px; }
    .sign { margin-top: 32px; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; }
    .sig { text-align: center; font-size: 12px; color: #6b7280; }
    .line { margin-top: 40px; border-top: 1px solid #9ca3af; }
    .footer { margin-top: 18px; font-size: 11px; color: #6b7280; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <h1 class="title">${restaurantName || 'Restaurant'}</h1>
  <p class="subtitle">Inventory Module</p>
  <h2 class="doc-title">GOODS RECEIVED NOTE</h2>

  <div class="grid">
    <div class="cell"><div class="k">GRN No</div><div class="v">${grn.grnNumber}</div></div>
    <div class="cell"><div class="k">Date</div><div class="v">${fmt(receivedAt)}</div></div>
    <div class="cell"><div class="k">PO Ref</div><div class="v">${grn.poNumber || '-'}</div></div>
    <div class="cell"><div class="k">Invoice No</div><div class="v">${grn.invoiceNumber || '-'}</div></div>
  </div>

  <div class="cell" style="margin-bottom: 8px;">
    <div class="k">Supplier</div>
    <div class="v">${grn.supplierName}</div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th>Unit</th>
        <th class="num">Qty</th>
        <th class="num">Unit Cost</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
      <tr class="total">
        <td colspan="4" class="num">Grand Total</td>
        <td class="num">Rs ${Number(grn.totalCost || 0).toLocaleString()}</td>
      </tr>
    </tbody>
  </table>

  <div class="cell" style="margin-top: 10px;">
    <div class="k">Payment Type</div>
    <div class="v">${String(grn.paymentType || '').toUpperCase()}</div>
  </div>

  ${grn.notes ? `<div class="notes"><strong>Notes:</strong> ${grn.notes}</div>` : ''}

  <div class="sign">
    <div class="sig"><div class="line"></div><div>Received By</div></div>
    <div class="sig"><div class="line"></div><div>Checked By</div></div>
    <div class="sig"><div class="line"></div><div>Approved By</div></div>
  </div>

  <div class="footer">
    <span>Printed by: ${userName || 'User'}</span>
    <span>Printed at: ${fmt(new Date())}</span>
  </div>

  <script>window.onload = () => window.print()</script>
</body>
</html>`;
}

// ---- Purchase Orders ----
router.get('/orders', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const { status, supplierId } = req.query;
    const filter = { restaurant: restaurantId };
    if (status) filter.status = status;
    if (supplierId) filter.supplierId = supplierId;

    const [orders, total] = await Promise.all([
      PurchaseOrder.find(filter).sort({ createdAt: -1 }).lean(),
      PurchaseOrder.countDocuments(filter),
    ]);
    res.json({ orders, total });
  } catch (err) {
    next(err);
  }
});

router.post('/orders', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const { supplierName, supplierId = null, branchId, expectedDeliveryDate = null, notes = '', lines = [] } = req.body;
    if (!supplierName || !String(supplierName).trim()) {
      return res.status(400).json({ message: 'supplierName is required' });
    }
    if (!branchId) return res.status(400).json({ message: 'branchId is required' });
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: 'lines (min 1) are required' });
    }

    const branch = await Branch.findOne({ _id: branchId, restaurant: restaurantId }).lean();
    if (!branch) return res.status(400).json({ message: 'Invalid branchId for this restaurant' });

    const normalizedLines = sanitizeOrderLines(lines);
    for (const line of normalizedLines) {
      if (!line.inventoryItem || !line.itemName || !line.unit || !(line.orderedQty > 0)) {
        return res.status(400).json({ message: 'Each line requires inventoryItem, itemName, unit, orderedQty > 0' });
      }
    }
    const totalEstimatedCost = normalizedLines.reduce(
      (sum, l) => sum + l.orderedQty * (l.estimatedUnitCost || 0),
      0
    );

    const po = await PurchaseOrder.create({
      restaurant: restaurantId,
      branch: branchId,
      supplierId: ensureObjectId(supplierId),
      supplierName: String(supplierName).trim(),
      expectedDeliveryDate: expectedDeliveryDate || null,
      notes: String(notes || ''),
      lines: normalizedLines,
      totalEstimatedCost: Math.round(totalEstimatedCost * 100) / 100,
      createdBy: req.user?._id || null,
    });
    res.status(201).json(po);
  } catch (err) {
    next(err);
  }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, restaurant: restaurantId }).lean();
    if (!po) return res.status(404).json({ message: 'Purchase order not found' });
    res.json(po);
  } catch (err) {
    next(err);
  }
});

router.patch('/orders/:id', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, restaurant: restaurantId });
    if (!po) return res.status(404).json({ message: 'Purchase order not found' });
    if (po.status !== 'draft') {
      return res.status(400).json({ message: 'Only draft purchase orders can be updated' });
    }

    const { supplierName, supplierId, expectedDeliveryDate, notes, lines } = req.body;
    if (supplierName !== undefined) po.supplierName = String(supplierName || '').trim();
    if (supplierId !== undefined) po.supplierId = ensureObjectId(supplierId);
    if (expectedDeliveryDate !== undefined) po.expectedDeliveryDate = expectedDeliveryDate || null;
    if (notes !== undefined) po.notes = String(notes || '');
    if (Array.isArray(lines)) {
      const normalizedLines = sanitizeOrderLines(lines);
      for (const line of normalizedLines) {
        if (!line.inventoryItem || !line.itemName || !line.unit || !(line.orderedQty > 0)) {
          return res.status(400).json({ message: 'Each line requires inventoryItem, itemName, unit, orderedQty > 0' });
        }
      }
      po.lines = normalizedLines;
      po.totalEstimatedCost = Math.round(
        normalizedLines.reduce((sum, l) => sum + l.orderedQty * (l.estimatedUnitCost || 0), 0) * 100
      ) / 100;
    }
    await po.save();
    res.json(po);
  } catch (err) {
    next(err);
  }
});

router.patch('/orders/:id/send', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, restaurant: restaurantId });
    if (!po) return res.status(404).json({ message: 'Purchase order not found' });
    if (po.status !== 'draft') {
      return res.status(400).json({ message: 'Only draft purchase orders can be sent' });
    }
    po.status = 'sent';
    po.sentAt = new Date();
    await po.save();
    res.json(po);
  } catch (err) {
    next(err);
  }
});

router.patch('/orders/:id/cancel', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, restaurant: restaurantId });
    if (!po) return res.status(404).json({ message: 'Purchase order not found' });
    if (!['draft', 'sent'].includes(po.status)) {
      return res.status(400).json({ message: 'Only draft/sent purchase orders can be cancelled' });
    }
    po.status = 'cancelled';
    await po.save();
    res.json(po);
  } catch (err) {
    next(err);
  }
});

// ---- GRNs ----
router.get('/grn', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const { supplierId, paymentType, dateFrom, dateTo } = req.query;
    const filter = { restaurant: restaurantId };
    if (supplierId) filter.supplierId = supplierId;
    if (paymentType) filter.paymentType = paymentType;
    if (dateFrom || dateTo) {
      filter.receivedDate = {};
      if (dateFrom) filter.receivedDate.$gte = new Date(dateFrom);
      if (dateTo) filter.receivedDate.$lte = new Date(dateTo);
    }

    const [grns, total] = await Promise.all([
      GoodsReceivedNote.find(filter).sort({ createdAt: -1 }).lean(),
      GoodsReceivedNote.countDocuments(filter),
    ]);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [monthAgg, cashAgg, creditAgg] = await Promise.all([
      GoodsReceivedNote.aggregate([
        { $match: { restaurant: restaurantId, receivedDate: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: '$totalCost' } } },
      ]),
      GoodsReceivedNote.aggregate([
        { $match: { restaurant: restaurantId, paymentType: 'cash' } },
        { $group: { _id: null, total: { $sum: '$totalCost' } } },
      ]),
      GoodsReceivedNote.aggregate([
        { $match: { restaurant: restaurantId, paymentType: 'credit' } },
        { $group: { _id: null, total: { $sum: '$totalCost' } } },
      ]),
    ]);

    res.json({
      grns,
      total,
      summary: {
        thisMonthTotal: monthAgg[0]?.total || 0,
        cashTotal: cashAgg[0]?.total || 0,
        creditTotal: creditAgg[0]?.total || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/grn/:id', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const grn = await GoodsReceivedNote.findOne({ _id: req.params.id, restaurant: restaurantId }).lean();
    if (!grn) return res.status(404).json({ message: 'GRN not found' });
    res.json(grn);
  } catch (err) {
    next(err);
  }
});

router.post('/grn', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const {
      supplierName,
      supplierId = null,
      branchId,
      paymentType,
      lines = [],
      purchaseOrderId = null,
      invoiceNumber = '',
      invoiceDate = null,
      receivedDate = null,
      paymentAccountId = null,
      paymentAccountCode = null,
      notes = '',
    } = req.body;

    if (!supplierName || !String(supplierName).trim()) {
      return res.status(400).json({ message: 'supplierName is required' });
    }
    if (!branchId) return res.status(400).json({ message: 'branchId is required' });
    if (!['cash', 'credit'].includes(String(paymentType || '').toLowerCase())) {
      return res.status(400).json({ message: 'paymentType must be cash or credit' });
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: 'lines (min 1) are required' });
    }

    const branch = await Branch.findOne({ _id: branchId, restaurant: restaurantId }).lean();
    if (!branch) return res.status(400).json({ message: 'Invalid branchId for this restaurant' });

    const normalizedLines = sanitizeGrnLines(lines);
    for (const line of normalizedLines) {
      if (!line.inventoryItem || !line.itemName || !line.unit || !(line.receivedQty > 0) || line.unitCost < 0) {
        return res.status(400).json({ message: 'Each line requires inventoryItem, itemName, unit, receivedQty > 0, unitCost >= 0' });
      }
    }
    const totalCost = Math.round(normalizedLines.reduce((sum, l) => sum + l.totalCost, 0) * 100) / 100;

    let po = null;
    if (purchaseOrderId) {
      po = await PurchaseOrder.findOne({ _id: purchaseOrderId, restaurant: restaurantId, branch: branchId });
      if (!po) return res.status(404).json({ message: 'Purchase order not found for this branch' });
    }

    const grn = await GoodsReceivedNote.create({
      restaurant: restaurantId,
      branch: branchId,
      purchaseOrder: po?._id || null,
      poNumber: po?.poNumber || null,
      supplierId: ensureObjectId(supplierId),
      supplierName: String(supplierName).trim(),
      invoiceNumber: String(invoiceNumber || ''),
      invoiceDate: invoiceDate || null,
      receivedDate: receivedDate || new Date(),
      paymentType: String(paymentType).toLowerCase(),
      paymentAccountId: ensureObjectId(paymentAccountId),
      paymentAccountCode: paymentAccountCode || null,
      status: 'draft',
      lines: normalizedLines,
      totalCost,
      notes: String(notes || ''),
      createdBy: req.user?._id || null,
    });

    // Update stock (must not fail silently)
    for (const line of normalizedLines) {
      await BranchInventory.findOneAndUpdate(
        { branch: branchId, inventoryItem: line.inventoryItem },
        {
          $inc: { currentStock: line.receivedQty },
          $setOnInsert: { lowStockThreshold: 0, costPrice: 0 },
        },
        { upsert: true, new: true }
      );
    }

    // Update PO receiving progress when linked
    if (po) {
      for (const grnLine of normalizedLines) {
        const idx = po.lines.findIndex((l) => String(l.inventoryItem) === String(grnLine.inventoryItem));
        if (idx >= 0) {
          po.lines[idx].receivedQty = Number(po.lines[idx].receivedQty || 0) + Number(grnLine.receivedQty || 0);
        }
      }
      const fullyReceived = po.lines.every((l) => Number(l.receivedQty || 0) >= Number(l.orderedQty || 0));
      po.status = fullyReceived ? 'received' : 'partially_received';
      await po.save();
    }

    // Accounting (must not block GRN posting)
    try {
      let voucher = null;
      const rawMaterialsId =
        (await getAccountIdByCode('30501', restaurantId)) ||
        (await getAccountIdByCode('305', restaurantId));
      if (!rawMaterialsId) throw new Error('Inventory account not found (30501/305)');

      if (grn.paymentType === 'cash') {
        const cashAccountId =
          ensureObjectId(paymentAccountId) || (await getAccountIdByCode('30101', restaurantId));
        if (!cashAccountId) throw new Error('Cash account not found (30101)');
        voucher = await createVoucher({
          tenantId: restaurantId,
          type: 'cash_payment',
          date: grn.receivedDate || new Date(),
          notes: `Stock received: GRN ${grn.grnNumber} — ${grn.supplierName}`,
          autoPosted: true,
          sourceType: 'grn',
          lines: [
            {
              accountId: cashAccountId,
              debit: 0,
              credit: grn.totalCost,
              description: `Cash paid for GRN ${grn.grnNumber}`,
            },
            {
              accountId: rawMaterialsId,
              debit: grn.totalCost,
              credit: 0,
              description: `Stock received: ${grn.supplierName}`,
            },
          ],
        });
      } else {
        const suppliersPayableId = await getAccountIdByCode('20101', restaurantId);
        if (!suppliersPayableId) throw new Error('Suppliers payable account not found (20101)');
        voucher = await createVoucher({
          tenantId: restaurantId,
          type: 'journal',
          date: grn.receivedDate || new Date(),
          notes: `Stock received on credit: GRN ${grn.grnNumber} — ${grn.supplierName}`,
          autoPosted: true,
          sourceType: 'grn',
          lines: [
            {
              accountId: rawMaterialsId,
              debit: grn.totalCost,
              credit: 0,
              description: `Stock received: ${grn.supplierName}`,
            },
            {
              accountId: suppliersPayableId,
              debit: 0,
              credit: grn.totalCost,
              description: `Payable to ${grn.supplierName} — GRN ${grn.grnNumber}`,
              partyId: grn.supplierId || null,
              partyName: grn.supplierName,
            },
          ],
        });
      }

      if (voucher) {
        grn.accountingVoucherId = voucher._id;
        grn.accountingVoucherNumber = voucher.voucherNumber;
      }
    } catch (err) {
      grn.accountingError = err.message;
      console.error('GRN accounting post failed:', err.message);
    }

    grn.status = 'posted';
    grn.postedAt = new Date();
    await grn.save();

    res.status(201).json({
      grn,
      message: `GRN ${grn.grnNumber} posted successfully`,
      voucherNumber: grn.accountingVoucherNumber || null,
      accountingError: grn.accountingError || null,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/grn/:id/print', async (req, res, next) => {
  try {
    const restaurantId = req.restaurant._id;
    const grn = await GoodsReceivedNote.findOne({
      _id: req.params.id,
      restaurant: restaurantId,
    })
      .populate('lines.inventoryItem', 'name')
      .lean();
    if (!grn) return res.status(404).json({ message: 'GRN not found' });

    const html = buildGrnPrintHtml({
      grn,
      restaurantName: req.restaurant?.name || 'Restaurant',
      userName: req.user?.name || req.user?.email || 'User',
    });
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
