const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    role: {
      type: String,
      enum: [
        'super_admin',
        'restaurant_admin',
        'staff', // legacy
        'admin',
        'product_manager',
        'cashier',
        'manager',
        'kitchen_staff',
        'order_taker',
        'delivery_rider'
      ],
      default: 'manager',
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    vehicleType: {
      type: String,
      enum: ['bike', 'bicycle', 'car', 'other', null],
      default: null,
    },
    profileImageUrl: {
      type: String,
      default: null,
    },
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      // super_admin may not belong to any single restaurant
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationOtp: {
      type: String,
    },
    emailVerificationOtpExpires: {
      type: Date,
    },
    resetPasswordOtp: {
      type: String,
    },
    resetPasswordOtpExpires: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Hash password before save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    return next();
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password
userSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.model('User', userSchema);

module.exports = User;


