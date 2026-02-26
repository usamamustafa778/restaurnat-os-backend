/**
 * One-time migration: update order status values to new enum.
 * Run with: node scripts/migrate-order-statuses.js
 * Requires MONGO_URI in env (or .env).
 *
 * Maps: UNPROCESSED -> NEW_ORDER, PENDING -> PROCESSING, COMPLETED -> DELIVERED.
 * READY and CANCELLED are unchanged.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');

const MAP = { UNPROCESSED: 'NEW_ORDER', PENDING: 'PROCESSING', COMPLETED: 'DELIVERED' };

const run = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI not set');
    process.exit(1);
  }
  await mongoose.connect(uri);
  for (const [oldStatus, newStatus] of Object.entries(MAP)) {
    const result = await Order.updateMany({ status: oldStatus }, { $set: { status: newStatus } });
    if (result.modifiedCount > 0) {
      console.log(`Updated ${result.modifiedCount} orders: ${oldStatus} -> ${newStatus}`);
    }
  }
  console.log('Migration done.');
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
