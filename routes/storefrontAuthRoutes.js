const express = require('express');
const Restaurant = require('../models/Restaurant');
const StorefrontCustomer = require('../models/StorefrontCustomer');
const { sendOtpEmail } = require('../utils/email');
const { normalizeEmail, normalizePhone } = require('../utils/storefrontIdentifiers');
const generateStorefrontCustomerToken = require('../utils/generateStorefrontCustomerToken');
const { authenticateStorefrontCustomer } = require('../middleware/storefrontCustomerAuth');

const router = express.Router({ mergeParams: true });

const otpRate = new Map();
function rateAuth({ windowMs = 60000, max = 20 } = {}) {
  return (req, res, next) => {
    const key = `${req.params.slug || ''}:${req.ip}:${req.path}`;
    const now = Date.now();
    let entry = otpRate.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 1 };
      otpRate.set(key, entry);
      return next();
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ message: 'Too many requests, please try again later' });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of otpRate) {
    if (now - entry.start > 120000) otpRate.delete(key);
  }
}, 60000);

async function resolveStorefrontForAuth(slug) {
  const s = String(slug || '')
    .toLowerCase()
    .trim();
  const restaurant = await Restaurant.findOne({
    'website.subdomain': s,
    isDeleted: { $ne: true },
  });
  if (!restaurant) return { error: { status: 404, message: 'Restaurant not found' } };
  if (restaurant.subscription?.status === 'SUSPENDED') {
    return { error: { status: 403, message: 'Subscription inactive or expired' } };
  }
  if (!restaurant.website?.isPublic) {
    return { error: { status: 403, message: 'Restaurant website is not public' } };
  }
  return { restaurant };
}

function smsConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

async function sendOtpSms(phoneDigits, code) {
  if (!smsConfigured()) {
    return { sent: false, error: 'SMS_NOT_CONFIGURED' };
  }
  // Placeholder: wire Twilio here when product enables phone OTP.
  console.warn('[storefront-auth] Twilio env present but SMS send not implemented. OTP:', phoneDigits, code);
  return { sent: false, error: 'SMS_NOT_IMPLEMENTED' };
}

/**
 * Expose OTP in API JSON when email failed — helps local dev (NODE_ENV often unset).
 * In production, only if STOREFRONT_DEV_OTP_RESPONSE=1 (avoid in real prod). Use STOREFRONT_DEV_OTP_RESPONSE=0 to disable everywhere.
 */
function maybeDevOtpInResponse(sent, otp) {
  if (sent) return {};
  if (process.env.STOREFRONT_DEV_OTP_RESPONSE === '0') return {};
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && process.env.STOREFRONT_DEV_OTP_RESPONSE !== '1') return {};
  return { devOtp: otp };
}

// POST /api/storefront/:slug/auth/lookup
router.post('/lookup', rateAuth({ max: 40 }), async (req, res, next) => {
  try {
    const { method, value } = req.body || {};
    const ctx = await resolveStorefrontForAuth(req.params.slug);
    if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });
    const { restaurant } = ctx;

    if (method === 'email') {
      const email = normalizeEmail(value);
      if (!email) return res.status(400).json({ message: 'Valid email is required' });
      const doc = await StorefrontCustomer.findOne({ restaurant: restaurant._id, email });
      if (!doc) return res.json({ exists: false });
      if (!doc.verified) {
        return res.json({ exists: false, pendingVerification: true });
      }
      return res.json({ exists: true, hasPassword: !!doc.password });
    }

    if (method === 'phone') {
      const phone = normalizePhone(value);
      if (!phone) return res.status(400).json({ message: 'Valid phone number is required' });
      const doc = await StorefrontCustomer.findOne({ restaurant: restaurant._id, phone });
      if (!doc) return res.json({ exists: false });
      if (!doc.verified) {
        return res.json({ exists: false, pendingVerification: true });
      }
      return res.json({ exists: true, hasPassword: !!doc.password });
    }

    return res.status(400).json({ message: 'method must be "email" or "phone"' });
  } catch (err) {
    next(err);
  }
});

