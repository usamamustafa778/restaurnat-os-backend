/**
 * Example: How to integrate deals into order processing
 * This shows a complete flow from finding applicable deals to creating an order
 */

const Order = require('../models/Order');
const Deal = require('../models/Deal');
const DealUsage = require('../models/DealUsage');
const { findBestDeals, applyBestDeals } = require('../utils/dealCalculator');

/**
 * Example 1: Process an order with automatic deal application
 */
async function processOrderWithDeals(orderData) {
  const {
    restaurantId,
    branchId,
    customerId,
    items, // [{ menuItem, name, quantity, unitPrice, category }]
    orderType,
    paymentMethod,
    createdBy,
  } = orderData;

  // Calculate subtotal
  const subtotal = items.reduce((sum, item) => {
    item.lineTotal = item.unitPrice * item.quantity;
    return sum + item.lineTotal;
  }, 0);

  // Find all applicable deals
  const availableDeals = await findBestDeals(
    restaurantId,
    branchId,
    items,
    subtotal,
    customerId
  );

  console.log(`Found ${availableDeals.length} applicable deals:`);
  availableDeals.forEach((deal) => {
    console.log(
      `- ${deal.deal.name}: -$${deal.discountAmount.toFixed(2)} (${deal.dealType})`
    );
  });

  // Apply best deal (or allow stacking if needed)
  const { totalDiscount, appliedDeals } = applyBestDeals(
    availableDeals,
    false // set to true to allow stacking
  );

  console.log(`\nTotal discount applied: $${totalDiscount.toFixed(2)}`);

  // Calculate final total
  const total = subtotal - totalDiscount;

  // Prepare applied deals for order record
  const appliedDealsForOrder = appliedDeals.map((ad) => ({
    deal: ad.deal._id,
    dealName: ad.deal.name,
    dealType: ad.dealType,
    discountAmount: ad.discountAmount,
  }));

  // Create order
  const order = await Order.create({
    restaurant: restaurantId,
    branch: branchId,
    customer: customerId,
    createdBy,
    orderType,
    paymentMethod,
    items: items.map((item) => ({
      menuItem: item.menuItem,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
    })),
    subtotal,
    discountAmount: totalDiscount,
    appliedDeals: appliedDealsForOrder,
    total,
    orderNumber: await generateOrderNumber(),
    status: 'PENDING',
  });

  // Record deal usage for each applied deal
  for (const appliedDeal of appliedDeals) {
    if (customerId) {
      await DealUsage.recordUsage(
        appliedDeal.deal._id,
        customerId,
        order._id,
        appliedDeal.discountAmount
      );
    }

    // Increment deal usage count
    await appliedDeal.deal.incrementUsage();
  }

  console.log(`\nOrder created: ${order.orderNumber}`);
  console.log(`Subtotal: $${subtotal.toFixed(2)}`);
  console.log(`Discount: -$${totalDiscount.toFixed(2)}`);
  console.log(`Total: $${total.toFixed(2)}`);

  return order;
}

/**
 * Example 2: Show available deals to customer before ordering
 */
async function getAvailableDealsForCustomer(restaurantId, branchId, customerId = null) {
  const deals = await Deal.findApplicableDeals(restaurantId, branchId);

  // Filter by customer eligibility if customerId provided
  const eligibleDeals = [];

  for (const deal of deals) {
    if (customerId && deal.maxUsagePerCustomer) {
      const usageCheck = await DealUsage.canCustomerUseDeal(deal._id, customerId);
      if (!usageCheck.canUse) {
        continue;
      }
      eligibleDeals.push({
        ...deal.toObject(),
        customerUsage: usageCheck.currentUsage,
        remainingUses: usageCheck.remainingUses,
      });
    } else {
      eligibleDeals.push(deal.toObject());
    }
  }

  return eligibleDeals;
}

/**
 * Example 3: Check if a specific deal applies to a cart
 */
async function checkDealEligibility(dealId, cartItems, subtotal, customerId) {
  const deal = await Deal.findById(dealId);

  if (!deal) {
    return { eligible: false, reason: 'Deal not found' };
  }

  if (!deal.isCurrentlyValid) {
    return { eligible: false, reason: 'Deal is not currently active' };
  }

  // Check customer usage
  if (customerId && deal.maxUsagePerCustomer) {
    const usageCheck = await DealUsage.canCustomerUseDeal(dealId, customerId);
    if (!usageCheck.canUse) {
      return { eligible: false, reason: usageCheck.reason };
    }
  }

  // Check deal type specific requirements
  switch (deal.dealType) {
    case 'MINIMUM_PURCHASE':
      if (subtotal < deal.minimumPurchaseAmount) {
        return {
          eligible: false,
          reason: `Minimum purchase of $${deal.minimumPurchaseAmount} required`,
          currentAmount: subtotal,
          remaining: deal.minimumPurchaseAmount - subtotal,
        };
      }
      break;

    case 'COMBO':
      const hasAllItems = deal.comboItems.every((comboItem) => {
        const cartItem = cartItems.find(
          (ci) => ci.menuItem.toString() === comboItem.menuItem.toString()
        );
        return cartItem && cartItem.quantity >= comboItem.quantity;
      });

      if (!hasAllItems) {
        return {
          eligible: false,
          reason: 'Cart does not contain all required combo items',
          requiredItems: deal.comboItems,
        };
      }
      break;

    case 'BUY_X_GET_Y':
      const buyItem = cartItems.find(
        (ci) => ci.menuItem.toString() === deal.buyMenuItem.toString()
      );

      if (!buyItem || buyItem.quantity < deal.buyQuantity) {
        return {
          eligible: false,
          reason: `Need to buy ${deal.buyQuantity} of the required item`,
          currentQuantity: buyItem ? buyItem.quantity : 0,
        };
      }
      break;
  }

  return { eligible: true, deal };
}

