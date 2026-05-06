const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const uploadToVPS = require('../config/file-upload');
const { logAuditEvent } = require('../utils/auditLogger');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const UPLOAD_FIELD_NAME = 'file';
const tempUploadDir = path.join(os.tmpdir(), 'assets-service-documents');

fs.mkdirSync(tempUploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: tempUploadDir,
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname);
    callback(null, `${Date.now()}-${uuidv4()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_DOCUMENT_BYTES,
    files: 1
  }
});

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

function buildDocumentFilters(query, tenantId) {
  const conditions = ['d.tenantId = ?'];
  const params = [tenantId];
  const type = cleanText(query.type);
  const search = cleanText(query.search);

  if (type) {
    conditions.push('d.type = ?');
    params.push(type);
  }

  if (search) {
    const searchLike = `%${search}%`;
    conditions.push('(d.filename LIKE ? OR d.imageUrl LIKE ? OR d.documentId LIKE ? OR d.type LIKE ? OR d.uploadedBy LIKE ? OR u.fullName LIKE ?)');
    params.push(searchLike, searchLike, searchLike, searchLike, searchLike, searchLike);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

function normalizeFilename(filename) {
  const extension = path.extname(filename);
  const basename = path.basename(filename, extension);
  const safeBasename = basename
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'document';

  return `${Date.now()}-${uuidv4()}-${safeBasename}${extension}`;
}

function cleanupLocalFile(file) {
  if (!file?.path) {
    return;
  }

  fs.promises.unlink(file.path).catch(() => {});
}

function handleMulterUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single(UPLOAD_FIELD_NAME)(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

router.use(authenticateToken);

async function getDocumentImages(req, res) {
  try {
    const requestedTenantId = cleanText(req.query.tenantId);

    if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
      return res.status(403).json({
        success: false,
        message: 'You can only access documents for your tenant'
      });
    }

    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const { whereSql, params } = buildDocumentFilters(req.query, req.user.tenantId);
    const db = pool.promise();

    const countSql = `
      SELECT COUNT(*) AS total
      FROM documents d
      LEFT JOIN users u ON u.userId = d.uploadedBy AND u.tenantId = d.tenantId
      ${whereSql}
    `;
    const listSql = `
  SELECT
    d.id,
    d.userId,
    d.tenantId,
    d.fileName,
    d.imageUrl,
    d.documentId,
    d.type,
    d.uploadedBy AS uploadedById,
    COALESCE(u.fullName, d.uploadedBy) AS uploadedBy,
    d.uploadedAt
  FROM documents d
  LEFT JOIN users u 
    ON u.userId = d.uploadedBy 
    AND u.tenantId = d.tenantId
  ${whereSql}
  ORDER BY d.uploadedAt DESC, d.id DESC
  LIMIT ? OFFSET ?
`;
    const [[countRows], [documents]] = await Promise.all([
      db.query(countSql, params),
      db.query(listSql, [...params, limit, offset])
    ]);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    return res.status(200).json({
      success: true,
      message: 'Document images fetched successfully',
      data: documents,
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
      message: 'Unable to fetch document images',
      error: error.message
    });
  }
}

router.get('/', getDocumentImages);
router.get('/images', getDocumentImages);

router.post('/upload', async (req, res) => {
  try {
    await handleMulterUpload(req, res);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: `Document file is required in '${UPLOAD_FIELD_NAME}' field`
      });
    }

    const type = cleanText(req.body.type);

    if (!type) {
      cleanupLocalFile(req.file);
      return res.status(400).json({
        success: false,
        message: 'Document type is required'
      });
    }

    const documentId = cleanText(req.body.documentId) || uuidv4();
    const remoteFilename = normalizeFilename(req.file.originalname);
    const remoteFolder = `assets-Images/${req.user.tenantId}`;
    const imageUrl = await uploadToVPS(req.file.path, remoteFilename, remoteFolder);

    cleanupLocalFile(req.file);

    const [result] = await pool.promise().query(
      `
       INSERT INTO documents (
  userId,
  tenantId,
  fileName,
  imageUrl,
  documentId,
  type,
  uploadedBy
) VALUES (?, ?, ?, ?, ?, ?, ?);
      `,
      [
        req.user.userId,
        req.user.tenantId,
        req.file.originalname,
        imageUrl,
        documentId,
        type,
        req.user.userId
      ]
    );

    const [rows] = await pool.promise().query(
      `
        SELECT
          d.id, d.userId, d.tenantId, d.filename, d.imageUrl, d.documentId, d.type,
          d.uploadedBy AS uploadedById,
          COALESCE(u.fullName, d.uploadedBy) AS uploadedBy,
          d.uploadedAt
        FROM documents d
        LEFT JOIN users u ON u.userId = d.uploadedBy AND u.tenantId = d.tenantId
        WHERE d.id = ? AND d.tenantId = ?
        LIMIT 1
      `,
      [result.insertId, req.user.tenantId]
    );

    await logAuditEvent({
      req,
      action: 'document.upload',
      entityType: 'document',
      entityId: documentId,
      entityLabel: req.file.originalname,
      metadata: {
        databaseId: result.insertId,
        type,
        imageUrl,
        size: req.file.size
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Document uploaded successfully',
      data: rows[0]
    });
  } catch (error) {
    cleanupLocalFile(req.file);

    if (error instanceof multer.MulterError) {
      return res.status(400).json({
        success: false,
        message: error.code === 'LIMIT_FILE_SIZE'
          ? 'Document file is too large'
          : 'Invalid document upload',
        error: error.message
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Unable to upload document',
      error: error.message
    });
  }
});

module.exports = router;