// POST /api/storefront/:slug/auth/send-signup-otp
router.post('/send-signup-otp', rateAuth({ max: 8 }), async (req, res, next) => {
  try {
    const { method, value, firstName, lastName } = req.body || {};
    const fn = String(firstName || '').trim();
    const ln = String(lastName || '').trim();
    if (!fn || !ln) {
      return res.status(400).json({ message: 'First name and last name are required' });
    }

    const ctx = await resolveStorefrontForAuth(req.params.slug);
    if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });
    const { restaurant } = ctx;

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const signupOtpExpires = new Date(Date.now() + 10 * 60 * 1000);

    if (method === 'email') {
      const email = normalizeEmail(value);
      if (!email) return res.status(400).json({ message: 'Valid email is required' });

      const taken = await StorefrontCustomer.findOne({
        restaurant: restaurant._id,
        email,
        verified: true,
      });
      if (taken) {
        return res.status(400).json({
          message: 'An account with this email already exists. Please sign in.',
          code: 'ALREADY_REGISTERED',
        });
      }

      let doc = await StorefrontCustomer.findOne({ restaurant: restaurant._id, email });
      if (!doc) {
        doc = new StorefrontCustomer({
          restaurant: restaurant._id,
          email,
          firstName: fn,
          lastName: ln,
          verified: false,
          signupOtp: otp,
          signupOtpExpires,
        });
      } else {
        doc.firstName = fn;
        doc.lastName = ln;
        doc.signupOtp = otp;
        doc.signupOtpExpires = signupOtpExpires;
        doc.verified = false;
      }
      await doc.save();

      const { sent, error } = await sendOtpEmail(email, otp, 'Sign up');
      if (!sent) {
        console.warn('[storefront-auth] signup OTP email not sent:', error, 'otp=', otp);
      }

      return res.json({
        message: sent
          ? 'Verification code sent to your email.'
          : 'Verification code could not be emailed. Set EMAIL_USER and EMAIL_PASS (and EMAIL_HOST/PORT if needed) on the API server. Check spam folder if SMTP is configured.',
        sent,
        ...(!sent && error ? { emailError: String(error) } : {}),
        ...maybeDevOtpInResponse(sent, otp),
      });
    }

    if (method === 'phone') {
      const phone = normalizePhone(value);
      if (!phone) return res.status(400).json({ message: 'Valid phone number is required' });

      const sms = await sendOtpSms(phone, otp);
      if (!sms.sent) {
        return res.status(503).json({
          message:
            'Phone verification is not available for this restaurant yet. Please sign up with email.',
          code: sms.error || 'SMS_UNAVAILABLE',
        });
      }

      const taken = await StorefrontCustomer.findOne({
        restaurant: restaurant._id,
        phone,
        verified: true,
      });
      if (taken) {
        return res.status(400).json({
          message: 'An account with this phone already exists. Please sign in.',
          code: 'ALREADY_REGISTERED',
        });
      }

      let doc = await StorefrontCustomer.findOne({ restaurant: restaurant._id, phone });
      if (!doc) {
        doc = new StorefrontCustomer({
          restaurant: restaurant._id,
          phone,
          firstName: fn,
          lastName: ln,
          verified: false,
          signupOtp: otp,
          signupOtpExpires,
        });
      } else {
        doc.firstName = fn;
        doc.lastName = ln;
        doc.signupOtp = otp;
        doc.signupOtpExpires = signupOtpExpires;
        doc.verified = false;
      }
      await doc.save();

      return res.json({ message: 'Verification code sent to your phone.', sent: true });
    }

    return res.status(400).json({ message: 'method must be "email" or "phone"' });
  } catch (err) {
    next(err);
  }
});

