const express = require('express');
const pool = require('../config/db');

const router = express.Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// GET /api/assets/list?page=1&limit=10&tenantId=<tenant-id>
router.get('/list', async (req, res) => {
  try {
    const page = parsePositiveInteger(req.query.page, DEFAULT_PAGE);
    const requestedLimit = parsePositiveInteger(req.query.limit, DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const { tenantId } = req.query;

    const whereClauses = [];
    const params = [];

    if (tenantId) {
      whereClauses.push('tenantId = ?');
      params.push(tenantId);
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*) AS total FROM assets ${whereSql}`;
    const [countRows] = await pool.promise().query(countSql, params);
    const totalRecords = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    const listSql = `
      SELECT
        id,
        country,
        location,
        building,
        roomName,
        floorNumber,
        pax,
        assetType,
        assetName,
        make,
        model,
        serialNo,
        quantity,
        ipAddress,
        macAddress,
        vlan,
        warranty,
        poNumber,
        vendorName,
        invoiceNumber,
        unitPrice,
        tenantId,
        createdBy,
        updatedBy,
        createdAt,
        updatedAt
      FROM assets
      ${whereSql}
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?
    `;

    const [assets] = await pool.promise().query(listSql, [...params, limit, offset]);

    return res.status(200).json({
      success: true,
      message: 'Assets fetched successfully',
      data: assets,
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
      message: 'Server error while fetching assets',
      error: error.message
    });
  }
});

module.exports = router;
