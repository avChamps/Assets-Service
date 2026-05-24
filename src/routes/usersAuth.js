const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nm = require('nodemailer');
const { logAuditEvent } = require('../utils/auditLogger');
const { sendMessageToGroup } = require('../config/whatsapp');

const DEFAULT_SIGNUP_SUBSCRIPTION_TYPE = 'trial';
const DEFAULT_SIGNUP_SUBSCRIPTION_AMOUNT = 0;
const DEFAULT_SIGNUP_SUBSCRIPTION_CURRENCY = 'INR';

function getJwtSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }

  return process.env.JWT_SECRET;
}

function toBoolean(value) {
  return value === true || value === 1 || value === '1';
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendForgotMail(email, otp) {
  const emailConfig = getEmailConfig();
  const loginUrl = escapeHtml(process.env.APP_LOGIN_URL || process.env.FRONTEND_URL || 'https://assetsystems.org/login');
  const otpBoxes = String(otp || '')
    .split('')
    .map((digit) => `
      <td style="padding: 0 6px 0 0;">
        <span style="display: inline-block; width: 36px; height: 36px; border: 1px solid #1f5cff; border-radius: 3px; color: #1f5cff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 18px; line-height: 36px; text-align: center; font-weight: 500;">${escapeHtml(digit)}</span>
      </td>
    `)
    .join('');
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
                                        <p style="margin: 0;"><strong>Sincerely,</strong><br>TheAsset SystemsTeam</p>
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
                                Copyrights � 2025 Asset Systems. All rights reserved.
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

  const verificationHtmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verify Your E-Mail Address</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #eef1f5;">
      <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #eef1f5;">
        <tr>
          <td align="center" style="padding: 20px 8px;">
            <table width="600" border="0" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; background-color: #ffffff; border: 1px solid #d5dbe5;">
              <tr>
                <td align="center" style="background-color: #3f5ed7; padding: 62px 24px 52px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                  <div style="font-size: 0; line-height: 0; margin-bottom: 16px;">
                    <span style="display: inline-block; width: 52px; height: 1px; background-color: #ffffff; vertical-align: middle;"></span>
                    <span style="display: inline-block; width: 32px; color: #ffffff; font-size: 22px; line-height: 22px; vertical-align: middle;">&#128737;</span>
                    <span style="display: inline-block; width: 52px; height: 1px; background-color: #ffffff; vertical-align: middle;"></span>
                  </div>
                  <p style="margin: 0 0 10px; font-size: 11px; line-height: 1.2; font-weight: 800; letter-spacing: 1.3px; text-transform: uppercase;">Security Verification</p>
                  <h1 style="margin: 0; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 34px; line-height: 1.12; font-weight: 700; color: #ffffff;">Verify Your E-Mail Address</h1>
                </td>
              </tr>
              <tr>
                <td style="padding: 52px 48px 44px; color: #253858; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.85; font-weight: 400;">
                  <p style="margin: 0 0 6px;">Hello!</p>
                  <p style="margin: 0 0 18px;">Please use the following One Time Password (OTP)</p>

                  <table border="0" cellpadding="0" cellspacing="0" style="margin: 0 0 22px;">
                    <tr>
                      ${otpBoxes}
                    </tr>
                  </table>

                  <p style="margin: 0 0 20px;">This passcode will only be valid for the next 2 minutes. If the passcode does not work, you can use this login verification link:</p>
                  <table border="0" cellpadding="0" cellspacing="0" style="margin: 0 0 32px;">
                    <tr>
                      <td align="center" style="background-color: #3f5ed7; border-radius: 3px;">
                        <a href="${loginUrl}" style="display: inline-block; padding: 13px 28px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; line-height: 1; font-weight: 800; text-decoration: none;">Verify Email</a>
                      </td>
                    </tr>
                  </table>

                  <p style="margin: 0 0 54px; color: #ff2f2f; font-size: 11px; line-height: 1.8;"><strong>Note:</strong> This OTP is time sensitive and confidential. Please do not share it with anyone.</p>
                  <p style="margin: 0;">Thank you,<br><strong>Team!</strong></p>
                </td>
              </tr>
              <tr>
                <td align="center" style="background-color: #eef1f5; padding: 34px 24px 32px; color: #53657d; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.8;">
                  <p style="margin: 0 0 8px; color: #1f5cff; font-size: 13px; font-weight: 700;">Get in touch</p>
                  <p style="margin: 0;">+91-9966416417<br>support@assetsystems.org</p>
                </td>
              </tr>
              <tr>
                <td align="center" style="background-color: #3f5ed7; padding: 18px 20px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 10px; line-height: 1.4; font-weight: 700;">
                  @2026, All Rihts reserved
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
    html: verificationHtmlContent
  };

  return transporter.sendMail(mailOptions);
}

