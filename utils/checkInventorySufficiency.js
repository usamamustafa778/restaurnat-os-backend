/**
 * Resolve inventory item id whether the ref is an ObjectId, string, or populated { _id, name }.
 */
function inventoryItemId(ref) {
  if (ref == null) return null;
  if (typeof ref === 'object' && ref._id != null) return String(ref._id);
  return String(ref);
}

function normalizeUnit(unit) {
  const u = String(unit || '').trim().toLowerCase();
  if (u === 'g' || u === 'gram') return 'gram';
  if (u === 'kg' || u === 'kilogram') return 'kilogram';
  if (u === 'ml' || u === 'milliliter') return 'milliliter';
  if (u === 'l' || u === 'liter') return 'liter';
  if (u === 'pc' || u === 'pcs' || u === 'piece') return 'piece';
  if (u === 'dozen') return 'dozen';
  return u;
}

function convertToInventoryUnit(recipeQty, recipeUnitRaw, inventoryUnitRaw) {
  const recipeQtyNum = Number(recipeQty || 0);
  if (!recipeQtyNum) return 0;
  const recipeUnit = normalizeUnit(recipeUnitRaw);
  const inventoryUnit = normalizeUnit(inventoryUnitRaw);

  if (recipeUnit === 'gram' && inventoryUnit === 'kilogram') return recipeQtyNum / 1000;
  if (recipeUnit === 'kilogram' && inventoryUnit === 'gram') return recipeQtyNum * 1000;
  if (recipeUnit === 'milliliter' && inventoryUnit === 'liter') return recipeQtyNum / 1000;
  if (recipeUnit === 'liter' && inventoryUnit === 'milliliter') return recipeQtyNum * 1000;
  if (recipeUnit === 'piece' && inventoryUnit === 'dozen') return recipeQtyNum / 12;
  if (recipeUnit === 'dozen' && inventoryUnit === 'piece') return recipeQtyNum * 12;
  return recipeQtyNum;
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
    const needed = convertToInventoryUnit(
      Number(consumption.quantity) || 0,
      consumption.unit,
      inv.unit
    );
    const stock = Number(inv.currentStock);
    const currentStock = Number.isFinite(stock) ? stock : 0;
    if (needed > 0 && currentStock < needed) {
      insufficientItems.push(inv.name || invId);
    }
  }
  return { sufficient: insufficientItems.length === 0, insufficientItems };
}

module.exports = { checkInventorySufficiency };
