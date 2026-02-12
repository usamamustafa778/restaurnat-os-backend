# Branch-Aware Menu System - Implementation Summary

## Problem Identified

The frontend was displaying restaurant-wide categories and menu items without considering branch-specific variations in:
- **Pricing** (different branches may have different prices)
- **Availability** (items may be unavailable at certain locations)
- **Inventory** (stock levels are branch-specific)

## Solution Implemented

Created a comprehensive branch-aware menu system that merges base restaurant data with branch-specific overrides.

---

## Files Created

### 1. **Core Utility** (`utils/branchMenuHelper.js`)

Helper functions for merging branch data:

- `getBranchMenu()` - Get all menu items with branch overrides applied
- `getBranchMenuByCategory()` - Get menu grouped by categories
- `getBranchMenuItem()` - Get single item with branch data
- `setBranchPrice()` - Set custom price for a branch
- `setBranchAvailability()` - Toggle item availability at branch
- `clearBranchOverride()` - Revert to base values
- `getBranchExclusiveItems()` - Find items only at specific branch

**Key Features:**
- Automatic merging of base MenuItem + BranchMenuItem
- Branch inventory stock checking
- Falls back to base values when no override exists

---

### 2. **API Routes** (`routes/menuRoutes.js`)

New RESTful endpoints for branch-aware menu access:

**Public Endpoints:**
```
GET  /api/menu/branch/:branchId/by-category          # Menu for specific branch
GET  /api/menu/branch/:branchId/item/:itemId         # Single item with branch data
GET  /api/menu/branch/:branchId/exclusive            # Branch-exclusive items
GET  /api/menu/restaurant/:restaurantId/by-category  # Base menu (no overrides)
```

**Admin Endpoints (Auth Required):**
```
POST   /api/menu/branch/:branchId/item/:itemId/price         # Set custom price
POST   /api/menu/branch/:branchId/item/:itemId/availability  # Toggle availability
DELETE /api/menu/branch/:branchId/item/:itemId/override      # Clear override
POST   /api/menu/branch/:branchId/bulk-update                # Bulk updates
```

---

### 3. **Documentation**

**`BRANCH_MENU_API.md`** - Complete API reference
- Detailed endpoint documentation
- Request/response examples
- Frontend integration examples (React)
- Admin/POS code examples
- Migration guide from old endpoints

**`BRANCH_MENU_QUICK_START.md`** - Quick reference guide
- Copy-paste code examples
- Common scenarios
- Troubleshooting tips
- Testing checklist

---

### 4. **Server Integration**

Updated `server.js`:
```javascript
const menuRoutes = require('./routes/menuRoutes');
app.use('/api/menu', menuRoutes);
```

---

## How It Works

### Data Structure

**Base Menu Item (Restaurant Level):**
```javascript
{
  _id: "item123",
  restaurant: "rest456",
  name: "Classic Burger",
  price: 10.99,           // Base price
  available: true,        // Base availability
  category: "cat789",
  // ... other fields
}
```

**Branch Override (Optional):**
```javascript
{
  branch: "branch111",
  menuItem: "item123",
  priceOverride: 12.99,   // Custom price for this branch
  available: true         // Custom availability for this branch
}
```

**Merged Result (What Frontend Gets):**
```javascript
{
  _id: "item123",
  name: "Classic Burger",
  price: 10.99,                    // Original base price
  available: true,                 // Original base availability
  finalPrice: 12.99,               // ⭐ Actual price at this branch
  finalAvailable: true,            // ⭐ Actual availability at this branch
  hasBranchOverride: true,
  branchOverride: {
    priceOverride: 12.99,
    available: true
  },
  // ... other fields
}
```

---

## Frontend Usage Examples

### Display Menu for a Branch

```javascript
const branchId = '507f1f77bcf86cd799439011';
const restaurantId = '507f1f77bcf86cd799439012';

// Fetch menu
const response = await fetch(
  `/api/menu/branch/${branchId}/by-category?restaurantId=${restaurantId}`
);
const categories = await response.json();

// Display
categories.forEach(category => {
  console.log(`\n${category.name}:`);
  category.items.forEach(item => {
    const priceTag = `$${item.finalPrice.toFixed(2)}`;
    const badge = item.hasBranchOverride ? ' [Special Price]' : '';
    console.log(`  - ${item.name}: ${priceTag}${badge}`);
  });
});
```

**Output:**
```
Burgers:
  - Classic Burger: $12.99 [Special Price]
  - Cheese Burger: $13.99 [Special Price]
  - Veggie Burger: $11.99

Sides:
  - French Fries: $3.99
  - Onion Rings: $4.99
```

---

### Admin: Set Branch-Specific Price

```javascript
const token = 'your-auth-token';

// Set custom price for downtown location
await fetch('/api/menu/branch/downtown-branch-id/item/burger-id/price', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({ priceOverride: 15.99 })
});

// Result: Burger now costs $15.99 at downtown location
```

---

### POS: Toggle Availability

```javascript
// Mark item as out of stock at current branch
await fetch('/api/menu/branch/current-branch-id/item/item-id/availability', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({ available: false })
});
```

---

## Key Benefits

