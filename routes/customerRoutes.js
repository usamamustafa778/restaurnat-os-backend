const express = require('express');
const Category = require('../models/Category');
const MenuItem = require('../models/MenuItem');
const Restaurant = require('../models/Restaurant');

const router = express.Router();

// @route   GET /api/
// @desc    Simple API root
// @access  Public
router.get('/', (req, res) => {
  res.json({ message: 'RestaurantOS public API is working' });
});

// Helper to resolve restaurant from subdomain or id
const resolveRestaurant = async (req) => {
  const { subdomain, restaurantId } = req.query;

  if (restaurantId) {
    return Restaurant.findById(restaurantId);
  }

  if (subdomain) {
    return Restaurant.findOne({ 'website.subdomain': subdomain.toLowerCase().trim() });
  }

  return null;
};

// @route   GET /api/menu
// @desc    Public menu for a restaurant website
// @access  Public
router.get('/menu', async (req, res, next) => {
  try {
    const restaurant = await resolveRestaurant(req);
    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    // Block public website for suspended subscriptions
    if (restaurant.subscription?.status === 'SUSPENDED') {
      return res.status(403).json({ message: 'Subscription inactive or expired' });
    }

    if (!restaurant.website?.isPublic) {
      return res.status(403).json({ message: 'Restaurant website is not public' });
    }

    const [categories, items] = await Promise.all([
      Category.find({ restaurant: restaurant._id, isActive: true }).sort({ createdAt: 1 }),
      MenuItem.find({ restaurant: restaurant._id, available: true, showOnWebsite: true }).populate('category'),
    ]);

    const response = items.map((item) => ({
      id: item._id.toString(),
      name: item.name,
      description: item.description || item.category?.description || '',
      price: item.price,
      category: item.category?.name || 'Uncategorized',
      imageUrl: item.imageUrl,
      isFeatured: item.isFeatured || false,
      isBestSeller: item.isBestSeller || false,
      tags: [],
    }));

    res.json({
      restaurant: {
        name: restaurant.website?.name,
        description: restaurant.website?.description,
        tagline: restaurant.website?.tagline,
        logoUrl: restaurant.website?.logoUrl,
        bannerUrl: restaurant.website?.bannerUrl,
        contactPhone: restaurant.website?.contactPhone,
        contactEmail: restaurant.website?.contactEmail,
        address: restaurant.website?.address,
        subdomain: restaurant.website?.subdomain,
        heroSlides: restaurant.website?.heroSlides || [],
        socialMedia: restaurant.website?.socialMedia || {},
        themeColors: restaurant.website?.themeColors || { primary: '#EF4444', secondary: '#FFA500' },
        openingHours: restaurant.website?.openingHours || {},
      },
      menu: response,
      categories: categories.map((c) => ({
        id: c._id.toString(),
        name: c.name,
        description: c.description || '',
      })),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

