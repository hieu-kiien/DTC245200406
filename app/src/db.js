'use strict';
const mysql = require('mysql2/promise');
const log = require('./log');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 5000,
  dateStrings: false,
});

async function waitForDb(tries = 40) {
  for (let i = 1; i <= tries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      log.warn('db_wait', { attempt: i, msg: err.message });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('Không kết nối được cơ sở dữ liệu');
}

module.exports = { pool, waitForDb };
