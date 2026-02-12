# Deals & Promotions System Documentation

## Overview

The deals system supports various types of restaurant promotions with flexible configuration options including time restrictions, usage limits, and branch-specific targeting.

## Deal Types

### 1. PERCENTAGE_DISCOUNT

Apply a percentage discount to the entire order or specific items/categories.

**Example: 20% off all pizzas**

```json
{
  "name": "20% Off All Pizzas",
  "description": "Get 20% off any pizza on our menu",
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 20,
  "applicableCategories": ["<pizza-category-id>"],
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-02-28T23:59:59Z",
  "isActive": true,
  "showOnWebsite": true,
  "badgeText": "SAVE 20%"
}
```

**Example: 15% off entire order**

```json
{
  "name": "15% Off Your Order",
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 15,
  "applicableMenuItems": [],
  "applicableCategories": [],
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-03-01T23:59:59Z",
  "isActive": true
}
```

---

### 2. FIXED_DISCOUNT

Apply a fixed dollar amount discount to the order or specific items.

**Example: $5 off any burger**

```json
{
  "name": "$5 Off Any Burger",
  "dealType": "FIXED_DISCOUNT",
  "discountAmount": 5,
  "applicableCategories": ["<burger-category-id>"],
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-02-28T23:59:59Z",
  "isActive": true
}
```

---

### 3. COMBO

Bundle multiple items together at a special price.

**Example: Burger + Fries + Drink for $12**

```json
{
  "name": "Meal Deal",
  "description": "Burger, Fries, and Drink combo",
  "dealType": "COMBO",
  "comboItems": [
    {
      "menuItem": "<burger-menu-item-id>",
      "quantity": 1
    },
    {
      "menuItem": "<fries-menu-item-id>",
      "quantity": 1
    },
    {
      "menuItem": "<drink-menu-item-id>",
      "quantity": 1
    }
  ],
  "comboPrice": 12,
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-12-31T23:59:59Z",
  "isActive": true,
  "imageUrl": "https://example.com/meal-deal.jpg",
  "badgeText": "COMBO DEAL"
}
```

---

### 4. BUY_X_GET_Y

Buy a certain quantity and get items free or at discount.

**Example: Buy 2 Pizzas, Get 1 Free**

```json
{
  "name": "Buy 2 Get 1 Free Pizza",
  "dealType": "BUY_X_GET_Y",
  "buyQuantity": 2,
  "getQuantity": 1,
  "buyMenuItem": "<pizza-menu-item-id>",
  "getMenuItem": "<pizza-menu-item-id>",
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-02-28T23:59:59Z",
  "isActive": true,
  "badgeText": "BUY 2 GET 1 FREE"
}
```

**Example: Buy 1 Burger, Get 1 Fries Free**

```json
{
  "name": "Burger + Free Fries",
  "dealType": "BUY_X_GET_Y",
  "buyQuantity": 1,
  "getQuantity": 1,
  "buyMenuItem": "<burger-menu-item-id>",
  "getMenuItem": "<fries-menu-item-id>",
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-02-28T23:59:59Z",
  "isActive": true
}
```

---

### 5. MINIMUM_PURCHASE

Get a discount when spending above a minimum amount.

**Example: Spend $30, Get $5 Off**

```json
{
  "name": "Spend $30, Get $5 Off",
  "dealType": "MINIMUM_PURCHASE",
  "minimumPurchaseAmount": 30,
  "discountAmount": 5,
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-02-28T23:59:59Z",
  "isActive": true
}
```

---

## Time-Based Restrictions

### Happy Hour (Time of Day)

**Example: 20% off from 4 PM to 7 PM**

```json
{
  "name": "Happy Hour Special",
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 20,
  "applicableCategories": ["<drinks-category-id>"],
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-12-31T23:59:59Z",
  "startTime": "16:00",
  "endTime": "19:00",
  "isActive": true,
  "badgeText": "HAPPY HOUR"
}
```

### Weekend Special (Days of Week)

**Example: 15% off on weekends only**

```json
{
  "name": "Weekend Special",
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 15,
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-12-31T23:59:59Z",
  "daysOfWeek": [0, 6],
  "isActive": true,
  "badgeText": "WEEKEND DEAL"
}
```

**Note:** `daysOfWeek` uses 0 = Sunday, 1 = Monday, ..., 6 = Saturday

---

## Branch-Specific Deals

**Example: Deal available only at specific branches**

