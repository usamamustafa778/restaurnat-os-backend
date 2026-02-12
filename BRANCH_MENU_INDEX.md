# Branch-Aware Menu System - Documentation Index

## 📚 Documentation Overview

This system makes your restaurant menu **branch-aware**, allowing each location to have custom pricing, availability, and inventory.

**🎯 Key Feature:** Items are automatically available at all branches by default - no manual setup needed!

📖 See [AVAILABLE_AT_ALL_BRANCHES.md](./AVAILABLE_AT_ALL_BRANCHES.md) for details.

---

## 🚀 Start Here

**New to the system?** Read these in order:

1. **[BRANCH_MENU_COMPARISON.md](./BRANCH_MENU_COMPARISON.md)** ⭐ START HERE
   - Visual before/after comparison
   - See what problem is solved
   - Quick examples
   - **5 min read**

2. **[BRANCH_MENU_QUICK_START.md](./BRANCH_MENU_QUICK_START.md)**
   - Copy-paste code examples
   - Frontend integration
   - Common scenarios
   - **10 min read**

3. **[BRANCH_MENU_API.md](./BRANCH_MENU_API.md)**
   - Complete API reference
   - All endpoints documented
   - Request/response examples
   - **Reference guide**

4. **[BRANCH_MENU_SUMMARY.md](./BRANCH_MENU_SUMMARY.md)**
   - Implementation details
   - Files created
   - Architecture overview
   - **Technical deep dive**

---

## 📖 Quick Reference

### For Frontend Developers

**Get menu for a branch:**
```javascript
GET /api/menu/branch/:branchId/by-category?restaurantId=X
```

**Display item:**
```jsx
<div className="price">${item.finalPrice}</div>
{!item.finalAvailable && <span>Unavailable</span>}
```

👉 See [BRANCH_MENU_QUICK_START.md](./BRANCH_MENU_QUICK_START.md)

---

### For Backend Developers

**Helper functions:**
```javascript
const { getBranchMenu } = require('./utils/branchMenuHelper');
const menu = await getBranchMenu(restaurantId, branchId);
```

👉 See [utils/branchMenuHelper.js](./utils/branchMenuHelper.js)

---

### For Admin/POS Developers

**Set branch price:**
```javascript
POST /api/menu/branch/:branchId/item/:itemId/price
Body: { priceOverride: 12.99 }
```

**Toggle availability:**
```javascript
POST /api/menu/branch/:branchId/item/:itemId/availability
Body: { available: false }
```

