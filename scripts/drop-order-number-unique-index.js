/**
 * One-time migration: drop the old global unique index on orders.orderNumber
 * so that the new compound unique index (restaurant, branch, orderNumber) can be used.
 * Run from backend root: node scripts/drop-order-number-unique-index.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

async function main() {
  await connectDB(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const coll = db.collection('orders');
  const indexes = await coll.indexes();
  const hasOld = indexes.some((idx) => idx.name === 'orderNumber_1');
  if (hasOld) {
    await coll.dropIndex('orderNumber_1');
    console.log('Dropped index orderNumber_1');
  } else {
    console.log('Index orderNumber_1 not found (already dropped or never created)');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
