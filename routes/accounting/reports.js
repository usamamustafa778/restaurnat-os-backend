const express = require('express');
const mongoose = require('mongoose');
const { JournalEntry, Voucher, Account } = require('../../models/accounting');
const { Party } = require('../../models/accounting');
const { protect, requireRole } = require('../../middleware/authMiddleware');
const Restaurant = require('../../models/Restaurant');

const router = express.Router();

// ─── Tenant resolver ──────────────────────────────────────────────────────────

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

router.use(protect, requireRole('restaurant_admin', 'super_admin', 'admin', 'manager'));

// ─── GET /api/accounting/reports/ledger ──────────────────────────────────────

router.get('/ledger', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const { accountId, partyId, dateFrom, dateTo, limit } = req.query;
    if (!accountId && !partyId) {
      return res.status(400).json({ message: 'accountId or partyId is required' });
    }
    if (!dateFrom || !dateTo) return res.status(400).json({ message: 'dateFrom and dateTo are required' });

    const dateStart = new Date(dateFrom); dateStart.setHours(0, 0, 0, 0);
    const dateEnd   = new Date(dateTo);   dateEnd.setHours(23, 59, 59, 999);

    const match = {
      tenantId: new mongoose.Types.ObjectId(tenantId),
      ...(accountId ? { accountId: new mongoose.Types.ObjectId(accountId) } : {}),
      ...(partyId ? { partyId: new mongoose.Types.ObjectId(partyId) } : {}),
    };

    // Opening balance — all entries strictly before dateFrom
    const openingAgg = await JournalEntry.aggregate([
      {
        $match: {
          ...match,
          date:      { $lt: dateStart },
        },
      },
      {
        $group: {
          _id:         null,
          totalDebit:  { $sum: '$debit' },
          totalCredit: { $sum: '$credit' },
        },
      },
    ]);

    const openingBalance = (openingAgg[0]?.totalDebit || 0) - (openingAgg[0]?.totalCredit || 0);

    // Period entries with running totals via $setWindowFields (MongoDB 5.0+)
    const windowStage = accountId
      ? {
          $setWindowFields: {
            partitionBy: '$accountId',
            sortBy:      { date: 1, createdAt: 1 },
            output: {
              runningDebit:  { $sum: '$debit',  window: { documents: ['unbounded', 'current'] } },
              runningCredit: { $sum: '$credit', window: { documents: ['unbounded', 'current'] } },
            },
          },
        }
      : {
          $setWindowFields: {
            sortBy:      { date: 1, createdAt: 1 },
            output: {
              runningDebit:  { $sum: '$debit',  window: { documents: ['unbounded', 'current'] } },
              runningCredit: { $sum: '$credit', window: { documents: ['unbounded', 'current'] } },
            },
          },
        };

    const entries = await JournalEntry.aggregate([
      {
        $match: {
          ...match,
          date:      { $gte: dateStart, $lte: dateEnd },
        },
      },
      { $sort: { date: 1, createdAt: 1 } },
      windowStage,
      {
        $project: {
          accountId:     1,
          partyId:       1,
          date:          1,
          voucherNumber: 1,
          voucherType:   1,
          voucherId:     1,
          debit:         1,
          credit:        1,
          description:   1,
          partyName:     1,
          accountName:   1,
          balance:       { $subtract: ['$runningDebit', '$runningCredit'] },
        },
      },
    ]);

    const limitedEntries = Number(limit) > 0 ? entries.slice(-Number(limit)) : entries;

    // Offset every row's running balance by the opening balance
    const entriesWithBalance = limitedEntries.map((e) => ({
      ...e,
      balance: openingBalance + e.balance,
    }));

    const closingBalance = entries.length > 0
      ? openingBalance + entries[entries.length - 1].balance
      : openingBalance;

    return res.json({ openingBalance, entries: entriesWithBalance, closingBalance });
  } catch (err) {
    console.error('Ledger report error:', err);
    return res.status(500).json({ message: err.message || 'Failed to generate ledger' });
  }
});

// ─── GET /api/accounting/reports/day-book ────────────────────────────────────

