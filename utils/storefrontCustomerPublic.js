/**
 * JSON shape for storefront customer (login responses, /auth/me, order response).
 */
function storefrontCustomerToPublic(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    firstName: doc.firstName,
    lastName: doc.lastName,
    email: doc.email || '',
    phone: doc.phone || '',
    hasPassword: !!doc.password,
    savedPhone: doc.savedPhone || '',
    savedDeliveryAddress: doc.savedDeliveryAddress || '',
  };
}

module.exports = { storefrontCustomerToPublic };
