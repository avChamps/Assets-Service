const express = require('express');
const jwt = require('jsonwebtoken');
const nm = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const DEFAULT_CURRENCY = 'INR';
const DEFAULT_SUBSCRIPTION_STATUS = 'active';
const DEFAULT_RENEWAL_DAYS = 7;
const ALLOWED_SUBSCRIPTION_STATUSES = new Set(['active', 'expired', 'cancelled', 'pending']);
const REQUEST_FLAGS = new Set(['pending', 'request', 'requests', 'pending-requests', 'pending_requests']);
const SUPPORT_FLAGS = new Set(['support', 'supoort']);
const SUPPORT_REQUEST_TYPES = ['support', 'supoort'];

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

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAmount(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value === 1 ? true : value === 0 ? false : null;
  }

  const text = cleanText(value).toLowerCase();

  if (['true', '1', 'yes'].includes(text)) {
    return true;
  }

  if (['false', '0', 'no'].includes(text)) {
    return false;
  }

  return null;
}

function normalizeDate(value) {
  const text = cleanText(value);

  if (!text) {
    return null;
  }

  const date = new Date(`${text.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : text.slice(0, 10);
}

function normalizeOptionalDate(value) {
  if (value === null || value === '') {
    return null;
  }

  return normalizeDate(value);
}

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function getSubscriptionFlag(query) {
  return cleanText(query.flag || query.type || query.view).toLowerCase();
}

function isRequestFlag(flag) {
  return REQUEST_FLAGS.has(flag);
}

function isSupportFlag(flag) {
  return SUPPORT_FLAGS.has(flag);
}

function validateSubscriptionStatus(status) {
  if (!status) {
    return null;
  }

  return ALLOWED_SUBSCRIPTION_STATUSES.has(status)
    ? null
    : `status must be one of ${Array.from(ALLOWED_SUBSCRIPTION_STATUSES).join(', ')}`;
}

function formatAmount(amount, currency) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    return `${currency} ${amount}`;
  }

  return `${currency} ${numericAmount.toFixed(2)}`;
}

function formatDisplayDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return cleanText(value);
  }

  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

async function getSubscriptionPlan(connection, subscriptionType) {
  const [rows] = await connection.query(
    `
      SELECT subscriptionType, maxUsers, maxAssets
      FROM subscriptionPlans
      WHERE subscriptionType = ? AND isActive = TRUE
      LIMIT 1
    `,
    [subscriptionType]
  );

  return rows[0] || null;
}

async function getSubscriptionMailRecipient(connection, tenantId, fallbackUserId) {
  const [rows] = await connection.query(
    `
      SELECT
        u.fullName,
        u.workEmail,
        t.companyName
      FROM users u
      INNER JOIN tenants t ON t.tenantId = u.tenantId
      WHERE u.tenantId = ?
        AND u.status = 'active'
        AND (u.role = 'admin' OR u.userId = ?)
      ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.fullName ASC
      LIMIT 1
    `,
    [tenantId, fallbackUserId]
  );

  return rows[0] || null;
}

async function sendSubscriptionUpdateMail(recipient, subscription) {
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

  const safeFullName = escapeHtml(recipient.fullName || 'User');
  const safeCompanyName = escapeHtml(recipient.companyName || 'your company');
  const safeSubscriptionType = escapeHtml(subscription.subscriptionType);
  const safePlanLabel = escapeHtml(`${safeSubscriptionType} (Active)`);
  const dashboardUrl = escapeHtml(process.env.APP_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://assetsystems.org/dashboard');

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Plan Upgraded Successfully</title>
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
                    <span style="display: inline-block; width: 32px; color: #ffffff; font-size: 22px; line-height: 22px; vertical-align: middle;">&#10024;</span>
                    <span style="display: inline-block; width: 52px; height: 1px; background-color: #ffffff; vertical-align: middle;"></span>
                  </div>
                  <p style="margin: 0 0 10px; font-size: 11px; line-height: 1.2; font-weight: 800; letter-spacing: 1.3px; text-transform: uppercase;">Upgrade Confirmed</p>
                  <h1 style="margin: 0 0 18px; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 34px; line-height: 1.12; font-weight: 700; color: #ffffff;">Plan Upgraded Successfully</h1>
                  <div style="font-size: 28px; line-height: 1;">&#128640;</div>
                </td>
              </tr>
              <tr>
                <td style="padding: 52px 48px 48px; color: #253858; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.85; font-weight: 400;">
                  <p style="margin: 0 0 18px; font-size: 15px; font-weight: 700; color: #101828;">Hello ${safeFullName}!</p>
                  <p style="margin: 0 0 20px;">Great news! Your plan has been successfully upgraded. Your account is now on the <strong>${safeSubscriptionType}</strong> Plan, unlocking more powerful features to help you manage and scale your operations more efficiently.</p>

                  <p style="margin: 0 0 14px; font-size: 14px; font-weight: 800; color: #101828;">&#128188;&nbsp; Updated Plan Details</p>
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
                            <td width="140" style="font-weight: 700; padding: 2px 0;">Current Plan:</td>
                            <td style="padding: 2px 0;"><span style="display: inline-block; background-color: #1f5cff; color: #ffffff; border-radius: 3px; padding: 2px 7px; font-size: 10px; line-height: 1.4; font-weight: 800;">${safePlanLabel}</span></td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>

                  <p style="margin: 0 0 20px;">You can now enjoy enhanced capabilities and improved performance across the platform.</p>
                  <table border="0" cellpadding="0" cellspacing="0" style="margin: 0 0 36px;">
                    <tr>
                      <td align="center" style="background-color: #3f5ed7; border-radius: 4px;">
                        <a href="${dashboardUrl}" style="display: inline-block; padding: 13px 28px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; line-height: 1; font-weight: 800; text-decoration: none;">&#128073;&nbsp; Access Your Dashboard</a>
                      </td>
                    </tr>
                  </table>

                  <p style="margin: 0 0 44px; color: #53657d; font-size: 11px; line-height: 1.8;">If you did not request this upgrade, please contact our support team immediately. We're excited to continue supporting your growth!</p>
                  <p style="margin: 0;">Regards,<br><strong>Team</strong></p>
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
    to: recipient.workEmail,
    subject: 'Your Asset Systems subscription plan has been updated',
    html: htmlContent
  });
}

async function sendSubscriptionInvoiceMail(recipient, subscription) {
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

  const safeCompanyName = escapeHtml(recipient.companyName || 'Client Company');
  const safeFullName = escapeHtml(recipient.fullName || 'Client');
  const safeEmail = escapeHtml(recipient.workEmail || '');
  const safeSubscriptionType = escapeHtml(subscription.subscriptionType);
  const safeInvoiceDate = escapeHtml(formatDisplayDate(subscription.invoiceDate || new Date()));
  const safeAmount = escapeHtml(formatAmount(subscription.amount, subscription.currency));
  const safeGstDetails = escapeHtml(subscription.gstDetails || 'Not provided');
  const invoiceDownloadUrl = escapeHtml(process.env.APP_INVOICE_URL || process.env.APP_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://assetsystems.org/dashboard');

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Invoice</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #eef1f5;">
      <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #eef1f5;">
        <tr>
          <td align="center" style="padding: 20px 8px;">
            <table width="700" border="0" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 700px; background-color: #ffffff; border: 1px solid #d5dbe5;">
              <tr>
                <td align="center" style="background-color: #3f5ed7; padding: 42px 24px 38px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                  <h1 style="margin: 0 0 14px; font-size: 34px; line-height: 1.1; font-weight: 800; color: #ffffff;">INVOICE</h1>
                  <p style="margin: 0; font-size: 12px; line-height: 1.4; font-weight: 700;">Invoice Date: ${safeInvoiceDate}</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 46px 48px 40px; color: #101828; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.55;">
                  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="margin: 0 0 34px;">
                    <tr>
                      <td width="48%" valign="top" style="padding-right: 24px; border-right: 1px solid #d9dee8;">
                        <p style="margin: 0 0 10px; font-size: 11px; font-weight: 800; text-transform: uppercase; color: #253858;">Billed To (Client):</p>
                        <p style="margin: 0; font-weight: 700;">${safeCompanyName}</p>
                        <p style="margin: 0;"><strong>${safeFullName}</strong></p>
                        <p style="margin: 0;"><strong>POC:</strong> ${safeEmail}</p>
                        <p style="margin: 0;"><strong>GST:</strong> ${safeGstDetails}</p>
                      </td>
                      <td width="52%" valign="top" style="padding-left: 24px;">
                        <p style="margin: 0 0 10px; font-size: 11px; font-weight: 800; text-transform: uppercase; color: #253858;">From:</p>
                        <p style="margin: 0; font-weight: 800;">Asset Systems LLP</p>
                        <p style="margin: 0;">123, Business Park Avenue,</p>
                        <p style="margin: 0;">Floor 4, Sector 18, India</p>
                        <p style="margin: 0;"><strong>GST:</strong> 24AAAAA0000A1Z5</p>
                      </td>
                    </tr>
                  </table>

                  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border: 1px solid #d9dee8; border-radius: 4px; margin: 0 0 42px;">
                    <tr>
                      <td style="padding: 14px 16px; color: #1f5cff; border-bottom: 2px solid #1f5cff; font-size: 12px;">Item Description</td>
                      <td align="right" style="padding: 14px 16px; color: #1f5cff; border-bottom: 2px solid #1f5cff; font-size: 12px;">Amount</td>
                    </tr>
                    <tr>
                      <td style="padding: 18px 16px 22px;">
                        <p style="margin: 0 0 8px; font-weight: 800;">${safeSubscriptionType}</p>
                        <p style="margin: 0; color: #53657d;">Subscription for asset management services</p>
                      </td>
                      <td align="right" style="padding: 18px 16px 22px; font-weight: 800;">${safeAmount}</td>
                    </tr>
                    <tr>
                      <td align="right" style="padding: 16px; background-color: #f4f6f9; border-top: 1px solid #d9dee8; font-weight: 800;">Total Amount:</td>
                      <td align="right" style="padding: 16px; background-color: #f4f6f9; border-top: 1px solid #d9dee8; color: #1f5cff; font-weight: 800;">${safeAmount}</td>
                    </tr>
                  </table>

                  <p style="margin: 0 0 24px; text-align: center; color: #53657d; font-size: 12px;">Click below to download a PDF copy of your invoice for your records.</p>
                  <table border="0" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto 48px;">
                    <tr>
                      <td align="center" style="background-color: #3f5ed7; border-radius: 4px;">
                        <a href="${invoiceDownloadUrl}" style="display: inline-block; padding: 13px 28px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1; font-weight: 800; text-decoration: none;">&#128196;&nbsp; Download Invoice</a>
                      </td>
                    </tr>
                  </table>

                  <p style="margin: 0; text-align: center; color: #53657d; font-size: 12px;">Thank you for choosingAsset SystemsLLP!</p>
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
    to: recipient.workEmail,
    subject: 'YourAsset Systemsinvoice',
    html: htmlContent
  });
}

function validateTenantAccess(req, res, tenantId = req.user.tenantId) {
  if (tenantId && tenantId !== req.user.tenantId) {
    res.status(403).json({
      success: false,
      message: 'You can only access subscriptions for your tenant'
    });
    return false;
  }

  return true;
}

async function closeSubscriptionRequest(connection, tenantId, closeRequest) {
  if (closeRequest === undefined || closeRequest === null || closeRequest === false || closeRequest === '') {
    return null;
  }

  const requestId = parsePositiveInteger(closeRequest, null);

  if (requestId) {
    const [result] = await connection.query(
      `
        UPDATE contactus
        SET isActive = TRUE
        WHERE id = ? AND tenantId = ? AND isActive = FALSE
      `,
      [requestId, tenantId]
    );

    if (result.affectedRows === 0) {
      const [existingRows] = await connection.query(
        `
          SELECT id, isActive
          FROM contactus
          WHERE id = ? AND tenantId = ?
          LIMIT 1
        `,
        [requestId, tenantId]
      );

      if (existingRows.length && Number(existingRows[0].isActive) === 1) {
        return {
          closeRequest: requestId,
          affectedRows: 0,
          alreadyClosed: true
        };
      }

      return {
        closeRequest: requestId,
        affectedRows: 0,
        error: 'No inactive contact request found for closeRequest'
      };
    }

    return {
      closeRequest: requestId,
      affectedRows: result.affectedRows
    };
  }

  const closeRequestFlag = parseBoolean(closeRequest);

  if (closeRequestFlag === false) {
    return null;
  }

  if (closeRequestFlag === true) {
    const [result] = await connection.query(
      `
        UPDATE contactus
        SET isActive = TRUE
        WHERE tenantId = ? AND isActive = FALSE
        ORDER BY id DESC
        LIMIT 1
      `,
      [tenantId]
    );

    return {
      closeRequest: true,
      affectedRows: result.affectedRows
    };
  }

  return {
    closeRequest,
    affectedRows: 0,
    error: 'closeRequest must be a contact request id or boolean true'
  };
}

function buildSubscriptionRequestFilters(query, tenantId) {
  const conditions = ['c.tenantId = ?'];
  const params = [tenantId];
  const flag = getSubscriptionFlag(query);
  const duration = cleanText(query.duration).toLowerCase();
  const subscriptionType = cleanText(query.subscriptionType);
  const search = cleanText(query.search);

  if (isRequestFlag(flag)) {
    conditions.push('c.isActive = FALSE');
    conditions.push(`LOWER(c.subscriptionType) NOT IN (${SUPPORT_REQUEST_TYPES.map(() => '?').join(', ')})`);
    params.push(...SUPPORT_REQUEST_TYPES);
  }

  if (isSupportFlag(flag)) {
    conditions.push(`LOWER(c.subscriptionType) IN (${SUPPORT_REQUEST_TYPES.map(() => '?').join(', ')})`);
    params.push(...SUPPORT_REQUEST_TYPES);
  }

  if (duration) {
    conditions.push('LOWER(c.duration) = ?');
    params.push(duration);
  }

  if (subscriptionType) {
    conditions.push('c.subscriptionType = ?');
    params.push(subscriptionType);
  }

  if (search) {
    const searchLike = `%${search}%`;
    conditions.push(`(
      c.subscriptionType LIKE ?
      OR c.fullName LIKE ?
      OR c.emailId LIKE ?
      OR c.mobileNumber LIKE ?
      OR c.companyName LIKE ?
      OR c.message LIKE ?
      OR u.fullName LIKE ?
      OR t.companyName LIKE ?
    )`);
    params.push(
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      searchLike
    );
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

function buildTenantSubscriptionFilters(query, tenantId) {
  const conditions = [
    's.tenantId = ?',
    `s.id = (
      SELECT latest.id
      FROM tenantSubscriptions latest
      WHERE latest.tenantId = s.tenantId
      ORDER BY latest.updatedAt DESC, latest.id DESC
      LIMIT 1
    )`
  ];
  const params = [tenantId];
  const flag = getSubscriptionFlag(query);
  const status = cleanText(query.status).toLowerCase();
  const subscriptionType = cleanText(query.subscriptionType);
  const search = cleanText(query.search);
  const renewalDays = Math.min(parsePositiveInteger(query.renewalDays, DEFAULT_RENEWAL_DAYS), 365);

  if (status) {
    conditions.push('LOWER(s.status) = ?');
    params.push(status);
  } else if (flag === 'live' || flag === 'active') {
    conditions.push('s.subscriptionEndDate >= CURDATE()');
  } else if (flag === 'paused' || flag === 'inactive') {
    conditions.push('s.subscriptionEndDate < CURDATE()');
  } else if (flag === 'renewal' || flag === 'due') {
    conditions.push('s.subscriptionEndDate BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)');
    params.push(renewalDays);
  }

  if (subscriptionType) {
    conditions.push('s.subscriptionType = ?');
    params.push(subscriptionType);
  }

  if (search) {
    const searchLike = `%${search}%`;
    conditions.push(`(
      s.subscriptionId LIKE ?
      OR s.subscriptionType LIKE ?
      OR s.currency LIKE ?
      OR s.status LIKE ?
      OR s.notes LIKE ?
      OR t.companyName LIKE ?
    )`);
    params.push(searchLike, searchLike, searchLike, searchLike, searchLike, searchLike);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

function buildSubscriptionSummary(summaryRow, planRows) {
  const activeSubscriptions = Number(summaryRow?.activeSubscriptions || 0);
  const inactiveSubscriptions = Number(summaryRow?.inactiveSubscriptions || 0);
  const dueSubscriptions = Number(summaryRow?.dueSubscriptions || 0);
  const pendingRequests = Number(summaryRow?.pendingRequests || 0);
  const supportTickets = Number(summaryRow?.supportTickets || 0);

  return {
    active: {
      label: 'Active Subscriptions',
      count: activeSubscriptions
    },
    inactive: {
      label: 'Inactive Subscriptions',
      count: inactiveSubscriptions
    },
    due: {
      label: 'Due Subscriptions',
      count: dueSubscriptions
    },
    pending: {
      label: 'Pending Requests',
      count: pendingRequests
    },
    support: {
      label: 'Support Tickets',
      count: supportTickets
    },
    byPlan: planRows.map((plan) => ({
      subscriptionType: plan.subscriptionType,
      maxUsers: Number(plan.maxUsers || 0),
      maxAssets: Number(plan.maxAssets || 0),
      count: Number(plan.activeSubscriptions || 0)
    }))
  };
}

async function getSubscriptionSummary(db, tenantId, renewalDays = DEFAULT_RENEWAL_DAYS) {
  const currentSubscriptionCondition = `
    s.id = (
      SELECT latest.id
      FROM tenantSubscriptions latest
      WHERE latest.tenantId = s.tenantId
      ORDER BY latest.updatedAt DESC, latest.id DESC
      LIMIT 1
    )
  `;
  const summarySql = `
    SELECT
      COALESCE(SUM(CASE WHEN s.subscriptionEndDate >= CURDATE() THEN 1 ELSE 0 END), 0) AS activeSubscriptions,
      COALESCE(SUM(CASE WHEN s.subscriptionEndDate < CURDATE() THEN 1 ELSE 0 END), 0) AS inactiveSubscriptions,
      COALESCE(SUM(CASE WHEN s.subscriptionEndDate BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY) THEN 1 ELSE 0 END), 0) AS dueSubscriptions,
      (
        SELECT COUNT(*)
        FROM contactus c
        WHERE c.tenantId = ?
          AND c.isActive = FALSE
      ) AS pendingRequests,
      (
        SELECT COUNT(*)
        FROM contactus c
        WHERE c.tenantId = ?
          AND LOWER(c.subscriptionType) IN (${SUPPORT_REQUEST_TYPES.map(() => '?').join(', ')})
      ) AS supportTickets
    FROM tenantSubscriptions s
    WHERE s.tenantId = ?
      AND ${currentSubscriptionCondition}
  `;
  const planCountsSql = `
    SELECT
      sp.subscriptionType,
      sp.maxUsers,
      sp.maxAssets,
      COALESCE(SUM(CASE WHEN s.subscriptionEndDate >= CURDATE() THEN 1 ELSE 0 END), 0) AS activeSubscriptions
    FROM subscriptionPlans sp
    LEFT JOIN tenantSubscriptions s
      ON s.subscriptionType = sp.subscriptionType
      AND s.tenantId = ?
      AND ${currentSubscriptionCondition}
    WHERE sp.isActive = TRUE
    GROUP BY sp.subscriptionType, sp.maxUsers, sp.maxAssets
    ORDER BY sp.id ASC
  `;

  const [[summaryRows], [planRows]] = await Promise.all([
    db.query(summarySql, [renewalDays, tenantId, tenantId, ...SUPPORT_REQUEST_TYPES, tenantId]),
    db.query(planCountsSql, [tenantId])
  ]);

  return buildSubscriptionSummary(summaryRows[0], planRows);
}

router.use(authenticateToken);

// GET /api/subscriptions/records?page=1&limit=10&flag=live&subscriptionType=basic
async function getTenantSubscriptions(req, res) {
  try {
    const flag = getSubscriptionFlag(req.query);

    if (isRequestFlag(flag) || isSupportFlag(flag)) {
      return getSubscriptionRequests(req, res);
    }

    const requestedTenantId = cleanText(req.query.tenantId);

    if (!validateTenantAccess(req, res, requestedTenantId || req.user.tenantId)) {
      return;
    }

    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const db = pool.promise();
    const renewalDays = Math.min(parsePositiveInteger(req.query.renewalDays, DEFAULT_RENEWAL_DAYS), 365);
    const { whereSql, params } = buildTenantSubscriptionFilters(req.query, req.user.tenantId);

    const countSql = `
      SELECT COUNT(*) AS total
      FROM tenantSubscriptions s
      LEFT JOIN tenants t ON t.tenantId = s.tenantId
      ${whereSql}
    `;
    const listSql = `
      SELECT
        s.id,
        s.subscriptionId,
        s.tenantId,
        t.companyName AS tenantName,
        s.subscriptionType,
        s.amount,
        s.currency,
        s.subscriptionStartDate,
        s.subscriptionEndDate,
        s.paymentDate,
        s.status,
        s.notes,
        s.createdBy,
        createdUser.fullName AS createdByName,
        s.updatedBy,
        updatedUser.fullName AS updatedByName,
        s.createdAt,
        DATE_FORMAT(s.createdAt, '%Y-%m-%d') AS createdDate,
        s.updatedAt,
        (
          SELECT COUNT(*)
          FROM users tenantUsers
          WHERE tenantUsers.tenantId = s.tenantId
        ) AS totalUsers,
        (
          SELECT COUNT(*)
          FROM assets tenantAssets
          WHERE tenantAssets.tenantId = s.tenantId
        ) AS totalAssets,
        (
          SELECT COUNT(*)
          FROM documents tenantDocuments
          WHERE tenantDocuments.tenantId = s.tenantId
        ) AS totalDocuments
      FROM tenantSubscriptions s
      LEFT JOIN tenants t ON t.tenantId = s.tenantId
      LEFT JOIN users createdUser ON createdUser.userId = s.createdBy AND createdUser.tenantId = s.tenantId
      LEFT JOIN users updatedUser ON updatedUser.userId = s.updatedBy AND updatedUser.tenantId = s.tenantId
      ${whereSql}
      ORDER BY s.updatedAt DESC, s.id DESC
      LIMIT ? OFFSET ?
    `;

    const [[countRows], [subscriptions], summary] = await Promise.all([
      db.query(countSql, params),
      db.query(listSql, [...params, limit, offset]),
      getSubscriptionSummary(db, req.user.tenantId, renewalDays)
    ]);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    return res.status(200).json({
      success: true,
      message: 'Tenant subscriptions fetched successfully',
      summary,
      data: subscriptions,
      pagination: {
        page,
        limit,
        totalRecords,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching tenant subscriptions',
      error: error.message
    });
  }
}

// POST /api/subscriptions
// POST /api/subscriptions/records
async function createTenantSubscription(req, res) {
  const db = pool.promise();
  let connection;
  let transactionStarted = false;

  try {
    const tenantId = cleanText(req.body?.tenantId) || req.user.tenantId;

    if (!validateTenantAccess(req, res, tenantId)) {
      return;
    }

    const subscriptionType = cleanText(req.body?.subscriptionType);
    const amount = parseAmount(req.body?.amount);
    const currency = cleanText(req.body?.currency) || DEFAULT_CURRENCY;
    const subscriptionStartDate = req.body?.subscriptionStartDate === undefined
      ? getTodayDateString()
      : normalizeDate(req.body.subscriptionStartDate);
    const subscriptionEndDate = normalizeDate(req.body?.subscriptionEndDate);
    const paymentDate = normalizeOptionalDate(req.body?.paymentDate);
    const status = (cleanText(req.body?.status) || DEFAULT_SUBSCRIPTION_STATUS).toLowerCase();
    const notes = cleanText(req.body?.notes) || null;
    const statusValidationError = validateSubscriptionStatus(status);

    if (!subscriptionType || amount === null || !subscriptionStartDate || !subscriptionEndDate) {
      return res.status(400).json({
        success: false,
        message: 'subscriptionType, amount and subscriptionEndDate are required'
      });
    }

    if (req.body?.subscriptionStartDate !== undefined && !subscriptionStartDate) {
      return res.status(400).json({
        success: false,
        message: 'subscriptionStartDate must be a valid date'
      });
    }

    if (req.body?.paymentDate !== undefined && req.body.paymentDate !== null && req.body.paymentDate !== '' && !paymentDate) {
      return res.status(400).json({
        success: false,
        message: 'paymentDate must be a valid date'
      });
    }

    if (subscriptionEndDate < subscriptionStartDate) {
      return res.status(400).json({
        success: false,
        message: 'subscriptionEndDate must be greater than or equal to subscriptionStartDate'
      });
    }

    if (statusValidationError) {
      return res.status(400).json({
        success: false,
        message: statusValidationError
      });
    }

    const subscriptionId = uuidv4();
    const sql = `
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const subscriptionPlan = await getSubscriptionPlan(connection, subscriptionType);

    if (!subscriptionPlan) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(400).json({
        success: false,
        message: 'Subscription plan not found or inactive'
      });
    }

    const mailRecipient = await getSubscriptionMailRecipient(connection, tenantId, req.user.userId);

    await connection.query(sql, [
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
      req.user.userId
    ]);

    const closedRequest = await closeSubscriptionRequest(connection, tenantId, req.body?.closeRequest);

    if (closedRequest?.error) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(400).json({
        success: false,
        message: closedRequest.error
      });
    }

    await connection.commit();
    transactionStarted = false;

    let emailSent = false;
    let emailError = null;
    let invoiceEmailSent = false;
    let invoiceEmailError = null;

    if (mailRecipient?.workEmail) {
      try {
        await sendSubscriptionUpdateMail(mailRecipient, {
          subscriptionType,
          amount,
          currency,
          subscriptionStartDate,
          subscriptionEndDate,
          maxUsers: subscriptionPlan.maxUsers,
          maxAssets: subscriptionPlan.maxAssets
        });
        emailSent = true;
      } catch (error) {
        emailError = error.message;
      }

      try {
        await sendSubscriptionInvoiceMail(mailRecipient, {
          subscriptionType,
          amount,
          currency,
          invoiceDate: subscriptionStartDate,
          gstDetails: req.body?.gstDetails || req.body?.gst || null
        });
        invoiceEmailSent = true;
      } catch (error) {
        invoiceEmailError = error.message;
      }
    }

    return res.status(201).json({
      success: true,
      message: emailError || invoiceEmailError
        ? 'Tenant subscription created successfully, but one or more emails failed'
        : 'Tenant subscription created successfully',
      data: {
        subscriptionId,
        subscriptionType,
        subscriptionStartDate,
        subscriptionEndDate,
        amount,
        currency,
        maxUsers: Number(subscriptionPlan.maxUsers),
        maxAssets: Number(subscriptionPlan.maxAssets),
        emailSent,
        emailTo: mailRecipient?.workEmail || null,
        emailError,
        invoiceEmailSent,
        invoiceEmailError,
        closedRequest
      }
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    return res.status(500).json({
      success: false,
      message: 'Server error while creating tenant subscription',
      error: error.message
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

router.post('/', createTenantSubscription);
router.post('/records', createTenantSubscription);

// PUT /api/subscriptions/records/:subscriptionId
router.put('/records/:subscriptionId', async (req, res) => {
  try {
    const subscriptionId = cleanText(req.params.subscriptionId);
    const db = pool.promise();
    const [existingRows] = await db.query(
      `
        SELECT tenantId, subscriptionStartDate, subscriptionEndDate
        FROM tenantSubscriptions
        WHERE subscriptionId = ?
        LIMIT 1
      `,
      [subscriptionId]
    );

    if (!existingRows.length) {
      return res.status(404).json({
        success: false,
        message: 'Tenant subscription not found'
      });
    }

    if (!validateTenantAccess(req, res, existingRows[0].tenantId)) {
      return;
    }

    const updates = [];
    const values = [];
    let nextSubscriptionStartDate = normalizeDate(existingRows[0].subscriptionStartDate);
    let nextSubscriptionEndDate = normalizeDate(existingRows[0].subscriptionEndDate);

    if (req.body?.subscriptionType !== undefined) {
      const subscriptionType = cleanText(req.body.subscriptionType);

      if (!subscriptionType) {
        return res.status(400).json({
          success: false,
          message: 'subscriptionType cannot be empty'
        });
      }

      updates.push('subscriptionType = ?');
      values.push(subscriptionType);
    }

    if (req.body?.amount !== undefined) {
      const amount = parseAmount(req.body.amount);

      if (amount === null) {
        return res.status(400).json({
          success: false,
          message: 'amount must be a valid positive number'
        });
      }

      updates.push('amount = ?');
      values.push(amount);
    }

    if (req.body?.currency !== undefined) {
      const currency = cleanText(req.body.currency);

      if (!currency) {
        return res.status(400).json({
          success: false,
          message: 'currency cannot be empty'
        });
      }

      updates.push('currency = ?');
      values.push(currency);
    }

    if (req.body?.subscriptionStartDate !== undefined) {
      const subscriptionStartDate = normalizeDate(req.body.subscriptionStartDate);

      if (!subscriptionStartDate) {
        return res.status(400).json({
          success: false,
          message: 'subscriptionStartDate must be a valid date'
        });
      }

      updates.push('subscriptionStartDate = ?');
      values.push(subscriptionStartDate);
      nextSubscriptionStartDate = subscriptionStartDate;
    }

    if (req.body?.subscriptionEndDate !== undefined) {
      const subscriptionEndDate = normalizeDate(req.body.subscriptionEndDate);

      if (!subscriptionEndDate) {
        return res.status(400).json({
          success: false,
          message: 'subscriptionEndDate must be a valid date'
        });
      }

      updates.push('subscriptionEndDate = ?');
      values.push(subscriptionEndDate);
      nextSubscriptionEndDate = subscriptionEndDate;
    }

    if (req.body?.paymentDate !== undefined) {
      const paymentDate = normalizeOptionalDate(req.body.paymentDate);

      if (req.body.paymentDate !== null && req.body.paymentDate !== '' && !paymentDate) {
        return res.status(400).json({
          success: false,
          message: 'paymentDate must be a valid date'
        });
      }

      updates.push('paymentDate = ?');
      values.push(paymentDate);
    }

    if (req.body?.status !== undefined) {
      const status = cleanText(req.body.status).toLowerCase();
      const statusValidationError = validateSubscriptionStatus(status);

      if (!status || statusValidationError) {
        return res.status(400).json({
          success: false,
          message: statusValidationError || 'status cannot be empty'
        });
      }

      updates.push('status = ?');
      values.push(status);
    }

    if (req.body?.notes !== undefined) {
      updates.push('notes = ?');
      values.push(cleanText(req.body.notes) || null);
    }

    if (!updates.length) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided to update'
      });
    }

    if (nextSubscriptionEndDate < nextSubscriptionStartDate) {
      return res.status(400).json({
        success: false,
        message: 'subscriptionEndDate must be greater than or equal to subscriptionStartDate'
      });
    }

    updates.push('updatedBy = ?');
    values.push(req.user.userId, subscriptionId, req.user.tenantId);

    const updateSql = `
      UPDATE tenantSubscriptions
      SET ${updates.join(', ')}
      WHERE subscriptionId = ? AND tenantId = ?
    `;
    await db.query(updateSql, values);

    return res.status(200).json({
      success: true,
      message: 'Tenant subscription updated successfully'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while updating tenant subscription',
      error: error.message
    });
  }
});

// GET /api/subscriptions/requests?page=1&limit=10&search=acme&duration=monthly&subscriptionType=basic
async function getSubscriptionRequests(req, res) {
  try {
    const requestedTenantId = cleanText(req.query.tenantId);

    if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
      return res.status(403).json({
        success: false,
        message: 'You can only access subscription requests for your tenant'
      });
    }

    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const db = pool.promise();
    const renewalDays = Math.min(parsePositiveInteger(req.query.renewalDays, DEFAULT_RENEWAL_DAYS), 365);
    const { whereSql, params } = buildSubscriptionRequestFilters(req.query, req.user.tenantId);

    const countSql = `
      SELECT COUNT(*) AS total
      FROM contactus c
      LEFT JOIN users u ON u.userId = c.userId AND u.tenantId = c.tenantId
      LEFT JOIN tenants t ON t.tenantId = c.tenantId
      ${whereSql}
    `;
    const listSql = `
      SELECT
        c.id,
        c.tenantId,
        c.userId,
        COALESCE(u.fullName, c.userId) AS requestedBy,
        t.companyName AS tenantName,
        c.duration,
        c.subscriptionType AS userrequestType,
        (
          SELECT s.subscriptionType
          FROM tenantSubscriptions s
          WHERE s.tenantId = c.tenantId
          ORDER BY s.updatedAt DESC, s.id DESC
          LIMIT 1
        ) AS subscriptionType,
        c.fullName,
        c.emailId,
        c.mobileNumber,
        c.companyName,
        c.message,
        c.isActive,
        CASE WHEN c.isActive = TRUE THEN 'closed' ELSE 'pending' END AS requestStatus,
        DATE_FORMAT(c.createdDate, '%Y-%m-%d') AS createdDate,
        (
          SELECT s.subscriptionStartDate
          FROM tenantSubscriptions s
          WHERE s.tenantId = c.tenantId
          ORDER BY s.updatedAt DESC, s.id DESC
          LIMIT 1
        ) AS subscriptionStartDate,
        (
          SELECT s.subscriptionEndDate
          FROM tenantSubscriptions s
          WHERE s.tenantId = c.tenantId
          ORDER BY s.updatedAt DESC, s.id DESC
          LIMIT 1
        ) AS subscriptionEndDate,
        (
          SELECT s.amount
          FROM tenantSubscriptions s
          WHERE s.tenantId = c.tenantId
          ORDER BY s.updatedAt DESC, s.id DESC
          LIMIT 1
        ) AS amount,
        (
          SELECT s.currency
          FROM tenantSubscriptions s
          WHERE s.tenantId = c.tenantId
          ORDER BY s.updatedAt DESC, s.id DESC
          LIMIT 1
        ) AS currency,
        (
          SELECT COUNT(*)
          FROM users tenantUsers
          WHERE tenantUsers.tenantId = c.tenantId
        ) AS totalUsers,
        (
          SELECT COUNT(*)
          FROM assets tenantAssets
          WHERE tenantAssets.tenantId = c.tenantId
        ) AS totalAssets,
        (
          SELECT COUNT(*)
          FROM documents tenantDocuments
          WHERE tenantDocuments.tenantId = c.tenantId
        ) AS totalDocuments
      FROM contactus c
      LEFT JOIN users u ON u.userId = c.userId AND u.tenantId = c.tenantId
      LEFT JOIN tenants t ON t.tenantId = c.tenantId
      ${whereSql}
      ORDER BY c.id DESC
      LIMIT ? OFFSET ?
    `;

    const [[countRows], [requests], summary] = await Promise.all([
      db.query(countSql, params),
      db.query(listSql, [...params, limit, offset]),
      getSubscriptionSummary(db, req.user.tenantId, renewalDays)
    ]);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    return res.status(200).json({
      success: true,
      message: 'Subscription requests fetched successfully',
      summary,
      data: requests,
      pagination: {
        page,
        limit,
        totalRecords,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching subscription requests',
      error: error.message
    });
  }
}

router.get('/', getTenantSubscriptions);
router.get('/records', getTenantSubscriptions);
router.get('/requests', getSubscriptionRequests);

module.exports = router;