router.get('/day-book', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const { date, type } = req.query;
    if (!date) return res.status(400).json({ message: 'date is required (YYYY-MM-DD)' });

    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end   = new Date(date); end.setHours(23, 59, 59, 999);

    const filter = {
      tenantId,
      date:   { $gte: start, $lte: end },
      status: 'posted',
    };
    if (type) filter.type = type;

    const vouchers = await Voucher.find(filter).sort({ createdAt: 1 }).lean();

    const voucherIds = vouchers.map((v) => v._id);
    let journalLinesByVoucher = {};
    if (voucherIds.length) {
      const journalRows = await JournalEntry.find({
        tenantId: new mongoose.Types.ObjectId(tenantId),
        voucherId: { $in: voucherIds.map((id) => new mongoose.Types.ObjectId(id)) },
      })
        .sort({ date: 1, createdAt: 1 })
        .lean();

      journalLinesByVoucher = journalRows.reduce((acc, j) => {
        const key = j.voucherId?.toString();
        if (!key) return acc;
        if (!acc[key]) acc[key] = [];
        acc[key].push({
          accountId: j.accountId,
          accountName: j.accountName || '',
          partyId: j.partyId || null,
          partyName: j.partyName || '',
          debit: j.debit || 0,
          credit: j.credit || 0,
          description: j.description || '',
          sequence: j.sequence || 0,
        });
        return acc;
      }, {});
    }

    const vouchersWithJournalLines = vouchers.map((v) => ({
      ...v,
      lines: journalLinesByVoucher[v._id.toString()] || [],
    }));

    const summary = {
      cash_payment:  0,
      cash_receipt:  0,
      bank_payment:  0,
      bank_receipt:  0,
      journal:       0,
      card_transfer: 0,
      total:         0,
    };
    vouchersWithJournalLines.forEach((v) => {
      if (summary[v.type] !== undefined) summary[v.type] += v.totalAmount;
      summary.total += v.totalAmount;
    });

    return res.json({ date, vouchers: vouchersWithJournalLines, summary });
  } catch (err) {
    console.error('Day book error:', err);
    return res.status(500).json({ message: err.message || 'Failed to generate day book' });
  }
});

// ─── GET /api/accounting/reports/payables ────────────────────────────────────
// Party Payable Analysis format:
//   O. Payable | Purchases | Cash Paid | Cheque Issued | Payable (closing)
//
// Backward compat: asOfDate still accepted (treated as dateTo with epoch start).

