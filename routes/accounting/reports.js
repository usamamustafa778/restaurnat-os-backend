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

router.get('/payables', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const asOfDate = req.query.asOfDate || new Date().toISOString().split('T')[0];
    const asOf = new Date(asOfDate); asOf.setHours(23, 59, 59, 999);

    const suppliers = await Party.find({ tenantId, type: 'supplier', isActive: true }).lean();
    if (!suppliers.length) return res.json({ asOfDate, suppliers: [], totalPayable: 0 });

    const supplierIds = suppliers.map((s) => s._id);

    const ledgerBalances = await JournalEntry.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          partyId:  { $in: supplierIds.map((id) => new mongoose.Types.ObjectId(id)) },
          date:     { $lte: asOf },
        },
      },
      {
        $group: {
          _id:         '$partyId',
          totalDebit:  { $sum: '$debit' },
          totalCredit: { $sum: '$credit' },
        },
      },
    ]);

    const lastPaymentRows = await JournalEntry.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          partyId: { $in: supplierIds.map((id) => new mongoose.Types.ObjectId(id)) },
          date: { $lte: asOf },
        },
      },
      {
        $group: {
          _id: '$partyId',
          lastPaymentDate: { $max: '$date' },
        },
      },
    ]);

    const balanceMap = Object.fromEntries(
      ledgerBalances.map((b) => [b._id.toString(), b])
    );
    const lastPaymentMap = Object.fromEntries(
      lastPaymentRows.map((r) => [r._id.toString(), r.lastPaymentDate])
    );

    const result = suppliers
      .map((s) => {
        const b = balanceMap[s._id.toString()] || { totalDebit: 0, totalCredit: 0 };
        // For payables: credit > debit means we owe them
        const balance = s.openingBalance + b.totalCredit - b.totalDebit;
        const creditLimit = Number(s.creditLimit) || 0;
        return {
          ...s,
          balance,
          lastPaymentDate: lastPaymentMap[s._id.toString()] || null,
          overdue: balance > creditLimit && creditLimit > 0,
        };
      })
      .filter((s) => s.balance > 0.01)
      .sort((a, b) => b.balance - a.balance);

    const totalPayable = result.reduce((sum, r) => sum + r.balance, 0);

    return res.json({ asOfDate, suppliers: result, totalPayable });
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

    const receipts = entries.filter((e) => e.debit  > 0);
    const payments = entries.filter((e) => e.credit > 0);

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

module.exports = router;
