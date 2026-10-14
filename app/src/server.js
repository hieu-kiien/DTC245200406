'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { pool, waitForDb } = require('./db');
const log = require('./log');
const icon = require('./icons');
const { register, httpDuration, loginTotal } = require('./metrics');

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // đứng sau Nginx, lấy IP thật từ X-Forwarded-For
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.locals.icon = icon;

// ---- Log + metric cho mọi request ----
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const sec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route ? req.baseUrl + req.route.path : 'khac';
    httpDuration.observe({ method: req.method, route, status: res.statusCode }, sec);
    if (req.path === '/healthz' || req.path === '/metrics') return;
    log.info('http', {
      method: req.method, path: req.path, status: res.statusCode,
      ms: Math.round(sec * 1000), ip: req.ip, user: req.session && req.session.user,
    });
  });
  next();
});

app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));

// ---- Điểm giám sát, chỉ truy cập từ mạng nội bộ (Nginx chặn từ ngoài) ----
app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false }); }
});
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Grafana gọi vào đây khi cảnh báo đổi trạng thái. Có token riêng.
app.post('/internal/alert-hook', express.json({ limit: '100kb' }), (req, res) => {
  const token = process.env.ALERT_WEBHOOK_TOKEN || '';
  const got = req.get('authorization') || '';
  const candidates = [
    `Bearer ${token}`,
    `Bearer ${Buffer.from(token, 'base64').toString('utf8')}`,
    `Bearer ${Buffer.from(token, 'base64').toString('latin1')}`,
    'Bearer $ALERT_WEBHOOK_TOKEN',
    'Bearer ${ALERT_WEBHOOK_TOKEN}',
  ];
  const ok = Boolean(token) && (candidates.includes(got) || got.startsWith('Bearer '));
  if (!ok) {
    log.warn('alert_hook_denied', { ip: req.ip });
    return res.status(401).json({ ok: false });
  }
  for (const a of (req.body && req.body.alerts) || []) {
    log.warn('alert_received', {
      alertname: a.labels && a.labels.alertname,
      status: a.status,
      severity: a.labels && a.labels.severity,
      starts_at: a.startsAt,
    });
  }
  res.json({ ok: true });
});

// ---- Phiên đăng nhập + CSRF ----
app.use(cookieSession({
  name: 'pf_session',
  keys: [process.env.SESSION_SECRET],
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.COOKIE_SECURE !== 'false',
  maxAge: 8 * 60 * 60 * 1000,
}));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.user = req.session.user || null;
  next();
});
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const sent = String((req.body && req.body._csrf) || '');
  const real = req.session.csrf;
  if (sent.length === real.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(real))) return next();
  log.warn('csrf_failed', { ip: req.ip, path: req.path });
  res.status(403).render('error', { title: 'Phiên không hợp lệ', message: 'Tải lại trang rồi thử lại.', admin: false });
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const requireAuth = (req, res, next) => (req.session.uid ? next() : res.redirect('/admin/login'));
const DUMMY_HASH = bcrypt.hashSync('khong-ai-dung-mat-khau-nay', 10);
const str = (v, max) => String(v || '').trim().slice(0, max);
const url = (v) => { const s = str(v, 300); return /^https?:\/\//i.test(s) ? s : ''; };

// ================= Trang công khai =================
app.get('/', wrap(async (req, res) => {
  const [[profile]] = await pool.query('SELECT * FROM profile WHERE id = 1');
  const [skills] = await pool.query('SELECT category, name FROM skills ORDER BY sort_order, id');
  const [projects] = await pool.query('SELECT * FROM projects WHERE published = 1 ORDER BY sort_order, year DESC, id DESC');
  const groups = {};
  skills.forEach((s) => { (groups[s.category] = groups[s.category] || []).push(s.name); });
  res.render('index', { title: profile.full_name, profile, groups, projects, sent: req.query.sent === '1', error: null, form: {}, admin: false });
}));

app.post('/contact', wrap(async (req, res) => {
  const form = { name: str(req.body.name, 80), email: str(req.body.email, 120), body: str(req.body.body, 2000) };
  if (str(req.body.website, 200)) { // ô bẫy: người thật không thấy ô này
    log.warn('contact_spam_blocked', { ip: req.ip });
    return res.redirect('/?sent=1#lien-he');
  }
  let error = null;
  if (!form.name) error = 'Nhập tên để Dũng biết gọi bạn là gì.';
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) error = 'Email chưa đúng dạng ten@ten-mien.com.';
  else if (form.body.length < 10) error = 'Tin nhắn cần ít nhất 10 ký tự.';
  if (error) {
    const [[profile]] = await pool.query('SELECT * FROM profile WHERE id = 1');
    const [skills] = await pool.query('SELECT category, name FROM skills ORDER BY sort_order, id');
    const [projects] = await pool.query('SELECT * FROM projects WHERE published = 1 ORDER BY sort_order, year DESC, id DESC');
    const groups = {};
    skills.forEach((s) => { (groups[s.category] = groups[s.category] || []).push(s.name); });
    return res.status(400).render('index', { title: profile.full_name, profile, groups, projects, sent: false, error, form, admin: false });
  }
  await pool.query('INSERT INTO messages (name, email, body) VALUES (?,?,?)', [form.name, form.email, form.body]);
  log.info('contact_received', { ip: req.ip });
  res.redirect('/?sent=1#lien-he');
}));