router.get('/payables', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const { dateFrom, dateTo, asOfDate } = req.query;

    let dateStart, dateEnd, fromParam, toParam;

    if (dateFrom && dateTo) {
      dateStart = new Date(dateFrom); dateStart.setHours(0, 0, 0, 0);
      dateEnd   = new Date(dateTo);   dateEnd.setHours(23, 59, 59, 999);
      fromParam = dateFrom;
      toParam   = dateTo;
    } else if (asOfDate) {
      // Legacy single-date mode
      dateStart = new Date('2000-01-01'); dateStart.setHours(0, 0, 0, 0);
      dateEnd   = new Date(asOfDate);    dateEnd.setHours(23, 59, 59, 999);
      fromParam = '2000-01-01';
      toParam   = asOfDate;
    } else {
      return res.status(400).json({ message: 'dateFrom and dateTo are required' });
    }

    const suppliers = await Party.find({ tenantId, type: 'supplier', isActive: true })
      .sort({ name: 1 })
      .lean();

    const EMPTY_TOTALS = { openingPayable: 0, purchases: 0, cashPaid: 0, chequeIssued: 0, payable: 0 };
    if (!suppliers.length) {
      return res.json({ dateFrom: fromParam, dateTo: toParam, suppliers: [], totals: EMPTY_TOTALS, totalPayable: 0 });
    }

    const tenantOid    = new mongoose.Types.ObjectId(tenantId);
    const supplierOids = suppliers.map((s) => new mongoose.Types.ObjectId(s._id));

    // Parallel aggregations — opening (before period) + period breakdown
    const [openingRows, periodRows] = await Promise.all([
      JournalEntry.aggregate([
        {
          $match: {
            tenantId: tenantOid,
            partyId:  { $in: supplierOids },
            date:     { $lt: dateStart },
          },
        },
        {
          $group: {
            _id: '$partyId',
            dr:  { $sum: '$debit' },
            cr:  { $sum: '$credit' },
          },
        },
      ]),
      JournalEntry.aggregate([
        {
          $match: {
            tenantId: tenantOid,
            partyId:  { $in: supplierOids },
            date:     { $gte: dateStart, $lte: dateEnd },
          },
        },
        {
          $group: {
            _id: '$partyId',
            // Purchases = credit entries from non-payment vouchers (GRN / JV)
            purchases: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gt: ['$credit', 0] },
                      {
                        $not: {
                          $in: [
                            '$voucherType',
                            ['cash_payment', 'bank_payment', 'card_transfer',
                             'cash_receipt', 'bank_receipt'],
                          ],
                        },
                      },
                    ],
                  },
                  '$credit',
                  0,
                ],
              },
            },
            // Cash Paid = debit entries on cash_payment vouchers
            cashPaid: {
              $sum: { $cond: [{ $eq: ['$voucherType', 'cash_payment'] }, '$debit', 0] },
            },
            // Cheque Issued = debit entries on bank_payment vouchers
            chequeIssued: {
              $sum: { $cond: [{ $eq: ['$voucherType', 'bank_payment'] }, '$debit', 0] },
            },
          },
        },
      ]),
    ]);

    const openMap   = Object.fromEntries(openingRows.map((r) => [String(r._id), r]));
    const periodMap = Object.fromEntries(periodRows.map((r) => [String(r._id), r]));

    const totals = { ...EMPTY_TOTALS };
    let seq = 0;

    const result = suppliers
      .map((s) => {
        const sid    = String(s._id);
        const open   = openMap[sid]   || { dr: 0, cr: 0 };
        const period = periodMap[sid] || { purchases: 0, cashPaid: 0, chequeIssued: 0 };

        // Supplier is credit-normal; openingPayable = opening credit surplus + stored opening balance
        const openingPayable  = (s.openingBalance || 0) + ((open.cr || 0) - (open.dr || 0));
        const purchases       = period.purchases    || 0;
        const cashPaid        = period.cashPaid     || 0;
        const chequeIssued    = period.chequeIssued || 0;
        const payable         = openingPayable + purchases - cashPaid - chequeIssued;

        totals.openingPayable += openingPayable;
        totals.purchases      += purchases;
        totals.cashPaid       += cashPaid;
        totals.chequeIssued   += chequeIssued;
        totals.payable        += payable;

        return {
          _id:           s._id,
          code:          ++seq,
          name:          s.name,
          phone:         s.phone  || '',
          city:          s.city   || '',
          openingPayable,
          purchases,
          cashPaid,
          chequeIssued,
          payable,
        };
      })
      .filter((s) =>
        s.openingPayable !== 0 || s.purchases !== 0 ||
        s.cashPaid !== 0 || s.chequeIssued !== 0 || s.payable !== 0,
      );

    return res.json({
      dateFrom:     fromParam,
      dateTo:       toParam,
      suppliers:    result,
      totals,
      totalPayable: totals.payable,       // keep legacy field
    });
  } catch (err) {
    console.error('Payables report error:', err);
    return res.status(500).json({ message: err.message || 'Failed to generate payables report' });
  }
});

// ─── GET /api/accounting/reports/cash-statement ──────────────────────────────

