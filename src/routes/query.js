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


router.post('/execute', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        message: 'Query is required'
      });
    }

    // Split multiple statements
    const queries = query
      .split(';')
      .map(q => q.trim())
      .filter(q => q.length > 0);

    const results = [];
    const db = pool.promise();

    for (const q of queries) {
      const validationError = validateQuery(q);
      if (validationError) {
        return res.status(400).json({
          success: false,
          message: validationError
        });
      }

      const sql = normalizeSql(q);
      const operation = getSqlOperation(sql);

      const [result] = await db.query(sql);

      results.push({
        operation,
        data: operation === 'SELECT' ? result : undefined,
        affectedRows: result.affectedRows,
        insertId: result.insertId,
        changedRows: result.changedRows
      });
    }

    return res.status(200).json({
      success: true,
      message: 'All queries executed successfully',
      results
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
