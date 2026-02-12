/**
 * Optional migration: create one default branch per restaurant that has none.
 * Run with: node scripts/migrate-branches.js
 * Requires MONGO_URI in env (or .env).
 *
 * - Creates Branch { name: "Main", code: "main", restaurant } for each restaurant with 0 branches.
 * - Does NOT update existing orders (they keep branch=null; list/dashboard will show them when no branch filter).
 * - Does NOT create BranchInventory; inventory stays at restaurant level until you add branch-scoped inventory.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Branch = require('../models/Branch');
const Restaurant = require('../models/Restaurant');

const run = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI not set');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const restaurants = await Restaurant.find({});
  let created = 0;
  for (const rest of restaurants) {
    const count = await Branch.countDocuments({ restaurant: rest._id });
    if (count === 0) {
      const name = rest.website?.name ? `${rest.website.name} (Main)` : 'Main';
      await Branch.create({
        restaurant: rest._id,
        name,
        code: 'main',
        address: rest.website?.address || '',
        contactPhone: rest.website?.contactPhone || '',
        contactEmail: rest.website?.contactEmail || '',
        status: 'active',
        sortOrder: 0,
      });
      created++;
      console.log(`Created default branch for restaurant ${rest._id} (${rest.website?.subdomain || 'no subdomain'})`);
    }
  }
  console.log(`Done. Created ${created} default branch(es).`);
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
