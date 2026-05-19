const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const nm = require('nodemailer');
const pool = require('../config/db');
const { logAuditEvent } = require('../utils/auditLogger');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

const USER_COLUMNS = [
  'userId',
  'tenantId',
  'fullName',
  'workEmail',
  'phoneNumber',
  'jobTitle',
  'location',
  'role',
  'status',
  'insertedBy',
  'updatedBy'
];

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

function generateTemporaryPassword() {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `Avc@${randomPart}${Math.floor(10 + Math.random() * 90)}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendTemporaryPasswordMail(email, fullName, temporaryPassword) {
  const emailConfig = getEmailConfig();
  const safeEmail = escapeHtml(email);
  const safeFullName = escapeHtml(fullName || 'User');
  const safeTemporaryPassword = escapeHtml(temporaryPassword);
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
      <title>Account Created Successfully</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #eef1f5;">
      <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #eef1f5;">
        <tr>
          <td align="center" style="padding: 12px 8px;">
            <table width="600" border="0" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; background-color: #ffffff; border: 1px solid #d5dbe5;">
              <tr>
                <td align="center" style="background-color: #3f5ed7; padding: 54px 24px 48px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                  <div style="width: 82px; height: 1px; background-color: #ffffff; opacity: 0.9; margin: 0 auto 12px;"></div>
                  <div style="font-size: 24px; line-height: 1; margin-bottom: 14px;">&#128279;</div>
                  <p style="margin: 0 0 14px; font-size: 11px; line-height: 1.2; font-weight: 800; letter-spacing: 1.4px; text-transform: uppercase;">Welcome Onboard!</p>
                  <h1 style="margin: 0; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 34px; line-height: 1.12; font-weight: 700; color: #ffffff;">Account Created Successfully</h1>
                </td>
              </tr>
              <tr>
                <td style="padding: 52px 48px 44px; color: #253858; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.85; font-weight: 400;">
                  <p style="margin: 0 0 18px;">Hello ${safeFullName},</p>
                  <p style="margin: 0 0 24px;">Your account has been successfully created. You can now log in to the platform using the credentials below:</p>

                  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border: 1px dashed #1f5cff; border-radius: 4px; margin: 0 0 26px;">
                    <tr>
                      <td style="padding: 18px 20px; color: #253858; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.75;">
                        <p style="margin: 0 0 12px;">Email ID:<br><span style="color: #1f5cff; font-weight: 700;">${safeEmail}</span></p>
                        <p style="margin: 0;">Temporary Password:<br><span style="color: #1f5cff; font-weight: 700;">${safeTemporaryPassword}</span></p>
                      </td>
                    </tr>
                  </table>

                  <p style="margin: 0 0 16px;">To access your account, please click the button below:</p>
                  <table border="0" cellpadding="0" cellspacing="0" style="margin: 0 0 28px;">
                    <tr>
                      <td align="center" style="background-color: #3f5ed7; border-radius: 3px;">
                        <a href="${loginUrl}" style="display: inline-block; padding: 12px 26px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; line-height: 1; font-weight: 800; text-decoration: none;">&#128073;&nbsp; Login to Your Account</a>
                      </td>
                    </tr>
                  </table>

                  <p style="margin: 0 0 18px; color: #ff2f2f; font-size: 11px; line-height: 1.8;"><strong>Note:</strong> For security reasons, we strongly recommend that you change your password immediately after your first login.</p>
                  <p style="margin: 0 0 34px; color: #55657a; font-size: 12px; font-style: italic;">If you did not expect this email, please contact your administrator.</p>
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
    to: email,
    subject: 'YourAsset Systemsaccount credentials',
    html: htmlContent
  });
}

async function sendUserActionMail(user, action) {
  const emailConfig = getEmailConfig();
  const safeFullName = escapeHtml(user.fullName || 'User');
  const safeEmail = escapeHtml(user.workEmail || '');
  const dashboardUrl = escapeHtml(process.env.APP_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://assetsystems.org/dashboard');
  const actionMessages = {
    enabled: {
      subject: 'YourAsset Systemsaccount has been enabled',
      eyebrow: 'Access Restored',
      title: 'Account Enabled Successfully',
      icon: '&#9989;',
      statusLabel: 'Active',
      statusColor: '#0a8f3c',
      message: 'YourAsset Systemsaccount has been enabled by your administrator. You can now access the platform and continue using your workspace.',
      note: 'If you did not expect this change, please contact your administrator immediately.',
      buttonText: '&#128073;&nbsp; Access Your Dashboard',
      buttonUrl: dashboardUrl
    },
    disabled: {
      subject: 'YourAsset Systemsaccount has been disabled',
      eyebrow: 'Access Updated',
      title: 'Account Disabled',
      icon: '&#9888;',
      statusLabel: 'Disabled',
      statusColor: '#d92d20',
      message: 'YourAsset Systemsaccount has been disabled by your administrator. You will not be able to access the platform until access is restored.',
      note: 'If you need access again or believe this was unexpected, please contact your administrator.',
      buttonText: null,
      buttonUrl: null
    },
    deleted: {
      subject: 'YourAsset Systemsaccount has been deleted',
      eyebrow: 'Account Removed',
      title: 'Account Deleted',
      icon: '&#128465;',
      statusLabel: 'Deleted',
      statusColor: '#667085',
      message: 'YourAsset Systemsaccount has been deleted by your administrator. Access to this workspace is no longer available.',
      note: 'If you did not expect this action, please contact your administrator or support team immediately.',
      buttonText: null,
      buttonUrl: null
    }
  };
  const content = actionMessages[action];

  if (!content) {
    return null;
  }

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
      <title>${content.title}</title>
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
                    <span style="display: inline-block; width: 32px; color: #ffffff; font-size: 22px; line-height: 22px; vertical-align: middle;">${content.icon}</span>
                    <span style="display: inline-block; width: 52px; height: 1px; background-color: #ffffff; vertical-align: middle;"></span>
                  </div>
                  <p style="margin: 0 0 10px; font-size: 11px; line-height: 1.2; font-weight: 800; letter-spacing: 1.3px; text-transform: uppercase;">${content.eyebrow}</p>
                  <h1 style="margin: 0; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 34px; line-height: 1.12; font-weight: 700; color: #ffffff;">${content.title}</h1>
                </td>
              </tr>
              <tr>
                <td style="padding: 52px 48px 48px; color: #253858; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.85; font-weight: 400;">
                  <p style="margin: 0 0 18px; font-size: 15px; font-weight: 700; color: #101828;">Hello ${safeFullName}!</p>
                  <p style="margin: 0 0 20px;">${content.message}</p>

                  <p style="margin: 0 0 14px; font-size: 14px; font-weight: 800; color: #101828;">&#128188;&nbsp; Account Details</p>
                  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border-left: 3px solid #1f5cff; border-top: 1px solid #d9dee8; border-right: 1px solid #d9dee8; border-bottom: 1px solid #d9dee8; border-radius: 4px; margin: 0 0 28px;">
                    <tr>
                      <td style="padding: 22px 24px; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 2; color: #101828;">
                        <table width="100%" border="0" cellpadding="0" cellspacing="0">
                          <tr>
                            <td width="140" style="font-weight: 700; padding: 2px 0;">Account Holder:</td>
                            <td style="padding: 2px 0;">${safeFullName}</td>
                          </tr>
                          <tr>
                            <td width="140" style="font-weight: 700; padding: 2px 0;">Email ID:</td>
                            <td style="padding: 2px 0;">${safeEmail}</td>
                          </tr>
                          <tr>
                            <td width="140" style="font-weight: 700; padding: 2px 0;">Status:</td>
                            <td style="padding: 2px 0;"><span style="display: inline-block; background-color: ${content.statusColor}; color: #ffffff; border-radius: 3px; padding: 2px 7px; font-size: 10px; line-height: 1.4; font-weight: 800;">${content.statusLabel}</span></td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>

                  ${content.buttonText ? `
                  <table border="0" cellpadding="0" cellspacing="0" style="margin: 0 0 36px;">
                    <tr>
                      <td align="center" style="background-color: #3f5ed7; border-radius: 4px;">
                        <a href="${content.buttonUrl}" style="display: inline-block; padding: 13px 28px; color: #ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; line-height: 1; font-weight: 800; text-decoration: none;">${content.buttonText}</a>
                      </td>
                    </tr>
                  </table>
                  ` : ''}

                  <p style="margin: 0 0 44px; color: #53657d; font-size: 11px; line-height: 1.8;">${content.note}</p>
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
    to: user.workEmail,
    subject: content.subject,
    html: htmlContent
  });
}

function getStatusAction(previousStatus, nextStatus) {
  const previous = String(previousStatus || '').toLowerCase();
  const next = String(nextStatus || '').toLowerCase();

  if (previous === next) {
    return null;
  }

  return next === 'active' ? 'enabled' : 'disabled';
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

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isMissing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function buildListFilters(query, tenantId) {
  const conditions = ['tenantId = ?'];
  const params = [tenantId];

  if (query.status) {
    conditions.push('status = ?');
    params.push(query.status);
  }

  if (query.role) {
    conditions.push('role = ?');
    params.push(query.role);
  }

  if (query.search) {
    const search = `%${String(query.search).trim()}%`;
    conditions.push('(fullName LIKE ? OR workEmail LIKE ? OR phoneNumber LIKE ? OR jobTitle LIKE ? OR location LIKE ?)');
    params.push(search, search, search, search, search);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

async function getTenantUserLimit(connection, tenantId) {
  const [rows] = await connection.query(
    `
      SELECT
        latest.subscriptionType,
        sp.maxUsers,
        (
          SELECT COUNT(*)
          FROM users tenantUsers
          WHERE tenantUsers.tenantId = ?
            AND tenantUsers.status = 'active'
        ) AS activeUsers
      FROM (
        SELECT
          COALESCE((
            SELECT s.subscriptionType
            FROM tenantSubscriptions s
            WHERE s.tenantId = t.tenantId
            ORDER BY s.updatedAt DESC, s.id DESC
            LIMIT 1
          ), t.subscriptionType) AS subscriptionType
        FROM tenants t
        WHERE t.tenantId = ?
        LIMIT 1
      ) latest
      LEFT JOIN subscriptionPlans sp
        ON sp.subscriptionType = latest.subscriptionType
        AND sp.isActive = TRUE
      LIMIT 1
    `,
    [tenantId, tenantId]
  );

  return rows[0] || null;
}

router.use(authenticateToken);

// POST /api/tenant-user-auth/users
router.post('/users', async (req, res) => {
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
      role,
      status
    } = req.body;

    if (!fullName || !workEmail) {
      return res.status(400).json({
        success: false,
        message: 'fullName and workEmail are required'
      });
    }

    const [existingUsers] = await db.query('SELECT userId FROM users WHERE workEmail = ? LIMIT 1', [workEmail]);

    if (existingUsers.length) {
      return res.status(409).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    const userId = uuidv4();
    const temporaryPassword = generateTemporaryPassword();
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
    const nextStatus = status || 'active';

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const userLimit = await getTenantUserLimit(connection, req.user.tenantId);

    if (
      String(nextStatus).toLowerCase() === 'active'
      && userLimit
      && userLimit.maxUsers !== null
      && Number(userLimit.activeUsers) >= Number(userLimit.maxUsers)
    ) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(403).json({
        success: false,
        message: 'User limit reached for current subscription plan',
        data: {
          subscriptionType: userLimit.subscriptionType,
          maxUsers: Number(userLimit.maxUsers),
          activeUsers: Number(userLimit.activeUsers)
        }
      });
    }

    const insertSql = `
      INSERT INTO users (
        userId, tenantId, fullName, workEmail, phoneNumber, jobTitle, location,
        password, role, status, insertedBy, updatedBy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await connection.query(insertSql, [
      userId,
      req.user.tenantId,
      fullName,
      workEmail,
      phoneNumber || null,
      jobTitle || null,
      location || null,
      hashedPassword,
      role || 'user',
      nextStatus,
      req.user.userId,
      req.user.userId
    ]);

    await sendTemporaryPasswordMail(workEmail, fullName, temporaryPassword);
    await connection.commit();
    transactionStarted = false;

    const [rows] = await db.query(
      `SELECT ${USER_COLUMNS.join(', ')} FROM users WHERE userId = ? AND tenantId = ? LIMIT 1`,
      [userId, req.user.tenantId]
    );

    await logAuditEvent({
      req,
      action: 'user.create',
      entityType: 'user',
      entityId: userId,
      entityLabel: fullName,
      metadata: {
        source: 'tenant_admin',
        role: role || 'user',
        status: nextStatus,
        workEmail
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Tenant user created successfully',
      data: rows[0]
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Server error while creating tenant user',
      error: error.message
    });
  } finally {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    if (connection) {
      connection.release();
    }
  }
});

