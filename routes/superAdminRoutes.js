const express = require('express');
const Restaurant = require('../models/Restaurant');
const User = require('../models/User');
const Branch = require('../models/Branch');
const { protect, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect, requireRole('super_admin'));

// @route   POST /api/super/restaurants
// @desc    Onboard a new restaurant and create admin user
// @access  Super Admin
router.post('/restaurants', async (req, res, next) => {
  try {
    const {
      subdomain,
      name,
      description,
      logoUrl,
      bannerUrl,
      contactPhone,
      contactEmail,
      address,
      subscriptionPlan,
      subscriptionStatus,
      trialEndsAt,
      expiresAt,
      adminName,
      adminEmail,
      adminPassword,
    } = req.body;

    if (!subdomain || !name || !adminName || !adminEmail || !adminPassword) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const existingSubdomain = await Restaurant.findOne({ 'website.subdomain': subdomain.toLowerCase().trim() });
    if (existingSubdomain) {
      return res.status(400).json({ message: 'Subdomain already in use' });
    }

    const adminExists = await User.findOne({ email: adminEmail.toLowerCase().trim() });
    if (adminExists) {
      return res.status(400).json({ message: 'Admin email already in use' });
    }

    // Default 15-day free trial for new restaurants
    const now = new Date();
    const defaultTrialEnd = new Date(now);
    defaultTrialEnd.setDate(defaultTrialEnd.getDate() + 15);

    const restaurant = await Restaurant.create({
      website: {
        subdomain: subdomain.toLowerCase().trim(),
        name,
        description,
        logoUrl,
        bannerUrl,
        contactPhone,
        contactEmail,
        address,
      },
      subscription: {
        plan: subscriptionPlan || 'ESSENTIAL',
        status: subscriptionStatus || 'TRIAL',
        trialStartsAt: now,
        trialEndsAt: trialEndsAt ? new Date(trialEndsAt) : defaultTrialEnd,
        freeTrialStartDate: now,
        freeTrialEndDate: trialEndsAt ? new Date(trialEndsAt) : defaultTrialEnd,
        subscriptionStartDate: expiresAt ? now : undefined,
        subscriptionEndDate: expiresAt ? new Date(expiresAt) : undefined,
      },
      readonly: false,
    });

    const adminUser = await User.create({
      name: adminName,
      email: adminEmail.toLowerCase().trim(),
      password: adminPassword,
      role: 'restaurant_admin',
      restaurant: restaurant._id,
    });

    res.status(201).json({
      restaurant: {
        id: restaurant._id,
        website: restaurant.website,
        subscription: restaurant.subscription,
      },
      adminUser: {
        id: adminUser._id,
        name: adminUser.name,
        email: adminUser.email,
        role: adminUser.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/super/restaurants
// @desc    List all restaurants with subscription info
// @access  Super Admin
router.get('/restaurants', async (req, res, next) => {
  try {
    const restaurants = await Restaurant.find({}).sort({ createdAt: -1 });
    res.json(
      restaurants.map((r) => ({
        id: r._id,
        website: r.website,
        subscription: r.subscription,
        createdAt: r.createdAt,
      }))
    );
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/super/branches
// @desc    List all branches of all restaurants (super_admin only)
// @access  Super Admin
router.get('/branches', async (req, res, next) => {
  try {
    const branches = await Branch.find({ isDeleted: { $ne: true } })
      .populate('restaurant', 'website.subdomain website.name')
      .sort({ restaurant: 1, sortOrder: 1, createdAt: 1 })
      .lean();

    const list = branches.map((b) => ({
      id: b._id.toString(),
      name: b.name,
      code: b.code || '',
      address: b.address || '',
      contactPhone: b.contactPhone || '',
      contactEmail: b.contactEmail || '',
      status: b.status || 'active',
      sortOrder: b.sortOrder ?? 0,
      restaurantId: b.restaurant?._id?.toString(),
      restaurantName: b.restaurant?.website?.name || '—',
      subdomain: b.restaurant?.website?.subdomain || '—',
    }));

    res.json({ branches: list });
  } catch (error) {
    next(error);
  }
});

// @route   PATCH /api/super/restaurants/:id/subscription
// @desc    Update subscription status/plan/dates
// @access  Super Admin
router.patch('/restaurants/:id/subscription', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { plan, status, trialEndsAt, expiresAt } = req.body;

    const restaurant = await Restaurant.findById(id);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    if (!restaurant.subscription) {
      restaurant.subscription = {};
    }

    if (plan) restaurant.subscription.plan = plan;
    if (status) restaurant.subscription.status = status;
    if (trialEndsAt !== undefined) {
      restaurant.subscription.trialEndsAt = trialEndsAt ? new Date(trialEndsAt) : undefined;
    }
    if (expiresAt !== undefined) {
      restaurant.subscription.expiresAt = expiresAt ? new Date(expiresAt) : undefined;
    }

    await restaurant.save();

    res.json({
      id: restaurant._id,
      subscription: restaurant.subscription,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