```json
{
  "name": "Downtown Location Special",
  "dealType": "FIXED_DISCOUNT",
  "discountAmount": 10,
  "branches": ["<branch-1-id>", "<branch-2-id>"],
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-02-28T23:59:59Z",
  "isActive": true
}
```

**Note:** If `branches` is empty `[]`, the deal applies to all branches.

---

## Usage Limits

### Limit per Customer

```json
{
  "name": "First-Time Customer Deal",
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 25,
  "maxUsagePerCustomer": 1,
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-12-31T23:59:59Z",
  "isActive": true,
  "badgeText": "NEW CUSTOMER"
}
```

### Limit Total Usage

```json
{
  "name": "Limited Time Offer",
  "dealType": "FIXED_DISCOUNT",
  "discountAmount": 5,
  "maxTotalUsage": 100,
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-02-28T23:59:59Z",
  "isActive": true,
  "badgeText": "LIMITED OFFER"
}
```

---

## API Endpoints

### Create Deal

```bash
POST /api/deals
Authorization: Bearer <token>

{
  "name": "20% Off Pizzas",
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 20,
  "applicableCategories": ["<category-id>"],
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-02-28T23:59:59Z",
  "isActive": true
}
```

### Get All Deals

```bash
GET /api/deals
GET /api/deals?isActive=true
GET /api/deals?dealType=COMBO
GET /api/deals?branchId=<branch-id>
GET /api/deals?showOnWebsite=true
```

### Get Active Deals (Currently Valid)

```bash
GET /api/deals/active?restaurantId=<restaurant-id>&branchId=<branch-id>
```

This endpoint returns only deals that are:
- Active (`isActive: true`)
- Within date range
- Matching current time of day (if `startTime`/`endTime` set)
- Matching current day of week (if `daysOfWeek` set)
- Not exceeding usage limits

### Get Single Deal

```bash
GET /api/deals/:id
```

### Update Deal

```bash
PUT /api/deals/:id
Authorization: Bearer <token>

{
  "discountPercentage": 25,
  "isActive": true
}
```

### Delete Deal

```bash
DELETE /api/deals/:id
Authorization: Bearer <token>
```

### Toggle Deal Active Status

```bash
POST /api/deals/:id/toggle
Authorization: Bearer <token>
```

### Get Deal Usage Statistics

```bash
GET /api/deals/:id/usage
Authorization: Bearer <token>
```

Returns:
```json
{
  "deal": { ... },
  "statistics": {
    "totalUsage": 45,
    "totalDiscountGiven": 225.50,
    "uniqueCustomers": 38,
    "averageDiscountPerUse": 5.01
  },
  "usageRecords": [...]
}
```

### Check Deal Eligibility

```bash
POST /api/deals/:id/check-eligibility
Authorization: Bearer <token>

{
  "customerId": "<customer-id>"
}
```

Returns:
```json
{
  "eligible": true,
  "currentUsage": 2,
  "remainingUses": 1
}
```

---

## Using Deals in Order Processing

### 1. Find Best Deals for an Order

```javascript
const { findBestDeals, applyBestDeals } = require('../utils/dealCalculator');

// Example order items
const orderItems = [
  {
    menuItem: '<burger-id>',
    category: '<burger-category-id>',
    quantity: 2,
    price: 10.99
  },
  {
    menuItem: '<fries-id>',
    category: '<sides-category-id>',
    quantity: 1,
    price: 3.99
  }
];

const subtotal = 25.97;

// Find all applicable deals
const availableDeals = await findBestDeals(
  restaurantId,
  branchId,
  orderItems,
  subtotal,
  customerId // optional
);

// Apply best deal(s)
const { totalDiscount, appliedDeals } = applyBestDeals(
  availableDeals,
  false // allowStacking - set to true to apply multiple deals
);

const finalTotal = subtotal - totalDiscount;
```

### 2. Record Deal Usage

```javascript
const DealUsage = require('../models/DealUsage');
const Deal = require('../models/Deal');

// After order is confirmed
for (const appliedDeal of appliedDeals) {
  // Record usage
  await DealUsage.recordUsage(
    appliedDeal.deal._id,
    customerId,
    orderId,
    appliedDeal.discountAmount
  );

  // Increment deal usage count
  await appliedDeal.deal.incrementUsage();
}
```

---

## Advanced Examples

### Flash Sale (Limited Time + Limited Quantity)

