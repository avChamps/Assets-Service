const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const router = express.Router();

const DEFAULT_ALERT_WINDOW_DAYS = 30;
const MAX_ALERT_WINDOW_DAYS = 365;

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

function buildCards(stats) {
  return {
    totalAvAssets: [
      {
        key: 'totalAssets',
        title: 'Total assets',
        value: stats.assets.total,
        description: 'Across all categories'
      },
      {
        key: 'allocated',
        title: 'Allocated',
        value: stats.assets.allocated,
        description: 'Actively assigned units'
      },
      {
        key: 'maintenance',
        title: 'Maintenance',
        value: stats.assets.maintenance,
        description: 'Maintenance records'
      },
      {
        key: 'expiringWarranties',
        title: 'Expiring warranties',
        value: stats.assets.expiringWarranties,
        description: 'Within configured alert window'
      }
    ],
    assetValue: [
      {
        key: 'investment',
        title: 'Investment',
        value: stats.assetValue.investment,
        description: 'Total Equipment Cost'
      },
      {
        key: 'amcValue',
        title: 'AMC Value',
        value: stats.assetValue.amcValue,
        description: 'AMC Budget Overview'
      },
      {
        key: 'outOfWarranty',
        title: 'Out of Warranty',
        value: stats.assetValue.outOfWarranty,
        description: 'Devices not under warranty'
      },
      {
        key: 'hardwareRecycle',
        title: 'Hardware Recycle',
        value: stats.assetValue.hardwareRecycle,
        description: 'Ready for recycling'
      }
    ],
    users: [
      {
        key: 'allUsers',
        title: 'All users',
        value: stats.users.total,
        description: 'Total registered users'
      },
      {
        key: 'enabledUsers',
        title: 'Enabled users',
        value: stats.users.enabled,
        description: 'Currently enabled users'
      },
      {
        key: 'inactiveUsers',
        title: 'Inactive users',
        value: stats.users.inactive,
        description: 'Disabled or inactive users'
      }
    ],
    tickets: [
      {
        key: 'allTickets',
        title: 'All tickets',
        value: stats.tickets.total,
        description: 'Total tickets raised'
      },
      {
        key: 'openTickets',
        title: 'Open tickets',
        value: stats.tickets.opened,
        description: 'Currently open tickets'
      },
      {
        key: 'closedTickets',
        title: 'Closed tickets',
        value: stats.tickets.closed,
        description: 'Resolved tickets'
      },
      {
        key: 'pendingTickets',
        title: 'Pending tickets',
        value: stats.tickets.pending,
        description: 'Waiting for action'
      },
      {
        key: 'inProgressTickets',
        title: 'In-progress tickets',
        value: stats.tickets.inProgress,
        description: 'Work in progress'
      }
    ]
  };
}

function sendDatabaseError(res, error) {
  return res.status(500).json({
    success: false,
    message: 'Server error while fetching analytics',
    error: error.message
  });
}

router.use(authenticateToken);

// GET /api/analytics?alertWindowDays=30
router.get('/', async (req, res) => {
  try {
    const alertWindowDays = parseAlertWindowDays(req.query.alertWindowDays);
    const { tenantId } = req.user;
    const db = pool.promise();
    const warrantyDateSql = getWarrantyDateSql();

    const assetsSql = `
      SELECT
        COUNT(*) AS totalAssets,
        SUM(
          CASE
            WHEN NULLIF(TRIM(roomName), '') IS NOT NULL
            THEN 1 ELSE 0
          END
        ) AS allocatedAssets,
        COALESCE(SUM(COALESCE(quantity, 0) * COALESCE(unitPrice, 0)), 0) AS investment,
        SUM(
          CASE
            WHEN ${warrantyDateSql} BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
            THEN 1 ELSE 0
          END
        ) AS expiringWarranties,
        SUM(
          CASE
            WHEN ${warrantyDateSql} < CURDATE()
            THEN 1 ELSE 0
          END
        ) AS outOfWarranty
      FROM assets
      WHERE tenantId = ? AND isActive = TRUE
    `;
    const usersSql = `
      SELECT
        COUNT(*) AS totalUsers,
        SUM(CASE WHEN LOWER(status) = 'active' THEN 1 ELSE 0 END) AS enabledUsers,
        SUM(CASE WHEN LOWER(status) = 'active' THEN 0 ELSE 1 END) AS inactiveUsers
      FROM users
      WHERE tenantId = ?
    `;
    const ticketsSql = `
      SELECT
        COUNT(*) AS totalTickets,
        SUM(CASE WHEN status = 'Opened' THEN 1 ELSE 0 END) AS openedTickets,
        SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pendingTickets,
        SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) AS inProgressTickets,
        SUM(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END) AS closedTickets
      FROM tickts
      WHERE tenantId = ?
    `;
    const retiredInventorySql = `
      SELECT COUNT(*) AS hardwareRecycle
      FROM retiredInvertory
      WHERE tenantId = ?
    `;
    const maintenanceSql = `
      SELECT COUNT(*) AS maintenance
      FROM maintainance
      WHERE tenantId = ?
    `;

    const [[assetRows], [userRows], [ticketRows], [retiredRows], [maintenanceRows], amcValue] = await Promise.all([
      db.query(assetsSql, [alertWindowDays, tenantId]),
      db.query(usersSql, [tenantId]),
      db.query(ticketsSql, [tenantId]),
      db.query(retiredInventorySql, [tenantId]),
      db.query(maintenanceSql, [tenantId]),
      getTenantAmcValue(db, tenantId)
    ]);

    const stats = {
      assets: {
        total: numberValue(assetRows[0], 'totalAssets'),
        allocated: numberValue(assetRows[0], 'allocatedAssets'),
        maintenance: numberValue(maintenanceRows[0], 'maintenance'),
        expiringWarranties: numberValue(assetRows[0], 'expiringWarranties')
      },
      assetValue: {
        investment: numberValue(assetRows[0], 'investment'),
        amcValue: calculateAmcValue(numberValue(assetRows[0], 'investment'), amcValue),
        outOfWarranty: numberValue(assetRows[0], 'outOfWarranty'),
        hardwareRecycle: numberValue(retiredRows[0], 'hardwareRecycle')
      },
      users: {
        total: numberValue(userRows[0], 'totalUsers'),
        enabled: numberValue(userRows[0], 'enabledUsers'),
        inactive: numberValue(userRows[0], 'inactiveUsers')
      },
      tickets: {
        total: numberValue(ticketRows[0], 'totalTickets'),
        opened: numberValue(ticketRows[0], 'openedTickets'),
        pending: numberValue(ticketRows[0], 'pendingTickets'),
        inProgress: numberValue(ticketRows[0], 'inProgressTickets'),
        closed: numberValue(ticketRows[0], 'closedTickets')
      }
    };

    return res.status(200).json({
      success: true,
      message: 'Analytics fetched successfully',
      alertWindowDays,
      data: stats,
      cards: buildCards(stats)
    });
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

module.exports = router;
