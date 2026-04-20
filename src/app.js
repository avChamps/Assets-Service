require('dotenv').config();

const path = require('path');
const express = require('express');
const pool = require('./config/db');
const indexRoutes = require('./routes/index');
const usersAuthRoutes = require('./routes/usersAuth');
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
