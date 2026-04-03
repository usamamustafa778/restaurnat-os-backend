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

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;
    const { type, q, city, balanceFilter, sortBy } = req.query;

    const baseFilter = { tenantId, isActive: true };
    if (type) baseFilter.type = type;
    if (city) baseFilter.city = city;

    let query;
    if (q && String(q).trim()) {
      query = Party.find({ ...baseFilter, $text: { $search: String(q).trim() } });
    } else {
      query = Party.find(baseFilter);
    }

    // Sorting
    if (sortBy === 'balance_desc' || sortBy === 'balance_asc') {
      query = query.sort({ openingBalance: sortBy === 'balance_desc' ? -1 : 1 });
    } else if (sortBy === 'recent') {
      query = query.sort({ createdAt: -1 });
    } else {
      query = query.sort({ name: 1 });
    }

    const [parties, total] = await Promise.all([
      query.skip(skip).limit(limit).lean(),
      Party.countDocuments(baseFilter),
    ]);

    // Unique cities for filter dropdown
    const cities = await Party.distinct('city', { tenantId, isActive: true, city: { $ne: null, $ne: '' } });

    return res.json({ parties, total, page, cities: cities.filter(Boolean).sort() });
  } catch (err) {
    console.error('Get parties error:', err);
    return res.status(500).json({ message: 'Failed to fetch parties' });
  }
});

// GET /api/accounting/parties/summary  — must be before /:id routes
router.get('/summary', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    const [byType, allParties] = await Promise.all([
      Party.aggregate([
        { $match: { tenantId: new mongoose.Types.ObjectId(tenantId), isActive: true } },
        { $group: { _id: '$type', count: { $sum: 1 }, totalOpeningBalance: { $sum: '$openingBalance' } } },
      ]),
      Party.find({ tenantId, isActive: true }, { openingBalance: 1, balanceType: 1, creditLimit: 1 }).lean(),
    ]);

    const supplierRow  = byType.find((r) => r._id === 'supplier')  || { count: 0, totalOpeningBalance: 0 };
    const customerRow  = byType.find((r) => r._id === 'customer')  || { count: 0, totalOpeningBalance: 0 };

    const totalPayable    = allParties.filter((p) => p.balanceType === 'credit').reduce((s, p) => s + (p.openingBalance || 0), 0);
    const totalReceivable = allParties.filter((p) => p.balanceType === 'debit').reduce((s, p) => s + (p.openingBalance || 0), 0);
    const overdueCount    = allParties.filter((p) => p.creditLimit > 0 && (p.openingBalance || 0) > p.creditLimit).length;

    return res.json({
      supplierCount:    supplierRow.count,
      customerCount:    customerRow.count,
      totalPayable:     Math.abs(totalPayable),
      totalReceivable:  Math.abs(totalReceivable),
      overdueCount,
      byType,
    });
  } catch (err) {
    console.error('Party summary error:', err);
    return res.status(500).json({ message: 'Failed to fetch summary' });
  }
});

// GET /api/accounting/parties/totals  — live balances from journal entries
router.get('/totals', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    // Fetch all active parties
    const parties = await Party.find(
      { tenantId, isActive: true },
      { openingBalance: 1, type: 1, creditLimit: 1 }
    ).lean();

    const partyIds = parties.map((p) => p._id);

    // Aggregate journal entries grouped by partyId for this tenant
    const journalTotals = await JournalEntry.aggregate([
      { $match: { tenantId: new mongoose.Types.ObjectId(tenantId), partyId: { $in: partyIds } } },
      { $group: { _id: '$partyId', totalDebit: { $sum: '$debit' }, totalCredit: { $sum: '$credit' } } },
    ]);

    const journalMap = {};
    journalTotals.forEach((j) => { journalMap[j._id.toString()] = j; });

    let totalPayable = 0, totalReceivable = 0, supplierCount = 0, customerCount = 0, overdueCount = 0;

    parties.forEach((p) => {
      if (p.type === 'supplier') supplierCount++;
      if (p.type === 'customer') customerCount++;
      const j = journalMap[p._id.toString()] || { totalDebit: 0, totalCredit: 0 };
      // balance > 0 = we owe them (payable); balance < 0 = they owe us (receivable)
      const balance = (p.openingBalance || 0) + j.totalCredit - j.totalDebit;
      if (balance > 0) totalPayable += balance;
      else if (balance < 0) totalReceivable += Math.abs(balance);
      if (p.creditLimit > 0 && balance > p.creditLimit) overdueCount++;
    });

    return res.json({ totalPayable, totalReceivable, supplierCount, customerCount, overdueCount });
  } catch (err) {
    console.error('Party totals error:', err);
    return res.status(500).json({ message: 'Failed to fetch totals' });
  }
});

