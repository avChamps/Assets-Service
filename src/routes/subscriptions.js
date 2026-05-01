const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const DEFAULT_CURRENCY = 'INR';
const DEFAULT_SUBSCRIPTION_STATUS = 'active';
const ALLOWED_SUBSCRIPTION_STATUSES = new Set(['active', 'expired', 'cancelled', 'pending']);

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

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAmount(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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

function validateSubscriptionStatus(status) {
  if (!status) {
    return null;
  }

  return ALLOWED_SUBSCRIPTION_STATUSES.has(status)
    ? null
    : `status must be one of ${Array.from(ALLOWED_SUBSCRIPTION_STATUSES).join(', ')}`;
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

function buildSubscriptionRequestFilters(query, tenantId) {
  const conditions = ['c.tenantId = ?'];
  const params = [tenantId];
  const duration = cleanText(query.duration).toLowerCase();
  const subscriptionType = cleanText(query.subscriptionType);
  const search = cleanText(query.search);

  if (duration) {
    conditions.push('LOWER(c.duration) = ?');
    params.push(duration);
  }

  if (subscriptionType) {
    conditions.push(`(
      SELECT s.subscriptionType
      FROM tenantSubscriptions s
      WHERE s.tenantId = c.tenantId
      ORDER BY s.subscriptionStartDate DESC, s.id DESC
      LIMIT 1
    ) = ?`);
    params.push(subscriptionType);
  }

  if (search) {
    const searchLike = `%${search}%`;
    conditions.push(`(
      (
        SELECT s.subscriptionType
        FROM tenantSubscriptions s
        WHERE s.tenantId = c.tenantId
        ORDER BY s.subscriptionStartDate DESC, s.id DESC
        LIMIT 1
      ) LIKE ?
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
  const conditions = ['s.tenantId = ?'];
  const params = [tenantId];
  const status = cleanText(query.status).toLowerCase();
  const subscriptionType = cleanText(query.subscriptionType);
  const search = cleanText(query.search);

  if (status) {
    conditions.push('LOWER(s.status) = ?');
    params.push(status);
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

router.use(authenticateToken);

// GET /api/subscriptions/records?page=1&limit=10&status=active&subscriptionType=basic
async function getTenantSubscriptions(req, res) {
  try {
    const requestedTenantId = cleanText(req.query.tenantId);

    if (!validateTenantAccess(req, res, requestedTenantId || req.user.tenantId)) {
      return;
    }

    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const db = pool.promise();
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
        s.updatedAt
      FROM tenantSubscriptions s
      LEFT JOIN tenants t ON t.tenantId = s.tenantId
      LEFT JOIN users createdUser ON createdUser.userId = s.createdBy AND createdUser.tenantId = s.tenantId
      LEFT JOIN users updatedUser ON updatedUser.userId = s.updatedBy AND updatedUser.tenantId = s.tenantId
      ${whereSql}
      ORDER BY s.subscriptionStartDate DESC, s.id DESC
      LIMIT ? OFFSET ?
    `;

    const [[countRows], [subscriptions]] = await Promise.all([
      db.query(countSql, params),
      db.query(listSql, [...params, limit, offset])
    ]);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    return res.status(200).json({
      success: true,
      message: 'Tenant subscriptions fetched successfully',
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

// POST /api/subscriptions/records
router.post('/records', async (req, res) => {
  try {
    const tenantId = cleanText(req.body?.tenantId) || req.user.tenantId;

    if (!validateTenantAccess(req, res, tenantId)) {
      return;
    }

    const subscriptionType = cleanText(req.body?.subscriptionType);
    const amount = parseAmount(req.body?.amount);
    const currency = cleanText(req.body?.currency) || DEFAULT_CURRENCY;
    const subscriptionStartDate = normalizeDate(req.body?.subscriptionStartDate);
    const subscriptionEndDate = normalizeDate(req.body?.subscriptionEndDate);
    const paymentDate = normalizeOptionalDate(req.body?.paymentDate);
    const status = (cleanText(req.body?.status) || DEFAULT_SUBSCRIPTION_STATUS).toLowerCase();
    const notes = cleanText(req.body?.notes) || null;
    const statusValidationError = validateSubscriptionStatus(status);

    if (!subscriptionType || amount === null || !subscriptionStartDate || !subscriptionEndDate) {
      return res.status(400).json({
        success: false,
        message: 'subscriptionType, amount, subscriptionStartDate and subscriptionEndDate are required'
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
    const db = pool.promise();
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

    await db.query(sql, [
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

    return res.status(201).json({
      success: true,
      message: 'Tenant subscription created successfully',
      data: {
        subscriptionId
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while creating tenant subscription',
      error: error.message
    });
  }
});

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
        (
          SELECT s.subscriptionType
          FROM tenantSubscriptions s
          WHERE s.tenantId = c.tenantId
          ORDER BY s.subscriptionStartDate DESC, s.id DESC
          LIMIT 1
        ) AS subscriptionType,
        c.fullName,
        c.emailId,
        c.mobileNumber,
        c.companyName,
        c.message,
        (
          SELECT s.subscriptionStartDate
          FROM tenantSubscriptions s
          WHERE s.tenantId = c.tenantId
          ORDER BY s.subscriptionStartDate DESC, s.id DESC
          LIMIT 1
        ) AS subscriptionStartDate,
        (
          SELECT s.subscriptionEndDate
          FROM tenantSubscriptions s
          WHERE s.tenantId = c.tenantId
          ORDER BY s.subscriptionStartDate DESC, s.id DESC
          LIMIT 1
        ) AS subscriptionEndDate,
        (
          SELECT s.amount
          FROM tenantSubscriptions s
          WHERE s.tenantId = c.tenantId
          ORDER BY s.subscriptionStartDate DESC, s.id DESC
          LIMIT 1
        ) AS amount,
        (
          SELECT s.currency
          FROM tenantSubscriptions s
          WHERE s.tenantId = c.tenantId
          ORDER BY s.subscriptionStartDate DESC, s.id DESC
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

    const [[countRows], [requests]] = await Promise.all([
      db.query(countSql, params),
      db.query(listSql, [...params, limit, offset])
    ]);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    return res.status(200).json({
      success: true,
      message: 'Subscription requests fetched successfully',
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
