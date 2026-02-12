const mongoose = require('mongoose');

/**
 * Track customer usage of deals to enforce per-customer limits
 */
const dealUsageSchema = new mongoose.Schema(
  {
    deal: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Deal',
      required: true,
      index: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    usageCount: {
      type: Number,
      default: 1,
      min: 1,
    },
    discountApplied: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for quick lookups
dealUsageSchema.index({ deal: 1, customer: 1 });

// Static method to check if customer can use a deal
dealUsageSchema.statics.canCustomerUseDeal = async function (dealId, customerId) {
  const deal = await mongoose.model('Deal').findById(dealId);
  
  if (!deal) {
    return { canUse: false, reason: 'Deal not found' };
  }

  if (!deal.maxUsagePerCustomer) {
    return { canUse: true };
  }

  const usageRecords = await this.find({ deal: dealId, customer: customerId });
  const totalUsage = usageRecords.reduce((sum, record) => sum + record.usageCount, 0);

  if (totalUsage >= deal.maxUsagePerCustomer) {
    return {
      canUse: false,
      reason: `Maximum usage limit reached (${deal.maxUsagePerCustomer} times)`,
      currentUsage: totalUsage,
    };
  }

  return {
    canUse: true,
    currentUsage: totalUsage,
    remainingUses: deal.maxUsagePerCustomer - totalUsage,
  };
};

// Static method to record deal usage
dealUsageSchema.statics.recordUsage = async function (dealId, customerId, orderId, discountApplied) {
  const usage = new this({
    deal: dealId,
    customer: customerId,
    order: orderId,
    discountApplied,
  });
  
  return usage.save();
};

const DealUsage = mongoose.model('DealUsage', dealUsageSchema);

module.exports = DealUsage;
