/**
 * Drop old unique index on category.name (name_1) and ensure correct compound index exists
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function fixCategoryIndex() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✓ Connected to MongoDB');

    const db = mongoose.connection.db;
    const categoriesCollection = db.collection('categories');

    // Get all indexes
    const indexes = await categoriesCollection.indexes();
    console.log('\nCurrent indexes:');
    indexes.forEach(idx => {
      console.log(`  - ${idx.name}:`, JSON.stringify(idx.key));
    });

    // Drop the old name_1 index if it exists
    const oldIndexName = 'name_1';
    const hasOldIndex = indexes.some(idx => idx.name === oldIndexName);
    
    if (hasOldIndex) {
      console.log(`\nDropping old index: ${oldIndexName}...`);
      await categoriesCollection.dropIndex(oldIndexName);
      console.log('✓ Old index dropped');
    } else {
      console.log(`\n✓ Old index ${oldIndexName} not found (already clean)`);
    }

    let currentIndexes = await categoriesCollection.indexes();

    // Drop old compound index without branch if present (wrong scope)
    const oldCompoundName = 'restaurant_1_name_1';
    if (currentIndexes.some(idx => idx.name === oldCompoundName)) {
      console.log(`\nDropping old compound index: ${oldCompoundName}...`);
      await categoriesCollection.dropIndex(oldCompoundName);
      console.log('✓ Dropped');
      currentIndexes = await categoriesCollection.indexes();
    }

    // Ensure the correct compound index (restaurant + branch + name) exists — unique per branch
    const compoundKey = { restaurant: 1, branch: 1, name: 1 };
    const compoundIndexName = 'restaurant_1_branch_1_name_1';
    const hasCompoundIndex = currentIndexes.some(
      idx => idx.name === compoundIndexName || (idx.unique && JSON.stringify(idx.key) === JSON.stringify(compoundKey))
    );
    if (!hasCompoundIndex) {
      console.log('\nCreating compound index: restaurant_1_branch_1_name_1 (unique per branch)...');
      await categoriesCollection.createIndex(compoundKey, { unique: true, name: compoundIndexName });
      console.log('✓ Compound index created');
    } else {
      console.log('\n✓ Compound index already exists');
    }

    // Show final indexes
    const finalIndexes = await categoriesCollection.indexes();
    console.log('\nFinal indexes:');
    finalIndexes.forEach(idx => {
      console.log(`  - ${idx.name}:`, JSON.stringify(idx.key), idx.unique ? '(unique)' : '');
    });

    console.log('\n✅ Category index fix completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error fixing category index:', error);
    process.exit(1);
  }
}

fixCategoryIndex();
