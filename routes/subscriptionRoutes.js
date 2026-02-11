const express = require('express');
const Restaurant = require('../models/Restaurant');
const SubscriptionRequest = require('../models/SubscriptionRequest');
const PaymentMethod = require('../models/PaymentMethod');
const { protect, requireRole, requireRestaurant } = require('../middleware/authMiddleware');

const router = express.Router();

// All routes require authentication
router.use(protect);

// ─────────────────────────────────────────────────────────
// RESTAURANT ADMIN ROUTES
// ─────────────────────────────────────────────────────────

// @route   GET /api/subscription/status
// @desc    Get current subscription status for the logged-in restaurant
// @access  restaurant_admin, admin, staff etc.
router.get(
  '/status',
  requireRole('restaurant_admin', 'admin', 'staff', 'manager', 'cashier', 'product_manager', 'kitchen_staff'),
  requireRestaurant,
  async (req, res, next) => {
    try {
      const restaurant = req.restaurant;
      const sub = restaurant.subscription || {};
      const now = new Date();

      // Merge new + legacy date fields so it works for both old and new restaurants
      const trialEnd = sub.freeTrialEndDate || sub.trialEndsAt;
      const subEnd = sub.subscriptionEndDate || sub.expiresAt;

      let currentStatus = 'expired';

      if (trialEnd && now <= new Date(trialEnd)) {
        currentStatus = 'trial_active';
      } else if (subEnd && now <= new Date(subEnd)) {
        currentStatus = 'active';
      }

      res.json({
        currentStatus,
        readonly: restaurant.readonly || false,
        freeTrialStartDate: sub.freeTrialStartDate || sub.trialStartsAt || null,
        freeTrialEndDate: sub.freeTrialEndDate || sub.trialEndsAt || null,
        subscriptionStartDate: sub.subscriptionStartDate || null,
        subscriptionEndDate: sub.subscriptionEndDate || sub.expiresAt || null,
        plan: sub.plan || 'ESSENTIAL',
      });
    } catch (error) {
      next(error);
    }
  }
);

// Plan duration mapping
const PLAN_DURATIONS = {
  '1_month': 30,
  '3_month': 90,
  '6_month': 180,
};

