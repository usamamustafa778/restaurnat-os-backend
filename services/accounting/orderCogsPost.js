const Account = require('../../models/accounting/Account');
const { Voucher } = require('../../models/accounting');
const { createVoucher } = require('./voucherService');

async function getAccountIdByCode(code, tenantId) {
  const account = await Account.findOne({ code, tenantId, isActive: true }).lean();
  return account?._id;
}

async function resolveInventoryCreditAccountId(tenantId) {
  let id = await getAccountIdByCode('30501', tenantId);
  if (!id) id = await getAccountIdByCode('305', tenantId);
  return id;
}

/**
 * Idempotent journal: Dr Food Cost (501), Cr Raw Materials / Inventory (30501 or 305).
 * Does not use sourceId — sales auto-post already reserves sourceId = orderId on receipt vouchers.
 */
async function postOrderCogsJournal({ tenantId, orderId, orderNumber, totalCOGS, createdBy }) {
  const prefix = `COGS auto-post|${orderId}`;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = await Voucher.findOne({
    tenantId,
    type: 'journal',
    autoPosted: true,
    notes: { $regex: new RegExp(`^${escapedPrefix}`) },
  }).lean();
  if (existing) return { skipped: true, reason: 'already_posted' };

  const cogsAccountId = await getAccountIdByCode('501', tenantId);
  const inventoryAccountId = await resolveInventoryCreditAccountId(tenantId);
  if (!cogsAccountId || !inventoryAccountId) {
    throw new Error('COGS (501) or inventory (30501/305) account not found');
  }

  await createVoucher({
    tenantId,
    type: 'journal',
    date: new Date(),
    notes: `${prefix} — Order #${orderNumber}`,
    autoPosted: true,
    sourceId: null,
    createdBy,
    lines: [
      {
        accountId: cogsAccountId,
        debit: totalCOGS,
        credit: 0,
        description: `Food cost: Order #${orderNumber}`,
      },
      {
        accountId: inventoryAccountId,
        debit: 0,
        credit: totalCOGS,
        description: `Inventory consumed: Order #${orderNumber}`,
      },
    ],
  });

  return { success: true };
}

module.exports = {
  getAccountIdByCode,
  postOrderCogsJournal,
};
