# availableAtAllBranches Flag - Documentation

## Overview

The `availableAtAllBranches` field on MenuItem controls whether an item is available at all branches by default, eliminating the need to manually configure each item at every branch.

---

## How It Works

### Default Behavior (`availableAtAllBranches: true`)

**Most common case** - Item is available everywhere by default.

```javascript
{
  name: "Classic Burger",
  price: 10.99,
  availableAtAllBranches: true  // ✅ Default
}
```

**Result:**
- ✅ Available at Downtown Branch (no override needed)
- ✅ Available at Suburban Branch (no override needed)
- ✅ Available at Airport Branch (no override needed)
- ✅ Available at Kiosk Branch (no override needed)

**To disable at specific branch:**
```javascript
// Only need to create override if you want to DISABLE it
await setBranchAvailability(kioskBranchId, burgerId, false);
```

---

### Specialty Items (`availableAtAllBranches: false`)

**For location-exclusive items** - Item is disabled everywhere by default.

```javascript
{
  name: "Downtown Signature Pizza",
  price: 18.99,
  availableAtAllBranches: false  // ⭐ Only at specific locations
}
```

**Result:**
- ❌ NOT available at Downtown Branch (until enabled)
- ❌ NOT available at Suburban Branch
- ❌ NOT available at Airport Branch
- ❌ NOT available at Kiosk Branch

**To enable at specific branches:**
```javascript
// Must explicitly enable at desired branches
await setBranchAvailability(downtownBranchId, specialPizzaId, true);
await setBranchAvailability(airportBranchId, specialPizzaId, true);
```

---

## Use Cases

### Use Case 1: Regular Menu Items (99% of items)

**Scenario:** You have 50 menu items that should be available everywhere.

**Old Way (Without flag):**
```javascript
// ❌ Had to manually enable each item at each branch
for (const branch of branches) {
  for (const item of menuItems) {
    await setBranchAvailability(branch._id, item._id, true);
  }
}
// = 50 items × 4 branches = 200 database operations!
```

**New Way (With flag):**
```javascript
// ✅ Items are automatically available everywhere!
// Set availableAtAllBranches: true when creating item (it's the default)
{
  name: "Classic Burger",
  price: 10.99,
  availableAtAllBranches: true  // No branch setup needed!
}

// Only disable at specific locations if needed
await setBranchAvailability(kioskId, itemId, false);
```

---

### Use Case 2: Location-Exclusive Items

**Scenario:** "Downtown Signature Burger" - only available at the flagship downtown location.

```javascript
// Create item with availableAtAllBranches: false
const specialItem = await MenuItem.create({
  restaurant: restaurantId,
  name: "Downtown Signature Burger",
  price: 15.99,
  category: burgerCategoryId,
  availableAtAllBranches: false  // ⭐ Not available by default
});

// Explicitly enable ONLY at downtown branch
await setBranchAvailability(downtownBranchId, specialItem._id, true);

// Result:
// - Downtown: ✅ Available
// - Suburban: ❌ Not available
// - Airport: ❌ Not available
// - Kiosk: ❌ Not available
```

---

### Use Case 3: Limited Menu at Small Kiosk

**Scenario:** Kiosk only serves 10 simple items out of 50 total items.

**Recommended Approach:**
```javascript
// All items have availableAtAllBranches: true (default)

// Simply disable complex items at kiosk
const complexItems = [steakId, pastaId, saladId, ...]; // 40 items

for (const itemId of complexItems) {
  await setBranchAvailability(kioskBranchId, itemId, false);
}

// Simple items remain available (no action needed)
```

**Alternative Approach (if most items are disabled):**
```javascript
// Set items as NOT available at all branches
const complexItems = await MenuItem.find({ category: complexCategoryId });
for (const item of complexItems) {
  item.availableAtAllBranches = false;
  await item.save();
}

// Then enable simple items at kiosk
for (const simpleItemId of simpleItems) {
  await setBranchAvailability(kioskBranchId, simpleItemId, true);
}
```

---

## Decision Tree

```
Creating a new menu item?
│
├─ Should it be available at ALL branches?
│  │
│  ├─ YES (most items) ✅
│  │  └─> Set availableAtAllBranches: true (default)
│  │      └─> No branch setup needed!
│  │          └─> Only disable at specific branches if needed
│  │
│  └─ NO (specialty items) ⭐
│     └─> Set availableAtAllBranches: false
│         └─> Must explicitly enable at desired branches
```

---

## API Examples

### Creating Items