// GET /api/tenant-user-auth/users?page=1&limit=10&search=john&status=active&role=admin
router.get('/users', async (req, res) => {
  try {
    const requestedTenantId = req.query.tenantId;

    if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
      return res.status(403).json({
        success: false,
        message: 'You can only access users for your tenant'
      });
    }

    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const { whereSql, params } = buildListFilters(req.query, req.user.tenantId);
    const db = pool.promise();

    const countSql = `SELECT COUNT(*) AS total FROM users ${whereSql}`;
    const [countRows] = await db.query(countSql, params);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    const usersSql = `
      SELECT ${USER_COLUMNS.join(', ')}
      FROM users
      ${whereSql}
      ORDER BY fullName ASC, workEmail ASC
      LIMIT ? OFFSET ?
    `;
    const [users] = await db.query(usersSql, [...params, limit, offset]);

    return res.status(200).json({
      success: true,
      message: 'Tenant users fetched successfully',
      data: users,
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
      message: 'Server error while fetching tenant users',
      error: error.message
    });
  }
});

// PUT /api/tenant-user-auth/users/:userId
router.put('/users/:userId', async (req, res) => {
  const db = pool.promise();
  let connection;
  let transactionStarted = false;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [existingRows] = await connection.query(
      `SELECT ${USER_COLUMNS.join(', ')} FROM users WHERE userId = ? AND tenantId = ? LIMIT 1 FOR UPDATE`,
      [req.params.userId, req.user.tenantId]
    );

    if (!existingRows.length) {
      return res.status(404).json({
        success: false,
        message: 'User not found for this tenant'
      });
    }

    const existingUser = existingRows[0];
    const allowedFields = ['fullName', 'workEmail', 'phoneNumber', 'jobTitle', 'location', 'role', 'status'];
    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (field in req.body) {
        updates.push(`${field} = ?`);
        values.push(isMissing(req.body[field]) ? null : req.body[field]);
      }
    }

    if (req.body.password || req.body.confirmPassword) {
      if (!req.body.password || !req.body.confirmPassword) {
        return res.status(400).json({
          success: false,
          message: 'password and confirmPassword are required to update password'
        });
      }

      if (req.body.password !== req.body.confirmPassword) {
        return res.status(400).json({
          success: false,
          message: 'Passwords do not match'
        });
      }

      updates.push('password = ?');
      values.push(await bcrypt.hash(req.body.password, 10));
    }

    if (!updates.length) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided for update'
      });
    }

    updates.push('updatedBy = ?');
    values.push(req.user.userId, req.params.userId, req.user.tenantId);

    const updateSql = `UPDATE users SET ${updates.join(', ')} WHERE userId = ? AND tenantId = ?`;
    await connection.query(updateSql, values);

    const [rows] = await connection.query(
      `SELECT ${USER_COLUMNS.join(', ')} FROM users WHERE userId = ? AND tenantId = ? LIMIT 1`,
      [req.params.userId, req.user.tenantId]
    );
    const updatedUser = rows[0];
    const statusAction = 'status' in req.body ? getStatusAction(existingUser.status, updatedUser.status) : null;

    if (statusAction) {
      await sendUserActionMail(updatedUser, statusAction);
    }

    await connection.commit();
    transactionStarted = false;

    await logAuditEvent({
      req,
      action: 'user.update',
      entityType: 'user',
      entityId: req.params.userId,
      entityLabel: updatedUser.fullName,
      metadata: {
        changedFields: Object.keys(req.body).filter((field) => field !== 'confirmPassword'),
        statusAction,
        workEmail: updatedUser.workEmail
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Tenant user updated successfully',
      data: rows[0]
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Server error while updating tenant user',
      error: error.message
    });
  } finally {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    if (connection) {
      connection.release();
    }
  }
});

