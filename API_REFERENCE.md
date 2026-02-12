## API Reference – RestaurantOS Backend

Base URL (local development): `http://localhost:5001`

All endpoints below are relative to this base URL.

---

### 1. Auth (`/api/auth`)

#### POST `/api/auth/register`
- **Description**: Register a new user (primarily for development; production should use super-admin onboarding flows).
- **Access**: Public
- **Body**: `{ name, email, password, role?, restaurantId? }`

#### POST `/api/auth/login`
- **Description**: Login user and return JWT + refresh token.
- **Access**: Public
- **Body**: `{ email, password }`
- **Response**:
  - `token`, `refreshToken`
  - `user`: `{ id, name, email, role, restaurant, restaurantSlug, defaultBranchId, allowedBranchIds[] }`

#### POST `/api/auth/register-restaurant`
- **Description**: Public restaurant owner signup (creates restaurant + admin user).
- **Access**: Public
- **Body**: `{ restaurantName, subdomain, ownerName, email, password, phone? }`
- **Response**: `token`, `refreshToken`, `user`, `restaurant`

#### POST `/api/auth/refresh`
- **Description**: Refresh access token using refresh token.
- **Access**: Public (token-based)
- **Body**: `{ refreshToken }`
- **Response**:
  - `token`, `refreshToken`
  - optionally `user` with same shape as login.

---

### 2. Public / Customer (`/api`)

#### GET `/api/`
- **Description**: Simple API root – health/info.
- **Access**: Public

#### GET `/api/menu`
- **Description**: Public menu for a restaurant website.
- **Access**: Public
- **Query**:
  - `subdomain` (preferred) OR
  - `restaurantId`
- **Response**:
  - `restaurant`: branding + website config
  - `menu`: array of menu items
  - `categories`: array of `{ id, name, description }`
  - `branches`: array of:
    - `{ id, name, code, address, contactPhone, contactEmail, openingHours }`

#### POST `/api/orders/website`
- **Description**: Place an order from the public website (Cash on Delivery).
- **Access**: Public
- **Body**:
  - `subdomain` (required)
  - `customerName?`
  - `customerPhone` (required)
  - `deliveryAddress?`
  - `items[]`: `{ menuItemId, quantity }`
  - `branchId`:
    - **Required** when restaurant has branches.
    - Optional when there are no branches.
- **Response**: `{ message, orderNumber, total }`

---

### 3. Tenant Admin (`/api/admin`)

All admin routes require:

- Header: `Authorization: Bearer <token>`
- User linked to a restaurant (except `super_admin` where noted).
- Optional header: `x-tenant-slug: <restaurantSlug>` for cross-tenant safety.
- Optional header: `x-branch-id: <branchId>` to scope branch-aware endpoints.

#### 3.1 Branches

##### GET `/api/admin/branches`
- **Description**: List branches for the restaurant.
- **Access**: `restaurant_admin`, `super_admin`, and staff roles.
- **Branch filtering**:
  - `restaurant_admin` / `super_admin`: see all branches for the tenant.
  - Staff roles: only branches in `allowedBranchIds`.
- **Response**: `{ branches: Branch[] }`

**Branch:**