router.get('/cash-statement', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const { accountId, dateFrom, dateTo } = req.query;
    if (!accountId) return res.status(400).json({ message: 'accountId is required' });
    if (!dateFrom || !dateTo) return res.status(400).json({ message: 'dateFrom and dateTo are required' });

    const dateStart = new Date(dateFrom); dateStart.setHours(0, 0, 0, 0);
    const dateEnd   = new Date(dateTo);   dateEnd.setHours(23, 59, 59, 999);

    // Opening balance — strictly before dateFrom
    const openingAgg = await JournalEntry.aggregate([
      {
        $match: {
          tenantId:  new mongoose.Types.ObjectId(tenantId),
          accountId: new mongoose.Types.ObjectId(accountId),
          date:      { $lt: dateStart },
        },
      },
      {
        $group: {
          _id: null,
          dr:  { $sum: '$debit' },
          cr:  { $sum: '$credit' },
        },
      },
    ]);

    const openingBalance = (openingAgg[0]?.dr || 0) - (openingAgg[0]?.cr || 0);

    // Period entries
    const entries = await JournalEntry.find({
      tenantId,
      accountId: new mongoose.Types.ObjectId(accountId),
      date: { $gte: dateStart, $lte: dateEnd },
    })
      .sort({ date: 1, createdAt: 1 })
      .lean();

    let receipts = entries.filter((e) => (e.debit || 0) > 0);
    let payments = entries.filter((e) => (e.credit || 0) > 0);

    // Guard against malformed historical data where the same voucher appears
    // on both sides for the same cash account. Keep each voucher in only one
    // section (receipt if debit >= credit, otherwise payment).
    const receiptTotalsByVoucher = receipts.reduce((acc, e) => {
      const key = e.voucherNumber || String(e.voucherId || '');
      acc[key] = (acc[key] || 0) + (e.debit || 0);
      return acc;
    }, {});
    const paymentTotalsByVoucher = payments.reduce((acc, e) => {
      const key = e.voucherNumber || String(e.voucherId || '');
      acc[key] = (acc[key] || 0) + (e.credit || 0);
      return acc;
    }, {});

    const overlapKeys = Object.keys(receiptTotalsByVoucher).filter(
      (k) => paymentTotalsByVoucher[k] !== undefined
    );
    if (overlapKeys.length) {
      const keepAsReceipt = new Set(
        overlapKeys.filter(
          (k) => (receiptTotalsByVoucher[k] || 0) >= (paymentTotalsByVoucher[k] || 0)
        )
      );
      receipts = receipts.filter((e) => {
        const key = e.voucherNumber || String(e.voucherId || '');
        return !overlapKeys.includes(key) || keepAsReceipt.has(key);
      });
      payments = payments.filter((e) => {
        const key = e.voucherNumber || String(e.voucherId || '');
        return !overlapKeys.includes(key) || !keepAsReceipt.has(key);
      });
    }

    const totalReceipts = receipts.reduce((s, e) => s + e.debit,  0);
    const totalPayments = payments.reduce((s, e) => s + e.credit, 0);
    const closingBalance = openingBalance + totalReceipts - totalPayments;

    return res.json({ openingBalance, receipts, payments, totalReceipts, totalPayments, closingBalance });
  } catch (err) {
    console.error('Cash statement error:', err);
    return res.status(500).json({ message: err.message || 'Failed to generate cash statement' });
  }
});

// ─── GET /api/accounting/reports/profit-loss ─────────────────────────────────

router.get('/profit-loss', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) return res.status(400).json({ message: 'dateFrom and dateTo are required' });

    const dateStart = new Date(dateFrom); dateStart.setHours(0, 0, 0, 0);
    const dateEnd   = new Date(dateTo);   dateEnd.setHours(23, 59, 59, 999);

    // Step 1: Get all revenue, cogs, expense accounts for tenant
    const accounts = await Account.find({
      tenantId,
      type: { $in: ['revenue', 'cogs', 'expense'] },
      isActive: true,
    }).sort({ code: 1 }).lean();

    // Step 2: Aggregate journal entry balances for the period
    const balances = await JournalEntry.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          date:     { $gte: dateStart, $lte: dateEnd },
        },
      },
      {
        $group: {
          _id:         '$accountId',
          totalDebit:  { $sum: '$debit' },
          totalCredit: { $sum: '$credit' },
        },
      },
    ]);

    const balanceMap = Object.fromEntries(balances.map((b) => [b._id.toString(), b]));

    // Step 3: Per-account net amounts
    const enriched = accounts.map((a) => {
      const b = balanceMap[a._id.toString()] || { totalDebit: 0, totalCredit: 0 };
      let net;
      if (a.type === 'revenue') {
        net = (b.totalCredit || 0) - (b.totalDebit || 0);
      } else {
        net = (b.totalDebit || 0) - (b.totalCredit || 0);
      }
      return { ...a, net };
    });

    const revenue  = enriched.filter((a) => a.type === 'revenue');
    const cogs     = enriched.filter((a) => a.type === 'cogs');
    const expenses = enriched.filter((a) => a.type === 'expense');

    // Step 4: Totals
    const grossRevenue     = revenue.reduce((s, a)  => s + a.net, 0);
    const totalCOGSRaw     = cogs.reduce((s, a)     => s + a.net, 0);
    const totalExpensesRaw = expenses.reduce((s, a) => s + a.net, 0);

    // Ensure COGS / expenses aggregate as positive amounts; only subtract in final calc.
    const totalCOGS     = Math.abs(totalCOGSRaw);
    const totalExpenses = Math.abs(totalExpensesRaw);

    const grossProfit = grossRevenue - totalCOGS;
    const netProfit   = grossProfit - totalExpenses;

    return res.json({
      dateFrom, dateTo,
      revenue, cogs, expenses,
      grossRevenue, totalCOGS, grossProfit, totalExpenses, netProfit,
    });
  } catch (err) {
    console.error('P&L report error:', err);
    return res.status(500).json({ message: err.message || 'Failed to generate P&L' });
  }
});