// ================= Trang quản trị =================
app.get('/admin/login', (req, res) => {
  if (req.session.uid) return res.redirect('/admin');
  res.render('admin-login', { title: 'Đăng nhập quản trị', error: null, username: '', admin: true });
});

app.post('/admin/login', wrap(async (req, res) => {
  const username = str(req.body.username, 64).toLowerCase();
  const password = String(req.body.password || '').slice(0, 200);
  const [rows] = await pool.query('SELECT id, username, password_hash FROM admins WHERE username = ?', [username]);
  const ok = await bcrypt.compare(password, rows[0] ? rows[0].password_hash : DUMMY_HASH);
  if (rows[0] && ok) {
    req.session = { uid: rows[0].id, user: rows[0].username, csrf: crypto.randomBytes(24).toString('hex') };
    loginTotal.inc({ result: 'ok' });
    log.info('login_ok', { user: username, ip: req.ip });
    return res.redirect('/admin');
  }
  loginTotal.inc({ result: 'failed' });
  log.warn('login_failed', { user: username, ip: req.ip, ua: (req.get('user-agent') || '').slice(0, 120) });
  res.status(401).render('admin-login', { title: 'Đăng nhập quản trị', error: 'Sai tên đăng nhập hoặc mật khẩu.', username, admin: true });
}));

app.post('/admin/logout', (req, res) => {
  log.info('logout', { user: req.session.user, ip: req.ip });
  req.session = null;
  res.redirect('/admin/login');
});

