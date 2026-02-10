const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    plan: {
      type: String,
      enum: ['ESSENTIAL', 'PROFESSIONAL', 'ENTERPRISE'],
      default: 'ESSENTIAL',
    },
    status: {
      type: String,
      enum: ['TRIAL', 'ACTIVE', 'SUSPENDED'],
      default: 'TRIAL',
    },
    // Trial window for newly created tenants
    trialStartsAt: {
      type: Date,
    },
    trialEndsAt: {
      type: Date,
    },
    expiresAt: {
      type: Date,
    },
  },
  { _id: false }
);

const websiteSettingsSchema = new mongoose.Schema(
  {
    subdomain: {
      // e.g. myrestaurant => myrestaurant.yourdomain.com
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
    },
    isPublic: {
      type: Boolean,
      default: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    logoUrl: {
      type: String,
    },
    bannerUrl: {
      type: String,
    },
    description: {
      type: String,
    },
    tagline: {
      type: String,
    },
    contactPhone: {
      type: String,
    },
    contactEmail: {
      type: String,
    },
    address: {
      type: String,
    },
    // Hero Slides for homepage carousel
    heroSlides: [{
      title: String,
      subtitle: String,
      imageUrl: String,
      buttonText: String,
      buttonLink: String,
      isActive: { type: Boolean, default: true }
    }],
    // Social Media Links
    socialMedia: {
      facebook: String,
      instagram: String,
      twitter: String,
      youtube: String,
    },
    // Theme Colors
    themeColors: {
      primary: { type: String, default: '#EF4444' },
      secondary: { type: String, default: '#FFA500' },
    },
    // Opening Hours
    openingHours: {
      monday: { type: String, default: '9:00 AM - 10:00 PM' },
      tuesday: { type: String, default: '9:00 AM - 10:00 PM' },
      wednesday: { type: String, default: '9:00 AM - 10:00 PM' },
      thursday: { type: String, default: '9:00 AM - 10:00 PM' },
      friday: { type: String, default: '9:00 AM - 10:00 PM' },
      saturday: { type: String, default: '10:00 AM - 11:00 PM' },
      sunday: { type: String, default: '10:00 AM - 11:00 PM' },
    },
  },
  { _id: false }
);

const restaurantSchema = new mongoose.Schema(
  {
    website: websiteSettingsSchema,
    subscription: subscriptionSchema,
    settings: {
      // POS / inventory behaviour that may be configurable later
      allowOrderWhenOutOfStock: {
        type: Boolean,
        default: false,
      },
    },
  },
  {
    timestamps: true,
  }
);

const Restaurant = mongoose.model('Restaurant', restaurantSchema);

module.exports = Restaurant;

