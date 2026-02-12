# Branch-Aware Menu - Before vs After

## Visual Comparison

### BEFORE ❌ (Restaurant-wide only)

```
Restaurant Menu
├── Burgers ($10.99 everywhere)
│   ├── Classic Burger
│   ├── Cheese Burger
│   └── Veggie Burger
├── Sides ($3.99 everywhere)
│   ├── French Fries
│   └── Onion Rings
└── Drinks ($2.99 everywhere)
    ├── Coke
    └── Water
```

**Problems:**
- All branches show same prices (even if downtown has higher rent)
- Can't disable items at specific locations
- No branch-specific inventory consideration
- Same menu everywhere (no location-specific specials)

---

### AFTER ✅ (Branch-aware)

```
Downtown Branch Menu
├── Burgers
│   ├── Classic Burger         $12.99  [Special Price] ⭐
│   ├── Cheese Burger          $13.99  [Special Price] ⭐
│   └── Veggie Burger          $11.99
├── Sides
│   ├── French Fries           $4.99   [Special Price] ⭐
│   └── Onion Rings            $5.99   [Special Price] ⭐
└── Drinks
    ├── Coke                   $3.49   [Special Price] ⭐
    └── Water                  $2.99

Suburban Branch Menu
├── Burgers
│   ├── Classic Burger         $9.99   [Special Price] ⭐
│   ├── Cheese Burger          $10.99  [Special Price] ⭐
│   └── Veggie Burger          $11.99
├── Sides
│   ├── French Fries           $2.99   [Special Price] ⭐
│   └── Onion Rings            $3.99
└── Drinks
    ├── Coke                   $2.49   [Special Price] ⭐
    └── Water                  $2.99

Kiosk Branch Menu (Limited)
├── Burgers
│   ├── Classic Burger         $10.99
│   └── Cheese Burger          $11.99
└── Drinks
    └── Coke                   $2.99
    
    (Veggie Burger, Sides, Water - Not Available) ⭐
```

**Benefits:**
- Each branch can have custom pricing
- Items can be enabled/disabled per branch
- Inventory checked per branch
- Location-specific menus

---

## Code Comparison

### Old API Call (Restaurant-wide)

```javascript
// ❌ Gets same menu for all branches
const response = await fetch('/api/menu?restaurantId=123');
const menu = await response.json();

// Result: All items show base price
{
  name: "Classic Burger",
  price: 10.99,        // Same everywhere
  available: true      // Same everywhere
}
```

### New API Call (Branch-aware)

```javascript
// ✅ Gets branch-specific menu
const response = await fetch(
  '/api/menu/branch/downtown-id/by-category?restaurantId=123'
);
const categories = await response.json();

// Result: Items show branch-specific data
{
  name: "Classic Burger",
  price: 10.99,              // Base price
  available: true,           // Base availability
  finalPrice: 12.99,         // ⭐ Actual price at Downtown
  finalAvailable: true,      // ⭐ Actually available here
  hasBranchOverride: true    // ⭐ Has custom settings
}
```

---

## Real-World Example

### Scenario: Pizza Restaurant Chain

**Base Menu (Restaurant-level):**
```javascript
{
  name: "Margherita Pizza",
  price: 15.00,          // Base price
  available: true
}
```

**Branch 1: Manhattan (High Rent)**
```javascript
await setBranchPrice('manhattan-id', 'pizza-id', 18.00);

// Customer sees: $18.00
```

**Branch 2: Brooklyn (Medium Rent)**
```javascript
// No override set

// Customer sees: $15.00 (base price)
```

**Branch 3: Jersey (Lower Rent)**
```javascript
await setBranchPrice('jersey-id', 'pizza-id', 12.00);

// Customer sees: $12.00
```

**Branch 4: Food Truck (Limited Menu)**
```javascript
await setBranchAvailability('truck-id', 'pizza-id', false);

// Customer doesn't see this item at all
```

---

## Data Structure Comparison

### Before

```javascript
// Single MenuItem document
{
  _id: "item123",
  restaurant: "rest456",
  name: "Classic Burger",
  price: 10.99,           // Only one price
  available: true,        // Only one availability
  category: "burgers"
}

// Frontend gets this everywhere
```

### After

```javascript
// Base MenuItem (unchanged)
{
  _id: "item123",
  restaurant: "rest456",
  name: "Classic Burger",
  price: 10.99,           // Base price
  available: true,        // Base availability
  category: "burgers"
}

// BranchMenuItem (new - optional per branch)
{
  branch: "downtown-branch",
  menuItem: "item123",
  priceOverride: 12.99,   // Custom price
  available: true         // Custom availability
}

// Frontend gets merged result
{
  _id: "item123",
  name: "Classic Burger",
  price: 10.99,           // Original
  available: true,        // Original
  finalPrice: 12.99,      // ⭐ Merged (override)
  finalAvailable: true,   // ⭐ Merged (override + stock)
  hasBranchOverride: true
}
```

---

## Frontend Display Comparison

### Before

```jsx
// All branches show same thing
<div className="menu-item">
  <h3>Classic Burger</h3>
  <span className="price">${item.price}</span>
  {/* Always shows $10.99 everywhere */}
</div>
```

