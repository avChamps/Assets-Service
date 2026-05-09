const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

const NOTIFICATION_COLUMNS = [
  'notificationId',
  'tenantId',
  'userId',
  'title',
  'message',
  'type',
  'linkUrl',
  'entityType',
  'entityId',
  'isRead',
  'readAt',
  'createdBy',
  'createdAt',
  'updatedAt'
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
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function isMissing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function mapNotification(row) {
  return {
    ...NOTIFICATION_COLUMNS.reduce((payload, column) => {
      payload[column] = row[column];
      return payload;
    }, {}),
    isRead: Boolean(row.isRead)
  };
}

function buildListFilters(query, tenantId, userId) {
  const conditions = ['tenantId = ?', '(userId = ? OR userId IS NULL)'];
  const params = [tenantId, userId];
  const search = cleanText(query.search);
  const type = cleanText(query.type);
  const unreadOnly = String(query.unreadOnly || '').toLowerCase() === 'true';

  if (!isMissing(type)) {
    conditions.push('type = ?');
    params.push(type);
  }

  if (unreadOnly) {
    conditions.push('isRead = 0');
  }

  if (!isMissing(search)) {
    conditions.push('(title LIKE ? OR message LIKE ? OR type LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params
  };
}

async function findNotification(db, notificationId, tenantId, userId) {
  const [rows] = await db.query(
    `
      SELECT ${NOTIFICATION_COLUMNS.join(', ')}
      FROM notifications
      WHERE notificationId = ?
        AND tenantId = ?
        AND (userId = ? OR userId IS NULL)
      LIMIT 1
    `,
    [notificationId, tenantId, userId]
  );

  return rows[0] ? mapNotification(rows[0]) : null;
}

async function ensureTenantUserExists(db, userId, tenantId) {
  if (!userId) {
    return true;
  }

  const [rows] = await db.query(
    'SELECT userId FROM users WHERE userId = ? AND tenantId = ? LIMIT 1',
    [userId, tenantId]
  );

  return rows.length > 0;
}

router.use(authenticateToken);

// GET /api/notifications
router.get('/', async (req, res) => {
  try {
    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const limit = Math.min(parsePositiveInteger(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
    const offset = (page - 1) * limit;
    const db = pool.promise();
    const { whereSql, params } = buildListFilters(req.query, req.user.tenantId, req.user.userId);

    const countSql = `SELECT COUNT(*) AS total FROM notifications ${whereSql}`;
    const unreadCountSql = `
      SELECT COUNT(*) AS unreadCount
      FROM notifications
      WHERE tenantId = ?
        AND (userId = ? OR userId IS NULL)
        AND isRead = 0
    `;
    const listSql = `
      SELECT ${NOTIFICATION_COLUMNS.join(', ')}
      FROM notifications
      ${whereSql}
      ORDER BY createdAt DESC, id DESC
      LIMIT ? OFFSET ?
    `;

    const [[countRows], [unreadRows], [rows]] = await Promise.all([
      db.query(countSql, params),
      db.query(unreadCountSql, [req.user.tenantId, req.user.userId]),
      db.query(listSql, [...params, limit, offset])
    ]);

    const total = Number(countRows[0]?.total || 0);

    return res.json({
      success: true,
      data: rows.map(mapNotification),
      unreadCount: Number(unreadRows[0]?.unreadCount || 0),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching notifications'
    });
  }
});

// POST /api/notifications
router.post('/', async (req, res) => {
  try {
    const title = cleanText(req.body.title);
    const message = cleanText(req.body.message);
    const type = cleanText(req.body.type) || 'general';
    const userId = cleanText(req.body.userId);
    const linkUrl = cleanText(req.body.linkUrl);
    const entityType = cleanText(req.body.entityType);
    const entityId = cleanText(req.body.entityId);

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: 'title and message are required'
      });
    }

    const db = pool.promise();
    const userExists = await ensureTenantUserExists(db, userId, req.user.tenantId);

    if (!userExists) {
      return res.status(400).json({
        success: false,
        message: 'Notification user does not exist for this tenant'
      });
    }

    const notificationId = uuidv4();

    await db.query(
      `
        INSERT INTO notifications (
          notificationId,
          tenantId,
          userId,
          title,
          message,
          type,
          linkUrl,
          entityType,
          entityId,
          createdBy
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        notificationId,
        req.user.tenantId,
        userId,
        title,
        message,
        type,
        linkUrl,
        entityType,
        entityId,
        req.user.userId
      ]
    );

    const notification = await findNotification(db, notificationId, req.user.tenantId, req.user.userId);

    return res.status(201).json({
      success: true,
      message: 'Notification created successfully',
      data: notification
    });
  } catch (error) {
    console.error('Error creating notification:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while creating notification'
    });
  }
});

// PATCH /api/notifications/read-all
router.patch(['/read-all', '/readall', '/readAll'], async (req, res) => {
  try {
    const [result] = await pool.promise().query(
      `
        UPDATE notifications
        SET isRead = 1,
            readAt = COALESCE(readAt, CURRENT_TIMESTAMP)
        WHERE tenantId = ?
          AND (userId = ? OR userId IS NULL)
          AND isRead = 0
      `,
      [req.user.tenantId, req.user.userId]
    );

    return res.json({
      success: true,
      message: 'All notifications marked as read',
      updatedCount: result.affectedRows
    });
  } catch (error) {
    console.error('Error marking notifications as read:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while marking notifications as read'
    });
  }
});

// PATCH /api/notifications/:notificationId/read
router.patch('/:notificationId/read', async (req, res) => {
  try {
    const db = pool.promise();
    const [result] = await db.query(
      `
        UPDATE notifications
        SET isRead = 1,
            readAt = COALESCE(readAt, CURRENT_TIMESTAMP)
        WHERE notificationId = ?
          AND tenantId = ?
          AND (userId = ? OR userId IS NULL)
      `,
      [req.params.notificationId, req.user.tenantId, req.user.userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    const notification = await findNotification(
      db,
      req.params.notificationId,
      req.user.tenantId,
      req.user.userId
    );

    return res.json({
      success: true,
      message: 'Notification marked as read',
      data: notification
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while marking notification as read'
    });
  }
});

// PATCH /api/notifications/:notificationId/unread
router.patch('/:notificationId/unread', async (req, res) => {
  try {
    const db = pool.promise();
    const [result] = await db.query(
      `
        UPDATE notifications
        SET isRead = 0,
            readAt = NULL
        WHERE notificationId = ?
          AND tenantId = ?
          AND (userId = ? OR userId IS NULL)
      `,
      [req.params.notificationId, req.user.tenantId, req.user.userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    const notification = await findNotification(
      db,
      req.params.notificationId,
      req.user.tenantId,
      req.user.userId
    );

    return res.json({
      success: true,
      message: 'Notification marked as unread',
      data: notification
    });
  } catch (error) {
    console.error('Error marking notification as unread:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while marking notification as unread'
    });
  }
});

// PUT /api/notifications/:notificationId
router.put('/:notificationId', async (req, res) => {
  try {
    const allowedFields = ['title', 'message', 'type', 'linkUrl', 'entityType', 'entityId', 'userId'];
    const updates = [];
    const values = [];
    const db = pool.promise();

    if (Object.prototype.hasOwnProperty.call(req.body, 'userId')) {
      const userId = cleanText(req.body.userId);
      const userExists = await ensureTenantUserExists(db, userId, req.user.tenantId);

      if (!userExists) {
        return res.status(400).json({
          success: false,
          message: 'Notification user does not exist for this tenant'
        });
      }
    }

    allowedFields.forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(req.body, field)) {
        return;
      }

      const value = cleanText(req.body[field]);

      if ((field === 'title' || field === 'message' || field === 'type') && !value) {
        return;
      }

      updates.push(`${field} = ?`);
      values.push(value);
    });

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid notification fields provided for update'
      });
    }

    const [result] = await db.query(
      `
        UPDATE notifications
        SET ${updates.join(', ')}
        WHERE notificationId = ?
          AND tenantId = ?
          AND (userId = ? OR userId IS NULL)
      `,
      [...values, req.params.notificationId, req.user.tenantId, req.user.userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    const notification = await findNotification(
      db,
      req.params.notificationId,
      req.user.tenantId,
      req.user.userId
    );

    return res.json({
      success: true,
      message: 'Notification updated successfully',
      data: notification
    });
  } catch (error) {
    console.error('Error updating notification:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while updating notification'
    });
  }
});

// DELETE /api/notifications/:notificationId
router.delete('/:notificationId', async (req, res) => {
  try {
    const [result] = await pool.promise().query(
      `
        DELETE FROM notifications
        WHERE notificationId = ?
          AND tenantId = ?
          AND (userId = ? OR userId IS NULL)
      `,
      [req.params.notificationId, req.user.tenantId, req.user.userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    return res.json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting notification:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while deleting notification'
    });
  }
});

module.exports = router;
