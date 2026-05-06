const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { logAuditEvent } = require('../utils/auditLogger');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const FILTER_COLUMNS = new Set(['action', 'entityType', 'status', 'actorUserId']);
const TENANT_COLUMNS = [
  'tenantId',
  'companyName',
  'companyDomain',
  'companySize',
  'expectedAssets',
  'subscriptionType'
];
const USER_COLUMNS = [
  'userId',
  'fullName',
  'workEmail',
  'phoneNumber',
  'jobTitle',
  'location',
  'role',
  'status'
];
const AUDIT_EXPORT_COLUMNS = [
  { header: 'Audit ID', key: 'auditId' },
  { header: 'Created At', key: 'createdAt' },
  { header: 'Tenant ID', key: 'tenantId' },
  { header: 'Company Name', key: 'tenantCompanyName' },
  { header: 'Actor User ID', key: 'actorUserId' },
  { header: 'Actor Name', key: 'actorName' },
  { header: 'Actor Email', key: 'actorEmail' },
  { header: 'Actor Role', key: 'actorRole' },
  { header: 'Action', key: 'action' },
  { header: 'Entity Type', key: 'entityType' },
  { header: 'Entity ID', key: 'entityId' },
  { header: 'Entity Label', key: 'entityLabel' },
  { header: 'Status', key: 'status' },
  { header: 'IP Address', key: 'ipAddress' },
  { header: 'Request Method', key: 'requestMethod' },
  { header: 'Request Path', key: 'requestPath' },
  { header: 'User Agent', key: 'userAgent' },
  { header: 'Metadata', key: 'metadata' }
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

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidDateText(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function getDateFilterError(query) {
  const startDate = cleanText(query.startDate || query.fromDate);
  const endDate = cleanText(query.endDate || query.toDate);

  if (startDate && !isValidDateText(startDate)) {
    return 'startDate must be in YYYY-MM-DD format';
  }

  if (endDate && !isValidDateText(endDate)) {
    return 'endDate must be in YYYY-MM-DD format';
  }

  if (startDate && endDate && startDate > endDate) {
    return 'startDate cannot be after endDate';
  }

  return null;
}

function buildAuditFilters(query, tenantId) {
  const conditions = ['a.tenantId = ?'];
  const params = [tenantId];

  for (const column of FILTER_COLUMNS) {
    const value = cleanText(query[column]);

    if (value) {
      conditions.push(`a.${column} = ?`);
      params.push(value);
    }
  }

  if (cleanText(query.entityId)) {
    conditions.push('a.entityId = ?');
    params.push(cleanText(query.entityId));
  }

  if (cleanText(query.search)) {
    const search = `%${cleanText(query.search)}%`;
    conditions.push('(a.action LIKE ? OR a.entityType LIKE ? OR a.entityLabel LIKE ? OR a.actorEmail LIKE ? OR u.fullName LIKE ?)');
    params.push(search, search, search, search, search);
  }

  const startDate = cleanText(query.startDate || query.fromDate);
  const endDate = cleanText(query.endDate || query.toDate);

  if (startDate) {
    conditions.push('a.createdAt >= ?');
    params.push(startDate);
  }

  if (endDate) {
    conditions.push('a.createdAt < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(endDate);
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

function mapAuditLogRow(row) {
  return {
    id: row.id,
    auditId: row.auditId,
    tenantId: row.tenantId,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    actorName: row.actorName,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    status: row.status,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    requestMethod: row.requestMethod,
    requestPath: row.requestPath,
    metadata: row.metadata,
    createdAt: row.createdAt,
    actor: row.actorUserId ? pickPrefixedColumns(row, USER_COLUMNS, 'actor_') : null,
    tenant: row.tenantId ? pickPrefixedColumns(row, TENANT_COLUMNS, 'tenant_') : null
  };
}

function escapeCsvValue(value) {
  if (value === undefined || value === null) {
    return '';
  }

  const text = value instanceof Date
    ? value.toISOString()
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function buildAuditLogsCsv(logs) {
  const rows = logs.map((log) => {
    const flattenedLog = {
      ...log,
      tenantCompanyName: log.tenant?.companyName,
      actorRole: log.actor?.role
    };

    return AUDIT_EXPORT_COLUMNS
      .map((column) => escapeCsvValue(flattenedLog[column.key]))
      .join(',');
  });

  return [
    AUDIT_EXPORT_COLUMNS.map((column) => escapeCsvValue(column.header)).join(','),
    ...rows
  ].join('\n');
}

router.use(authenticateToken);

// GET /api/audit-log?page=1&limit=20&action=asset.create&entityType=asset
router.get('/', async (req, res) => {
  try {
    const requestedTenantId = cleanText(req.query.tenantId);
    const dateFilterError = getDateFilterError(req.query);

    if (dateFilterError) {
      return res.status(400).json({
        success: false,
        message: dateFilterError
      });
    }

    if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
      return res.status(403).json({
        success: false,
        message: 'You can only access audit logs for your tenant'
      });
    }

    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const { whereSql, params } = buildAuditFilters(req.query, req.user.tenantId);
    const db = pool.promise();

    const countSql = `
      SELECT COUNT(*) AS total
      FROM auditLogs a
      LEFT JOIN users u ON u.userId = a.actorUserId
      ${whereSql}
    `;
    const listSql = `
      SELECT
        a.id,
        a.auditId,
        a.tenantId,
        a.actorUserId,
        COALESCE(u.fullName, a.actorEmail, a.actorUserId) AS actorName,
        a.actorEmail,
        a.action,
        a.entityType,
        a.entityId,
        a.entityLabel,
        a.status,
        a.ipAddress,
        a.userAgent,
        a.requestMethod,
        a.requestPath,
        a.metadata,
        a.createdAt,
        ${buildAliasedColumns('u', USER_COLUMNS, 'actor_')},
        ${buildAliasedColumns('t', TENANT_COLUMNS, 'tenant_')}
      FROM auditLogs a
      LEFT JOIN users u ON u.userId = a.actorUserId
      LEFT JOIN tenants t ON t.tenantId = a.tenantId
      ${whereSql}
      ORDER BY a.createdAt DESC, a.id DESC
      LIMIT ? OFFSET ?
    `;

    const [[countRows], [logs]] = await Promise.all([
      db.query(countSql, params),
      db.query(listSql, [...params, limit, offset])
    ]);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    return res.status(200).json({
      success: true,
      message: 'Audit logs fetched successfully',
      data: logs.map(mapAuditLogRow),
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
      message: 'Unable to fetch audit logs',
      error: error.message
    });
  }
});

// GET /api/audit-log/export/csv?action=asset.create&startDate=2026-05-01&endDate=2026-05-03
router.get('/export/csv', async (req, res) => {
  try {
    const requestedTenantId = cleanText(req.query.tenantId);
    const dateFilterError = getDateFilterError(req.query);

    if (dateFilterError) {
      return res.status(400).json({
        success: false,
        message: dateFilterError
      });
    }

    if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
      return res.status(403).json({
        success: false,
        message: 'You can only export audit logs for your tenant'
      });
    }

    const { whereSql, params } = buildAuditFilters(req.query, req.user.tenantId);
    const [rows] = await pool.promise().query(
      `
        SELECT
          a.id,
          a.auditId,
          a.tenantId,
          a.actorUserId,
          COALESCE(u.fullName, a.actorEmail, a.actorUserId) AS actorName,
          a.actorEmail,
          a.action,
          a.entityType,
          a.entityId,
          a.entityLabel,
          a.status,
          a.ipAddress,
          a.userAgent,
          a.requestMethod,
          a.requestPath,
          a.metadata,
          a.createdAt,
          ${buildAliasedColumns('u', USER_COLUMNS, 'actor_')},
          ${buildAliasedColumns('t', TENANT_COLUMNS, 'tenant_')}
        FROM auditLogs a
        LEFT JOIN users u ON u.userId = a.actorUserId
        LEFT JOIN tenants t ON t.tenantId = a.tenantId
        ${whereSql}
        ORDER BY a.createdAt DESC, a.id DESC
      `,
      params
    );
    const logs = rows.map(mapAuditLogRow);
    const csv = buildAuditLogsCsv(logs);

    await logAuditEvent({
      req,
      action: 'audit_log.download',
      entityType: 'audit_log',
      entityLabel: 'audit-logs.csv',
      metadata: {
        rowCount: logs.length,
        filters: req.query
      }
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');

    return res.status(200).send(csv);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Unable to export audit logs',
      error: error.message
    });
  }
});

// GET /api/audit-log/summary
router.get('/summary', async (req, res) => {
  try {
    const requestedTenantId = cleanText(req.query.tenantId);
    const dateFilterError = getDateFilterError(req.query);

    if (dateFilterError) {
      return res.status(400).json({
        success: false,
        message: dateFilterError
      });
    }

    if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
      return res.status(403).json({
        success: false,
        message: 'You can only access audit summary for your tenant'
      });
    }

    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const { whereSql, params } = buildAuditFilters(req.query, req.user.tenantId);
    const db = pool.promise();

    const countSql = `
      SELECT COUNT(*) AS total
      FROM auditLogs a
      LEFT JOIN users u ON u.userId = a.actorUserId
      ${whereSql}
    `;
    const summarySql = `
      SELECT
        a.id,
        a.auditId,
        a.tenantId,
        a.actorUserId,
        COALESCE(u.fullName, a.actorEmail, a.actorUserId) AS actorName,
        a.actorEmail,
        a.action,
        a.entityType,
        a.entityId,
        a.entityLabel,
        a.status,
        a.ipAddress,
        a.userAgent,
        a.requestMethod,
        a.requestPath,
        a.metadata,
        a.createdAt,
        ${buildAliasedColumns('u', USER_COLUMNS, 'actor_')},
        ${buildAliasedColumns('t', TENANT_COLUMNS, 'tenant_')}
      FROM auditLogs a
      LEFT JOIN users u ON u.userId = a.actorUserId
      LEFT JOIN tenants t ON t.tenantId = a.tenantId
      ${whereSql}
      ORDER BY a.createdAt DESC, a.id DESC
      LIMIT ? OFFSET ?
    `;

    const [[countRows], [rows]] = await Promise.all([
      db.query(countSql, params),
      db.query(summarySql, [...params, limit, offset])
    ]);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    return res.status(200).json({
      success: true,
      message: 'Audit summary fetched successfully',
      data: rows.map(mapAuditLogRow),
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
      message: 'Unable to fetch audit summary',
      error: error.message
    });
  }
});

module.exports = router;
