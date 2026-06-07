const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { logAuditEvent } = require('../utils/auditLogger');

const router = express.Router();

const DEFAULT_ALERT_WINDOW_DAYS = 30;
const MAX_ALERT_WINDOW_DAYS = 365;
const DEFAULT_TOP_LIMIT = 10;
const MAX_TOP_LIMIT = 25;
const REPORT_EXPORT_FLAGS = new Set([
  'summary',
  'roomCapacity',
  'deviceType',
  'investmentAndAmc',
  'tickets',
  'outOfWarranty',
  'hardwareRecycle',
  'topRoomsWithIssues',
  'topRoomsHighValue'
]);
const REPORT_EXPORT_FLAG_ALIASES = new Map([
  ['summary', 'summary'],
  ['roomcapacity', 'roomCapacity'],
  ['devicetype', 'deviceType'],
  ['investmentandamc', 'investmentAndAmc'],
  ['investmentamc', 'investmentAndAmc'],
  ['tickets', 'tickets'],
  ['outofwarranty', 'outOfWarranty'],
  ['hardwarerecycle', 'hardwareRecycle'],
  ['toproomswithissues', 'topRoomsWithIssues'],
  ['roomswithissues', 'topRoomsWithIssues'],
  ['toproomshighvalue', 'topRoomsHighValue'],
  ['roomshighvalue', 'topRoomsHighValue']
]);
const BASIC_ASSET_EXPORT_COLUMNS = [
  { header: 'Asset ID', key: 'id' },
  { header: 'Asset Tag', key: 'assetTag' },
  { header: 'Asset Name', key: 'assetName' },
  { header: 'Asset Type', key: 'assetType' },
  { header: 'Country', key: 'country' },
  { header: 'Location', key: 'location' },
  { header: 'Building', key: 'building' },
  { header: 'Room', key: 'roomName' },
  { header: 'Floor', key: 'floorNumber' },
  { header: 'Make', key: 'make' },
  { header: 'Model', key: 'model' },
  { header: 'Serial No', key: 'serialNo' },
  { header: 'Quantity', key: 'quantity' },
  { header: 'Unit Price', key: 'unitPrice' },
  { header: 'Warranty', key: 'warranty' },
  { header: 'Created At', key: 'createdAt' }
];

function getPaxNameSql(column = 'pax') {
  return `
    CASE
      WHEN COALESCE(${column}, 0) > 0 THEN CONCAT(COALESCE(${column}, 0), ' Pax')
      ELSE 'Not Specified'
    END
  `;
}

function getRoomScopeSql(alias = 'a') {
  const prefix = alias ? `${alias}.` : '';

  return `
    CONCAT_WS('|',
      COALESCE(NULLIF(TRIM(${prefix}country), ''), 'Not Specified'),
      COALESCE(NULLIF(TRIM(${prefix}location), ''), 'Not Specified'),
      COALESCE(NULLIF(TRIM(${prefix}building), ''), 'Not Specified'),
      COALESCE(NULLIF(TRIM(${prefix}roomName), ''), 'Not Specified')
    )
  `;
}

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

function parseBoundedInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function numberValue(row, key) {
  return Number(row?.[key] || 0);
}

async function getTenantAmcValue(db, tenantId) {
  const [columns] = await db.query('SHOW COLUMNS FROM tenants LIKE ?', ['amcValue']);

  if (!columns.length) {
    return 0;
  }

  const [rows] = await db.query(
    'SELECT COALESCE(amcValue, 0) AS amcValue FROM tenants WHERE tenantId = ? LIMIT 1',
    [tenantId]
  );

  return numberValue(rows[0], 'amcValue');
}

function calculateAmcValue(totalAssetValue, amcValue) {
  const total = Number(totalAssetValue || 0);
  const percentage = Number(amcValue || 0);

  if (!Number.isFinite(total) || !Number.isFinite(percentage)) {
    return 0;
  }

  return Number(((total * percentage) / 100).toFixed(2));
}

