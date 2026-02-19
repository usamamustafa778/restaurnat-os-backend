/**
 * Cleanup script: remove categories/items/inventory stored with branch: null
 * that were created before the branch-required enforcement was added.
 *
 * These orphaned records cause false "already exists" duplicate errors when
 * creating new records in a real branch, because old duplicate checks used
 * branch: null as the scope.
 *
 * Run: node scripts/fix-null-branch-categories.js [--dry-run]
 *
 * Add --dry-run to preview what would be deleted without actually deleting.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const isDryRun = process.argv.includes('--dry-run');

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✓ Connected to MongoDB\n');

    if (isDryRun) {
      console.log('*** DRY RUN MODE – nothing will be deleted ***\n');
    }

    const db = mongoose.connection.db;

    const collections = [
      { name: 'categories',      label: 'Categories' },
      { name: 'menuitems',       label: 'Menu Items' },
      { name: 'inventoryitems',  label: 'Inventory Items' },
    ];

    for (const { name, label } of collections) {
      const col = db.collection(name);

      // Find records with branch: null (unscoped / legacy)
      const nullBranchDocs = await col.find({ branch: null }).toArray();

      if (nullBranchDocs.length === 0) {
        console.log(`✓ ${label}: no null-branch records found`);
        continue;
      }

      console.log(`\n${label}: found ${nullBranchDocs.length} null-branch record(s):`);
      nullBranchDocs.forEach(doc => {
        console.log(`   - _id: ${doc._id}  name: "${doc.name}"  restaurant: ${doc.restaurant}`);
      });

      if (!isDryRun) {
        const result = await col.deleteMany({ branch: null });
        console.log(`   → Deleted ${result.deletedCount} null-branch ${label.toLowerCase()}`);
      } else {
        console.log(`   → [DRY RUN] Would delete ${nullBranchDocs.length} record(s)`);
      }
    }

    console.log('\n✅ Cleanup completed');
    process.exit(0);
  } catch (err) {
    console.error('Error during cleanup:', err);
    process.exit(1);
  }
}

run();