/**
 * Example 4: Manual deal application (for POS)
 */
async function applySpecificDealToOrder(dealId, orderData) {
  const { restaurantId, branchId, customerId, items } = orderData;

  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  // Check eligibility
  const eligibilityCheck = await checkDealEligibility(dealId, items, subtotal, customerId);

  if (!eligibilityCheck.eligible) {
    throw new Error(eligibilityCheck.reason);
  }

  const deal = eligibilityCheck.deal;

  // Calculate discount using the deal calculator
  const { calculateDealDiscount } = require('../utils/dealCalculator');
  const discountResult = calculateDealDiscount(deal, items, subtotal);

  if (!discountResult.dealApplied) {
    throw new Error('Deal could not be applied to this order');
  }

  return {
    deal,
    discountAmount: discountResult.discountAmount,
    newTotal: subtotal - discountResult.discountAmount,
    details: discountResult,
  };
}

/**
 * Example 5: Get deal analytics
 */
async function getDealAnalytics(dealId) {
  const deal = await Deal.findById(dealId);

  if (!deal) {
    throw new Error('Deal not found');
  }

  const usageRecords = await DealUsage.find({ deal: dealId })
    .populate('customer', 'name email')
    .populate('order', 'orderNumber createdAt total');

  const totalDiscount = usageRecords.reduce((sum, record) => sum + record.discountApplied, 0);
  const uniqueCustomers = new Set(usageRecords.map((r) => r.customer?._id.toString())).size;

  const analytics = {
    dealName: deal.name,
    dealType: deal.dealType,
    status: deal.isActive ? 'Active' : 'Inactive',
    dateRange: {
      start: deal.startDate,
      end: deal.endDate,
    },
    usage: {
      total: deal.currentUsageCount,
      limit: deal.maxTotalUsage || 'Unlimited',
      remaining: deal.maxTotalUsage
        ? Math.max(0, deal.maxTotalUsage - deal.currentUsageCount)
        : 'Unlimited',
    },
    financialImpact: {
      totalDiscountGiven: totalDiscount,
      averageDiscountPerUse:
        deal.currentUsageCount > 0 ? totalDiscount / deal.currentUsageCount : 0,
      totalOrders: usageRecords.length,
    },
    customerEngagement: {
      uniqueCustomers,
      averageUsesPerCustomer:
        uniqueCustomers > 0 ? deal.currentUsageCount / uniqueCustomers : 0,
    },
    recentUsage: usageRecords.slice(0, 10).map((record) => ({
      customer: record.customer?.name || 'Guest',
      orderNumber: record.order?.orderNumber,
      discountApplied: record.discountApplied,
      date: record.createdAt,
    })),
  };

  return analytics;
}

// Helper function
async function generateOrderNumber() {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
  return `ORD-${timestamp}-${random}`;
}

// Export examples
module.exports = {
  processOrderWithDeals,
  getAvailableDealsForCustomer,
  checkDealEligibility,
  applySpecificDealToOrder,
  getDealAnalytics,
};

/**
 * USAGE EXAMPLES:
 *
 * 1. Process order with automatic best deal:
 *
 * const order = await processOrderWithDeals({
 *   restaurantId: '...',
 *   branchId: '...',
 *   customerId: '...',
 *   items: [
 *     { menuItem: '...', name: 'Burger', quantity: 2, unitPrice: 10.99, category: '...' },
 *     { menuItem: '...', name: 'Fries', quantity: 1, unitPrice: 3.99, category: '...' }
 *   ],
 *   orderType: 'DINE_IN',
 *   paymentMethod: 'CARD',
 *   createdBy: '...'
 * });
 *
 *
 * 2. Show available deals to customer:
 *
 * const deals = await getAvailableDealsForCustomer(restaurantId, branchId, customerId);
 * console.log('Available deals:', deals);
 *
 *
 * 3. Check if customer can use a specific deal:
 *
 * const check = await checkDealEligibility(dealId, cartItems, subtotal, customerId);
 * if (check.eligible) {
 *   console.log('Deal can be applied!');
 * } else {
 *   console.log('Cannot apply deal:', check.reason);
 * }
 *
 *
 * 4. Apply specific deal manually:
 *
 * try {
 *   const result = await applySpecificDealToOrder(dealId, orderData);
 *   console.log(`Discount: $${result.discountAmount}`);
 *   console.log(`New total: $${result.newTotal}`);
 * } catch (error) {
 *   console.error('Deal application failed:', error.message);
 * }
 *
 *
 * 5. Get deal performance analytics:
 *
 * const analytics = await getDealAnalytics(dealId);
 * console.log('Total discount given:', analytics.financialImpact.totalDiscountGiven);
 * console.log('Unique customers:', analytics.customerEngagement.uniqueCustomers);
 */
