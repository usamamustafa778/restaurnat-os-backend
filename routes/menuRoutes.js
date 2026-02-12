const express = require('express');
const router = express.Router();
const {
  getBranchMenu,
  getBranchMenuByCategory,
  getBranchMenuItem,
  setBranchPrice,
  setBranchAvailability,
  clearBranchOverride,
  getBranchExclusiveItems,
} = require('../utils/branchMenuHelper');
const { protect } = require('../middleware/authMiddleware');

/**
 * @route   GET /api/menu/branch/:branchId
 * @desc    Get full menu for a specific branch (with branch-specific pricing/availability)
 * @access  Public
 */
router.get('/branch/:branchId', async (req, res) => {
  try {
    const { branchId } = req.params;
    const { restaurantId, available, showOnWebsite, categoryId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ message: 'restaurantId query parameter is required' });
    }

    const filters = {
      available: available === 'true' ? true : available === 'false' ? false : undefined,
      showOnWebsite: showOnWebsite === 'true' ? true : showOnWebsite === 'false' ? false : undefined,
      categoryId,
      onlyAvailable: available === 'true',
    };

    const menuItems = await getBranchMenu(restaurantId, branchId, filters);

    res.json(menuItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   GET /api/menu/branch/:branchId/by-category
 * @desc    Get menu grouped by categories for a specific branch
 * @access  Public
 */
router.get('/branch/:branchId/by-category', async (req, res) => {
  try {
    const { branchId } = req.params;
    const { restaurantId, activeOnly, excludeEmpty } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ message: 'restaurantId query parameter is required' });
    }

    const filters = {
      activeOnly: activeOnly !== 'false',
      excludeEmpty: excludeEmpty !== 'false',
      onlyAvailable: true,
      showOnWebsite: true,
    };

    const categories = await getBranchMenuByCategory(restaurantId, branchId, filters);

    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   GET /api/menu/branch/:branchId/item/:itemId
 * @desc    Get a single menu item with branch-specific data
 * @access  Public
 */
router.get('/branch/:branchId/item/:itemId', async (req, res) => {
  try {
    const { branchId, itemId } = req.params;

    const menuItem = await getBranchMenuItem(itemId, branchId);

    if (!menuItem) {
      return res.status(404).json({ message: 'Menu item not found' });
    }

    res.json(menuItem);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   GET /api/menu/branch/:branchId/exclusive
 * @desc    Get items that are only available at this branch
 * @access  Public
 */
router.get('/branch/:branchId/exclusive', async (req, res) => {
  try {
    const { branchId } = req.params;
    const { restaurantId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ message: 'restaurantId query parameter is required' });
    }

    const exclusiveItems = await getBranchExclusiveItems(restaurantId, branchId);

    res.json(exclusiveItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   POST /api/menu/branch/:branchId/item/:itemId/price
 * @desc    Set branch-specific price for a menu item
 * @access  Admin only
 */
router.post('/branch/:branchId/item/:itemId/price', protect, async (req, res) => {
  try {
    const { branchId, itemId } = req.params;
    const { priceOverride } = req.body;

    if (priceOverride !== null && (typeof priceOverride !== 'number' || priceOverride < 0)) {
      return res.status(400).json({ message: 'priceOverride must be a positive number or null' });
    }

    const branchMenuItem = await setBranchPrice(branchId, itemId, priceOverride);

    res.json({
      message: 'Branch price updated successfully',
      branchMenuItem,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   POST /api/menu/branch/:branchId/item/:itemId/availability
 * @desc    Set branch-specific availability for a menu item
 * @access  Admin only
 */
router.post('/branch/:branchId/item/:itemId/availability', protect, async (req, res) => {
  try {
    const { branchId, itemId } = req.params;
    const { available } = req.body;

    if (typeof available !== 'boolean') {
      return res.status(400).json({ message: 'available must be a boolean' });
    }

    const branchMenuItem = await setBranchAvailability(branchId, itemId, available);

    res.json({
      message: 'Branch availability updated successfully',
      branchMenuItem,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   DELETE /api/menu/branch/:branchId/item/:itemId/override
 * @desc    Clear branch override (revert to base menu item values)
 * @access  Admin only
 */
router.delete('/branch/:branchId/item/:itemId/override', protect, async (req, res) => {
  try {
    const { branchId, itemId } = req.params;

    await clearBranchOverride(branchId, itemId);

    res.json({ message: 'Branch override cleared successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   GET /api/menu/restaurant/:restaurantId
 * @desc    Get base menu for restaurant (no branch-specific data)
 * @access  Public
 */
router.get('/restaurant/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { available, showOnWebsite, categoryId } = req.query;

    const filters = {
      available: available === 'true' ? true : available === 'false' ? false : undefined,
      showOnWebsite: showOnWebsite === 'true' ? true : showOnWebsite === 'false' ? false : undefined,
      categoryId,
    };

    const menuItems = await getBranchMenu(restaurantId, null, filters);

    res.json(menuItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   GET /api/menu/restaurant/:restaurantId/by-category
 * @desc    Get base menu grouped by categories (no branch-specific data)
 * @access  Public
 */
router.get('/restaurant/:restaurantId/by-category', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { activeOnly, excludeEmpty } = req.query;

    const filters = {
      activeOnly: activeOnly !== 'false',
      excludeEmpty: excludeEmpty !== 'false',
      showOnWebsite: true,
    };

    const categories = await getBranchMenuByCategory(restaurantId, null, filters);

    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   POST /api/menu/branch/:branchId/bulk-update
 * @desc    Bulk update branch overrides for multiple items
 * @access  Admin only
 */
router.post('/branch/:branchId/bulk-update', protect, async (req, res) => {
  try {
    const { branchId } = req.params;
    const { updates } = req.body; // [{ menuItemId, priceOverride?, available? }]

    if (!Array.isArray(updates)) {
      return res.status(400).json({ message: 'updates must be an array' });
    }

    const results = [];

    for (const update of updates) {
      const { menuItemId, priceOverride, available } = update;

      if (!menuItemId) continue;

      try {
        if (priceOverride !== undefined && priceOverride !== null) {
          await setBranchPrice(branchId, menuItemId, priceOverride);
        }

        if (available !== undefined) {
          await setBranchAvailability(branchId, menuItemId, available);
        }

        results.push({
          menuItemId,
          success: true,
        });
      } catch (error) {
        results.push({
          menuItemId,
          success: false,
          error: error.message,
        });
      }
    }

    res.json({
      message: 'Bulk update completed',
      results,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
