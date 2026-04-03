const express = require('express');
const mongoose = require('mongoose');
const { Party, JournalEntry } = require('../../models/accounting');
const { protect, requireRole } = require('../../middleware/authMiddleware');
const Restaurant = require('../../models/Restaurant');

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

router.use(protect, requireRole('restaurant_admin', 'super_admin', 'admin', 'manager', 'product_manager', 'cashier'));

// GET /api/accounting/parties
router.get('/', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const skip = (page - 1) * limit;
    const { type, q } = req.query;

    let query;
    if (q && String(q).trim()) {
      query = Party.find({
        tenantId,
        $text: { $search: String(q).trim() },
        isActive: true,
        ...(type && { type }),
      });
    } else {
      query = Party.find({
        tenantId,
        isActive: true,
        ...(type && { type }),
      }).sort({ name: 1 });
    }

    const [parties, total] = await Promise.all([
      query.skip(skip).limit(limit).lean(),
      Party.countDocuments({ tenantId, isActive: true, ...(type && { type }) }),
    ]);

    return res.json({ parties, total, page });
  } catch (err) {
    console.error('Get parties error:', err);
    return res.status(500).json({ message: 'Failed to fetch parties' });
  }
});

// GET /api/accounting/parties/:id/balance
router.get('/:id/balance', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const party = await Party.findOne({ _id: req.params.id, tenantId });
    if (!party) return res.status(404).json({ message: 'Party not found' });

    const result = await JournalEntry.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          partyId: new mongoose.Types.ObjectId(req.params.id),
        },
      },
      {
        $group: {
          _id: null,
          totalDebit: { $sum: '$debit' },
          totalCredit: { $sum: '$credit' },
        },
      },
    ]);

    const ledgerBalance = (result[0]?.totalCredit || 0) - (result[0]?.totalDebit || 0);
    const balance = party.openingBalance + ledgerBalance;

    return res.json({
      balance,
      balanceType: balance >= 0 ? 'credit' : 'debit',
      openingBalance: party.openingBalance,
      ledgerDebit: result[0]?.totalDebit || 0,
      ledgerCredit: result[0]?.totalCredit || 0,
    });
  } catch (err) {
    console.error('Get party balance error:', err);
    return res.status(500).json({ message: 'Failed to fetch balance' });
  }
});

// POST /api/accounting/parties
router.post('/', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const { name, type, phone, email, openingBalance, balanceType } = req.body;

    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Name is required' });
    const VALID_TYPES = ['supplier', 'customer', 'employee', 'director', 'other'];
    if (!type || !VALID_TYPES.includes(type)) return res.status(400).json({ message: `Type must be one of: ${VALID_TYPES.join(', ')}` });

    const party = await Party.create({
      tenantId,
      name: String(name).trim(),
      type,
      phone: phone || undefined,
      email: email ? String(email).toLowerCase().trim() : undefined,
      openingBalance: Number(openingBalance) || 0,
      balanceType: balanceType || 'credit',
    });

    return res.status(201).json(party);
  } catch (err) {
    console.error('Create party error:', err);
    return res.status(500).json({ message: 'Failed to create party' });
  }
});

// PATCH /api/accounting/parties/:id
router.patch('/:id', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const party = await Party.findOne({ _id: req.params.id, tenantId });
    if (!party) return res.status(404).json({ message: 'Party not found' });

    const allowed = ['name', 'type', 'phone', 'email', 'openingBalance', 'balanceType', 'accountId', 'isActive'];
    const updates = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const updated = await Party.findByIdAndUpdate(party._id, { $set: updates }, { new: true });
    return res.json(updated);
  } catch (err) {
    console.error('Update party error:', err);
    return res.status(500).json({ message: 'Failed to update party' });
  }
});

// DELETE /api/accounting/parties/:id  (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const party = await Party.findOne({ _id: req.params.id, tenantId });
    if (!party) return res.status(404).json({ message: 'Party not found' });

    const inUse = await JournalEntry.countDocuments({ partyId: party._id });
    if (inUse > 0) {
      return res.status(400).json({
        message: `Cannot delete: party has ${inUse} journal entr${inUse === 1 ? 'y' : 'ies'} referencing it`,
      });
    }

    await Party.findByIdAndUpdate(party._id, { $set: { isActive: false } });
    return res.json({ success: true });
  } catch (err) {
    console.error('Delete party error:', err);
    return res.status(500).json({ message: 'Failed to delete party' });
  }
});

module.exports = router;
