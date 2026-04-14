/**
 * Delivery zones (name + fee) for website / POS / rider checkout.
 */

const mongoose = require('mongoose');

function normalizeDbList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => ({
      _id: l._id,
      name: String(l.name || '')
        .trim()
        .slice(0, 120),
      fee: Math.max(0, Math.min(1e7, Number(l.fee) || 0)),
      sortOrder: Number.isFinite(Number(l.sortOrder)) ? Number(l.sortOrder) : 0,
    }))
    .filter((l) => l.name.length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((l, idx) => ({ ...l, sortOrder: idx }));
}

/** Sanitize payload from dashboard / branch overrides (plain JSON). Preserves valid _id / id; assigns new ObjectId for new rows. */
function sanitizeDeliveryLocationsInput(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x, i) => {
      const idRaw = x?._id ?? x?.id;
      let _id;
      if (idRaw != null && String(idRaw).trim() && mongoose.Types.ObjectId.isValid(String(idRaw))) {
        _id = new mongoose.Types.ObjectId(String(idRaw));
      } else {
        _id = new mongoose.Types.ObjectId();
      }
      return {
        _id,
        name: String(x?.name ?? '')
          .trim()
          .slice(0, 120),
        fee: Math.max(0, Math.min(1e7, Number(x?.fee) || 0)),
        sortOrder: Number.isFinite(Number(x?.sortOrder)) ? Number(x.sortOrder) : i,
      };
    })
    .filter((x) => x.name.length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((x, idx) => ({ _id: x._id, name: x.name, fee: x.fee, sortOrder: idx }));
}

/**
 * Branch overrides replace the whole list when non-empty.
 */
function mergedDeliveryLocations(restaurant, branch) {
  const ov = branch?.websiteOverrides?.deliveryLocations;
  if (Array.isArray(ov) && ov.length > 0) {
    return normalizeDbList(ov);
  }
  return normalizeDbList(restaurant?.website?.deliveryLocations);
}

function pickDeliveryLocation(locations, deliveryLocationId) {
  if (!deliveryLocationId || !locations?.length) return null;
  const want = String(deliveryLocationId).trim();
  if (!want) return null;
  for (const loc of locations) {
    const lid = loc._id != null ? String(loc._id) : '';
    if (lid && lid === want) {
      return { name: loc.name, fee: Math.max(0, Number(loc.fee) || 0) };
    }
  }
  return null;
}

function publicDeliveryZones(restaurant, branch) {
  return mergedDeliveryLocations(restaurant, branch).map((l) => ({
    id: l._id ? String(l._id) : '',
    name: l.name,
    fee: l.fee,
  }));
}

module.exports = {
  sanitizeDeliveryLocationsInput,
  mergedDeliveryLocations,
  pickDeliveryLocation,
  publicDeliveryZones,
  normalizeDbList,
};