// @route   POST /api/subscription/request
// @desc    Submit a new subscription request with payment screenshot
// @access  restaurant_admin
router.post(
  '/request',
  requireRole('restaurant_admin', 'admin'),
  requireRestaurant,
  async (req, res, next) => {
    try {
      const { planType, paymentScreenshot } = req.body;

      if (!planType || !PLAN_DURATIONS[planType]) {
        return res.status(400).json({ message: 'Invalid plan type. Choose 1_month, 3_month, or 6_month.' });
      }

      if (!paymentScreenshot) {
        return res.status(400).json({ message: 'Payment screenshot is required.' });
      }

      // Check if there's already a pending request
      const existingPending = await SubscriptionRequest.findOne({
        restaurant: req.restaurant._id,
        status: 'pending',
      });

      if (existingPending) {
        return res.status(400).json({
          message: 'You already have a pending subscription request. Please wait for approval.',
        });
      }

      // Validate payment method if provided
      const { paymentMethodId } = req.body;
      let paymentMethodName = null;
      if (paymentMethodId) {
        const pm = await PaymentMethod.findById(paymentMethodId);
        if (!pm || !pm.isActive) {
          return res.status(400).json({ message: 'Invalid or inactive payment method.' });
        }
        paymentMethodName = pm.name;
      }

      const request = await SubscriptionRequest.create({
        restaurant: req.restaurant._id,
        planType,
        durationInDays: PLAN_DURATIONS[planType],
        paymentScreenshot,
        paymentMethod: paymentMethodId || undefined,
        paymentMethodName: paymentMethodName || undefined,
        status: 'pending',
      });

      res.status(201).json({
        message: 'Payment submitted successfully. It is under review (24–48 hours). Please contact platform support if urgent.',
        request: {
          id: request._id,
          planType: request.planType,
          durationInDays: request.durationInDays,
          status: request.status,
          createdAt: request.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// @route   PUT /api/subscription/request/:id/screenshot
// @desc    Update payment screenshot on a pending request
// @access  restaurant_admin
router.put(
  '/request/:id/screenshot',
  requireRole('restaurant_admin', 'admin'),
  requireRestaurant,
  async (req, res, next) => {
    try {
      const request = await SubscriptionRequest.findById(req.params.id);
      if (!request) {
        return res.status(404).json({ message: 'Subscription request not found.' });
      }

      // Must belong to this restaurant
      if (request.restaurant.toString() !== req.restaurant._id.toString()) {
        return res.status(403).json({ message: 'Access denied.' });
      }

      // Only allow updating while still pending
      if (request.status !== 'pending') {
        return res.status(400).json({ message: 'Cannot update screenshot. Request is already ' + request.status + '.' });
      }

      const { paymentScreenshot } = req.body;
      if (!paymentScreenshot) {
        return res.status(400).json({ message: 'Payment screenshot is required.' });
      }

      request.paymentScreenshot = paymentScreenshot;
      await request.save();

      res.json({
        message: 'Payment screenshot updated successfully.',
        request: {
          id: request._id,
          paymentScreenshot: request.paymentScreenshot,
          status: request.status,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// @route   GET /api/subscription/history
// @desc    Get subscription request history for the logged-in restaurant
// @access  restaurant_admin
router.get(
  '/history',
  requireRole('restaurant_admin', 'admin'),
  requireRestaurant,
  async (req, res, next) => {
    try {
      const requests = await SubscriptionRequest.find({
        restaurant: req.restaurant._id,
      }).sort({ createdAt: -1 });

      const sub = req.restaurant.subscription || {};

      res.json({
        subscription: {
          freeTrialStartDate: sub.freeTrialStartDate || sub.trialStartsAt || null,
          freeTrialEndDate: sub.freeTrialEndDate || sub.trialEndsAt || null,
          subscriptionStartDate: sub.subscriptionStartDate || null,
          subscriptionEndDate: sub.subscriptionEndDate || sub.expiresAt || null,
        },
        requests: requests.map((r) => ({
          id: r._id,
          planType: r.planType,
          durationInDays: r.durationInDays,
          paymentScreenshot: r.paymentScreenshot,
          paymentMethodName: r.paymentMethodName || null,
          status: r.status,
          createdAt: r.createdAt,
          approvedAt: r.approvedAt,
          rejectedAt: r.rejectedAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─────────────────────────────────────────────────────────
// SUPER ADMIN ROUTES
// ─────────────────────────────────────────────────────────

// @route   GET /api/subscription/super/requests
// @desc    List all pending subscription requests
// @access  super_admin
router.get(
  '/super/requests',
  requireRole('super_admin'),
  async (req, res, next) => {
    try {
      const statusFilter = req.query.status || 'pending';
      const filter = statusFilter === 'all' ? {} : { status: statusFilter };

      const requests = await SubscriptionRequest.find(filter)
        .populate('restaurant', 'website.name website.subdomain subscription readonly')
        .sort({ createdAt: -1 });

      res.json(
        requests.map((r) => ({
          id: r._id,
          restaurant: {
            id: r.restaurant?._id,
            name: r.restaurant?.website?.name,
            subdomain: r.restaurant?.website?.subdomain,
          },
          planType: r.planType,
          durationInDays: r.durationInDays,
          paymentScreenshot: r.paymentScreenshot,
          paymentMethodName: r.paymentMethodName || null,
          status: r.status,
          createdAt: r.createdAt,
          approvedAt: r.approvedAt,
          rejectedAt: r.rejectedAt,
        }))
      );
    } catch (error) {
      next(error);
    }
  }
);

// @route   PUT /api/subscription/super/requests/:id/approve
// @desc    Approve a subscription request
// @access  super_admin
router.put(
  '/super/requests/:id/approve',
  requireRole('super_admin'),
  async (req, res, next) => {
    try {
      const request = await SubscriptionRequest.findById(req.params.id);
      if (!request) {
        return res.status(404).json({ message: 'Subscription request not found' });
      }

      if (request.status !== 'pending') {
        return res.status(400).json({ message: `Request is already ${request.status}` });
      }

      const restaurant = await Restaurant.findById(request.restaurant);
      if (!restaurant) {
        return res.status(404).json({ message: 'Restaurant not found' });
      }

      const now = new Date();
      const endDate = new Date(now);
      endDate.setDate(endDate.getDate() + request.durationInDays);

      // Update restaurant subscription
      if (!restaurant.subscription) {
        restaurant.subscription = {};
      }
      restaurant.subscription.subscriptionStartDate = now;
      restaurant.subscription.subscriptionEndDate = endDate;
      restaurant.subscription.status = 'ACTIVE';
      restaurant.readonly = false;
      await restaurant.save();

      // Update request
      request.status = 'approved';
      request.approvedAt = now;
      await request.save();

      res.json({
        message: 'Subscription request approved successfully.',
        request: {
          id: request._id,
          status: request.status,
          approvedAt: request.approvedAt,
        },
        restaurant: {
          id: restaurant._id,
          name: restaurant.website?.name,
          subscriptionStartDate: restaurant.subscription.subscriptionStartDate,
          subscriptionEndDate: restaurant.subscription.subscriptionEndDate,
          readonly: restaurant.readonly,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// @route   PUT /api/subscription/super/requests/:id/reject
// @desc    Reject a subscription request
// @access  super_admin
router.put(
  '/super/requests/:id/reject',
  requireRole('super_admin'),
  async (req, res, next) => {
    try {
      const request = await SubscriptionRequest.findById(req.params.id);
      if (!request) {
        return res.status(404).json({ message: 'Subscription request not found' });
      }

      if (request.status !== 'pending') {
        return res.status(400).json({ message: `Request is already ${request.status}` });
      }

      request.status = 'rejected';
      request.rejectedAt = new Date();
      await request.save();

      res.json({
        message: 'Subscription request rejected.',
        request: {
          id: request._id,
          status: request.status,
          rejectedAt: request.rejectedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// @route   GET /api/subscription/super/history
// @desc    Get subscription history for all restaurants
// @access  super_admin
router.get(
  '/super/history',
  requireRole('super_admin'),
  async (req, res, next) => {
    try {
      const restaurants = await Restaurant.find({}).sort({ createdAt: -1 });

      const result = restaurants.map((r) => {
        const sub = r.subscription || {};
        return {
          id: r._id,
          name: r.website?.name,
          subdomain: r.website?.subdomain,
          readonly: r.readonly || false,
          freeTrialStartDate: sub.freeTrialStartDate || sub.trialStartsAt || null,
          freeTrialEndDate: sub.freeTrialEndDate || sub.trialEndsAt || null,
          subscriptionStartDate: sub.subscriptionStartDate || null,
          subscriptionEndDate: sub.subscriptionEndDate || sub.expiresAt || null,
          status: sub.status,
          createdAt: r.createdAt,
        };
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ─────────────────────────────────────────────────────────
// PAYMENT METHODS (Platform-level, managed by super_admin)
// ─────────────────────────────────────────────────────────

// @route   GET /api/subscription/payment-methods
// @desc    List active payment methods (visible to restaurant admins)
// @access  Any authenticated user
router.get('/payment-methods', async (req, res, next) => {
  try {
    const methods = await PaymentMethod.find({ isActive: true }).sort({ createdAt: 1 });
    res.json(
      methods.map((m) => ({
        id: m._id,
        name: m.name,
        fields: m.fields,
      }))
    );
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/subscription/super/payment-methods
// @desc    List ALL payment methods (active + inactive)
// @access  super_admin
router.get(
  '/super/payment-methods',
  requireRole('super_admin'),
  async (req, res, next) => {
    try {
      const methods = await PaymentMethod.find({}).sort({ createdAt: -1 });
      res.json(
        methods.map((m) => ({
          id: m._id,
          name: m.name,
          fields: m.fields,
          isActive: m.isActive,
          createdAt: m.createdAt,
        }))
      );
    } catch (error) {
      next(error);
    }
  }
);

// @route   POST /api/subscription/super/payment-methods
// @desc    Create a new payment method
// @access  super_admin
router.post(
  '/super/payment-methods',
  requireRole('super_admin'),
  async (req, res, next) => {
    try {
      const { name, fields } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ message: 'Payment method name is required.' });
      }

      if (!fields || !Array.isArray(fields) || fields.length === 0) {
        return res.status(400).json({ message: 'At least one field (label + value) is required.' });
      }

      // Validate each field
      for (const f of fields) {
        if (!f.label || !f.label.trim() || !f.value || !f.value.trim()) {
          return res.status(400).json({ message: 'Each field must have a label and value.' });
        }
      }

      const method = await PaymentMethod.create({
        name: name.trim(),
        fields: fields.map((f) => ({ label: f.label.trim(), value: f.value.trim() })),
        isActive: true,
      });

      res.status(201).json({
        id: method._id,
        name: method.name,
        fields: method.fields,
        isActive: method.isActive,
        createdAt: method.createdAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

// @route   PUT /api/subscription/super/payment-methods/:id
// @desc    Update a payment method
// @access  super_admin
router.put(
  '/super/payment-methods/:id',
  requireRole('super_admin'),
  async (req, res, next) => {
    try {
      const method = await PaymentMethod.findById(req.params.id);
      if (!method) {
        return res.status(404).json({ message: 'Payment method not found.' });
      }

      const { name, fields, isActive } = req.body;

      if (name !== undefined) method.name = name.trim();
      if (typeof isActive === 'boolean') method.isActive = isActive;
      if (fields && Array.isArray(fields)) {
        method.fields = fields.map((f) => ({ label: f.label.trim(), value: f.value.trim() }));
      }

      await method.save();

      res.json({
        id: method._id,
        name: method.name,
        fields: method.fields,
        isActive: method.isActive,
        createdAt: method.createdAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

// @route   DELETE /api/subscription/super/payment-methods/:id
// @desc    Delete a payment method
// @access  super_admin
router.delete(
  '/super/payment-methods/:id',
  requireRole('super_admin'),
  async (req, res, next) => {
    try {
      const method = await PaymentMethod.findById(req.params.id);
      if (!method) {
        return res.status(404).json({ message: 'Payment method not found.' });
      }

      await method.deleteOne();
      res.json({ message: 'Payment method deleted.' });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
