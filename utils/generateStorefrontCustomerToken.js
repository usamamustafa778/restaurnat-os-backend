const jwt = require('jsonwebtoken');

/**
 * JWT for website customers (storefront). Distinct from staff tokens via sfCustomer flag.
 */
function generateStorefrontCustomerToken({ customerId, restaurantId, slug }) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined');
  }
  return jwt.sign(
    {
      sfCustomer: true,
      scid: customerId.toString(),
      rid: restaurantId.toString(),
      slug: String(slug || '').toLowerCase().trim(),
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.STOREFRONT_JWT_EXPIRES_IN || '30d' }
  );
}

module.exports = generateStorefrontCustomerToken;
