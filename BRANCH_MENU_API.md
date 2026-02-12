# Branch-Aware Menu API Documentation

## Overview

The new menu API provides branch-specific pricing, availability, and inventory management. Each branch can override the base restaurant menu with custom prices and availability settings.

## Key Concepts

### Base Menu Items
- Defined at the **restaurant level**
- Have a base price and availability
- Can be linked to inventory items

### Branch Overrides
- Each branch can override:
  - **Price** (`priceOverride`) - Custom pricing for this branch
  - **Availability** (`available`) - Enable/disable items per branch
- Inventory is checked at the **branch level** via `BranchInventory`

### Response Format

All branch-aware endpoints return items with merged data:

```json
{
  "_id": "item-id",
  "name": "Classic Burger",
  "description": "Our signature burger",
  "price": 10.99,              // Base price
  "available": true,            // Base availability
  "category": {...},
  "finalPrice": 12.99,          // Actual price for this branch (with override)
  "finalAvailable": true,       // Actual availability (considering override + inventory)
  "hasBranchOverride": true,
  "branchOverride": {
    "priceOverride": 12.99,
    "available": true
  }
}
```

---

## Frontend API Endpoints

### 1. Get Menu for a Specific Branch

**Endpoint:** `GET /api/menu/branch/:branchId/by-category`

**Use Case:** Customer website or mobile app showing menu for a specific location

**Query Parameters:**
- `restaurantId` (required) - Restaurant ID
- `activeOnly` (optional, default: `true`) - Only show active categories
- `excludeEmpty` (optional, default: `true`) - Hide categories with no available items

**Response:**
```json
[
  {
    "_id": "category-id",
    "name": "Burgers",
    "description": "Our delicious burgers",
    "isActive": true,
    "items": [
      {
        "_id": "item-id",
        "name": "Classic Burger",
        "price": 10.99,
        "finalPrice": 12.99,
        "finalAvailable": true,
        "hasBranchOverride": true,
        "category": {...},
        "imageUrl": "...",
        "isFeatured": false
      }
    ]
  }
]
```

**Example Request:**
```javascript
// Fetch menu for a specific branch
const branchId = '507f1f77bcf86cd799439011';
const restaurantId = '507f1f77bcf86cd799439012';

const response = await fetch(
  `/api/menu/branch/${branchId}/by-category?restaurantId=${restaurantId}`
);
const categories = await response.json();

// Display on frontend
categories.forEach(category => {
  console.log(`Category: ${category.name}`);
  category.items.forEach(item => {
    console.log(`  - ${item.name}: $${item.finalPrice}`);
    if (item.hasBranchOverride) {
      console.log(`    (Original: $${item.price})`);
    }
  });
});
```

---

### 2. Get Single Item with Branch Data

**Endpoint:** `GET /api/menu/branch/:branchId/item/:itemId`

**Use Case:** Item detail page showing branch-specific pricing

**Response:**
```json
{
  "_id": "item-id",
  "name": "Classic Burger",
  "description": "Our signature burger with special sauce",
  "price": 10.99,
  "finalPrice": 12.99,
  "finalAvailable": true,
  "hasBranchOverride": true,
  "branchOverride": {
    "priceOverride": 12.99,
    "available": true
  },
  "category": {...},
  "imageUrl": "...",
  "inventoryConsumptions": [...]
}
```

**Example Request:**
```javascript
const branchId = '507f1f77bcf86cd799439011';
const itemId = '507f1f77bcf86cd799439013';

const response = await fetch(`/api/menu/branch/${branchId}/item/${itemId}`);
const item = await response.json();

console.log(`${item.name} at this location: $${item.finalPrice}`);
```

---

### 3. Get Branch-Exclusive Items

**Endpoint:** `GET /api/menu/branch/:branchId/exclusive`

**Use Case:** Show "Only at this location" items

**Query Parameters:**
- `restaurantId` (required)

**Response:**
```json
[
  {
    "_id": "item-id",
    "name": "Downtown Special Pizza",
    "finalPrice": 15.99,
    "finalAvailable": true,
    // ... other item fields
  }
]
```

**Example Request:**
```javascript
const response = await fetch(
  `/api/menu/branch/${branchId}/exclusive?restaurantId=${restaurantId}`
);
const exclusiveItems = await response.json();

// Display badge
exclusiveItems.forEach(item => {
  console.log(`${item.name} - Only at this location!`);
});
```

---

### 4. Get Base Restaurant Menu (No Branch Data)

**Endpoint:** `GET /api/menu/restaurant/:restaurantId/by-category`

**Use Case:** Admin view or multi-branch display

**Query Parameters:**
- `activeOnly` (optional, default: `true`)
- `excludeEmpty` (optional, default: `true`)

