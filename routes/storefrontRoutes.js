const express = require('express');
const Restaurant = require('../models/Restaurant');
const Branch = require('../models/Branch');
const MenuItem = require('../models/MenuItem');
const BranchMenuItem = require('../models/BranchMenuItem');
const Category = require('../models/Category');
const InventoryItem = require('../models/InventoryItem');
const BranchInventory = require('../models/BranchInventory');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const StorefrontCustomer = require('../models/StorefrontCustomer');
const Deal = require('../models/Deal');
const AgentConversation = require('../models/AgentConversation');
const { generateOrderNumber } = require('../utils/orderNumber');
const { getOrderRooms } = require('../utils/socketRooms');
const crypto = require('crypto');
const storefrontAuthRoutes = require('./storefrontAuthRoutes');
const { normalizeEmail, normalizePhone } = require('../utils/storefrontIdentifiers');
const {
  authenticateStorefrontCustomer,
  optionalStorefrontCustomer,
} = require('../middleware/storefrontCustomerAuth');
const { storefrontCustomerToPublic } = require('../utils/storefrontCustomerPublic');
const { mergedDeliveryLocations, pickDeliveryLocation, publicDeliveryZones } = require('../utils/deliveryLocations');

const router = express.Router();

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter (no extra dependency)
// ---------------------------------------------------------------------------
const rateLimitStore = new Map();

function rateLimit({ windowMs = 60000, max = 100 } = {}) {
  return (req, res, next) => {
    const key = `${req.params.slug || ''}:${req.ip}:${req.path}`;
    const now = Date.now();
    let entry = rateLimitStore.get(key);

    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 1 };
      rateLimitStore.set(key, entry);
      return next();
    }

    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ message: 'Too many requests, please try again later' });
    }
    next();
  };
}

// Periodic cleanup so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.start > 120000) rateLimitStore.delete(key);
  }
}, 60000);

/**
 * Optional OpenAI reply (uses OPENAI_API_KEY on the server).
 */
