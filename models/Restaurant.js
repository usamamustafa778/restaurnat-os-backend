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
      enum: ['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED'],
      default: 'TRIAL',
    },
    // Legacy fields (kept for backward compat)
    trialStartsAt: { type: Date },
    trialEndsAt: { type: Date },
    expiresAt: { type: Date },
    // New subscription fields
    freeTrialStartDate: { type: Date },
    freeTrialEndDate: { type: Date },
    subscriptionStartDate: { type: Date },
    subscriptionEndDate: { type: Date },
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
    /** Tab icon for the public website (PNG, ICO, or SVG URL). */
    faviconUrl: {
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
    // homepage hero: single banner image or multi-slide carousel
    heroType: {
      type: String,
      enum: ['banner', 'slides'],
      default: 'slides',
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
    // Opening Hours – structured (legacy) or free-text paragraph
    openingHours: {
      monday: { type: String, default: '9:00 AM - 10:00 PM' },
      tuesday: { type: String, default: '9:00 AM - 10:00 PM' },
      wednesday: { type: String, default: '9:00 AM - 10:00 PM' },
      thursday: { type: String, default: '9:00 AM - 10:00 PM' },
      friday: { type: String, default: '9:00 AM - 10:00 PM' },
      saturday: { type: String, default: '10:00 AM - 11:00 PM' },
      sunday: { type: String, default: '10:00 AM - 11:00 PM' },
    },
    openingHoursText: { type: String },
    // Allow customers to place orders from the public website
    allowWebsiteOrders: {
      type: Boolean,
      default: true,
    },
    /** Named delivery zones with flat fees (website, POS, rider). Empty = free-text address only. */
    deliveryLocations: [
      {
        name: { type: String, required: true, trim: true, maxlength: 120 },
        fee: { type: Number, required: true, min: 0, default: 0 },
        sortOrder: { type: Number, default: 0 },
      },
    ],
    // Website Sections – up to 3 customizable sections for the public website
    websiteSections: [{
      title: { type: String, default: '' },
      subtitle: { type: String, default: '' },
      isActive: { type: Boolean, default: true },
      items: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MenuItem',
      }],
    }],
    // Storefront template selection (maps to a template repo/directory)
    template: {
      type: String,
      default: 'classic',
      enum: ['classic', 'modern', 'minimal'],
    },
    // Custom domain for the storefront (e.g. urbanspoon.pk)
    customDomain: {
      type: String,
      default: null,
    },
    // Search & social previews (public storefront meta tags)
    seo: {
      title: { type: String },
      metaDescription: { type: String },
      keywords: { type: String },
      ogImageUrl: { type: String },
      noIndex: { type: Boolean, default: false },
    },
    // AI chat / voice agent (customer-facing; secrets stay server-side)
    aiAgents: {
      chatEnabled: { type: Boolean, default: false },
      chatWelcomeMessage: {
        type: String,
        default: 'Hi! How can we help you today?',
      },
      chatAssistantName: { type: String, default: 'Assistant' },
      callAgentEnabled: { type: Boolean, default: false },
      // Shown on website when call agent is enabled (e.g. Twilio number)
      callAgentPhone: { type: String, default: '' },
      callAgentNote: { type: String, default: '' },
    },
  },
  { _id: false }
);

const restaurantSchema = new mongoose.Schema(
  {
    website: websiteSettingsSchema,
    subscription: subscriptionSchema,
    readonly: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    settings: {
      // POS / inventory behaviour that may be configurable later
      allowOrderWhenOutOfStock: {
        type: Boolean,
        default: false,
      },
      // Shared restaurant logo used in POS / printed bills (separate from website logo)
      restaurantLogoUrl: {
        type: String,
      },
      restaurantLogoHeightPx: {
        type: Number,
        default: 100,
      },
      billFooterMessage: {
        type: String,
        default: 'Thank you for your order!',
      },
      // Branch/tenant operating currency for POS and cash counting widgets.
      // Empty means "not configured" and UI may fall back to manual mode.
      currencyCode: {
        type: String,
        uppercase: true,
        trim: true,
        default: null,
      },
    },
  },
  {
    timestamps: true,
  }
);

const Restaurant = mongoose.model('Restaurant', restaurantSchema);

module.exports = Restaurant;

