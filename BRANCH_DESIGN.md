# Multi-Branch Restaurant System – Design & Backend Requirements

This document describes how branch switching is designed in RestaurantOS: one **owner**, one **website**, optional **area/general manager**, and **per-branch** staff, inventory, and optionally menu.

---

## 1. High-Level Model

| Level | Scope | Notes |
|-------|--------|------|
| **Restaurant (tenant)** | One owner, one brand, one customer website | Identified by `tenantSlug` / subdomain |
| **Branches** | Per-location: own staff, inventory, maybe menu | Each order (POS + website) is tied to a branch |
| **Website** | Single site per restaurant | User selects branch, then places order |
| **Roles** | Owner (all branches), Area/GM (one or more branches), Staff (one branch) | Backend enforces access by branch |

---

## 2. Data Model (Backend)

### 2.1 Core Entities

- **Restaurant (Tenant)**  
  - `id`, `slug`, `name`, website settings, subscription, etc. (existing).

- **Branch**  
  - `id`, `restaurantId`, `name`, `code` (e.g. `downtown`, `mall`), `address`, `contactPhone`, `contactEmail`  
  - `openingHours` (JSON), `status` (`active` / `inactive` / `closed_today`)  
  - `sortOrder` (for display), `createdAt`, `updatedAt`

- **User (staff)**  
  - Existing user model plus **branch assignments**:  
  - `UserBranch`: `userId`, `branchId`, `role` (e.g. `manager`, `cashier`, `kitchen_staff`).  
  - A user can be assigned to multiple branches with different roles.  
  - **Owner / restaurant_admin**: no branch row; they see all branches.  
  - **Area manager / GM**: one or more `UserBranch` rows with role `manager` (or similar).  
  - **Staff**: typically one branch.

- **Menu**  
  - **Option A (simpler):** Menu is at **restaurant** level; all branches share the same menu.  
  - **Option B (flexible):** Restaurant-level base menu; **branch overrides** for availability or price (e.g. `BranchMenuItem`: `branchId`, `menuItemId`, `available`, `priceOverride`).  
  - Recommendation: start with Option A; add Option B when needed.

- **Inventory**  
  - **Per branch.**  
  - Tables: e.g. `BranchInventory` with `branchId`, item ref, quantity, unit, reorder level.  
  - All inventory APIs should be scoped by `branchId` (from token or header).

- **Orders**  
  - **Always tied to a branch.**  
  - Add `branchId` to the order table (POS and website).  
  - List/filter orders by `branchId` (and optionally date, status).

---

## 3. Backend API Requirements

### 3.1 Auth & Branch Context

- **Login response** should include (in addition to existing fields):  
  - `user.defaultBranchId` (optional; suggested branch for dashboard).  
  - `user.allowedBranchIds` (array) or equivalent:  
    - Owner/restaurant_admin: all branches of the tenant.  
    - Manager: branches assigned via `UserBranch`.  
    - Staff: single branch.  
- **JWT** can optionally include `defaultBranchId` and `allowedBranchIds` (or a flag “can access all branches”) so the backend can validate `x-branch-id` without a DB hit on every request.

### 3.2 Branch CRUD (tenant-scoped)

- `GET /api/admin/branches`  
  - Returns list of branches for the tenant.  
  - For non-owners: filter by `user.allowedBranchIds`.  
  - Response: `{ branches: [{ id, name, code, address, status, openingHours, ... }] }`.

- `POST /api/admin/branches`  
  - Create branch (owner/restaurant_admin only, or role-check as needed).

- `GET /api/admin/branches/:id`  
  - Single branch details.

- `PUT /api/admin/branches/:id`  
  - Update branch.

- `DELETE /api/admin/branches/:id`  
  - Soft-delete or deactivate (prefer soft so orders remain valid).

### 3.3 Branch Context Header

- **Dashboard requests:**  
  - Frontend sends `x-branch-id: <branchId>` on all tenant-scoped admin APIs when the user has switched branch.  
  - Backend uses this to:  
    - Scope **inventory** to that branch.  
    - Scope **orders** list (and POS create) to that branch.  
    - Scope **menu** if using branch-level overrides.  
    - Scope **users** list to staff assigned to that branch (or allow “all branches” for owner).

- **Validation:**  
  - If `x-branch-id` is sent, backend must check that the branch belongs to the tenant and that the current user is allowed to access it (`allowedBranchIds` or owner).  
  - If user has a single branch, backend can ignore or override header to that branch.

### 3.4 Existing APIs – Branch-Aware Behavior