**Response:**
```json
[
  {
    "_id": "category-id",
    "name": "Burgers",
    "items": [
      {
        "_id": "item-id",
        "name": "Classic Burger",
        "price": 10.99,
        "finalPrice": 10.99,        // Same as base price
        "finalAvailable": true,
        "hasBranchOverride": false  // No branch override
      }
    ]
  }
]
```

---

## Admin/POS Endpoints

### 5. Set Branch-Specific Price

**Endpoint:** `POST /api/menu/branch/:branchId/item/:itemId/price`

**Auth Required:** Yes

**Body:**
```json
{
  "priceOverride": 12.99  // or null to use base price
}
```

**Example:**
```javascript
const response = await fetch(
  `/api/menu/branch/${branchId}/item/${itemId}/price`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ priceOverride: 12.99 })
  }
);

const result = await response.json();
console.log(result.message); // "Branch price updated successfully"
```

---

### 6. Set Branch-Specific Availability

**Endpoint:** `POST /api/menu/branch/:branchId/item/:itemId/availability`

**Auth Required:** Yes

**Body:**
```json
{
  "available": false  // true or false
}
```

**Example:**
```javascript
// Mark item as unavailable at this branch
await fetch(
  `/api/menu/branch/${branchId}/item/${itemId}/availability`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ available: false })
  }
);
```

---

### 7. Clear Branch Override

**Endpoint:** `DELETE /api/menu/branch/:branchId/item/:itemId/override`

**Auth Required:** Yes

**Use Case:** Revert to base menu item values

**Example:**
```javascript
// Remove all branch-specific overrides for this item
await fetch(
  `/api/menu/branch/${branchId}/item/${itemId}/override`,
  {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  }
);
```

---

### 8. Bulk Update Branch Overrides

**Endpoint:** `POST /api/menu/branch/:branchId/bulk-update`

**Auth Required:** Yes

**Body:**
```json
{
  "updates": [
    {
      "menuItemId": "item-1-id",
      "priceOverride": 11.99,
      "available": true
    },
    {
      "menuItemId": "item-2-id",
      "priceOverride": null,
      "available": false
    },
    {
      "menuItemId": "item-3-id",
      "available": true
    }
  ]
}
```

**Response:**
```json
{
  "message": "Bulk update completed",
  "results": [
    {
      "menuItemId": "item-1-id",
      "success": true
    },
    {
      "menuItemId": "item-2-id",
      "success": true
    },
    {
      "menuItemId": "item-3-id",
      "success": true
    }
  ]
}
```

---

## Frontend Integration Examples

### Example 1: Branch Selector with Menu

