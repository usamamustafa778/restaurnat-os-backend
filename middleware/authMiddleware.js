const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const Branch = require('../models/Branch');
const UserBranch = require('../models/UserBranch');

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

/**
 * Get allowed branch IDs and default branch for a user in a restaurant.
 * - super_admin: not used in tenant context (no restaurant).
 * - restaurant_admin: all branches of the tenant; defaultBranchId = first branch or null.
 * - Others: branches from UserBranch; defaultBranchId = first assigned branch or null.
 */
const getBranchContext = async (user, restaurantId) => {
  if (!restaurantId) return { allowedBranchIds: [], defaultBranchId: null };
  const isOwner = user.role === 'restaurant_admin' || user.role === 'super_admin' || user.role === 'admin';
  if (isOwner) {
    const branches = await Branch.find({ restaurant: restaurantId }).sort({ sortOrder: 1, createdAt: 1 }).select('_id').lean();
    const allowedBranchIds = branches.map((b) => b._id.toString());
    const defaultBranchId = allowedBranchIds[0] || null;
    return { allowedBranchIds, defaultBranchId };
  }
  const assignments = await UserBranch.find({ user: user.id })
    .populate({ path: 'branch', match: { restaurant: restaurantId } })
    .lean();
  const allowedBranchIds = assignments
    .filter((a) => a.branch)
    .map((a) => a.branch._id.toString());
  const defaultBranchId = allowedBranchIds[0] || null;
  return { allowedBranchIds, defaultBranchId };
};

/**
 * Resolve req.branch from x-branch-id header (after req.restaurant is set).
 * Sets req.user.allowedBranchIds and req.user.defaultBranchId if not already set.
 * If x-branch-id is sent, validates branch belongs to tenant and user is allowed; sets req.branch.
 * If user has single branch, req.branch is set to that branch regardless of header.
 */
const resolveBranch = async (req, res, next) => {
  try {
    if (!req.restaurant) {
      return next();
    }
    // Admins and owners can access any branch — resolve directly without allowedBranchIds check
    const isFullAccess = ['super_admin', 'restaurant_admin', 'admin'].includes(req.user.role);
    if (isFullAccess) {
      const branchId = req.headers['x-branch-id'];
      if (branchId) {
        const branch = await Branch.findOne({ _id: branchId, restaurant: req.restaurant._id });
        if (branch) req.branch = branch;
      }
      return next();
    }
    if (!req.user.allowedBranchIds) {
      const ctx = await getBranchContext(req.user, req.restaurant._id);
      req.user.allowedBranchIds = ctx.allowedBranchIds;
      req.user.defaultBranchId = ctx.defaultBranchId;
    }
    const headerBranchId = req.headers['x-branch-id'];
    if (headerBranchId) {
      if (!req.user.allowedBranchIds.includes(headerBranchId)) {
        // Invalid branch for this user – ignore for GET, block for write ops
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) {
          // Just skip setting req.branch; let the route see all branches
          return next();
        }
        return res.status(403).json({ message: 'Access denied: you do not have access to this branch' });
      }
      const branch = await Branch.findOne({ _id: headerBranchId, restaurant: req.restaurant._id });
      if (!branch) {
        // Branch not found – ignore for GET, block for write ops
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) {
          return next();
        }
        return res.status(404).json({ message: 'Branch not found' });
      }
      req.branch = branch;
      return next();
    }
    if (req.user.allowedBranchIds.length === 1) {
      const branch = await Branch.findOne({ _id: req.user.allowedBranchIds[0], restaurant: req.restaurant._id });
      if (branch) req.branch = branch;
    }
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Require that req.branch is set (for branch-scoped APIs when restaurant has branches).
 * Call after resolveBranch. If restaurant has no branches, continues without req.branch.
 */
const requireBranchOptional = (req, res, next) => {
  next();
};

module.exports = {
  protect,
  requireRole,
  requireRestaurant,
  requireActiveSubscription,
  checkSubscriptionStatus,
  isSubscriptionActive,
  getBranchContext,
  resolveBranch,
  requireBranchOptional,
};