// DELETE /api/tenant-user-auth/users/:userId
router.delete('/users/:userId', async (req, res) => {
  const db = pool.promise();
  let connection;
  let transactionStarted = false;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [rows] = await connection.query(
      `SELECT ${USER_COLUMNS.join(', ')} FROM users WHERE userId = ? AND tenantId = ? LIMIT 1 FOR UPDATE`,
      [req.params.userId, req.user.tenantId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'User not found for this tenant'
      });
    }

    const user = rows[0];
    const [result] = await connection.query(
      'DELETE FROM users WHERE userId = ? AND tenantId = ?',
      [req.params.userId, req.user.tenantId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: 'User not found for this tenant'
      });
    }

    await sendUserActionMail(user, 'deleted');
    await connection.commit();
    transactionStarted = false;

    await logAuditEvent({
      req,
      action: 'user.delete',
      entityType: 'user',
      entityId: req.params.userId,
      entityLabel: user.fullName,
      metadata: {
        workEmail: user.workEmail,
        role: user.role,
        status: user.status
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Tenant user deleted successfully'
    });
  } catch (error) {
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({
        success: false,
        message: 'User cannot be deleted because it is referenced by existing records'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Server error while deleting tenant user',
      error: error.message
    });
  } finally {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    if (connection) {
      connection.release();
    }
  }
});

// GET /api/tenant-user-auth/users/:userId
router.get('/users/:userId', async (req, res) => {
  try {
    const sql = `
      SELECT ${USER_COLUMNS.join(', ')}
      FROM users
      WHERE userId = ? AND tenantId = ?
      LIMIT 1
    `;
    const [rows] = await pool.promise().query(sql, [req.params.userId, req.user.tenantId]);

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'User not found for this tenant'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Tenant user fetched successfully',
      data: rows[0]
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching tenant user',
      error: error.message
    });
  }
});

module.exports = router;
