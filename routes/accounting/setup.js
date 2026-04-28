const express = require('express');
const { Account, VoucherSequence } = require('../../models/accounting');
const { protect, requireRole } = require('../../middleware/authMiddleware');
const Restaurant = require('../../models/Restaurant');
const { syncSalesForDate } = require('../../services/accounting/autoPost');

const router = express.Router();

const VOUCHER_TYPES = [
  'cash_payment',
  'cash_receipt',
  'bank_payment',
  'bank_receipt',
  'journal',
  'card_transfer',
];

// ─── Chart of Accounts definition ────────────────────────────────────────────
// Rules:
//   • 3-digit codes   = GROUP accounts (parent = null)
//   • 5-digit codes   = LEAF accounts  (parentCode = their 3-digit group)
// parentCode is stripped before DB insert; parentId is resolved after insertMany.

const COA = [
  // ── CAPITAL ────────────────────────────────────────────────────────────────
  { code: '101', name: 'Partners Capital',   type: 'capital',   isSystem: true },
  { code: '102', name: 'Drawings',           type: 'capital',   isSystem: true },
  { code: '103', name: 'Retained Earnings',  type: 'capital',   isSystem: true },
  { code: '10101', name: 'Owner Capital',    type: 'capital',   isSystem: true, parentCode: '101' },
  { code: '10201', name: 'Owner Drawings',   type: 'capital',   isSystem: true, parentCode: '102' },

  // ── LIABILITIES ────────────────────────────────────────────────────────────
  { code: '201', name: 'Suppliers',          type: 'liability', isSystem: true },
  { code: '202', name: 'Other Payable',      type: 'liability', isSystem: true },
  { code: '203', name: 'Tax Payable',        type: 'liability', isSystem: true },
  { code: '20101', name: 'Suppliers Payable',  type: 'liability', isSystem: true, parentCode: '201' },
  { code: '20201', name: 'Due to Director',    type: 'liability', isSystem: true, parentCode: '202' },
  { code: '20202', name: 'Accrued Liabilities',type: 'liability', isSystem: true, parentCode: '202' },

  // ── ASSETS ─────────────────────────────────────────────────────────────────
  { code: '301', name: 'Cash In Hand',            type: 'asset', isSystem: true },
  { code: '302', name: 'Bank Balances',          type: 'asset', isSystem: true },
  { code: '303', name: 'Digital Accounts',       type: 'asset', isSystem: true },
  { code: '304', name: 'Accounts Receivable',    type: 'asset', isSystem: true },
  { code: '305', name: 'Inventory',              type: 'asset', isSystem: true },
  { code: '306', name: 'Advances and Deposits',  type: 'asset', isSystem: true },
  { code: '307', name: 'Fixed Assets',           type: 'asset', isSystem: true },
  { code: '308', name: 'Accumulated Depreciation', type: 'asset', isSystem: true },
  { code: '30101', name: 'Cash in Hand',        type: 'asset', isSystem: true, parentCode: '301' },
  { code: '30102', name: 'Petty Cash',          type: 'asset', isSystem: true, parentCode: '301' },
  { code: '30201', name: 'Main Bank Account',   type: 'asset', isSystem: true, parentCode: '302' },
  { code: '30301', name: 'Easypaisa',           type: 'asset', isSystem: true, parentCode: '303' },
  { code: '30302', name: 'JazzCash',            type: 'asset', isSystem: true, parentCode: '303' },
  { code: '30501', name: 'Raw Materials',       type: 'asset', isSystem: true, parentCode: '305' },
  { code: '30502', name: 'Packing Materials',   type: 'asset', isSystem: true, parentCode: '305' },
  { code: '30503', name: 'Finished Goods',      type: 'asset', isSystem: true, parentCode: '305' },
  { code: '30701', name: 'Furniture and Fixtures', type: 'asset', isSystem: true, parentCode: '307' },
  { code: '30702', name: 'Kitchen Equipment',   type: 'asset', isSystem: true, parentCode: '307' },
  { code: '30703', name: 'IT Equipment',        type: 'asset', isSystem: true, parentCode: '307' },

  // ── REVENUE ────────────────────────────────────────────────────────────────
  { code: '401', name: 'Sales',            type: 'revenue', isSystem: true },
  { code: '402', name: 'Other Revenue',    type: 'revenue', isSystem: true },
  { code: '40101', name: 'Dine-in Sales',  type: 'revenue', isSystem: true, parentCode: '401' },
  { code: '40102', name: 'Takeaway Sales', type: 'revenue', isSystem: true, parentCode: '401' },
  { code: '40103', name: 'Delivery Sales', type: 'revenue', isSystem: true, parentCode: '401' },
  { code: '40104', name: 'Online Sales',   type: 'revenue', isSystem: true, parentCode: '401' },
  { code: '40201', name: 'Catering Sales', type: 'revenue', isSystem: true, parentCode: '402' },

  // ── COGS ───────────────────────────────────────────────────────────────────
  { code: '501', name: 'Cost of Goods',     type: 'cogs', isSystem: true },
  { code: '502', name: 'Other COGS',        type: 'cogs', isSystem: true },
  { code: '50101', name: 'Food Cost',       type: 'cogs', isSystem: true, parentCode: '501' },
  { code: '50201', name: 'Packaging Cost',  type: 'cogs', isSystem: true, parentCode: '502' },

  // ── EXPENSES ───────────────────────────────────────────────────────────────
  { code: '601', name: 'Operating Expenses',         type: 'expense', isSystem: true },
  { code: '602', name: 'Other Expenses',             type: 'expense', isSystem: true },
  { code: '60101', name: 'Salaries',                 type: 'expense', isSystem: true, parentCode: '601' },
  { code: '60102', name: 'Rent',                     type: 'expense', isSystem: true, parentCode: '601' },
  { code: '60103', name: 'Utilities',                type: 'expense', isSystem: true, parentCode: '601' },
  { code: '60104', name: 'Rider Payouts',            type: 'expense', isSystem: true, parentCode: '601' },
  { code: '60105', name: 'Discounts Given',          type: 'expense', isSystem: true, parentCode: '601' },
  { code: '60201', name: 'Easypaisa / JazzCash Fees', type: 'expense', isSystem: true, parentCode: '602' },
  { code: '60202', name: 'Foodpanda Commission',     type: 'expense', isSystem: true, parentCode: '602' },
  { code: '60203', name: 'Marketing and Advertising',type: 'expense', isSystem: true, parentCode: '602' },
  { code: '60204', name: 'Maintenance and Repairs',  type: 'expense', isSystem: true, parentCode: '602' },
  { code: '60205', name: 'Mobile and Internet',      type: 'expense', isSystem: true, parentCode: '602' },
  { code: '60206', name: 'Printing and Stationery',  type: 'expense', isSystem: true, parentCode: '602' },
  { code: '60207', name: 'Depreciation Expense',     type: 'expense', isSystem: true, parentCode: '602' },
  { code: '60208', name: 'Miscellaneous Expense',    type: 'expense', isSystem: true, parentCode: '602' },
];