// POST /api/storefront/:slug/auth/verify-signup-otp
router.post('/verify-signup-otp', rateAuth({ max: 15 }), async (req, res, next) => {
  try {
    const { method, value, otp, firstName, lastName, password } = req.body || {};
    const code = String(otp || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: 'A valid 6-digit code is required' });
    }

    if (password != null && String(password).length > 0 && String(password).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const ctx = await resolveStorefrontForAuth(req.params.slug);
    if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });
    const { restaurant } = ctx;
    const slug = restaurant.website.subdomain;

    let doc;
    if (method === 'email') {
      const email = normalizeEmail(value);
      if (!email) return res.status(400).json({ message: 'Valid email is required' });
      doc = await StorefrontCustomer.findOne({ restaurant: restaurant._id, email });
    } else if (method === 'phone') {
      const phone = normalizePhone(value);
      if (!phone) return res.status(400).json({ message: 'Valid phone number is required' });
      doc = await StorefrontCustomer.findOne({ restaurant: restaurant._id, phone });
    } else {
      return res.status(400).json({ message: 'method must be "email" or "phone"' });
    }

    if (!doc) {
      return res.status(400).json({ message: 'No signup in progress for this address. Request a new code.' });
    }
    if (doc.verified) {
      return res.status(400).json({ message: 'This account is already verified. Please sign in.' });
    }
    if (!doc.signupOtp || doc.signupOtp !== code) {
      return res.status(400).json({ message: 'Invalid verification code' });
    }
    if (!doc.signupOtpExpires || doc.signupOtpExpires < new Date()) {
      return res.status(400).json({ message: 'Verification code has expired. Request a new one.' });
    }

    const fn = String(firstName || doc.firstName || '').trim();
    const ln = String(lastName || doc.lastName || '').trim();
    if (!fn || !ln) {
      return res.status(400).json({ message: 'First name and last name are required' });
    }
    doc.firstName = fn;
    doc.lastName = ln;
    doc.verified = true;
    doc.signupOtp = null;
    doc.signupOtpExpires = null;
    if (password != null && String(password).length > 0) {
      doc.password = String(password);
    }
    await doc.save();

    const token = generateStorefrontCustomerToken({
      customerId: doc._id,
      restaurantId: restaurant._id,
      slug,
    });

    res.status(201).json({
      message: 'Account created',
      token,
      customer: {
        id: doc._id.toString(),
        firstName: doc.firstName,
        lastName: doc.lastName,
        email: doc.email || '',
        phone: doc.phone || '',
        hasPassword: !!doc.password,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/storefront/:slug/auth/login
router.post('/login', rateAuth({ max: 15 }), async (req, res, next) => {
  try {
    const { method, value, password } = req.body || {};
    if (!password || String(password).length < 1) {
      return res.status(400).json({ message: 'Password is required' });
    }

    const ctx = await resolveStorefrontForAuth(req.params.slug);
    if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });
    const { restaurant } = ctx;
    const slug = restaurant.website.subdomain;

    let doc;
    if (method === 'email') {
      const email = normalizeEmail(value);
      if (!email) return res.status(400).json({ message: 'Valid email is required' });
      doc = await StorefrontCustomer.findOne({ restaurant: restaurant._id, email, verified: true });
    } else if (method === 'phone') {
      const phone = normalizePhone(value);
      if (!phone) return res.status(400).json({ message: 'Valid phone number is required' });
      doc = await StorefrontCustomer.findOne({ restaurant: restaurant._id, phone, verified: true });
    } else {
      return res.status(400).json({ message: 'method must be "email" or "phone"' });
    }

    if (!doc || !doc.password) {
      return res.status(401).json({
        message: 'Invalid email or password',
        code: doc && !doc.password ? 'NO_PASSWORD_USE_OTP' : 'INVALID_CREDENTIALS',
      });
    }

    const ok = await doc.matchPassword(String(password));
    if (!ok) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = generateStorefrontCustomerToken({
      customerId: doc._id,
      restaurantId: restaurant._id,
      slug,
    });

    res.json({
      token,
      customer: {
        id: doc._id.toString(),
        firstName: doc.firstName,
        lastName: doc.lastName,
        email: doc.email || '',
        phone: doc.phone || '',
        hasPassword: true,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/storefront/:slug/auth/send-login-otp — verified accounts without a password
router.post('/send-login-otp', rateAuth({ max: 8 }), async (req, res, next) => {
  try {
    const { method, value } = req.body || {};
    const ctx = await resolveStorefrontForAuth(req.params.slug);
    if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });
    const { restaurant } = ctx;

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const loginOtpExpires = new Date(Date.now() + 10 * 60 * 1000);

    if (method === 'email') {
      const email = normalizeEmail(value);
      if (!email) return res.status(400).json({ message: 'Valid email is required' });
      const doc = await StorefrontCustomer.findOne({
        restaurant: restaurant._id,
        email,
        verified: true,
      });
      if (!doc) {
        return res.status(404).json({ message: 'No account found for this email' });
      }
      if (doc.password) {
        return res.status(400).json({
          message: 'This account uses a password. Please sign in with your password.',
          code: 'USE_PASSWORD',
        });
      }
      doc.loginOtp = otp;
      doc.loginOtpExpires = loginOtpExpires;
      await doc.save();
      const { sent, error } = await sendOtpEmail(email, otp, 'Login');
      if (!sent) console.warn('[storefront-auth] login OTP email not sent:', error, 'otp=', otp);
      return res.json({
        message: sent
          ? 'Login code sent to your email.'
          : 'Login code could not be emailed. Set EMAIL_USER and EMAIL_PASS on the API server.',
        sent,
        ...(!sent && error ? { emailError: String(error) } : {}),
        ...maybeDevOtpInResponse(sent, otp),
      });
    }

    if (method === 'phone') {
      const phone = normalizePhone(value);
      if (!phone) return res.status(400).json({ message: 'Valid phone number is required' });
      const doc = await StorefrontCustomer.findOne({
        restaurant: restaurant._id,
        phone,
        verified: true,
      });
      if (!doc) {
        return res.status(404).json({ message: 'No account found for this phone number' });
      }
      if (doc.password) {
        return res.status(400).json({
          message: 'This account uses a password. Please sign in with your password.',
          code: 'USE_PASSWORD',
        });
      }
      const sms = await sendOtpSms(phone, otp);
      if (!sms.sent) {
        return res.status(503).json({
          message: 'Phone login codes are not available. Add email to your account or contact the restaurant.',
          code: sms.error || 'SMS_UNAVAILABLE',
        });
      }
      doc.loginOtp = otp;
      doc.loginOtpExpires = loginOtpExpires;
      await doc.save();
      return res.json({ message: 'Login code sent.', sent: true });
    }

    return res.status(400).json({ message: 'method must be "email" or "phone"' });
  } catch (err) {
    next(err);
  }
});

// POST /api/storefront/:slug/auth/verify-login-otp
router.post('/verify-login-otp', rateAuth({ max: 15 }), async (req, res, next) => {
  try {
    const { method, value, otp } = req.body || {};
    const code = String(otp || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: 'A valid 6-digit code is required' });
    }

    const ctx = await resolveStorefrontForAuth(req.params.slug);
    if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });
    const { restaurant } = ctx;
    const slug = restaurant.website.subdomain;

    let doc;
    if (method === 'email') {
      const email = normalizeEmail(value);
      if (!email) return res.status(400).json({ message: 'Valid email is required' });
      doc = await StorefrontCustomer.findOne({ restaurant: restaurant._id, email, verified: true });
    } else if (method === 'phone') {
      const phone = normalizePhone(value);
      if (!phone) return res.status(400).json({ message: 'Valid phone number is required' });
      doc = await StorefrontCustomer.findOne({ restaurant: restaurant._id, phone, verified: true });
    } else {
      return res.status(400).json({ message: 'method must be "email" or "phone"' });
    }

    if (!doc) {
      return res.status(404).json({ message: 'Account not found' });
    }
    if (!doc.loginOtp || doc.loginOtp !== code) {
      return res.status(400).json({ message: 'Invalid code' });
    }
    if (!doc.loginOtpExpires || doc.loginOtpExpires < new Date()) {
      return res.status(400).json({ message: 'Code expired' });
    }
    doc.loginOtp = null;
    doc.loginOtpExpires = null;
    await doc.save();

    const token = generateStorefrontCustomerToken({
      customerId: doc._id,
      restaurantId: restaurant._id,
      slug,
    });

    res.json({
      token,
      customer: {
        id: doc._id.toString(),
        firstName: doc.firstName,
        lastName: doc.lastName,
        email: doc.email || '',
        phone: doc.phone || '',
        hasPassword: !!doc.password,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/storefront/:slug/auth/set-password
router.post('/set-password', rateAuth({ max: 10 }), authenticateStorefrontCustomer, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
    const doc = req.storefrontCustomer;
    doc.password = String(password);
    await doc.save();
    res.json({ message: 'Password saved' });
  } catch (err) {
    next(err);
  }
});

// GET /api/storefront/:slug/auth/me
router.get('/me', rateAuth({ max: 60 }), authenticateStorefrontCustomer, async (req, res, next) => {
  try {
    const doc = req.storefrontCustomer;
    res.json({
      customer: {
        id: doc._id.toString(),
        firstName: doc.firstName,
        lastName: doc.lastName,
        email: doc.email || '',
        phone: doc.phone || '',
        hasPassword: !!doc.password,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
