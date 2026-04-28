const express = require('express');
const { Account, JournalEntry } = require('../../models/accounting');
const { protect, requireRole } = require('../../middleware/authMiddleware');
const Restaurant = require('../../models/Restaurant');

const router = express.Router();

const VALID_TYPES = ['asset', 'liability', 'capital', 'revenue', 'cogs', 'expense'];

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

// Apply auth to all routes in this router
router.use(
  protect,
  requireRole('restaurant_admin', 'super_admin', 'admin', 'manager', 'product_manager', 'cashier')
);

// GET /api/accounting/accounts
router.get('/', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    const tenantId = restaurant._id;
    const filter = { tenantId };

    if (req.query.type && VALID_TYPES.includes(req.query.type)) {
      filter.type = req.query.type;
    }

    if (req.query.q && String(req.query.q).trim()) {
      const escaped = String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { code: { $regex: escaped, $options: 'i' } },
      ];
    }

    const accounts = await Account.find(filter).sort({ code: 1 }).lean();

    if (accounts.length === 0) {
      return res.json({ accounts: [], isEmpty: true });
    }

    return res.json({ accounts, isEmpty: false });
  } catch (err) {
    console.error('Get accounts error:', err);
    return res.status(500).json({ message: 'Failed to fetch accounts' });
  }
});

// POST /api/accounting/accounts
router.post('/', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    const tenantId = restaurant._id;
    const { code, name, type, parentId } = req.body;

    if (!code || !String(code).trim()) {
      return res.status(400).json({ message: 'Account code is required' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'Account name is required' });
    }
    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ message: `Account type must be one of: ${VALID_TYPES.join(', ')}` });
    }

    const exists = await Account.findOne({ tenantId, code: String(code).trim() });
    if (exists) {
      return res.status(400).json({ message: `Account code "${code}" already exists` });
    }

    const account = await Account.create({
      tenantId,
      code: String(code).trim(),
      name: String(name).trim(),
      type,
      parentId: parentId || null,
      isSystem: false,
    });

    return res.status(201).json(account);
  } catch (err) {
    console.error('Create account error:', err);
    return res.status(500).json({ message: 'Failed to create account' });
  }
});

// ── Known 3-digit group accounts to auto-create if missing during migration ───
const GROUP_DEFAULTS = {
  '101': { name: 'Partners Capital',          type: 'capital'   },
  '102': { name: 'Drawings',                 type: 'capital'   },
  '103': { name: 'Retained Earnings',        type: 'capital'   },
  '201': { name: 'Suppliers',                type: 'liability' },
  '202': { name: 'Other Payable',            type: 'liability' },
  '203': { name: 'Tax Payable',              type: 'liability' },
  '301': { name: 'Cash In Hand',             type: 'asset'     },
  '302': { name: 'Bank Balances',            type: 'asset'     },
  '303': { name: 'Digital Accounts',         type: 'asset'     },
  '304': { name: 'Accounts Receivable',      type: 'asset'     },
  '305': { name: 'Inventory',               type: 'asset'     },
  '306': { name: 'Advances and Deposits',   type: 'asset'     },
  '307': { name: 'Fixed Assets',            type: 'asset'     },
  '308': { name: 'Accumulated Depreciation', type: 'asset'    },
  '401': { name: 'Sales',                   type: 'revenue'   },
  '402': { name: 'Other Revenue',           type: 'revenue'   },
  '501': { name: 'Cost of Goods',           type: 'cogs'      },
  '502': { name: 'Other COGS',              type: 'cogs'      },
  '601': { name: 'Operating Expenses',      type: 'expense'   },
  '602': { name: 'Other Expenses',          type: 'expense'   },
};

// Stale names that must be corrected in existing data (old name → correct name)
// Keyed by account code so the match is unambiguous.
const NAME_CORRECTIONS = {
  '301': 'Cash In Hand',
  '302': 'Bank Balances',
  '303': 'Digital Accounts',
  '201': 'Suppliers',
};