// Resolve tenant restaurant from the request (mirrors the admin routes pattern)
async function resolveTenant(req, res) {
  const tenantSlug = req.headers['x-tenant-slug'];

  if (req.user.role === 'super_admin') {
    if (!tenantSlug) {
      res.status(400).json({ message: 'Super admin must send x-tenant-slug' });
      return null;
    }
    const restaurant = await Restaurant.findOne({ 'website.subdomain': tenantSlug });
    if (!restaurant) {
      res.status(404).json({ message: 'Restaurant not found' });
      return null;
    }
    return restaurant;
  }

  if (!req.user.restaurant) {
    res.status(400).json({ message: 'User is not linked to any restaurant' });
    return null;
  }
  const restaurant = await Restaurant.findById(req.user.restaurant);
  if (!restaurant) {
    res.status(404).json({ message: 'Restaurant not found' });
    return null;
  }
  return restaurant;
}

// POST /api/accounting/setup
router.post(
  '/',
  protect,
  requireRole('restaurant_admin', 'super_admin', 'admin', 'manager'),
  async (req, res) => {
    try {
      const restaurant = await resolveTenant(req, res);
      if (!restaurant) return;

      const tenantId = restaurant._id;

      const existing = await Account.countDocuments({ tenantId });
      if (existing > 0) {
        return res.status(400).json({ error: 'Already set up' });
      }

      // Insert all accounts (parents before children), without parentCode field
      const docsToInsert = COA.map(({ parentCode, ...rest }) => ({
        ...rest,
        tenantId,
      }));

      const inserted = await Account.insertMany(docsToInsert);

      // Build code → _id map for resolving parentCodes
      const codeToId = {};
      inserted.forEach((acc) => {
        codeToId[acc.code] = acc._id;
      });

      // Resolve parentCode references
      const parentUpdates = COA.filter((a) => a.parentCode).map((a) => ({
        code: a.code,
        parentCode: a.parentCode,
      }));

      await Promise.all(
        parentUpdates.map(({ code, parentCode }) => {
          const parentId = codeToId[parentCode];
          if (!parentId) return Promise.resolve();
          return Account.updateOne({ tenantId, code }, { $set: { parentId } });
        })
      );

      // Initialise VoucherSequence docs for all types
      await VoucherSequence.insertMany(
        VOUCHER_TYPES.map((type) => ({ tenantId, type, lastNumber: 0 }))
      );

      return res.json({ success: true, accountsCreated: inserted.length });
    } catch (err) {
      console.error('Accounting setup error:', err);
      // Rollback: delete any accounts and sequences inserted for this tenant
      try {
        const restaurant = req.user.restaurant
          ? await Restaurant.findById(req.user.restaurant)
          : null;
        if (restaurant) {
          await Account.deleteMany({ tenantId: restaurant._id });
          await VoucherSequence.deleteMany({ tenantId: restaurant._id });
        }
      } catch (_) {
        // ignore rollback error
      }
      return res.status(500).json({ message: 'Setup failed', error: err.message });
    }
  }
);

