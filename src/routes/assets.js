const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const ASSET_TAG_PREFIX = 'AVC';
const ASSET_TAG_NUMBER_START = ASSET_TAG_PREFIX.length + 2;

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

const INSERT_COLUMNS = [
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
  'updatedBy'
];

const UPDATE_COLUMNS = INSERT_COLUMNS.filter((column) => !['id', 'tenantId', 'assetTag', 'isActive', 'createdBy'].includes(column));
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
const LIST_FILTER_COLUMNS = [
  'country',
  'location',
  'building',
  'roomName',
  'make',
  'assetType'
];
const FILE_IGNORED_COLUMNS = new Set(['id', 'tenantId', 'assetTag', 'isActive', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt']);
const FILE_IMPORT_COLUMNS = INSERT_COLUMNS.filter((column) => !FILE_IGNORED_COLUMNS.has(column));
const CSV_HEADER_MAP = new Map(
  INSERT_COLUMNS.map((column) => [column.toLowerCase(), column])
);

for (const column of INSERT_COLUMNS) {
  CSV_HEADER_MAP.set(column.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`).toLowerCase(), column);
  CSV_HEADER_MAP.set(column.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).toLowerCase(), column);
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

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isMissing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function normalizeAssetValue(field, value) {
  if (NULLABLE_FIELDS.has(field) && isMissing(value)) {
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

function getContentType(req) {
  return req.headers['content-type'] || '';
}

function readRequestBody(req, limitBytes = MAX_IMPORT_FILE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > limitBytes) {
        reject(new Error(`File size must be ${Math.floor(limitBytes / (1024 * 1024))}MB or less`));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getMultipartBoundary(contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? match[1] || match[2] : null;
}

function parseMultipartCsvFile(bodyBuffer, contentType) {
  const boundary = getMultipartBoundary(contentType);

  if (!boundary) {
    throw new Error('Multipart boundary is missing');
  }

  const body = bodyBuffer.toString('utf8');
  const parts = body.split(`--${boundary}`);

  for (const rawPart of parts) {
    const part = rawPart.replace(/^\r?\n/, '');

    if (!part || part === '--' || part.startsWith('--')) {
      continue;
    }

    const separator = part.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
    const separatorIndex = part.indexOf(separator);

    if (separatorIndex === -1) {
      continue;
    }

    const rawHeaders = part.slice(0, separatorIndex);
    const fileContent = part
      .slice(separatorIndex + separator.length)
      .replace(/\r?\n--$/, '')
      .replace(/\r?\n$/, '');
    const isFilePart = /filename=/i.test(rawHeaders) || /name="file"/i.test(rawHeaders);

    if (isFilePart) {
      return fileContent;
    }
  }

  throw new Error('CSV file is required in form field "file"');
}

function getCsvTextFromRequest(req, bodyBuffer) {
  const contentType = getContentType(req);

  if (contentType.includes('multipart/form-data')) {
    return parseMultipartCsvFile(bodyBuffer, contentType);
  }

  if (
    contentType.includes('text/csv') ||
    contentType.includes('application/csv') ||
    contentType.includes('application/vnd.ms-excel')
  ) {
    return bodyBuffer.toString('utf8');
  }

  throw new Error('Upload a CSV file using multipart/form-data field "file" or text/csv');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        index += 1;
      }

      row.push(field);
      if (row.some((value) => !isMissing(value))) {
        rows.push(row);
      }

      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new Error('Invalid CSV: quoted field is not closed');
  }

  row.push(field);
  if (row.some((value) => !isMissing(value))) {
    rows.push(row);
  }

  return rows;
}

function normalizeCsvHeader(header) {
  return header.replace(/^\uFEFF/, '').trim().toLowerCase();
}

function parseAssetsCsv(csvText) {
  const rows = parseCsv(csvText);

  if (!rows.length) {
    return {
      records: [],
      logs: [{ type: 'error', message: 'CSV file is empty' }],
      totalRows: 0
    };
  }

  const headers = rows[0].map((header) => CSV_HEADER_MAP.get(normalizeCsvHeader(header)) || null);
  const logs = [];
  const records = [];
  const totalRows = rows.length - 1;

  rows.slice(1).forEach((row, index) => {
    const record = {};
    const rowNumber = index + 2;

    headers.forEach((header, columnIndex) => {
      if (!header || FILE_IGNORED_COLUMNS.has(header)) {
        return;
      }

      if (FILE_IMPORT_COLUMNS.includes(header)) {
        record[header] = typeof row[columnIndex] === 'string' ? row[columnIndex].trim() : row[columnIndex];
      }
    });

    if (Object.keys(record).length) {
      records.push({ rowNumber, record });
    } else {
      logs.push({
        row: rowNumber,
        type: 'error',
        message: 'No valid asset columns found'
      });
    }
  });

  return { records, logs, totalRows };
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

function buildAssetsCsv(assets) {
  const header = ASSET_COLUMNS.join(',');
  const rows = assets.map((asset) => (
    ASSET_COLUMNS.map((column) => escapeCsvValue(asset[column])).join(',')
  ));

  return [header, ...rows].join('\n');
}

function buildInsertSql() {
  const placeholders = INSERT_COLUMNS.map(() => '?').join(', ');
  return `
    INSERT INTO assets (${INSERT_COLUMNS.join(', ')})
    VALUES (${placeholders})
  `;
}

function formatAssetTag(sequence) {
  return `${ASSET_TAG_PREFIX}-${sequence}`;
}

async function getNextAssetTagSequence(db, tenantId) {
  const [rows] = await db.query(
    `
      SELECT COALESCE(MAX(CAST(SUBSTRING(assetTag, ?) AS UNSIGNED)), 0) + 1 AS nextSequence
      FROM assets
      WHERE tenantId = ?
        AND assetTag REGEXP ?
    `,
    [ASSET_TAG_NUMBER_START, tenantId, `^${ASSET_TAG_PREFIX}-[0-9]+$`]
  );

  return Number(rows[0]?.nextSequence || 1);
}

async function getTenantAssetLimit(db, tenantId) {
  const [rows] = await db.query(
    `
      SELECT
        latest.subscriptionType,
        sp.maxAssets,
        (
          SELECT COUNT(*)
          FROM assets tenantAssets
          WHERE tenantAssets.tenantId = ?
            AND tenantAssets.isActive = TRUE
        ) AS activeAssets
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

function hasReachedAssetLimit(assetLimit, pendingAssets = 0) {
  return assetLimit
    && assetLimit.maxAssets !== null
    && Number(assetLimit.activeAssets) + pendingAssets >= Number(assetLimit.maxAssets);
}

function buildAssetLimitResponse(assetLimit) {
  return {
    subscriptionType: assetLimit.subscriptionType,
    maxAssets: Number(assetLimit.maxAssets),
    activeAssets: Number(assetLimit.activeAssets)
  };
}

function validateAssetForInsert(asset) {
  const missingFields = getMissingRequiredFields(asset);

  if (missingFields.length) {
    return `Required fields missing: ${missingFields.join(', ')}`;
  }

  return validateNumericFields(asset) || validateRequiredUpdateFields(asset);
}

function buildListFilters(query, tenantId) {
  const conditions = ['tenantId = ?', 'isActive = TRUE'];
  const params = [tenantId];

  for (const column of LIST_FILTER_COLUMNS) {
    const value = query[column];

    if (!isMissing(value)) {
      conditions.push(`${column} = ?`);
      params.push(typeof value === 'string' ? value.trim() : value);
    }
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

function buildInsertAsset(body) {
  const asset = {
    id: uuidv4(),
    isActive: true,
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
      message: 'Asset already exists with this serialNo or assetTag'
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

// GET /api/assets/list?page=1&limit=10&country=India&location=HQ%20-%20Floor%208&building=Kapil%20Towers&roomName=Ganga&make=Test%20Make&assetType=Cables
router.get('/list', async (req, res) => {
  try {
    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const { tenantId } = req.user;
    const { whereSql, params } = buildListFilters(req.query, tenantId);

    const db = pool.promise();
    const countSql = `SELECT COUNT(*) AS total FROM assets ${whereSql}`;
    const totalAssetsValueSql = `
      SELECT COALESCE(SUM(COALESCE(quantity, 0) * COALESCE(unitPrice, 0)), 0) AS totalAssetsValue
      FROM assets
      WHERE tenantId = ? AND isActive = TRUE
    `;

    const [[countRows], [totalAssetsValueRows]] = await Promise.all([
      db.query(countSql, params),
      db.query(totalAssetsValueSql, [tenantId])
    ]);
    const totalRecords = countRows[0]?.total || 0;
    const totalAssetsValue = Number(totalAssetsValueRows[0]?.totalAssetsValue || 0);
    const totalPages = Math.ceil(totalRecords / limit);

    const listSql = `
      SELECT ${ASSET_COLUMNS.join(', ')}
      FROM assets
      ${whereSql}
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?
    `;

    const [assets] = await db.query(listSql, [...params, limit, offset]);

    return res.status(200).json({
      success: true,
      message: 'Assets fetched successfully',
      data: assets,
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
    return sendDatabaseError(res, error, 'fetching');
  }
});

// POST /api/assets/upload
router.post('/upload', async (req, res) => {
  try {
    const bodyBuffer = await readRequestBody(req);
    const csvText = getCsvTextFromRequest(req, bodyBuffer);
    const { records, logs, totalRows } = parseAssetsCsv(csvText);

    if (!records.length) {
      return res.status(400).json({
        success: false,
        message: 'No valid asset records found in CSV file',
        summary: {
          totalRows,
          insertedRows: 0,
          failedRows: logs.length
        },
        logs
      });
    }

    const insertSql = buildInsertSql();
    const insertedIds = [];
    const db = pool.promise();
    let nextAssetTagSequence = await getNextAssetTagSequence(db, req.user.tenantId);
    const assetLimit = await getTenantAssetLimit(db, req.user.tenantId);
    let failedRows = logs.length;

    for (const { rowNumber, record } of records) {
      if (hasReachedAssetLimit(assetLimit, insertedIds.length)) {
        failedRows += 1;
        logs.push({
          row: rowNumber,
          type: 'error',
          message: 'Asset limit reached for current subscription plan'
        });
        continue;
      }

      const asset = buildInsertAsset({
        ...record,
        tenantId: req.user.tenantId,
        assetTag: formatAssetTag(nextAssetTagSequence),
        createdBy: req.user.userId,
        updatedBy: req.user.userId
      });
      const validationError = validateAssetForInsert(asset);

      if (validationError) {
        failedRows += 1;
        logs.push({
          row: rowNumber,
          type: 'error',
          message: validationError
        });
        continue;
      }

      try {
        await db.query(
          insertSql,
          INSERT_COLUMNS.map((field) => asset[field])
        );
        insertedIds.push(asset.id);
        nextAssetTagSequence += 1;
      } catch (error) {
        failedRows += 1;
        logs.push({
          row: rowNumber,
          type: 'error',
          message: error.code === 'ER_DUP_ENTRY'
            ? 'Asset already exists with this serialNo or assetTag'
            : error.message
        });
      }
    }

    const insertedRows = insertedIds.length;

    return res.status(200).json({
      success: failedRows === 0,
      message: failedRows
        ? 'Asset file processed with errors'
        : 'Asset file imported successfully',
      summary: {
        totalRows,
        insertedRows,
        failedRows
      },
      insertedIds,
      logs
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: 'Unable to process asset CSV file',
      error: error.message
    });
  }
});

// GET /api/assets/export/csv
router.get('/export/csv', async (req, res) => {
  try {
    const [assets] = await pool.promise().query(
      `
        SELECT ${ASSET_COLUMNS.join(', ')}
        FROM assets
        WHERE tenantId = ? AND isActive = TRUE
        ORDER BY createdAt DESC
      `,
      [req.user.tenantId]
    );
    const csv = buildAssetsCsv(assets);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="assets.csv"');

    return res.status(200).send(csv);
  } catch (error) {
    return sendDatabaseError(res, error, 'exporting');
  }
});

// GET /api/assets/:id
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.promise().query(
      `SELECT ${ASSET_COLUMNS.join(', ')} FROM assets WHERE id = ? AND tenantId = ? AND isActive = TRUE LIMIT 1`,
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
    const db = pool.promise();
    const assetLimit = await getTenantAssetLimit(db, req.user.tenantId);

    if (hasReachedAssetLimit(assetLimit)) {
      return res.status(403).json({
        success: false,
        message: 'Asset limit reached for current subscription plan',
        data: buildAssetLimitResponse(assetLimit)
      });
    }

    const assetTag = formatAssetTag(await getNextAssetTagSequence(db, req.user.tenantId));
    const asset = buildInsertAsset({
      ...req.body,
      tenantId: req.user.tenantId,
      assetTag,
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

    await db.query(
      insertSql,
      INSERT_COLUMNS.map((field) => asset[field])
    );

    const [rows] = await db.query(
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
    const updateSql = `UPDATE assets SET ${setSql} WHERE id = ? AND tenantId = ? AND isActive = TRUE`;
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
      `SELECT ${ASSET_COLUMNS.join(', ')} FROM assets WHERE id = ? AND tenantId = ? AND isActive = TRUE LIMIT 1`,
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
      'DELETE FROM assets WHERE id = ? AND tenantId = ? AND isActive = TRUE',
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
