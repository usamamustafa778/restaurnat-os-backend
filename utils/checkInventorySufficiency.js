/**
 * Resolve inventory item id whether the ref is an ObjectId, string, or populated { _id, name }.
 */
function inventoryItemId(ref) {
  if (ref == null) return null;
  if (typeof ref === 'object' && ref._id != null) return String(ref._id);
  return String(ref);
}

/**
 * Whether a menu item has enough stock for at least one sale (same logic as POS / admin menu).
 * @param {object} menuItem — Mongoose doc or lean object with inventoryConsumptions
 * @param {Map<string, { name?: string, currentStock: number }>} inventoryMap
 */
function checkInventorySufficiency(menuItem, inventoryMap) {
  const insufficientItems = [];
  if (!menuItem.inventoryConsumptions || menuItem.inventoryConsumptions.length === 0) {
    return { sufficient: true, insufficientItems };
  }
  for (const consumption of menuItem.inventoryConsumptions) {
    const invId = inventoryItemId(consumption.inventoryItem);
    if (!invId) continue;
    const inv = inventoryMap.get(invId);
    if (!inv) {
      insufficientItems.push('Unknown ingredient');
      continue;
    }
    const needed = Number(consumption.quantity) || 0;
    const stock = Number(inv.currentStock);
    const currentStock = Number.isFinite(stock) ? stock : 0;
    if (needed > 0 && currentStock < needed) {
      insufficientItems.push(inv.name || invId);
    }
  }
  return { sufficient: insufficientItems.length === 0, insufficientItems };
}

module.exports = { checkInventorySufficiency };
