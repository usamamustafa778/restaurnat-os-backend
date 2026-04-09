const express = require('express');
const { Voucher, JournalEntry } = require('../../models/accounting');
const { protect, requireRole } = require('../../middleware/authMiddleware');
const Restaurant = require('../../models/Restaurant');
const { createVoucher, peekNextVoucherNumber } = require('../../services/accounting/voucherService');

const PRINT_TYPE_TITLE = {
  cash_payment:  'CASH PAYMENT VOUCHER',
  cash_receipt:  'CASH RECEIPT VOUCHER',
  bank_payment:  'BANK PAYMENT VOUCHER',
  bank_receipt:  'BANK RECEIPT VOUCHER',
  journal:       'JOURNAL ENTRY VOUCHER',
  card_transfer: 'CARD TRANSFER VOUCHER',
};

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

// GET /api/accounting/vouchers/:id/print — must be registered before /:id
router.get('/:id/print', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    const voucher = await Voucher.findOne({ _id: req.params.id, tenantId: restaurant._id })
      .populate('createdBy', 'name email')
      .lean();
    if (!voucher) return res.status(404).send('<p>Voucher not found</p>');

    const pad2 = (n) => String(n).padStart(2, '0');
    const d = new Date(voucher.date);
    const dateStr = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
    const now = new Date();
    const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const dateFooter = `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`;
    const typeTitle = PRINT_TYPE_TITLE[voucher.type] || String(voucher.type || 'VOUCHER').toUpperCase();
    const tenantName = restaurant.website?.name || restaurant.name || 'Restaurant';
    const createdByName = voucher.createdBy?.name || voucher.createdBy?.email || '—';

    const totalDebit = voucher.lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totalCredit = voucher.lines.reduce((s, l) => s + (l.credit || 0), 0);

    const fmtCell = (n) => (n > 0
      ? n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '');

    const lineRows = voucher.lines.map((l) => `
      <tr>
        <td style="border:1px solid #333;padding:8px 10px">${escHtml(l.accountName || l.accountId || '—')}</td>
        <td style="border:1px solid #333;padding:8px 10px">${escHtml(l.description || '')}</td>
        <td style="border:1px solid #333;padding:8px 10px;text-align:right;font-family:monospace">${fmtCell(l.debit)}</td>
        <td style="border:1px solid #333;padding:8px 10px;text-align:right;font-family:monospace">${fmtCell(l.credit)}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(typeTitle)} — ${escHtml(voucher.voucherNumber)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; padding: 20px 24px 32px; max-width: 920px; margin: 0 auto; }
  .rest-name { font-size: 22px; font-weight: bold; text-align: center; margin-bottom: 6px; }
  .type-title { font-size: 14px; font-weight: bold; text-align: center; letter-spacing: 0.04em; margin-bottom: 18px; }
  .top-row { display: flex; justify-content: flex-end; margin-bottom: 16px; }
  .info-box { border: 2px solid #111; padding: 10px 14px; min-width: 220px; font-size: 11px; line-height: 1.7; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { border: 1px solid #333; padding: 8px 10px; text-align: left; background: #e8e8e8; font-size: 11px; font-weight: bold; }
  th.num { text-align: right; }
  .total-row td { font-weight: bold; border: 2px solid #111; padding: 10px; background: #f5f5f5; }
  .total-row td.num { text-align: right; font-family: monospace; }
  .sigs { display: table; width: 100%; table-layout: fixed; margin-top: 40px; border-collapse: separate; border-spacing: 16px 0; }
  .sig { display: table-cell; border-top: 1px solid #111; padding-top: 8px; text-align: center; font-size: 11px; vertical-align: top; }
  .footer { margin-top: 24px; font-size: 10px; color: #444; text-align: right; border-top: 1px solid #ccc; padding-top: 10px; }
</style>
</head>
<body>
  <div class="rest-name">${escHtml(tenantName)}</div>
  <div class="type-title">${escHtml(typeTitle)}</div>
  <div class="top-row">
    <div class="info-box">
      <div><strong>Unit:</strong> ${escHtml(tenantName)}</div>
      <div><strong>Trans Date:</strong> ${escHtml(dateStr)}</div>
      <div><strong>Voucher No:</strong> ${escHtml(voucher.voucherNumber)}</div>
      ${voucher.referenceNo ? `<div><strong>Reference:</strong> ${escHtml(voucher.referenceNo)}</div>` : ''}
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Account Description</th>
        <th>Voucher Description</th>
        <th class="num">Debit</th>
        <th class="num">Credit</th>
      </tr>
    </thead>
    <tbody>
      ${lineRows}
      <tr class="total-row">
        <td colspan="2" style="text-align:right">Total</td>
        <td class="num">${fmtCell(totalDebit)}</td>
        <td class="num">${fmtCell(totalCredit)}</td>
      </tr>
    </tbody>
  </table>
  <div class="sigs">
    <div class="sig">Prepared By</div>
    <div class="sig">Checked By</div>
    <div class="sig">Approved By</div>
    <div class="sig">Received By</div>
  </div>
  <div class="footer">User: ${escHtml(createdByName)} &nbsp;|&nbsp; Date: ${escHtml(dateFooter)} &nbsp;|&nbsp; Time: ${escHtml(timeStr)}</div>
  <script>window.onload = function () { window.print(); };</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    console.error('Print voucher error:', err);
    return res.status(500).send('<p>Error generating print view</p>');
  }
});

// GET /api/accounting/vouchers/:id
router.get('/:id', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    const voucher = await Voucher.findOne({ _id: req.params.id, tenantId: restaurant._id })
      .populate('reversalOf', 'voucherNumber')
      .populate('reversedBy', 'voucherNumber')
      .lean();
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

// POST /api/accounting/vouchers/:id/reverse
router.post('/:id/reverse', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    if (!ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({ message: 'Only admin roles can reverse vouchers' });
    }

    const original = await Voucher.findOne({ _id: req.params.id, tenantId: restaurant._id });
    if (!original) return res.status(404).json({ message: 'Voucher not found' });
    if (original.status !== 'posted') return res.status(400).json({ message: 'Only posted vouchers can be reversed' });
    if (original.isReversed) return res.status(400).json({ message: 'This voucher has already been reversed' });

    // Flip debit ↔ credit for every line
    const reversedLines = original.lines.map((l) => ({
      accountId:   l.accountId,
      accountName: l.accountName,
      partyId:     l.partyId   || null,
      partyName:   l.partyName || '',
      debit:       l.credit,
      credit:      l.debit,
      description: l.description,
      sequence:    l.sequence,
    }));

    const { createVoucher } = require('../../services/accounting/voucherService');

    const reversalVoucher = await createVoucher({
      tenantId:    restaurant._id,
      type:        original.type,
      date:        new Date(),
      referenceNo: original.referenceNo,
      notes:       `Reversal of ${original.voucherNumber}`,
      lines:       reversedLines,
      createdBy:   req.user.id,
    });

    // Tag both vouchers
    await Promise.all([
      Voucher.findByIdAndUpdate(reversalVoucher._id, {
        isReversal: true,
        reversalOf: original._id,
      }),
      Voucher.findByIdAndUpdate(original._id, {
        isReversed: true,
        reversedBy: reversalVoucher._id,
      }),
    ]);

    const updated = await Voucher.findById(reversalVoucher._id)
      .populate('reversalOf', 'voucherNumber')
      .lean();

    return res.status(201).json({ reversal: updated, originalId: original._id.toString() });
  } catch (err) {
    console.error('Reverse voucher error:', err);
    return res.status(400).json({ message: err.message || 'Failed to reverse voucher' });
  }
});

module.exports = router;
