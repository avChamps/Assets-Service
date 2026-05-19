const express = require('express');
const jwt = require('jsonwebtoken');
const nm = require('nodemailer');
const pool = require('../config/db');
const { sendMessageToGroup } = require('../config/whatsapp');

const router = express.Router();

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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Authorization token is required'
    });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());

    if (!decoded.tenantId || !decoded.userId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token payload'
      });
    }

    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
}

router.use(authenticateToken);

async function sendContactThankYouMail(contact) {
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

  const safeFullName = escapeHtml(contact.fullName || 'there');
  const safeCompanyName = escapeHtml(contact.companyName || 'your company');
  const dashboardUrl = escapeHtml(process.env.APP_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://assetsystems.org/dashboard');

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Thank you for contacting Asset Systems</title>
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
                    <span style="display: inline-block; width: 32px; color: #ffffff; font-size: 22px; line-height: 22px; vertical-align: middle;">&#10003;</span>
                    <span style="display: inline-block; width: 52px; height: 1px; background-color: #ffffff; vertical-align: middle;"></span>
                  </div>
                  <p style="margin: 0 0 10px; font-size: 11px; line-height: 1.2; font-weight: 800; letter-spacing: 1.3px; text-transform: uppercase;">Request Received</p>
                  <h1 style="margin: 0; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 34px; line-height: 1.12; font-weight: 700; color: #ffffff;">Thank You for Contacting Us</h1>
                </td>
              </tr>
              <tr>
                <td style="padding: 52px 48px 48px; color: #253858; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.85; font-weight: 400;">
                  <p style="margin: 0 0 18px; font-size: 15px; font-weight: 700; color: #101828;">Hello ${safeFullName}!</p>
                  <p style="margin: 0 0 20px;">Thank you for reaching out to Asset Systems. We have received your contact request for <strong>${safeCompanyName}</strong>, and we truly appreciate the opportunity to connect with you.</p>
                  <p style="margin: 0 0 20px;">Our team will carefully review your message and get back to you with the right details as soon as possible. We understand that every organization has different asset management needs, so we will make sure the next response is clear, helpful, and relevant to your requirement.</p>
                  <p style="margin: 0 0 20px;">Thanks again for contacting us and showing interest in Asset Systems. We look forward to assisting you and helping your team manage assets with more confidence and ease.</p>
                  <p style="margin: 0 0 20px;">You can continue managing your account from the dashboard while our team reviews your request.</p>
                  <table border="0" cellpadding="0" cellspacing="0" style="margin: 0 0 36px;">
                    <tr>
                      <td align="center" style="background-color: #3f5ed7; border-radius: 4px;">
                        <a href="${dashboardUrl}" style="display: inline-block; padding: 13px 28px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; line-height: 1; font-weight: 800; text-decoration: none;">Open Dashboard</a>
                      </td>
                    </tr>
                  </table>

                  <p style="margin: 0;">Regards,<br><strong>Team Asset Systems</strong></p>
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
    to: contact.emailId,
    subject: 'Thank you for contacting Asset Systems',
    html: htmlContent
  });
}

function buildContactWhatsAppMessage(payload) {
  const {
    id,
    tenantName,
    userName,
    duration,
    subscriptionType,
    fullName,
    emailId,
    mobileNumber,
    companyName,
    message
  } = payload;

  return [
    '✨ *New Contact Request*',
    '',
    `🆔 *Request ID:* ${id}`,
    `🏢 *Tenant Name:* ${tenantName || 'N/A'}`,
    `👤 *User Name:* ${userName || 'N/A'}`,
    `📅 *Duration:* ${duration}`,
    `💼 *Subscription Type:* ${subscriptionType}`,
    `🙍 *Contact Person:* ${fullName}`,
    `📧 *Email:* ${emailId}`,
    `📱 *Mobile:* ${mobileNumber}`,
    `🏭 *Company:* ${companyName}`,
    `📝 *Message:* ${message || 'N/A'}`
  ].join('\n');
}