// POST /api/accounting/migrate-account-names
// One-time idempotent migration: corrects stale parent account names in the tenant's COA.
// Safe to call multiple times — uses $ne guards so no-op when already correct.
router.post(
  '/migrate-account-names',
  protect,
  requireRole('restaurant_admin', 'super_admin', 'admin', 'manager'),
  async (req, res) => {
    try {
      const restaurant = await resolveTenant(req, res);
      if (!restaurant) return;
      const tenantId = restaurant._id;

      // Each entry: oldNames (array of stale names to match) → correctName
      const RENAMES = [
        { oldNames: ['Cash Accounts'],                             correctName: 'Cash In Hand'     },
        { oldNames: ['Accounts Payable', 'Accounts Payable Group'], correctName: 'Suppliers'       },
        { oldNames: ['Bank Accounts'],                             correctName: 'Bank Balances'    },
        { oldNames: ['Digital Wallets'],                           correctName: 'Digital Accounts' },
      ];

      let totalRenamed = 0;
      const details = [];

      for (const { oldNames, correctName } of RENAMES) {
        const result = await Account.updateMany(
          { tenantId, name: { $in: oldNames } },
          { $set: { name: correctName } },
        );
        if (result.modifiedCount > 0) {
          totalRenamed += result.modifiedCount;
          details.push({ correctName, count: result.modifiedCount });
        }
      }

      return res.json({ success: true, totalRenamed, details });
    } catch (err) {
      console.error('migrate-account-names error:', err);
      return res.status(500).json({ message: err.message || 'Migration failed' });
    }
  }
);

// POST /api/accounting/sync-sales
// Body: { date } — YYYY-MM-DD
router.post(
  '/sync-sales',
  protect,
  requireRole('restaurant_admin', 'super_admin', 'admin', 'manager'),
  async (req, res) => {
    try {
      const restaurant = await resolveTenant(req, res);
      if (!restaurant) return;

      const { date } = req.body;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ message: 'date (YYYY-MM-DD) is required' });
      }

      const results = await syncSalesForDate(restaurant._id, date);
      return res.json(results);
    } catch (err) {
      console.error('Sync sales error:', err);
      return res.status(500).json({ message: err.message || 'Sync failed' });
    }
  }
);

module.exports = router;
