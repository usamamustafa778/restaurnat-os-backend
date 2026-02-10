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

    req.restaurant = restaurant;
    next();
  } catch (error) {
    next(error);
  }
};

const isSubscriptionActive = (restaurant) => {
  if (!restaurant.subscription) return false;
  const { status, trialEndsAt, expiresAt } = restaurant.subscription;

  if (status === 'SUSPENDED') return false;

  const now = new Date();

  if (status === 'TRIAL') {
    if (!trialEndsAt) return true;
    return trialEndsAt >= now;
  }

  if (status === 'ACTIVE') {
    if (!expiresAt) return true;
    return expiresAt >= now;
  }

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

module.exports = {
  protect,
  requireRole,
  requireRestaurant,
  requireActiveSubscription,
};

