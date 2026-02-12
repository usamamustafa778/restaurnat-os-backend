# Example: Setting Up Menu Items - Before vs After

## Scenario

You have a restaurant chain with **4 branches** and **50 menu items**.

**Branches:**
- Downtown (full menu)
- Suburban (full menu)
- Airport (full menu, higher prices)
- Kiosk (limited menu - only 10 simple items)

---

## ❌ OLD WAY (Without availableAtAllBranches flag)

### Step 1: Create 50 menu items
```javascript
const items = await MenuItem.create([
  { name: "Classic Burger", price: 10.99, category: burgersId },
  { name: "Cheese Burger", price: 11.99, category: burgersId },
  { name: "Veggie Burger", price: 10.99, category: burgersId },
  // ... 47 more items
]);
```

### Step 2: Manually enable ALL items at ALL branches
```javascript
// ❌ This is painful!
const branches = [downtownId, suburbanId, airportId, kioskId];

for (const branchId of branches) {
  for (const item of items) {
    await BranchMenuItem.create({
      branch: branchId,
      menuItem: item._id,
      available: true  // Manually enabling everywhere
    });
  }
}

// Result: 50 items × 4 branches = 200 database records!
```

### Step 3: Disable complex items at kiosk
```javascript
// Now disable 40 items at the kiosk
const complexItems = items.slice(10); // 40 complex items

for (const item of complexItems) {
  await BranchMenuItem.findOneAndUpdate(
    { branch: kioskId, menuItem: item._id },
    { available: false }
  );
}
```

**Total work:** 200 records created, then 40 updated = lots of manual work!

---

## ✅ NEW WAY (With availableAtAllBranches flag)

### Step 1: Create 50 menu items with flag
```javascript
// Regular items - available everywhere automatically
const regularItems = await MenuItem.create([
  { 
    name: "Classic Burger", 
    price: 10.99, 
    category: burgersId,
    availableAtAllBranches: true  // ✅ Automatically available everywhere!
  },
  { 
    name: "Cheese Burger", 
    price: 11.99, 
    category: burgersId,
    availableAtAllBranches: true  // ✅ No branch setup needed!
  },
  // ... 48 more items with availableAtAllBranches: true
]);

// Result: Items automatically available at all 4 branches!
// 0 BranchMenuItem records needed for default behavior!
```

### Step 2: Only disable items at kiosk (40 items)
```javascript
// Only need to disable complex items at kiosk
const complexItems = regularItems.slice(10); // 40 complex items

for (const item of complexItems) {
  await BranchMenuItem.create({
    branch: kioskId,
    menuItem: item._id,
    available: false  // Only creating overrides where needed
  });
}

// Result: Only 40 BranchMenuItem records needed (instead of 200!)
```

**Total work:** 40 records created (instead of 200!) = **80% less work!**

---

## Real Example: Add New Menu Item

### ❌ OLD WAY

```javascript
// 1. Create item
const newItem = await MenuItem.create({
  name: "BBQ Burger",
  price: 12.99,
  category: burgersId
});

// 2. Manually add to each branch
await BranchMenuItem.create({ branch: downtownId, menuItem: newItem._id, available: true });
await BranchMenuItem.create({ branch: suburbanId, menuItem: newItem._id, available: true });
await BranchMenuItem.create({ branch: airportId, menuItem: newItem._id, available: true });
await BranchMenuItem.create({ branch: kioskId, menuItem: newItem._id, available: true });

// 4 records created manually 😓
```

### ✅ NEW WAY

```javascript
// 1. Create item with availableAtAllBranches: true
const newItem = await MenuItem.create({
  name: "BBQ Burger",
  price: 12.99,
  category: burgersId,
  availableAtAllBranches: true  // ✅ That's it!
});

// Done! Item automatically available at all branches! 🎉
// 0 additional records needed!
```

---

## Example: Location-Exclusive Item

### Scenario: "Downtown Signature Pizza" - only at flagship location

```javascript
// Create specialty item
const specialItem = await MenuItem.create({
  name: "Downtown Signature Pizza",
  price: 18.99,
  category: pizzasId,
  availableAtAllBranches: false  // ⭐ NOT available by default
});

// Explicitly enable ONLY at downtown branch
await BranchMenuItem.create({
  branch: downtownId,
  menuItem: specialItem._id,
  available: true  // Enable at downtown only
});

// Result:
// - Downtown: ✅ Available (because we enabled it)
// - Suburban: ❌ Not available (default behavior)
// - Airport: ❌ Not available (default behavior)
// - Kiosk: ❌ Not available (default behavior)
```

---

## Example: Seasonal Item Rollout

### Scenario: "Pumpkin Spice Latte" - testing at 2 locations first

