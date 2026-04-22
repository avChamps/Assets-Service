const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nm = require('nodemailer');

const GMAIL_USERNAME = 'hello@avchamps.com';
const GMAIL_PASSWORD = 'Bl@ckh0r5e@2028!';

async function sendForgotMail(email, otp) {
  const transporter = nm.createTransport({
    host: 'smtpout.secureserver.net',
    port: 465,
    secure: true,
    auth: {
      user: GMAIL_USERNAME,
      pass: GMAIL_PASSWORD
    }
  });

  const htmlContent = `
    <!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your OTP Code</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }
        table {
            border-collapse: collapse;
        }
        @media screen and (max-width: 600px) {
            .container {
                width: 100% !important;
                padding: 0 15px !important;
            }
            .content {
                padding: 30px 15px !important;
            }
            .header-icon {
                width: 60px !important;
                height: 60px !important;
            }
            .header-title {
                font-size: 32px !important;
            }
            .otp-code {
                font-size: 28px !important;
                padding: 16px !important;
            }
        }
    </style>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f7f6;">

    <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f4f7f6;">
        <tr>
            <td align="center" style="padding: 40px 0;">
                <table class="container" width="600" border="0" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #dfe3e8;">
                    <tr>
                        <td align="center" class="content" style="padding: 40px 40px 30px 40px;">
                            <img src="https://img.icons8.com/fluency/96/privacy.png" alt="Secure" width="80" height="80" class="header-icon" style="display: block; margin-bottom: 20px;">
                            <h1 class="header-title" style="font-family: Arial, sans-serif; font-size: 42px; font-weight: bold; color: #1c293b; margin: 0;">
                                Verification Code
                            </h1>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 0 40px 30px 40px; font-family: Arial, sans-serif; font-size: 16px; line-height: 1.7; color: #555555;">
                            <p style="margin: 0 0 20px;">Hello,</p>
                            <p style="margin: 0 0 24px;">Your One-Time Password (OTP) for account verification is:</p>

                            <table width="100%" border="0" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td align="center" style="background-color: #f4f7f6; border-radius: 8px; padding: 20px;">
                                        <p class="otp-code" style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 700; color: #1c293b; letter-spacing: 3px; margin: 0;">
                                           ${otp}
                                        </p>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin: 24px 0 0px;">This OTP is valid for <strong style="color: #000000;">2 minutes</strong>. Please do not share this code with anyone.</p>
                            <p style="margin: 16px 0 0px;">If you didn't request this code, please ignore this email.</p>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 0 40px 30px 40px;">
                            <table width="100%" border="0" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="border-top: 1px solid #eeeeee; padding-top: 30px;">
                                        <p style="margin: 0;"><strong>Sincerely,</strong><br>The AV Champs Team</p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>

                <table width="600" border="0" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; margin: 0 auto;">
                    <tr>
                        <td style="padding: 30px 20px; text-align: center;">
                            <p style="font-family: Arial, sans-serif; font-size: 12px; color: #999999; margin: 0 0 10px;">
                                Copyrights � 2025 AV CHAMPS. All rights reserved.
                            </p>
                            <p style="font-family: Arial, sans-serif; font-size: 12px; color: #999999; margin: 0;">
                                You are receiving this email because you requested a login code.
                            </p>
                        </td>
                    </tr>
                </table>

            </td>
        </tr>
    </table>

</body>
</html>
  `;

  const mailOptions = {
    from: GMAIL_USERNAME,
    to: email,
    subject: 'Here is your One-Time Password (OTP)',
    html: htmlContent
  };

  return transporter.sendMail(mailOptions);
}

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

    const checkSql = 'SELECT userId FROM Users WHERE workEmail = ? LIMIT 1';
    const [rows] = await pool.promise().query(checkSql, [workEmail]);

    if (rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);

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

    const token = jwt.sign(
      {
        userId,
        workEmail,
        role: 'admin',
        companyName: companyName || null
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
    );

    return res.status(201).json({
      success: true,
      message: 'User created successfully',
      token,
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

// POST /api/users/login-generate-otp
router.post('/login-generate-otp', async (req, res) => {
  try {
    const { workEmail, password } = req.body;

    if (!workEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'workEmail and password are required'
      });
    }

    const sql = `
      SELECT userId, fullName, workEmail, password, companyName
      FROM Users
      WHERE workEmail = ?
      LIMIT 1
    `;
    const [rows] = await pool.promise().query(sql, [workEmail]);

    if (!rows.length) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    if (!GMAIL_USERNAME || !GMAIL_PASSWORD) {
      return res.status(500).json({
        success: false,
        message: 'Email configuration missing. Set GMAIL_USERNAME and GMAIL_PASSWORD.'
      });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await sendForgotMail(user.workEmail, otp);

    const otpToken = jwt.sign(
      {
        userId: user.userId,
        workEmail: user.workEmail,
        otp,
        purpose: 'login_otp'
      },
      process.env.JWT_SECRET,
      { expiresIn: '2m' }
    );

    return res.status(200).json({
      success: true,
      message: 'OTP sent to your email',
      otpToken,
      data: {
        userId: user.userId,
        fullName: user.fullName,
        workEmail: user.workEmail,
        companyName: user.companyName || null
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while generating OTP',
      error: error.message
    });
  }
});

// POST /api/users/verify-login-otp
router.post('/verify-login-otp', async (req, res) => {
  try {
    const { otpToken, otp } = req.body;

    if (!otpToken || !otp) {
      return res.status(400).json({
        success: false,
        message: 'otpToken and otp are required'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(otpToken, process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired OTP token'
      });
    }

    if (decoded.purpose !== 'login_otp' || String(decoded.otp) !== String(otp)) {
      return res.status(401).json({
        success: false,
        message: 'Invalid OTP'
      });
    }

    const authToken = jwt.sign(
      {
        userId: decoded.userId,
        workEmail: decoded.workEmail,
        role: 'admin'
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
    );

    return res.status(200).json({
      success: true,
      message: 'Login verified successfully',
      token: authToken
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while verifying OTP',
      error: error.message
    });
  }
});

module.exports = router;