### ✅ For Customers
- See accurate pricing for selected location
- Only see items actually available at that branch
- "Only at this location" badges for exclusive items

### ✅ For Restaurant Owners
- Adjust prices per location (higher rent = higher prices)
- Enable/disable items per branch (small kiosk = limited menu)
- Track which items are popular at which locations

### ✅ For POS Staff
- Quick availability toggles
- Real-time inventory integration
- Branch-specific menu management

### ✅ For Developers
- Clean, RESTful API
- Backward compatible (base menu still available)
- Helper functions for easy integration
- Comprehensive documentation

---

## Use Cases

### 1. Multi-Location Pricing
**Scenario:** Downtown location has higher rent
```javascript
// Downtown branch
await setBranchPrice(downtownId, burgerId, 15.99, token);

// Suburban branch  
await setBranchPrice(suburbanId, burgerId, 11.99, token);

// Base price stays at $13.50 for any new branches
```

### 2. Limited Menu at Kiosks
**Scenario:** Small kiosk only serves simple items
```javascript
// Disable complex items at kiosk
await setBranchAvailability(kioskId, steakId, false, token);
await setBranchAvailability(kioskId, pastaId, false, token);

// Simple items remain available
```

### 3. Seasonal Items
**Scenario:** Pumpkin spice latte only at certain locations
```javascript
// Enable at participating locations
await setBranchAvailability(mainBranchId, pslId, true, token);
await setBranchAvailability(downtownId, pslId, true, token);

// Disable at others
await setBranchAvailability(kioskId, pslId, false, token);
```

### 4. Dynamic Pricing
**Scenario:** Happy hour pricing at bar location
```javascript
// Temporarily reduce prices during happy hour
await setBranchPrice(barBranchId, beerId, 3.99, token); // Was $5.99

// Later, revert to normal
await clearBranchOverride(barBranchId, beerId);
```

---

## Migration Path

### Old Way (Restaurant-Wide Only)
```javascript
// ❌ No branch context
fetch('/api/menu?restaurantId=123')
  .then(res => res.json())
  .then(menu => {
    // All items show same price/availability
  });
```

### New Way (Branch-Aware)
```javascript
// ✅ Branch-specific data
fetch('/api/menu/branch/branch-id/by-category?restaurantId=123')
  .then(res => res.json())
  .then(categories => {
    // Each item has finalPrice and finalAvailable for this branch
  });
```

**Note:** Old endpoints still work for backward compatibility!

---

## Testing

### Manual Testing
```bash
# Get menu for a branch
curl "http://localhost:5000/api/menu/branch/BRANCH_ID/by-category?restaurantId=REST_ID"

# Set custom price
curl -X POST http://localhost:5000/api/menu/branch/BRANCH_ID/item/ITEM_ID/price \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"priceOverride": 12.99}'

# Toggle availability
curl -X POST http://localhost:5000/api/menu/branch/BRANCH_ID/item/ITEM_ID/availability \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"available": false}'
```

### Integration Testing Checklist
- [ ] Menu loads with branch-specific pricing
- [ ] Price overrides display correctly
- [ ] Unavailable items are hidden/marked
- [ ] Admin can set custom prices
- [ ] Admin can toggle availability
- [ ] Clearing override reverts to base values
- [ ] Inventory integration works
- [ ] Multiple branches show different data

---

## Performance Considerations

### Optimizations Included
- ✅ Lean queries (`.lean()`) for better performance
- ✅ Efficient Map lookups for merging data
- ✅ Single database query per entity type
- ✅ Indexed fields (branch, menuItem) for fast lookups

### Frontend Recommendations
- Cache menu data (5-10 minute TTL)
- Lazy load item images
- Use skeleton loaders during fetch
- Debounce availability toggles

---

## Future Enhancements (Possible)

1. **Time-based pricing** - Automatically adjust prices during peak hours
2. **Location-based deals** - Integrate with deals system per branch
3. **Menu scheduling** - Breakfast/lunch/dinner menus per branch
4. **A/B testing** - Test different prices at different locations
5. **Analytics** - Track which items sell best at which branches
6. **Bulk price adjustments** - Apply percentage changes across branches

---

## Files Summary

```
✅ utils/branchMenuHelper.js       - Core merge logic
✅ routes/menuRoutes.js             - API endpoints  
✅ server.js                        - Route registration
✅ BRANCH_MENU_API.md              - Full API documentation
✅ BRANCH_MENU_QUICK_START.md      - Quick reference guide
✅ BRANCH_MENU_SUMMARY.md          - This file
```

---

## What's Next?

### For Frontend Team:
1. Update customer website to use `/api/menu/branch/:branchId/by-category`
2. Add branch selector to menu pages
3. Display price badges when `hasBranchOverride` is true
4. Show "Unavailable" badge when `finalAvailable` is false

### For Admin/POS Team:
1. Add branch price management UI
2. Add quick availability toggle buttons
3. Show which items have branch-specific overrides
4. Implement bulk update interface

### For Backend Team:
1. Monitor API performance
2. Add caching if needed
3. Set up analytics tracking
4. Consider time-based pricing features

---

**Your menu system is now fully branch-aware! 🎉**

Each branch can have its own pricing, availability, and inventory management while maintaining a centralized base menu.
