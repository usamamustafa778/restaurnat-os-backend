# Branch-Aware Menu - Quick Start Guide

## Problem Solved

Previously, categories and menu items were restaurant-wide only. Now each branch can have:
- **Custom pricing** (Downtown location charges more, suburbs charge less)
- **Different availability** (Some items only at certain locations)
- **Branch-specific inventory** (Out of stock at one location, available at another)
- **Automatic availability** (Items available everywhere by default, no manual setup!) ⭐

---

## 💡 Key Feature: availableAtAllBranches

**Most items are automatically available at all branches!** No need to manually configure each item at each branch.

```javascript
// Regular item - available everywhere by default
{
  name: "Classic Burger",
  availableAtAllBranches: true  // ✅ Default - no branch setup needed!
}

// Specialty item - only at specific locations
{
  name: "Downtown Signature Pizza",
  availableAtAllBranches: false  // Must explicitly enable per branch
}
```

📖 [Full documentation](./AVAILABLE_AT_ALL_BRANCHES.md)

---

## 🚀 Quick Start (Frontend Developers)

### 1. Display Menu for a Specific Branch

**Before (Old way - NOT branch-aware):**
```javascript
// ❌ This doesn't consider branch pricing or availability
const response = await fetch('/api/menu?restaurantId=123');
```

**After (New way - Branch-aware):**
```javascript
// ✅ Gets menu with branch-specific pricing and availability
const branchId = 'abc123';
const restaurantId = 'xyz789';

const response = await fetch(
  `/api/menu/branch/${branchId}/by-category?restaurantId=${restaurantId}`
);

const categories = await response.json();

// Each item now has:
categories.forEach(cat => {
  cat.items.forEach(item => {
    console.log(item.name);
    console.log('Base price:', item.price);           // Original restaurant price
    console.log('Branch price:', item.finalPrice);    // Actual price at this branch ⭐
    console.log('Available:', item.finalAvailable);   // True if in stock at this branch ⭐
    console.log('Has override:', item.hasBranchOverride);
  });
});
```

---

### 2. Single Item with Branch Data

```javascript
const itemId = 'item123';
const branchId = 'branch456';

const response = await fetch(`/api/menu/branch/${branchId}/item/${itemId}`);
const item = await response.json();

// Display
console.log(`${item.name} - $${item.finalPrice}`);
if (item.hasBranchOverride) {
  console.log('Special pricing at this location!');
}
```

---

### 3. React Component Example

