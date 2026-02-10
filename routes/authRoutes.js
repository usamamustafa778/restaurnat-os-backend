const express = require('express');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const generateToken = require('../utils/generateToken');
const generateRefreshToken = require('../utils/generateRefreshToken');
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

    const token = generateToken(user);
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
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Resolve restaurant to expose tenant slug (subdomain) for dashboard routing
    let restaurantSlug = null;
    if (user.restaurant) {
      const restaurant = await Restaurant.findById(user.restaurant);
      if (restaurant?.website?.subdomain) {
        restaurantSlug = restaurant.website.subdomain;
      }
    }

    const token = generateToken(user);

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
      subdomain,
      ownerName,
      email,
      password,
      phone,
    } = req.body;

    // Validate required fields
    if (!restaurantName || !subdomain || !ownerName || !email || !password) {
      return res.status(400).json({ 
        message: 'Please provide restaurant name, subdomain, owner name, email, and password' 
      });
    }

    // Check if subdomain is already taken
    const existingSubdomain = await Restaurant.findOne({ 
      'website.subdomain': subdomain.toLowerCase().trim() 
    });
    if (existingSubdomain) {
      return res.status(400).json({ message: 'Subdomain already taken' });
    }

    // Check if email is already registered
    const userExists = await User.findOne({ email: email.toLowerCase().trim() });
    if (userExists) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    // Create the restaurant with trial subscription
    const trialDays = 14;
    const trialStartsAt = new Date();
    const trialEndsAt = new Date(trialStartsAt);
    trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

    const restaurant = await Restaurant.create({
      website: {
        subdomain: subdomain.toLowerCase().trim(),
        name: restaurantName,
        contactPhone: phone || '',
        contactEmail: email.toLowerCase().trim(),
        isPublic: false, // Owner can enable later
      },
      subscription: {
        plan: 'ESSENTIAL',
        status: 'TRIAL',
        trialStartsAt,
        trialEndsAt,
      },
    });

    // Create the restaurant owner user (maps to restaurant_admin role in current RBAC)
    const adminUser = await User.create({
      name: ownerName,
      email: email.toLowerCase().trim(),
      password,
      role: 'restaurant_admin',
      restaurant: restaurant._id,
    });

    // Generate token for immediate login
    const token = generateToken(adminUser);
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
      },
      restaurant: {
        id: restaurant._id,
        name: restaurant.website.name,
        subdomain: restaurant.website.subdomain,
        trialStart: restaurant.subscription.trialStartsAt || trialStartsAt,
        trialEnd: restaurant.subscription.trialEndsAt || trialEndsAt,
      },
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

    const newAccessToken = generateToken(user);
    const newRefreshToken = generateRefreshToken(user);

    res.json({
      token: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;