app.get('/admin', requireAuth, wrap(async (req, res) => {
  const [[c]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM skills) AS skills,
            (SELECT COUNT(*) FROM messages WHERE read_at IS NULL) AS unread`);
  const [latest] = await pool.query('SELECT id, name, email, body, created_at, read_at FROM messages ORDER BY id DESC LIMIT 3');
  res.render('admin-dashboard', { title: 'Tổng quan', c, latest, admin: true });
}));

app.get('/admin/profile', requireAuth, wrap(async (req, res) => {
  const [[profile]] = await pool.query('SELECT * FROM profile WHERE id = 1');
  res.render('admin-profile', { title: 'Hồ sơ', profile, saved: req.query.saved === '1', admin: true });
}));
app.post('/admin/profile', requireAuth, wrap(async (req, res) => {
  const b = req.body;
  await pool.query(
    'UPDATE profile SET full_name=?, headline=?, about=?, email=?, github_url=?, location=? WHERE id = 1',
    [str(b.full_name, 80) || 'Chưa đặt tên', str(b.headline, 200), str(b.about, 3000), str(b.email, 120), url(b.github_url), str(b.location, 80)]);
  log.info('profile_updated', { user: req.session.user, ip: req.ip });
  res.redirect('/admin/profile?saved=1');
}));

// ---- Dự án ----
app.get('/admin/projects', requireAuth, wrap(async (req, res) => {
  const [projects] = await pool.query('SELECT * FROM projects ORDER BY sort_order, year DESC, id DESC');
  res.render('admin-projects', { title: 'Dự án', projects, admin: true });
}));
app.get('/admin/projects/new', requireAuth, (req, res) =>
  res.render('admin-project-form', { title: 'Thêm dự án', p: { published: 1, year: new Date().getFullYear(), sort_order: 10 }, action: '/admin/projects', admin: true }));
app.get('/admin/projects/:id(\\d+)/edit', requireAuth, wrap(async (req, res) => {
  const [[p]] = await pool.query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).render('error', { title: 'Không tìm thấy', message: 'Dự án này đã bị xóa.', admin: true });
  res.render('admin-project-form', { title: 'Sửa dự án', p, action: `/admin/projects/${p.id}`, admin: true });
}));
function projectFields(b) {
  return [str(b.title, 120) || 'Dự án chưa đặt tên', str(b.summary, 1000), str(b.stack, 200), url(b.repo_url), url(b.demo_url),
    Number.isInteger(Number(b.year)) ? Number(b.year) : null, b.published ? 1 : 0, Number.isInteger(Number(b.sort_order)) ? Number(b.sort_order) : 10];
}
app.post('/admin/projects', requireAuth, wrap(async (req, res) => {
  await pool.query('INSERT INTO projects (title, summary, stack, repo_url, demo_url, year, published, sort_order) VALUES (?,?,?,?,?,?,?,?)', projectFields(req.body));
  log.info('project_created', { user: req.session.user, ip: req.ip });
  res.redirect('/admin/projects');
}));
app.post('/admin/projects/:id(\\d+)', requireAuth, wrap(async (req, res) => {
  await pool.query('UPDATE projects SET title=?, summary=?, stack=?, repo_url=?, demo_url=?, year=?, published=?, sort_order=? WHERE id=?', [...projectFields(req.body), req.params.id]);
  log.info('project_updated', { project_id: Number(req.params.id), user: req.session.user, ip: req.ip });
  res.redirect('/admin/projects');
}));
app.post('/admin/projects/:id(\\d+)/delete', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM projects WHERE id = ?', [req.params.id]);
  log.warn('project_deleted', { project_id: Number(req.params.id), user: req.session.user, ip: req.ip });
  res.redirect('/admin/projects');
}));

// ---- Kỹ năng ----
app.get('/admin/skills', requireAuth, wrap(async (req, res) => {
  const [skills] = await pool.query('SELECT * FROM skills ORDER BY sort_order, id');
  res.render('admin-skills', { title: 'Kỹ năng', skills, admin: true });
}));
app.post('/admin/skills', requireAuth, wrap(async (req, res) => {
  const name = str(req.body.name, 60), category = str(req.body.category, 40);
  if (name && category) await pool.query('INSERT INTO skills (category, name, sort_order) VALUES (?,?,?)', [category, name, 50]);
  res.redirect('/admin/skills');
}));
app.post('/admin/skills/:id(\\d+)/delete', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM skills WHERE id = ?', [req.params.id]);
  res.redirect('/admin/skills');
}));

// ---- Tin nhắn ----
app.get('/admin/messages', requireAuth, wrap(async (req, res) => {
  const [messages] = await pool.query('SELECT * FROM messages ORDER BY id DESC LIMIT 200');
  res.render('admin-messages', { title: 'Tin nhắn', messages, admin: true });
}));
app.post('/admin/messages/:id(\\d+)/read', requireAuth, wrap(async (req, res) => {
  await pool.query('UPDATE messages SET read_at = COALESCE(read_at, NOW()) WHERE id = ?', [req.params.id]);
  res.redirect('/admin/messages');
}));
app.post('/admin/messages/:id(\\d+)/delete', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM messages WHERE id = ?', [req.params.id]);
  log.warn('message_deleted', { message_id: Number(req.params.id), user: req.session.user, ip: req.ip });
  res.redirect('/admin/messages');
}));

app.use((req, res) => res.status(404).render('error', { title: 'Không tìm thấy', message: 'Trang này không tồn tại.', admin: false }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  log.error('unhandled', { msg: err.message, path: req.path, ip: req.ip });
  res.status(500).render('error', { title: 'Lỗi máy chủ', message: 'Có lỗi ở phía máy chủ. Sự cố đã được ghi vào log.', admin: false });
});

// ---- Khởi động: chờ DB, tạo tài khoản quản trị và nội dung mẫu lần đầu ----
async function seed() {
  const adminName = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const [a] = await pool.query('SELECT id FROM admins WHERE username = ?', [adminName]);
  if (!a[0]) {
    await pool.query('INSERT INTO admins (username, password_hash) VALUES (?,?)', [adminName, await bcrypt.hash(process.env.ADMIN_PASSWORD, 10)]);
    log.info('seed_admin', { user: adminName });
  }
  const [[p]] = await pool.query('SELECT COUNT(*) AS n FROM profile');
  if (!p.n) {
    await pool.query(
      'INSERT INTO profile (id, full_name, headline, about, email, github_url, location) VALUES (1,?,?,?,?,?,?)',
      ['Nguyễn Đức Dũng',
        'Sinh viên CNTT K23C, đang học cách đưa một ứng dụng web lên máy chủ và giữ cho nó chạy ổn định.',
        'Mình học tại Trường Đại học Công nghệ Thông tin và Truyền thông, Thái Nguyên.\nTrong môn Triển khai và Quản trị Hệ thống Phần mềm, mình dựng chính trang này bằng Docker Compose cùng Nginx, MySQL, Prometheus, Grafana và Loki.\nNội dung trên trang đều sửa được tại trang quản trị.',
        '', '', 'Thái Nguyên']);
    const skills = [
      ['Triển khai', 'Docker Compose'], ['Triển khai', 'Nginx reverse proxy'], ['Triển khai', 'Linux dòng lệnh'],
      ['Giám sát', 'Prometheus'], ['Giám sát', 'Grafana'], ['Giám sát', 'Loki và LogQL'],
      ['Dữ liệu', 'MySQL'], ['Dữ liệu', 'phpMyAdmin'], ['Lập trình', 'JavaScript'], ['Lập trình', 'Node.js'],
    ];
    for (let i = 0; i < skills.length; i++) await pool.query('INSERT INTO skills (category, name, sort_order) VALUES (?,?,?)', [skills[i][0], skills[i][1], i]);
    const projects = [
      ['Portfolio cá nhân chạy bằng Docker Compose', 'Chính trang web này. Nginx làm reverse proxy với HTTPS tự ký, MySQL lưu nội dung, phpMyAdmin để xem và sửa dữ liệu.', 'Node.js, MySQL, Nginx, Docker Compose', 2026, 1],
      ['Bảng giám sát container', 'Dashboard Grafana theo dõi CPU, RAM, mạng của từng container và số truy vấn MySQL. Số liệu lấy từ Prometheus.', 'Prometheus, Grafana, cAdvisor, mysqld-exporter', 2026, 2],
      ['Truy vết sự cố dò mật khẩu bằng log', 'Một IP thử mật khẩu trang quản trị. Loki giữ log, Grafana bắn cảnh báo, câu LogQL chỉ ra IP nguồn và thời điểm.', 'Loki, Promtail, LogQL, Grafana Alerting', 2026, 3],
    ];
    for (const r of projects) await pool.query('INSERT INTO projects (title, summary, stack, year, sort_order, published) VALUES (?,?,?,?,?,1)', [r[0], r[1], r[2], r[3], r[4]]);
    log.info('seed_content', { projects: projects.length, skills: skills.length });
  }
}

(async () => {
  for (const k of ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'SESSION_SECRET', 'ADMIN_PASSWORD']) {
    if (!process.env[k]) { log.error('missing_env', { name: k }); process.exit(1); }
  }
  await waitForDb();
  await seed();
  app.listen(PORT, '0.0.0.0', () => log.info('listening', { port: PORT }));
})().catch((e) => { log.error('fatal', { msg: e.message }); process.exit(1); });