function percentageValue(value, total) {
  const numericValue = Number(value || 0);
  const numericTotal = Number(total || 0);

  if (!numericTotal) {
    return 0;
  }

  return Number(((numericValue / numericTotal) * 100).toFixed(2));
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function isMissing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function normalizeDate(value) {
  const normalized = normalizeString(value);

  if (isMissing(normalized)) {
    return null;
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function getWarrantyDateSql(alias = 'a') {
  const prefix = alias ? `${alias}.` : '';
  const warranty = `${prefix}warranty`;
  const createdAt = `${prefix}createdAt`;
  const parsedWarrantyDateSql = `
    COALESCE(
      STR_TO_DATE(NULLIF(${warranty}, ''), '%Y-%m-%d'),
      STR_TO_DATE(NULLIF(${warranty}, ''), '%d-%m-%Y'),
      STR_TO_DATE(NULLIF(${warranty}, ''), '%m/%d/%Y'),
      STR_TO_DATE(NULLIF(${warranty}, ''), '%d/%m/%Y'),
      STR_TO_DATE(NULLIF(${warranty}, ''), '%d %b %Y'),
      STR_TO_DATE(NULLIF(${warranty}, ''), '%d %M %Y')
    )
  `;

  return `
    COALESCE(
      ${parsedWarrantyDateSql},
      CASE
        WHEN ${warranty} REGEXP '^[0-9]+[[:space:]]*Year' THEN DATE_ADD(DATE(${createdAt}), INTERVAL CAST(${warranty} AS UNSIGNED) YEAR)
        WHEN ${warranty} REGEXP '^[0-9]+[[:space:]]*Month' THEN DATE_ADD(DATE(${createdAt}), INTERVAL CAST(${warranty} AS UNSIGNED) MONTH)
        WHEN ${warranty} REGEXP '^[0-9]+[[:space:]]*Day' THEN DATE_ADD(DATE(${createdAt}), INTERVAL CAST(${warranty} AS UNSIGNED) DAY)
        ELSE NULL
      END
    )
  `;
}

function mapNamedValueRows(rows, nameKey, valueKey, total = null) {
  const effectiveTotal = total === null
    ? rows.reduce((sum, row) => sum + numberValue(row, valueKey), 0)
    : Number(total || 0);

  return rows.map((row) => ({
    name: row[nameKey] || 'Not Specified',
    value: numberValue(row, valueKey),
    percentage: percentageValue(numberValue(row, valueKey), effectiveTotal)
  }));
}

function buildCards(totals) {
  return [
    {
      key: 'inventory',
      title: 'Inventory',
      description: 'Total Assets',
      value: totals.totalAssets
    },
    {
      key: 'budget',
      title: 'Budget',
      description: 'Investment',
      value: totals.investment
    },
    {
      key: 'coverage',
      title: 'Coverage',
      description: 'Under Warranty',
      value: totals.underWarranty
    },
    {
      key: 'risk',
      title: 'Risk',
      description: 'Out of Warranty',
      value: totals.outOfWarranty
    },
    {
      key: 'service',
      title: 'Service',
      description: 'AMC Value',
      value: totals.amcValue
    },
    {
      key: 'lifecycle',
      title: 'Lifecycle',
      description: 'Hardware Recycle',
      value: totals.hardwareRecycle
    }
  ];
}

function sendDatabaseError(res, error) {
  return res.status(500).json({
    success: false,
    message: 'Server error while fetching reports',
    error: error.message
  });
}

function buildAssetFilters(query, tenantId, alias = 'a', options = {}) {
  const { includeActive = true } = options;
  const prefix = alias ? `${alias}.` : '';
  const conditions = [`${prefix}tenantId = ?`];
  const params = [tenantId];
  const startDate = normalizeDate(query.startDate);
  const endDate = normalizeDate(query.endDate);
  const filters = [
    { column: 'country', value: query.country },
    { column: 'location', value: query.locationId || query.location },
    { column: 'building', value: query.buildingId || query.building },
    { column: 'roomName', value: query.roomId || query.roomName }
  ];

  if (includeActive) {
    conditions.push(`${prefix}isActive = TRUE`);
  }

  if (startDate) {
    conditions.push(`DATE(${prefix}createdAt) >= ?`);
    params.push(startDate);
  }

  if (endDate) {
    conditions.push(`DATE(${prefix}createdAt) <= ?`);
    params.push(endDate);
  }

  for (const filter of filters) {
    const value = normalizeString(filter.value);

    if (!isMissing(value)) {
      conditions.push(`${prefix}${filter.column} = ?`);
      params.push(value);
    }
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params,
    appliedFilters: {
      startDate,
      endDate,
      country: normalizeString(query.country) || null,
      locationId: normalizeString(query.locationId || query.location) || null,
      buildingId: normalizeString(query.buildingId || query.building) || null,
      roomId: normalizeString(query.roomId || query.roomName) || null
    }
  };
}

function buildTicketFilters(query, tenantId, alias = 't') {
  const prefix = alias ? `${alias}.` : '';
  const conditions = [`${prefix}tenantId = ?`];
  const params = [tenantId];
  const startDate = normalizeDate(query.startDate);
  const endDate = normalizeDate(query.endDate);

  if (startDate) {
    conditions.push(`DATE(${prefix}createdAt) >= ?`);
    params.push(startDate);
  }

  if (endDate) {
    conditions.push(`DATE(${prefix}createdAt) <= ?`);
    params.push(endDate);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

function buildRetiredFilters(query, tenantId, alias = 'r') {
  const prefix = alias ? `${alias}.` : '';
  const conditions = [`${prefix}tenantId = ?`];
  const params = [tenantId];
  const startDate = normalizeDate(query.startDate);
  const endDate = normalizeDate(query.endDate);

  if (startDate) {
    conditions.push(`DATE(${prefix}createdAt) >= ?`);
    params.push(startDate);
  }

  if (endDate) {
    conditions.push(`DATE(${prefix}createdAt) <= ?`);
    params.push(endDate);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

function buildDateJoinFilters(query, alias) {
  const prefix = alias ? `${alias}.` : '';
  const conditions = [];
  const params = [];
  const startDate = normalizeDate(query.startDate);
  const endDate = normalizeDate(query.endDate);

  if (startDate) {
    conditions.push(`DATE(${prefix}createdAt) >= ?`);
    params.push(startDate);
  }

  if (endDate) {
    conditions.push(`DATE(${prefix}createdAt) <= ?`);
    params.push(endDate);
  }

  return {
    joinSql: conditions.length ? ` AND ${conditions.join(' AND ')}` : '',
    params
  };
}

function buildFilterOptionWhere(query, tenantId, alias = '', columns = []) {
  const prefix = alias ? `${alias}.` : '';
  const conditions = [`${prefix}tenantId = ?`, `${prefix}isActive = TRUE`];
  const params = [tenantId];
  const startDate = normalizeDate(query.startDate);
  const endDate = normalizeDate(query.endDate);
  const filterValues = {
    country: query.country,
    location: query.locationId || query.location,
    building: query.buildingId || query.building,
    roomName: query.roomId || query.roomName
  };

  if (startDate) {
    conditions.push(`DATE(${prefix}createdAt) >= ?`);
    params.push(startDate);
  }

  if (endDate) {
    conditions.push(`DATE(${prefix}createdAt) <= ?`);
    params.push(endDate);
  }

  for (const column of columns) {
    const value = normalizeString(filterValues[column]);

    if (!isMissing(value)) {
      conditions.push(`${prefix}${column} = ?`);
      params.push(value);
    }
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

function mapOptionRows(rows, valueKey = 'value') {
  return rows.map((row) => ({
    id: row[valueKey],
    name: row[valueKey]
  }));
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);

  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function buildCsv(columns, rows) {
  const header = columns.map(({ header }) => escapeCsvValue(header)).join(',');
  const csvRows = rows.map((row) => (
    columns.map(({ key }) => escapeCsvValue(row[key])).join(',')
  ));

  return [header, ...csvRows].join('\n');
}

function getBasicAssetSelect(alias = 'a') {
  const prefix = alias ? `${alias}.` : '';

  return `
    ${prefix}id,
    ${prefix}assetTag,
    ${prefix}assetName,
    ${prefix}assetType,
    ${prefix}country,
    ${prefix}location,
    ${prefix}building,
    ${prefix}roomName,
    ${prefix}floorNumber,
    ${prefix}make,
    ${prefix}model,
    ${prefix}serialNo,
    ${prefix}quantity,
    ${prefix}unitPrice,
    ${prefix}warranty,
    DATE_FORMAT(${prefix}createdAt, '%Y-%m-%d') AS createdAt
  `;
}

function appendAssetExportIdFilter(flag, id, whereSql, params, alias = 'a') {
  const normalizedId = normalizeString(id);

  if (isMissing(normalizedId)) {
    return { whereSql, params };
  }

  const prefix = alias ? `${alias}.` : '';

  if (flag === 'roomCapacity') {
    const paxValue = Number.parseInt(String(normalizedId).replace(/[^0-9-]/g, ''), 10);

    if (!Number.isInteger(paxValue)) {
      return {
        whereSql: `${whereSql} AND COALESCE(${prefix}pax, 0) = 0`,
        params
      };
    }

    return {
      whereSql: `${whereSql} AND COALESCE(${prefix}pax, 0) = ?`,
      params: [...params, paxValue]
    };
  }

  if (flag === 'topRoomsWithIssues' || flag === 'topRoomsHighValue') {
    return {
      whereSql: `${whereSql} AND COALESCE(NULLIF(TRIM(${prefix}roomName), ''), 'Not Specified') = ?`,
      params: [...params, normalizedId]
    };
  }

  if (flag === 'deviceType') {
    return {
      whereSql: `${whereSql} AND COALESCE(NULLIF(TRIM(${prefix}assetType), ''), 'Not Specified') = ?`,
      params: [...params, normalizedId]
    };
  }

  return { whereSql, params };
}

function normalizeExportFlag(value) {
  const normalized = normalizeString(value);

  if (REPORT_EXPORT_FLAGS.has(normalized)) {
    return normalized;
  }

  const aliasKey = normalized?.toLowerCase().replace(/[^a-z0-9]/g, '');

  return REPORT_EXPORT_FLAG_ALIASES.get(aliasKey) || null;
}

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
}

function mergeWhereClauses(...clauses) {
  const conditions = [];
  const params = [];

  for (const clause of clauses) {
    if (!clause?.whereSql) {
      continue;
    }

    conditions.push(clause.whereSql.replace(/^WHERE\s+/i, ''));
    params.push(...clause.params);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

router.use(authenticateToken);

// GET /api/reports/export/csv?flag=roomCapacity&startDate=2026-01-01&endDate=2026-04-30&country=India&locationId=HQ&buildingId=Tower&roomId=Room%20101
router.get('/export/csv', async (req, res) => {
  try {
    const flag = normalizeExportFlag(req.query.flag || req.query.section);

    if (!flag) {
      return res.status(400).json({
        success: false,
        message: `flag is required. Allowed values: ${Array.from(REPORT_EXPORT_FLAGS).join(', ')}`
      });
    }

    const { tenantId } = req.user;
    const alertWindowDays = parseBoundedInteger(
      req.query.alertWindowDays,
      DEFAULT_ALERT_WINDOW_DAYS,
      MAX_ALERT_WINDOW_DAYS
    );
    const topLimit = parseBoundedInteger(req.query.topLimit, DEFAULT_TOP_LIMIT, MAX_TOP_LIMIT);
    const db = pool.promise();
    const warrantyDateSql = getWarrantyDateSql('a');
    const assetFilters = buildAssetFilters(req.query, tenantId, 'a');
    const unaliasedAssetFilters = buildAssetFilters(req.query, tenantId, '');
    const ticketFilters = buildTicketFilters(req.query, tenantId, 't');
    const ticketAssetFilters = buildAssetFilters(req.query, tenantId, 'a');
    const ticketScopedFilters = mergeWhereClauses(ticketFilters, ticketAssetFilters);
    const retiredFilters = buildRetiredFilters(req.query, tenantId, 'r');
    const retiredAssetFilters = buildAssetFilters(req.query, tenantId, 'a', { includeActive: false });
    const retiredScopedFilters = mergeWhereClauses(retiredFilters, retiredAssetFilters);
    const ticketJoinDateFilters = buildDateJoinFilters(req.query, 't');
    const roomScopeSql = getRoomScopeSql('a');
    const exportId = req.query.id || req.query.value || req.query.sectionId;
    let columns = [];
    let rows = [];

    if (flag === 'summary') {
      const [[assetRows], [ticketRows], [retiredRows], amcValue] = await Promise.all([
        db.query(
          `
            SELECT
              COUNT(*) AS totalAssets,
              COUNT(DISTINCT ${roomScopeSql}) AS totalRooms,
              COALESCE(SUM(COALESCE(a.quantity, 0) * COALESCE(a.unitPrice, 0)), 0) AS investment,
              SUM(CASE WHEN ${warrantyDateSql} >= CURDATE() THEN 1 ELSE 0 END) AS underWarranty,
              SUM(CASE WHEN ${warrantyDateSql} < CURDATE() THEN 1 ELSE 0 END) AS outOfWarranty,
              SUM(
                CASE
                  WHEN ${warrantyDateSql} BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
                  THEN 1 ELSE 0
                END
              ) AS expiringWarranties
            FROM assets a
            ${assetFilters.whereSql}
          `,
          [alertWindowDays, ...assetFilters.params]
        ),
        db.query(
          `
            SELECT COUNT(*) AS totalTickets
            FROM tickts t
            LEFT JOIN assets a ON a.id = t.assetId AND a.tenantId = t.tenantId
            ${ticketScopedFilters.whereSql}
          `,
          ticketScopedFilters.params
        ),
        db.query(
          `
            SELECT COUNT(*) AS hardwareRecycle
            FROM retiredInvertory r
            LEFT JOIN assets a ON a.id = r.assetId AND a.tenantId = r.tenantId
            ${retiredScopedFilters.whereSql}
          `,
          retiredScopedFilters.params
        ),
        getTenantAmcValue(db, tenantId)
      ]);
      columns = [
        { header: 'Metric', key: 'metric' },
        { header: 'Value', key: 'value' }
      ];
      rows = [
        { metric: 'Total Assets', value: numberValue(assetRows[0], 'totalAssets') },
        { metric: 'Total Rooms', value: numberValue(assetRows[0], 'totalRooms') },
        { metric: 'Investment', value: numberValue(assetRows[0], 'investment') },
        { metric: 'Under Warranty', value: numberValue(assetRows[0], 'underWarranty') },
        { metric: 'Out Of Warranty', value: numberValue(assetRows[0], 'outOfWarranty') },
        { metric: 'Expiring Warranties', value: numberValue(assetRows[0], 'expiringWarranties') },
        { metric: 'AMC Value', value: calculateAmcValue(numberValue(assetRows[0], 'investment'), amcValue) },
        { metric: 'Tickets', value: numberValue(ticketRows[0], 'totalTickets') },
        { metric: 'Hardware Recycle', value: numberValue(retiredRows[0], 'hardwareRecycle') }
      ];
    } else if (flag === 'roomCapacity' || flag === 'deviceType' || flag === 'investmentAndAmc' || flag === 'topRoomsHighValue') {
      const exportFilters = appendAssetExportIdFilter(
        flag,
        exportId,
        assetFilters.whereSql,
        assetFilters.params,
        'a'
      );

      [rows] = await db.query(
        `
          SELECT
            ${getBasicAssetSelect('a')}
          FROM assets a
          ${exportFilters.whereSql}
          ORDER BY a.roomName ASC, a.assetType ASC, a.assetName ASC
        `,
        exportFilters.params
      );
      columns = BASIC_ASSET_EXPORT_COLUMNS;
    } else if (flag === 'tickets') {
      [rows] = await db.query(
        `
          SELECT
            t.ticketNumber,
            t.subject,
            t.status,
            ${getBasicAssetSelect('a')}
          FROM tickts t
          LEFT JOIN assets a ON a.id = t.assetId AND a.tenantId = t.tenantId
          ${ticketScopedFilters.whereSql}
            ${isMissing(exportId) ? '' : 'AND COALESCE(NULLIF(TRIM(t.status), \'\'), \'Not Specified\') = ?'}
          ORDER BY t.createdAt DESC
        `,
        isMissing(exportId) ? ticketScopedFilters.params : [...ticketScopedFilters.params, normalizeString(exportId)]
      );
      columns = [
        { header: 'Ticket Number', key: 'ticketNumber' },
        { header: 'Subject', key: 'subject' },
        { header: 'Status', key: 'status' },
        ...BASIC_ASSET_EXPORT_COLUMNS
      ];
    } else if (flag === 'outOfWarranty') {
      [rows] = await db.query(
        `
          SELECT
            ${getBasicAssetSelect('a')},
            DATE_FORMAT(${warrantyDateSql}, '%Y-%m-%d') AS warrantyEnd
          FROM assets a
          ${assetFilters.whereSql}
            AND ${warrantyDateSql} < CURDATE()
          ORDER BY ${warrantyDateSql} ASC, a.roomName ASC, a.assetName ASC
        `,
        assetFilters.params
      );
      columns = [
        ...BASIC_ASSET_EXPORT_COLUMNS,
        { header: 'Warranty End', key: 'warrantyEnd' }
      ];
    } else if (flag === 'hardwareRecycle') {
      [rows] = await db.query(
        `
          SELECT
            r.id AS retiredId,
            ${getBasicAssetSelect('a')},
            r.retirementStatus,
            r.comments,
            DATE_FORMAT(r.createdAt, '%Y-%m-%d') AS retiredDate
          FROM retiredInvertory r
          LEFT JOIN assets a ON a.id = r.assetId AND a.tenantId = r.tenantId
          ${retiredScopedFilters.whereSql}
          ORDER BY r.createdAt DESC
        `,
        retiredScopedFilters.params
      );
      columns = [
        { header: 'Retired ID', key: 'retiredId' },
        ...BASIC_ASSET_EXPORT_COLUMNS,
        { header: 'Retirement Status', key: 'retirementStatus' },
        { header: 'Comments', key: 'comments' },
        { header: 'Retired Date', key: 'retiredDate' }
      ];
    } else if (flag === 'topRoomsWithIssues') {
      const exportFilters = appendAssetExportIdFilter(
        flag,
        exportId,
        assetFilters.whereSql,
        assetFilters.params,
        'a'
      );

      [rows] = await db.query(
        `
          SELECT
            ${getBasicAssetSelect('a')},
            COUNT(DISTINCT t.id) AS tickets,
            CASE WHEN ${warrantyDateSql} < CURDATE() THEN 1 ELSE 0 END AS warrantyIssue,
            COUNT(DISTINCT t.id) + CASE WHEN ${warrantyDateSql} < CURDATE() THEN 1 ELSE 0 END AS totalIssues
          FROM assets a
          LEFT JOIN tickts t ON t.assetId = a.id AND t.tenantId = a.tenantId${ticketJoinDateFilters.joinSql}
          ${exportFilters.whereSql}
          GROUP BY a.id
          HAVING totalIssues > 0
          ORDER BY totalIssues DESC, a.roomName ASC, a.assetName ASC
        `,
        [...ticketJoinDateFilters.params, ...exportFilters.params]
      );
      columns = [
        ...BASIC_ASSET_EXPORT_COLUMNS,
        { header: 'Tickets', key: 'tickets' },
        { header: 'Warranty Issue', key: 'warrantyIssue' },
        { header: 'Total Issues', key: 'totalIssues' }
      ];
    }

    await logAuditEvent({
      req,
      action: 'report.download',
      entityType: 'report',
      entityId: flag,
      entityLabel: `reports-${flag}.csv`,
      metadata: {
        flag,
        rowCount: rows.length,
        filters: req.query
      }
    });

    return sendCsv(res, `reports-${flag}.csv`, buildCsv(columns, rows));
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

// GET /api/reports?alertWindowDays=30&topLimit=10&startDate=2026-01-01&endDate=2026-04-30&country=India&locationId=HQ&buildingId=Tower&roomId=Room%20101
router.get('/', async (req, res) => {
  try {
    const { tenantId } = req.user;
    const alertWindowDays = parseBoundedInteger(
      req.query.alertWindowDays,
      DEFAULT_ALERT_WINDOW_DAYS,
      MAX_ALERT_WINDOW_DAYS
    );
    const topLimit = parseBoundedInteger(req.query.topLimit, DEFAULT_TOP_LIMIT, MAX_TOP_LIMIT);
    const db = pool.promise();
    const warrantyDateSql = getWarrantyDateSql('a');
    const assetFilters = buildAssetFilters(req.query, tenantId, 'a');
    const unaliasedAssetFilters = buildAssetFilters(req.query, tenantId, '');
    const ticketFilters = buildTicketFilters(req.query, tenantId, 't');
    const ticketAssetFilters = buildAssetFilters(req.query, tenantId, 'a');
    const ticketScopedFilters = mergeWhereClauses(ticketFilters, ticketAssetFilters);
    const retiredFilters = buildRetiredFilters(req.query, tenantId, 'r');
    const retiredAssetFilters = buildAssetFilters(req.query, tenantId, 'a', { includeActive: false });
    const retiredScopedFilters = mergeWhereClauses(retiredFilters, retiredAssetFilters);
    const ticketJoinDateFilters = buildDateJoinFilters(req.query, 't');
    const roomScopeSql = getRoomScopeSql('a');
    const unaliasedRoomScopeSql = getRoomScopeSql('');
    const paxNameSql = getPaxNameSql('roomPax');
    const countryOptionFilters = buildFilterOptionWhere(req.query, tenantId);
    const locationOptionFilters = buildFilterOptionWhere(req.query, tenantId, '', ['country']);
    const buildingOptionFilters = buildFilterOptionWhere(req.query, tenantId, '', ['country', 'location']);
    const roomOptionFilters = buildFilterOptionWhere(req.query, tenantId, '', ['country', 'location', 'building']);
    const dateRangeFilters = buildFilterOptionWhere(req.query, tenantId, '', ['country', 'location', 'building', 'roomName']);

    const totalsSql = `
      SELECT
        COUNT(*) AS totalAssets,
        COUNT(DISTINCT ${roomScopeSql}) AS totalRooms,
        COALESCE(SUM(COALESCE(a.quantity, 0) * COALESCE(a.unitPrice, 0)), 0) AS investment,
        SUM(CASE WHEN ${warrantyDateSql} >= CURDATE() THEN 1 ELSE 0 END) AS underWarranty,
        SUM(CASE WHEN ${warrantyDateSql} < CURDATE() THEN 1 ELSE 0 END) AS outOfWarranty,
        SUM(
          CASE
            WHEN ${warrantyDateSql} BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
            THEN 1 ELSE 0
          END
        ) AS expiringWarranties
      FROM assets a
      ${assetFilters.whereSql}
    `;
    const ticketsSql = `
      SELECT
        COUNT(*) AS totalTickets,
        SUM(CASE WHEN t.status = 'Opened' THEN 1 ELSE 0 END) AS openedTickets,
        SUM(CASE WHEN t.status = 'Pending' THEN 1 ELSE 0 END) AS pendingTickets,
        SUM(CASE WHEN t.status = 'Closed' THEN 1 ELSE 0 END) AS closedTickets
      FROM tickts t
      LEFT JOIN assets a ON a.id = t.assetId AND a.tenantId = t.tenantId
      ${ticketScopedFilters.whereSql}
    `;
    const retiredSql = `
      SELECT COUNT(*) AS hardwareRecycle
      FROM retiredInvertory r
      LEFT JOIN assets a ON a.id = r.assetId AND a.tenantId = r.tenantId
      ${retiredScopedFilters.whereSql}
    `;
    const hardwareRecycleSql = `
      SELECT
        COALESCE(NULLIF(TRIM(r.retirementStatus), ''), 'Not Specified') AS name,
        COUNT(*) AS value
      FROM retiredInvertory r
      LEFT JOIN assets a ON a.id = r.assetId AND a.tenantId = r.tenantId
      ${retiredScopedFilters.whereSql}
      GROUP BY COALESCE(NULLIF(TRIM(r.retirementStatus), ''), 'Not Specified')
      ORDER BY value DESC, name ASC
    `;
    const roomCapacitySql = `
      SELECT
        roomName AS name,
        roomName,
        building,
        location,
        country,
        ${paxNameSql} AS paxName,
        roomPax AS pax,
        1 AS rooms,
        assets,
        quantity,
        roomPax AS capacity
      FROM (
        SELECT
          ${unaliasedRoomScopeSql} AS roomScope,
          COALESCE(NULLIF(TRIM(country), ''), 'Not Specified') AS country,
          COALESCE(NULLIF(TRIM(location), ''), 'Not Specified') AS location,
          COALESCE(NULLIF(TRIM(building), ''), 'Not Specified') AS building,
          COALESCE(NULLIF(TRIM(roomName), ''), 'Not Specified') AS roomName,
          COUNT(*) AS assets,
          COALESCE(SUM(COALESCE(quantity, 0)), 0) AS quantity,
          COALESCE(MAX(pax), 0) AS roomPax
        FROM assets
        ${unaliasedAssetFilters.whereSql}
        GROUP BY
          ${unaliasedRoomScopeSql},
          COALESCE(NULLIF(TRIM(country), ''), 'Not Specified'),
          COALESCE(NULLIF(TRIM(location), ''), 'Not Specified'),
          COALESCE(NULLIF(TRIM(building), ''), 'Not Specified'),
          COALESCE(NULLIF(TRIM(roomName), ''), 'Not Specified')
      ) roomCapacityByRoom
      ORDER BY capacity DESC, roomName ASC
    `;
    const deviceTypeSql = `
      SELECT
        COALESCE(NULLIF(TRIM(assetType), ''), 'Not Specified') AS name,
        COUNT(*) AS value
      FROM assets
      ${unaliasedAssetFilters.whereSql}
      GROUP BY COALESCE(NULLIF(TRIM(assetType), ''), 'Not Specified')
      ORDER BY value DESC, name ASC
    `;
    const ticketStatusSql = `
      SELECT t.status AS name, COUNT(*) AS value
      FROM tickts t
      LEFT JOIN assets a ON a.id = t.assetId AND a.tenantId = t.tenantId
      ${ticketScopedFilters.whereSql}
      GROUP BY t.status
      ORDER BY value DESC, name ASC
    `;
    const topRoomsWithIssuesSql = `
      SELECT
        COALESCE(NULLIF(TRIM(a.roomName), ''), 'Not Specified') AS roomName,
        0 AS maintenance,
        COUNT(DISTINCT t.id) AS tickets,
        COUNT(DISTINCT CASE WHEN ${warrantyDateSql} < CURDATE() THEN a.id END) AS warranty,
        COUNT(DISTINCT t.id) + COUNT(DISTINCT CASE WHEN ${warrantyDateSql} < CURDATE() THEN a.id END) AS totalIssues
      FROM assets a
      LEFT JOIN tickts t ON t.assetId = a.id AND t.tenantId = a.tenantId${ticketJoinDateFilters.joinSql}
      ${assetFilters.whereSql}
      GROUP BY COALESCE(NULLIF(TRIM(a.roomName), ''), 'Not Specified')
      HAVING totalIssues > 0
      ORDER BY totalIssues DESC, roomName ASC
      LIMIT ?
    `;
    const topRoomsHighValueSql = `
      SELECT
        COALESCE(NULLIF(TRIM(roomName), ''), 'Not Specified') AS roomName,
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(assetType, '')) LIKE '%video%' THEN COALESCE(quantity, 0) * COALESCE(unitPrice, 0) ELSE 0 END), 0) AS video,
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(assetType, '')) LIKE '%audio%' THEN COALESCE(quantity, 0) * COALESCE(unitPrice, 0) ELSE 0 END), 0) AS audio,
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(assetType, '')) NOT LIKE '%video%' AND LOWER(COALESCE(assetType, '')) NOT LIKE '%audio%' THEN COALESCE(quantity, 0) * COALESCE(unitPrice, 0) ELSE 0 END), 0) AS other,
        COALESCE(SUM(COALESCE(quantity, 0) * COALESCE(unitPrice, 0)), 0) AS totalValue
      FROM assets
      ${unaliasedAssetFilters.whereSql}
      GROUP BY COALESCE(NULLIF(TRIM(roomName), ''), 'Not Specified')
      ORDER BY totalValue DESC, roomName ASC
      LIMIT ?
    `;
    const countriesSql = `
      SELECT DISTINCT TRIM(country) AS value
      FROM assets
      ${countryOptionFilters.whereSql}
        AND country IS NOT NULL
        AND TRIM(country) <> ''
      ORDER BY value ASC
    `;
    const locationsSql = `
      SELECT DISTINCT TRIM(location) AS value
      FROM assets
      ${locationOptionFilters.whereSql}
        AND location IS NOT NULL
        AND TRIM(location) <> ''
      ORDER BY value ASC
    `;
    const buildingsSql = `
      SELECT DISTINCT TRIM(building) AS value
      FROM assets
      ${buildingOptionFilters.whereSql}
        AND building IS NOT NULL
        AND TRIM(building) <> ''
      ORDER BY value ASC
    `;
    const roomsSql = `
      SELECT DISTINCT TRIM(roomName) AS value
      FROM assets
      ${roomOptionFilters.whereSql}
        AND roomName IS NOT NULL
        AND TRIM(roomName) <> ''
      ORDER BY value ASC
    `;
    const dateRangeSql = `
      SELECT
        DATE_FORMAT(MIN(createdAt), '%Y-%m-%d') AS minDate,
        DATE_FORMAT(MAX(createdAt), '%Y-%m-%d') AS maxDate
      FROM assets
      ${dateRangeFilters.whereSql}
    `;

    const [
      [totalRows],
      [ticketRows],
      [retiredRows],
      [hardwareRecycleRows],
      [roomRows],
      [deviceRows],
      [ticketStatusRows],
      [issueRows],
      [highValueRows],
      [countryRows],
      [locationRows],
      [buildingRows],
      [filterRoomRows],
      [dateRangeRows],
      amcValue
    ] = await Promise.all([
      db.query(totalsSql, [alertWindowDays, ...assetFilters.params]),
      db.query(ticketsSql, ticketScopedFilters.params),
      db.query(retiredSql, retiredScopedFilters.params),
      db.query(hardwareRecycleSql, retiredScopedFilters.params),
      db.query(roomCapacitySql, unaliasedAssetFilters.params),
      db.query(deviceTypeSql, unaliasedAssetFilters.params),
      db.query(ticketStatusSql, ticketScopedFilters.params),
      db.query(topRoomsWithIssuesSql, [...ticketJoinDateFilters.params, ...assetFilters.params, topLimit]),
      db.query(topRoomsHighValueSql, [...unaliasedAssetFilters.params, topLimit]),
      db.query(countriesSql, countryOptionFilters.params),
      db.query(locationsSql, locationOptionFilters.params),
      db.query(buildingsSql, buildingOptionFilters.params),
      db.query(roomsSql, roomOptionFilters.params),
      db.query(dateRangeSql, dateRangeFilters.params),
      getTenantAmcValue(db, tenantId)
    ]);

    const totals = {
      totalAssets: numberValue(totalRows[0], 'totalAssets'),
      totalRooms: numberValue(totalRows[0], 'totalRooms'),
      investment: numberValue(totalRows[0], 'investment'),
      underWarranty: numberValue(totalRows[0], 'underWarranty'),
      outOfWarranty: numberValue(totalRows[0], 'outOfWarranty'),
      expiringWarranties: numberValue(totalRows[0], 'expiringWarranties'),
      amcValue: calculateAmcValue(numberValue(totalRows[0], 'investment'), amcValue),
      hardwareRecycle: numberValue(retiredRows[0], 'hardwareRecycle'),
      totalTickets: numberValue(ticketRows[0], 'totalTickets'),
      openedTickets: numberValue(ticketRows[0], 'openedTickets'),
      pendingTickets: numberValue(ticketRows[0], 'pendingTickets'),
      closedTickets: numberValue(ticketRows[0], 'closedTickets')
    };
    const totalRoomCapacity = roomRows.reduce((sum, row) => sum + numberValue(row, 'capacity'), 0);
    const totalRoomCount = roomRows.reduce((sum, row) => sum + numberValue(row, 'rooms'), 0);
    const totalIssuesInTopRooms = issueRows.reduce((sum, row) => sum + numberValue(row, 'totalIssues'), 0);
    const totalHighValue = highValueRows.reduce((sum, row) => sum + numberValue(row, 'totalValue'), 0);

    const charts = {
      roomCapacity: {
        totalRooms: totals.totalRooms,
        totalCapacity: totalRoomCapacity,
        data: roomRows.map((row) => ({
          name: row.name,
          roomName: row.roomName || row.name,
          building: row.building,
          location: row.location,
          country: row.country,
          paxName: row.paxName || row.name,
          pax: numberValue(row, 'pax'),
          rooms: numberValue(row, 'rooms'),
          assets: numberValue(row, 'assets'),
          quantity: numberValue(row, 'quantity'),
          capacity: numberValue(row, 'capacity'),
          percentage: percentageValue(numberValue(row, 'rooms'), totalRoomCount)
        }))
      },
      deviceType: {
        totalAssets: totals.totalAssets,
        data: mapNamedValueRows(deviceRows, 'name', 'value', totals.totalAssets)
      },
      investmentAndAmc: {
        data: [
          {
            name: 'Investment',
            value: totals.investment,
            percentage: percentageValue(totals.investment, totals.investment)
          },
          {
            name: 'AMC',
            value: totals.amcValue,
            percentage: percentageValue(totals.amcValue, totals.investment)
          }
        ]
      },
      tickets: {
        totalTickets: totals.totalTickets,
        data: mapNamedValueRows(ticketStatusRows, 'name', 'value', totals.totalTickets)
      },
      outOfWarranty: {
        totalDevices: totals.outOfWarranty,
        data: [{
          name: 'Out of Warranty',
          value: totals.outOfWarranty,
          percentage: percentageValue(totals.outOfWarranty, totals.totalAssets)
        }]
      },
      hardwareRecycle: {
        totalDevices: totals.hardwareRecycle,
        data: mapNamedValueRows(hardwareRecycleRows, 'name', 'value', totals.hardwareRecycle)
      },
      topRoomsWithIssues: {
        data: issueRows.map((row) => ({
          roomName: row.roomName,
          maintenance: numberValue(row, 'maintenance'),
          tickets: numberValue(row, 'tickets'),
          warranty: numberValue(row, 'warranty'),
          totalIssues: numberValue(row, 'totalIssues'),
          percentage: percentageValue(numberValue(row, 'totalIssues'), totalIssuesInTopRooms)
        }))
      },
      topRoomsHighValue: {
        data: highValueRows.map((row) => ({
          roomName: row.roomName,
          video: numberValue(row, 'video'),
          audio: numberValue(row, 'audio'),
          other: numberValue(row, 'other'),
          totalValue: numberValue(row, 'totalValue'),
          percentage: percentageValue(numberValue(row, 'totalValue'), totalHighValue)
        }))
      }
    };
    const filterOptions = {
      countries: mapOptionRows(countryRows),
      locations: mapOptionRows(locationRows),
      buildings: mapOptionRows(buildingRows),
      rooms: mapOptionRows(filterRoomRows),
      timeRange: {
        minDate: dateRangeRows[0]?.minDate || null,
        maxDate: dateRangeRows[0]?.maxDate || null
      }
    };

    return res.status(200).json({
      success: true,
      message: 'Reports fetched successfully',
      alertWindowDays,
      topLimit,
      filters: assetFilters.appliedFilters,
      data: {
        totals,
        cards: buildCards(totals),
        charts,
        filterOptions
      }
    });
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

module.exports = router;
