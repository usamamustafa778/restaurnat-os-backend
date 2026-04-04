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
    const invId = consumption.inventoryItem ? consumption.inventoryItem.toString() : null;
    if (!invId) continue;
    const inv = inventoryMap.get(invId);
    if (!inv) {
      insufficientItems.push('Unknown ingredient');
      continue;
    }
    const needed = consumption.quantity || 0;
    if (needed > 0 && inv.currentStock < needed) {
      insufficientItems.push(inv.name);
    }
  }
  return { sufficient: insufficientItems.length === 0, insufficientItems };
}

module.exports = { checkInventorySufficiency };