async function sendSignupWelcomeMail(user) {
  const emailConfig = getEmailConfig();
  const safeFullName = escapeHtml(user.fullName || 'Account Holder');
  const safeCompanyName = escapeHtml(user.companyName || 'Your company');
  const safeSubscriptionType = escapeHtml(user.subscriptionType || DEFAULT_SIGNUP_SUBSCRIPTION_TYPE);
  const safePlanLabel = escapeHtml(`${safeSubscriptionType.charAt(0).toUpperCase()}${safeSubscriptionType.slice(1)} Plan (Active)`);
  const loginUrl = escapeHtml(process.env.APP_LOGIN_URL || process.env.FRONTEND_URL || 'https://assetsystems.org/login');
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
      <title>Welcome to the Platform</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #eef1f5;">
      <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #eef1f5;">
        <tr>
          <td align="center" style="padding: 20px 8px;">
            <table width="600" border="0" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; background-color: #ffffff; border: 1px solid #d5dbe5;">
              <tr>
                <td align="center" style="background-color: #3f5ed7; padding: 58px 24px 52px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                  <div style="font-size: 0; line-height: 0; margin-bottom: 16px;">
                    <span style="display: inline-block; width: 52px; height: 1px; background-color: #ffffff; vertical-align: middle;"></span>
                    <span style="display: inline-block; width: 32px; color: #ffffff; font-size: 22px; line-height: 22px; vertical-align: middle;">&#128640;</span>
                    <span style="display: inline-block; width: 52px; height: 1px; background-color: #ffffff; vertical-align: middle;"></span>
                  </div>
                  <p style="margin: 0 0 10px; font-size: 11px; line-height: 1.2; font-weight: 800; letter-spacing: 1.3px; text-transform: uppercase;">Setup Complete</p>
                  <h1 style="margin: 0; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 34px; line-height: 1.12; font-weight: 700; color: #ffffff;">Welcome to the Platform! &#127881;</h1>
                </td>
              </tr>
              <tr>
                <td style="padding: 52px 48px 48px; color: #253858; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.85; font-weight: 400;">
                  <p style="margin: 0 0 18px; font-size: 15px; font-weight: 700; color: #101828;">Hello ${safeFullName}!</p>
                  <p style="margin: 0 0 20px;">Your account setup is complete! Your company <strong>${safeCompanyName}</strong> has been successfully registered, and your <strong>${safeSubscriptionType}</strong> Plan is now active. You're all set to start managing your assets and operations efficiently.</p>

                  <p style="margin: 0 0 14px; font-size: 14px; font-weight: 800; color: #101828;">&#128188;&nbsp; Account Summary</p>
                  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border-left: 3px solid #1f5cff; border-top: 1px solid #d9dee8; border-right: 1px solid #d9dee8; border-bottom: 1px solid #d9dee8; border-radius: 4px; margin: 0 0 28px;">
                    <tr>
                      <td style="padding: 22px 24px; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 2; color: #101828;">
                        <table width="100%" border="0" cellpadding="0" cellspacing="0">
                          <tr>
                            <td width="140" style="font-weight: 700; padding: 2px 0;">Account Holder:</td>
                            <td style="padding: 2px 0;">${safeFullName}</td>
                          </tr>
                          <tr>
                            <td width="140" style="font-weight: 700; padding: 2px 0;">Company:</td>
                            <td style="padding: 2px 0;">${safeCompanyName}</td>
                          </tr>
                          <tr>
                            <td width="140" style="font-weight: 700; padding: 2px 0;">Plan:</td>
                            <td style="padding: 2px 0;"><span style="display: inline-block; background-color: #0a8f3c; color: #ffffff; border-radius: 3px; padding: 2px 7px; font-size: 10px; line-height: 1.4; font-weight: 800;">${safePlanLabel}</span></td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>

                  <p style="margin: 0 0 20px;">You can now access your dashboard and begin exploring the features available to you.</p>
                  <table border="0" cellpadding="0" cellspacing="0" style="margin: 0 0 36px;">
                    <tr>
                      <td align="center" style="background-color: #3f5ed7; border-radius: 4px;">
                        <a href="${loginUrl}" style="display: inline-block; padding: 13px 28px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; line-height: 1; font-weight: 800; text-decoration: none;">&#128073;&nbsp; Login to Your Account</a>
                      </td>
                    </tr>
                  </table>

                  <p style="margin: 0 0 44px; color: #53657d; font-size: 11px; line-height: 1.8;">If you did not create this account, please contact our support team immediately. We're excited to support your journey and help you streamline your asset management.</p>
                  <p style="margin: 0;">Regards,<br><strong>Team!</strong></p>
                </td>
              </tr>
              <tr>
                <td align="center" style="background-color: #eef1f5; padding: 34px 24px 32px; color: #53657d; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.8;">
                  <p style="margin: 0 0 8px; color: #1f5cff; font-size: 13px; font-weight: 700;">Get in touch</p>
                  <p style="margin: 0;">+91-9966416417<br>support@assetsystems.org</p>
                </td>
              </tr>
              <tr>
                <td align="center" style="background-color: #3f5ed7; padding: 18px 20px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 10px; line-height: 1.4; font-weight: 700;">
                  @2026, All Rihts reserved
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  return transporter.sendMail({
    from: emailConfig.user,
    to: user.workEmail,
    subject: 'Welcome to Asset Systems - Your Account is Ready!',
    html: htmlContent
  });
}

