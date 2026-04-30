require('dotenv').config();

const path = require('path');
const express = require('express');
const pool = require('./config/db');
const indexRoutes = require('./routes/index');
const usersAuthRoutes = require('./routes/usersAuth');
const queryRoutes = require('./routes/query');
const countryRoutes = require('./routes/country');
const assetsRoutes = require('./routes/assets');
const retiredInverotyRoutes = require('./routes/retiredInveroty');
const ticktsRoutes = require('./routes/tickts');
const analyticsRoutes = require('./routes/analytics');
const reportsRoutes = require('./routes/reports');
const documentsRoutes = require('./routes/documents');
const warrantyTrackerRoutes = require('./routes/warrantyTracker');
const tenantUserAuthRoutes = require('./routes/tenant-user-auth');
const settingsRoutes = require('./routes/settings');
const cors = require('cors');

const app = express();
app.use(cors());

pool.getConnection((err, connection) => {
  if (err) {
    console.error('Database connection failed:', err.message);
  } else {
    console.log('Database connected successfully');
    connection.release();
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/', indexRoutes);
app.use('/api/users', usersAuthRoutes);
app.use('/api/query', queryRoutes);
app.use('/api/country', countryRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/retired-inventory', retiredInverotyRoutes);
app.use('/api/tickets', ticktsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/warranty-tracker', warrantyTrackerRoutes);
app.use('/api/tenant-user-auth', tenantUserAuthRoutes);
app.use('/api/settings', settingsRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