// GET /api/accounting/parties/:id/balance
router.get('/:id/balance', async (req, res) => {
  try {
    const restaurant = await resolveTenant(req, res);
    if (!restaurant) return;
    const tenantId = restaurant._id;

    let partyObjId;
    try {
      partyObjId = new mongoose.Types.ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ message: 'Invalid party ID' });
    }

    const party = await Party.findOne({ _id: partyObjId, tenantId });
    if (!party) return res.status(404).json({ message: 'Party not found' });

    // ── Debug: log all journal entries for this party ──────────────────────
    const allEntries = await JournalEntry.find({ partyId: partyObjId }).lean();
    const tenantEntries = await JournalEntry.find({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      partyId: partyObjId,
    }).lean();

    console.log(`\n[BalanceDebug] ── Party: "${party.name}" (${req.params.id}) ──`);
    console.log(`[BalanceDebug]   openingBalance = ${party.openingBalance}, balanceType = ${party.balanceType}`);
    console.log(`[BalanceDebug]   JournalEntries with partyId (any tenant): ${allEntries.length}`);
    console.log(`[BalanceDebug]   JournalEntries with partyId + this tenant: ${tenantEntries.length}`);
    tenantEntries.forEach((e, i) => {
      console.log(`[BalanceDebug]   [${i + 1}] voucher=${e.voucherNumber} | account=${e.accountName} | dr=${e.debit} | cr=${e.credit} | partyId=${e.partyId}`);
    });
    if (allEntries.length > 0 && tenantEntries.length === 0) {
      console.warn(`[BalanceDebug]   ⚠ Entries exist but tenantId filter excluded them. Stored tenantId sample: ${allEntries[0]?.tenantId}`);
    }
    if (allEntries.length === 0) {
      // Check if ANY journal entries reference this party at all (partyId stored as string?)
      const asStringCheck = await JournalEntry.find({ partyId: req.params.id }).lean();
      console.warn(`[BalanceDebug]   ⚠ No entries found by ObjectId. String-based match: ${asStringCheck.length}`);
    }
    // ──────────────────────────────────────────────────────────────────────

    const result = await JournalEntry.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(tenantId),
          partyId: partyObjId,
        },
      },
      {
        $group: {
          _id: null,
          totalDebit:  { $sum: '$debit' },
          totalCredit: { $sum: '$credit' },
        },
      },
    ]);

    const ledgerDebit  = result[0]?.totalDebit  || 0;
    const ledgerCredit = result[0]?.totalCredit || 0;
    // balance = openingBalance + totalCredit - totalDebit
    // Supplier: openingBalance > 0 means we owe them.
    // Paying them creates a DEBIT on their payable account → reduces balance.
    const balance = party.openingBalance + ledgerCredit - ledgerDebit;

    console.log(`[BalanceDebug]   ledgerDebit=${ledgerDebit}, ledgerCredit=${ledgerCredit}, finalBalance=${balance}\n`);

    return res.json({
      balance,
      // balance > 0: we still owe them (payable/credit position).
      // balance < 0: they owe us (debit position / overpaid).
      balanceType:    balance >= 0 ? 'credit' : 'debit',
      openingBalance: party.openingBalance,
      ledgerDebit,
      ledgerCredit,
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

    const { name, type, phone, email, address, city, ntn, notes, creditLimit, paymentTerms, openingBalance, balanceType } = req.body;

    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Name is required' });
    const VALID_TYPES = ['supplier', 'customer', 'employee', 'director', 'other'];
    if (!type || !VALID_TYPES.includes(type)) return res.status(400).json({ message: `Type must be one of: ${VALID_TYPES.join(', ')}` });

    const party = await Party.create({
      tenantId,
      name:           String(name).trim(),
      type,
      phone:          phone   ? String(phone).trim()              : undefined,
      email:          email   ? String(email).toLowerCase().trim(): undefined,
      address:        address ? String(address).trim()            : undefined,
      city:           city    ? String(city).trim()               : undefined,
      ntn:            ntn     ? String(ntn).trim()                : undefined,
      notes:          notes   ? String(notes).trim()              : undefined,
      creditLimit:    Number(creditLimit) || 0,
      paymentTerms:   paymentTerms || 'immediate',
      openingBalance: Number(openingBalance) || 0,
      balanceType:    balanceType || 'credit',
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

    const allowed = [
      'name', 'type', 'phone', 'email', 'address', 'city', 'ntn', 'notes',
      'creditLimit', 'paymentTerms', 'openingBalance', 'balanceType', 'accountId', 'isActive',
    ];
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
