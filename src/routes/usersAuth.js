const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nm = require('nodemailer');

function getJwtSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }

  return process.env.JWT_SECRET;
}

function getEmailConfig() {
  const config = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD
  };

  if (!config.host || !config.user || !config.password) {
    throw new Error('Email configuration missing. Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD.');
  }

  return config;
}

async function sendForgotMail(email, otp) {
  const emailConfig = getEmailConfig();
  const transporter = nm.createTransport({
    host: emailConfig.host,
    port: emailConfig.port,
    secure: emailConfig.secure,
    auth: {
      user: emailConfig.user,
      pass: emailConfig.password
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
    from: emailConfig.user,
    to: email,
    subject: 'Here is your One-Time Password (OTP)',
    html: htmlContent
  };

  return transporter.sendMail(mailOptions);
}

// POST /api/users/create-user
router.post('/create-user', async (req, res) => {
  const db = pool.promise();
  let connection;
  let transactionStarted = false;

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

    if (!fullName || !workEmail || !companyName || !password || !confirmPassword) {
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

    const checkSql = 'SELECT userId FROM users WHERE workEmail = ? LIMIT 1';
    const [rows] = await db.query(checkSql, [workEmail]);

    if (rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    const tenantId = uuidv4();
    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const insertTenantSql = `
      INSERT INTO tenants (
        tenantId, companyName, companyDomain, companySize, expectedAssets,
        subscriptionType
      ) VALUES (?, ?, ?, ?, ?, ?)
    `;

    await connection.query(insertTenantSql, [
      tenantId,
      companyName,
      companyDomain || null,
      companySize || null,
      expectedAssets || null,
      subscriptionType || null
    ]);

    const insertUserSql = `
      INSERT INTO users (
        userId, tenantId, fullName, workEmail, phoneNumber, jobTitle,
        password, role, status, insertedBy, updatedBy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await connection.query(insertUserSql, [
      userId,
      tenantId,
      fullName,
      workEmail,
      phoneNumber || null,
      jobTitle || null,
      hashedPassword,
      'admin',
      'active',
      userId,
      userId
    ]);

    await connection.commit();
    transactionStarted = false;

    const token = jwt.sign(
      {
        userId,
        tenantId,
        workEmail,
        role: 'admin',
        companyName
      },
      getJwtSecret(),
      { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
    );

    return res.status(201).json({
      success: true,
      message: 'User created successfully',
      token,
      data: {
        userId,
        tenantId,
        fullName,
        workEmail,
        companyName,
        jobTitle
      }
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  } finally {
    if (connection) {
      connection.release();
    }
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
      SELECT
        u.userId,
        u.tenantId,
        u.fullName,
        u.workEmail,
        u.password,
        u.role,
        u.status,
        u.jobTitle,
        t.companyName,
        t.companyDomain,
        t.companySize,
        t.expectedAssets,
        t.subscriptionType
      FROM users u
      INNER JOIN tenants t ON t.tenantId = u.tenantId
      WHERE u.workEmail = ?
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

    if (user.status && user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'User account is not active'
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await sendForgotMail(user.workEmail, otp);

    const otpToken = jwt.sign(
      {
        userId: user.userId,
        tenantId: user.tenantId,
        fullName: user.fullName,
        workEmail: user.workEmail,
        role: user.role,
        companyName: user.companyName || null,
        companyDomain: user.companyDomain || null,
        companySize: user.companySize || null,
        expectedAssets: user.expectedAssets || null,
        subscriptionType: user.subscriptionType || null,
        jobTitle: user.jobTitle || null,
        otp,
        purpose: 'login_otp'
      },
      getJwtSecret(),
      { expiresIn: '2m' }
    );

    return res.status(200).json({
      success: true,
      message: 'OTP sent to your email',
      otpToken,
      data: {
        userId: user.userId,
        tenantId: user.tenantId,
        fullName: user.fullName,
        workEmail: user.workEmail,
        role: user.role,
        companyName: user.companyName || null,
        companyDomain: user.companyDomain || null,
        companySize: user.companySize || null,
        expectedAssets: user.expectedAssets || null,
        subscriptionType: user.subscriptionType || null,
        jobTitle: user.jobTitle
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
      decoded = jwt.verify(otpToken, getJwtSecret());
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
        tenantId: decoded.tenantId,
        workEmail: decoded.workEmail,
        role: decoded.role
      },
      getJwtSecret(),
      { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
    );

    return res.status(200).json({
      success: true,
      message: 'Login verified successfully',
      token: authToken,
      data: {
        userId: decoded.userId,
        tenantId: decoded.tenantId,
        fullName: decoded.fullName,
        workEmail: decoded.workEmail,
        role: decoded.role,
        companyName: decoded.companyName,
        companyDomain: decoded.companyDomain,
        companySize: decoded.companySize,
        expectedAssets: decoded.expectedAssets,
        subscriptionType: decoded.subscriptionType,
        jobTitle: decoded.jobTitle
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while verifying OTP',
      error: error.message
    });
  }
});

// POST /api/users/forgot-password-generate-otp
router.post('/forgot-password-generate-otp', async (req, res) => {
  try {
    const { workEmail } = req.body;

    if (!workEmail) {
      return res.status(400).json({
        success: false,
        message: 'workEmail is required'
      });
    }

    const sql = `
      SELECT userId, fullName, workEmail
      FROM users
      WHERE workEmail = ?
      LIMIT 1
    `;
    const [rows] = await pool.promise().query(sql, [workEmail]);

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'User not found with this email'
      });
    }

    const user = rows[0];
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await sendForgotMail(user.workEmail, otp);

    const otpToken = jwt.sign(
      {
        userId: user.userId,
        workEmail: user.workEmail,
        otp,
        purpose: 'forgot_password_otp'
      },
      getJwtSecret(),
      { expiresIn: '2m' }
    );

    return res.status(200).json({
      success: true,
      message: 'OTP sent to your email',
      otpToken
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while generating forgot password OTP',
      error: error.message
    });
  }
});

// POST /api/users/verify-forgot-password-otp
router.post('/verify-forgot-password-otp', async (req, res) => {
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
      decoded = jwt.verify(otpToken, getJwtSecret());
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired OTP token'
      });
    }

    if (decoded.purpose !== 'forgot_password_otp' || String(decoded.otp) !== String(otp)) {
      return res.status(401).json({
        success: false,
        message: 'Invalid OTP'
      });
    }

    const resetToken = jwt.sign(
      {
        userId: decoded.userId,
        workEmail: decoded.workEmail,
        purpose: 'password_reset'
      },
      getJwtSecret(),
      { expiresIn: '10m' }
    );

    return res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      resetToken
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while verifying forgot password OTP',
      error: error.message
    });
  }
});

// POST /api/users/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { resetToken, newPassword, confirmPassword } = req.body;

    if (!resetToken || !newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'resetToken, newPassword and confirmPassword are required'
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'Passwords do not match'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(resetToken, getJwtSecret());
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired reset token'
      });
    }

    if (decoded.purpose !== 'password_reset') {
      return res.status(401).json({
        success: false,
        message: 'Invalid reset token'
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const updateSql = `
      UPDATE users
      SET password = ?, updatedBy = ?
      WHERE userId = ? AND workEmail = ?
    `;
    const [result] = await pool.promise().query(updateSql, [
      hashedPassword,
      decoded.userId,
      decoded.userId,
      decoded.workEmail
    ]);

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while resetting password',
      error: error.message
    });
  }
});

module.exports = router;
