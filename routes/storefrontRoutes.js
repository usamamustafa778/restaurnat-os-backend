const express = require('express');
const Restaurant = require('../models/Restaurant');
const Branch = require('../models/Branch');
const MenuItem = require('../models/MenuItem');
const BranchMenuItem = require('../models/BranchMenuItem');
const Category = require('../models/Category');
const InventoryItem = require('../models/InventoryItem');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Deal = require('../models/Deal');
const AgentConversation = require('../models/AgentConversation');
const { generateOrderNumber } = require('../utils/orderNumber');
const { getOrderRooms } = require('../utils/socketRooms');
const crypto = require('crypto');

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

      const ai = w.aiAgents || {};
      res.json({
        slug: w.subdomain,
        name: w.name,
        template: w.template || 'classic',
        isPublic: w.isPublic,
        logoUrl: w.logoUrl || null,
        bannerUrl: w.bannerUrl || null,
        description: w.description || '',
        tagline: w.tagline || '',
        contactPhone: w.contactPhone || '',
        contactEmail: w.contactEmail || '',
        address: w.address || '',
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
      const menuQuery = { restaurant: restaurant._id, available: true, showOnWebsite: true };
      if (selectedBranchId) {
        categoryQuery.branch = selectedBranchId;
        menuQuery.branch = selectedBranchId;
      }

      const [categories, allItems, inventoryItems, branchForWebsite] = await Promise.all([
        Category.find(categoryQuery).sort({ createdAt: 1 }),
        MenuItem.find(menuQuery).populate('category'),
        InventoryItem.find({ restaurant: restaurant._id }),
        selectedBranchId
          ? Branch.findOne({ _id: selectedBranchId, restaurant: restaurant._id })
          : null,
      ]);

      // Inventory sufficiency check
      const inventoryMap = new Map();
      for (const inv of inventoryItems) {
        inventoryMap.set(inv._id.toString(), inv);
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
        ['heroSlides', 'socialMedia', 'themeColors', 'openingHoursText', 'websiteSections', 'allowWebsiteOrders'].forEach((key) => {
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
          showOnWebsite: true,
        };
        if (selectedBranchId) sectionItemQuery.branch = selectedBranchId;

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

      res.json({
        restaurant: {
          name: websiteConfig.name,
          description: websiteConfig.description,
          tagline: websiteConfig.tagline,
          logoUrl: websiteConfig.logoUrl,
          bannerUrl: websiteConfig.bannerUrl,
          contactPhone: websiteConfig.contactPhone,
          contactEmail: websiteConfig.contactEmail,
          address: websiteConfig.address,
          subdomain: websiteConfig.subdomain,
          heroSlides: websiteConfig.heroSlides || [],
          socialMedia: websiteConfig.socialMedia || {},
          themeColors: websiteConfig.themeColors || { primary: '#EF4444', secondary: '#FFA500' },
          openingHoursText: websiteConfig.openingHoursText || '',
          websiteSections,
          allowWebsiteOrders: websiteConfig.allowWebsiteOrders !== false,
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
        .filter((d) => d.showOnWebsite)
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
// POST /api/storefront/:slug/orders
// ---------------------------------------------------------------------------
router.post(
  '/:slug/orders',
  rateLimit({ windowMs: 60000, max: 10 }),
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

      const { customerName, customerPhone, deliveryAddress, items, branchId } = req.body;

      if (!customerPhone || !customerPhone.trim()) {
        return res.status(400).json({ message: 'Phone number is required' });
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

      const orderNumber = await generateOrderNumber(restaurant._id, branch ? branch._id : null, 'WEB');

      try {
        await Customer.findOneAndUpdate(
          { restaurant: restaurant._id, branch: branch ? branch._id : null, phone: customerPhone.trim() },
          {
            $set: {
              name: (customerName || '').trim() || 'Website Customer',
              address: (deliveryAddress || '').trim(),
              lastOrderAt: new Date(),
            },
            $inc: { totalOrders: 1, totalSpent: subtotal },
            $setOnInsert: {
              restaurant: restaurant._id,
              branch: branch ? branch._id : null,
              phone: customerPhone.trim(),
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
        customerPhone: customerPhone.trim(),
        deliveryAddress: (deliveryAddress || '').trim(),
        items: orderItems,
        subtotal,
        discountAmount: 0,
        total: subtotal,
        orderNumber,
      });

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
        total: order.total,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
