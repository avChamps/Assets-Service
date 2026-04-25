require('dotenv').config();

const mysql = require('mysql2/promise');

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  multipleStatements: false
};

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `
      SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [dbConfig.database, tableName, columnName]
  );

  return rows.length > 0;
}

async function indexExists(connection, tableName, indexName) {
  const [rows] = await connection.query(
    `
      SELECT 1
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1
    `,
    [dbConfig.database, tableName, indexName]
  );

  return rows.length > 0;
}

async function constraintExists(connection, tableName, constraintName) {
  const [rows] = await connection.query(
    `
      SELECT 1
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ?
      LIMIT 1
    `,
    [dbConfig.database, tableName, constraintName]
  );

  return rows.length > 0;
}

async function main() {
  for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME']) {
    if (!process.env[key]) {
      throw new Error(`${key} is required`);
    }
  }

  const connection = await mysql.createConnection(dbConfig);

  try {
    if (!(await columnExists(connection, 'tickts', 'createdBy'))) {
      await connection.query('ALTER TABLE tickts ADD COLUMN createdBy VARCHAR(36) NULL AFTER status');
      console.log('Added tickts.createdBy');
    } else {
      console.log('tickts.createdBy already exists');
    }

    await connection.query('UPDATE tickts SET createdBy = updatedBy WHERE createdBy IS NULL');
    console.log('Backfilled tickts.createdBy from updatedBy where needed');

    await connection.query('ALTER TABLE tickts MODIFY createdBy VARCHAR(36) NOT NULL');
    console.log('Set tickts.createdBy to NOT NULL');

    if (!(await indexExists(connection, 'tickts', 'idx_tickts_createdBy'))) {
      await connection.query('ALTER TABLE tickts ADD INDEX idx_tickts_createdBy (createdBy)');
      console.log('Added idx_tickts_createdBy');
    } else {
      console.log('idx_tickts_createdBy already exists');
    }

    if (!(await constraintExists(connection, 'tickts', 'fk_tickts_createdBy'))) {
      await connection.query(`
        ALTER TABLE tickts
        ADD CONSTRAINT fk_tickts_createdBy
          FOREIGN KEY (createdBy) REFERENCES users(userId)
      `);
      console.log('Added fk_tickts_createdBy');
    } else {
      console.log('fk_tickts_createdBy already exists');
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
