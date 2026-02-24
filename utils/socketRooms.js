/**
 * Room names for Socket.IO order events.
 * - restaurant:rid — all branches (e.g. "All branches" view)
 * - restaurant:rid:branch:bid — single branch (branch-scoped view)
 * Emit to both when order has a branch so branch view and "all" view both get updates.
 */
function getOrderRooms(restaurantId, branchId) {
  const rid = restaurantId && typeof restaurantId.toString === 'function' ? restaurantId.toString() : String(restaurantId);
  const rooms = [`restaurant:${rid}`];
  if (branchId) {
    const bid = typeof branchId.toString === 'function' ? branchId.toString() : String(branchId);
    rooms.push(`restaurant:${rid}:branch:${bid}`);
  }
  return rooms;
}

module.exports = { getOrderRooms };
