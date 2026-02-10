/**
 * One-time script: set a user's role to super_admin by email.
 * Run from backend root: node scripts/fix-super-admin-role.js
 * Optional env: FIX_SUPER_ADMIN_EMAIL (default: superadmin@restaurantos.local)
 */
require('dotenv').config();
const connectDB = require('../config/db');
const User = require('../models/User');

const email = process.env.FIX_SUPER_ADMIN_EMAIL || 'superadmin@restaurantos.local';

async function main() {
  await connectDB(process.env.MONGO_URI);
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }
  if (user.role === 'super_admin') {
    console.log(`User ${email} is already super_admin.`);
    process.exit(0);
  }
  user.role = 'super_admin';
  await user.save();
  console.log(`Updated ${email} to role: super_admin`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