**Regular item (available everywhere):**
```javascript
POST /api/admin/menu-items

{
  "name": "Classic Burger",
  "price": 10.99,
  "category": "category-id",
  "availableAtAllBranches": true  // or omit (it's the default)
}
```

**Specialty item (only at specific locations):**
```javascript
POST /api/admin/menu-items

{
  "name": "Airport Exclusive Meal",
  "price": 18.99,
  "category": "category-id",
  "availableAtAllBranches": false  // ⭐ Must be explicitly enabled per branch
}
```

---

### Updating Items

**Change item to be available everywhere:**
```javascript
PUT /api/admin/menu-items/:itemId

{
  "availableAtAllBranches": true
}

// Item now available at all branches automatically
// Can still disable at specific branches via BranchMenuItem overrides
```

**Change item to be location-exclusive:**
```javascript
PUT /api/admin/menu-items/:itemId

{
  "availableAtAllBranches": false
}

// Item now disabled at all branches by default
// Must enable at specific branches via setBranchAvailability
```

---

## Logic Flow

### When Frontend Requests Menu for a Branch

```javascript
const item = await MenuItem.findById(itemId);
const override = await BranchMenuItem.findOne({ branch: branchId, menuItem: itemId });

let finalAvailable = item.available;  // Start with base availability

if (branchId) {
  // Check availableAtAllBranches flag
  if (item.availableAtAllBranches === false) {
    finalAvailable = false;  // Disabled by default
  }
  
  // Branch override takes precedence
  if (override) {
    finalAvailable = override.available;  // Override wins
  }
}

// Check inventory
if (hasInventoryConsumptions && !hasEnoughStock) {
  finalAvailable = false;  // Out of stock
}

return { ...item, finalAvailable };
```

---

## Priority Order (Availability)

The final availability is determined in this order:

1. **Base availability** (`item.available`)
2. **availableAtAllBranches flag** (if `false`, sets to unavailable)
3. **Branch override** (BranchMenuItem.available) - **HIGHEST PRIORITY**
4. **Inventory check** (out of stock = unavailable)

---

## Examples Table

| availableAtAllBranches | Branch Override | Final Result |
|------------------------|-----------------|--------------|
| `true` (default) | None | ✅ Available |
| `true` | `available: false` | ❌ Not available |
| `true` | `available: true` | ✅ Available |
| `false` | None | ❌ Not available |
| `false` | `available: true` | ✅ Available |
| `false` | `available: false` | ❌ Not available |

---

## Benefits

### ✅ Before (Without Flag)

**Setup 50 items for 4 branches:**
- 200 BranchMenuItem records needed
- Manual configuration for each branch
- Tedious for restaurant owners
- Easy to miss items

### ✅ After (With Flag)

**Setup 50 items for 4 branches:**
- 0 BranchMenuItem records needed (for default case)
- Automatic availability at all branches
- Only configure exceptions
- Much simpler management

---

## Migration Notes

### For Existing Data

All existing MenuItems will default to `availableAtAllBranches: true`, so:

- ✅ No breaking changes
- ✅ All current items remain available everywhere
- ✅ Existing BranchMenuItem overrides still work

### For New Implementations

**Recommended defaults:**

```javascript
// Regular items (most cases)
availableAtAllBranches: true  // Default - no action needed

// Specialty/seasonal items
availableAtAllBranches: false  // Set explicitly
```

---

## Admin UI Suggestions

### Item Creation Form

```jsx
<div className="form-group">
  <label>
    <input 
      type="checkbox" 
      checked={availableAtAllBranches}
      onChange={(e) => setAvailableAtAllBranches(e.target.checked)}
    />
    Available at all branches by default
  </label>
  <small className="help-text">
    {availableAtAllBranches 
      ? "✅ This item will be available at all branches automatically. You can disable it at specific branches if needed."
      : "⚠️ This item will only be available at branches where you explicitly enable it."
    }
  </small>
</div>
```

### Branch Menu Management

```jsx
{!item.availableAtAllBranches && !branchOverride && (
  <span className="badge badge-warning">
    Not available here (enable to add)
  </span>
)}

{item.availableAtAllBranches && !branchOverride && (
  <span className="badge badge-success">
    Available everywhere ✓
  </span>
)}
```

---

## Summary

- **Default:** `availableAtAllBranches: true` - item available everywhere
- **Specialty:** `availableAtAllBranches: false` - item disabled everywhere by default
- **Override:** BranchMenuItem always takes precedence
- **Benefit:** Reduces setup from 200+ records to just exceptions

**This dramatically simplifies multi-branch menu management!** 🎉