```jsx
import { useState, useEffect } from 'react';

function BranchMenu({ branchId, restaurantId }) {
  const [menu, setMenu] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/menu/branch/${branchId}/by-category?restaurantId=${restaurantId}`)
      .then(res => res.json())
      .then(data => {
        setMenu(data);
        setLoading(false);
      });
  }, [branchId, restaurantId]);

  if (loading) return <div>Loading menu...</div>;

  return (
    <div className="menu">
      {menu.map(category => (
        <div key={category._id} className="category">
          <h2>{category.name}</h2>
          <div className="items">
            {category.items.map(item => (
              <div key={item._id} className="menu-item">
                <div className="item-header">
                  <h3>{item.name}</h3>
                  <span className="price">${item.finalPrice.toFixed(2)}</span>
                </div>
                
                <p>{item.description}</p>
                
                {/* Show if price is different at this branch */}
                {item.hasBranchOverride && item.finalPrice !== item.price && (
                  <span className="badge badge-info">
                    Special Price (Usually ${item.price.toFixed(2)})
                  </span>
                )}
                
                {/* Show if unavailable at this branch */}
                {!item.finalAvailable && (
                  <span className="badge badge-danger">
                    Not Available at This Location
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default BranchMenu;
```

---

## 🛠️ Admin/POS Quick Actions

### Set Custom Price for a Branch

```javascript
async function setBranchPrice(branchId, itemId, newPrice, token) {
  const response = await fetch(
    `/api/menu/branch/${branchId}/item/${itemId}/price`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        priceOverride: newPrice  // or null to revert to base price
      })
    }
  );
  
  return response.json();
}

// Usage
await setBranchPrice('branch123', 'item456', 15.99, authToken);
```

### Toggle Item Availability

```javascript
async function toggleAvailability(branchId, itemId, available, token) {
  const response = await fetch(
    `/api/menu/branch/${branchId}/item/${itemId}/availability`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ available })
    }
  );
  
  return response.json();
}

// Mark item as unavailable
await toggleAvailability('branch123', 'item456', false, authToken);
```

---

## 📊 Common Scenarios

### Scenario 1: Different Pricing by Location

**Downtown Branch** (higher rent, higher prices):
```javascript
// Set burger price to $15 at downtown location
await setBranchPrice(downtownBranchId, burgerId, 15.00, token);
```

**Suburban Branch** (lower rent, lower prices):
```javascript
// Set burger price to $12 at suburban location
await setBranchPrice(suburbanBranchId, burgerId, 12.00, token);
```

**Customer sees:**
- Downtown: $15.00
- Suburban: $12.00
- Base price remains $13.50 (can be used for new branches)

---

### Scenario 2: Limited Menu at Certain Locations

**Small Kiosk** (limited menu):
```javascript
// Disable complex items at kiosk
await toggleAvailability(kioskBranchId, steakId, false, token);
await toggleAvailability(kioskBranchId, pastaId, false, token);

// Only simple items available
await toggleAvailability(kioskBranchId, burgerId, true, token);
await toggleAvailability(kioskBranchId, friesId, true, token);
```

---

### Scenario 3: "Only at This Location" Items

```javascript
// Get exclusive items for a branch
const response = await fetch(
  `/api/menu/branch/${branchId}/exclusive?restaurantId=${restaurantId}`
);

const exclusiveItems = await response.json();

// Display with badge
exclusiveItems.forEach(item => {
  console.log(`${item.name} - Only at ${branchName}!`);
});
```

---

## 🔄 Data Flow

```
User selects branch
       ↓
Frontend requests: GET /api/menu/branch/{branchId}/by-category
       ↓
Backend loads:
  1. Base MenuItem (restaurant level)
  2. BranchMenuItem override (if exists)
  3. BranchInventory (stock check)
       ↓
Backend merges:
  - finalPrice = branchOverride.price OR baseItem.price
  - finalAvailable = branchOverride.available AND hasStock
       ↓
Frontend displays merged data
```

---

## ⚠️ Important Notes

### Always Use These Fields:

```javascript
// ✅ CORRECT
const price = item.finalPrice;        // Actual price at branch
const available = item.finalAvailable; // Actually available at branch

// ❌ WRONG
const price = item.price;              // Base price (might not be correct)
const available = item.available;      // Base availability (might not be correct)
```

### Check Override Status:

```javascript
if (item.hasBranchOverride) {
  // This item has custom pricing or availability at this branch
  console.log('Custom settings for this location');
}
```

---

## 📋 API Endpoints Summary

### Public (No Auth Required)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/menu/branch/:branchId/by-category` | Get menu grouped by categories for a branch |
| `GET /api/menu/branch/:branchId/item/:itemId` | Get single item with branch data |
| `GET /api/menu/branch/:branchId/exclusive` | Get items only available at this branch |
| `GET /api/menu/restaurant/:restaurantId/by-category` | Get base menu (no branch overrides) |

### Admin (Auth Required)

| Endpoint | Purpose |
|----------|---------|
| `POST /api/menu/branch/:branchId/item/:itemId/price` | Set custom price |
| `POST /api/menu/branch/:branchId/item/:itemId/availability` | Set availability |
| `DELETE /api/menu/branch/:branchId/item/:itemId/override` | Clear all overrides |
| `POST /api/menu/branch/:branchId/bulk-update` | Update multiple items at once |

---

## 🧪 Testing Checklist

- [ ] Menu displays different prices for different branches
- [ ] Items unavailable at one branch don't show at that branch
- [ ] "Only at this location" badge works
- [ ] Price changes in admin reflect immediately on customer site
- [ ] Availability toggles work in POS
- [ ] Out of stock items are marked unavailable
- [ ] Clearing override reverts to base price/availability

---

## 🆘 Troubleshooting

### Item showing wrong price?
Make sure you're using `item.finalPrice`, not `item.price`

### Item showing as available but shouldn't be?
Check:
1. Branch override availability
2. Branch inventory stock levels

### Changes not reflecting?
Clear browser cache or force refresh (Ctrl+F5)

### Getting 400 error?
Make sure to include `restaurantId` in query parameters

---

## 📚 Full Documentation

For complete API documentation with all options:
- See `BRANCH_MENU_API.md` for detailed API reference
- See `utils/branchMenuHelper.js` for helper functions

---

## 💡 Pro Tips

1. **Cache menu data** - Menus don't change frequently, cache for 5-10 minutes
2. **Preload branch list** - Let users select branch before loading menu
3. **Show price badges** - Highlight when price differs from base
4. **Use skeleton loaders** - Better UX while menu loads
5. **Lazy load images** - Don't load all item images at once

---

**You're all set! Your frontend is now branch-aware! 🎉**