### After

```jsx
// Each branch can show different data
<div className="menu-item">
  <h3>Classic Burger</h3>
  
  {/* Show actual branch price */}
  <span className="price">${item.finalPrice}</span>
  
  {/* Show if price is special at this location */}
  {item.hasBranchOverride && item.finalPrice !== item.price && (
    <span className="badge badge-info">
      Special Price (Usually ${item.price})
    </span>
  )}
  
  {/* Show if unavailable at this location */}
  {!item.finalAvailable && (
    <span className="badge badge-danger">
      Not Available Here
    </span>
  )}
</div>
```

---

## Admin Interface Comparison

### Before

```jsx
// Can only edit base price (affects all branches)
<input 
  type="number" 
  value={item.price}
  onChange={(e) => updateBasePrice(e.target.value)}
/>
// Changing this affects EVERY branch
```

### After

```jsx
// Can edit base price OR branch-specific price
<div>
  <label>Base Price (for all branches):</label>
  <input 
    type="number" 
    value={item.price}
    onChange={(e) => updateBasePrice(e.target.value)}
  />
  
  <label>Price at {branchName}:</label>
  <input 
    type="number" 
    value={branchPrice || item.price}
    onChange={(e) => setBranchPrice(branchId, item._id, e.target.value)}
  />
  
  <button onClick={() => clearBranchOverride(branchId, item._id)}>
    Revert to Base Price
  </button>
</div>
```

---

## API Endpoint Comparison

### Before

| Endpoint | Returns |
|----------|---------|
| `GET /api/menu?restaurantId=X` | Restaurant-wide menu (same for all branches) |

### After

| Endpoint | Returns |
|----------|---------|
| `GET /api/menu/restaurant/:restaurantId/by-category` | Base restaurant menu (no overrides) |
| `GET /api/menu/branch/:branchId/by-category` | ⭐ Branch-specific menu (with overrides) |
| `GET /api/menu/branch/:branchId/item/:itemId` | ⭐ Single item with branch data |
| `GET /api/menu/branch/:branchId/exclusive` | ⭐ Items only at this branch |
| `POST /api/menu/branch/:branchId/item/:itemId/price` | ⭐ Set custom price |
| `POST /api/menu/branch/:branchId/item/:itemId/availability` | ⭐ Toggle availability |

---

## Use Case Examples

### Use Case 1: Airport Location (Higher Prices)

**Before:**
- All locations must charge same price
- Airport branch loses money due to high rent

**After:**
```javascript
// Set higher prices for airport branch
await setBranchPrice(airportBranchId, burgerItemId, 16.99);
await setBranchPrice(airportBranchId, friesItemId, 5.99);

// Other branches keep normal prices
```

---

### Use Case 2: Limited Kiosk Menu

**Before:**
- Must show all items even if kiosk can't make them
- Customers order items that aren't actually available

**After:**
```javascript
// Only enable simple items at kiosk
await setBranchAvailability(kioskId, burgerItemId, true);
await setBranchAvailability(kioskId, friesItemId, true);

// Disable complex items
await setBranchAvailability(kioskId, steakItemId, false);
await setBranchAvailability(kioskId, pastaItemId, false);
```

---

### Use Case 3: Seasonal/Regional Items

**Before:**
- Pumpkin Spice Latte shows everywhere year-round
- Customers disappointed when not available

**After:**
```javascript
// Enable only at certain branches during fall
await setBranchAvailability(downtownId, pslItemId, true);
await setBranchAvailability(mainStreetId, pslItemId, true);

// Keep disabled at others
await setBranchAvailability(kioskId, pslItemId, false);
```

---

## Summary Table

| Feature | Before | After |
|---------|--------|-------|
| **Pricing** | Same everywhere | ✅ Per-branch pricing |
| **Availability** | Same everywhere | ✅ Per-branch availability |
| **Inventory** | Restaurant-wide | ✅ Branch-specific stock |
| **Menu customization** | None | ✅ Enable/disable items per branch |
| **Location specials** | Not possible | ✅ Exclusive items per branch |
| **Price flexibility** | One price fits all | ✅ Adjust for rent/demographics |
| **Admin control** | Global only | ✅ Global + per-branch |
| **Customer experience** | Generic | ✅ Location-specific |

---

## Migration Checklist

- [ ] **Backend:** Install new routes (`/api/menu` endpoints working)
- [ ] **Frontend:** Update API calls to use branch-specific endpoints
- [ ] **Frontend:** Display `finalPrice` instead of `price`
- [ ] **Frontend:** Check `finalAvailable` instead of `available`
- [ ] **Frontend:** Add branch selector if not present
- [ ] **Admin:** Add branch price management UI
- [ ] **Admin:** Add availability toggle per branch
- [ ] **POS:** Update to use branch context
- [ ] **Testing:** Verify different branches show different prices
- [ ] **Testing:** Verify unavailable items don't show

---

**Your restaurant menu is now fully branch-aware! 🎉**

Different locations can have different pricing, availability, and inventory while maintaining a centralized base menu.
