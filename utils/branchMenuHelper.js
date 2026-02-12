const MenuItem = require('../models/MenuItem');
const BranchMenuItem = require('../models/BranchMenuItem');
const Category = require('../models/Category');
const BranchInventory = require('../models/BranchInventory');
const InventoryItem = require('../models/InventoryItem');

/**
 * Get menu items for a specific branch, with branch-specific overrides applied
 * @param {String} restaurantId - Restaurant ID
 * @param {String} branchId - Branch ID (optional)
 * @param {Object} filters - Optional filters { available, showOnWebsite, categoryId }
 * @returns {Array} Menu items with branch-specific data merged
 */
async function getBranchMenu(restaurantId, branchId = null, filters = {}) {
  // Build base query for menu items
  const menuQuery = { restaurant: restaurantId };
  
  if (filters.available !== undefined) {
    menuQuery.available = filters.available;
  }
  
  if (filters.showOnWebsite !== undefined) {
    menuQuery.showOnWebsite = filters.showOnWebsite;
  }
  
  if (filters.categoryId) {
    menuQuery.category = filters.categoryId;
  }

  // Get all base menu items
  const baseMenuItems = await MenuItem.find(menuQuery)
    .populate('category')
    .lean();

  // If no branch specified, return base items as-is
  if (!branchId) {
    return baseMenuItems.map(item => ({
      ...item,
      finalPrice: item.price,
      finalAvailable: item.available,
      hasBranchOverride: false,
    }));
  }

  // Get all branch overrides for this branch
  const branchOverrides = await BranchMenuItem.find({ branch: branchId }).lean();
  
  // Create a map for quick lookup
  const overrideMap = new Map();
  branchOverrides.forEach(override => {
    overrideMap.set(override.menuItem.toString(), override);
  });

  // Get branch inventory for stock checks
  const branchInventory = await BranchInventory.find({ branch: branchId }).lean();
  const inventoryMap = new Map();
  branchInventory.forEach(inv => {
    inventoryMap.set(inv.inventoryItem.toString(), inv);
  });

  // Merge base items with branch overrides
  const mergedItems = baseMenuItems
    .map(item => {
      const override = overrideMap.get(item._id.toString());
      
      // Calculate final price (override takes precedence)
      const finalPrice = override?.priceOverride ?? item.price;
      
      // Calculate final availability
      let finalAvailable = item.available;
      
      if (branchId) {
        // If item is NOT available at all branches by default, start with false
        if (item.availableAtAllBranches === false) {
          finalAvailable = false;
        }
        
        // Branch override takes precedence over default behavior
        if (override) {
          finalAvailable = override.available;
        }
      }
      
      // Check branch inventory if item has consumptions
      if (item.inventoryConsumptions && item.inventoryConsumptions.length > 0) {
        const hasStock = checkBranchInventory(item.inventoryConsumptions, inventoryMap);
        if (!hasStock) {
          finalAvailable = false;
        }
      }

      return {
        ...item,
        finalPrice,
        finalAvailable,
        hasBranchOverride: !!override,
        branchOverride: override ? {
          priceOverride: override.priceOverride,
          available: override.available,
        } : null,
      };
    })
    .filter(item => {
      // If checking for a specific branch and item is NOT available at all branches
      // Only include it if there's a branch override that explicitly enables it
      if (branchId && item.availableAtAllBranches === false) {
        const override = overrideMap.get(item._id.toString());
        // Only show if override exists AND is available
        return override && override.available === true;
      }
      // Otherwise, include the item
      return true;
    });

  // Filter out unavailable items if requested
  if (filters.onlyAvailable) {
    return mergedItems.filter(item => item.finalAvailable);
  }

  return mergedItems;
}

/**
 * Get categories with their menu items for a specific branch
 * @param {String} restaurantId - Restaurant ID
 * @param {String} branchId - Branch ID (optional)
 * @param {Object} filters - Optional filters
 * @returns {Object} Categories grouped with their items
 */
async function getBranchMenuByCategory(restaurantId, branchId = null, filters = {}) {
  // Get categories
  const categoryQuery = { restaurant: restaurantId };
  if (filters.activeOnly) {
    categoryQuery.isActive = true;
  }
  
  const categories = await Category.find(categoryQuery)
    .sort({ createdAt: 1 })
    .lean();

  // Get all menu items with branch overrides
  const allMenuItems = await getBranchMenu(restaurantId, branchId, filters);

  // Group items by category
  const categoryMap = new Map();
  categories.forEach(cat => {
    categoryMap.set(cat._id.toString(), {
      ...cat,
      items: [],
    });
  });

  // Add items to their categories
  allMenuItems.forEach(item => {
    const categoryId = item.category?._id?.toString() || item.category?.toString();
    if (categoryId && categoryMap.has(categoryId)) {
      categoryMap.get(categoryId).items.push(item);
    }
  });

  // Convert map to array and filter empty categories if requested
  let result = Array.from(categoryMap.values());
  
  if (filters.excludeEmpty) {
    result = result.filter(cat => cat.items.length > 0);
  }

  return result;
}

/**
 * Get a single menu item with branch-specific data
 * @param {String} menuItemId - Menu Item ID
 * @param {String} branchId - Branch ID (optional)
 * @returns {Object} Menu item with branch data
 */
