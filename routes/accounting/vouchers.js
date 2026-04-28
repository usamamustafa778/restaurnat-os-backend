const express = require('express');
const { Voucher, JournalEntry } = require('../../models/accounting');
const Account = require('../../models/accounting/Account');
const Branch  = require('../../models/Branch');
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

    // ── Issue 1: GL name resolution with code-prefix fallback ─────────
    //
    // Strategy:
    //   1. Fetch the leaf account for each line.
    //   2. If it has a parentId, fetch the parent — use parent.name as GL.
    //   3. If no parentId (or parent not found), use code-prefix map as fallback.
    //   4. If no code match, fall back to the account's own name.

    const CODE_GL_MAP = [
      { prefix: '301', gl: 'CASH IN HAND' },
      { prefix: '302', gl: 'BANK BALANCES' },
      { prefix: '303', gl: 'EASYPAISA / JAZZCASH' },
      { prefix: '201', gl: 'SUPPLIERS' },
      { prefix: '401', gl: 'SALES' },
      { prefix: '501', gl: 'COST OF GOODS SOLD' },
      { prefix: '601', gl: 'EXPENSES' },
    ];

    function glFromCode(code) {
      if (!code) return null;
      const s = String(code);
      for (const { prefix, gl } of CODE_GL_MAP) {
        if (s.startsWith(prefix)) return gl;
      }
      return null;
    }

    const accountIds = [...new Set(voucher.lines.map((l) => String(l.accountId)).filter(Boolean))];
    const accounts = accountIds.length
      ? await Account.find({ _id: { $in: accountIds } }).lean()
      : [];
    const accountMap = Object.fromEntries(accounts.map((a) => [String(a._id), a]));

    // Collect parent IDs from accounts that have one
    const parentIds = [
      ...new Set(accounts.filter((a) => a.parentId).map((a) => String(a.parentId))),
    ];
    const parentMap = {};
    if (parentIds.length) {
      const parents = await Account.find({ _id: { $in: parentIds } }).lean();
      parents.forEach((p) => { parentMap[String(p._id)] = p; });
    }

    console.log(`[PRINT ${voucher.voucherNumber}] lines=${voucher.lines.length} accountsFound=${accounts.length} parentsFound=${Object.keys(parentMap).length}`);
    accounts.forEach((a) => {
      const parent = a.parentId ? parentMap[String(a.parentId)] : null;
      console.log(`  acc "${a.name}" (${a.code}) parentId=${a.parentId || 'none'} → parent="${parent?.name || 'NOT FOUND'}" codeGL="${glFromCode(a.code) || '-'}"`);
    });

    // Resolve final GL name for one account
    function resolveGlName(line) {
      const acc = accountMap[String(line.accountId)];
      const accName = (acc?.name || line.accountName || '').toUpperCase();
      const accCode = acc?.code || '';

      if (acc?.parentId) {
        const parent = parentMap[String(acc.parentId)];
        if (parent) return parent.name.toUpperCase();
        // Parent ID exists but wasn't found — try code fallback
        return glFromCode(accCode) || accName;
      }

      // No parentId: try code prefix map, then account name
      return glFromCode(accCode) || accName;
    }

    // ── Helpers ───────────────────────────────────────────────────────
    const pad2 = (n) => String(n).padStart(2, '0');
    const d = new Date(voucher.date);
    const dateStr   = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
    const now       = new Date();
    const timeStr   = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const dateFooter = `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`;

    const typeTitle  = PRINT_TYPE_TITLE[voucher.type] || String(voucher.type || 'VOUCHER').toUpperCase();
    const tenantName = restaurant.website?.name || restaurant.name || 'Restaurant';
    const createdByName = (voucher.createdBy?.name || voucher.createdBy?.email || '—').toUpperCase();

    // Fetch the first active branch so we can show a real branch name
    const branch     = await Branch.findOne({ restaurant: restaurant._id, isDeleted: { $ne: true } })
                                   .sort({ sortOrder: 1, createdAt: 1 })
                                   .lean();
    const branchName = branch?.name || '';

    const totalDebit  = voucher.lines.reduce((s, l) => s + (l.debit  || 0), 0);
    const totalCredit = voucher.lines.reduce((s, l) => s + (l.credit || 0), 0);

    const fmtAmt = (n) => (n > 0
      ? n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '');

    // ── Two-row rendering per voucher line ────────────────────────────
    //
    // Row 1 — GL / parent level:
    //   Account Description = parent account name (if parentId exists)
    //                       OR account own name if no parent
    //   Voucher Description = EMPTY
    //   Debit / Credit      = the amounts for this line
    //
    // Row 2 — Title / subsidiary level (ALWAYS rendered):
    //   Account Description = partyName if a party is attached,
    //                         otherwise the account's own name
    //   Voucher Description = the line description (may be empty)
    //   Debit / Credit      = EMPTY (already shown in Row 1)

    const TD  = 'style="border:1px solid #ccc;padding:6px 10px"';
    const TDR = 'style="border:1px solid #ccc;padding:6px 10px;text-align:right;font-family:monospace;white-space:nowrap"';
    const TDS = 'style="border:1px solid #ccc;padding:6px 10px;background:#f7f7f7"';

    const lineRows = voucher.lines.map((l) => {
      const acc = accountMap[String(l.accountId)];

      // Row 1: parent/GL account name
      const glName = escHtml(resolveGlName(l));

      // Row 2: party name preferred; fall back to the account's own name
      const ownName   = (acc?.name || l.accountName || '').toUpperCase();
      const partyName = (l.partyName || '').trim().toUpperCase();
      const subName   = escHtml(partyName || ownName);
      const desc = escHtml((l.description || '').toUpperCase());

      const row1 = `<tr>
        <td ${TD}>${glName}</td>
        <td ${TD}></td>
        <td ${TDR}>${fmtAmt(l.debit)}</td>
        <td ${TDR}>${fmtAmt(l.credit)}</td>
      </tr>`;

      // Row 2 is ALWAYS rendered for every line
      const row2 = `<tr>
        <td ${TDS}>${subName}</td>
        <td ${TDS}>${desc}</td>
        <td ${TDR}></td>
        <td ${TDR}></td>
      </tr>`;

      return row1 + row2;
    }).join('');

    // ── Issue 3: Libre Barcode 128 via Google Fonts ───────────────────
    const barcodeNum = escHtml(voucher.voucherNumber);

    // ── HTML ──────────────────────────────────────────────────────────
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml(typeTitle)} — ${barcodeNum}</title>
<!-- Issue 3: Libre Barcode 128 for real CODE128 rendering -->
<link href="https://fonts.googleapis.com/css2?family=Libre+Barcode+128&display=swap" rel="stylesheet"/>
<style>
/* Issue 2: global uppercase on all table cells */
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;padding:24px 28px 36px;max-width:960px;margin:0 auto;background:#fff}
table td,table th{text-transform:uppercase}

