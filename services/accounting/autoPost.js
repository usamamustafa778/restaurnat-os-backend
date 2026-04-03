const Order   = require('../../models/Order');
const { Account, Voucher } = require('../../models/accounting');

/**
 * Map an Order's payment method + provider to the correct cash/bank account code.
 * Mirrors the COA codes seeded in setup.js.
 */
function resolvePaymentAccountCode(order) {
  const method   = (order.paymentMethod   || '').toUpperCase();
  const provider = (order.paymentProvider || '').toLowerCase();

  if (method === 'CASH') return '30101';         // Cash in Hand
  if (method === 'ONLINE') {
    if (provider.includes('easypaisa')) return '30301';
    if (provider.includes('jazzcash'))  return '30302';
    return '30201';                               // Main Bank Account fallback
  }
  if (method === 'CARD')  return '30201';         // Main Bank Account
  if (method === 'SPLIT') return '30101';         // Cash in Hand (simplified — split handled per amount below)
  return '30101';
}

/**
 * Map an Order's type to the correct revenue account code.
 */
function resolveRevenueAccountCode(order) {
  const type = (order.orderType || '').toUpperCase();
  if (type === 'DELIVERY') return '402';
  if (type === 'DINE_IN')  return '403';
  return '401'; // TAKEAWAY and anything else → Food Sales
}

/**
 * Determine voucher type from payment method.
 */
function resolveVoucherType(order) {
  const method = (order.paymentMethod || '').toUpperCase();
  if (method === 'CASH') return 'cash_receipt';
  return 'bank_receipt';
}

/**
 * Build accounting lines for a completed order.
 * Handles: cash, card, online (easypaisa/jazzcash), split payments.
 */
function buildOrderLines(order, acc) {
  const netTotal   = order.grandTotal ?? order.total;       // amount actually collected
  const grossSales = order.subtotal  ?? netTotal;            // before discount
  const discount   = order.discountAmount || 0;
  const lines      = [];

  if (order.paymentMethod === 'SPLIT') {
    // Split payment: debit each component separately
    const cash   = order.splitCashAmount   || 0;
    const card   = order.splitCardAmount   || 0;
    const online = order.splitOnlineAmount || 0;

    if (cash   > 0 && acc['30101']) lines.push({ accountId: acc['30101'], debit: cash,   credit: 0, description: `Cash portion – Order #${order.orderNumber}` });
    if (card   > 0 && acc['30201']) lines.push({ accountId: acc['30201'], debit: card,   credit: 0, description: `Card portion – Order #${order.orderNumber}` });
    if (online > 0) {
      const provider = (order.splitOnlineProvider || '').toLowerCase();
      const onlineAccId = provider.includes('easypaisa') ? acc['30301']
                        : provider.includes('jazzcash')   ? acc['30302']
                        : acc['30201'];
      if (onlineAccId) lines.push({ accountId: onlineAccId, debit: online, credit: 0, description: `Online portion – Order #${order.orderNumber}` });
    }
  } else {
    const payCode = resolvePaymentAccountCode(order);
    if (acc[payCode]) {
      lines.push({ accountId: acc[payCode], debit: netTotal, credit: 0, description: `Order #${order.orderNumber}` });
    }
  }

  // Discount debit (if any)
  if (discount > 0 && acc['405']) {
    lines.push({ accountId: acc['405'], debit: discount, credit: 0, description: `Discount – Order #${order.orderNumber}` });
  }

  // Revenue credit (gross before discount)
  const revCode = resolveRevenueAccountCode(order);
  if (acc[revCode]) {
    lines.push({ accountId: acc[revCode], debit: 0, credit: grossSales, description: `Sales – Order #${order.orderNumber}` });
  }

  return lines;
}

/**
 * Auto-post a single completed order as an accounting voucher.
 * Idempotent: skips if already posted (sourceId match).
 */
async function autoPostOrder(orderId, tenantId) {
  // Idempotency guard
  const existing = await Voucher.findOne({ tenantId, sourceId: orderId }).lean();
  if (existing) return { skipped: true, reason: 'already_posted' };

  const order = await Order.findById(orderId).lean();
  if (!order) return { skipped: true, reason: 'order_not_found' };

  const completedStatuses = ['DELIVERED', 'COMPLETED'];
  if (!completedStatuses.includes(order.status)) {
    return { skipped: true, reason: 'order_not_completed' };
  }

  // Only post orders that have a real payment (not PENDING)
  if (!order.paymentMethod || order.paymentMethod === 'PENDING') {
    return { skipped: true, reason: 'payment_pending' };
  }

  // Look up accounts by code for this tenant
  const CODES_NEEDED = ['30101', '30201', '30301', '30302', '401', '402', '403', '405'];
  const accounts = await Account.find({
    tenantId,
    code: { $in: CODES_NEEDED },
    isActive: true,
  }).lean();

  const acc = Object.fromEntries(accounts.map((a) => [a.code, a._id]));

  const lines = buildOrderLines(order, acc);
  if (!lines.length) return { skipped: true, reason: 'no_account_mapping' };

  const { createVoucher } = require('./voucherService');
  await createVoucher({
    tenantId,
    type:       resolveVoucherType(order),
    date:       order.updatedAt || new Date(),
    notes:      `Auto-posted: Order #${order.orderNumber}`,
    lines,
    autoPosted: true,
    sourceId:   orderId,
  });

  return { success: true };
}

/**
 * Sync all completed orders for a given date (YYYY-MM-DD string).
 * Used by the manual sync endpoint.
 */
async function syncSalesForDate(tenantId, date) {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end   = new Date(date); end.setHours(23, 59, 59, 999);

  const orders = await Order.find({
    restaurant: tenantId,
    status:     { $in: ['DELIVERED', 'COMPLETED'] },
    paymentMethod: { $ne: 'PENDING' },
    updatedAt:  { $gte: start, $lte: end },
  }).lean();

  const results = { synced: 0, skipped: 0, errors: [] };

  for (const order of orders) {
    try {
      const r = await autoPostOrder(order._id, tenantId);
      if (r.skipped) results.skipped++;
      else            results.synced++;
    } catch (err) {
      results.errors.push({ orderId: order._id, error: err.message });
    }
  }

  return results;
}

module.exports = { autoPostOrder, syncSalesForDate };
