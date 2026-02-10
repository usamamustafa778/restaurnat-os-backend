const jwt = require('jsonwebtoken');

const generateRefreshToken = (user) => {
  const secret = process.env.REFRESH_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('REFRESH_JWT_SECRET or JWT_SECRET is not defined');
  }

  return jwt.sign(
    {
      id: user._id.toString(),
      role: user.role,
      restaurant: user.restaurant ? user.restaurant.toString() : null,
      type: 'refresh'
    },
    secret,
    {
      expiresIn: '30d'
    }
  );
};

module.exports = generateRefreshToken;

