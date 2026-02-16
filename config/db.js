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
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    throw error;
  }
};

module.exports = connectDB;

