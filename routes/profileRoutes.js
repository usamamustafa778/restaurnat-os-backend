const express = require('express');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Multer for profile image upload (memory storage -> Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  },
});

// All profile routes require authentication
router.use(protect);

// @route   GET /api/profile
// @desc    Get current user profile
// @access  Authenticated
router.get('/', async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      profileImageUrl: user.profileImageUrl || null,
      createdAt: user.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/profile
// @desc    Update current user name & email
// @access  Authenticated
router.put('/', async (req, res, next) => {
  try {
    const { name, email } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ message: 'Name is required' });
      user.name = name.trim();
    }

    if (email !== undefined) {
      const trimmed = email.toLowerCase().trim();
      if (!trimmed) return res.status(400).json({ message: 'Email is required' });
      // Check uniqueness
      const existing = await User.findOne({ email: trimmed, _id: { $ne: user._id } });
      if (existing) return res.status(400).json({ message: 'Email already in use' });
      user.email = trimmed;
    }

    await user.save();

    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      profileImageUrl: user.profileImageUrl || null,
      createdAt: user.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/profile/password
// @desc    Change password (requires current password)
// @access  Authenticated
router.put('/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/profile/avatar
// @desc    Upload profile image to Cloudinary and save URL
// @access  Authenticated
router.post('/avatar', upload.single('image'), async (req, res, next) => {
  try {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
      return res.status(503).json({
        message: 'Image upload is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in the server environment.',
      });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No image file provided' });
    }

    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
    });

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `restaurant-os/avatars`,
          resource_type: 'image',
          transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face', quality: 'auto' }],
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.profileImageUrl = result.secure_url;
    await user.save();

    res.json({
      profileImageUrl: result.secure_url,
      publicId: result.public_id,
    });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/profile/avatar
// @desc    Remove profile image
// @access  Authenticated
router.delete('/avatar', async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.profileImageUrl = null;
    await user.save();

    res.json({ message: 'Profile image removed' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
