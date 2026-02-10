const jwt = require('jsonwebtoken');

const generateToken = (user) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined');
  }

  return jwt.sign(
    {
      id: user._id.toString(),
      role: user.role,
      restaurant: user.restaurant ? user.restaurant.toString() : null,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '7d',
    }
  );
};

module.exports = generateToken;