```javascript
// Create seasonal item
const psl = await MenuItem.create({
  name: "Pumpkin Spice Latte",
  price: 5.99,
  category: drinksId,
  availableAtAllBranches: false  // ⭐ Start disabled everywhere
});

// Enable at test locations only
await BranchMenuItem.create({
  branch: downtownId,
  menuItem: psl._id,
  available: true  // Enable at downtown
});

await BranchMenuItem.create({
  branch: airportId,
  menuItem: psl._id,
  available: true  // Enable at airport
});

// Later: if successful, enable everywhere
await MenuItem.findByIdAndUpdate(psl._id, {
  availableAtAllBranches: true  // Now available at all branches!
});

// Can now delete the specific branch overrides if desired
await BranchMenuItem.deleteMany({ menuItem: psl._id });
```

---

## Comparison Table

| Task | OLD WAY | NEW WAY |
|------|---------|---------|
| **Add regular item** | Create item + 4 branch records | Create item (done!) |
| **Add 50 regular items** | 250 records (50 + 200) | 50 records |
| **Add exclusive item** | Create item + disable at 3 branches | Create with flag + enable at 1 branch |
| **Limited kiosk menu** | Enable 10, disable 40 | Create items, disable 40 at kiosk |
| **Expand to 5th branch** | Copy 50 items to new branch | Automatically available! |

---

## Code Comparison: Adding Items

### Creating Regular Item

```javascript
// ❌ OLD - Manual setup per branch
const item = await MenuItem.create({ name: "Burger", price: 10.99 });
for (const branchId of branchIds) {
  await BranchMenuItem.create({ branch: branchId, menuItem: item._id, available: true });
}

// ✅ NEW - Automatic
const item = await MenuItem.create({ 
  name: "Burger", 
  price: 10.99,
  availableAtAllBranches: true  // Available everywhere automatically!
});
```

### Creating Exclusive Item

```javascript
// ❌ OLD - Disable at unwanted branches
const item = await MenuItem.create({ name: "Special Pizza", price: 18.99 });
await BranchMenuItem.create({ branch: downtownId, menuItem: item._id, available: true });
await BranchMenuItem.create({ branch: suburbanId, menuItem: item._id, available: false });
await BranchMenuItem.create({ branch: airportId, menuItem: item._id, available: false });
await BranchMenuItem.create({ branch: kioskId, menuItem: item._id, available: false });

// ✅ NEW - Enable at wanted branches only
const item = await MenuItem.create({ 
  name: "Special Pizza", 
  price: 18.99,
  availableAtAllBranches: false  // Disabled everywhere by default
});
await BranchMenuItem.create({ 
  branch: downtownId, 
  menuItem: item._id, 
  available: true  // Only enable where wanted
});
```

---

## Admin UI Example

### Item Creation Form

```jsx
function CreateMenuItem() {
  const [availableAtAllBranches, setAvailableAtAllBranches] = useState(true);

  return (
    <form onSubmit={handleSubmit}>
      <input 
        type="text" 
        placeholder="Item name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      
      <input 
        type="number" 
        placeholder="Price"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />
      
      <div className="form-check">
        <input 
          type="checkbox"
          id="availableAtAllBranches"
          checked={availableAtAllBranches}
          onChange={(e) => setAvailableAtAllBranches(e.target.checked)}
        />
        <label htmlFor="availableAtAllBranches">
          Available at all branches
        </label>
        <small className="form-text text-muted">
          {availableAtAllBranches ? (
            <span className="text-success">
              ✅ This item will be automatically available at all branches.
              You can disable it at specific branches later if needed.
            </span>
          ) : (
            <span className="text-warning">
              ⚠️ This item will NOT be available at any branch by default.
              You'll need to enable it at specific branches.
            </span>
          )}
        </small>
      </div>
      
      <button type="submit">Create Item</button>
    </form>
  );
}
```

---

## Summary

### Benefits of availableAtAllBranches Flag

✅ **80% less database records** for typical setups  
✅ **Automatic availability** at all branches  
✅ **Only configure exceptions**, not the norm  
✅ **Easy to add new branches** - items automatically available  
✅ **Specialty items** can be location-exclusive  
✅ **Seasonal rollouts** are easier to manage  

### When to Use Each Setting

**Use `availableAtAllBranches: true` (default) when:**
- Regular menu items that should be everywhere
- 90%+ of your menu items
- Items available to all customers

**Use `availableAtAllBranches: false` when:**
- Location-exclusive signature items
- Seasonal items in testing phase
- Regional specialties
- Items only available at specific branch types

---

**This feature dramatically simplifies multi-branch menu management! 🎉**
