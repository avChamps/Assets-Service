const express = require('express');
const pool = require('../config/db');

const router = express.Router();

const ALLOWED_OPERATIONS = new Set(['CREATE','ALTER','SELECT', 'TRUNCATE','INSERT', 'UPDATE', 'DELETE','DROP']);

function normalizeSql(sql) {
  return sql.trim().replace(/;+\s*$/, '');
}

function getSqlOperation(sql) {
  const match = sql.match(/^\s*(\w+)/);
  return match ? match[1].toUpperCase() : '';
}

function hasMultipleStatements(sql) {
  return /;.+\S/s.test(sql);
}

function validateQuery(sql) {
  if (!sql || typeof sql !== 'string') {
    return 'query is required and must be a string';
  }

  if (hasMultipleStatements(sql)) {
    return 'Only one SQL statement is allowed per request';
  }

  const operation = getSqlOperation(sql);
  if (!ALLOWED_OPERATIONS.has(operation)) {
    return 'Only SELECT, INSERT, UPDATE and DELETE statements are allowed';
  }

  return null;
}

// POST /api/query/execute
router.post('/execute', async (req, res) => {
  try {
    const { query } = req.body;
    const validationError = validateQuery(query);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError
      });
    }

    const sql = normalizeSql(query);
    const operation = getSqlOperation(sql);
    const [result] = await pool.promise().query(sql);

    return res.status(200).json({
      success: true,
      message: 'SQL query executed successfully',
      operation,
      data: operation === 'SELECT' ? result : undefined,
      affectedRows: result.affectedRows,
      insertId: result.insertId,
      changedRows: result.changedRows
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while executing SQL query',
      error: error.message
    });
  }
});

module.exports = router;
