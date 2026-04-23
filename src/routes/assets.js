const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

const ASSET_COLUMNS = [
  'id',
  'tenantId',
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

const INSERT_COLUMNS = [
  'id',
  'tenantId',
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
  'updatedBy'
];

const UPDATE_COLUMNS = INSERT_COLUMNS.filter((column) => !['id', 'tenantId', 'createdBy'].includes(column));
const REQUIRED_CREATE_FIELDS = [
  'country',
  'location',
  'building',
  'roomName',
  'floorNumber',
  'assetType',
  'assetName',
  'createdBy'
];

const REQUIRED_UPDATE_FIELDS = new Set([
  'country',
  'location',
  'building',
  'roomName',
  'floorNumber',
  'assetType',
  'assetName',
  'quantity'
]);

const NULLABLE_FIELDS = new Set([
  'pax',
  'make',
  'model',
  'serialNo',
  'ipAddress',
  'macAddress',
  'vlan',
  'warranty',
  'poNumber',
  'vendorName',
  'invoiceNumber',
  'unitPrice',
  'updatedBy'
]);

const INTEGER_FIELDS = new Set(['floorNumber', 'pax', 'quantity']);
const DECIMAL_FIELDS = new Set(['unitPrice']);

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

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isMissing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function normalizeAssetValue(field, value) {
  if (NULLABLE_FIELDS.has(field) && value === '') {
    return null;
  }

  if (INTEGER_FIELDS.has(field) && !isMissing(value)) {
    return Number(value);
  }

  if (DECIMAL_FIELDS.has(field) && !isMissing(value)) {
    return Number(value);
  }

  return value;
}

function validateNumericFields(asset) {
  for (const field of INTEGER_FIELDS) {
    if (field in asset && !isMissing(asset[field]) && !Number.isInteger(Number(asset[field]))) {
      return `${field} must be an integer`;
    }
  }

  for (const field of DECIMAL_FIELDS) {
    if (field in asset && !isMissing(asset[field]) && Number.isNaN(Number(asset[field]))) {
      return `${field} must be a valid number`;
    }
  }

  return null;
}

function validateRequiredUpdateFields(asset) {
  for (const field of REQUIRED_UPDATE_FIELDS) {
    if (field in asset && isMissing(asset[field])) {
      return `${field} cannot be empty`;
    }
  }

  return null;
}

function buildInsertAsset(body) {
  const asset = {
    id: uuidv4(),
    quantity: 1,
    ...body
  };

  if (isMissing(asset.quantity)) {
    asset.quantity = 1;
  }

  return INSERT_COLUMNS.reduce((payload, field) => {
    payload[field] = normalizeAssetValue(field, asset[field]);
    return payload;
  }, {});
}

function buildUpdateAsset(body) {
  return UPDATE_COLUMNS.reduce((payload, field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      payload[field] = normalizeAssetValue(field, body[field]);
    }

    return payload;
  }, {});
}

function getMissingRequiredFields(asset) {
  return REQUIRED_CREATE_FIELDS.filter((field) => isMissing(asset[field]));
}

function sendDatabaseError(res, error, action) {
  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      message: 'Asset already exists with this serialNo'
    });
  }

  if (error.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(400).json({
      success: false,
      message: 'Invalid tenantId. Tenant does not exist'
    });
  }

  return res.status(500).json({
    success: false,
    message: `Server error while ${action} asset`,
    error: error.message
  });
}

router.use(authenticateToken);

// GET /api/assets/list?page=1&limit=10
router.get('/list', async (req, res) => {
  try {
    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const { tenantId } = req.user;
    const whereSql = 'WHERE tenantId = ?';
    const params = [tenantId];

    const countSql = `SELECT COUNT(*) AS total FROM assets ${whereSql}`;
    const [countRows] = await pool.promise().query(countSql, params);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    const listSql = `
      SELECT ${ASSET_COLUMNS.join(', ')}
      FROM assets
      ${whereSql}
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?
    `;

    const [assets] = await pool.promise().query(listSql, [...params, limit, offset]);

    return res.status(200).json({
      success: true,
      message: 'Assets fetched successfully',
      data: assets,
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
    return sendDatabaseError(res, error, 'fetching');
  }
});

// GET /api/assets/:id
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.promise().query(
      `SELECT ${ASSET_COLUMNS.join(', ')} FROM assets WHERE id = ? AND tenantId = ? LIMIT 1`,
      [req.params.id, req.user.tenantId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Asset not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Asset fetched successfully',
      data: rows[0]
    });
  } catch (error) {
    return sendDatabaseError(res, error, 'fetching');
  }
});