// ─── GET /api/accounting/reports/balance-sheet ───────────────────────────────

router.get('/balance-sheet', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const year  = parseInt(req.query.year,  10);
    const month = parseInt(req.query.month, 10); // 1–12

    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ message: 'year and month (1-12) are required' });
    }

    // Date boundaries (month is 1-indexed; JS Date months are 0-indexed)
    const prevMonthEnd  = new Date(year, month - 1, 0, 23, 59, 59, 999); // last day of prev month
    const currMonthEnd  = new Date(year, month,     0, 23, 59, 59, 999); // last day of curr month
    const currMonthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);    // first day of curr month

    // Helper: aggregate cumulative debit/credit per account up to endDate
    async function getBalancesUpTo(endDate) {
      const rows = await JournalEntry.aggregate([
        {
          $match: {
            tenantId: new mongoose.Types.ObjectId(tenantId),
            date:     { $lte: endDate },
          },
        },
        {
          $group: {
            _id:         '$accountId',
            totalDebit:  { $sum: '$debit' },
            totalCredit: { $sum: '$credit' },
          },
        },
      ]);
      return Object.fromEntries(rows.map((r) => [r._id.toString(), r]));
    }

    // Helper: cumulative net P&L (revenue - cogs - expense) up to endDate
    async function getNetProfitUpTo(endDate) {
      const plResult = await JournalEntry.aggregate([
        {
          $match: {
            tenantId: new mongoose.Types.ObjectId(tenantId),
            date: { $lte: endDate },
          },
        },
        {
          $lookup: {
            from: 'accounts',
            localField: 'accountId',
            foreignField: '_id',
            as: 'account',
          },
        },
        { $unwind: '$account' },
        {
          $match: {
            'account.type': { $in: ['revenue', 'cogs', 'expense'] },
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: {
              $sum: {
                $cond: [
                  { $eq: ['$account.type', 'revenue'] },
                  { $subtract: ['$credit', '$debit'] },
                  0,
                ],
              },
            },
            totalCosts: {
              $sum: {
                $cond: [
                  { $in: ['$account.type', ['cogs', 'expense']] },
                  { $subtract: ['$debit', '$credit'] },
                  0,
                ],
              },
            },
          },
        },
      ]);

      const totalRevenue = plResult[0]?.totalRevenue || 0;
      const totalCosts = plResult[0]?.totalCosts || 0;
      return totalRevenue - totalCosts;
    }

    const [prevMap, currMap, prevNetProfit, currNetProfit] = await Promise.all([
      getBalancesUpTo(prevMonthEnd),
      getBalancesUpTo(currMonthEnd),
      getNetProfitUpTo(prevMonthEnd),
      getNetProfitUpTo(currMonthEnd),
    ]);

    // Get all asset / liability / capital accounts
    const accounts = await Account.find({
      tenantId,
      type: { $in: ['asset', 'liability', 'capital'] },
      isActive: true,
    }).sort({ code: 1 }).lean();

    // Net balance per account per period
    function netForAccount(account, map) {
      const b = map[account._id.toString()] || { totalDebit: 0, totalCredit: 0 };
      if (account.type === 'asset') {
        return (b.totalDebit || 0) - (b.totalCredit || 0);
      }
      // liability & capital: credit-normal
      return (b.totalCredit || 0) - (b.totalDebit || 0);
    }

    function enrichAccount(a) {
      const prev  = netForAccount(a, prevMap);
      const curr  = netForAccount(a, currMap);
      const month = curr - prev;
      return { ...a, prev, curr, month };
    }

    const enriched = accounts.map(enrichAccount);

    // Flow cumulative P&L into Retained Earnings (code 103) for both periods.
    const retainedIdx = enriched.findIndex((a) => String(a.code) === '103');
    if (retainedIdx !== -1) {
      enriched[retainedIdx].prev += prevNetProfit;
      enriched[retainedIdx].curr += currNetProfit;
      enriched[retainedIdx].month = enriched[retainedIdx].curr - enriched[retainedIdx].prev;
    }

    const assets      = enriched.filter((a) => a.type === 'asset');
    const capital     = enriched.filter((a) => a.type === 'capital');
    const liabilities = enriched.filter((a) => a.type === 'liability');

    // Current assets: code < '307' (fixed assets start at 307)
    const currentAssets    = assets.filter((a) => a.code < '307');
    const nonCurrentAssets = assets.filter((a) => a.code >= '307');

    function totals(list) {
      return {
        prev:  list.reduce((s, a) => s + a.prev,  0),
        curr:  list.reduce((s, a) => s + a.curr,  0),
        month: list.reduce((s, a) => s + a.month, 0),
      };
    }

    const assetTotals     = totals(assets);
    const capitalTotals   = totals(capital);
    const liabTotals      = totals(liabilities);

    const capitalPlusLiab = capitalTotals.curr + liabTotals.curr;
    const difference      = assetTotals.curr - capitalPlusLiab;

    return res.json({
      period: {
        from: currMonthStart.toISOString().split('T')[0],
        to:   currMonthEnd.toISOString().split('T')[0],
      },
      assets: {
        current:    currentAssets,
        nonCurrent: nonCurrentAssets,
        totals:     assetTotals,
      },
      capital:   { accounts: capital,     totals: capitalTotals },
      liabilities: { current: liabilities, totals: liabTotals },
      balanceCheck: {
        isBalanced: Math.abs(difference) < 0.01,
        difference,
      },
    });
  } catch (err) {
    console.error('Balance sheet error:', err);
    return res.status(500).json({ message: err.message || 'Failed to generate balance sheet' });
  }
});