// POST /api/accounting/accounts/migrate-parents
// Idempotent: finds child accounts (code > 3 digits) with no parentId,
// creates any missing 3-digit group accounts, then sets parentId on orphans.
router.post('/migrate-parents', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    const tenantId = restaurant._id;
    const allAccounts = await Account.find({ tenantId }).lean();

    // Build mutable code → _id map
    const codeToId = {};
    allAccounts.forEach((a) => { codeToId[a.code] = String(a._id); });

    // Find leaf accounts (code length > 3) that still have no parentId
    const orphans = allAccounts.filter((a) => a.code.length > 3 && !a.parentId);

    if (orphans.length === 0) {
      return res.json({ success: true, fixed: 0, created: 0, message: 'Nothing to migrate' });
    }

    let created = 0;
    let fixed   = 0;
    let renamed = 0;

    // ── Step 1: correct stale parent account names ────────────────────
    for (const [code, correctName] of Object.entries(NAME_CORRECTIONS)) {
      const result = await Account.updateOne(
        { tenantId, code, name: { $ne: correctName } },
        { $set: { name: correctName } },
      );
      if (result.modifiedCount > 0) renamed++;
    }

    // ── Step 2: set parentId on orphaned child accounts ───────────────
    for (const acc of orphans) {
      // Derive the expected parent code (first 3 digits)
      const parentCode = acc.code.substring(0, 3);
      let parentId = codeToId[parentCode];

      // Create the group account if it does not exist yet
      if (!parentId) {
        const def = GROUP_DEFAULTS[parentCode];
        if (!def) continue; // unknown prefix — skip safely

        try {
          const newGroup = await Account.create({
            tenantId,
            code: parentCode,
            name: def.name,
            type: def.type,
            isSystem: true,
            parentId: null,
          });
          codeToId[parentCode] = String(newGroup._id);
          parentId = codeToId[parentCode];
          created++;
        } catch (dupErr) {
          // Race condition: another request just created it — fetch and continue
          const existing = await Account.findOne({ tenantId, code: parentCode }).lean();
          if (existing) {
            codeToId[parentCode] = String(existing._id);
            parentId = codeToId[parentCode];
          } else {
            continue;
          }
        }
      }

      await Account.updateOne({ _id: acc._id, tenantId }, { $set: { parentId } });
      fixed++;
    }

    return res.json({ success: true, fixed, created, renamed });
  } catch (err) {
    console.error('migrate-parents error:', err);
    return res.status(500).json({ message: err.message || 'Migration failed' });
  }
});

// PATCH /api/accounting/accounts/:id
router.patch('/:id', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    const tenantId = restaurant._id;
    const account = await Account.findOne({ _id: req.params.id, tenantId });
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const updates = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ message: 'Name cannot be empty' });
      updates.name = name;
    }
    if (req.body.isActive !== undefined) {
      if (req.body.isActive === false) {
        const inUse = await JournalEntry.countDocuments({ accountId: account._id });
        if (inUse > 0) {
          return res.status(400).json({
            message: 'Cannot deactivate: account has journal entries referencing it',
          });
        }
      }
      updates.isActive = Boolean(req.body.isActive);
    }

    const updated = await Account.findByIdAndUpdate(account._id, { $set: updates }, { new: true });
    return res.json(updated);
  } catch (err) {
    console.error('Update account error:', err);
    return res.status(500).json({ message: 'Failed to update account' });
  }
});

// DELETE /api/accounting/accounts/:id
router.delete('/:id', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;

    const tenantId = restaurant._id;
    const account = await Account.findOne({ _id: req.params.id, tenantId });
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    if (account.isSystem) {
      return res.status(400).json({ message: 'System accounts cannot be deleted' });
    }

    const inUse = await JournalEntry.countDocuments({ accountId: account._id });
    if (inUse > 0) {
      return res.status(400).json({
        message: `Cannot delete: account is referenced by ${inUse} journal entr${inUse === 1 ? 'y' : 'ies'}`,
      });
    }

    await Account.deleteOne({ _id: account._id });
    return res.json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err);
    return res.status(500).json({ message: 'Failed to delete account' });
  }
});

module.exports = router;