async function getBranchMenuItem(menuItemId, branchId = null) {
  const baseItem = await MenuItem.findById(menuItemId)
    .populate('category')
    .lean();

  if (!baseItem) {
    return null;
  }

  if (!branchId) {
    return {
      ...baseItem,
      finalPrice: baseItem.price,
      finalAvailable: baseItem.available,
      hasBranchOverride: false,
    };
  }

  // Get branch override
  const override = await BranchMenuItem.findOne({
    branch: branchId,
    menuItem: menuItemId,
  }).lean();

  // Get branch inventory
  const branchInventory = await BranchInventory.find({ branch: branchId }).lean();
  const inventoryMap = new Map();
  branchInventory.forEach(inv => {
    inventoryMap.set(inv.inventoryItem.toString(), inv);
  });

  // If item is NOT available at all branches and there's no override enabling it
  // return null (item doesn't exist at this branch)
  if (baseItem.availableAtAllBranches === false) {
    if (!override || override.available !== true) {
      return null;
    }
  }

  // Calculate final values
  const finalPrice = override?.priceOverride ?? baseItem.price;
  let finalAvailable = baseItem.available;
  
  // If item is NOT available at all branches by default, start with false
  if (baseItem.availableAtAllBranches === false) {
    finalAvailable = false;
  }
  
  // Branch override takes precedence
  if (override) {
    finalAvailable = override.available;
  }

  // Check inventory
  if (baseItem.inventoryConsumptions && baseItem.inventoryConsumptions.length > 0) {
    const hasStock = checkBranchInventory(baseItem.inventoryConsumptions, inventoryMap);
    if (!hasStock) {
      finalAvailable = false;
    }
  }

  return {
    ...baseItem,
    finalPrice,
    finalAvailable,
    hasBranchOverride: !!override,
    branchOverride: override ? {
      priceOverride: override.priceOverride,
      available: override.available,
    } : null,
  };
}

/**
 * Check if branch has enough inventory for item consumptions
 * @param {Array} consumptions - Inventory consumptions
 * @param {Map} inventoryMap - Map of inventory items
 * @returns {Boolean} True if enough stock
 */
function checkBranchInventory(consumptions, inventoryMap) {
  for (const consumption of consumptions) {
    const invId = consumption.inventoryItem?.toString();
    if (!invId) continue;
    
    const inv = inventoryMap.get(invId);
    if (!inv) return false; // No branch inventory record = no stock
    
    const needed = consumption.quantity || 0;
    if (needed > 0 && inv.currentStock < needed) {
      return false;
    }
  }
  return true;
}

/**
 * Set or update branch-specific pricing
 * @param {String} branchId - Branch ID
 * @param {String} menuItemId - Menu Item ID
 * @param {Number} priceOverride - New price (null to use base price)
 * @returns {Object} Updated BranchMenuItem
 */
async function setBranchPrice(branchId, menuItemId, priceOverride) {
  const existing = await BranchMenuItem.findOne({
    branch: branchId,
    menuItem: menuItemId,
  });

  if (existing) {
    existing.priceOverride = priceOverride;
    return existing.save();
  }

  return BranchMenuItem.create({
    branch: branchId,
    menuItem: menuItemId,
    priceOverride,
    available: true,
  });
}

/**
 * Set or update branch-specific availability
 * @param {String} branchId - Branch ID
 * @param {String} menuItemId - Menu Item ID
 * @param {Boolean} available - Availability status
 * @returns {Object} Updated BranchMenuItem
 */
async function setBranchAvailability(branchId, menuItemId, available) {
  const existing = await BranchMenuItem.findOne({
    branch: branchId,
    menuItem: menuItemId,
  });

  if (existing) {
    existing.available = available;
    return existing.save();
  }

  return BranchMenuItem.create({
    branch: branchId,
    menuItem: menuItemId,
    available,
  });
}

/**
 * Clear branch override (revert to base item values)
 * @param {String} branchId - Branch ID
 * @param {String} menuItemId - Menu Item ID
 */
async function clearBranchOverride(branchId, menuItemId) {
  return BranchMenuItem.findOneAndDelete({
    branch: branchId,
    menuItem: menuItemId,
  });
}

/**
 * Get items that are available at a specific branch but not at others
 * (Useful for "Only at this location" badges)
 */
async function getBranchExclusiveItems(restaurantId, branchId) {
  const allBranches = await require('../models/Branch').find({ restaurant: restaurantId }).lean();
  const branchIds = allBranches.map(b => b._id.toString());
  
  // Get this branch's menu
  const thisBranchMenu = await getBranchMenu(restaurantId, branchId, { onlyAvailable: true });
  
  // Check each item against other branches
  const exclusiveItems = [];
  
  for (const item of thisBranchMenu) {
    let isExclusive = true;
    
    // Check if item is available at any other branch
    for (const otherBranchId of branchIds) {
      if (otherBranchId === branchId.toString()) continue;
      
      const otherBranchItem = await getBranchMenuItem(item._id.toString(), otherBranchId);
      if (otherBranchItem && otherBranchItem.finalAvailable) {
        isExclusive = false;
        break;
      }
    }
    
    if (isExclusive) {
      exclusiveItems.push(item);
    }
  }
  
  return exclusiveItems;
}

module.exports = {
  getBranchMenu,
  getBranchMenuByCategory,
  getBranchMenuItem,
  setBranchPrice,
  setBranchAvailability,
  clearBranchOverride,
  getBranchExclusiveItems,
};
