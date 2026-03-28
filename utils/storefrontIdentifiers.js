function normalizeEmail(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase();
  if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return '';
  return v;
}

/** Digits only, min length 8 (adjust per region as needed). */
function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 8 ? d : '';
}

module.exports = { normalizeEmail, normalizePhone };
