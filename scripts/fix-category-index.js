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

    // Ensure the correct compound index exists
    const compoundIndexName = 'restaurant_1_name_1';
    const hasCompoundIndex = indexes.some(idx => idx.name === compoundIndexName);
    
    if (!hasCompoundIndex) {
      console.log('\nCreating compound index: restaurant_1_name_1...');
      await categoriesCollection.createIndex(
        { restaurant: 1, name: 1 },
        { unique: true, name: 'restaurant_1_name_1' }
      );
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
