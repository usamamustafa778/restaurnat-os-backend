const express = require('express');
const Lead = require('../models/Lead');

const router = express.Router();

// @route   POST /api/contact
// @desc    Submit contact/lead form (public, no auth)
// @access  Public
router.post('/contact', async (req, res, next) => {
  try {
    const { name, phone, email, message } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'Name is required.' });
    }
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ message: 'Phone is required.' });
    }
    if (!email || !String(email).trim()) {
      return res.status(400).json({ message: 'Email is required.' });
    }
    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: 'Message is required.' });
    }
    const lead = await Lead.create({
      name: String(name).trim(),
      phone: String(phone).trim(),
      email: String(email).trim().toLowerCase(),
      message: String(message).trim(),
    });
    res.status(201).json({
      message: 'Thank you! Your message has been sent.',
      id: lead._id,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
