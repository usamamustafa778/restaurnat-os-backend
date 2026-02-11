const jwt = require('jsonwebtoken');

const generateToken = (user, tenantSlug) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined');
  }

  const payload = {
    id: user._id.toString(),
    role: user.role,
    restaurant: user.restaurant ? user.restaurant.toString() : null,
  };

  if (tenantSlug) {
    payload.tenantSlug = tenantSlug;
  }

  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
};

module.exports = generateToken;

