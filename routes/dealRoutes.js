const express = require('express');
const router = express.Router();
const Deal = require('../models/Deal');
const DealUsage = require('../models/DealUsage');
const { protect } = require('../middleware/authMiddleware');

/**
 * @route   POST /api/deals
 * @desc    Create a new deal
 * @access  Admin only
 */
router.post('/', protect, async (req, res) => {
  try {
    const deal = new Deal({
      ...req.body,
      restaurant: req.user.restaurant,
    });

    const savedDeal = await deal.save();
    res.status(201).json(savedDeal);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

/**
 * @route   GET /api/deals
 * @desc    Get all deals for the restaurant
 * @access  Authenticated users
 */
router.get('/', protect, async (req, res) => {
  try {
    const {
      isActive,
      dealType,
      branchId,
      showOnWebsite,
      showOnPOS,
      includeExpired,
    } = req.query;

    const query = { restaurant: req.user.restaurant };

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    if (dealType) {
      query.dealType = dealType;
    }

    if (branchId) {
      query.$or = [{ branches: { $size: 0 } }, { branches: branchId }];
    }

    if (showOnWebsite !== undefined) {
      query.showOnWebsite = showOnWebsite === 'true';
    }

    if (showOnPOS !== undefined) {
      query.showOnPOS = showOnPOS === 'true';
    }

    if (!includeExpired || includeExpired === 'false') {
      query.endDate = { $gte: new Date() };
    }

    const deals = await Deal.find(query)
      .populate('applicableMenuItems')
      .populate('applicableCategories')
      .populate('comboItems.menuItem')
      .populate('buyMenuItem')
      .populate('getMenuItem')
      .populate('branches')
      .sort({ priority: -1, startDate: -1 });

    res.json(deals);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   GET /api/deals/active
 * @desc    Get currently active deals (respecting time/day restrictions)
 * @access  Public or authenticated
 */
router.get('/active', async (req, res) => {
  try {
    const { restaurantId, branchId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ message: 'restaurantId is required' });
    }

    const deals = await Deal.findApplicableDeals(restaurantId, branchId);

    await Deal.populate(deals, [
      { path: 'applicableMenuItems' },
      { path: 'applicableCategories' },
      { path: 'comboItems.menuItem' },
      { path: 'buyMenuItem' },
      { path: 'getMenuItem' },
    ]);

    res.json(deals);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   GET /api/deals/:id
 * @desc    Get a single deal by ID
 * @access  Authenticated users
 */
router.get('/:id', protect, async (req, res) => {
  try {
    const deal = await Deal.findOne({
      _id: req.params.id,
      restaurant: req.user.restaurant,
    })
      .populate('applicableMenuItems')
      .populate('applicableCategories')
      .populate('comboItems.menuItem')
      .populate('buyMenuItem')
      .populate('getMenuItem')
      .populate('branches');

    if (!deal) {
      return res.status(404).json({ message: 'Deal not found' });
    }

    res.json(deal);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   PUT /api/deals/:id
 * @desc    Update a deal
 * @access  Admin only
 */
router.put('/:id', protect, async (req, res) => {
  try {
    const deal = await Deal.findOne({
      _id: req.params.id,
      restaurant: req.user.restaurant,
    });

    if (!deal) {
      return res.status(404).json({ message: 'Deal not found' });
    }

    Object.assign(deal, req.body);
    const updatedDeal = await deal.save();

    res.json(updatedDeal);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

/**
 * @route   DELETE /api/deals/:id
 * @desc    Delete a deal
 * @access  Admin only
 */
router.delete('/:id', protect, async (req, res) => {
  try {
    const deal = await Deal.findOne({
      _id: req.params.id,
      restaurant: req.user.restaurant,
    });

    if (!deal) {
      return res.status(404).json({ message: 'Deal not found' });
    }

    await deal.deleteOne();
    res.json({ message: 'Deal deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   POST /api/deals/:id/toggle
 * @desc    Toggle deal active status
 * @access  Admin only
 */
router.post('/:id/toggle', protect, async (req, res) => {
  try {
    const deal = await Deal.findOne({
      _id: req.params.id,
      restaurant: req.user.restaurant,
    });

    if (!deal) {
      return res.status(404).json({ message: 'Deal not found' });
    }

    deal.isActive = !deal.isActive;
    await deal.save();

    res.json({ message: `Deal ${deal.isActive ? 'activated' : 'deactivated'}`, deal });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   GET /api/deals/:id/usage
 * @desc    Get usage statistics for a deal
 * @access  Admin only
 */
router.get('/:id/usage', protect, async (req, res) => {
  try {
    const deal = await Deal.findOne({
      _id: req.params.id,
      restaurant: req.user.restaurant,
    });

    if (!deal) {
      return res.status(404).json({ message: 'Deal not found' });
    }

    const usageRecords = await DealUsage.find({ deal: req.params.id })
      .populate('customer', 'name email phone')
      .populate('order', 'orderNumber totalAmount')
      .sort({ createdAt: -1 });

    const totalDiscount = usageRecords.reduce((sum, record) => sum + record.discountApplied, 0);
    const uniqueCustomers = new Set(usageRecords.map((r) => r.customer._id.toString())).size;

    res.json({
      deal,
      statistics: {
        totalUsage: deal.currentUsageCount,
        totalDiscountGiven: totalDiscount,
        uniqueCustomers,
        averageDiscountPerUse: deal.currentUsageCount > 0 ? totalDiscount / deal.currentUsageCount : 0,
      },
      usageRecords,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   POST /api/deals/:id/check-eligibility
 * @desc    Check if a customer can use a specific deal
 * @access  Authenticated users
 */
router.post('/:id/check-eligibility', protect, async (req, res) => {
  try {
    const { customerId } = req.body;

    const deal = await Deal.findById(req.params.id);

    if (!deal) {
      return res.status(404).json({ message: 'Deal not found' });
    }

    // Check if deal is currently valid
    if (!deal.isCurrentlyValid) {
      return res.json({
        eligible: false,
        reason: 'Deal is not currently active or has expired',
      });
    }

    // Check customer usage limit
    if (customerId && deal.maxUsagePerCustomer) {
      const usageCheck = await DealUsage.canCustomerUseDeal(req.params.id, customerId);
      
      if (!usageCheck.canUse) {
        return res.json({
          eligible: false,
          reason: usageCheck.reason,
        });
      }

      return res.json({
        eligible: true,
        currentUsage: usageCheck.currentUsage,
        remainingUses: usageCheck.remainingUses,
      });
    }

    res.json({ eligible: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
