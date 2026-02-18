const express = require('express');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const Branch = require('../models/Branch');
const UserBranch = require('../models/UserBranch');
const generateToken = require('../utils/generateToken');
const generateRefreshToken = require('../utils/generateRefreshToken');
const { getBranchContext } = require('../middleware/authMiddleware');
const jwt = require('jsonwebtoken');

const router = express.Router();

// @route   POST /api/auth/register
// @desc    Register a new user (primarily for development; production should use super admin flows)
// @access  Public
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, role, restaurantId } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please provide name, email and password' });
    }

    const userExists = await User.findOne({ email: email.toLowerCase().trim() });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    let restaurant = null;
    if (restaurantId) {
      restaurant = await Restaurant.findById(restaurantId);
      if (!restaurant) {
        return res.status(400).json({ message: 'Invalid restaurantId' });
      }
    }

    const user = await User.create({
      name,
      email: email.toLowerCase().trim(),
      password,
      role: role || 'staff',
      restaurant: restaurant ? restaurant._id : undefined,
    });

    let defaultBranchId = null;
    let allowedBranchIds = [];
    if (user.restaurant) {
      const branchCtx = await getBranchContext(
        { id: user._id.toString(), role: user.role },
        user.restaurant
      );
      defaultBranchId = branchCtx.defaultBranchId;
      allowedBranchIds = branchCtx.allowedBranchIds;
    }

    const token = generateToken(user, restaurant?.website?.subdomain || null);
    const refreshToken = generateRefreshToken(user);

    res.status(201).json({
      token,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        restaurant: user.restaurant,
        defaultBranchId,
        allowedBranchIds,
      },
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/auth/login
// @desc    Login user and return JWT
// @access  Public
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide email and password' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ message: 'Email not found. Please sign up first.' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Resolve restaurant to expose tenant slug (subdomain) for dashboard routing
    let restaurantSlug = null;
    let defaultBranchId = null;
    let allowedBranchIds = [];
    if (user.restaurant) {
      const restaurant = await Restaurant.findById(user.restaurant);
      if (restaurant?.website?.subdomain) {
        restaurantSlug = restaurant.website.subdomain;
      }
      const branchCtx = await getBranchContext(
        { id: user._id.toString(), role: user.role },
        user.restaurant
      );
      defaultBranchId = branchCtx.defaultBranchId;
      allowedBranchIds = branchCtx.allowedBranchIds;
    }

    const token = generateToken(user, restaurantSlug);

    const refreshToken = generateRefreshToken(user);

    res.json({
      token,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        restaurant: user.restaurant,
        restaurantSlug,
        defaultBranchId,
        allowedBranchIds,
      },
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/auth/register-restaurant
// @desc    Public restaurant owner signup - creates restaurant + admin user
// @access  Public
router.post('/register-restaurant', async (req, res, next) => {
  try {
    const {
      restaurantName,
      ownerName,
      email,
      password,
      phone,
      branches, // [{ name, address? }] — at least one required
    } = req.body;

    // Validate required fields
    if (!restaurantName || !ownerName || !email || !password) {
      return res.status(400).json({ 
        message: 'Please provide restaurant name, owner name, email, and password' 
      });
    }

    if (!Array.isArray(branches) || branches.length === 0 || !branches[0]?.name?.trim()) {
      return res.status(400).json({
        message: 'Please provide at least one branch with a name (e.g. [{ name: "Downtown", address: "..." }])',
      });
    }

    // Auto-generate unique subdomain from restaurant name
    const slugify = (v) => v.toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50);
    let baseSlug = slugify(restaurantName);
    if (!baseSlug) baseSlug = 'restaurant';
    let subdomain = baseSlug;
    let slugCounter = 2;
    while (await Restaurant.findOne({ 'website.subdomain': subdomain })) {
      subdomain = `${baseSlug}-${slugCounter++}`;
    }

    // Check if email is already registered
    const userExists = await User.findOne({ email: email.toLowerCase().trim() });
    if (userExists) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    // Create the restaurant with 15-day free trial
    const trialDays = 15;
    const freeTrialStartDate = new Date();
    const freeTrialEndDate = new Date(freeTrialStartDate);
    freeTrialEndDate.setDate(freeTrialEndDate.getDate() + trialDays);

    const restaurant = await Restaurant.create({
      website: {
        subdomain,
        name: restaurantName,
        contactPhone: phone || '',
        contactEmail: email.toLowerCase().trim(),
        isPublic: false, // Owner can enable later
      },
      subscription: {
        plan: 'ESSENTIAL',
        status: 'TRIAL',
        trialStartsAt: freeTrialStartDate,
        trialEndsAt: freeTrialEndDate,
        freeTrialStartDate,
        freeTrialEndDate,
      },
      readonly: false,
    });

    // Create all branches for this restaurant
    const usedCodes = new Set();
    const branchDocs = branches.map((b, idx) => {
      let code = slugify(b.name) || 'branch';
      // Ensure unique codes within this batch
      let candidate = code;
      let counter = 2;
      while (usedCodes.has(candidate)) {
        candidate = `${code}-${counter++}`;
      }
      usedCodes.add(candidate);
      return {
        restaurant: restaurant._id,
        name: b.name.trim(),
        code: candidate,
        address: (b.address || '').trim(),
        contactPhone: (b.contactPhone || phone || '').trim(),
        contactEmail: (b.contactEmail || email.toLowerCase().trim()),
        status: 'active',
        sortOrder: idx,
      };
    });
    const createdBranches = await Branch.insertMany(branchDocs);

    // Create the restaurant owner user (maps to restaurant_admin role in current RBAC)
    const adminUser = await User.create({
      name: ownerName,
      email: email.toLowerCase().trim(),
      password,
      role: 'restaurant_admin',
      restaurant: restaurant._id,
    });

    const branchCtx = await getBranchContext(
      { id: adminUser._id.toString(), role: adminUser.role },
      restaurant._id
    );

    // Generate token for immediate login
    const token = generateToken(adminUser, restaurant.website.subdomain);
    const refreshToken = generateRefreshToken(adminUser);

    res.status(201).json({
      token,
      refreshToken,
      user: {
        id: adminUser._id,
        name: adminUser.name,
        email: adminUser.email,
        role: adminUser.role,
        restaurant: adminUser.restaurant,
        defaultBranchId: branchCtx.defaultBranchId,
        allowedBranchIds: branchCtx.allowedBranchIds,
      },
      restaurant: {
        id: restaurant._id,
        name: restaurant.website.name,
        subdomain: restaurant.website.subdomain,
        trialStart: restaurant.subscription.freeTrialStartDate,
        trialEnd: restaurant.subscription.freeTrialEndDate,
      },
      branches: createdBranches.map((b) => ({
        id: b._id,
        name: b.name,
        code: b.code,
        address: b.address || '',
      })),
    });
  } catch (error) {
    // Handle rare race condition on unique slug index
    if (error && error.code === 11000 && error.keyValue && error.keyValue['website.subdomain']) {
      return res.status(400).json({ message: 'Subdomain already taken' });
    }
    next(error);
  }
});

// @route   POST /api/auth/refresh
// @desc    Refresh access token using refresh token
// @access  Public (token-based)
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required' });
    }

    const secret = process.env.REFRESH_JWT_SECRET || process.env.JWT_SECRET;
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, secret);
    } catch (err) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    if (decoded.type !== 'refresh') {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ message: 'User not found for refresh token' });
    }

    let tenantSlug = null;
    let defaultBranchId = null;
    let allowedBranchIds = [];
    if (user.restaurant) {
      const rest = await Restaurant.findById(user.restaurant);
      if (rest?.website?.subdomain) tenantSlug = rest.website.subdomain;
      const branchCtx = await getBranchContext(
        { id: user._id.toString(), role: user.role },
        user.restaurant
      );
      defaultBranchId = branchCtx.defaultBranchId;
      allowedBranchIds = branchCtx.allowedBranchIds;
    }

    const newAccessToken = generateToken(user, tenantSlug);
    const newRefreshToken = generateRefreshToken(user);

    res.json({
      token: newAccessToken,
      refreshToken: newRefreshToken,
      user: user.restaurant
        ? {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            restaurant: user.restaurant,
            restaurantSlug: tenantSlug,
            defaultBranchId,
            allowedBranchIds,
          }
        : undefined,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;


