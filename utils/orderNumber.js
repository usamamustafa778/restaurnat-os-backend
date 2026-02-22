const Order = require('../models/Order');
const Branch = require('../models/Branch');

/**
 * Get 1-based branch index for a restaurant (by sortOrder, then createdAt).
 * Returns 1 when branchId is null (single-branch or no branch).
 */
async function getBranchIndex(restaurantId, branchId) {
  if (!branchId) return 1;
  const branches = await Branch.find({ restaurant: restaurantId, isDeleted: { $ne: true } })
    .sort({ sortOrder: 1, createdAt: 1 })
    .select('_id')
    .lean();
  const idx = branches.findIndex((b) => b._id.toString() === branchId.toString());
  return idx >= 0 ? idx + 1 : 1;
}

/**
 * Generate order number unique per branch: {prefix}-YYYYMMDD-{branchIndex}-{seq}.
 * e.g. ORD-20260222-1-0001, ORD-20260222-2-0001 (branch 2's first of the day).
 * @param {Object} restaurantId - Restaurant ObjectId
 * @param {Object|null} branchId - Branch ObjectId or null
 * @param {string} prefix - 'ORD' or 'WEB'
 */
async function generateOrderNumber(restaurantId, branchId, prefix = 'ORD') {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
  const branchIndex = await getBranchIndex(restaurantId, branchId);
  const basePrefix = `${prefix}-${dateStr}-${branchIndex}-`;

  const lastOrder = await Order.findOne({
    restaurant: restaurantId,
    branch: branchId || null,
    orderNumber: { $regex: `^${basePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
  })
    .sort({ orderNumber: -1 })
    .select('orderNumber')
    .lean();

  let nextSeq = 1;
  if (lastOrder && lastOrder.orderNumber) {
    const parts = lastOrder.orderNumber.split('-');
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
  }

  return `${basePrefix}${nextSeq.toString().padStart(4, '0')}`;
}

module.exports = { generateOrderNumber, getBranchIndex };
