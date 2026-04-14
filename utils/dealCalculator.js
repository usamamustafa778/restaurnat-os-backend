const Deal = require('../models/Deal');
const DealUsage = require('../models/DealUsage');

/** Normalize Mongo refs / strings / populated docs to a comparable id string */
function toRefString(ref) {
  if (ref == null) return '';
  if (typeof ref === 'object' && ref._id != null) return String(ref._id);
  return String(ref);
}

/**
 * POS and clients may send `menuItemId` instead of `menuItem`. Normalize so
 * all calculators can safely use `oi.menuItem`.
 */
function normalizeOrderItemsForDeals(orderItems) {
  if (!Array.isArray(orderItems)) return [];
  return orderItems
    .map((oi) => {
      const menuItem = oi.menuItem ?? oi.menuItemId ?? oi.id;
      if (menuItem === undefined || menuItem === null || menuItem === '') return null;
      return {
        ...oi,
        menuItem,
        quantity: Number(oi.quantity) || 0,
        price: Number(oi.price) || 0,
        category: oi.category ?? oi.categoryId ?? null,
      };
    })
    .filter((oi) => oi && oi.quantity > 0);
}

/**
 * Calculate discount for a given deal and order items
 * @param {Object} deal - The deal object
 * @param {Array} orderItems - Array of order items {menuItem, quantity, price}
 * @param {Number} subtotal - Order subtotal before discount
 * @returns {Object} - {discountAmount, modifiedItems, dealApplied}
 */
const calculateDealDiscount = (deal, orderItems, subtotal) => {
  if (!deal.isCurrentlyValid) {
    return { discountAmount: 0, modifiedItems: [], dealApplied: false };
  }

  switch (deal.dealType) {
    case 'PERCENTAGE_DISCOUNT':
      return calculatePercentageDiscount(deal, orderItems, subtotal);
    
    case 'FIXED_DISCOUNT':
      return calculateFixedDiscount(deal, orderItems, subtotal);
    
    case 'COMBO':
      return calculateComboDiscount(deal, orderItems);
    
    case 'BUY_X_GET_Y':
      return calculateBuyXGetYDiscount(deal, orderItems);
    
    case 'MINIMUM_PURCHASE':
      return calculateMinimumPurchaseDiscount(deal, subtotal);
    
    default:
      return { discountAmount: 0, modifiedItems: [], dealApplied: false };
  }
};

/**
 * Calculate percentage discount
 */
const calculatePercentageDiscount = (deal, orderItems, subtotal) => {
  // Check if discount applies to specific items or categories
  const applicableItems = getApplicableItems(deal, orderItems);
  
  if (applicableItems.length === 0) {
    // If no specific items are set, apply to entire order
    const discountAmount = (subtotal * deal.discountPercentage) / 100;
    return {
      discountAmount: Math.min(discountAmount, subtotal),
      modifiedItems: [],
      dealApplied: true,
      dealType: 'PERCENTAGE_DISCOUNT',
    };
  }

  // Apply to specific items only
  let discountAmount = 0;
  applicableItems.forEach((item) => {
    const itemTotal = item.price * item.quantity;
    discountAmount += (itemTotal * deal.discountPercentage) / 100;
  });

  return {
    discountAmount,
    modifiedItems: applicableItems.map((i) => i.menuItem),
    dealApplied: true,
    dealType: 'PERCENTAGE_DISCOUNT',
  };
};

/**
 * Calculate fixed amount discount
 */
const calculateFixedDiscount = (deal, orderItems, subtotal) => {
  const applicableItems = getApplicableItems(deal, orderItems);
  
  if (applicableItems.length === 0) {
    // Apply to entire order
    return {
      discountAmount: Math.min(deal.discountAmount, subtotal),
      modifiedItems: [],
      dealApplied: true,
      dealType: 'FIXED_DISCOUNT',
    };
  }

  // Apply to specific items only
  const applicableTotal = applicableItems.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  return {
    discountAmount: Math.min(deal.discountAmount, applicableTotal),
    modifiedItems: applicableItems.map((i) => i.menuItem),
    dealApplied: true,
    dealType: 'FIXED_DISCOUNT',
  };
};

/**
 * Calculate combo deal discount
 */
const calculateComboDiscount = (deal, orderItems) => {
  if (!deal.comboItems || deal.comboItems.length === 0) {
    return { discountAmount: 0, modifiedItems: [], dealApplied: false };
  }

  // Check if order contains all combo items
  const hasAllComboItems = deal.comboItems.every((comboItem) => {
    const comboMid = toRefString(comboItem.menuItem);
    const orderItem = orderItems.find((oi) => toRefString(oi.menuItem) === comboMid);
    return orderItem && orderItem.quantity >= comboItem.quantity;
  });

  if (!hasAllComboItems) {
    return { discountAmount: 0, modifiedItems: [], dealApplied: false };
  }

  // Calculate original price of combo items
  let originalComboPrice = 0;
  deal.comboItems.forEach((comboItem) => {
    const comboMid = toRefString(comboItem.menuItem);
    const orderItem = orderItems.find((oi) => toRefString(oi.menuItem) === comboMid);
    if (orderItem) {
      originalComboPrice += orderItem.price * comboItem.quantity;
    }
  });

  const discountAmount = originalComboPrice - deal.comboPrice;

  return {
    discountAmount: Math.max(0, discountAmount),
    modifiedItems: deal.comboItems.map((ci) => ci.menuItem),
    dealApplied: true,
    dealType: 'COMBO',
    comboPrice: deal.comboPrice,
    originalPrice: originalComboPrice,
  };
};

/**
 * Calculate Buy X Get Y discount
 */