function cleanWhatsAppValue(value, fallback = 'N/A') {
  if (value === undefined || value === null) {
    return fallback;
  }

  const text = String(value).trim();
  return text || fallback;
}

function buildSignupWhatsAppMessage(payload) {
  return [
    '*New Signup*',
    '',
    `Name: ${cleanWhatsAppValue(payload.fullName)}`,
    `Email: ${cleanWhatsAppValue(payload.workEmail)}`,
    `Phone: ${cleanWhatsAppValue(payload.phoneNumber)}`,
    `Company: ${cleanWhatsAppValue(payload.companyName)}`,
    `Domain: ${cleanWhatsAppValue(payload.companyDomain)}`,
    `Company Size: ${cleanWhatsAppValue(payload.companySize)}`,
    `Expected Assets: ${cleanWhatsAppValue(payload.expectedAssets)}`,
    `Subscription: ${cleanWhatsAppValue(payload.subscriptionType)}`,
    `Tenant ID: ${cleanWhatsAppValue(payload.tenantId)}`,
    `User ID: ${cleanWhatsAppValue(payload.userId)}`
  ].join('\n');
}

function buildLoginWhatsAppMessage(payload) {
  return [
    '*User Login*',
    '',
    `Name: ${cleanWhatsAppValue(payload.fullName)}`,
    `Email: ${cleanWhatsAppValue(payload.workEmail)}`,
    `Company: ${cleanWhatsAppValue(payload.companyName)}`,
    `Role: ${cleanWhatsAppValue(payload.role)}`,
    `Tenant ID: ${cleanWhatsAppValue(payload.tenantId)}`,
    `User ID: ${cleanWhatsAppValue(payload.userId)}`
  ].join('\n');
}