async function getTenantAndUserNames(db, tenantId, userId) {
  const sql = `
    SELECT
      u.fullName AS userName,
      t.companyName AS tenantName
    FROM users u
    LEFT JOIN tenants t ON t.tenantId = u.tenantId
    WHERE u.userId = ? AND u.tenantId = ?
    LIMIT 1
  `;

  const [rows] = await db.query(sql, [userId, tenantId]);
  const row = rows && rows.length ? rows[0] : null;

  return {
    userName: row?.userName ? String(row.userName).trim() : null,
    tenantName: row?.tenantName ? String(row.tenantName).trim() : null
  };
}

router.post('/', async (req, res) => {
  try {
    const {
      duration,
      subscriptionType,
      fullName,
      emailId,
      mobileNumber,
      companyName,
      message
    } = req.body || {};
    const tenantId = String(req.user.tenantId || '').trim();
    const userId = String(req.user.userId || '').trim();

    if (
      !duration
      || !subscriptionType
      || !fullName
      || !emailId
      || !mobileNumber
      || !companyName
    ) {
      return res.status(400).json({
        success: false,
        message: 'duration, subscriptionType, fullName, emailId, mobileNumber and companyName are required'
      });
    }

    if (!tenantId || !userId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token payload'
      });
    }

    if (!['monthly', 'yearly'].includes(String(duration).toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: "duration must be either 'monthly' or 'yearly'"
      });
    }

    const db = pool.promise();
    const sql = `
      INSERT INTO contactus (
        tenantId,
        userId,
        duration,
        subscriptionType,
        fullName,
        emailId,
        mobileNumber,
        companyName,
        message,
        isActive
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE)
    `;

    const [result] = await db.query(sql, [
      tenantId,
      userId,
      String(duration).toLowerCase().trim(),
      String(subscriptionType).trim(),
      String(fullName).trim(),
      String(emailId).trim(),
      String(mobileNumber).trim(),
      String(companyName).trim(),
      message ? String(message).trim() : null
    ]);

    const durationValue = String(duration).toLowerCase().trim();
    const subscriptionTypeValue = String(subscriptionType).trim();
    const fullNameValue = String(fullName).trim();
    const emailIdValue = String(emailId).trim();
    const mobileNumberValue = String(mobileNumber).trim();
    const companyNameValue = String(companyName).trim();
    const messageValue = message ? String(message).trim() : null;

    try {
      const { tenantName, userName } = await getTenantAndUserNames(db, tenantId, userId);
      const whatsappText = buildContactWhatsAppMessage({
        id: result.insertId,
        tenantName,
        userName,
        duration: durationValue,
        subscriptionType: subscriptionTypeValue,
        fullName: fullNameValue,
        emailId: emailIdValue,
        mobileNumber: mobileNumberValue,
        companyName: companyNameValue,
        message: messageValue
      });

      await sendMessageToGroup(whatsappText);
    } catch (waError) {
      console.error('Failed to send contact request to WhatsApp group:', waError.message);
    }

    let thankYouEmailSent = false;
    let thankYouEmailError = null;

    try {
      await sendContactThankYouMail({
        duration: durationValue,
        subscriptionType: subscriptionTypeValue,
        fullName: fullNameValue,
        emailId: emailIdValue,
        mobileNumber: mobileNumberValue,
        companyName: companyNameValue,
        message: messageValue
      });
      thankYouEmailSent = true;
    } catch (mailError) {
      thankYouEmailError = mailError.message;
      console.error('Failed to send contact thank-you email:', mailError.message);
    }

    return res.status(201).json({
      success: true,
      message: thankYouEmailError
        ? 'Contact request submitted successfully, but thank-you email failed'
        : 'Contact request submitted successfully',
      data: {
        id: result.insertId,
        thankYouEmailSent,
        thankYouEmailTo: emailIdValue,
        thankYouEmailError
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while saving contact request',
      error: error.message
    });
  }
});

module.exports = router;