| API | Change |
|-----|--------|
| `GET /api/admin/menu` | Optional query `?branchId=`. If supported, return menu with branch overrides (Option B). Otherwise return tenant menu. |
| `GET/POST/PUT/DELETE /api/admin/inventory` | Scope by branch: from `x-branch-id` or user’s single branch. Require branch for create/update. |
| `GET /api/admin/orders` | Filter by `x-branch-id` (and optional date/status). |
| `POST /api/pos/orders` | Body must include `branchId`; validate against tenant and user access. |
| `GET /api/admin/users` | Optional: filter by `branchId` (from header or query) to show staff for current branch. |
| `GET /api/admin/dashboard/summary` | Optional `x-branch-id`: summary for that branch only. |
| `GET/POST/PUT/DELETE /api/admin/branches/*` | As above; tenant-scoped, role-checked. |

### 3.5 Public Website (one site per restaurant)

- **GET /api/menu?subdomain=xxx**  
  - Response should include **branches** for the restaurant:  
  - `{ restaurant, menu, categories, branches: [{ id, name, code, address, ... }], ... }`  
  - So the frontend can show a branch selector (e.g. “Order from: Downtown / Mall”).

- **POST /api/orders/website**  
  - Body must include `branchId` (and existing fields: subdomain, customerName, customerPhone, deliveryAddress, items).  
  - Backend creates the order for that branch and validates that the branch belongs to the tenant.

---

## 4. Frontend Implementation (This Repo)

### 4.1 App-Level Branch Context

- **BranchContext** (in `contexts/BranchContext.js`):  
  - Holds: `currentBranch`, `branches`, `setCurrentBranch`, `loading`.  
  - Loads branch list from `GET /api/admin/branches` when user is logged in (tenant dashboard).  
  - Persists selected branch in `localStorage` (`restaurantos_branch_id`) so the choice survives refresh.  
  - If user has a single branch, auto-select it and optionally hide switcher.

- **_app.js**  
  - Wrap app with `BranchProvider` so dashboard pages and AdminLayout can use `useBranch()`.

### 4.2 API Client

- **apiClient**  
  - Reads current branch id from BranchContext (or localStorage fallback) and sends `x-branch-id` header on all admin API requests when present.  
  - `createPosOrder` and report/get helpers use the same header; POS payload will include `branchId` when backend expects it.

### 4.3 Admin Layout

- **Branch switcher** in header/sidebar (for non–super_admin, when `branches.length > 1`):  
  - Dropdown: current branch name → list of branches → on select, `setCurrentBranch(branch)` and optionally reload or refetch key data.  
  - Single-branch users: show branch name only (no switch) or hide.

### 4.4 Dashboard Pages

- **Branches page**  
  - List branches, “Switch to” (sets current branch), and later: add/edit branch (when backend is ready).  
  - Uses `getBranches()` and BranchContext.

- **POS**  
  - Uses `currentBranch` from context; `createPosOrder` sends `branchId` in body and `x-branch-id` in header (backend requirement).

- **Orders / Inventory / Overview**  
  - No UI change beyond using branch from context; API client sends `x-branch-id`, so lists and summary are branch-scoped when backend supports it.

### 4.5 Customer Website (`r/[subdomain].js`)

- **Branch selector**  
  - After restaurant/menu load, if `branches.length > 1`, show a selector (e.g. “Order from: [Downtown ▼]”).  
  - Store selected branch in component state (and optionally in sessionStorage for the visit).

- **Checkout**  
  - Include `branchId` in the body of `POST /api/orders/website`.  
  - If only one branch, use it by default and optionally hide the selector.

---

## 5. Summary Checklist

**Backend**

- [x] Branch CRUD: `GET/POST/GET/PUT/DELETE /api/admin/branches` (tenant-scoped).
- [x] Auth: return `defaultBranchId` and `allowedBranchIds` (or equivalent) in login/user.
- [x] All tenant admin APIs: accept and validate `x-branch-id`; scope orders, dashboard summary, and reports by branch (inventory remains restaurant-level for now; BranchInventory model exists for future per-branch inventory).
- [x] POS: `POST /api/pos/orders` body includes `branchId` when restaurant has branches; validate and store on order.
- [x] Website menu: `GET /api/menu?subdomain=xxx` returns `branches[]`.
- [x] Website order: `POST /api/orders/website` body includes `branchId` when restaurant has branches; validate and set on order.

**Frontend (this repo)**

- [x] BranchContext + BranchProvider in _app.js.
- [x] apiClient sends `x-branch-id` and supports branch in POS payload.
- [x] AdminLayout branch switcher.
- [x] Branches dashboard page (list + switch).
- [x] Website: branch selector and `branchId` in checkout payload.

Once the backend implements the above, the frontend is ready for full multi-branch behavior.
