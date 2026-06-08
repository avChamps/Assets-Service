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
  'SET',
  'PREPARE',
  'EXECUTE',
  'DEALLOCATE'
]);

function normalizeSql(sql) {
  return sql.trim().replace(/;+\s*$/, '');
}

function getSqlOperation(sql) {
  const match = sql.match(/^\s*(\w+)/);
  return match ? match[1].toUpperCase() : '';
}

function splitSqlStatements(sql) {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function validateSingleStatement(sql) {
  const operation = getSqlOperation(sql);

  if (!ALLOWED_OPERATIONS.has(operation)) {
    return `SQL operation "${operation}" is not allowed`;
  }

  return null;
}

function validateQuery(sql) {
  if (!sql || typeof sql !== 'string') {
    return 'query is required and must be a string';
  }

  const statements = splitSqlStatements(sql);

  if (!statements.length) {
    return 'query is required and must be a valid SQL statement';
  }

  for (const statement of statements) {
    const error = validateSingleStatement(statement);
    if (error) return error;
  }

  return null;
}

router.post('/execute', async (req, res) => {
  let connection;

  try {
    const { query } = req.body;

    const validationError = validateQuery(query);
    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const statements = splitSqlStatements(query);

    connection = await pool.promise().getConnection();

    const results = [];

    for (const statement of statements) {
      const sql = normalizeSql(statement);
      const operation = getSqlOperation(sql);

      const [result] = await connection.query(sql);

      results.push({
        operation,
        data: Array.isArray(result) ? result : undefined,
        affectedRows: result?.affectedRows,
        insertId: result?.insertId,
        changedRows: result?.changedRows,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Query executed successfully',
      results,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while executing SQL query',
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;