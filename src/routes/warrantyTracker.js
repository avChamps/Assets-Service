const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const DEFAULT_ALERT_WINDOW_DAYS = 30;
const MAX_ALERT_WINDOW_DAYS = 365;

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

const SEARCH_COLUMNS = [
  'assetTag',
  'assetName',
  'assetType',
  'make',
  'model',
  'serialNo',
  'country',
  'location',
  'building',
  'roomName',
  'vendorName',
  'invoiceNumber',
  'poNumber'
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

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAlertWindowDays(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_ALERT_WINDOW_DAYS;
  }

  return Math.min(parsed, MAX_ALERT_WINDOW_DAYS);
}

function numberValue(row, key) {
  return Number(row?.[key] || 0);
}

function pickAsset(row) {
  return ASSET_COLUMNS.reduce((asset, column) => {
    asset[column] = row[column];
    return asset;
  }, {});
}

function mapWarrantyRow(row) {
  return {
    ...pickAsset(row),
    daysLeft: row.daysLeft === null || row.daysLeft === undefined ? null : Number(row.daysLeft)
  };
}

function buildSttsCounts(row) {
  return [
    {
      key: 'totalAssets',
      title: 'Total Assets',
      value: numberValue(row, 'totalAssets'),
      description: 'Assets currently tracked for warranty coverage'
    },
    {
      key: 'expiringSoon',
      label: 'Attention',
      title: 'Expiring Soon',
      value: numberValue(row, 'expiringSoon'),
      description: 'Assets nearing warranty expiry'
    },
    {
      key: 'outOfWarranty',
      label: 'Risk',
      title: 'Out Of Warranty',
      value: numberValue(row, 'outOfWarranty'),
      description: 'Assets no longer covered by warranty'
    }
  ];
}