```json
{
  "name": "Flash Sale - 50% Off",
  "description": "First 50 customers only!",
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 50,
  "startDate": "2026-02-14T12:00:00Z",
  "endDate": "2026-02-14T14:00:00Z",
  "maxTotalUsage": 50,
  "isActive": true,
  "priority": 100,
  "badgeText": "FLASH SALE",
  "showOnWebsite": true
}
```

### Lunch Special (Weekdays, 11 AM - 2 PM)

```json
{
  "name": "Lunch Special",
  "dealType": "COMBO",
  "comboItems": [
    { "menuItem": "<sandwich-id>", "quantity": 1 },
    { "menuItem": "<chips-id>", "quantity": 1 },
    { "menuItem": "<drink-id>", "quantity": 1 }
  ],
  "comboPrice": 8.99,
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-12-31T23:59:59Z",
  "startTime": "11:00",
  "endTime": "14:00",
  "daysOfWeek": [1, 2, 3, 4, 5],
  "isActive": true,
  "badgeText": "LUNCH DEAL"
}
```

### Loyalty Reward (Customer-Specific Limit)

```json
{
  "name": "Loyalty Reward",
  "description": "Use 3 times per month",
  "dealType": "FIXED_DISCOUNT",
  "discountAmount": 5,
  "maxUsagePerCustomer": 3,
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-02-28T23:59:59Z",
  "isActive": true,
  "showOnPOS": true,
  "showOnWebsite": false
}
```

### Stackable Deals

```json
[
  {
    "name": "Student Discount",
    "dealType": "PERCENTAGE_DISCOUNT",
    "discountPercentage": 10,
    "canStackWithOtherDeals": true,
    "startDate": "2026-02-01T00:00:00Z",
    "endDate": "2026-12-31T23:59:59Z",
    "isActive": true
  },
  {
    "name": "First Order Bonus",
    "dealType": "FIXED_DISCOUNT",
    "discountAmount": 5,
    "canStackWithOtherDeals": true,
    "maxUsagePerCustomer": 1,
    "startDate": "2026-02-01T00:00:00Z",
    "endDate": "2026-12-31T23:59:59Z",
    "isActive": true
  }
]
```

When both are applicable and stacking is enabled, both discounts will apply.

---

## Deal Priority

Use the `priority` field (higher = applied first) when multiple deals might conflict:

```json
{
  "name": "Super Sale",
  "dealType": "PERCENTAGE_DISCOUNT",
  "discountPercentage": 30,
  "priority": 10,
  "canStackWithOtherDeals": false,
  "startDate": "2026-02-01T00:00:00Z",
  "endDate": "2026-02-28T23:59:59Z",
  "isActive": true
}
```

---

## Integration Checklist

- [ ] Add deal routes to `server.js`
- [ ] Update Order model to track applied deals
- [ ] Integrate deal calculator in order processing
- [ ] Add deal selection UI in POS system
- [ ] Display active deals on customer website
- [ ] Add deal management screens in admin panel
- [ ] Test each deal type thoroughly
- [ ] Set up automated deal expiration notifications

---

## Testing Examples

### Test Data Creation

```javascript
// Create a test deal
const testDeal = await Deal.create({
  restaurant: restaurantId,
  name: "Test 20% Off",
  dealType: "PERCENTAGE_DISCOUNT",
  discountPercentage: 20,
  startDate: new Date(),
  endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
  isActive: true
});

// Test deal calculation
const result = calculateDealDiscount(testDeal, orderItems, subtotal);
console.log(result);
// { discountAmount: 5.99, dealApplied: true, dealType: 'PERCENTAGE_DISCOUNT' }
```

---

## Notes

1. **Date Handling**: All dates are stored in UTC. Make sure to convert to local timezone when displaying to users.

2. **Performance**: Deals are indexed on `restaurant`, `isActive`, `startDate`, and `endDate` for fast queries.

3. **Validation**: The model includes built-in validation for time formats (HH:mm) and day of week values (0-6).

4. **Combo Deals**: When creating combo deals, ensure all referenced menu items exist and are active.

5. **Usage Tracking**: Deal usage is automatically tracked in the `DealUsage` model for reporting and limits.

6. **Stacking**: By default, only the best single deal is applied. Enable `canStackWithOtherDeals` carefully.

7. **Branch Filtering**: Empty `branches` array means the deal applies to all branches.

---

## Future Enhancements

- Coupon codes integration
- Customer segment targeting (new vs returning)
- Automatic deal recommendations based on order contents
- A/B testing for deals
- Deal performance analytics dashboard
