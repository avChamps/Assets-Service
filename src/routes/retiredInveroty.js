const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { logAuditEvent } = require('../utils/auditLogger');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

const RETIRED_INVENTORY_COLUMNS = [
  'id',
  'tenantId',
  'assetId',
  'retirementStatus',
  'comments',
  'updatedBy',
  'createdAt',
  'updatedAt'
];

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

const RETIRED_INVENTORY_CSV_COLUMNS = [
  ...RETIRED_INVENTORY_COLUMNS.map((column) => ({
    header: column,
    prefix: 'retired_',
    column
  })),
  ...ASSET_COLUMNS.map((column) => ({
    header: `asset_${column}`,
    prefix: 'asset_',
    column
  }))
];

const ALLOWED_RETIREMENT_STATUSES = new Set([
  'End Of Life',
  'Ready For Disposal',
  'Obsolete'
]);

const SEARCH_COLUMNS = [
  'r.id',
  'r.assetId',
  'r.retirementStatus',
  'r.comments',
  'a.assetTag',
  'a.assetName',
  'a.assetType',
  'a.make',
  'a.model',
  'a.serialNo',
  'a.vendorName',
  'a.invoiceNumber',
  'a.poNumber',
  'a.country',
  'a.location',
  'a.building',
  'a.roomName'
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

function isMissing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function numberValue(row, key) {
  return Number(row?.[key] || 0);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function buildAliasedColumns(tableAlias, columns, prefix) {
  return columns.map((column) => `${tableAlias}.${column} AS ${prefix}${column}`).join(', ');
}

function pickPrefixedColumns(row, columns, prefix) {
  return columns.reduce((payload, column) => {
    payload[column] = row[`${prefix}${column}`];
    return payload;
  }, {});
}

function mapRetiredInventoryRow(row) {
  return {
    ...pickPrefixedColumns(row, RETIRED_INVENTORY_COLUMNS, 'retired_'),
    asset: row.asset_id ? pickPrefixedColumns(row, ASSET_COLUMNS, 'asset_') : null
  };
}

function mapOptionRows(rows) {
  return rows.map((row) => ({
    id: row.value,
    name: row.value
  }));
}

function buildListFilters(query, tenantId, options = {}) {
  const { includeAssetType = true } = options;
  const conditions = ['r.tenantId = ?'];
  const params = [tenantId];
  const search = normalizeString(query.search);
  const assetType = normalizeString(query.assetType || query.assetTypeId);

  if (!isMissing(search)) {
    conditions.push(`(${SEARCH_COLUMNS.map((column) => `${column} LIKE ?`).join(' OR ')})`);
    params.push(...SEARCH_COLUMNS.map(() => `%${search}%`));
  }

  if (includeAssetType && !isMissing(assetType)) {
    conditions.push('a.assetType = ?');
    params.push(assetType);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

function escapeCsvValue(value) {
  if (value === undefined || value === null) {
    return '';
  }

  const text = value instanceof Date ? value.toISOString() : String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function buildRetiredInventoryCsv(rows) {
  const header = RETIRED_INVENTORY_CSV_COLUMNS.map(({ header: columnHeader }) => columnHeader).join(',');
  const csvRows = rows.map((row) => (
    RETIRED_INVENTORY_CSV_COLUMNS
      .map(({ prefix, column }) => escapeCsvValue(row[`${prefix}${column}`]))
      .join(',')
  ));

  return [header, ...csvRows].join('\n');
}

function sendDatabaseError(res, error, action) {
  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      message: 'Asset already exists in retired inventory'
    });
  }

  if (error.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(400).json({
      success: false,
      message: 'Invalid tenantId, assetId, or updatedBy reference'
    });
  }

  return res.status(500).json({
    success: false,
    message: `Server error while ${action} retired inventory`,
    error: error.message
  });
}

router.use(authenticateToken);

// POST /api/retired-inventory
router.post('/', async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const assetId = normalizeString(req.body.assetId || req.body.AssetID);
    const retirementStatus = normalizeString(req.body.retirementStatus || req.body.status);
    const comments = isMissing(req.body.comments) ? null : normalizeString(req.body.comments);

    if (isMissing(assetId)) {
      return res.status(400).json({
        success: false,
        message: 'assetId is required'
      });
    }

    if (isMissing(retirementStatus)) {
      return res.status(400).json({
        success: false,
        message: 'retirementStatus is required'
      });
    }

    if (!ALLOWED_RETIREMENT_STATUSES.has(retirementStatus)) {
      return res.status(400).json({
        success: false,
        message: 'retirementStatus must be End Of Life, Ready For Disposal, or Obsolete'
      });
    }

    connection = await pool.promise().getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [assetRows] = await connection.query(
      'SELECT id, isActive FROM assets WHERE id = ? AND tenantId = ? LIMIT 1 FOR UPDATE',
      [assetId, req.user.tenantId]
    );

    if (!assetRows.length) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: 'Asset not found for this tenant'
      });
    }

    if (Number(assetRows[0].isActive) === 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: 'Asset is already inactive or retired'
      });
    }

    const id = uuidv4();
    await connection.query(
      `
        INSERT INTO retiredInvertory (
          id, tenantId, assetId, retirementStatus, comments, updatedBy
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [id, req.user.tenantId, assetId, retirementStatus, comments, req.user.userId]
    );

    await connection.query(
      'UPDATE assets SET isActive = FALSE, updatedBy = ? WHERE id = ? AND tenantId = ?',
      [req.user.userId, assetId, req.user.tenantId]
    );

    const [rows] = await connection.query(
      `SELECT ${RETIRED_INVENTORY_COLUMNS.join(', ')}
       FROM retiredInvertory
       WHERE id = ? AND tenantId = ?
       LIMIT 1`,
      [id, req.user.tenantId]
    );

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: 'Retired inventory created successfully',
      data: rows[0]
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    return sendDatabaseError(res, error, 'creating');
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// GET /api/retired-inventory
router.get('/', async (req, res) => {
  try {
    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const db = pool.promise();
    const { whereSql, params } = buildListFilters(req.query, req.user.tenantId);
    const {
      whereSql: filterOptionsWhereSql,
      params: filterOptionsParams
    } = buildListFilters(req.query, req.user.tenantId, { includeAssetType: false });

    const countSql = `
      SELECT COUNT(*) AS total
      FROM retiredInvertory r
      LEFT JOIN assets a ON a.id = r.assetId AND a.tenantId = r.tenantId
      ${whereSql}
    `;
    const totalAssetsValueSql = `
      SELECT COALESCE(SUM(COALESCE(a.quantity, 0) * COALESCE(a.unitPrice, 0)), 0) AS totalAssetsValue
      FROM retiredInvertory r
      LEFT JOIN assets a ON a.id = r.assetId AND a.tenantId = r.tenantId
      ${whereSql}
    `;
    const assetTypesSql = `
      SELECT DISTINCT TRIM(a.assetType) AS value
      FROM retiredInvertory r
      LEFT JOIN assets a ON a.id = r.assetId AND a.tenantId = r.tenantId
      ${filterOptionsWhereSql}
        AND a.assetType IS NOT NULL
        AND TRIM(a.assetType) <> ''
      ORDER BY value ASC
    `;
    const listSql = `
      SELECT
        ${buildAliasedColumns('r', RETIRED_INVENTORY_COLUMNS, 'retired_')},
        ${buildAliasedColumns('a', ASSET_COLUMNS, 'asset_')}
      FROM retiredInvertory r
      LEFT JOIN assets a ON a.id = r.assetId AND a.tenantId = r.tenantId
      ${whereSql}
      ORDER BY r.createdAt DESC
      LIMIT ? OFFSET ?
    `;

    const [[countRows], [totalAssetsValueRows], [assetTypeRows], [rows]] = await Promise.all([
      db.query(countSql, params),
      db.query(totalAssetsValueSql, params),
      db.query(assetTypesSql, filterOptionsParams),
      db.query(listSql, [...params, limit, offset])
    ]);
    const totalRecords = numberValue(countRows[0], 'total');
    const totalAssetsValue = numberValue(totalAssetsValueRows[0], 'totalAssetsValue');
    const totalPages = Math.ceil(totalRecords / limit);

    return res.status(200).json({
      success: true,
      message: 'Retired inventory fetched successfully',
      data: rows.map(mapRetiredInventoryRow),
      totalAssetsValue,
      filterOptions: {
        assetTypes: mapOptionRows(assetTypeRows)
      },
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

// GET /api/retired-inventory/export/csv
router.get('/export/csv', async (req, res) => {
  try {
    const db = pool.promise();
    const { whereSql, params } = buildListFilters(req.query, req.user.tenantId);
    const exportSql = `
      SELECT
        ${buildAliasedColumns('r', RETIRED_INVENTORY_COLUMNS, 'retired_')},
        ${buildAliasedColumns('a', ASSET_COLUMNS, 'asset_')}
      FROM retiredInvertory r
      LEFT JOIN assets a ON a.id = r.assetId AND a.tenantId = r.tenantId
      ${whereSql}
      ORDER BY r.createdAt DESC
    `;

    const [rows] = await db.query(exportSql, params);
    const csv = buildRetiredInventoryCsv(rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="retired-inventory.csv"');

    await logAuditEvent({
      req,
      action: 'retired_inventory.download',
      entityType: 'retired_inventory',
      entityLabel: 'retired-inventory.csv',
      metadata: {
        rowCount: rows.length,
        filters: req.query
      }
    });

    return res.status(200).send(csv);
  } catch (error) {
    return sendDatabaseError(res, error, 'exporting');
  }
});

// GET /api/retired-inventory/:id
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.promise().query(
      `
        SELECT
          ${buildAliasedColumns('r', RETIRED_INVENTORY_COLUMNS, 'retired_')},
          ${buildAliasedColumns('a', ASSET_COLUMNS, 'asset_')}
        FROM retiredInvertory r
        LEFT JOIN assets a ON a.id = r.assetId AND a.tenantId = r.tenantId
        WHERE r.id = ? AND r.tenantId = ?
        LIMIT 1
      `,
      [req.params.id, req.user.tenantId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Retired inventory record not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Retired inventory fetched successfully',
      data: mapRetiredInventoryRow(rows[0])
    });
  } catch (error) {
    return sendDatabaseError(res, error, 'fetching');
  }
});

module.exports = router;
