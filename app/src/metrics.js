'use strict';
const client = require('prom-client');
const { pool } = require('./db');

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'portfolio_' });

const httpDuration = new client.Histogram({
  name: 'portfolio_http_request_duration_seconds',
  help: 'Thời gian xử lý request HTTP',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

const loginTotal = new client.Counter({
  name: 'portfolio_login_total',
  help: 'Số lần đăng nhập trang quản trị, chia theo kết quả',
  labelNames: ['result'],
  registers: [register],
});

new client.Gauge({
  name: 'portfolio_messages',
  help: 'Số tin nhắn liên hệ theo trạng thái',
  labelNames: ['state'],
  registers: [register],
  async collect() {
    const [[r]] = await pool.query(
      'SELECT SUM(read_at IS NULL) AS unread, SUM(read_at IS NOT NULL) AS seen FROM messages');
    this.set({ state: 'unread' }, Number(r.unread || 0));
    this.set({ state: 'read' }, Number(r.seen || 0));
  },
});

module.exports = { register, httpDuration, loginTotal };