```json
{
  "id": "string",
  "name": "Downtown",
  "code": "downtown",
  "address": "string",
  "contactPhone": "string",
  "contactEmail": "string",
  "openingHours": { "...": "..." },
  "status": "active" | "inactive" | "closed_today",
  "sortOrder": 0,
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

##### POST `/api/admin/branches`
- **Description**: Create a new branch.
- **Access**: `restaurant_admin`, `super_admin`
- **Body**: `{ name, code?, address?, contactPhone?, contactEmail?, openingHours?, status?, sortOrder? }`

##### GET `/api/admin/branches/:id`
- **Description**: Get single branch (enforces branch access for staff).
- **Access**: `restaurant_admin`, `super_admin`, staff with access.

##### PUT `/api/admin/branches/:id`
- **Description**: Update a branch.
- **Access**: `restaurant_admin`, `super_admin`, or manager with branch access.

##### DELETE `/api/admin/branches/:id`
- **Description**: Soft-deactivate branch (`status = 'inactive'`).
- **Access**: `restaurant_admin`, `super_admin`

---

#### 3.2 Menu (Categories & Items)

##### GET `/api/admin/menu`
- **Description**: Get all categories and menu items for the restaurant.
- **Access**: `restaurant_admin`, `super_admin`, staff roles.
- **Response**:
  - `categories`: `{ id, name, description, createdAt }[]`
  - `items`: menu items with pricing, flags, and inventory consumption metadata.

##### POST `/api/admin/categories`
- **Description**: Create category.
- **Access**: `restaurant_admin`, `super_admin`
- **Body**: `{ name, description? }`

##### PUT `/api/admin/categories/:id`
- **Description**: Update category.
- **Access**: `restaurant_admin`, `super_admin`

##### DELETE `/api/admin/categories/:id`
- **Description**: Delete category and its menu items.
- **Access**: `restaurant_admin`, `super_admin`

##### POST `/api/admin/items`
- **Description**: Create menu item.
- **Access**: `restaurant_admin`, `super_admin`
- **Body** (simplified):
  - `name`, `price`, `categoryId`
  - `description?`, `showOnWebsite?`, `imageUrl?`
  - `inventoryConsumptions?`: `{ inventoryItemId, quantity }[]`

##### PUT `/api/admin/items/:id`
- **Description**: Update menu item (price, availability, website visibility, etc.).
- **Access**: `restaurant_admin`, `super_admin`

##### DELETE `/api/admin/items/:id`
- **Description**: Delete menu item.
- **Access**: `restaurant_admin`, `super_admin`

---

#### 3.3 Inventory (current behavior – restaurant-level)

> Note: Inventory is currently scoped by restaurant, not per-branch yet. `BranchInventory` model exists for future per-branch stock.

##### GET `/api/admin/inventory`
- **Description**: List inventory items for the restaurant.
- **Access**: `restaurant_admin`, `super_admin`

##### POST `/api/admin/inventory`
- **Description**: Create inventory item.
- **Access**: `restaurant_admin`, `super_admin`
- **Body**: `{ name, unit, initialStock?, lowStockThreshold?, costPrice? }`

##### PUT `/api/admin/inventory/:id`
- **Description**: Update item, adjust stock.
- **Access**: `restaurant_admin`, `super_admin`

##### DELETE `/api/admin/inventory/:id`
- **Description**: Delete inventory item.
- **Access**: `restaurant_admin`, `super_admin`

---

#### 3.4 Orders & Dashboard

##### GET `/api/admin/orders`
- **Description**: List recent orders for restaurant; optionally scoped by branch.
- **Access**: `restaurant_admin`, staff roles, `super_admin`
- **Headers**:
  - `x-branch-id` (optional): when set, filters by that branch.
- **Query** (optional):
  - `status`
  - `source` (`POS`, `FOODPANDA`, `WEBSITE`)

##### PUT `/api/admin/orders/:id/status`
- **Description**: Update order status.
- **Access**: `restaurant_admin`, staff roles, `super_admin`
- **Body**: `{ status }` (`UNPROCESSED` | `PENDING` | `READY` | `COMPLETED` | `CANCELLED`)

##### GET `/api/admin/reports/sales`
- **Description**: Sales report for a date range.
- **Access**: `restaurant_admin`, `super_admin`
- **Headers**:
  - `x-branch-id` (optional): scope to branch.
- **Query**:
  - `from` (ISO date or `YYYY-MM-DD`)
  - `to` (ISO date or `YYYY-MM-DD`)

##### GET `/api/admin/reports/day`
- **Description**: Day report with cost & profit.
- **Access**: `restaurant_admin`, `super_admin`
- **Headers**:
  - `x-branch-id` (optional): scope to branch.
- **Query**:
  - `date` (ISO date or `YYYY-MM-DD`)

##### GET `/api/admin/dashboard/summary`
- **Description**: Dashboard KPIs (today’s revenue, orders, profit, low stock, charts).
- **Access**: `restaurant_admin`, `super_admin`
- **Headers**:
  - `x-branch-id` (optional): scope to branch.

---

#### 3.5 Website Settings

##### GET `/api/admin/website`
- **Description**: Get website settings for current restaurant.
- **Access**: `restaurant_admin`, `super_admin`

##### PUT `/api/admin/website`
- **Description**: Update website branding/content/sections/theme.
- **Access**: `restaurant_admin`, `super_admin`

---

#### 3.6 Kitchen Display System (KDS)

##### GET `/api/admin/kitchen/orders`
- **Description**: Get orders for kitchen display, grouped by status (newOrders, inKitchen, ready).
- **Access**: `restaurant_admin`, staff roles
- **Headers**: `x-branch-id` (optional) to scope by branch.
- **Response**:
  - `newOrders`: array of orders with status `UNPROCESSED`
  - `inKitchen`: array of orders with status `PENDING`
  - `ready`: array of orders with status `READY`
  - `delayed`: count of orders delayed > 20 minutes
- **Note**: For real-time updates, poll this endpoint every 5-10 seconds from your KDS frontend.

##### PUT `/api/admin/kitchen/orders/:id/status`
- **Description**: Update order status from KDS. Use order ID or order number.
- **Access**: `restaurant_admin`, staff roles
- **Body**: `{ status }` (UNPROCESSED | PENDING | READY | COMPLETED | CANCELLED)

---

#### 3.7 Tables Management

##### GET `/api/admin/tables`
- **Description**: List tables for restaurant/branch.
- **Access**: `restaurant_admin`, staff roles
- **Headers**: `x-branch-id` (optional) to scope by branch.

##### POST `/api/admin/tables`
- **Description**: Create a table (assigned to current branch if x-branch-id is set).
- **Access**: `restaurant_admin`
- **Body**: `{ tableNumber, capacity?, location?, status?, qrCode? }`

##### PUT `/api/admin/tables/:id`
- **Description**: Update a table.
- **Access**: `restaurant_admin`

##### DELETE `/api/admin/tables/:id`
- **Description**: Delete a table.
- **Access**: `restaurant_admin`

**Table object:**
```json
{
  "id": "string",
  "tableNumber": "5",
  "capacity": 4,
  "location": "Main Hall",
  "status": "available" | "occupied" | "reserved" | "maintenance",
  "qrCode": "...",
  "branchId": "string | null"
}
```

---

#### 3.8 Reservations

##### GET `/api/admin/reservations`
- **Description**: List reservations (scoped by x-branch-id).
- **Access**: `restaurant_admin`, staff roles
- **Headers**: `x-branch-id` (optional)
- **Query**: `date` (YYYY-MM-DD, optional) to filter by date.

##### POST `/api/admin/reservations`
- **Description**: Create a reservation (assigned to current branch).
- **Access**: `restaurant_admin`, staff roles
- **Body**: `{ customerName, customerPhone, customerEmail?, date, time, guestCount, tableNumber?, tableId?, notes?, specialRequests? }`

##### GET `/api/admin/reservations/:id`
- **Description**: Get single reservation.
- **Access**: `restaurant_admin`, staff roles

##### PUT `/api/admin/reservations/:id`
- **Description**: Update a reservation.
- **Access**: `restaurant_admin`, staff roles

##### DELETE `/api/admin/reservations/:id`
- **Description**: Delete a reservation.
- **Access**: `restaurant_admin`, staff roles

**Reservation statuses:** `pending`, `confirmed`, `seated`, `completed`, `cancelled`, `no_show`

---

#### 3.9 Customers (CRM)

##### GET `/api/admin/customers`
- **Description**: List customers (scoped by x-branch-id).
- **Access**: `restaurant_admin`, staff roles
- **Headers**: `x-branch-id` (optional)
- **Query**: `allBranches=true` (owner only) to see all branches.

##### GET `/api/admin/customers/:id`
- **Description**: Get single customer.
- **Access**: `restaurant_admin`, staff roles

##### POST `/api/admin/customers`
- **Description**: Create a customer (assigned to current branch).
- **Access**: `restaurant_admin`, staff roles
- **Body**: `{ name, phone, email?, address?, notes? }`

##### PUT `/api/admin/customers/:id`
- **Description**: Update a customer.
- **Access**: `restaurant_admin`, staff roles

##### DELETE `/api/admin/customers/:id`
- **Description**: Delete a customer.
- **Access**: `restaurant_admin`, staff roles

---

#### 3.10 Branch Menu Overrides

##### PUT `/api/admin/branch-menu/:menuItemId`
- **Description**: Set/update branch override for a menu item (requires x-branch-id).
- **Access**: `restaurant_admin`, branch manager
- **Body**: `{ available?, priceOverride? }`

##### DELETE `/api/admin/branch-menu/:menuItemId`
- **Description**: Remove branch override (revert to base).
- **Access**: `restaurant_admin`, branch manager

##### GET `/api/admin/branch-menu`
- **Description**: List all overrides for current branch.
- **Access**: `restaurant_admin`, staff roles

---

#### 3.11 Users (Tenant staff)

##### GET `/api/admin/users`
- **Description**: List users for this restaurant.
- **Access**: `restaurant_admin`, `super_admin`

##### POST `/api/admin/users`
- **Description**: Create staff user.
- **Access**: `restaurant_admin`, `super_admin`
- **Body**: `{ name, email, password, role?, profileImageUrl? }`

##### PUT `/api/admin/users/:id`
- **Description**: Update staff user.
- **Access**: `restaurant_admin`, `super_admin`

##### DELETE `/api/admin/users/:id`
- **Description**: Delete staff user.
- **Access**: `restaurant_admin`, `super_admin`

---

### 4. POS (`/api/pos`)

All POS routes require:

- `Authorization: Bearer <token>`
- User linked to restaurant and subscription active/allowed.

#### POST `/api/pos/orders`
- **Description**: Create and complete a new POS order.
- **Access**: staff roles, `restaurant_admin`
- **Body** (simplified):
  - `items[]`: `{ menuItemId, quantity }`
  - `orderType`: `DINE_IN` \| `TAKEAWAY`
  - `paymentMethod`: `CASH` \| `CARD`
  - `discountAmount?`
  - `customerName?`, `customerPhone?`, `deliveryAddress?`
  - `branchId`:
    - **Required** when restaurant has branches.
    - Optional when there are no branches.

#### POST `/api/pos/orders/:id/cancel`
- **Description**: Cancel order and reverse inventory deduction.
- **Access**: staff roles, `restaurant_admin`

---

### 5. Profile (`/api/profile`)

All require `Authorization: Bearer <token>`.

#### GET `/api/profile`
- **Description**: Get current user profile.

#### PUT `/api/profile`
- **Description**: Update current user name & email.

#### PUT `/api/profile/password`
- **Description**: Change password (requires current password).

#### POST `/api/profile/avatar`
- **Description**: Upload profile image to Cloudinary and save URL.

#### DELETE `/api/profile/avatar`
- **Description**: Remove profile image.

---

### 6. Upload (`/api/upload`)

#### POST `/api/upload/image`
- **Description**: Upload an image to Cloudinary and return URL.
- **Access**: Authenticated restaurant users
- **Body**: `multipart/form-data` with field `image`.

---

### 7. Integrations (`/api/integrations`, `/api/webhooks`)

#### Authenticated integration routes (`/api/integrations`)

All require `Authorization: Bearer <token>`.

- **GET `/api/integrations`** – list integrations for restaurant.
- **POST `/api/integrations`** – create/update integration config.
- **PUT `/api/integrations/:id/toggle`** – toggle active/inactive.
- **DELETE `/api/integrations/:id`** – delete integration.
- **POST `/api/integrations/test-order`** – create a test Foodpanda order for the restaurant.

#### Webhooks

##### POST `/api/webhooks/foodpanda/:restaurantId`
- **Description**: Receive Foodpanda order webhook / manual sync.
- **Access**: API-key based (see integration config).

---

### 8. Subscription (`/api/subscription`)

#### Restaurant-side

- **GET `/api/subscription/status`** – current subscription status for logged-in restaurant.
- **POST `/api/subscription/request`** – submit new subscription request with payment screenshot.
- **PUT `/api/subscription/request/:id/screenshot`** – update screenshot on pending request.
- **GET `/api/subscription/history`** – subscription request history.
- **GET `/api/subscription/payment-methods`** – list active payment methods visible to restaurant admins.

#### Super-admin-side (`/api/subscription/super/*`)

- **GET `/api/subscription/super/requests`** – list pending subscription requests.
- **PUT `/api/subscription/super/requests/:id/approve`** – approve a request.
- **PUT `/api/subscription/super/requests/:id/reject`** – reject a request.
- **GET `/api/subscription/super/history`** – subscription history across restaurants.
- **GET `/api/subscription/super/payment-methods`** – list all payment methods.
- **POST `/api/subscription/super/payment-methods`** – create a payment method.
- **PUT `/api/subscription/super/payment-methods/:id`** – update a payment method.
- **DELETE `/api/subscription/super/payment-methods/:id`** – delete a payment method.

---

### 9. Super Admin (`/api/super`)

#### POST `/api/super/restaurants`
- **Description**: Onboard new restaurant and create admin user.
- **Access**: `super_admin`

#### GET `/api/super/restaurants`
- **Description**: List restaurants with subscription info.
- **Access**: `super_admin`

#### PATCH `/api/super/restaurants/:id/subscription`
- **Description**: Update subscription status/plan/dates.
- **Access**: `super_admin`

