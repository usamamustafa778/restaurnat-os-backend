const express = require('express');
const Restaurant = require('../models/Restaurant');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Lead = require('../models/Lead');
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const { protect, requireRole } = require('../middleware/authMiddleware');

/** Heuristic for super-admin: who is “really” using the product vs signups only. */
function computeEngagement({ ordersLast30Days, ordersLifetime, createdAt, menuItemsCount }) {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400000;
  if (ordersLast30Days >= 1) {
    return {
      key: 'active',
      label: 'Active',
      description: 'At least one order recorded in the last 30 days (POS / website / integrations).',
    };
  }
  if (ordersLifetime >= 1) {
    return {
      key: 'quiet',
      label: 'Quiet',
      description: 'Has order history but nothing in the last 30 days — follow up or seasonal.',
    };
  }
  if (ageDays <= 14) {
    return {
      key: 'new',
      label: 'New',
      description: 'Signed up recently; no orders yet (normal while onboarding).',
    };
  }
  if (menuItemsCount >= 3) {
    return {
      key: 'configured',
      label: 'Configured',
      description: 'Menu has items but no orders — may need training or go-live push.',
    };
  }
  return {
    key: 'dormant',
    label: 'Dormant',
    description: 'No orders and minimal setup — likely churned or stuck in signup.',
  };
}

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

    // Default 3-month free trial for new restaurants
    const now = new Date();
    const defaultTrialEnd = new Date(now);
    defaultTrialEnd.setMonth(defaultTrialEnd.getMonth() + 3);

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
// @desc    List all restaurants with subscription info (excludes soft-deleted)
// @access  Super Admin
router.get('/restaurants', async (req, res, next) => {
  try {
    const restaurants = await Restaurant.find({ isDeleted: { $ne: true } }).sort({ createdAt: -1 });
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

// @route   GET /api/super/restaurants/activity-summary
// @desc    Per-tenant usage: orders, revenue, setup counts — for platform health / engagement
// @access  Super Admin
router.get('/restaurants/activity-summary', async (req, res, next) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const restaurants = await Restaurant.find({ isDeleted: { $ne: true } })
      .sort({ createdAt: -1 })
      .lean();

    const [orderStats, menuCounts, branchCounts, userCounts] = await Promise.all([
      Order.aggregate([
        {
          $group: {
            _id: '$restaurant',
            ordersLifetime: { $sum: 1 },
            lastOrderAt: { $max: '$createdAt' },
            ordersLast7Days: {
              $sum: { $cond: [{ $gte: ['$createdAt', sevenDaysAgo] }, 1, 0] },
            },
            ordersLast30Days: {
              $sum: { $cond: [{ $gte: ['$createdAt', thirtyDaysAgo] }, 1, 0] },
            },
            revenueLast30Days: {
              $sum: {
                $cond: [{ $gte: ['$createdAt', thirtyDaysAgo] }, { $ifNull: ['$total', 0] }, 0],
              },
            },
            websiteOrdersLast30Days: {
              $sum: {
                $cond: [
                  {
                    $and: [{ $gte: ['$createdAt', thirtyDaysAgo] }, { $eq: ['$source', 'WEBSITE'] }],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      MenuItem.aggregate([
        { $group: { _id: '$restaurant', menuItemsCount: { $sum: 1 } } },
      ]),
      Branch.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $group: { _id: '$restaurant', branchesCount: { $sum: 1 } } },
      ]),
      User.aggregate([
        {
          $match: {
            restaurant: { $exists: true, $ne: null },
            role: { $ne: 'super_admin' },
          },
        },
        { $group: { _id: '$restaurant', teamMembersCount: { $sum: 1 } } },
      ]),
    ]);

    const orderMap = new Map(orderStats.map((o) => [o._id.toString(), o]));
    const menuMap = new Map(menuCounts.map((m) => [m._id.toString(), m.menuItemsCount]));
    const branchMap = new Map(branchCounts.map((b) => [b._id.toString(), b.branchesCount]));
    const userMap = new Map(userCounts.map((u) => [u._id.toString(), u.teamMembersCount]));

    const rows = restaurants.map((r) => {
      const id = r._id.toString();
      const o = orderMap.get(id);
      const ordersLast7Days = o?.ordersLast7Days ?? 0;
      const ordersLast30Days = o?.ordersLast30Days ?? 0;
      const ordersLifetime = o?.ordersLifetime ?? 0;
      const lastOrderAt = o?.lastOrderAt ? o.lastOrderAt.toISOString() : null;
      const revenueLast30Days = Math.round((o?.revenueLast30Days ?? 0) * 100) / 100;
      const websiteOrdersLast30Days = o?.websiteOrdersLast30Days ?? 0;
      const menuItemsCount = menuMap.get(id) ?? 0;
      const branchesCount = branchMap.get(id) ?? 0;
      const teamMembersCount = userMap.get(id) ?? 0;

      const engagement = computeEngagement({
        ordersLast30Days,
        ordersLifetime,
        createdAt: r.createdAt,
        menuItemsCount,
      });

      return {
        id,
        website: r.website,
        subscription: r.subscription,
        createdAt: r.createdAt,
        activity: {
          ordersLast7Days,
          ordersLast30Days,
          ordersLifetime,
          lastOrderAt,
          revenueLast30Days,
          websiteOrdersLast30Days,
          menuItemsCount,
          branchesCount,
          teamMembersCount,
        },
        engagement,
      };
    });

    const engaged30 = rows.filter((x) => x.activity.ordersLast30Days >= 1).length;
    const everOrdered = rows.filter((x) => x.activity.ordersLifetime >= 1).length;
    const noOrders = rows.filter((x) => x.activity.ordersLifetime === 0).length;

    res.json({
      generatedAt: new Date().toISOString(),
      summary: {
        totalRestaurants: rows.length,
        engagedLast30Days: engaged30,
        everHadOrders: everOrdered,
        neverHadOrders: noOrders,
        quietHadOrdersBefore: Math.max(0, everOrdered - engaged30),
      },
      restaurants: rows,
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/super/restaurants/deleted
// @desc    List soft-deleted restaurants from the last 48 hours
// @access  Super Admin
router.get('/restaurants/deleted', async (req, res, next) => {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const restaurants = await Restaurant.find({
      isDeleted: true,
      deletedAt: { $gte: cutoff },
    })
      .sort({ deletedAt: -1 })
      .lean();
    res.json({
      restaurants: restaurants.map((r) => ({
        id: r._id,
        website: r.website,
        subscription: r.subscription,
        createdAt: r.createdAt,
        deletedAt: r.deletedAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/super/restaurants/:id
// @desc    Soft-delete restaurant (recoverable within 48 hours) and remove related users
// @access  Super Admin
router.delete('/restaurants/:id', async (req, res, next) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }
    if (restaurant.isDeleted) {
      return res.status(400).json({ message: 'Restaurant is already deleted' });
    }
    restaurant.isDeleted = true;
    restaurant.deletedAt = new Date();
    await restaurant.save();

    // Remove all users linked to this restaurant (including restaurant_admin)
    await User.deleteMany({ restaurant: restaurant._id });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/super/restaurants/:id/restore
// @desc    Restore a soft-deleted restaurant within 48 hours
// @access  Super Admin
router.post('/restaurants/:id/restore', async (req, res, next) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }
    if (!restaurant.isDeleted || !restaurant.deletedAt) {
      return res.status(400).json({ message: 'Restaurant is not deleted' });
    }
    const now = Date.now();
    const deletedAtMs = restaurant.deletedAt.getTime();
    const diffHours = (now - deletedAtMs) / (1000 * 60 * 60);
    if (diffHours > 48) {
      return res.status(400).json({ message: 'Restore window (48 hours) has expired for this restaurant' });
    }
    restaurant.isDeleted = false;
    restaurant.deletedAt = null;
    await restaurant.save();
    res.json({
      id: restaurant._id,
      website: restaurant.website,
      subscription: restaurant.subscription,
      createdAt: restaurant.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/super/restaurants/:id/permanent
// @desc    Permanently delete a restaurant and related users (cannot be undone)
// @access  Super Admin
router.delete('/restaurants/:id/permanent', async (req, res, next) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    await Restaurant.deleteOne({ _id: restaurant._id });
    await User.deleteMany({ restaurant: restaurant._id });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/super/branches/:id
// @desc    Soft-delete branch (recoverable within 48 hours)
// @access  Super Admin
router.delete('/branches/:id', async (req, res, next) => {
  try {
    const branch = await Branch.findById(req.params.id);
    if (!branch) {
      return res.status(404).json({ message: 'Branch not found' });
    }
    if (branch.isDeleted) {
      return res.status(400).json({ message: 'Branch is already deleted' });
    }
    branch.status = 'inactive';
    branch.isDeleted = true;
    branch.deletedAt = new Date();
    await branch.save();
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/super/branches/:id/restore
// @desc    Restore a soft-deleted branch within 48 hours
// @access  Super Admin
router.post('/branches/:id/restore', async (req, res, next) => {
  try {
    const branch = await Branch.findById(req.params.id);
    if (!branch) {
      return res.status(404).json({ message: 'Branch not found' });
    }
    if (!branch.isDeleted || !branch.deletedAt) {
      return res.status(400).json({ message: 'Branch is not deleted' });
    }
    const now = Date.now();
    const deletedAtMs = branch.deletedAt.getTime();
    const diffHours = (now - deletedAtMs) / (1000 * 60 * 60);
    if (diffHours > 48) {
      return res
        .status(400)
        .json({ message: 'Restore window (48 hours) has expired for this branch' });
    }
    branch.isDeleted = false;
    branch.deletedAt = null;
    branch.status = 'active';
    await branch.save();
    res.json({
      id: branch._id.toString(),
      name: branch.name,
      code: branch.code || '',
      address: branch.address || '',
      contactPhone: branch.contactPhone || '',
      contactEmail: branch.contactEmail || '',
      status: branch.status || 'active',
      sortOrder: branch.sortOrder ?? 0,
      restaurantId: branch.restaurant?.toString() || null,
    });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/super/branches/:id/permanent
// @desc    Permanently delete a branch (cannot be undone)
// @access  Super Admin
router.delete('/branches/:id/permanent', async (req, res, next) => {
  try {
    const branch = await Branch.findById(req.params.id);
    if (!branch) {
      return res.status(404).json({ message: 'Branch not found' });
    }
    await Branch.deleteOne({ _id: branch._id });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/super/branches
// @desc    List all non-deleted branches of all restaurants (super_admin only)
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

// @route   GET /api/super/branches/deleted
// @desc    List soft-deleted branches from the last 48 hours across all restaurants
// @access  Super Admin
router.get('/branches/deleted', async (req, res, next) => {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const branches = await Branch.find({
      isDeleted: true,
      deletedAt: { $gte: cutoff },
    })
      .populate('restaurant', 'website.subdomain website.name')
      .sort({ deletedAt: -1 })
      .lean();

    const list = branches.map((b) => ({
      id: b._id.toString(),
      name: b.name,
      code: b.code || '',
      address: b.address || '',
      contactPhone: b.contactPhone || '',
      contactEmail: b.contactEmail || '',
      status: b.status || 'inactive',
      sortOrder: b.sortOrder ?? 0,
      restaurantId: b.restaurant?._id?.toString(),
      restaurantName: b.restaurant?.website?.name || '—',
      subdomain: b.restaurant?.website?.subdomain || '—',
      deletedAt: b.deletedAt || null,
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
    const { plan, status, trialEndsAt, expiresAt, durationMonths } = req.body;

    const restaurant = await Restaurant.findById(id);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    if (!restaurant.subscription) {
      restaurant.subscription = {};
    }

    if (plan) restaurant.subscription.plan = plan;

    const now = new Date();

    if (status === 'TRIAL') {
      // Standardize trial to 3 months from now
      const trialStart = now;
      const trialEnd = new Date(trialStart);
      trialEnd.setMonth(trialEnd.getMonth() + 3);

      restaurant.subscription.status = 'TRIAL';
      restaurant.subscription.trialStartsAt = trialStart;
      restaurant.subscription.trialEndsAt = trialEnd;
      restaurant.subscription.freeTrialStartDate = trialStart;
      restaurant.subscription.freeTrialEndDate = trialEnd;
      // Clear paid subscription dates when resetting to trial
      restaurant.subscription.subscriptionStartDate = undefined;
      restaurant.subscription.subscriptionEndDate = undefined;
      restaurant.subscription.expiresAt = trialEnd;
      restaurant.readonly = false;
    } else if (status === 'ACTIVE') {
      // Activate for a fixed duration in months (1,3,6,12)
      let months = Number(durationMonths) || 1;
      if (![1, 3, 6, 12].includes(months)) months = 1;
      const start = now;
      const end = new Date(start);
      end.setMonth(end.getMonth() + months);

      restaurant.subscription.status = 'ACTIVE';
      restaurant.subscription.subscriptionStartDate = start;
      restaurant.subscription.subscriptionEndDate = end;
      restaurant.subscription.expiresAt = end;
      restaurant.readonly = false;
    } else {
      if (status) restaurant.subscription.status = status;
      if (trialEndsAt !== undefined) {
        restaurant.subscription.trialEndsAt = trialEndsAt ? new Date(trialEndsAt) : undefined;
      }
      if (expiresAt !== undefined) {
        restaurant.subscription.expiresAt = expiresAt ? new Date(expiresAt) : undefined;
      }
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

// @route   GET /api/super/users
// @desc    List all users for super admin
// @access  Super Admin
router.get('/users', async (req, res, next) => {
  try {
    const users = await User.find({}).sort({ createdAt: -1 }).lean();

    res.json(
      users.map((u) => ({
        id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        restaurantId: u.restaurant || null,
        createdAt: u.createdAt,
      }))
    );
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/super/users
// @desc    Create a new user (including additional super_admins)
// @access  Super Admin
router.post('/users', async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {};

    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: 'Name, email, password and role are required' });
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(400).json({ message: 'A user with this email already exists' });
    }

    const allowedRoles = [
      'super_admin',
      'restaurant_admin',
      'staff',
      'admin',
      'product_manager',
      'cashier',
      'manager',
      'kitchen_staff',
      'order_taker',
    ];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    const user = await User.create({
      name,
      email: email.toLowerCase().trim(),
      password,
      role,
      emailVerified: true,
    });

    res.status(201).json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/super/users/:id
// @desc    Permanently delete a user (cannot be undone)
// @access  Super Admin
router.delete('/users/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    await User.deleteOne({ _id: user._id });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/super/leads
// @desc    List all contact/lead submissions
// @access  Super Admin
router.get('/leads', async (req, res, next) => {
  try {
    const leads = await Lead.find({}).sort({ createdAt: -1 }).lean();
    res.json({
      leads: leads.map((l) => ({
        id: l._id,
        name: l.name,
        phone: l.phone,
        email: l.email,
        message: l.message,
        createdAt: l.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

