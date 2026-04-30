const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { sendMessageToGroup } = require('../config/whatsapp');

const router = express.Router();

function getJwtSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }

  return process.env.JWT_SECRET;
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
        message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    return res.status(201).json({
      success: true,
      message: 'Contact request submitted successfully',
      data: {
        id: result.insertId
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
