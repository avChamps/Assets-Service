const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { logAuditEvent } = require('../utils/auditLogger');
const { createNotificationSafely } = require('../utils/notifications');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const DEFAULT_TICKET_STATUS = 'Pending';
const TICKET_NUMBER_PREFIX = 'AST';
const TICKET_NUMBER_START = TICKET_NUMBER_PREFIX.length + 2;
const ALLOWED_TICKET_STATUSES = new Set(['Opened', 'Pending', 'Closed', 'In Progress']);

const TICKET_COLUMNS = [
  'id',
  'tenantId',
  'ticketNumber',
  'assetId',
  'subject',
  'status',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt'
];

const TICKET_USER_NAME_COLUMNS = [
  {
    header: 'createdByName',
    alias: 'ticket_createdByName',
    expression: 'createdUser.fullName'
  },
  {
    header: 'updatedByName',
    alias: 'ticket_updatedByName',
    expression: 'updatedUser.fullName'
  }
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

const TICKET_CSV_COLUMNS = [
  ...TICKET_COLUMNS.map((column) => ({
    header: column,
    prefix: 'ticket_',
    column
  })),
  ...TICKET_USER_NAME_COLUMNS.map((column) => ({
    header: column.header,
    alias: column.alias
  })),
  ...ASSET_COLUMNS.map((column) => ({
    header: `asset_${column}`,
    prefix: 'asset_',
    column
  }))
];

const SEARCH_COLUMNS = [
  't.id',
  't.ticketNumber',
  't.assetId',
  't.subject',
  't.status',
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

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeTicketStatus(value) {
  const status = normalizeString(value);

  if (isMissing(status)) {
    return status;
  }

  const normalized = String(status).toLowerCase().replace(/[\s_-]+/g, '');
  const statusMap = {
    opened: 'Opened',
    pending: 'Pending',
    closed: 'Closed',
    inprogress: 'In Progress'
  };

  return statusMap[normalized] || status;
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

function buildAliasedColumns(tableAlias, columns, prefix) {
  return columns.map((column) => `${tableAlias}.${column} AS ${prefix}${column}`).join(', ');
}

function buildTicketUserNameColumns() {
  return TICKET_USER_NAME_COLUMNS
    .map((column) => `${column.expression} AS ${column.alias}`)
    .join(', ');
}

function buildTicketUserNameJoins() {
  return `
      LEFT JOIN users createdUser
        ON createdUser.userId = t.createdBy
       AND createdUser.tenantId = t.tenantId
      LEFT JOIN users updatedUser
        ON updatedUser.userId = t.updatedBy
       AND updatedUser.tenantId = t.tenantId
    `;
}

function pickPrefixedColumns(row, columns, prefix) {
  return columns.reduce((payload, column) => {
    payload[column] = row[`${prefix}${column}`];
    return payload;
  }, {});
}

function mapTicketRow(row) {
  return {
    ...pickPrefixedColumns(row, TICKET_COLUMNS, 'ticket_'),
    createdByName: row.ticket_createdByName || null,
    updatedByName: row.ticket_updatedByName || null,
    asset: row.asset_id ? pickPrefixedColumns(row, ASSET_COLUMNS, 'asset_') : null
  };
}

function buildListFilters(query, tenantId, options = {}) {
  const { includeStatus = true } = options;
  const conditions = ['t.tenantId = ?'];
  const params = [tenantId];
  const search = normalizeString(query.search);
  const status = normalizeTicketStatus(query.status);
  const startDate = cleanText(query.startDate || query.fromDate);
  const endDate = cleanText(query.endDate || query.toDate);

  if (includeStatus && !isMissing(status)) {
    conditions.push('t.status = ?');
    params.push(status);
  }

  if (!isMissing(search)) {
    conditions.push(`(${SEARCH_COLUMNS.map((column) => `${column} LIKE ?`).join(' OR ')})`);
    params.push(...SEARCH_COLUMNS.map(() => `%${search}%`));
  }

  if (startDate) {
    conditions.push('t.createdAt >= ?');
    params.push(startDate);
  }

  if (endDate) {
    conditions.push('t.createdAt < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(endDate);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

function validateTicketStatus(status) {
  const normalizedStatus = normalizeTicketStatus(status);

  if (!isMissing(normalizedStatus) && !ALLOWED_TICKET_STATUSES.has(normalizedStatus)) {
    return 'status must be Opened, Pending, Closed, or In Progress';
  }

  return null;
}

function buildTicketCounts(rows) {
  const counts = {
    total: 0,
    Opened: 0,
    Pending: 0,
    'In Progress': 0,
    inProgress: 0,
    Closed: 0
  };

  for (const row of rows) {
    const count = Number(row.total || 0);

    counts.total += count;

    if (Object.prototype.hasOwnProperty.call(counts, row.status)) {
      counts[row.status] = count;
    }

    if (row.status === 'In Progress') {
      counts.inProgress = count;
    }
  }

  return counts;
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

function buildTicketsCsv(rows) {
  const header = TICKET_CSV_COLUMNS.map(({ header: columnHeader }) => columnHeader).join(',');
  const csvRows = rows.map((row) => (
    TICKET_CSV_COLUMNS
      .map(({ prefix, column, alias }) => escapeCsvValue(alias ? row[alias] : row[`${prefix}${column}`]))
      .join(',')
  ));

  return [header, ...csvRows].join('\n');
}

function formatTicketNumber(sequence) {
  return `${TICKET_NUMBER_PREFIX}-${sequence}`;
}

async function getNextTicketNumberSequence(db, tenantId) {
  const [rows] = await db.query(
    `
      SELECT COALESCE(MAX(CAST(SUBSTRING(ticketNumber, ?) AS UNSIGNED)), 0) + 1 AS nextSequence
      FROM tickts
      WHERE tenantId = ?
        AND ticketNumber REGEXP ?
    `,
    [TICKET_NUMBER_START, tenantId, `^${TICKET_NUMBER_PREFIX}-[0-9]+$`]
  );

  return Number(rows[0]?.nextSequence || 1);
}

function sendDatabaseError(res, error, action) {
  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      message: 'Ticket already exists with this ticketNumber'
    });
  }

  if (error.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(400).json({
      success: false,
      message: 'Invalid tenantId, assetId, createdBy, or updatedBy reference'
    });
  }

  return res.status(500).json({
    success: false,
    message: `Server error while ${action} ticket`,
    error: error.message
  });
}

router.use(authenticateToken);

// POST /api/tickets
router.post('/', async (req, res) => {
  try {
    const assetId = normalizeString(req.body.assetId || req.body.AssetID);
    const subject = normalizeString(req.body.subject);

    if (isMissing(assetId)) {
      return res.status(400).json({
        success: false,
        message: 'assetId is required'
      });
    }

    if (isMissing(subject)) {
      return res.status(400).json({
        success: false,
        message: 'subject is required'
      });
    }

    const db = pool.promise();
    const [assetRows] = await db.query(
      'SELECT id FROM assets WHERE id = ? AND tenantId = ? LIMIT 1',
      [assetId, req.user.tenantId]
    );

    if (!assetRows.length) {
      return res.status(404).json({
        success: false,
        message: 'Asset not found for this tenant'
      });
    }

    const id = uuidv4();
    const ticketNumber = formatTicketNumber(await getNextTicketNumberSequence(db, req.user.tenantId));

    await db.query(
      `
        INSERT INTO tickts (
          id, tenantId, ticketNumber, assetId, subject, status, createdBy, updatedBy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [id, req.user.tenantId, ticketNumber, assetId, subject, DEFAULT_TICKET_STATUS, req.user.userId, req.user.userId]
    );

    await createNotificationSafely({
      db,
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      title: 'Ticket created',
      message: `Ticket ${ticketNumber} has been created for ${subject}.`,
      type: 'ticket',
      entityType: 'ticket',
      entityId: id,
      createdBy: req.user.userId
    });

    await logAuditEvent({
      req,
      action: 'ticket.create',
      entityType: 'ticket',
      entityId: id,
      entityLabel: ticketNumber,
      metadata: {
        ticketNumber,
        assetId,
        subject,
        status: DEFAULT_TICKET_STATUS
      }
    });

    const [rows] = await db.query(
      `SELECT
         ${buildAliasedColumns('t', TICKET_COLUMNS, 'ticket_')},
         ${buildTicketUserNameColumns()}
       FROM tickts t
       ${buildTicketUserNameJoins()}
       WHERE t.id = ? AND t.tenantId = ?
       LIMIT 1`,
      [id, req.user.tenantId]
    );

    return res.status(201).json({
      success: true,
      message: 'Ticket created successfully',
      data: mapTicketRow(rows[0])
    });
  } catch (error) {
    return sendDatabaseError(res, error, 'creating');
  }
});

// GET /api/tickets
router.get('/', async (req, res) => {
  try {
    const statusValidationError = validateTicketStatus(req.query.status);
    const dateFilterError = getDateFilterError(req.query);

    if (statusValidationError) {
      return res.status(400).json({
        success: false,
        message: statusValidationError
      });
    }

    if (dateFilterError) {
      return res.status(400).json({
        success: false,
        message: dateFilterError
      });
    }

    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const db = pool.promise();
    const { whereSql, params } = buildListFilters(req.query, req.user.tenantId);
    const {
      whereSql: countsWhereSql,
      params: countsParams
    } = buildListFilters(req.query, req.user.tenantId, { includeStatus: false });

    const countSql = `
      SELECT COUNT(*) AS total
      FROM tickts t
      LEFT JOIN assets a ON a.id = t.assetId AND a.tenantId = t.tenantId
      ${whereSql}
    `;
    const listSql = `
      SELECT
        ${buildAliasedColumns('t', TICKET_COLUMNS, 'ticket_')},
        ${buildTicketUserNameColumns()},
        ${buildAliasedColumns('a', ASSET_COLUMNS, 'asset_')}
      FROM tickts t
      LEFT JOIN assets a ON a.id = t.assetId AND a.tenantId = t.tenantId
      ${buildTicketUserNameJoins()}
      ${whereSql}
      ORDER BY
        CASE
          WHEN t.status = 'Pending' THEN 0
          WHEN t.status = 'Closed' THEN 2
          ELSE 1
        END,
        t.createdAt DESC
      LIMIT ? OFFSET ?
    `;
    const statusCountsSql = `
      SELECT t.status, COUNT(*) AS total
      FROM tickts t
      LEFT JOIN assets a ON a.id = t.assetId AND a.tenantId = t.tenantId
      ${countsWhereSql}
      GROUP BY t.status
    `;

    const [[countRows], [rows], [statusCountRows]] = await Promise.all([
      db.query(countSql, params),
      db.query(listSql, [...params, limit, offset]),
      db.query(statusCountsSql, countsParams)
    ]);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);
    const counts = buildTicketCounts(statusCountRows);

    return res.status(200).json({
      success: true,
      message: 'Tickets fetched successfully',
      counts,
      data: rows.map(mapTicketRow),
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

// GET /api/tickets/export/csv
router.get('/export/csv', async (req, res) => {
  try {
    const statusValidationError = validateTicketStatus(req.query.status);
    const dateFilterError = getDateFilterError(req.query);

    if (statusValidationError) {
      return res.status(400).json({
        success: false,
        message: statusValidationError
      });
    }

    if (dateFilterError) {
      return res.status(400).json({
        success: false,
        message: dateFilterError
      });
    }

    const db = pool.promise();
    const { whereSql, params } = buildListFilters(req.query, req.user.tenantId);
    const exportSql = `
      SELECT
        ${buildAliasedColumns('t', TICKET_COLUMNS, 'ticket_')},
        ${buildTicketUserNameColumns()},
        ${buildAliasedColumns('a', ASSET_COLUMNS, 'asset_')}
      FROM tickts t
      LEFT JOIN assets a ON a.id = t.assetId AND a.tenantId = t.tenantId
      ${buildTicketUserNameJoins()}
      ${whereSql}
      ORDER BY t.createdAt DESC
    `;

    const [rows] = await db.query(exportSql, params);
    const csv = buildTicketsCsv(rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.csv"');

    await logAuditEvent({
      req,
      action: 'ticket.download',
      entityType: 'ticket',
      entityLabel: 'tickets.csv',
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

// GET /api/tickets/:id
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.promise().query(
      `
        SELECT
          ${buildAliasedColumns('t', TICKET_COLUMNS, 'ticket_')},
          ${buildTicketUserNameColumns()},
          ${buildAliasedColumns('a', ASSET_COLUMNS, 'asset_')}
        FROM tickts t
        LEFT JOIN assets a ON a.id = t.assetId AND a.tenantId = t.tenantId
        ${buildTicketUserNameJoins()}
        WHERE t.id = ? AND t.tenantId = ?
        LIMIT 1
      `,
      [req.params.id, req.user.tenantId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Ticket fetched successfully',
      data: mapTicketRow(rows[0])
    });
  } catch (error) {
    return sendDatabaseError(res, error, 'fetching');
  }
});

// GET /api/tickets/asset/:assetId
router.get('/asset/:assetId', async (req, res) => {
  try {
    const assetId = normalizeString(req.params.assetId);

    if (isMissing(assetId)) {
      return res.status(400).json({
        success: false,
        message: 'assetId is required'
      });
    }

    const [assetRows] = await pool.promise().query(
      'SELECT id FROM assets WHERE id = ? AND tenantId = ? LIMIT 1',
      [assetId, req.user.tenantId]
    );

    if (!assetRows.length) {
      return res.status(404).json({
        success: false,
        message: 'Asset not found for this tenant'
      });
    }

    const [rows] = await pool.promise().query(
      `
        SELECT
          ${buildAliasedColumns('t', TICKET_COLUMNS, 'ticket_')},
          ${buildTicketUserNameColumns()},
          ${buildAliasedColumns('a', ASSET_COLUMNS, 'asset_')}
        FROM tickts t
        LEFT JOIN assets a ON a.id = t.assetId AND a.tenantId = t.tenantId
        ${buildTicketUserNameJoins()}
        WHERE t.assetId = ? AND t.tenantId = ?
        ORDER BY t.createdAt DESC
      `,
      [assetId, req.user.tenantId]
    );

    return res.status(200).json({
      success: true,
      message: 'Asset ticket history fetched successfully',
      totalRecords: rows.length,
      data: rows.map(mapTicketRow)
    });
  } catch (error) {
    return sendDatabaseError(res, error, 'fetching asset ticket history');
  }
});


// PATCH /api/tickets/:id/status
router.patch('/:id/status', async (req, res) => {
  try {
    const status = normalizeTicketStatus(req.body.status);

    const validationError = validateTicketStatus(status);
    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError
      });
    }

    const db = pool.promise();
    const [currentRows] = await db.query(
      'SELECT ticketNumber, subject, status, createdBy FROM tickts WHERE id = ? AND tenantId = ? LIMIT 1',
      [req.params.id, req.user.tenantId]
    );

    if (!currentRows.length) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    const [result] = await db.query(
      `
      UPDATE tickts
      SET status = ?, updatedBy = ?
      WHERE id = ? AND tenantId = ?
      `,
      [status, req.user.userId, req.params.id, req.user.tenantId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    await createNotificationSafely({
      db,
      tenantId: req.user.tenantId,
      userId: currentRows[0].createdBy,
      title: 'Ticket status updated',
      message: `Ticket ${currentRows[0].ticketNumber} status changed from ${currentRows[0].status} to ${status}.`,
      type: 'ticket',
      entityType: 'ticket',
      entityId: req.params.id,
      createdBy: req.user.userId
    });

    await logAuditEvent({
      req,
      action: 'ticket.update',
      entityType: 'ticket',
      entityId: req.params.id,
      entityLabel: currentRows[0].ticketNumber,
      metadata: {
        changedFields: ['status'],
        ticketNumber: currentRows[0].ticketNumber,
        subject: currentRows[0].subject,
        previousStatus: currentRows[0].status,
        status
      }
    });

    const [rows] = await db.query(
      `
        SELECT
          ${buildAliasedColumns('t', TICKET_COLUMNS, 'ticket_')},
          ${buildTicketUserNameColumns()},
          ${buildAliasedColumns('a', ASSET_COLUMNS, 'asset_')}
        FROM tickts t
        LEFT JOIN assets a ON a.id = t.assetId AND a.tenantId = t.tenantId
        ${buildTicketUserNameJoins()}
        WHERE t.id = ? AND t.tenantId = ?
        LIMIT 1
      `,
      [req.params.id, req.user.tenantId]
    );

    return res.status(200).json({
      success: true,
      message: 'Ticket status updated successfully',
      data: mapTicketRow(rows[0])
    });
  } catch (error) {
    return sendDatabaseError(res, error, 'updating');
  }
});

module.exports = router;
