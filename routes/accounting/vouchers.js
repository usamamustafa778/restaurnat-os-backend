const express = require('express');
const { Voucher, JournalEntry } = require('../../models/accounting');
const { protect, requireRole } = require('../../middleware/authMiddleware');
const Restaurant = require('../../models/Restaurant');
const { createVoucher, peekNextVoucherNumber } = require('../../services/accounting/voucherService');

const VOUCHER_TYPE_LABELS = {
  cash_payment:  'Cash Payment Voucher',
  cash_receipt:  'Cash Receipt Voucher',
  bank_payment:  'Bank Payment Voucher',
  bank_receipt:  'Bank Receipt Voucher',
  journal:       'Journal Voucher',
  card_transfer: 'Card Transfer Voucher',
};

const router = express.Router();

async function resolveTenant(req, res) {
  const tenantSlug = req.headers['x-tenant-slug'];
  if (req.user.role === 'super_admin') {
    if (!tenantSlug) { res.status(400).json({ message: 'Super admin must send x-tenant-slug' }); return null; }
    const r = await Restaurant.findOne({ 'website.subdomain': tenantSlug });
    if (!r) { res.status(404).json({ message: 'Restaurant not found' }); return null; }
    return r;
  }
  if (!req.user.restaurant) { res.status(400).json({ message: 'User is not linked to any restaurant' }); return null; }
  const r = await Restaurant.findById(req.user.restaurant);
  if (!r) { res.status(404).json({ message: 'Restaurant not found' }); return null; }
  return r;
}

const ADMIN_ROLES = ['restaurant_admin', 'super_admin', 'admin', 'manager'];

router.use(protect, requireRole('restaurant_admin', 'super_admin', 'admin', 'manager', 'cashier'));

// GET /api/accounting/vouchers/next-number?type=X  (peek — no increment)
router.get('/next-number', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    const { type } = req.query;
    const VALID = ['cash_payment', 'cash_receipt', 'bank_payment', 'bank_receipt', 'journal', 'card_transfer'];
    if (!type || !VALID.includes(type)) {
      return res.status(400).json({ message: 'Valid type is required' });
    }

    const number = await peekNextVoucherNumber(restaurant._id, type);
    return res.json({ number });
  } catch (err) {
    console.error('Peek voucher number error:', err);
    return res.status(500).json({ message: 'Failed to get voucher number' });
  }
});

// GET /api/accounting/vouchers
router.get('/', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    const { type, status, dateFrom, dateTo } = req.query;

    const filter = { tenantId };
    if (type)   filter.type   = type;
    if (status) filter.status = status;
    if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) filter.date.$gte = new Date(dateFrom);
      if (dateTo)   filter.date.$lte = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
    }

    const [vouchers, total] = await Promise.all([
      Voucher.find(filter).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Voucher.countDocuments(filter),
    ]);

    return res.json({ vouchers, total, page });
  } catch (err) {
    console.error('Get vouchers error:', err);
    return res.status(500).json({ message: 'Failed to fetch vouchers' });
  }
});

// GET /api/accounting/vouchers/:id
router.get('/:id', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    const voucher = await Voucher.findOne({ _id: req.params.id, tenantId: restaurant._id }).lean();
    if (!voucher) return res.status(404).json({ message: 'Voucher not found' });

    return res.json(voucher);
  } catch (err) {
    console.error('Get voucher error:', err);
    return res.status(500).json({ message: 'Failed to fetch voucher' });
  }
});

// POST /api/accounting/vouchers
router.post('/', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    const { type, date, referenceNo, notes, lines } = req.body;

    if (!type) return res.status(400).json({ message: 'Voucher type is required' });
    if (!date) return res.status(400).json({ message: 'Date is required' });

    const voucher = await createVoucher({
      tenantId:   restaurant._id,
      type,
      date:       new Date(date),
      referenceNo,
      notes,
      lines,
      createdBy:  req.user.id,
    });

    return res.status(201).json(voucher);
  } catch (err) {
    console.error('Create voucher error:', err);
    return res.status(400).json({ message: err.message || 'Failed to create voucher' });
  }
});