// POST /api/assets/create
router.post('/create', async (req, res) => {
  try {
    const asset = buildInsertAsset({
      ...req.body,
      tenantId: req.user.tenantId,
      createdBy: req.user.userId,
      updatedBy: req.user.userId
    });
    const missingFields = getMissingRequiredFields(asset);

    if (missingFields.length) {
      return res.status(400).json({
        success: false,
        message: `Required fields missing: ${missingFields.join(', ')}`
      });
    }

    const numericValidationError = validateNumericFields(asset);
    const requiredUpdateValidationError = validateRequiredUpdateFields(asset);

    if (requiredUpdateValidationError) {
      return res.status(400).json({
        success: false,
        message: requiredUpdateValidationError
      });
    }

    if (numericValidationError) {
      return res.status(400).json({
        success: false,
        message: numericValidationError
      });
    }

    const placeholders = INSERT_COLUMNS.map(() => '?').join(', ');
    const insertSql = `
      INSERT INTO assets (${INSERT_COLUMNS.join(', ')})
      VALUES (${placeholders})
    `;

    await pool.promise().query(
      insertSql,
      INSERT_COLUMNS.map((field) => asset[field])
    );

    const [rows] = await pool.promise().query(
      `SELECT ${ASSET_COLUMNS.join(', ')} FROM assets WHERE id = ? AND tenantId = ? LIMIT 1`,
      [asset.id, req.user.tenantId]
    );

    return res.status(201).json({
      success: true,
      message: 'Asset created successfully',
      data: rows[0]
    });
  } catch (error) {
    return sendDatabaseError(res, error, 'creating');
  }
});

// PUT /api/assets/:id
router.put('/:id', async (req, res) => {
  try {
    const asset = buildUpdateAsset({
      ...req.body,
      updatedBy: req.user.userId
    });
    const updateFields = Object.keys(asset);

    if (!updateFields.length) {
      return res.status(400).json({
        success: false,
        message: 'No valid asset fields provided for update'
      });
    }

    const numericValidationError = validateNumericFields(asset);
    const requiredUpdateValidationError = validateRequiredUpdateFields(asset);

    if (requiredUpdateValidationError) {
      return res.status(400).json({
        success: false,
        message: requiredUpdateValidationError
      });
    }

    if (numericValidationError) {
      return res.status(400).json({
        success: false,
        message: numericValidationError
      });
    }

    const setSql = updateFields.map((field) => `${field} = ?`).join(', ');
    const updateSql = `UPDATE assets SET ${setSql} WHERE id = ? AND tenantId = ?`;
    const [result] = await pool.promise().query(
      updateSql,
      [...updateFields.map((field) => asset[field]), req.params.id, req.user.tenantId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Asset not found'
      });
    }

    const [rows] = await pool.promise().query(
      `SELECT ${ASSET_COLUMNS.join(', ')} FROM assets WHERE id = ? AND tenantId = ? LIMIT 1`,
      [req.params.id, req.user.tenantId]
    );

    return res.status(200).json({
      success: true,
      message: 'Asset updated successfully',
      data: rows[0]
    });
  } catch (error) {
    return sendDatabaseError(res, error, 'updating');
  }
});

// DELETE /api/assets/:id
router.delete('/:id', async (req, res) => {
  try {
    const [result] = await pool.promise().query(
      'DELETE FROM assets WHERE id = ? AND tenantId = ?',
      [req.params.id, req.user.tenantId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Asset not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Asset deleted successfully'
    });
  } catch (error) {
    return sendDatabaseError(res, error, 'deleting');
  }
});

module.exports = router;
