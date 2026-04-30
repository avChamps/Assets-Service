const express = require('express');
const pool = require('../config/db');

const router = express.Router();

const ALLOWED_OPERATIONS = new Set([
  'CREATE',
  'ALTER',
  'SELECT',
  'TRUNCATE',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'DESC',
  'DESCRIBE',
  'SHOW',
]);

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
    return 'This SQL operation is not allowed';
  }

  return null;
}

router.post('/execute', async (req, res) => {
  try {
    const { query } = req.body;

    const validationError = validateQuery(query);
    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const sql = normalizeSql(query);
    const operation = getSqlOperation(sql);

    const db = pool.promise();
    const [result] = await db.query(sql);

    return res.status(200).json({
      success: true,
      message: 'Query executed successfully',
      results: [
        {
          operation,
          data: Array.isArray(result) ? result : undefined,
          affectedRows: result?.affectedRows,
          insertId: result?.insertId,
          changedRows: result?.changedRows,
        },
      ],
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while executing SQL query',
      error: error.message,
    });
  }
});

module.exports = router;