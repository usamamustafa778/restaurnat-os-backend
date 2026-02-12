# Deals & Promotions System - Quick Summary

## What Was Created

A comprehensive deals/promotions system for your restaurant management platform with support for:

✅ **5 Deal Types:**
- Percentage Discount (20% off)
- Fixed Amount Discount ($5 off)
- Combo Deals (Burger + Fries + Drink for $10)
- Buy X Get Y (Buy 2, Get 1 Free)
- Minimum Purchase (Spend $20, get $5 off)

✅ **Advanced Features:**
- Time-based restrictions (Happy Hour: 4 PM - 7 PM)
- Day of week restrictions (Weekend specials)
- Branch-specific deals
- Customer usage limits (first-time customer deals)
- Total usage limits (limited offers)
- Deal stacking support
- Priority system for conflicting deals

## Files Created

### 1. **Models**
- `models/Deal.js` - Main deal model with all configurations
- `models/DealUsage.js` - Track customer usage for limits

### 2. **Routes**
- `routes/dealRoutes.js` - Full CRUD API for deals
  - `POST /api/deals` - Create deal
  - `GET /api/deals` - List all deals
  - `GET /api/deals/active` - Get currently valid deals
  - `GET /api/deals/:id` - Get single deal
  - `PUT /api/deals/:id` - Update deal
  - `DELETE /api/deals/:id` - Delete deal
  - `POST /api/deals/:id/toggle` - Activate/deactivate
  - `GET /api/deals/:id/usage` - Usage statistics
  - `POST /api/deals/:id/check-eligibility` - Check if customer can use

### 3. **Utilities**
- `utils/dealCalculator.js` - Calculate discounts for different deal types
  - `findBestDeals()` - Find all applicable deals for an order
  - `applyBestDeals()` - Apply best deal(s) to order
  - `calculateDealDiscount()` - Calculate discount amount

### 4. **Documentation**
- `DEALS_DOCUMENTATION.md` - Complete guide with examples
- `DEALS_SYSTEM_SUMMARY.md` - This file
- `examples/dealIntegrationExample.js` - Integration examples

### 5. **Updates**
- `models/Order.js` - Added `appliedDeals` array to track which deals were used
- `server.js` - Added deal routes

## Quick Start

### 1. Create a Deal

```bash
POST /api/deals
Authorization: Bearer <your-token>

{
  "name": "Happy Hour - 20% Off Drinks",
  "description": "20% off all drinks from 4 PM to 7 PM",
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 20,
  "applicableCategories": ["<drinks-category-id>"],
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-12-31T23:59:59Z",
  "startTime": "16:00",
  "endTime": "19:00",
  "isActive": true,
  "showOnWebsite": true,
  "badgeText": "HAPPY HOUR"
}
```

### 2. Get Active Deals

```bash
GET /api/deals/active?restaurantId=<restaurant-id>&branchId=<branch-id>
```

### 3. Apply Deals in Order Processing

```javascript
const { findBestDeals, applyBestDeals } = require('./utils/dealCalculator');

// Find applicable deals
const availableDeals = await findBestDeals(
  restaurantId,
  branchId,
  orderItems,
  subtotal,
  customerId
);

// Apply best deal
const { totalDiscount, appliedDeals } = applyBestDeals(availableDeals);

// Create order with discount
const order = await Order.create({
  // ... other fields
  subtotal: subtotal,
  discountAmount: totalDiscount,
  appliedDeals: appliedDeals.map(ad => ({
    deal: ad.deal._id,
    dealName: ad.deal.name,
    dealType: ad.dealType,
    discountAmount: ad.discountAmount
  })),
  total: subtotal - totalDiscount
});

// Record usage
for (const ad of appliedDeals) {
  await DealUsage.recordUsage(ad.deal._id, customerId, order._id, ad.discountAmount);
  await ad.deal.incrementUsage();
}
```

## Common Use Cases

### 1. **Happy Hour Special**
```json
{
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 25,
  "startTime": "16:00",
  "endTime": "19:00",
  "daysOfWeek": [1, 2, 3, 4, 5]
}
```

### 2. **Lunch Combo**
```json
{
  "dealType": "COMBO",
  "comboItems": [
    { "menuItem": "sandwich-id", "quantity": 1 },
    { "menuItem": "chips-id", "quantity": 1 },
    { "menuItem": "drink-id", "quantity": 1 }
  ],
  "comboPrice": 8.99
}
```

### 3. **First-Time Customer**
```json
{
  "dealType": "FIXED_DISCOUNT",
  "discountAmount": 10,
  "maxUsagePerCustomer": 1,
  "badgeText": "NEW CUSTOMER"
}
```

### 4. **Weekend Special**
```json
{
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 15,
  "daysOfWeek": [0, 6],
  "badgeText": "WEEKEND DEAL"
}
```

### 5. **Flash Sale**
```json
{
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 50,
  "maxTotalUsage": 100,
  "priority": 100,
  "badgeText": "FLASH SALE"
}
```

## API Testing with cURL

```bash
# Create a deal
curl -X POST http://localhost:5000/api/deals \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "Test Deal",
    "dealType": "PERCENTAGE_DISCOUNT",
    "discountPercentage": 20,
    "startDate": "2026-02-01T00:00:00Z",
    "endDate": "2026-12-31T23:59:59Z",
    "isActive": true
  }'

# Get all deals
curl http://localhost:5000/api/deals \
  -H "Authorization: Bearer YOUR_TOKEN"

# Get active deals (no auth required)
curl http://localhost:5000/api/deals/active?restaurantId=YOUR_RESTAURANT_ID

# Get deal usage stats
curl http://localhost:5000/api/deals/DEAL_ID/usage \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Next Steps

1. **Test the endpoints** - Use Postman or cURL to create test deals
2. **Integrate with POS** - Add deal selection to your POS order flow
3. **Website integration** - Display active deals on customer-facing website
4. **Admin UI** - Build management screens for creating/editing deals
5. **Reports** - Use the analytics endpoints to track deal performance

## Key Features

- ✅ Automatic deal discovery based on order contents
- ✅ Customer usage tracking and limits
- ✅ Time and day restrictions
- ✅ Branch-specific targeting
- ✅ Deal priority system
- ✅ Stacking support
- ✅ Usage analytics and reporting
- ✅ Historical deal records in orders

## Support for Future Features

The system is designed to easily support:
- Coupon codes (add a `code` field to Deal model)
- Customer segment targeting (add `customerSegment` field)
- Product recommendations based on deals
- A/B testing different deals
- Automated deal scheduling

---

For detailed examples and complete API documentation, see `DEALS_DOCUMENTATION.md`.
