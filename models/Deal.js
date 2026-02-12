const mongoose = require('mongoose');

/**
 * Deal/Promotion Model
 * Supports various types of restaurant deals and promotions
 */

const dealItemSchema = new mongoose.Schema(
  {
    menuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
  },
  { _id: false }
);

const dealSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    // Optional: restrict to specific branches
    branches: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
      },
    ],
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    dealType: {
      type: String,
      enum: [
        'PERCENTAGE_DISCOUNT', // e.g., 20% off
        'FIXED_DISCOUNT', // e.g., $5 off
        'COMBO', // e.g., Burger + Fries + Drink for $10
        'BUY_X_GET_Y', // e.g., Buy 2, Get 1 Free
        'MINIMUM_PURCHASE', // e.g., Spend $20, get $5 off
      ],
      required: true,
    },

    // ===== PERCENTAGE_DISCOUNT / FIXED_DISCOUNT =====
    discountPercentage: {
      type: Number,
      min: 0,
      max: 100,
      // Required if dealType is PERCENTAGE_DISCOUNT
    },
    discountAmount: {
      type: Number,
      min: 0,
      // Required if dealType is FIXED_DISCOUNT or MINIMUM_PURCHASE
    },

    // ===== COMBO DEAL =====
    comboItems: [dealItemSchema], // Items included in the combo
    comboPrice: {
      type: Number,
      min: 0,
      // Required if dealType is COMBO
    },

    // ===== BUY X GET Y =====
    buyQuantity: {
      type: Number,
      min: 1,
      // Required if dealType is BUY_X_GET_Y
    },
    getQuantity: {
      type: Number,
      min: 1,
      // Required if dealType is BUY_X_GET_Y
    },
    buyMenuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      // Required if dealType is BUY_X_GET_Y
    },
    getMenuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      // Can be same as buyMenuItem or different
    },

    // ===== MINIMUM PURCHASE =====
    minimumPurchaseAmount: {
      type: Number,
      min: 0,
      // Required if dealType is MINIMUM_PURCHASE
    },

    // ===== Applicability =====
    // If empty, applies to all items (or all orders for MINIMUM_PURCHASE)
    applicableMenuItems: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MenuItem',
      },
    ],
    applicableCategories: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category',
      },
    ],

    // ===== Time Restrictions =====
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    // Time of day restrictions (e.g., Happy Hour: 4 PM - 7 PM)
    startTime: {
      type: String, // Format: "HH:mm" (e.g., "16:00")
      validate: {
        validator: function (v) {
          return !v || /^([01]\d|2[0-3]):([0-5]\d)$/.test(v);
        },
        message: 'startTime must be in HH:mm format (e.g., "16:00")',
      },
    },
    endTime: {
      type: String, // Format: "HH:mm" (e.g., "19:00")
      validate: {
        validator: function (v) {
          return !v || /^([01]\d|2[0-3]):([0-5]\d)$/.test(v);
        },
        message: 'endTime must be in HH:mm format (e.g., "19:00")',
      },
    },
    // Days of week (0 = Sunday, 6 = Saturday)
    daysOfWeek: {
      type: [Number],
      validate: {
        validator: function (arr) {
          return arr.every((day) => day >= 0 && day <= 6);
        },
        message: 'daysOfWeek must contain numbers between 0 (Sunday) and 6 (Saturday)',
      },
    },

    // ===== Usage Limits =====
    maxUsagePerCustomer: {
      type: Number,
      min: 0,
      // 0 or null = unlimited
    },
    maxTotalUsage: {
      type: Number,
      min: 0,
      // 0 or null = unlimited
    },
    currentUsageCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ===== Status =====
    isActive: {
      type: Boolean,
      default: true,
    },
    priority: {
      type: Number,
      default: 0,
      // Higher priority deals are applied first (useful when multiple deals apply)
    },

    // ===== Display =====
    imageUrl: {
      type: String,
    },
    showOnWebsite: {
      type: Boolean,
      default: true,
    },
    showOnPOS: {
      type: Boolean,
      default: true,
    },
    badgeText: {
      type: String,
      trim: true,
      // e.g., "HOT DEAL", "LIMITED TIME", "SAVE 20%"
    },

    // ===== Stacking =====
    canStackWithOtherDeals: {
      type: Boolean,
      default: false,
      // Whether this deal can be combined with other deals
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
dealSchema.index({ restaurant: 1, isActive: 1, startDate: 1, endDate: 1 });
dealSchema.index({ branches: 1 });
dealSchema.index({ dealType: 1 });

// Virtual to check if deal is currently valid
dealSchema.virtual('isCurrentlyValid').get(function () {
  const now = new Date();
  
  // Check date range
  if (now < this.startDate || now > this.endDate) {
    return false;
  }

  // Check if active
  if (!this.isActive) {
    return false;
  }

  // Check usage limits
  if (this.maxTotalUsage && this.currentUsageCount >= this.maxTotalUsage) {
    return false;
  }

  // Check day of week
  if (this.daysOfWeek && this.daysOfWeek.length > 0) {
    const currentDay = now.getDay();
    if (!this.daysOfWeek.includes(currentDay)) {
      return false;
    }
  }

  // Check time of day
  if (this.startTime || this.endTime) {
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes()
    ).padStart(2, '0')}`;
    if (this.startTime && currentTime < this.startTime) {
      return false;
    }
    if (this.endTime && currentTime > this.endTime) {
      return false;
    }
  }

  return true;
});

// Method to increment usage count
dealSchema.methods.incrementUsage = async function () {
  this.currentUsageCount += 1;
  return this.save();
};

// Static method to find applicable deals for a branch
dealSchema.statics.findApplicableDeals = async function (
  restaurantId,
  branchId,
  options = {}
) {
  const query = {
    restaurant: restaurantId,
    isActive: true,
    startDate: { $lte: new Date() },
    endDate: { $gte: new Date() },
    $or: [{ branches: { $size: 0 } }, { branches: branchId }],
  };

  // Optional filters
  if (options.dealType) {
    query.dealType = options.dealType;
  }

  if (options.menuItem) {
    query.$or = [
      { applicableMenuItems: { $size: 0 } },
      { applicableMenuItems: options.menuItem },
    ];
  }

  const deals = await this.find(query).sort({ priority: -1 });

  // Filter by time and day of week
  return deals.filter((deal) => deal.isCurrentlyValid);
};

const Deal = mongoose.model('Deal', dealSchema);

module.exports = Deal;
