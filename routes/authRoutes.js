const express = require('express');
const User = require('../models/User');
const Restaurant = require('../models/Restaurant');
const Branch = require('../models/Branch');
const UserBranch = require('../models/UserBranch');
const generateToken = require('../utils/generateToken');
const generateRefreshToken = require('../utils/generateRefreshToken');
const { getBranchContext } = require('../middleware/authMiddleware');
const { sendEmail, sendOtpEmail } = require('../utils/email');
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

    // Generate email verification OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.emailVerificationOtp = otp;
    user.emailVerificationOtpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    user.emailVerified = false;
    await user.save();

    // Send verification email (best-effort), using same OTP logic as svift-backend
    const { sent, error: emailError } = await sendOtpEmail(user.email, otp, 'Signup');
    if (!sent) {
      console.warn('Verification email (register) not sent:', emailError || 'unknown error');
    }

    res.status(201).json({
      message: 'User registered. Verification code sent to email.',
      pendingVerification: true,
      user: {
        id: user._id,
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

    if (!user.emailVerified) {
      // Re-send verification OTP on login attempt
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      user.emailVerificationOtp = otp;
      user.emailVerificationOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
      await user.save();

      const { sent, error: emailError } = await sendOtpEmail(user.email, otp, 'Login');
      if (!sent) {
        console.warn('Verification email (login) not sent:', emailError || 'unknown error');
      }

      return res
        .status(403)
        .json({ message: 'EMAIL_NOT_VERIFIED', pendingVerification: true });
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

    // Create the restaurant with a 3-month free trial
    const freeTrialStartDate = new Date();
    const freeTrialEndDate = new Date(freeTrialStartDate);
    freeTrialEndDate.setMonth(freeTrialEndDate.getMonth() + 3);

    const restaurant = await Restaurant.create({
      website: {
        subdomain,
        name: restaurantName,
        contactPhone: phone || '',
        contactEmail: email.toLowerCase().trim(),
        isPublic: true, // Website public by default
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

    // Generate email verification OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    adminUser.emailVerificationOtp = otp;
    adminUser.emailVerificationOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
    adminUser.emailVerified = false;
    await adminUser.save();

    try {
      await sendEmail({
        to: adminUser.email,
        subject: 'Verify your Eats Desk account',
        text: `Your verification code is ${otp}. It will expire in 10 minutes.`,
      });
    } catch (e) {
      console.error('Failed to send verification email for restaurant signup:', e.message);
    }

    res.status(201).json({
      message: 'Restaurant registered. Verification code sent to owner email.',
      pendingVerification: true,
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

// @route   POST /api/auth/verify-email
// @desc    Verify email with OTP and return tokens
// @access  Public
router.post('/verify-email', async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and code are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or code' });
    }

    if (
      !user.emailVerificationOtp ||
      !user.emailVerificationOtpExpires ||
      user.emailVerificationOtp !== otp ||
      user.emailVerificationOtpExpires < new Date()
    ) {
      return res.status(400).json({ message: 'Invalid or expired verification code' });
    }

    user.emailVerified = true;
    user.emailVerificationOtp = undefined;
    user.emailVerificationOtpExpires = undefined;
    await user.save();

    // Issue tokens like login
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
        user.restaurant,
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

// @route   POST /api/auth/request-password-reset
// @desc    Send OTP to email for password reset
// @access  Public
router.post('/request-password-reset', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Do not leak that email does not exist
      return res.json({ message: 'If this email is registered, a reset code has been sent.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetPasswordOtp = otp;
    user.resetPasswordOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    const { sent, error: emailError } = await sendOtpEmail(user.email, otp, 'Password reset');
    if (!sent) {
      console.warn('Password reset email not sent:', emailError || 'unknown error');
      console.log(`Fallback password reset OTP for ${user.email}:`, otp);
    }

    res.json({ message: 'If this email is registered, a reset code has been sent.' });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/auth/reset-password
// @desc    Reset password using email + OTP
// @access  Public
router.post('/reset-password', async (req, res, next) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: 'Email, code, and new password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (
      !user ||
      !user.resetPasswordOtp ||
      !user.resetPasswordOtpExpires ||
      user.resetPasswordOtp !== otp ||
      user.resetPasswordOtpExpires < new Date()
    ) {
      return res.status(400).json({ message: 'Invalid or expired reset code' });
    }

    user.password = newPassword;
    user.resetPasswordOtp = undefined;
    user.resetPasswordOtpExpires = undefined;
    await user.save();

    res.json({ message: 'Password reset successful. You can now log in with your new password.' });
  } catch (error) {
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


