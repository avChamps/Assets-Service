const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { createNotificationsSafely, createNotificationSafely } = require('../utils/notifications');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const VALID_STATUSES = new Set(['working', 'not working']);
const VALID_ACTIONS = new Set(['verified', 'not verified']);
const ASSET_COLUMNS = [
  'id',
  'tenantId',
  'assetTag',
  'isActive',
  'country',
  'location',
  'building',
  'roomName',
  'floorNumber',
  'pax',
  'assetType',
  'assetName',
  'make',
  'model',
  'serialNo',
  'quantity',
  'ipAddress',
  'macAddress',
  'vlan',
  'warranty',
  'poNumber',
  'vendorName',
  'invoiceNumber',
  'unitPrice',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt'
];
const ASSET_SEARCH_COLUMNS = [
  'assetTag',
  'country',
  'location',
  'building',
  'roomName',
  'assetType',
  'assetName',
  'make',
  'model',
  'serialNo',
  'ipAddress',
  'macAddress',
  'vlan',
  'warranty',
  'poNumber',
  'vendorName',
  'invoiceNumber'
];

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
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
}

function normalizeValue(value) {
  return cleanText(value).toLowerCase();
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getMaintenanceItems(body) {
  if (Array.isArray(body)) {
    return body;
  }

  if (Array.isArray(body?.items)) {
    return body.items;
  }

  return body ? [body] : [];
}

function validateStatus(status) {
  const normalized = normalizeValue(status);

  if (!VALID_STATUSES.has(normalized)) {
    return null;
  }

  return normalized;
}

function validateAction(action) {
  const normalized = normalizeValue(action);

  if (!VALID_ACTIONS.has(normalized)) {
    return null;
  }

  return normalized;
}

function validateMaintenanceItem(item, index, fallbackUserId) {
  const assetId = cleanText(item?.assetId);
  const userId = cleanText(item?.userId) || fallbackUserId;
  const status = validateStatus(item?.status);
  const action = validateAction(item?.action);

  if (!assetId) {
    return { error: `items[${index}].assetId is required` };
  }

  if (!userId) {
    return { error: `items[${index}].userId is required` };
  }

  if (!status) {
    return { error: `items[${index}].status must be working or not working` };
  }

  if (!action) {
    return { error: `items[${index}].action must be verified or not verified` };
  }

  return {
    value: {
      userId,
      assetId,
      status,
      action
    }
  };
}

function buildListFilters(query, tenantId) {
  const conditions = ['m.tenantId = ?'];
  const params = [tenantId];
  const filterColumns = ['userId', 'assetId', 'status', 'action'];

  for (const column of filterColumns) {
    const value = column === 'status' || column === 'action'
      ? normalizeValue(query[column])
      : cleanText(query[column]);

    if (value) {
      conditions.push(`m.${column} = ?`);
      params.push(value);
    }
  }

  if (cleanText(query.search)) {
    const search = `%${cleanText(query.search)}%`;
    const searchConditions = [
      'm.assetId LIKE ?',
      'm.userId LIKE ?',
      'u.fullName LIKE ?',
      'u.workEmail LIKE ?',
      ...ASSET_SEARCH_COLUMNS.map((column) => `a.${column} LIKE ?`)
    ];

    conditions.push(`(${searchConditions.join(' OR ')})`);
    params.push(...searchConditions.map(() => search));
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

function buildAliasedColumns(alias, columns, prefix) {
  return columns.map((column) => `${alias}.${column} AS ${prefix}${column}`).join(', ');
}

function pickPrefixedColumns(row, columns, prefix) {
  return columns.reduce((data, column) => {
    data[column] = row[`${prefix}${column}`];
    return data;
  }, {});
}

function mapMaintenanceRow(row) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    assetId: row.assetId,
    status: row.status,
    action: row.action,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    user: row.userId
      ? {
        userId: row.userId,
        fullName: row.fullName || null,
        workEmail: row.workEmail || null
      }
      : null,
    asset: row.assetId
      ? pickPrefixedColumns(row, ASSET_COLUMNS, 'asset_')
      : null
  };
}

async function findMissingAssetIds(connection, tenantId, assetIds) {
  const uniqueAssetIds = [...new Set(assetIds)];

  if (!uniqueAssetIds.length) {
    return [];
  }

  const placeholders = uniqueAssetIds.map(() => '?').join(', ');
  const [rows] = await connection.query(
    `SELECT id FROM assets WHERE tenantId = ? AND id IN (${placeholders})`,
    [tenantId, ...uniqueAssetIds]
  );
  const foundIds = new Set(rows.map((row) => row.id));

  return uniqueAssetIds.filter((assetId) => !foundIds.has(assetId));
}

async function findMissingUserIds(connection, tenantId, userIds) {
  const uniqueUserIds = [...new Set(userIds)];

  if (!uniqueUserIds.length) {
    return [];
  }

  const placeholders = uniqueUserIds.map(() => '?').join(', ');
  const [rows] = await connection.query(
    `SELECT userId FROM users WHERE tenantId = ? AND userId IN (${placeholders})`,
    [tenantId, ...uniqueUserIds]
  );
  const foundIds = new Set(rows.map((row) => row.userId));

  return uniqueUserIds.filter((userId) => !foundIds.has(userId));
}

async function getMaintenanceById(db, id, tenantId) {
  const [rows] = await db.query(
    `
      SELECT
        m.id,
        m.tenantId,
        m.userId,
        m.assetId,
        m.status,
        m.action,
        m.createdAt,
        m.updatedAt,
        u.fullName,
        u.workEmail,
        ${buildAliasedColumns('a', ASSET_COLUMNS, 'asset_')}
      FROM maintainance m
      LEFT JOIN users u ON u.userId = m.userId
      LEFT JOIN assets a ON a.id = m.assetId
      WHERE m.id = ? AND m.tenantId = ?
      LIMIT 1
    `,
    [id, tenantId]
  );

  return rows[0] ? mapMaintenanceRow(rows[0]) : null;
}

router.use(authenticateToken);

// POST /api/maintainance
// Body can be one object, an array of objects, or { "items": [...] }.
router.post('/', async (req, res) => {
  const db = pool.promise();
  let connection;

  try {
    const items = getMaintenanceItems(req.body);

    if (!items.length) {
      return res.status(400).json({
        success: false,
        message: 'At least one maintainance item is required'
      });
    }

    const validatedItems = [];
    for (let index = 0; index < items.length; index += 1) {
      const result = validateMaintenanceItem(items[index], index, req.user.userId);

      if (result.error) {
        return res.status(400).json({
          success: false,
          message: result.error
        });
      }

      validatedItems.push(result.value);
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const missingAssetIds = await findMissingAssetIds(
      connection,
      req.user.tenantId,
      validatedItems.map((item) => item.assetId)
    );
    const missingUserIds = await findMissingUserIds(
      connection,
      req.user.tenantId,
      validatedItems.map((item) => item.userId)
    );

    if (missingAssetIds.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'One or more assets were not found for this tenant',
        missingAssetIds
      });
    }

    if (missingUserIds.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'One or more users were not found for this tenant',
        missingUserIds
      });
    }

    const values = validatedItems.map((item) => [
      req.user.tenantId,
      item.userId,
      item.assetId,
      item.status,
      item.action
    ]);
    const [result] = await connection.query(
      `
        INSERT INTO maintainance (tenantId, userId, assetId, status, action)
        VALUES ?
      `,
      [values]
    );

    await connection.commit();

    await createNotificationsSafely(
      validatedItems.map((item, index) => ({
        tenantId: req.user.tenantId,
        userId: item.userId,
        title: 'Maintenance assigned',
        message: `Maintenance was assigned for asset ${item.assetId}.`,
        type: 'maintenance',
        entityType: 'maintenance',
        entityId: String(result.insertId + index),
        createdBy: req.user.userId
      }))
    );

    return res.status(201).json({
      success: true,
      message: 'Maintainance records created successfully',
      data: {
        insertedCount: result.affectedRows,
        firstInsertId: result.insertId
      }
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    return res.status(500).json({
      success: false,
      message: 'Unable to create maintainance records',
      error: error.message
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

async function listMaintenanceRecords(req, res) {
  try {
    const requestedTenantId = cleanText(req.query.tenantId);

    if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
      return res.status(403).json({
        success: false,
        message: 'You can only access maintainance records for your tenant'
      });
    }

    if (req.query.status && !validateStatus(req.query.status)) {
      return res.status(400).json({
        success: false,
        message: 'status must be working or not working'
      });
    }

    if (req.query.action && !validateAction(req.query.action)) {
      return res.status(400).json({
        success: false,
        message: 'action must be verified or not verified'
      });
    }

    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const db = pool.promise();
    const { whereSql, params } = buildListFilters(req.query, req.user.tenantId);
    const countSql = `
      SELECT COUNT(*) AS total
      FROM maintainance m
      LEFT JOIN users u ON u.userId = m.userId
      LEFT JOIN assets a ON a.id = m.assetId
      ${whereSql}
    `;
    const listSql = `
      SELECT
        m.id,
        m.tenantId,
        m.userId,
        m.assetId,
        m.status,
        m.action,
        m.createdAt,
        m.updatedAt,
        u.fullName,
        u.workEmail,
        ${buildAliasedColumns('a', ASSET_COLUMNS, 'asset_')}
      FROM maintainance m
      LEFT JOIN users u ON u.userId = m.userId
      LEFT JOIN assets a ON a.id = m.assetId
      ${whereSql}
      ORDER BY m.createdAt DESC, m.id DESC
      LIMIT ? OFFSET ?
    `;

    const [[countRows], [rows]] = await Promise.all([
      db.query(countSql, params),
      db.query(listSql, [...params, limit, offset])
    ]);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    return res.status(200).json({
      success: true,
      message: 'Maintainance records fetched successfully',
      data: rows.map(mapMaintenanceRow),
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
      message: 'Unable to fetch maintainance records',
      error: error.message
    });
  }
}

// GET /api/maintainance?page=1&limit=20&status=working&action=verified
// GET /api/maintainance/list?page=1&limit=20&status=working&action=verified
router.get(['/', '/list'], listMaintenanceRecords);

// PUT /api/maintainance/:id
router.put('/:id', async (req, res) => {
  try {
    const id = parsePositiveInteger(req.params.id, null);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Valid maintainance id is required'
      });
    }

    const updates = [];
    const values = [];

    if (req.body.status !== undefined) {
      const status = validateStatus(req.body.status);

      if (!status) {
        return res.status(400).json({
          success: false,
          message: 'status must be working or not working'
        });
      }

      updates.push('status = ?');
      values.push(status);
    }

    if (req.body.action !== undefined) {
      const action = validateAction(req.body.action);

      if (!action) {
        return res.status(400).json({
          success: false,
          message: 'action must be verified or not verified'
        });
      }

      updates.push('action = ?');
      values.push(action);
    }

    if (!updates.length) {
      return res.status(400).json({
        success: false,
        message: 'Provide status or action to update'
      });
    }

    const db = pool.promise();
    const currentRecord = await getMaintenanceById(db, id, req.user.tenantId);

    if (!currentRecord) {
      return res.status(404).json({
        success: false,
        message: 'Maintainance record not found'
      });
    }

    const [result] = await db.query(
      `UPDATE maintainance SET ${updates.join(', ')} WHERE id = ? AND tenantId = ?`,
      [...values, id, req.user.tenantId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: 'Maintainance record not found'
      });
    }

    const record = await getMaintenanceById(db, id, req.user.tenantId);

    await createNotificationSafely({
      db,
      tenantId: req.user.tenantId,
      userId: record.userId,
      title: 'Maintenance updated',
      message: `Maintenance for asset ${record.assetId} was updated.`,
      type: 'maintenance',
      entityType: 'maintenance',
      entityId: String(record.id),
      createdBy: req.user.userId
    });

    return res.status(200).json({
      success: true,
      message: 'Maintainance record updated successfully',
      data: record
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Unable to update maintainance record',
      error: error.message
    });
  }
});

module.exports = router;
