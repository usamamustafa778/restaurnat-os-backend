const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const morgan = require('morgan');
const cors = require('cors');
const dotenv = require('dotenv');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const Restaurant = require('./models/Restaurant');
const { getOrderRooms } = require('./utils/socketRooms');

dotenv.config();

const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const connectDB = require('./config/db');

const authRoutes = require('./routes/authRoutes');
const customerRoutes = require('./routes/customerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const superAdminRoutes = require('./routes/superAdminRoutes');
const posRoutes = require('./routes/posRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const integrationRoutes = require('./routes/integrationRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const profileRoutes = require('./routes/profileRoutes');
const dealRoutes = require('./routes/dealRoutes');
const menuRoutes = require('./routes/menuRoutes');
const contactRoutes = require('./routes/contactRoutes');
const riderRoutes = require('./routes/riderRoutes');
const storefrontRoutes = require('./routes/storefrontRoutes');
const purchaseRoutes = require('./routes/purchaseRoutes');
const accountingSetupRoutes    = require('./routes/accounting/setup');
const accountingAccountsRoutes = require('./routes/accounting/accounts');
const accountingPartiesRoutes  = require('./routes/accounting/parties');
const accountingVouchersRoutes = require('./routes/accounting/vouchers');
const accountingReportsRoutes  = require('./routes/accounting/reports');
// Eagerly register accounting models so their indexes are created on startup
require('./models/accounting');

const app = express();
const server = http.createServer(app);

// Socket.IO: attach to same HTTP server, CORS for frontend origin
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      return next(new Error('Not authorized, token missing'));
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) {
      return next(new Error('Not authorized, user not found'));
    }
    socket.user = {
      id: user._id.toString(),
      role: user.role,
      restaurant: user.restaurant ? user.restaurant.toString() : null,
    };
    if (!socket.user.restaurant) {
      return next(new Error('User is not linked to any restaurant'));
    }
    const restaurant = await Restaurant.findById(socket.user.restaurant);
    if (!restaurant) {
      return next(new Error('Restaurant not found'));
    }
    socket.restaurantId = restaurant._id.toString();
    const branchId = socket.handshake.auth?.branchId || socket.handshake.query?.branchId || null;
    socket.branchId = branchId && branchId !== 'all' ? branchId : null;
    next();
  } catch (err) {
    next(new Error('Not authorized, token invalid'));
  }
});

io.on('connection', (socket) => {
  // Branch-scoped client: only join branch room. "All branches" client: join restaurant room only.
  const rooms = getOrderRooms(socket.restaurantId, socket.branchId);
  rooms.forEach((room) => socket.join(room));
});

app.set('io', io);

// CORS – allow dashboard and storefront origins
const corsOptions = {
  origin: function (origin, callback) {
    const dashboardOrigin = process.env.DASHBOARD_ORIGIN || '';
    const storefrontPattern = process.env.STOREFRONT_ORIGIN_PATTERN || '';
    // Allow requests with no origin (server-to-server, Postman, etc.)
    if (!origin) return callback(null, true);
    if (dashboardOrigin && origin === dashboardOrigin) return callback(null, true);
    if (storefrontPattern && new RegExp(storefrontPattern).test(origin)) return callback(null, true);
    // Fallback: allow all in dev when no origins are configured
    if (!dashboardOrigin && !storefrontPattern) return callback(null, true);
    callback(null, true);
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(morgan('dev'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api', customerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/super', superAdminRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api', integrationRoutes); // mounts /api/webhooks/foodpanda/:restaurantId
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/deals', dealRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api', contactRoutes);
app.use('/api/rider', riderRoutes);
app.use('/api/storefront', storefrontRoutes);
app.use('/api/purchase', purchaseRoutes);
app.use('/api/accounting/setup',    accountingSetupRoutes);
app.use('/api/accounting',          accountingSetupRoutes);   // exposes /api/accounting/sync-sales
app.use('/api/accounting/accounts', accountingAccountsRoutes);
app.use('/api/accounting/parties',  accountingPartiesRoutes);
app.use('/api/accounting/vouchers', accountingVouchersRoutes);
app.use('/api/accounting/reports',  accountingReportsRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    server.listen(PORT, () => {
      const url = `http://localhost:${PORT}`;
      console.log(`Server running on port ${PORT} (${url})`);
    });
  } catch (error) {
    console.error('Failed to start server', error);
    process.exit(1);
  }
};

startServer();

module.exports = app;

