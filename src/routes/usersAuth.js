const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken'); // ✅ NEW

// POST /api/users/create-user
router.post('/create-user', async (req, res) => {
  try {
    const {
      fullName,
      workEmail,
      phoneNumber,
      jobTitle,
      companyName,
      companyDomain,
      companySize,
      expectedAssets,
      subscriptionType,
      password,
      confirmPassword
    } = req.body;

    // ✅ Validation
    if (!fullName || !workEmail || !password || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'Required fields missing'
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'Passwords do not match'
      });
    }

    // ✅ Check existing user
    const checkSql = 'SELECT userId FROM Users WHERE workEmail = ? LIMIT 1';
    const [rows] = await pool.promise().query(checkSql, [workEmail]);

    if (rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    // ✅ Generate UUID
    const userId = uuidv4();

    // ✅ Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ Insert user
    const insertSql = `
      INSERT INTO Users (
        userId, fullName, workEmail, phoneNumber, jobTitle,
        companyName, companyDomain, companySize, expectedAssets,
        subscriptionType, password, insertedBy, updatedBy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await pool.promise().query(insertSql, [
      userId,
      fullName,
      workEmail,
      phoneNumber || null,
      jobTitle || null,
      companyName || null,
      companyDomain || null,
      companySize || null,
      expectedAssets || null,
      subscriptionType || null,
      hashedPassword,
      userId,
      userId
    ]);

   
// ✅ Generate JWT Token
const token = jwt.sign(
  {
    userId,
    workEmail,
    role: 'admin', // since signup user is admin
    companyName: companyName || null
  },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
);


    // ✅ Response with token
    return res.status(201).json({
      success: true,
      message: 'User created successfully',
      token, // 🔥 TOKEN RETURNED
      data: {
        userId,
        fullName,
        workEmail,
        companyName,
        jobTitle
      }
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

module.exports = router;