function buildWhereClause(query, tenantId) {
  const conditions = ['tenantId = ?', 'isActive = TRUE'];
  const params = [tenantId];
  const search = normalizeString(query.search);
  const status = normalizeString(query.status)?.toLowerCase();
  const warrantyStatus = normalizeString(query.warrantyStatus)?.toLowerCase();
  const warrantyDateSql = getWarrantyDateSql();
  const alertWindowDays = parseAlertWindowDays(query.alertWindowDays);

  if (!isMissing(search)) {
    conditions.push(`(${SEARCH_COLUMNS.map((column) => `${column} LIKE ?`).join(' OR ')})`);
    params.push(...SEARCH_COLUMNS.map(() => `%${search}%`));
  }

  if (!isMissing(status)) {
    if (status === 'available') {
      conditions.push('isActive = TRUE');
    } else if (status === 'retired') {
      conditions.push('isActive = FALSE');
    }
  }

  if (!isMissing(warrantyStatus)) {
    if (warrantyStatus === 'expiringsoon' || warrantyStatus === 'expiring soon') {
      conditions.push(`${warrantyDateSql} BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)`);
      params.push(alertWindowDays);
    } else if (warrantyStatus === 'outofwarranty' || warrantyStatus === 'out of warranty') {
      conditions.push(`${warrantyDateSql} < CURDATE()`);
    } else if (warrantyStatus === 'available') {
      conditions.push(`${warrantyDateSql} > DATE_ADD(CURDATE(), INTERVAL ? DAY)`);
      params.push(alertWindowDays);
    } else if (warrantyStatus === 'nottracked' || warrantyStatus === 'not tracked') {
      conditions.push(`${warrantyDateSql} IS NULL`);
    }
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

function getWarrantyDateSql() {
  const normalizedWarrantySql = 'LOWER(TRIM(warranty))';
  const parsedWarrantyDateSql = `
    COALESCE(
      STR_TO_DATE(NULLIF(warranty, ''), '%Y-%m-%d'),
      STR_TO_DATE(NULLIF(warranty, ''), '%d-%m-%Y'),
      STR_TO_DATE(NULLIF(warranty, ''), '%m/%d/%Y'),
      STR_TO_DATE(NULLIF(warranty, ''), '%d/%m/%Y'),
      STR_TO_DATE(NULLIF(warranty, ''), '%d %b %Y'),
      STR_TO_DATE(NULLIF(warranty, ''), '%d %M %Y')
    )
  `;

  return `
    COALESCE(
      ${parsedWarrantyDateSql},
      CASE
        WHEN ${normalizedWarrantySql} REGEXP '^[0-9]+[[:space:]-]*(year|years|yr|yrs)$' THEN DATE_ADD(DATE(createdAt), INTERVAL CAST(warranty AS UNSIGNED) YEAR)
        WHEN ${normalizedWarrantySql} REGEXP '^[0-9]+[[:space:]-]*(month|months|mo|mos)$' THEN DATE_ADD(DATE(createdAt), INTERVAL CAST(warranty AS UNSIGNED) MONTH)
        WHEN ${normalizedWarrantySql} REGEXP '^[0-9]+[[:space:]-]*(day|days)$' THEN DATE_ADD(DATE(createdAt), INTERVAL CAST(warranty AS UNSIGNED) DAY)
        WHEN ${normalizedWarrantySql} REGEXP '^(expired|out[[:space:]]*of[[:space:]]*warranty|outofwarranty)$' THEN DATE_SUB(CURDATE(), INTERVAL 1 DAY)
        ELSE NULL
      END
    )
  `;
}

function sendDatabaseError(res, error) {
  return res.status(500).json({
    success: false,
    message: 'Server error while fetching warranty tracker',
    error: error.message
  });
}

router.use(authenticateToken);

// GET /api/warranty-tracker?page=1&limit=10&search=macbook&status=Available&alertWindowDays=30
router.get('/', async (req, res) => {
  try {
    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const alertWindowDays = parseAlertWindowDays(req.query.alertWindowDays);
    const { tenantId } = req.user;
    const db = pool.promise();
    const warrantyDateSql = getWarrantyDateSql();
    const { whereSql, params } = buildWhereClause(req.query, tenantId);
    const countSql = `SELECT COUNT(*) AS total FROM assets ${whereSql}`;
    const totalAssetsValueSql = `
      SELECT
        COALESCE(SUM(COALESCE(quantity, 0) * COALESCE(unitPrice, 0)), 0) AS totalAssetsValue
      FROM assets
      ${whereSql}
    `;
    const sttsCountsSql = `
      SELECT
        COUNT(*) AS totalAssets,
        SUM(
          CASE
            WHEN ${warrantyDateSql} BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
            THEN 1 ELSE 0
          END
        ) AS expiringSoon,
        SUM(
          CASE
            WHEN ${warrantyDateSql} < CURDATE()
            THEN 1 ELSE 0
          END
        ) AS outOfWarranty
      FROM assets
      WHERE tenantId = ? AND isActive = TRUE
    `;
    const listSql = `
      SELECT
        ${ASSET_COLUMNS.join(', ')},
        DATE_FORMAT(${warrantyDateSql}, '%d %b %Y') AS warrantyEnd,
        DATEDIFF(${warrantyDateSql}, CURDATE()) AS daysLeft,
        CASE
          WHEN ${warrantyDateSql} IS NULL THEN 'Not Tracked'
          WHEN ${warrantyDateSql} < CURDATE() THEN 'Out Of Warranty'
          WHEN ${warrantyDateSql} BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY) THEN 'Expiring Soon'
          ELSE 'Available'
        END AS warrantyStatus
      FROM assets
      ${whereSql}
      ORDER BY
        CASE WHEN ${warrantyDateSql} IS NULL THEN 1 ELSE 0 END,
        ${warrantyDateSql} ASC,
        createdAt DESC
      LIMIT ? OFFSET ?
    `;

    const [[countRows], [totalAssetsValueRows], [sttsCountRows], [rows]] = await Promise.all([
      db.query(countSql, params),
      db.query(totalAssetsValueSql, params),
      db.query(sttsCountsSql, [alertWindowDays, tenantId]),
      db.query(listSql, [alertWindowDays, ...params, limit, offset])
    ]);

    const totalRecords = numberValue(countRows[0], 'total');
    const totalPages = Math.ceil(totalRecords / limit);
    const totalAssetsValue = numberValue(totalAssetsValueRows[0], 'totalAssetsValue');

    return res.status(200).json({
      success: true,
      message: 'Assets fetched successfully',
      sttscounts: buildSttsCounts(sttsCountRows[0]),
      data: rows.map(mapWarrantyRow),
      totalAssetsValue,
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
    return sendDatabaseError(res, error);
  }
});

module.exports = router;