// GET /api/accounting/vouchers/:id/print  (returns HTML)
router.get('/:id/print', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    const voucher = await Voucher.findOne({ _id: req.params.id, tenantId: restaurant._id })
      .populate('createdBy', 'name')
      .lean();
    if (!voucher) return res.status(404).send('<p>Voucher not found</p>');

    const pad2 = (n) => String(n).padStart(2, '0');
    const d = new Date(voucher.date);
    const dateStr = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
    const now = new Date();
    const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const typeLabel = VOUCHER_TYPE_LABELS[voucher.type] || voucher.type;
    const tenantName = restaurant.name || 'EatsDesk';
    const createdByName = voucher.createdBy?.name || '—';

    const totalDebit  = voucher.lines.reduce((s, l) => s + (l.debit  || 0), 0);
    const totalCredit = voucher.lines.reduce((s, l) => s + (l.credit || 0), 0);

    const fmtAmt = (n) => n > 0 ? n.toLocaleString('en-PK', { minimumFractionDigits: 2 }) : '';

    const lineRows = voucher.lines.map((l, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${l.accountName || l.accountId || '—'}</td>
        <td>${l.partyName || '—'}</td>
        <td>${l.description || ''}</td>
        <td style="text-align:right">${fmtAmt(l.debit)}</td>
        <td style="text-align:right">${fmtAmt(l.credit)}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${typeLabel} — ${voucher.voucherNumber}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 12px; color: #111; padding: 24px; max-width: 900px; margin: auto; }
  h1 { font-size: 20px; font-weight: bold; text-align: center; margin-bottom: 2px; }
  h2 { font-size: 13px; font-weight: normal; text-align: center; color: #555; margin-bottom: 16px; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 16px; border: 1px solid #ccc; padding: 10px 14px; border-radius: 4px; }
  .meta div { line-height: 1.8; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: #f0f0f0; border: 1px solid #ccc; padding: 6px 8px; text-align: left; font-size: 11px; }
  td { border: 1px solid #ddd; padding: 5px 8px; }
  .total-row td { font-weight: bold; background: #f9f9f9; }
  .sigs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; margin-top: 32px; }
  .sig { border-top: 1px solid #333; padding-top: 6px; text-align: center; font-size: 11px; color: #555; }
  .footer { margin-top: 18px; font-size: 10px; color: #888; text-align: right; }
  @media print { body { padding: 12px; } button { display: none !important; } }
</style>
</head>
<body>
<button onclick="window.print()" style="float:right;padding:6px 14px;background:#e55a1c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;margin-bottom:8px">Print</button>
<h1>${tenantName}</h1>
<h2>${typeLabel}</h2>

<div class="meta">
  <div>
    <strong>Tenant:</strong> ${tenantName}<br>
    <strong>Date:</strong> ${dateStr}<br>
    <strong>Voucher #:</strong> ${voucher.voucherNumber}
  </div>
  <div>
    ${voucher.referenceNo ? `<strong>Reference:</strong> ${voucher.referenceNo}<br>` : ''}
    <strong>Status:</strong> ${voucher.status}<br>
    ${voucher.notes ? `<strong>Notes:</strong> ${voucher.notes}` : ''}
  </div>
</div>

<table>
  <thead>
    <tr>
      <th style="width:30px">#</th>
      <th>Account</th>
      <th>Party</th>
      <th>Description</th>
      <th style="text-align:right;width:110px">Debit (Rs)</th>
      <th style="text-align:right;width:110px">Credit (Rs)</th>
    </tr>
  </thead>
  <tbody>
    ${lineRows}
  </tbody>
  <tfoot>
    <tr class="total-row">
      <td colspan="4" style="text-align:right">Total</td>
      <td style="text-align:right">${fmtAmt(totalDebit)}</td>
      <td style="text-align:right">${fmtAmt(totalCredit)}</td>
    </tr>
  </tfoot>
</table>

<div class="sigs">
  <div class="sig">Prepared By</div>
  <div class="sig">Checked By</div>
  <div class="sig">Approved By</div>
  <div class="sig">Received By</div>
</div>

<div class="footer">
  User: ${createdByName} &nbsp;|&nbsp; Date: ${dateStr} &nbsp;|&nbsp; Time: ${timeStr}
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  } catch (err) {
    console.error('Print voucher error:', err);
    return res.status(500).send('<p>Error generating print view</p>');
  }
});

// POST /api/accounting/vouchers/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    if (!ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({ message: 'Only admin roles can cancel vouchers' });
    }

    const voucher = await Voucher.findOne({ _id: req.params.id, tenantId: restaurant._id });
    if (!voucher) return res.status(404).json({ message: 'Voucher not found' });
    if (voucher.status === 'cancelled') return res.status(400).json({ message: 'Already cancelled' });

    await JournalEntry.deleteMany({ voucherId: voucher._id });
    await Voucher.findByIdAndUpdate(voucher._id, { status: 'cancelled' });

    return res.json({ success: true });
  } catch (err) {
    console.error('Cancel voucher error:', err);
    return res.status(500).json({ message: 'Failed to cancel voucher' });
  }
});

module.exports = router;
