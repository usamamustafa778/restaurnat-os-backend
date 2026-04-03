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