```javascript
import { useState, useEffect } from 'react';

function BranchMenu({ restaurantId }) {
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState(null);
  const [menu, setMenu] = useState([]);

  useEffect(() => {
    // Fetch branches
    fetch(`/api/branches?restaurantId=${restaurantId}`)
      .then(res => res.json())
      .then(data => {
        setBranches(data);
        if (data.length > 0) {
          setSelectedBranch(data[0]._id);
        }
      });
  }, [restaurantId]);

  useEffect(() => {
    if (!selectedBranch) return;

    // Fetch menu for selected branch
    fetch(`/api/menu/branch/${selectedBranch}/by-category?restaurantId=${restaurantId}`)
      .then(res => res.json())
      .then(data => setMenu(data));
  }, [selectedBranch, restaurantId]);

  return (
    <div>
      <select onChange={(e) => setSelectedBranch(e.target.value)} value={selectedBranch}>
        {branches.map(branch => (
          <option key={branch._id} value={branch._id}>
            {branch.name}
          </option>
        ))}
      </select>

      {menu.map(category => (
        <div key={category._id}>
          <h2>{category.name}</h2>
          {category.items.map(item => (
            <div key={item._id}>
              <h3>{item.name}</h3>
              <p>${item.finalPrice.toFixed(2)}</p>
              {item.hasBranchOverride && item.price !== item.finalPrice && (
                <span className="badge">
                  Special price! (Usually ${item.price.toFixed(2)})
                </span>
              )}
              {!item.finalAvailable && (
                <span className="unavailable">Not available</span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

---

### Example 2: Admin Price Management

```javascript
function BranchPriceManager({ branchId, menuItemId, basePrice }) {
  const [customPrice, setCustomPrice] = useState(null);
  const [useCustomPrice, setUseCustomPrice] = useState(false);

  const savePrice = async () => {
    const priceToSave = useCustomPrice ? customPrice : null;
    
    await fetch(`/api/menu/branch/${branchId}/item/${menuItemId}/price`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ priceOverride: priceToSave })
    });

    alert('Price updated!');
  };

  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={useCustomPrice}
          onChange={(e) => setUseCustomPrice(e.target.checked)}
        />
        Use custom price for this branch
      </label>

      {useCustomPrice ? (
        <input
          type="number"
          step="0.01"
          value={customPrice || basePrice}
          onChange={(e) => setCustomPrice(parseFloat(e.target.value))}
        />
      ) : (
        <span>Using base price: ${basePrice.toFixed(2)}</span>
      )}

      <button onClick={savePrice}>Save</button>
    </div>
  );
}
```

---

### Example 3: Quick Availability Toggle (POS)

```javascript
function QuickAvailabilityToggle({ branchId, item }) {
  const [available, setAvailable] = useState(item.finalAvailable);

  const toggleAvailability = async () => {
    const newStatus = !available;
    
    await fetch(`/api/menu/branch/${branchId}/item/${item._id}/availability`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ available: newStatus })
    });

    setAvailable(newStatus);
  };

  return (
    <div className="menu-item">
      <span>{item.name} - ${item.finalPrice.toFixed(2)}</span>
      <button
        onClick={toggleAvailability}
        className={available ? 'btn-success' : 'btn-danger'}
      >
        {available ? '✓ Available' : '✗ Unavailable'}
      </button>
    </div>
  );
}
```

---

## Migration Guide

### For Existing Frontends

If you're currently using the old `/api/menu` endpoint, here's how to migrate:

**Old Way:**
```javascript
// Gets restaurant-wide menu (no branch specificity)
fetch('/api/menu?restaurantId=123')
```

**New Way:**
```javascript
// Gets branch-specific menu with pricing/availability
fetch('/api/menu/branch/BRANCH_ID/by-category?restaurantId=123')
```

### Key Differences

| Old Endpoint | New Endpoint | Difference |
|--------------|--------------|------------|
| `/api/menu` | `/api/menu/branch/:branchId/by-category` | Branch-specific pricing & availability |
| Returns `price` | Returns `finalPrice` | Uses branch override if set |
| Returns `available` | Returns `finalAvailable` | Considers branch override + inventory |
| No branch context | Full branch context | Includes `hasBranchOverride` flag |

---

## Best Practices

### 1. Always Use `finalPrice` and `finalAvailable`

```javascript
// ✅ Good
<div className="price">${item.finalPrice}</div>

// ❌ Bad
<div className="price">${item.price}</div>
```

### 2. Show Price Differences

```javascript
{item.hasBranchOverride && item.price !== item.finalPrice && (
  <span className="price-note">
    Special location pricing (Usually ${item.price})
  </span>
)}
```

### 3. Handle Unavailable Items

```javascript
{!item.finalAvailable && (
  <div className="unavailable-badge">Currently Unavailable</div>
)}
```

### 4. Cache Branch Menu Data

```javascript
// Cache menu for 5 minutes
const cacheKey = `menu-${branchId}`;
const cached = localStorage.getItem(cacheKey);
const cacheTime = localStorage.getItem(`${cacheKey}-time`);

if (cached && Date.now() - cacheTime < 5 * 60 * 1000) {
  return JSON.parse(cached);
}

// Fetch fresh data...
```

---

## Common Use Cases

### Customer Website
- Use `GET /api/menu/branch/:branchId/by-category` with `restaurantId`
- Show `finalPrice` and check `finalAvailable`
- Display "Only at this location" badge for exclusive items

### Mobile App
- Same as website
- Store selected branch in app state
- Refresh menu when branch changes

### POS System
- Use availability toggles: `POST /api/menu/branch/:branchId/item/:itemId/availability`
- Quick price adjustments: `POST /api/menu/branch/:branchId/item/:itemId/price`
- Bulk updates for daily specials

### Admin Dashboard
- Use base menu endpoints: `GET /api/menu/restaurant/:restaurantId/by-category`
- Show which branches have overrides
- Manage pricing across all branches

---

## Testing

```bash
# Get menu for branch
curl http://localhost:5000/api/menu/branch/BRANCH_ID/by-category?restaurantId=REST_ID

# Get single item
curl http://localhost:5000/api/menu/branch/BRANCH_ID/item/ITEM_ID

# Set custom price (requires auth)
curl -X POST http://localhost:5000/api/menu/branch/BRANCH_ID/item/ITEM_ID/price \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"priceOverride": 12.99}'

# Toggle availability (requires auth)
curl -X POST http://localhost:5000/api/menu/branch/BRANCH_ID/item/ITEM_ID/availability \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"available": false}'
```

---

## Summary

✅ **Branch-specific pricing and availability**  
✅ **Automatic inventory checking**  
✅ **Easy override management**  
✅ **Bulk update support**  
✅ **Public and admin endpoints**  
✅ **Backward compatible with base menu**

Your frontend now has full control over branch-specific menu data!
