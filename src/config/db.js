const mysql = require('mysql2');

const dbConfig = {
   host: '194.238.17.75',
  user: 'disendra',
  password: 'Bl@ckh0r5e@2025!',
  database: 'AssetManagement',
  dateStrings: ['DATE'],    // Return DATE columns as pure strings
  timezone: 'local'         // Prevent UTC conversion
};

const pool = mysql.createPool(dbConfig);
pool.on('connection', function (connection) {
  console.log('New connection established');

  connection.on('error', function (err) {
    console.error('MySQL error', err);
    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
      console.log('Attempting to reconnect...');
      pool.removeConnection(connection);
      const newConnection = mysql.createConnection(dbConfig);
      pool.addConnection(newConnection);
      newConnection.connect(function (error) {
        if (error) {
          console.error('Failed to reconnect:', error);
        } else {
          console.log('Reconnected successfully');
        }
      });
    } else {
      throw err;
    }
  });
});

module.exports = pool;