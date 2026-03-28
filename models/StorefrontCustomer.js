const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const storefrontCustomerSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    firstName: {
      type: String,
      trim: true,
      default: '',
    },
    lastName: {
      type: String,
      trim: true,
      default: '',
    },
    password: {
      type: String,
      minlength: 6,
      default: undefined,
    },
    verified: {
      type: Boolean,
      default: false,
    },
    signupOtp: { type: String, default: null },
    signupOtpExpires: { type: Date, default: null },
    loginOtp: { type: String, default: null },
    loginOtpExpires: { type: Date, default: null },
    /** Last checkout contact phone (editable per order; used to prefill checkout). */
    savedPhone: { type: String, trim: true, default: '' },
    /** Last delivery address from checkout (editable per order). */
    savedDeliveryAddress: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

storefrontCustomerSchema.index(
  { restaurant: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $type: 'string', $gt: '' } },
  }
);
storefrontCustomerSchema.index(
  { restaurant: 1, phone: 1 },
  {
    unique: true,
    partialFilterExpression: { phone: { $type: 'string', $gt: '' } },
  }
);

storefrontCustomerSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

storefrontCustomerSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

const StorefrontCustomer = mongoose.model('StorefrontCustomer', storefrontCustomerSchema);

module.exports = StorefrontCustomer;
