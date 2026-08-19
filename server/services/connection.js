const mysql = require('mysql2/promise');

let pool = null;

const connectDB = async () => {
  try {
    // Railway provides MYSQL_URL; local dev uses individual vars
    const dbUrl = process.env.MYSQL_URL || process.env.DATABASE_URL;

    const poolConfig = dbUrl
      ? { uri: dbUrl, waitForConnections: true, connectionLimit: 10, queueLimit: 0, enableKeepAlive: true, keepAliveInitialDelay: 10000, idleTimeout: 60000 }
      : {
          host: process.env.DB_HOST,
          port: process.env.DB_PORT || 3306,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0,
          enableKeepAlive: true,
          keepAliveInitialDelay: 10000,
          idleTimeout: 60000,
        };

    pool = mysql.createPool(poolConfig);

    // Test connection
    const connection = await pool.getConnection();
    console.log('✅ MySQL connected successfully');
    connection.release();
    
    return pool;
  } catch (error) {
    console.error('❌ MySQL connection failed:', error.message);
    throw error;
  }
};

const getPool = () => {
  if (!pool) {
    throw new Error('Database not initialized. Call connectDB first.');
  }
  return pool;
};

const query = async (sql, params) => {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const p = getPool();
      const [results] = await p.query(sql, params);
      return results;
    } catch (err) {
      const isConnectionError = ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(err.code)
        || (err.message && err.message.includes('Connection lost'));
      if (isConnectionError && attempt < maxRetries) {
        console.warn(`⚠️ DB connection error (attempt ${attempt}/${maxRetries}): ${err.code || err.message}. Reconnecting...`);
        try { await pool.end(); } catch {}
        pool = null;
        await connectDB();
        continue;
      }
      throw err;
    }
  }
};

module.exports = { connectDB, getPool, query };