async function generateOpenAiReply({ restaurantName, contactPhone, userMessages }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
  const phone = contactPhone || 'the restaurant';
  const system = `You are ${restaurantName}'s friendly customer chat assistant. Be brief and helpful.
If asked about ordering, mention they can use the website ordering when it is available.
If unsure about menu prices or items, suggest checking the menu on the site or calling ${phone}.
Do not invent specific prices or dishes; keep answers general unless the user pasted them.`;

  const msgs = [
    { role: 'system', content: system },
    ...userMessages.slice(-16).map((m) => ({ role: m.role, content: m.content })),
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, messages: msgs, max_tokens: 500, temperature: 0.7 }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ---------------------------------------------------------------------------
// Shared helper – resolve restaurant by slug, return 404 / 403 as needed
// ---------------------------------------------------------------------------
async function resolveBySlug(slug) {
  if (!slug) return null;
  return Restaurant.findOne({
    'website.subdomain': slug.toLowerCase().trim(),
    isDeleted: { $ne: true },
  });
}

function setCacheHeaders(res, maxAge = 60, swr = 300) {
  res.set('Cache-Control', `public, s-maxage=${maxAge}, stale-while-revalidate=${swr}`);
}

// ---------------------------------------------------------------------------
// GET /api/storefront/directory — public list for food hub (nearby / discovery)
// Must be registered before /:slug/* so "directory" is not treated as a slug.
// ---------------------------------------------------------------------------
router.get(
  '/directory',
  rateLimit({ windowMs: 60000, max: 60 }),
  async (req, res, next) => {
    try {
      const q = String(req.query.q || '')
        .trim()
        .toLowerCase();
      const city = String(req.query.city || '')
        .trim()
        .toLowerCase();

      const filter = {
        isDeleted: { $ne: true },
        'website.isPublic': true,
        'website.subdomain': { $exists: true, $nin: [null, ''] },
        'subscription.status': { $nin: ['SUSPENDED', 'EXPIRED'] },
      };

      let restaurants = await Restaurant.find(filter)
        .select('website subscription')
        .lean()
        .limit(300);

      const branchList = await Branch.find({
        restaurant: { $in: restaurants.map((r) => r._id) },
        status: 'active',
      })
        .sort({ sortOrder: 1, createdAt: 1 })
        .select('restaurant name address websiteOverrides')
        .lean();

      const branchByRestaurant = new Map();
      for (const b of branchList) {
        const rid = b.restaurant.toString();
        if (!branchByRestaurant.has(rid)) branchByRestaurant.set(rid, b);
      }

      const rows = [];
      for (const r of restaurants) {
        const w = r.website || {};
        const slug = (w.subdomain || '').toLowerCase().trim();
        if (!slug || slug === 'food' || slug === 'www') continue;

        const b = branchByRestaurant.get(r._id.toString());
        const address = (b && b.address) || w.address || '';
        const name = w.name || slug;
        const zones = mergedDeliveryLocations(r, b);
        const fees = zones.map((z) => z.fee).filter((f) => Number.isFinite(f));
        const minDeliveryFee = fees.length ? Math.min(...fees) : null;

        const blob = [name, address, w.tagline || '', w.description || '', slug].join(' ').toLowerCase();
        if (q && !blob.includes(q)) continue;
        if (city && !address.toLowerCase().includes(city)) continue;

        rows.push({
          slug,
          name,
          tagline: w.tagline || '',
          logoUrl: w.logoUrl || null,
          bannerUrl: w.bannerUrl || null,
          address: address || w.address || '',
          branchName: b?.name || '',
          allowWebsiteOrders: w.allowWebsiteOrders !== false,
          deliveryZoneCount: zones.length,
          minDeliveryFee,
        });
      }

      rows.sort((a, b) => a.name.localeCompare(b.name));

      setCacheHeaders(res, 60, 180);
      res.json({ restaurants: rows });
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/storefront/resolve-host — map custom domain → tenant subdomain (middleware)
// Must be registered before /:slug/* so "resolve-host" is not treated as a slug.
// ---------------------------------------------------------------------------
function normalizeHostForLookup(h) {
  let v = String(h || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '');
  const colon = v.indexOf(':');
  if (colon !== -1) v = v.slice(0, colon);
  if (v.startsWith('www.')) v = v.slice(4);
  return v;
}

router.get(
  '/resolve-host',
  rateLimit({ windowMs: 60000, max: 120 }),
  async (req, res, next) => {
    try {
      const raw = String(req.query.host || req.headers['x-forwarded-host'] || '').trim();
      const host = normalizeHostForLookup(raw);
      if (!host) return res.status(400).json({ message: 'host query parameter is required' });

      const candidates = [host];
      if (!host.startsWith('www.')) candidates.push(`www.${host}`);

      const restaurant = await Restaurant.findOne({
        isDeleted: { $ne: true },
        'website.customDomain': { $in: candidates },
      })
        .select('website.subdomain')
        .lean();

      const slug = (restaurant?.website?.subdomain || '').toLowerCase().trim();
      if (!slug) return res.status(404).json({ message: 'No restaurant for this host' });

      setCacheHeaders(res, 30, 120);
      return res.json({ subdomain: slug });
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/storefront/:slug/auth/* — customer accounts (order tracking)
// ---------------------------------------------------------------------------
router.use('/:slug/auth', storefrontAuthRoutes);

// ---------------------------------------------------------------------------
// GET /api/storefront/:slug/config
// ---------------------------------------------------------------------------
router.get(
  '/:slug/config',
  rateLimit({ windowMs: 60000, max: 120 }),
  async (req, res, next) => {
    try {
      const restaurant = await resolveBySlug(req.params.slug);
      if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

      if (restaurant.subscription?.status === 'SUSPENDED') {
        return res.status(403).json({ message: 'Subscription inactive or expired', suspended: true });
      }
      if (!restaurant.website?.isPublic) {
        return res.status(403).json({ message: 'Restaurant website is not public' });
      }

      const w = restaurant.website;
      setCacheHeaders(res, 60, 300);

      const requestedBranchId = req.query.branchId ? String(req.query.branchId).trim() : null;
      let branchForZones = null;
      if (requestedBranchId) {
        branchForZones = await Branch.findOne({
          _id: requestedBranchId,
          restaurant: restaurant._id,
          status: 'active',
        }).lean();
      }

      const ai = w.aiAgents || {};
      const logoFallback = restaurant.settings?.restaurantLogoUrl || null;
      const seo = w.seo || {};
      res.json({
        slug: w.subdomain,
        name: w.name,
        template: w.template || 'classic',
        isPublic: w.isPublic,
        logoUrl: w.logoUrl || logoFallback || null,
        faviconUrl: w.faviconUrl || null,
        bannerUrl: w.bannerUrl || null,
        description: w.description || '',
        tagline: w.tagline || '',
        heroType: w.heroType === 'banner' ? 'banner' : 'slides',
        seo: {
          title: seo.title || '',
          metaDescription: seo.metaDescription || '',
          keywords: seo.keywords || '',
          ogImageUrl: seo.ogImageUrl || null,
          noIndex: seo.noIndex === true,
        },
        contactPhone: w.contactPhone || '',
        contactEmail: w.contactEmail || '',
        address: w.address || '',
        deliveryZones: publicDeliveryZones(restaurant, branchForZones),
        heroSlides: (w.heroSlides || []).filter((s) => s.isActive),
        socialMedia: w.socialMedia || {},
        themeColors: w.themeColors || { primary: '#EF4444', secondary: '#FFA500' },
        openingHoursText: w.openingHoursText || '',
        allowWebsiteOrders: w.allowWebsiteOrders !== false,
        websiteSections: (w.websiteSections || [])
          .filter((s) => s.isActive)
          .map((s) => ({
            title: s.title || '',
            subtitle: s.subtitle || '',
            isActive: s.isActive,
            items: (s.items || []).map((id) => id.toString()),
          })),
        aiAgents: {
          chatEnabled: ai.chatEnabled === true,
          chatWelcomeMessage: ai.chatWelcomeMessage || 'Hi! How can we help you today?',
          chatAssistantName: ai.chatAssistantName || 'Assistant',
          callAgentEnabled: ai.callAgentEnabled === true,
          callAgentPhone: ai.callAgentPhone || '',
          callAgentNote: ai.callAgentNote || '',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/storefront/:slug/branches
// ---------------------------------------------------------------------------
router.get(
  '/:slug/branches',
  rateLimit({ windowMs: 60000, max: 60 }),
  async (req, res, next) => {
    try {
      const restaurant = await resolveBySlug(req.params.slug);
      if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });
      if (restaurant.subscription?.status === 'SUSPENDED') {
        return res.status(403).json({ message: 'Subscription inactive or expired', suspended: true });
      }

      const branches = await Branch.find({ restaurant: restaurant._id, status: 'active' })
        .sort({ sortOrder: 1, createdAt: 1 })
        .select('name code address contactPhone contactEmail openingHours')
        .lean();

      setCacheHeaders(res, 60, 300);

      res.json(
        branches.map((b) => ({
          id: b._id.toString(),
          name: b.name,
          code: b.code || '',
          address: b.address || '',
          contactPhone: b.contactPhone || '',
          contactEmail: b.contactEmail || '',
          openingHours: b.openingHours || {},
        }))
      );
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/storefront/:slug/menu
// ---------------------------------------------------------------------------
router.get(
  '/:slug/menu',
  rateLimit({ windowMs: 60000, max: 120 }),
  async (req, res, next) => {
    try {
      const restaurant = await resolveBySlug(req.params.slug);
      if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });
      if (restaurant.subscription?.status === 'SUSPENDED') {
        return res.status(403).json({ message: 'Subscription inactive or expired', suspended: true });
      }
      if (!restaurant.website?.isPublic) {
        return res.status(403).json({ message: 'Restaurant website is not public' });
      }

      const requestedBranchId = req.query.branchId || null;
      const activeBranches = await Branch.find({ restaurant: restaurant._id, status: 'active' })
        .sort({ sortOrder: 1, createdAt: 1 })
        .select('name code address contactPhone contactEmail openingHours websiteOverrides')
        .lean();

      let selectedBranchId = requestedBranchId;
      if (!selectedBranchId && activeBranches.length === 1) {
        selectedBranchId = activeBranches[0]._id.toString();
      }

      const categoryQuery = { restaurant: restaurant._id, isActive: true };
      // Use $ne: false so items created before the showOnWebsite field was added (field missing/null)
      // are treated as visible — matching the schema's default: true intent.
      const menuQuery = { restaurant: restaurant._id, available: true, showOnWebsite: { $ne: false } };

      if (selectedBranchId) {
        // Include items scoped to this branch AND items with branch:null (shared across all branches)
        categoryQuery.$or = [
          { branch: selectedBranchId },
          { branch: null },
          { branch: { $exists: false } },
        ];
        menuQuery.$or = [
          { branch: selectedBranchId },
          { branch: null },
          { branch: { $exists: false } },
        ];
      }

      const [categories, allItems, inventoryItems, branchInventoryRows, branchForWebsite] = await Promise.all([
        Category.find(categoryQuery).sort({ createdAt: 1 }),
        MenuItem.find(menuQuery).populate('category'),
        InventoryItem.find({ restaurant: restaurant._id }),
        selectedBranchId
          ? BranchInventory.find({ branch: selectedBranchId }).lean()
          : Promise.resolve([]),
        selectedBranchId
          ? Branch.findOne({ _id: selectedBranchId, restaurant: restaurant._id })
          : null,
      ]);

      // Inventory sufficiency check.
      // When a branch is selected, prefer branch-level stock (BranchInventory) over the
      // main InventoryItem.currentStock. Restaurants that track stock per-branch keep
      // their real quantities in BranchInventory; the main item stock may be 0 or stale.
      const branchStockMap = new Map();
      for (const row of branchInventoryRows) {
        branchStockMap.set(row.inventoryItem.toString(), row.currentStock);
      }

      const inventoryMap = new Map();
      for (const inv of inventoryItems) {
        const id = inv._id.toString();
        const currentStock = selectedBranchId && branchStockMap.has(id)
          ? branchStockMap.get(id)
          : inv.currentStock;
        inventoryMap.set(id, { ...inv.toObject?.() ?? inv, currentStock });
      }

      function hasEnoughInventory(menuItem) {
        if (!menuItem.inventoryConsumptions || menuItem.inventoryConsumptions.length === 0) return true;
        for (const consumption of menuItem.inventoryConsumptions) {
          const invId = consumption.inventoryItem ? consumption.inventoryItem.toString() : null;
          if (!invId) continue;
          const inv = inventoryMap.get(invId);
          if (!inv) continue;
          if ((consumption.quantity || 0) > 0 && inv.currentStock < consumption.quantity) return false;
        }
        return true;
      }

      const items = allItems.filter(hasEnoughInventory);

      // Branch-specific overrides for website config
      const rawWebsite = restaurant.website || {};
      const baseWebsite = typeof rawWebsite.toObject === 'function' ? rawWebsite.toObject() : { ...rawWebsite };
      delete baseWebsite.openingHours;

      let websiteConfig = { ...baseWebsite };
      if (branchForWebsite && branchForWebsite.websiteOverrides) {
        const overrides = branchForWebsite.websiteOverrides;
        [
          'heroSlides',
          'socialMedia',
          'themeColors',
          'openingHoursText',
          'websiteSections',
          'allowWebsiteOrders',
          'deliveryLocations',
        ].forEach((key) => {
          if (overrides[key] !== undefined) websiteConfig[key] = overrides[key];
        });
      }

      // Populate website sections with full menu item data
      const rawSections = websiteConfig.websiteSections || [];
      const websiteSections = [];
      for (const section of rawSections) {
        if (!section.isActive) continue;
        const sectionItemIds = (section.items || []).map((id) => id.toString());
        const sectionItemQuery = {
          _id: { $in: sectionItemIds },
          restaurant: restaurant._id,
          available: true,
          showOnWebsite: { $ne: false },
        };
        if (selectedBranchId) {
          sectionItemQuery.$or = [
            { branch: selectedBranchId },
            { branch: null },
            { branch: { $exists: false } },
          ];
        }

        const sectionItems = await MenuItem.find(sectionItemQuery).populate('category');
        websiteSections.push({
          title: section.title || '',
          subtitle: section.subtitle || '',
          items: sectionItems.filter(hasEnoughInventory).map((item) => ({
            id: item._id.toString(),
            name: item.name,
            description: item.description || item.category?.description || '',
            price: item.price,
            category: item.category?.name || 'Uncategorized',
            imageUrl: item.imageUrl,
          })),
        });
      }

      // Branch-level price/availability overrides
      let overrideMap = new Map();
      if (selectedBranchId) {
        const overrides = await BranchMenuItem.find({ branch: selectedBranchId }).lean();
        for (const o of overrides) overrideMap.set(o.menuItem.toString(), o);
      }

      const branchFilteredItems = selectedBranchId
        ? items.filter((item) => {
            const override = overrideMap.get(item._id.toString());
            return override ? override.available !== false : true;
          })
        : items;

      const menuResponse = branchFilteredItems.map((item) => {
        const override = overrideMap.get(item._id.toString());
        return {
          id: item._id.toString(),
          name: item.name,
          description: item.description || item.category?.description || '',
          price: override?.priceOverride != null ? override.priceOverride : item.price,
          category: item.category?.name || 'Uncategorized',
          imageUrl: item.imageUrl,
          isFeatured: item.isFeatured || false,
          isBestSeller: item.isBestSeller || false,
        };
      });

      setCacheHeaders(res, 30, 120);

      const logoFallback = restaurant.settings?.restaurantLogoUrl || null;
      res.json({
        restaurant: {
          name: websiteConfig.name,
          description: websiteConfig.description,
          tagline: websiteConfig.tagline,
          logoUrl: websiteConfig.logoUrl || logoFallback || null,
          bannerUrl: websiteConfig.bannerUrl,
          contactPhone: websiteConfig.contactPhone,
          contactEmail: websiteConfig.contactEmail,
          address: websiteConfig.address,
          subdomain: websiteConfig.subdomain,
          heroType: websiteConfig.heroType === 'banner' ? 'banner' : 'slides',
          heroSlides: websiteConfig.heroSlides || [],
          socialMedia: websiteConfig.socialMedia || {},
          themeColors: websiteConfig.themeColors || { primary: '#EF4444', secondary: '#FFA500' },
          openingHoursText: websiteConfig.openingHoursText || '',
          websiteSections,
          allowWebsiteOrders: websiteConfig.allowWebsiteOrders !== false,
          deliveryZones: publicDeliveryZones(restaurant, branchForWebsite),
        },
        menu: menuResponse,
        categories: categories.map((c) => ({
          id: c._id.toString(),
          name: c.name,
          description: c.description || '',
        })),
        branches: activeBranches.map((b) => ({
          id: b._id.toString(),
          name: b.name,
          code: b.code || '',
          address: b.address || '',
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/storefront/:slug/deals
// ---------------------------------------------------------------------------
router.get(
  '/:slug/deals',
  rateLimit({ windowMs: 60000, max: 60 }),
  async (req, res, next) => {
    try {
      const restaurant = await resolveBySlug(req.params.slug);
      if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });
      if (restaurant.subscription?.status === 'SUSPENDED') {
        return res.status(403).json({ message: 'Subscription inactive or expired', suspended: true });
      }

      const { branchId } = req.query;
      const deals = await Deal.findApplicableDeals(restaurant._id.toString(), branchId || undefined);

      await Deal.populate(deals, [
        { path: 'applicableMenuItems' },
        { path: 'applicableCategories' },
        { path: 'comboItems.menuItem' },
        { path: 'buyMenuItem' },
        { path: 'getMenuItem' },
      ]);

      const publicDeals = deals
        .filter((d) => d.showOnWebsite !== false)
        .map((d) => ({
          id: d._id.toString(),
          name: d.name,
          description: d.description || '',
          dealType: d.dealType,
          discountPercentage: d.discountPercentage,
          discountAmount: d.discountAmount,
          comboPrice: d.comboPrice,
          buyQuantity: d.buyQuantity,
          getQuantity: d.getQuantity,
          minimumPurchase: d.minimumPurchaseAmount,
          startTime: d.startTime,
          endTime: d.endTime,
          daysOfWeek: d.daysOfWeek || [],
          maxTotalUsage: d.maxTotalUsage,
          badgeText: d.badgeText || '',
          showOnWebsite: d.showOnWebsite,
        }));

      setCacheHeaders(res, 60, 300);
      res.json(publicDeals);
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/storefront/:slug/agent/chat  — public AI chat (when enabled)
// ---------------------------------------------------------------------------
router.post(
  '/:slug/agent/chat',
  rateLimit({ windowMs: 60000, max: 40 }),
  async (req, res, next) => {
    try {
      const restaurant = await resolveBySlug(req.params.slug);
      if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });
      if (restaurant.subscription?.status === 'SUSPENDED') {
        return res.status(403).json({ message: 'Subscription inactive or expired', suspended: true });
      }
      if (!restaurant.website?.isPublic) {
        return res.status(403).json({ message: 'Restaurant website is not public' });
      }

      const ai = restaurant.website?.aiAgents || {};
      if (!ai.chatEnabled) {
        return res.status(403).json({ message: 'Chat is not enabled for this restaurant' });
      }

      const { message, sessionId: incomingSession } = req.body || {};
      const text = typeof message === 'string' ? message.trim() : '';
      if (!text || text.length > 4000) {
        return res.status(400).json({ message: 'message is required (max 4000 characters)' });
      }

      const sessionId =
        incomingSession && String(incomingSession).length >= 8
          ? String(incomingSession)
          : crypto.randomBytes(16).toString('hex');

      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
      const userAgent = req.headers['user-agent'] || '';

      let convo = await AgentConversation.findOne({
        restaurant: restaurant._id,
        sessionId,
        channel: 'chat',
      });

      if (!convo) {
        convo = await AgentConversation.create({
          restaurant: restaurant._id,
          channel: 'chat',
          sessionId,
          slug: req.params.slug,
          messages: [],
          meta: { ip, userAgent },
        });
      }

      convo.messages.push({ role: 'user', content: text, at: new Date() });

      const historyForModel = convo.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));

      const fallback = `Thanks for your message! For immediate help, call us at ${
        restaurant.website?.contactPhone || 'the number on our website'
      }.`;

      const reply =
        (await generateOpenAiReply({
          restaurantName: restaurant.website?.name || restaurant.name,
          contactPhone: restaurant.website?.contactPhone || '',
          userMessages: historyForModel,
        })) || fallback;

      convo.messages.push({ role: 'assistant', content: reply, at: new Date() });
      await convo.save();

      res.json({
        sessionId,
        reply,
        assistantName: ai.chatAssistantName || 'Assistant',
      });
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/storefront/:slug/orders/mine — logged-in customer order history
// ---------------------------------------------------------------------------
router.get(
  '/:slug/orders/mine',
  rateLimit({ windowMs: 60000, max: 60 }),
  authenticateStorefrontCustomer,
  async (req, res, next) => {
    try {
      const restaurant = await resolveBySlug(req.params.slug);
      if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });
      if (!restaurant._id.equals(req.storefrontCustomer.restaurant)) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      const c = req.storefrontCustomer;
      const clauses = [{ storefrontCustomer: c._id }];
      if (c.phone) {
        clauses.push({ source: 'WEBSITE', customerPhoneDigits: c.phone });
      }
      if (c.email) {
        clauses.push({ source: 'WEBSITE', customerEmail: c.email });
      }

      const orders = await Order.find({
        restaurant: restaurant._id,
        $or: clauses,
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .select(
          'orderNumber status total subtotal createdAt deliveryAddress customerName customerPhone customerEmail items paymentMethod orderType'
        )
        .lean();

      res.json({
        orders: orders.map((o) => ({
          id: o._id.toString(),
          orderNumber: o.orderNumber,
          status: o.status,
          total: o.total,
          subtotal: o.subtotal,
          createdAt: o.createdAt,
          deliveryAddress: o.deliveryAddress || '',
          customerName: o.customerName || '',
          customerPhone: o.customerPhone || '',
          customerEmail: o.customerEmail || '',
          paymentMethod: o.paymentMethod,
          orderType: o.orderType,
          items: (o.items || []).map((it) => ({
            name: it.name,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            lineTotal: it.lineTotal,
          })),
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/storefront/:slug/orders
// ---------------------------------------------------------------------------
router.post(
  '/:slug/orders',
  rateLimit({ windowMs: 60000, max: 10 }),
  optionalStorefrontCustomer,
  async (req, res, next) => {
    try {
      const restaurant = await resolveBySlug(req.params.slug);
      if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

      if (restaurant.subscription?.status === 'SUSPENDED') {
        return res.status(403).json({ message: 'Subscription inactive or expired' });
      }
      if (restaurant.website?.allowWebsiteOrders === false) {
        return res.status(403).json({ message: 'Online ordering is temporarily unavailable. Please contact the restaurant directly.' });
      }

      const { customerName, customerPhone, customerEmail, deliveryAddress, deliveryLocationId, items, branchId } =
        req.body || {};

      if (!customerPhone || !customerPhone.trim()) {
        return res.status(400).json({ message: 'Phone number is required' });
      }

      const phoneTrim = customerPhone.trim();
      const customerPhoneDigits = normalizePhone(phoneTrim) || phoneTrim.replace(/\D/g, '') || '';
      const emailNorm = normalizeEmail(customerEmail);

      let storefrontCustomerId = null;
      if (req.storefrontCustomer) {
        storefrontCustomerId = req.storefrontCustomer._id;
      }
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: 'At least one item is required' });
      }

      let branch = null;
      const branchCount = await Branch.countDocuments({ restaurant: restaurant._id });
      if (branchCount > 0) {
        if (!branchId) {
          return res.status(400).json({ message: 'branchId is required when restaurant has branches' });
        }
        branch = await Branch.findOne({ _id: branchId, restaurant: restaurant._id });
        if (!branch) {
          return res.status(400).json({ message: 'Invalid branchId for this restaurant' });
        }
      } else if (branchId) {
        branch = await Branch.findOne({ _id: branchId, restaurant: restaurant._id });
      }

      const menuItemIds = items.map((i) => i.menuItemId);
      const menuItems = await MenuItem.find({
        _id: { $in: menuItemIds },
        restaurant: restaurant._id,
        available: true,
      });

      const menuItemMap = {};
      for (const mi of menuItems) menuItemMap[mi._id.toString()] = mi;

      let subtotal = 0;
      const orderItems = [];

      for (const cartItem of items) {
        const mi = menuItemMap[cartItem.menuItemId];
        if (!mi) {
          return res.status(400).json({ message: `Menu item not found or unavailable: ${cartItem.menuItemId}` });
        }
        const qty = Math.max(1, parseInt(cartItem.quantity) || 1);
        const lineTotal = mi.price * qty;
        subtotal += lineTotal;
        orderItems.push({
          menuItem: mi._id,
          name: mi.name,
          quantity: qty,
          unitPrice: mi.price,
          lineTotal,
        });
      }

      const zones = mergedDeliveryLocations(restaurant, branch);
      let deliveryCharges = 0;
      let deliveryLocId = null;
      let deliveryLocName = '';
      let addressTrim = (deliveryAddress || '').trim();

      if (zones.length > 0) {
        const picked = pickDeliveryLocation(zones, deliveryLocationId);
        if (!picked) {
          return res.status(400).json({ message: 'Please select a valid delivery area' });
        }
        deliveryCharges = picked.fee;
        deliveryLocName = picked.name;
        deliveryLocId = deliveryLocationId ? String(deliveryLocationId).trim() : null;
        addressTrim = deliveryLocName + (addressTrim ? ` — ${addressTrim}` : '');
      }

      const foodTotal = Math.round(subtotal * 100) / 100;
      const deliveryChargesRounded = Math.round(deliveryCharges * 100) / 100;
      const grandTotal = Math.round((foodTotal + deliveryChargesRounded) * 100) / 100;
      const orderNumber = await generateOrderNumber(restaurant._id, branch ? branch._id : null, 'WEB');

      try {
        await Customer.findOneAndUpdate(
          { restaurant: restaurant._id, branch: branch ? branch._id : null, phone: phoneTrim },
          {
            $set: {
              name: (customerName || '').trim() || 'Website Customer',
              address: addressTrim,
              lastOrderAt: new Date(),
            },
            $inc: { totalOrders: 1, totalSpent: grandTotal },
            $setOnInsert: {
              restaurant: restaurant._id,
              branch: branch ? branch._id : null,
              phone: phoneTrim,
            },
          },
          { upsert: true }
        );
      } catch (_) { /* non-critical */ }

      const order = await Order.create({
        restaurant: restaurant._id,
        branch: branch ? branch._id : undefined,
        orderType: 'DELIVERY',
        paymentMethod: 'CASH',
        source: 'WEBSITE',
        status: 'NEW_ORDER',
        customerName: (customerName || '').trim() || 'Website Customer',
        customerPhone: phoneTrim,
        customerPhoneDigits,
        customerEmail: emailNorm || '',
        storefrontCustomer: storefrontCustomerId,
        deliveryAddress: addressTrim,
        deliveryCharges: deliveryChargesRounded,
        deliveryLocationId: deliveryLocId || undefined,
        deliveryLocationName: deliveryLocName || undefined,
        items: orderItems,
        subtotal,
        discountAmount: 0,
        total: foodTotal,
        grandTotal,
        orderNumber,
      });

      let customerPayload = null;
      if (storefrontCustomerId) {
        await StorefrontCustomer.updateOne(
          { _id: storefrontCustomerId },
          { $set: { savedPhone: phoneTrim, savedDeliveryAddress: addressTrim } }
        );
        const refreshed = await StorefrontCustomer.findById(storefrontCustomerId).lean();
        if (refreshed) customerPayload = storefrontCustomerToPublic(refreshed);
      }

      const io = req.app.get('io');
      if (io) {
        const rooms = getOrderRooms(order.restaurant, order.branch);
        const payload = {
          id: order._id.toString(),
          orderNumber: order.orderNumber,
          status: order.status,
          createdAt: order.createdAt,
        };
        rooms.forEach((room) => io.to(room).emit('order:created', payload));
      }

      res.status(201).json({
        message: 'Order placed successfully!',
        orderNumber: order.orderNumber,
        subtotal: order.subtotal,
        deliveryCharges: order.deliveryCharges || 0,
        total: order.total + (order.deliveryCharges || 0),
        ...(customerPayload ? { customer: customerPayload } : {}),
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
