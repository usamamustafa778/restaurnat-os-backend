const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Not authorized, token missing' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ message: 'Not authorized, user not found' });
    }

    req.user = {
      id: user._id.toString(),
      role: user.role,
      restaurant: user.restaurant ? user.restaurant.toString() : null,
    };

    next();
  } catch (error) {
    console.error('Auth error', error);
    return res.status(401).json({ message: 'Not authorized, token invalid' });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'Forbidden: insufficient role' });
  }
  next();
};

const requireRestaurant = async (req, res, next) => {
  try {
    if (!req.user?.restaurant) {
      return res.status(400).json({ message: 'User is not linked to any restaurant' });
    }

    const restaurant = await Restaurant.findById(req.user.restaurant);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    // Prevent cross-tenant access: verify x-tenant-slug matches the user's restaurant
    const tenantSlug = req.headers['x-tenant-slug'];
    if (tenantSlug && restaurant.website?.subdomain && tenantSlug !== restaurant.website.subdomain) {
      return res.status(403).json({ message: 'Access denied: you do not have permission to access this restaurant' });
    }

    req.restaurant = restaurant;
    next();
  } catch (error) {
    next(error);
  }
};

const isSubscriptionActive = (restaurant) => {
  if (!restaurant.subscription) return false;
  const sub = restaurant.subscription;
  const now = new Date();

  // Explicitly suspended → always inactive
  if (sub.status === 'SUSPENDED') return false;

  // Check trial dates (new field + legacy field)
  const trialEnd = sub.freeTrialEndDate || sub.trialEndsAt;
  if (trialEnd && now <= new Date(trialEnd)) return true;

  // Check subscription dates (new field + legacy field)
  const subEnd = sub.subscriptionEndDate || sub.expiresAt;
  if (subEnd && now <= new Date(subEnd)) return true;

  return false;
};

const requireActiveSubscription = (req, res, next) => {
  // Super admin bypasses subscription checks
  if (req.user?.role === 'super_admin') {
    return next();
  }

  if (!req.restaurant) {
    return res.status(500).json({ message: 'Restaurant context missing for subscription check' });
  }

  if (!isSubscriptionActive(req.restaurant)) {
    return res.status(402).json({ message: 'Subscription inactive or expired' });
  }

  next();
};

/**
 * checkSubscriptionStatus – replaces hard-block with read-only mode.
 *
 * Logic:
 *  - super_admin → always pass
 *  - Free trial active OR subscription active → full access
 *  - Otherwise → set restaurant.readonly = true in DB,
 *    allow GET (read), block POST/PUT/DELETE (write) with 402
 */
const checkSubscriptionStatus = async (req, res, next) => {
  // Super admin bypasses everything
  if (req.user?.role === 'super_admin') {
    return next();
  }

  if (!req.restaurant) {
    return res.status(500).json({ message: 'Restaurant context missing for subscription check' });
  }

  const active = isSubscriptionActive(req.restaurant);

  if (active) {
    // If restaurant was previously set to readonly, clear it
    if (req.restaurant.readonly) {
      req.restaurant.readonly = false;
      await req.restaurant.save();
    }
    return next();
  }

  // Subscription/trial expired → enforce read-only
  if (!req.restaurant.readonly) {
    req.restaurant.readonly = true;
    if (req.restaurant.subscription) {
      req.restaurant.subscription.status = 'EXPIRED';
    }
    await req.restaurant.save();
  }

  // Allow read operations (GET, HEAD, OPTIONS)
  const readMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (readMethods.includes(req.method.toUpperCase())) {
    return next();
  }

  // Block write operations
  return res.status(402).json({
    message: 'Subscription expired. Your account is in read-only mode.',
    readonly: true,
  });
};

module.exports = {
  protect,
  requireRole,
  requireRestaurant,
  requireActiveSubscription,
  checkSubscriptionStatus,
  isSubscriptionActive,
};

