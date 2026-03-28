const jwt = require('jsonwebtoken');
const StorefrontCustomer = require('../models/StorefrontCustomer');

async function authenticateStorefrontCustomer(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization required' });
    }
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ message: 'Server misconfiguration' });
    }
    let decoded;
    try {
      decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    if (!decoded.sfCustomer || !decoded.scid || !decoded.rid) {
      return res.status(401).json({ message: 'Invalid token type' });
    }
    const slug = String(req.params.slug || '')
      .toLowerCase()
      .trim();
    if (decoded.slug && slug && decoded.slug !== slug) {
      return res.status(403).json({ message: 'Token does not match this restaurant' });
    }
    const customer = await StorefrontCustomer.findOne({
      _id: decoded.scid,
      restaurant: decoded.rid,
      verified: true,
    });
    if (!customer) {
      return res.status(401).json({ message: 'Account not found' });
    }
    req.storefrontCustomer = customer;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * If a valid storefront Bearer token is present, sets req.storefrontCustomer; otherwise continues.
 */
async function optionalStorefrontCustomer(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ') || !process.env.JWT_SECRET) {
      return next();
    }
    let decoded;
    try {
      decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    } catch {
      return next();
    }
    if (!decoded.sfCustomer || !decoded.scid || !decoded.rid) {
      return next();
    }
    const slug = String(req.params.slug || '')
      .toLowerCase()
      .trim();
    if (decoded.slug && slug && decoded.slug !== slug) {
      return next();
    }
    const customer = await StorefrontCustomer.findOne({
      _id: decoded.scid,
      restaurant: decoded.rid,
      verified: true,
    });
    if (customer) req.storefrontCustomer = customer;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authenticateStorefrontCustomer, optionalStorefrontCustomer };