// ─── GET /api/accounting/reports/receivables ─────────────────────────────────
// Party Receivable Analysis (mirror of Payables but for customers):
//   O. Rec | Activity | Cash Rec | Bank Rec | Receivable (closing)
//
// Customers are debit-normal:
//   openingRec = party.openingBalance + (openingDr - openingCr)
//   activity   = debit entries from non-receipt vouchers (sales / JV)
//   cashRec    = credit entries from cash_receipt vouchers
//   bankRec    = credit entries from bank_receipt vouchers
//   receivable = openingRec + activity - cashRec - bankRec

router.get('/receivables', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ message: 'dateFrom and dateTo are required' });
    }

    const dateStart = new Date(dateFrom); dateStart.setHours(0, 0, 0, 0);
    const dateEnd   = new Date(dateTo);   dateEnd.setHours(23, 59, 59, 999);

    const customers = await Party.find({ tenantId, type: 'customer', isActive: true })
      .sort({ name: 1 })
      .lean();

    const EMPTY_TOTALS = { openingRec: 0, activity: 0, cashRec: 0, bankRec: 0, receivable: 0 };
    if (!customers.length) {
      return res.json({ dateFrom, dateTo, customers: [], totals: EMPTY_TOTALS });
    }

    const tenantOid    = new mongoose.Types.ObjectId(tenantId);
    const customerOids = customers.map((c) => new mongoose.Types.ObjectId(c._id));

    const [openingRows, periodRows] = await Promise.all([
      // Opening: all entries before dateFrom
      JournalEntry.aggregate([
        {
          $match: {
            tenantId: tenantOid,
            partyId:  { $in: customerOids },
            date:     { $lt: dateStart },
          },
        },
        {
          $group: {
            _id: '$partyId',
            dr:  { $sum: '$debit' },
            cr:  { $sum: '$credit' },
          },
        },
      ]),
      // Period: entries in date range, split by voucher type
      JournalEntry.aggregate([
        {
          $match: {
            tenantId: tenantOid,
            partyId:  { $in: customerOids },
            date:     { $gte: dateStart, $lte: dateEnd },
          },
        },
        {
          $group: {
            _id: '$partyId',
            // Activity = new receivables (debit entries from non-receipt vouchers: sales / JV)
            activity: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gt: ['$debit', 0] },
                      {
                        $not: {
                          $in: [
                            '$voucherType',
                            ['cash_receipt', 'bank_receipt', 'card_transfer',
                             'cash_payment', 'bank_payment'],
                          ],
                        },
                      },
                    ],
                  },
                  '$debit',
                  0,
                ],
              },
            },
            // Cash Rec = credit entries on cash_receipt vouchers
            cashRec: {
              $sum: { $cond: [{ $eq: ['$voucherType', 'cash_receipt'] }, '$credit', 0] },
            },
            // Bank Rec = credit entries on bank_receipt vouchers
            bankRec: {
              $sum: { $cond: [{ $eq: ['$voucherType', 'bank_receipt'] }, '$credit', 0] },
            },
          },
        },
      ]),
    ]);

    const openMap   = Object.fromEntries(openingRows.map((r) => [String(r._id), r]));
    const periodMap = Object.fromEntries(periodRows.map((r) => [String(r._id), r]));

    const totals = { ...EMPTY_TOTALS };
    let seq = 0;

    const result = customers
      .map((c) => {
        const cid    = String(c._id);
        const open   = openMap[cid]   || { dr: 0, cr: 0 };
        const period = periodMap[cid] || { activity: 0, cashRec: 0, bankRec: 0 };

        // Customer is debit-normal; openingRec = opening debit surplus + stored opening balance
        const openingRec = (c.openingBalance || 0) + ((open.dr || 0) - (open.cr || 0));
        const activity   = period.activity || 0;
        const cashRec    = period.cashRec  || 0;
        const bankRec    = period.bankRec  || 0;
        const receivable = openingRec + activity - cashRec - bankRec;

        totals.openingRec += openingRec;
        totals.activity   += activity;
        totals.cashRec    += cashRec;
        totals.bankRec    += bankRec;
        totals.receivable += receivable;

        return {
          _id:        c._id,
          code:       ++seq,
          name:       c.name,
          phone:      c.phone || '',
          city:       c.city  || '',
          openingRec,
          activity,
          cashRec,
          bankRec,
          receivable,
        };
      })
      .filter((c) =>
        c.openingRec !== 0 || c.activity !== 0 ||
        c.cashRec !== 0    || c.bankRec !== 0  || c.receivable !== 0,
      );

    return res.json({ dateFrom, dateTo, customers: result, totals });
  } catch (err) {
    console.error('Receivables report error:', err);
    return res.status(500).json({ message: err.message || 'Failed to generate receivables report' });
  }
});