const calculateBuyXGetYDiscount = (deal, orderItems) => {
  if (!deal.buyMenuItem) {
    return { discountAmount: 0, modifiedItems: [], dealApplied: false };
  }
  const buyMid = toRefString(deal.buyMenuItem);
  const buyItem = orderItems.find((oi) => toRefString(oi.menuItem) === buyMid);

  if (!buyItem || buyItem.quantity < deal.buyQuantity) {
    return { discountAmount: 0, modifiedItems: [], dealApplied: false };
  }

  // Calculate how many sets of (Buy X Get Y) can be applied
  const sets = Math.floor(buyItem.quantity / deal.buyQuantity);

  // Get the item to discount (could be same or different)
  const getItemId = deal.getMenuItem || deal.buyMenuItem;
  const getMid = toRefString(getItemId);
  const getItem = orderItems.find((oi) => toRefString(oi.menuItem) === getMid);

  if (!getItem) {
    return { discountAmount: 0, modifiedItems: [], dealApplied: false };
  }

  // Discount is for Y items at full price per set
  const itemsToDiscount = Math.min(sets * deal.getQuantity, getItem.quantity);
  const discountAmount = itemsToDiscount * getItem.price;

  return {
    discountAmount,
    modifiedItems: [getItemId],
    dealApplied: true,
    dealType: 'BUY_X_GET_Y',
    freeItems: itemsToDiscount,
  };
};

/**
 * Calculate minimum purchase discount
 */
const calculateMinimumPurchaseDiscount = (deal, subtotal) => {
  if (subtotal < deal.minimumPurchaseAmount) {
    return {
      discountAmount: 0,
      modifiedItems: [],
      dealApplied: false,
      reason: `Minimum purchase of $${deal.minimumPurchaseAmount} required`,
    };
  }

  return {
    discountAmount: Math.min(deal.discountAmount, subtotal),
    modifiedItems: [],
    dealApplied: true,
    dealType: 'MINIMUM_PURCHASE',
  };
};

/**
 * Get items from order that are applicable for the deal
 */
const getApplicableItems = (deal, orderItems) => {
  // If no specific restrictions, all items are applicable
  if (
    (!deal.applicableMenuItems || deal.applicableMenuItems.length === 0) &&
    (!deal.applicableCategories || deal.applicableCategories.length === 0)
  ) {
    return orderItems;
  }

  return orderItems.filter((item) => {
    const itemMid = toRefString(item.menuItem);
    if (!itemMid) return false;

    // Check if item is in applicableMenuItems
    if (
      deal.applicableMenuItems &&
      deal.applicableMenuItems.some(
        (ami) => toRefString(ami) === itemMid
      )
    ) {
      return true;
    }

    // Check if item's category is in applicableCategories
    if (
      deal.applicableCategories &&
      item.category &&
      deal.applicableCategories.some(
        (ac) => toRefString(ac) === toRefString(item.category)
      )
    ) {
      return true;
    }

    return false;
  });
};

/**
 * Find best applicable deals for an order
 * @param {String} restaurantId - Restaurant ID
 * @param {String} branchId - Branch ID
 * @param {Array} orderItems - Array of order items
 * @param {Number} subtotal - Order subtotal
 * @param {String} customerId - Optional customer ID for usage limits
 * @returns {Array} - Sorted array of deals with calculated discounts
 */
const findBestDeals = async (restaurantId, branchId, orderItems, subtotal, customerId = null) => {
  const normalizedItems = normalizeOrderItemsForDeals(orderItems);

  // Get all applicable deals
  const deals = await Deal.findApplicableDeals(restaurantId, branchId);

  // Calculate discount for each deal
  const dealsWithDiscounts = [];

  for (const deal of deals) {
    // Check customer usage limit if customer is provided
    if (customerId && deal.maxUsagePerCustomer) {
      const usageCheck = await DealUsage.canCustomerUseDeal(deal._id, customerId);
      if (!usageCheck.canUse) {
        continue; // Skip this deal
      }
    }

    const discountCalc = calculateDealDiscount(deal, normalizedItems, subtotal);
    
    if (discountCalc.dealApplied && discountCalc.discountAmount > 0) {
      dealsWithDiscounts.push({
        deal,
        ...discountCalc,
      });
    }
  }

  // Sort by discount amount (highest first)
  dealsWithDiscounts.sort((a, b) => b.discountAmount - a.discountAmount);

  return dealsWithDiscounts;
};

/**
 * Apply best deal(s) to an order
 * @param {Array} availableDeals - Deals with calculated discounts
 * @param {Boolean} allowStacking - Whether to allow multiple deals
 * @returns {Object} - {totalDiscount, appliedDeals[]}
 */
const applyBestDeals = (availableDeals, allowStacking = false) => {
  if (availableDeals.length === 0) {
    return { totalDiscount: 0, appliedDeals: [] };
  }

  if (!allowStacking) {
    // Apply only the best deal
    const bestDeal = availableDeals[0];
    return {
      totalDiscount: bestDeal.discountAmount,
      appliedDeals: [bestDeal],
    };
  }

  // Apply multiple deals that can stack
  const stackableDeals = availableDeals.filter((d) => d.deal.canStackWithOtherDeals);
  const totalDiscount = stackableDeals.reduce((sum, d) => sum + d.discountAmount, 0);

  return {
    totalDiscount,
    appliedDeals: stackableDeals,
  };
};

module.exports = {
  calculateDealDiscount,
  findBestDeals,
  normalizeOrderItemsForDeals,
  applyBestDeals,
  calculatePercentageDiscount,
  calculateFixedDiscount,
  calculateComboDiscount,
  calculateBuyXGetYDiscount,
  calculateMinimumPurchaseDiscount,
};
