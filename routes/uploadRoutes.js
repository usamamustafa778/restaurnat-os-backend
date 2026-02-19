const express = require('express');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { protect, requireRole, requireRestaurant } = require('../middleware/authMiddleware');
const { getCloudinaryConfig } = require('../config/cloudinary');

const router = express.Router();

// Configure Cloudinary from env (CLOUDINARY_* vars or CLOUDINARY_URL)
const cloudinaryEnv = getCloudinaryConfig();
if (cloudinaryEnv) {
  cloudinary.config(cloudinaryEnv);
}

// Use memory storage so we can stream the buffer to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  },
});

// Auth – any logged-in restaurant user can upload
router.use(protect, requireRole('staff', 'restaurant_admin', 'admin', 'product_manager', 'manager'), requireRestaurant);

// @route   POST /api/upload/image
// @desc    Upload an image to Cloudinary and return the URL
// @access  Authenticated restaurant users
router.post('/image', upload.single('image'), async (req, res, next) => {
  try {
    if (!getCloudinaryConfig()) {
      return res.status(503).json({
        message: 'Image upload is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET, or CLOUDINARY_URL (e.g. cloudinary://api_key:api_secret@cloud_name).',
      });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No image file provided' });
    }

    const restaurantId = req.restaurant._id.toString();

    // Upload buffer to Cloudinary via a stream
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `restaurant-os/${restaurantId}`,
          resource_type: 'image',
          transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    res.json({
      url: result.secure_url,
      publicId: result.public_id,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