👉 See [BRANCH_MENU_API.md](./BRANCH_MENU_API.md#admin-endpoints)

---

## 🗂️ Files Created

### Core Implementation
- `utils/branchMenuHelper.js` - Merge logic for branch data
- `routes/menuRoutes.js` - RESTful API endpoints
- `server.js` - Updated with menu routes

### Documentation
- `AVAILABLE_AT_ALL_BRANCHES.md` - How automatic availability works ⭐
- `BRANCH_MENU_COMPARISON.md` - Before/after visual guide
- `BRANCH_MENU_QUICK_START.md` - Quick reference with examples
- `BRANCH_MENU_API.md` - Complete API documentation
- `BRANCH_MENU_SUMMARY.md` - Implementation summary
- `BRANCH_MENU_INDEX.md` - This file

### Models (Already Existed)
- `models/MenuItem.js` - Base restaurant menu items
- `models/BranchMenuItem.js` - Branch-specific overrides
- `models/Category.js` - Menu categories
- `models/BranchInventory.js` - Branch inventory

---

## 🎯 Key Concepts

### Base Menu Item (Restaurant Level)
```javascript
{
  name: "Classic Burger",
  price: 10.99,        // Base price
  available: true      // Base availability
}
```

### Branch Override (Optional)
```javascript
{
  branch: "downtown",
  menuItem: "burger-id",
  priceOverride: 12.99,   // Custom price
  available: true         // Custom availability
}
```

### Merged Result (What Frontend Gets)
```javascript
{
  name: "Classic Burger",
  price: 10.99,              // Base
  finalPrice: 12.99,         // ⭐ Use this
  finalAvailable: true,      // ⭐ Use this
  hasBranchOverride: true
}
```

---

## 🔥 Common Tasks

### Display Menu on Website
```javascript
const res = await fetch(
  `/api/menu/branch/${branchId}/by-category?restaurantId=${restaurantId}`
);
const menu = await res.json();
```
📖 [Full example](./BRANCH_MENU_QUICK_START.md#1-display-menu-for-a-specific-branch)

---

### Set Custom Price for Branch
```javascript
await fetch(`/api/menu/branch/${branchId}/item/${itemId}/price`, {
  method: 'POST',
  headers: { 
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ priceOverride: 15.99 })
});
```
📖 [Full example](./BRANCH_MENU_API.md#5-set-branch-specific-price)

---

### Mark Item as Unavailable
```javascript
await fetch(`/api/menu/branch/${branchId}/item/${itemId}/availability`, {
  method: 'POST',
  headers: { 
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ available: false })
});
```
📖 [Full example](./BRANCH_MENU_API.md#6-set-branch-specific-availability)

---

## 🎓 Learning Path

### Beginner
1. Read [BRANCH_MENU_COMPARISON.md](./BRANCH_MENU_COMPARISON.md)
2. Try the examples in [BRANCH_MENU_QUICK_START.md](./BRANCH_MENU_QUICK_START.md)
3. Test with cURL or Postman

### Intermediate
1. Integrate frontend with new endpoints
2. Build admin UI for price management
3. Add availability toggles to POS

### Advanced
1. Review [utils/branchMenuHelper.js](./utils/branchMenuHelper.js)
2. Extend with custom features
3. Optimize with caching

---

## 📊 API Endpoints Overview

### Public (No Auth)
| Endpoint | Purpose |
|----------|---------|
| `GET /api/menu/branch/:branchId/by-category` | Get menu for branch |
| `GET /api/menu/branch/:branchId/item/:itemId` | Get single item |
| `GET /api/menu/branch/:branchId/exclusive` | Get exclusive items |

### Admin (Auth Required)
| Endpoint | Purpose |
|----------|---------|
| `POST /api/menu/branch/:branchId/item/:itemId/price` | Set price |
| `POST /api/menu/branch/:branchId/item/:itemId/availability` | Set availability |
| `DELETE /api/menu/branch/:branchId/item/:itemId/override` | Clear override |
| `POST /api/menu/branch/:branchId/bulk-update` | Bulk update |

📖 [Full API Reference](./BRANCH_MENU_API.md)

---

## ✅ Features

- ✅ Branch-specific pricing
- ✅ Branch-specific availability
- ✅ Branch-specific inventory checking
- ✅ Location-exclusive items
- ✅ Bulk updates
- ✅ Easy override management
- ✅ Backward compatible
- ✅ RESTful API
- ✅ Comprehensive documentation

---

## 🆘 Troubleshooting

### Item showing wrong price?
👉 Use `item.finalPrice`, not `item.price`

### Changes not reflecting?
👉 Clear browser cache (Ctrl+F5)

### Getting 400 error?
👉 Include `restaurantId` in query params

### Need more help?
👉 See [BRANCH_MENU_QUICK_START.md#troubleshooting](./BRANCH_MENU_QUICK_START.md#-troubleshooting)

---

## 🧪 Testing

```bash
# Quick test
curl "http://localhost:5000/api/menu/branch/BRANCH_ID/by-category?restaurantId=REST_ID"

# Full testing guide
```
📖 [See BRANCH_MENU_API.md](./BRANCH_MENU_API.md#testing)

---

## 📞 Support

- **API Issues:** Check [BRANCH_MENU_API.md](./BRANCH_MENU_API.md)
- **Integration Help:** Check [BRANCH_MENU_QUICK_START.md](./BRANCH_MENU_QUICK_START.md)
- **Understanding System:** Check [BRANCH_MENU_COMPARISON.md](./BRANCH_MENU_COMPARISON.md)
- **Technical Details:** Check [BRANCH_MENU_SUMMARY.md](./BRANCH_MENU_SUMMARY.md)

---

## 🚀 Next Steps

1. **Frontend Team:** 
   - Update API calls to use branch endpoints
   - Display `finalPrice` and `finalAvailable`
   - Add branch selector

2. **Admin Team:**
   - Build price management UI
   - Add availability toggles
   - Show override indicators

3. **POS Team:**
   - Integrate branch context
   - Add quick toggle buttons
   - Test inventory integration

---

**Ready to get started? Read [BRANCH_MENU_COMPARISON.md](./BRANCH_MENU_COMPARISON.md) first! 📚**
