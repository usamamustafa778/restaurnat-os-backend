const mongoose = require('mongoose');

const connectDB = async (mongoUri) => {
  if (!mongoUri) {
    throw new Error('MONGO_URI is not defined in environment variables');
  }

  try {
    const conn = await mongoose.connect(mongoUri, {
      // These options are defaulted in newer mongoose versions but kept for clarity
    });
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // One-time: drop old Table index (tableNumber) from previous schema so new schema (name + isAvailable) works
    const tablesCol = conn.connection.db?.collection('tables');
    if (tablesCol) {
      tablesCol.dropIndex('restaurant_1_branch_1_tableNumber_1').catch(() => {});
    }

    // Ensure category uniqueness is per (restaurant + branch + name), not per (restaurant + name) or (name) only
    const categoriesCol = conn.connection.db?.collection('categories');
    if (categoriesCol) {
      const dropIfExists = async (indexName) => {
        try {
          await categoriesCol.dropIndex(indexName);
          console.log(`Dropped old category index: ${indexName}`);
        } catch (e) {
          if (e.code !== 27 && e.codeName !== 'IndexNotFound') throw e;
        }
      };
      await dropIfExists('name_1');
      await dropIfExists('restaurant_1_name_1');
      const compoundKey = { restaurant: 1, branch: 1, name: 1 };
      const compoundIndexName = 'restaurant_1_branch_1_name_1';
      const indexes = await categoriesCol.indexes();
      const hasCompound = indexes.some(
        (idx) => idx.name === compoundIndexName || (idx.unique && JSON.stringify(idx.key) === JSON.stringify(compoundKey))
      );
      if (!hasCompound) {
        await categoriesCol.createIndex(compoundKey, { unique: true, name: compoundIndexName });
        console.log('Created category compound index: restaurant_1_branch_1_name_1');
      }
    }
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    throw error;
  }
};

module.exports = connectDB;

