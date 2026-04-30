const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const router = express.Router();

const RENEWAL_PERIOD_DAYS = 365;

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

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value.slice(0, 10);
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  return null;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calculateDaysLeft(endDateString) {
  if (!endDateString) {
    return null;
  }

  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const endDate = new Date(`${endDateString}T00:00:00.000Z`);

  if (Number.isNaN(endDate.getTime())) {
    return null;
  }

  return Math.max(0, Math.ceil((endDate.getTime() - todayUtc) / 86400000));
}

async function getTableColumns(db, tableName) {
  const [rows] = await db.query(`SHOW COLUMNS FROM ${tableName}`);
  return new Set(rows.map((row) => row.Field));
}

function selectColumn(columns, tableAlias, columnName, alias = columnName) {
  return columns.has(columnName)
    ? `${tableAlias}.${columnName} AS ${alias}`
    : `NULL AS ${alias}`;
}

function selectFirstColumn(columns, tableAlias, columnNames, alias) {
  const columnName = columnNames.find((name) => columns.has(name));
  return columnName ? `${tableAlias}.${columnName} AS ${alias}` : `NULL AS ${alias}`;
}

function mapCountRows(rows, key) {
  return rows.map((row) => ({
    [key]: row.name,
    name: row.name,
    assetCount: Number(row.assetCount || 0)
  }));
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

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function addUpdate(updates, values, columns, columnName, value) {
  if (!columns.has(columnName) || value === undefined) {
    return;
  }

  updates.push(`${columnName} = ?`);
  values.push(cleanText(value));
}

router.use(authenticateToken);

// GET /api/settings
router.get('/', async (req, res) => {
  try {
    const db = pool.promise();
    const [userColumns, tenantColumns] = await Promise.all([
      getTableColumns(db, 'users'),
      getTableColumns(db, 'tenants')
    ]);

    const userSelect = [
      selectColumn(userColumns, 'u', 'userId'),
      selectColumn(userColumns, 'u', 'tenantId'),
      selectColumn(userColumns, 'u', 'fullName'),
      selectColumn(userColumns, 'u', 'workEmail'),
      selectColumn(userColumns, 'u', 'phoneNumber'),
      selectColumn(userColumns, 'u', 'jobTitle'),
      selectColumn(userColumns, 'u', 'location')
    ];

    const tenantSelect = [
      selectColumn(tenantColumns, 't', 'companyName'),
      selectColumn(tenantColumns, 't', 'companyDomain'),
      selectColumn(tenantColumns, 't', 'companySize'),
      selectColumn(tenantColumns, 't', 'expectedAssets'),
      selectColumn(tenantColumns, 't', 'subscriptionType'),
      selectFirstColumn(tenantColumns, 't', ['addressLine1', 'address1', 'address'], 'addressLine1'),
      selectFirstColumn(tenantColumns, 't', ['addressLine2', 'address2'], 'addressLine2'),
      selectFirstColumn(tenantColumns, 't', ['subscriptionStartDate', 'subscriptionStart', 'startDate', 'createdAt'], 'subscriptionStartDate'),
      selectFirstColumn(tenantColumns, 't', ['subscriptionEndDate', 'subscriptionEnd', 'renewalDate', 'nextRenewalDate'], 'subscriptionEndDate')
    ];

    const [profileRows] = await db.query(
      `
        SELECT
          ${[...userSelect, ...tenantSelect].join(',\n          ')}
        FROM users u
        INNER JOIN tenants t ON t.tenantId = u.tenantId
        WHERE u.userId = ? AND u.tenantId = ?
        LIMIT 1
      `,
      [req.user.userId, req.user.tenantId]
    );

    if (!profileRows.length) {
      return res.status(404).json({
        success: false,
        message: 'Settings profile not found for this user'
      });
    }

    const profile = profileRows[0];
    const subscriptionStartDate = normalizeDate(profile.subscriptionStartDate);
    const subscriptionEndDate = normalizeDate(profile.subscriptionEndDate)
      || (subscriptionStartDate ? addDays(subscriptionStartDate, RENEWAL_PERIOD_DAYS) : null);

    const regionsSql = `
      SELECT TRIM(country) AS name, COUNT(*) AS assetCount
      FROM assets
      WHERE tenantId = ? AND isActive = TRUE AND country IS NOT NULL AND TRIM(country) <> ''
      GROUP BY TRIM(country)
      ORDER BY TRIM(country) ASC
    `;
    const locationsSql = `
      SELECT TRIM(location) AS name, COUNT(*) AS assetCount
      FROM assets
      WHERE tenantId = ? AND isActive = TRUE AND location IS NOT NULL AND TRIM(location) <> ''
      GROUP BY TRIM(location)
      ORDER BY TRIM(location) ASC
    `;
    const totalsSql = `
      SELECT
        COUNT(*) AS totalAssets,
        COUNT(DISTINCT NULLIF(TRIM(country), '')) AS totalRegions,
        COUNT(DISTINCT NULLIF(TRIM(location), '')) AS totalLocations
      FROM assets
      WHERE tenantId = ? AND isActive = TRUE
    `;

    const [[regionRows], [locationRows], [totalRows]] = await Promise.all([
      db.query(regionsSql, [req.user.tenantId]),
      db.query(locationsSql, [req.user.tenantId]),
      db.query(totalsSql, [req.user.tenantId])
    ]);

    const totals = totalRows[0] || {};

    return res.status(200).json({
      success: true,
      message: 'Settings fetched successfully',
      data: {
        aboutCompany: {
          companyName: profile.companyName || null,
          addressLine1: profile.addressLine1 || null,
          addressLine2: profile.addressLine2 || null,
          contactName: profile.fullName || null,
          mobileNumber: profile.phoneNumber || null,
          emailId: profile.workEmail || null
        },
        personalData: {
          userId: profile.userId,
          tenantId: profile.tenantId,
          fullName: profile.fullName || null,
          workEmail: profile.workEmail || null,
          phoneNumber: profile.phoneNumber || null,
          jobTitle: profile.jobTitle || null,
          location: profile.location || null
        },
        subscriptionManagement: {
          subscriptionStartDate,
          subscriptionEndDate,
          daysLeftForRenewal: calculateDaysLeft(subscriptionEndDate),
          currentPlan: profile.subscriptionType || null,
          companyDomain: profile.companyDomain || null,
          companySize: profile.companySize || null,
          expectedAssets: profile.expectedAssets || null
        },
        assetsSummary: {
          totalAssets: Number(totals.totalAssets || 0),
          totalRegions: Number(totals.totalRegions || 0),
          totalLocations: Number(totals.totalLocations || 0)
        },
        regions: mapCountRows(regionRows, 'region'),
        locations: mapCountRows(locationRows, 'location')
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching settings',
      error: error.message
    });
  }
});

// PUT /api/settings
router.put('/', async (req, res) => {
  const db = pool.promise();
  let connection;

  try {
    const body = req.body || {};
    const aboutCompany = body.aboutCompany || {};
    const personalData = body.personalData || {};
    const subscriptionManagement = body.subscriptionManagement || {};

    const fullName = firstDefined(personalData.fullName, aboutCompany.contactName);
    const workEmail = firstDefined(personalData.workEmail, aboutCompany.emailId);
    const phoneNumber = firstDefined(personalData.phoneNumber, aboutCompany.mobileNumber);

    if (workEmail !== undefined && !cleanText(workEmail)) {
      return res.status(400).json({
        success: false,
        message: 'workEmail cannot be empty'
      });
    }

    if (fullName !== undefined && !cleanText(fullName)) {
      return res.status(400).json({
        success: false,
        message: 'fullName cannot be empty'
      });
    }

    const [userColumns, tenantColumns] = await Promise.all([
      getTableColumns(db, 'users'),
      getTableColumns(db, 'tenants')
    ]);

    const userUpdates = [];
    const userValues = [];
    addUpdate(userUpdates, userValues, userColumns, 'fullName', fullName);
    addUpdate(userUpdates, userValues, userColumns, 'workEmail', workEmail);
    addUpdate(userUpdates, userValues, userColumns, 'phoneNumber', phoneNumber);
    addUpdate(userUpdates, userValues, userColumns, 'jobTitle', personalData.jobTitle);
    addUpdate(userUpdates, userValues, userColumns, 'location', personalData.location);

    const tenantUpdates = [];
    const tenantValues = [];
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'companyName', aboutCompany.companyName);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'companyDomain', subscriptionManagement.companyDomain);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'companySize', subscriptionManagement.companySize);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'expectedAssets', subscriptionManagement.expectedAssets);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'subscriptionType', subscriptionManagement.currentPlan);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'subscriptionStartDate', subscriptionManagement.subscriptionStartDate);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'subscriptionEndDate', subscriptionManagement.subscriptionEndDate);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'addressLine1', aboutCompany.addressLine1);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'address1', aboutCompany.addressLine1);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'address', aboutCompany.addressLine1);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'addressLine2', aboutCompany.addressLine2);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'address2', aboutCompany.addressLine2);

    if (!userUpdates.length && !tenantUpdates.length) {
      return res.status(400).json({
        success: false,
        message: 'No valid settings fields provided for update'
      });
    }

    addUpdate(userUpdates, userValues, userColumns, 'updatedBy', req.user.userId);
    addUpdate(tenantUpdates, tenantValues, tenantColumns, 'updatedBy', req.user.userId);

    connection = await db.getConnection();
    await connection.beginTransaction();

    if (workEmail !== undefined) {
      const [emailRows] = await connection.query(
        'SELECT userId FROM users WHERE workEmail = ? AND userId <> ? LIMIT 1',
        [cleanText(workEmail), req.user.userId]
      );

      if (emailRows.length) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          message: 'Another user already exists with this workEmail'
        });
      }
    }

    if (userUpdates.length) {
      await connection.query(
        `UPDATE users SET ${userUpdates.join(', ')} WHERE userId = ? AND tenantId = ?`,
        [...userValues, req.user.userId, req.user.tenantId]
      );
    }

    if (tenantUpdates.length) {
      await connection.query(
        `UPDATE tenants SET ${tenantUpdates.join(', ')} WHERE tenantId = ?`,
        [...tenantValues, req.user.tenantId]
      );
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: 'Settings updated successfully'
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    return res.status(500).json({
      success: false,
      message: 'Server error while updating settings',
      error: error.message
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

module.exports = router;