/* Header */
.header-wrap{display:flex;align-items:flex-start;margin-bottom:18px;gap:16px}
.header-left{flex:1;min-width:0}

/* Issue 5: restaurant name 32px/900 */
.rest-name{font-size:32px;font-weight:900;text-align:center;letter-spacing:1px;line-height:1.1;margin-bottom:4px}
.unit-code{font-size:13px;font-weight:normal;text-align:center;color:#444;margin-bottom:10px}
.type-title{font-size:15px;font-weight:bold;text-align:left;letter-spacing:0.08em;margin-top:10px;text-transform:uppercase}

/* Issue 3: barcode top-right */
.header-right{display:flex;flex-direction:column;align-items:flex-end;gap:10px;flex-shrink:0;min-width:230px}
.barcode{text-align:center;margin-bottom:4px}
.barcode-bars{font-family:'Libre Barcode 128',monospace;font-size:42px;letter-spacing:-1px;line-height:1;color:#111}
.barcode-number{font-size:9px;letter-spacing:1.5px;color:#111;text-align:center;margin-top:2px;font-family:monospace}

.info-box{border:2px solid #111;padding:9px 13px;font-size:11px;line-height:1.85;min-width:210px}
.info-box div{display:flex;gap:6px}
.info-box strong{flex-shrink:0}

/* Table */
table{width:100%;border-collapse:collapse;margin-bottom:22px;font-size:11.5px}
th{border:1px solid #444;padding:8px 10px;text-align:left;background:#3a3a3a;color:#fff;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:0.05em}
th.num{text-align:right}
.total-row td{font-weight:bold;border-top:3px double #111;border-bottom:2px solid #111;border-left:1px solid #555;border-right:1px solid #555;padding:10px;font-size:12px;text-transform:uppercase}
.total-row td.num{text-align:right;font-family:monospace}

/* Issue 4: signature block */
.sigs{display:table;width:100%;table-layout:fixed;margin-top:44px;border-collapse:separate;border-spacing:20px 0}
.sig{display:table-cell;text-align:center;font-size:11px;vertical-align:top;padding:0 8px}
.sig-name{font-weight:bold;margin-bottom:24px;font-size:11px;color:#111;text-transform:uppercase;letter-spacing:0.5px;word-break:break-word}
.sig-line{border-top:1px solid #111;padding-top:7px;font-size:11px}

.footer{margin-top:20px;font-size:10px;color:#555;text-align:left;border-top:1px solid #ddd;padding-top:8px}
@media print{body{padding:12px 16px}}
</style>
</head>
<body>

<div class="header-wrap">
  <div class="header-left">
    <div class="rest-name">${escHtml(tenantName)}</div>
    ${branchName ? `<div class="unit-code">${escHtml(branchName)}</div>` : ''}
    <div class="type-title">${escHtml(typeTitle)}</div>
  </div>
  <div class="header-right">
    <!-- Issue 3: real CODE128 barcode via Google Font -->
    <div class="barcode">
      <div class="barcode-bars">${barcodeNum}</div>
      <div class="barcode-number">${barcodeNum}</div>
    </div>
    <div class="info-box">
      <div><strong>Unit:</strong><span>${escHtml(branchName || tenantName)}</span></div>
      <div><strong>Trans Date:</strong><span>${escHtml(dateStr)}</span></div>
      <div><strong>Voucher #:</strong><span>${barcodeNum}</span></div>
      ${voucher.referenceNo ? `<div><strong>Ref:</strong><span>${escHtml(voucher.referenceNo)}</span></div>` : ''}
    </div>
  </div>
</div>

<!-- Issue 2: text-transform uppercase applied via CSS above -->
<table>
  <thead>
    <tr>
      <th style="width:30%">Account Description</th>
      <th style="width:38%">Voucher Description</th>
      <th class="num" style="width:16%">Debit</th>
      <th class="num" style="width:16%">Credit</th>
    </tr>
  </thead>
  <tbody>
    ${lineRows}
    <tr class="total-row">
      <td colspan="2" style="text-align:right;border-left:1px solid #555">Total</td>
      <td class="num">${fmtAmt(totalDebit)}</td>
      <td class="num">${fmtAmt(totalCredit)}</td>
    </tr>
  </tbody>
</table>

<!-- Issue 4: creator name above Prepared By -->
<div class="sigs">
  <div class="sig">
    <div class="sig-name">${escHtml(createdByName)}</div>
    <div class="sig-line">Prepared By</div>
  </div>
  <div class="sig">
    <div class="sig-name">&nbsp;</div>
    <div class="sig-line">Checked By</div>
  </div>
  <div class="sig">
    <div class="sig-name">&nbsp;</div>
    <div class="sig-line">Approved By</div>
  </div>
  <div class="sig">
    <div class="sig-name">&nbsp;</div>
    <div class="sig-line">Received By</div>
  </div>
</div>

<div class="footer">User: ${escHtml(createdByName)} &nbsp;|&nbsp; Date: ${escHtml(dateFooter)} &nbsp;|&nbsp; Time: ${escHtml(timeStr)}</div>
<script>window.onload=function(){window.print()};</script>
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
    console.log('Raw request lines:', JSON.stringify(req.body.lines, null, 2));

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