async function sendWhatsAppSafely(message, logLabel) {
  try {
    await sendMessageToGroup(message);
  } catch (error) {
    console.error(`${logLabel}:`, error.message);
  }
}

async function sendMailSafely(mailPromise, logLabel) {
  try {
    await mailPromise;
    return { sent: true, error: null };
  } catch (error) {
    console.error(`${logLabel}:`, error.message);
    return { sent: false, error: error.message };
  }
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
      location,
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
    const subscriptionId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);
    const effectiveSubscriptionType = subscriptionType || DEFAULT_SIGNUP_SUBSCRIPTION_TYPE;
    let isAdmin = false;

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
      effectiveSubscriptionType
    ]);

    const insertUserSql = `
      INSERT INTO users (
        userId, tenantId, fullName, workEmail, phoneNumber, jobTitle, location,
        password, role, status, insertedBy, updatedBy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await connection.query(insertUserSql, [
      userId,
      tenantId,
      fullName,
      workEmail,
      phoneNumber || null,
      jobTitle || null,
      location || null,
      hashedPassword,
      'admin',
      'active',
      userId,
      userId
    ]);

    const [createdUserRows] = await connection.query(
      'SELECT isAdmin FROM users WHERE userId = ? LIMIT 1',
      [userId]
    );
    isAdmin = toBoolean(createdUserRows[0]?.isAdmin);

    const insertSubscriptionSql = `
      INSERT INTO tenantSubscriptions (
        subscriptionId,
        tenantId,
        subscriptionType,
        amount,
        currency,
        subscriptionStartDate,
        subscriptionEndDate,
        paymentDate,
        status,
        notes,
        createdBy
      ) VALUES (?, ?, ?, ?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 1 MONTH), NULL, ?, ?, ?)
    `;

    await connection.query(insertSubscriptionSql, [
      subscriptionId,
      tenantId,
      effectiveSubscriptionType,
      DEFAULT_SIGNUP_SUBSCRIPTION_AMOUNT,
      DEFAULT_SIGNUP_SUBSCRIPTION_CURRENCY,
      'active',
      'Initial subscription created during tenant signup',
      userId
    ]);

    await connection.commit();
    transactionStarted = false;

    await logAuditEvent({
      req,
      tenantId,
      actorUserId: userId,
      actorEmail: workEmail,
      action: 'user.create',
      entityType: 'user',
      entityId: userId,
      entityLabel: fullName,
      metadata: {
        source: 'signup',
        companyName,
        role: 'admin',
        subscriptionType: effectiveSubscriptionType
      }
    });

    const welcomeMail = await sendMailSafely(
      sendSignupWelcomeMail({
        fullName,
        workEmail,
        companyName,
        subscriptionType: effectiveSubscriptionType
      }),
      'Failed to send signup welcome email'
    );

    await sendWhatsAppSafely(
      buildSignupWhatsAppMessage({
        fullName,
        workEmail,
        phoneNumber,
        companyName,
        companyDomain,
        companySize,
        expectedAssets,
        subscriptionType: effectiveSubscriptionType,
        tenantId,
        userId
      }),
      'Failed to send signup WhatsApp message'
    );

    const token = jwt.sign(
      {
        userId,
        tenantId,
        workEmail,
        role: 'admin',
        isAdmin,
        companyName,
        subscriptionType: effectiveSubscriptionType
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
        isAdmin,
        subscriptionType: effectiveSubscriptionType,
        welcomeEmailSent: welcomeMail.sent,
        welcomeEmailError: welcomeMail.error,
        jobTitle,
        location: location || null
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
        u.isAdmin,
        u.status,
        u.jobTitle,
        u.location,
        t.companyName,
        t.companyDomain,
        t.companySize,
        t.expectedAssets,
        COALESCE((
          SELECT s.subscriptionType
          FROM tenantSubscriptions s
          WHERE s.tenantId = u.tenantId
          ORDER BY s.updatedAt DESC, s.id DESC
          LIMIT 1
        ), t.subscriptionType) AS subscriptionType
      FROM users u
      INNER JOIN tenants t ON t.tenantId = u.tenantId
      WHERE u.workEmail = ?
      LIMIT 1
    `;
    const [rows] = await pool.promise().query(sql, [workEmail]);

    if (!rows.length) {
      await logAuditEvent({
        req,
        actorEmail: workEmail,
        action: 'login.attempt',
        entityType: 'auth',
        status: 'failed',
        metadata: {
          reason: 'invalid_credentials'
        }
      });

      return res.status(401).json({
        success: false,
        message: 'User not found with this email'
      });
    }

    const user = rows[0];

    if (user.status && user.status !== 'active') {
      await logAuditEvent({
        req,
        tenantId: user.tenantId,
        actorUserId: user.userId,
        actorEmail: user.workEmail,
        action: 'login.attempt',
        entityType: 'auth',
        status: 'failed',
        metadata: {
          reason: 'inactive_account'
        }
      });

      return res.status(403).json({
        success: false,
        message: 'User account is not active'
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      await logAuditEvent({
        req,
        tenantId: user.tenantId,
        actorUserId: user.userId,
        actorEmail: user.workEmail,
        action: 'login.attempt',
        entityType: 'auth',
        status: 'failed',
        metadata: {
          reason: 'invalid_credentials'
        }
      });

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
        isAdmin: toBoolean(user.isAdmin),
        companyName: user.companyName || null,
        companyDomain: user.companyDomain || null,
        companySize: user.companySize || null,
        expectedAssets: user.expectedAssets || null,
        subscriptionType: user.subscriptionType || null,
        jobTitle: user.jobTitle || null,
        location: user.location || null,
        otp,
        purpose: 'login_otp'
      },
      getJwtSecret(),
      { expiresIn: '2m' }
    );

    await logAuditEvent({
      req,
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actorEmail: user.workEmail,
      action: 'login.otp_request',
      entityType: 'auth',
      metadata: {
        workEmail: user.workEmail
      }
    });

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
        isAdmin: toBoolean(user.isAdmin),
        companyName: user.companyName || null,
        companyDomain: user.companyDomain || null,
        companySize: user.companySize || null,
        expectedAssets: user.expectedAssets || null,
        subscriptionType: user.subscriptionType || null,
        jobTitle: user.jobTitle,
        location: user.location || null
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
      await logAuditEvent({
        req,
        tenantId: decoded.tenantId,
        actorUserId: decoded.userId,
        actorEmail: decoded.workEmail,
        action: 'login.verify',
        entityType: 'auth',
        status: 'failed',
        metadata: {
          reason: 'invalid_otp'
        }
      });

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
        role: decoded.role,
        isAdmin: toBoolean(decoded.isAdmin)
      },
      getJwtSecret(),
      { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
    );

    await logAuditEvent({
      req,
      tenantId: decoded.tenantId,
      actorUserId: decoded.userId,
      actorEmail: decoded.workEmail,
      action: 'login.success',
      entityType: 'auth',
      metadata: {
        role: decoded.role
      }
    });

    await sendWhatsAppSafely(
      buildLoginWhatsAppMessage({
        fullName: decoded.fullName,
        workEmail: decoded.workEmail,
        companyName: decoded.companyName,
        role: decoded.role,
        tenantId: decoded.tenantId,
        userId: decoded.userId
      }),
      'Failed to send login WhatsApp message'
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
        isAdmin: toBoolean(decoded.isAdmin),
        companyName: decoded.companyName,
        companyDomain: decoded.companyDomain,
        companySize: decoded.companySize,
        expectedAssets: decoded.expectedAssets,
        subscriptionType: decoded.subscriptionType,
        jobTitle: decoded.jobTitle,
        location: decoded.location || null
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