// ─── GET /api/accounting/reports/trial-balance ───────────────────────────────

router.get('/trial-balance', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ message: 'dateFrom and dateTo are required' });
    }

    const dateStart = new Date(dateFrom); dateStart.setHours(0, 0, 0, 0);
    const dateEnd   = new Date(dateTo);   dateEnd.setHours(23, 59, 59, 999);

    // Net Dr/Cr into one-side presentation (standard trial balance rule)
    function netSide(dr, cr) {
      const net = (dr || 0) - (cr || 0);
      return net >= 0 ? { dr: net, cr: 0 } : { dr: 0, cr: -net };
    }

    const tenantOid = new mongoose.Types.ObjectId(tenantId);

    // Run both aggregations in parallel
    const [openingRows, periodRows] = await Promise.all([
      JournalEntry.aggregate([
        { $match: { tenantId: tenantOid, date: { $lt: dateStart } } },
        {
          $group: {
            _id: {
              accountId: '$accountId',
              partyId:   { $ifNull: ['$partyId', null] },
            },
            dr:          { $sum: '$debit' },
            cr:          { $sum: '$credit' },
            accountName: { $first: '$accountName' },
            accountCode: { $first: '$accountCode' },
            partyName:   { $first: '$partyName' },
          },
        },
      ]),
      JournalEntry.aggregate([
        { $match: { tenantId: tenantOid, date: { $gte: dateStart, $lte: dateEnd } } },
        {
          $group: {
            _id: {
              accountId: '$accountId',
              partyId:   { $ifNull: ['$partyId', null] },
            },
            dr:          { $sum: '$debit' },
            cr:          { $sum: '$credit' },
            accountName: { $first: '$accountName' },
            accountCode: { $first: '$accountCode' },
            partyName:   { $first: '$partyName' },
          },
        },
      ]),
    ]);

    // Merge opening + period into a single map keyed by accountId::partyId
    const rowMap = new Map();
    const key = (accountId, partyId) => `${accountId}::${partyId ?? 'null'}`;

    for (const r of openingRows) {
      const k = key(r._id.accountId, r._id.partyId);
      rowMap.set(k, {
        accountId:   r._id.accountId,
        partyId:     r._id.partyId,
        accountName: r.accountName,
        accountCode: r.accountCode,
        partyName:   r.partyName,
        openDr:  r.dr,
        openCr:  r.cr,
        periodDr: 0,
        periodCr: 0,
      });
    }

    for (const r of periodRows) {
      const k = key(r._id.accountId, r._id.partyId);
      if (rowMap.has(k)) {
        rowMap.get(k).periodDr = r.dr;
        rowMap.get(k).periodCr = r.cr;
      } else {
        rowMap.set(k, {
          accountId:   r._id.accountId,
          partyId:     r._id.partyId,
          accountName: r.accountName,
          accountCode: r.accountCode,
          partyName:   r.partyName,
          openDr:  0,
          openCr:  0,
          periodDr: r.dr,
          periodCr: r.cr,
        });
      }
    }

    // Fetch full account list (for ordering + type grouping)
    const accounts = await Account.find({ tenantId, isActive: true }).sort({ code: 1 }).lean();
    const accountMap = Object.fromEntries(accounts.map((a) => [String(a._id), a]));

    // Build per-account aggregates (sum all party rows back into the account)
    const accAgg = new Map(); // accountId → { rawOpenDr, rawOpenCr, rawPeriodDr, rawPeriodCr, parties[] }

    for (const [, row] of rowMap) {
      const accId = String(row.accountId);
      if (!accountMap[accId]) continue; // orphan entry — skip

      if (!accAgg.has(accId)) {
        accAgg.set(accId, { rawOpenDr: 0, rawOpenCr: 0, rawPeriodDr: 0, rawPeriodCr: 0, parties: [] });
      }

      const agg = accAgg.get(accId);
      agg.rawOpenDr   += row.openDr;
      agg.rawOpenCr   += row.openCr;
      agg.rawPeriodDr += row.periodDr;
      agg.rawPeriodCr += row.periodCr;

      if (row.partyId) {
        const os = netSide(row.openDr, row.openCr);
        const ps = netSide(row.periodDr, row.periodCr);
        const cs = netSide(row.openDr + row.periodDr, row.openCr + row.periodCr);
        agg.parties.push({
          partyId:   String(row.partyId),
          partyName: row.partyName || '—',
          openingDr: os.dr, openingCr: os.cr,
          periodDr:  ps.dr, periodCr:  ps.cr,
          closingDr: cs.dr, closingCr: cs.cr,
        });
      }
    }

    const TYPE_ORDER  = ['capital', 'liability', 'asset', 'revenue', 'cogs', 'expense'];
    const TYPE_LABELS = {
      capital:   'Capital',
      liability: 'Liabilities',
      asset:     'Assets',
      revenue:   'Revenue',
      cogs:      'Cost of Goods Sold',
      expense:   'Expenses',
    };

    const ZERO6 = { openingDr: 0, openingCr: 0, periodDr: 0, periodCr: 0, closingDr: 0, closingCr: 0 };
    const addTo = (target, src) => {
      target.openingDr += src.openingDr;
      target.openingCr += src.openingCr;
      target.periodDr  += src.periodDr;
      target.periodCr  += src.periodCr;
      target.closingDr += src.closingDr;
      target.closingCr += src.closingCr;
    };

    const grandTotal = { ...ZERO6 };

    const groups = TYPE_ORDER
      .map((type) => {
        const typeAccs = accounts.filter((a) => a.type === type);
        const subtotal = { ...ZERO6 };

        const accountRows = typeAccs
          .map((a) => {
            const agg = accAgg.get(String(a._id));
            const rawODr  = agg?.rawOpenDr   || 0;
            const rawOCr  = agg?.rawOpenCr   || 0;
            const rawPDr  = agg?.rawPeriodDr || 0;
            const rawPCr  = agg?.rawPeriodCr || 0;

            const os = netSide(rawODr, rawOCr);
            const ps = netSide(rawPDr, rawPCr);
            const cs = netSide(rawODr + rawPDr, rawOCr + rawPCr);

            return {
              accountId:   String(a._id),
              accountCode: a.code,
              accountName: a.name,
              openingDr: os.dr, openingCr: os.cr,
              periodDr:  ps.dr, periodCr:  ps.cr,
              closingDr: cs.dr, closingCr: cs.cr,
              parties: agg?.parties || [],
            };
          })
          .filter((a) =>
            a.openingDr || a.openingCr || a.periodDr || a.periodCr || a.closingDr || a.closingCr,
          );

        accountRows.forEach((a) => addTo(subtotal, a));
        addTo(grandTotal, subtotal);

        return { type, label: TYPE_LABELS[type], accounts: accountRows, subtotal };
      })
      .filter((g) => g.accounts.length > 0);

    return res.json({ dateFrom, dateTo, groups, grandTotal });
  } catch (err) {
    console.error('Trial balance error:', err);
    return res.status(500).json({ message: err.message || 'Failed to generate trial balance' });
  }
});

module.exports = router;
