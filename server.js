/**
 * 旅行记忆 — 后端服务
 * Node.js + Express + sql.js（纯 JS，无需编译）
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 配置 ====================

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (!process.env.ADMIN_PASSWORD && IS_PRODUCTION) {
  console.error('[安全] 生产环境必须设置 ADMIN_PASSWORD，服务已停止启动。');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'blctblct';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('[安全] 未设置 ADMIN_PASSWORD 环境变量，使用内置密码。生产环境请务必设置环境变量！');
}

const DB_PATH = path.join(__dirname, 'data.db');

// ==================== 数据库（sql.js） ====================

let db; // sql.js Database 实例

async function initDatabase() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  // 尝试加载已有数据库文件
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('[数据库] 已加载现有数据库');
  } else {
    db = new SQL.Database();
    console.log('[数据库] 已创建新数据库');
  }

  // 初始化表
  db.run(`CREATE TABLE IF NOT EXISTS codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    used INTEGER DEFAULT 0
  )`);

  // 统计表（旧版，保持兼容）
  db.run(`CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT,
    action TEXT NOT NULL,
    value TEXT,
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // 新版用户行为日志表
  db.run(`CREATE TABLE IF NOT EXISTS user_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_meta TEXT DEFAULT '{}',
    active_time_ms INTEGER DEFAULT 0,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // 管理员模板表
  db.run(`CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tkey TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // 用户路线投稿表
  db.run(`CREATE TABLE IF NOT EXISTS route_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    tkey TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // 增量迁移：为 templates 表补充距离/分类字段（已存在则忽略）
  try { db.run("ALTER TABLE templates ADD COLUMN distance REAL"); } catch (e) {}
  try { db.run("ALTER TABLE templates ADD COLUMN category TEXT DEFAULT 'cycling'"); } catch (e) {}
  saveDb();

  // 查询是否已有数据
  const count = dbGet('SELECT COUNT(*) AS cnt FROM codes');
  if (count && count.cnt === 0) {
    const samples = ['LINGO2024', 'HAINAN01', 'SUNNY99', 'TRAVEL88', 'GREEN22'];
    samples.forEach(s => db.run('INSERT INTO codes (code) VALUES (?)', [s]));
    saveDb();
    console.log('[数据库] 已预置 5 个示例兑换码:', samples.join(', '));
  }

  syncTemplatesFromDisk();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

const TEMPLATE_ROOT = path.join(__dirname, 'public', 'templates');

function hasTemplatePngs(tkey) {
  const dirPath = path.join(TEMPLATE_ROOT, tkey);
  if (!fs.existsSync(dirPath)) return false;
  return fs.readdirSync(dirPath).some(f => f.endsWith('.png'));
}

function getTemplateDirs() {
  if (!fs.existsSync(TEMPLATE_ROOT)) return [];
  return fs.readdirSync(TEMPLATE_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && isValidTkey(d.name) && hasTemplatePngs(d.name))
    .map(d => d.name);
}

function removeTemplateDir(tkey) {
  const tplDir = path.join(TEMPLATE_ROOT, tkey);
  if (!fs.existsSync(tplDir)) return;
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Remove-Item -LiteralPath $env:TPL_DIR -Recurse -Force -ErrorAction Stop',
    ], {
      env: { ...process.env, TPL_DIR: tplDir },
      stdio: 'pipe',
      windowsHide: true,
    });
    return;
  }
  fs.rmSync(tplDir, { recursive: true, force: true });
}

function templateExists(tkey) {
  // 先检查磁盘：文件夹不存在则清理 DB 并返回 false
  const dirPath = path.join(TEMPLATE_ROOT, tkey);
  if (!fs.existsSync(dirPath)) {
    // 清理残留的数据库记录
    const inDB = !!dbGet('SELECT tkey FROM templates WHERE tkey = ?', [tkey]);
    const inSub = !!dbGet('SELECT tkey FROM route_submissions WHERE tkey = ?', [tkey]);
    if (inDB || inSub) {
      db.run('DELETE FROM templates WHERE tkey = ?', [tkey]);
      db.run('DELETE FROM route_submissions WHERE tkey = ?', [tkey]);
      saveDb();
    }
    return false;
  }
  return true;
}

function findAvailableTemplateKey(baseKey) {
  if (!templateExists(baseKey)) return baseKey;
  for (let i = 2; i < 1000; i++) {
    const key = `${baseKey}（${i}）`;
    if (isValidTkey(key) && !templateExists(key)) return key;
  }
  return null;
}

// 扫描磁盘模板目录，双向同步磁盘与数据库
function syncTemplatesFromDisk() {
  if (!fs.existsSync(TEMPLATE_ROOT)) return;

  // 磁盘上实际存在的文件夹
  const diskDirs = new Set(getTemplateDirs());
  const dbKeys = dbAll('SELECT tkey FROM templates').map(r => r.tkey);

  // ① 磁盘有、DB 无 → 注册
  let added = 0;
  for (const name of diskDirs) {
    if (!dbKeys.includes(name)) {
      db.run('INSERT OR IGNORE INTO templates (tkey, name, distance, category) VALUES (?, ?, NULL, ?)',
        [name, name, 'cycling']);
      added++;
    }
  }
  if (added > 0) { saveDb(); console.log(`[磁盘同步] 注册了 ${added} 个模板`); }

  // ② DB 有、磁盘无 → 清理（用户直接删了文件夹）
  let removed = 0;
  for (const tkey of dbKeys) {
    if (!diskDirs.has(tkey)) {
      db.run('DELETE FROM templates WHERE tkey = ?', [tkey]);
      db.run('DELETE FROM route_submissions WHERE tkey = ?', [tkey]);
      removed++;
    }
  }
  if (removed > 0) { saveDb(); console.log(`[磁盘同步] 清理了 ${removed} 个已删除的模板`); }
}

// 查询单行结果
function dbGet(sql, params = []) {
  const results = db.exec(sql, params);
  if (!results.length || !results[0].values.length) return null;
  const row = {};
  results[0].columns.forEach((col, i) => row[col] = results[0].values[0][i]);
  return row;
}

// 查询多行结果
function dbAll(sql, params = []) {
  const results = db.exec(sql, params);
  if (!results.length) return [];
  return results[0].values.map(vals => {
    const row = {};
    results[0].columns.forEach((col, i) => row[col] = vals[i]);
    return row;
  });
}

// ==================== 登录限流 ====================

const loginAttempts = new Map();

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (record && now - record.firstAttempt > 15 * 60 * 1000) {
    loginAttempts.delete(ip);
    return true;
  }
  if (!record) return true;
  if (record.blockedUntil && now < record.blockedUntil) return false;
  if (record.count >= 5) {
    record.blockedUntil = now + 15 * 60 * 1000;
    return false;
  }
  return true;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  let record = loginAttempts.get(ip);
  if (!record || now - record.firstAttempt > 15 * 60 * 1000) {
    record = { count: 0, firstAttempt: now, blockedUntil: null };
  }
  record.count++;
  loginAttempts.set(ip, record);
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) {
    if (now - v.firstAttempt > 30 * 60 * 1000) loginAttempts.delete(k);
  }
}, 300_000);

// ==================== 中间件 ====================

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 管理员令牌 ====================

const tokenStore = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未提供认证令牌' });
  }
  const token = auth.slice(7);
  const record = tokenStore.get(token);
  if (!record || record.expiry < Date.now()) {
    tokenStore.delete(token);
    return res.status(401).json({ error: '令牌无效或已过期' });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenStore) {
    if (v.expiry < now) tokenStore.delete(k);
  }
}, 60_000);

// ==================== API 路由 ====================

// 规律码正则
const PATTERN_CODE_REGEX = /^[a-z]{4}\d{2}[a-z]{2}$/;

// 兑换限流
const redeemFailures = new Map();
const redeemSuccess = new Map();
const REDEEM_FAIL_MAX = 50;
const REDEEM_SUCCESS_MAX = 50;

function checkRedeemRateLimit(ip) {
  const now = Date.now();
  const failRec = redeemFailures.get(ip);
  if (failRec && now - failRec.firstAttempt < 3600_000 && failRec.count >= REDEEM_FAIL_MAX) {
    return false;
  }
  const succRec = redeemSuccess.get(ip);
  const today = new Date().toDateString();
  if (succRec && succRec.date === today && succRec.count >= REDEEM_SUCCESS_MAX) {
    return false;
  }
  return true;
}

function recordRedeemFailure(ip) {
  const now = Date.now();
  let rec = redeemFailures.get(ip);
  if (!rec || now - rec.firstAttempt > 3600_000) {
    rec = { count: 0, firstAttempt: now };
  }
  rec.count++;
  redeemFailures.set(ip, rec);
  try { db.run('INSERT INTO analytics (ip, action) VALUES (?, ?)', [ip.replace(/^::ffff:/, '').slice(0, 45), 'redeem_failed']); } catch (e) {}
}

function recordRedeemSuccess(ip) {
  const today = new Date().toDateString();
  let rec = redeemSuccess.get(ip);
  if (!rec || rec.date !== today) {
    rec = { count: 0, date: today };
  }
  rec.count++;
  redeemSuccess.set(ip, rec);
  redeemFailures.delete(ip);
  try { db.run('INSERT INTO analytics (ip, action) VALUES (?, ?)', [ip.replace(/^::ffff:/, '').slice(0, 45), 'redeem_success']); } catch (e) {}
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of redeemFailures) {
    if (now - v.firstAttempt > 7200_000) redeemFailures.delete(k);
  }
}, 600_000);

app.post('/api/redeem', (req, res) => {
  const { code } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!code || typeof code !== 'string') {
    return res.json({ success: false, message: '请输入兑换码' });
  }

  if (!checkRedeemRateLimit(ip)) {
    try { db.run('INSERT INTO analytics (ip, action) VALUES (?, ?)', [ip.replace(/^::ffff:/, '').slice(0, 45), 'redeem_failed']); } catch (e) {}
    return res.json({ success: false, message: '操作频繁，请稍后再试' });
  }

  const trimmed = code.trim();

  // 规律码
  if (PATTERN_CODE_REGEX.test(trimmed.toLowerCase())) {
    const lowered = trimmed.toLowerCase();
    const existing = dbGet('SELECT * FROM codes WHERE code = ?', [lowered]);
    if (existing) {
      if (existing.used) {
        recordRedeemFailure(ip);
        return res.json({ success: false, message: '该兑换码已被使用' });
      }
      db.run('UPDATE codes SET used = 1 WHERE id = ?', [existing.id]);
      saveDb();
      recordRedeemSuccess(ip);
      return res.json({ success: true, message: '兑换成功！正在下载高清图...' });
    }
    db.run('INSERT INTO codes (code, used) VALUES (?, 1)', [lowered]);
    saveDb();
    recordRedeemSuccess(ip);
    return res.json({ success: true, message: '兑换成功！正在下载高清图...' });
  }

  // 非规律码
  const row = dbGet('SELECT * FROM codes WHERE code = ?', [trimmed]);
  if (!row) {
    recordRedeemFailure(ip);
    return res.json({ success: false, message: '兑换码无效' });
  }
  if (row.used) {
    recordRedeemFailure(ip);
    return res.json({ success: false, message: '该兑换码已被使用' });
  }

  db.run('UPDATE codes SET used = 1 WHERE id = ?', [row.id]);
  saveDb();
  recordRedeemSuccess(ip);
  return res.json({ success: true, message: '兑换成功！正在下载高清图...' });
});

// 管理员登录
app.post('/api/admin/auth', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;

  if (!checkLoginRateLimit(ip)) {
    const record = loginAttempts.get(ip);
    const remaining = record.blockedUntil
      ? Math.ceil((record.blockedUntil - Date.now()) / 1000 / 60)
      : 0;
    return res.status(429).json({
      error: `登录尝试过于频繁，请 ${remaining} 分钟后再试`
    });
  }

  const { password } = req.body;
  const input = String(password || '');
  const expected = ADMIN_PASSWORD;
  let match = input.length === expected.length;
  for (let i = 0; i < Math.min(input.length, expected.length); i++) {
    if (input[i] !== expected[i]) match = false;
  }

  if (!match || !password) {
    recordLoginFailure(ip);
    try { db.run('INSERT INTO analytics (ip, action) VALUES (?, ?)', [ip.replace(/^::ffff:/, '').slice(0, 45), 'admin_login_failed']); } catch (e) {}
    const record = loginAttempts.get(ip);
    const remaining = 5 - record.count;
    const delay = Math.min(record.count * 500, 3000);
    setTimeout(() => {
      res.status(403).json({
        error: remaining > 0
          ? `密码错误，还剩 ${remaining} 次尝试机会`
          : '账户已临时锁定，请 15 分钟后再试'
      });
    }, delay);
    return;
  }

  resetLoginAttempts(ip);
  try { db.run('INSERT INTO analytics (ip, action) VALUES (?, ?)', [ip.replace(/^::ffff:/, '').slice(0, 45), 'admin_login']); } catch (e) {}
  const token = generateToken();
  tokenStore.set(token, { expiry: Date.now() + 15 * 60 * 1000 });
  return res.json({ token });
});

// 管理员生成兑换码
app.post('/api/admin/generate', requireAdmin, (req, res) => {
  const { prefix, count } = req.body;
  if (!count || count < 1 || count > 500) {
    return res.status(400).json({ error: '数量需在 1-500 之间' });
  }

  const generated = [];
  for (let i = 0; i < count; i++) {
    const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const code = prefix ? `${prefix}-${suffix}` : suffix;
    try {
      db.run('INSERT INTO codes (code) VALUES (?)', [code]);
      generated.push(code);
    } catch (e) {
      // 忽略重复码
    }
  }
  saveDb();
  return res.json({ codes: generated, total: generated.length });
});

// 查看所有兑换码
app.get('/api/admin/codes', requireAdmin, (req, res) => {
  const rows = dbAll('SELECT id, code, used FROM codes ORDER BY id DESC');
  return res.json({ codes: rows, total: rows.length });
});

// 导出未使用兑换码
app.get('/api/admin/export_unused', requireAdmin, (req, res) => {
  const rows = dbAll('SELECT code FROM codes WHERE used = 0 ORDER BY id');
  const text = rows.map(r => r.code).join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="unused_codes.txt"');
  return res.send(text);
});

// ==================== 数据统计 ====================

// 记录埋点事件
const VALID_ACTIONS = new Set(['pageview', 'download', 'duration', 'admin_login', 'admin_login_failed', 'redeem_success', 'redeem_failed']);

app.post('/api/track', (req, res) => {
  const { action, value, sid } = req.body || {};
  if (!action || !VALID_ACTIONS.has(action)) return res.json({ ok: false });

  const ip = (req.ip || req.connection.remoteAddress || '').replace(/^::ffff:/, '');
  // 忽略你自己的本地访问
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return res.json({ ok: true, skipped: true });

  // 限制 value 长度
  const safeValue = value ? String(value).slice(0, 20) : null;
  const safeSid = sid ? String(sid).slice(0, 40) : null;

  // 同一会话 30 秒内下载只计一次（防重复刷量）
  if (action === 'download' && safeSid) {
    const recentDL = dbGet(
      "SELECT COUNT(*) AS cnt FROM analytics WHERE action='download' AND session_id=? AND created_at >= datetime('now','localtime','-30 seconds')",
      [safeSid]
    );
    if (recentDL && recentDL.cnt > 0) return res.json({ ok: true, dedup: true });
  }

  try {
    db.run('INSERT INTO analytics (ip, action, value, session_id) VALUES (?, ?, ?, ?)',
      [ip.slice(0, 45), action, safeValue, safeSid]);
  } catch (e) { /* 统计失败不影响主功能 */ }
  res.json({ ok: true });
});

// 每 10 秒批量写一次数据库（降低崩溃丢数据风险）
setInterval(() => { try { saveDb(); } catch (e) {} }, 10000);

// ==================== 新版日志接口（Tracker 模块专用） ====================

// 兼容 sendBeacon 的各种 Content-Type（text/plain, application/json 等）
app.post('/api/log', express.raw({ type: '*/*', limit: '64kb' }), (req, res) => {
  // Fire-and-Forget：立刻返回 204，不阻塞前端
  res.status(204).end();

  // 异步解析和落库
  setImmediate(() => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : String(req.body || '');
      if (!raw) return;

      const data = JSON.parse(raw);
      const sessionId = String(data.session_id || '').slice(0, 40);
      const eventType = String(data.event_type || '').slice(0, 50);
      const eventMeta = data.event_meta ? JSON.stringify(data.event_meta).slice(0, 2000) : '{}';
      const activeTimeMs = parseInt(data.active_time_ms) || 0;
      const ip = (req.ip || req.connection.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 45);

      db.run(
        'INSERT INTO user_logs (session_id, event_type, event_meta, active_time_ms, ip) VALUES (?, ?, ?, ?, ?)',
        [sessionId, eventType, eventMeta, activeTimeMs, ip]
      );
    } catch (e) {
      // 静默失败：解析错误或 DB 写入错误都不影响前端
    }
  });
});

// 管理后台：查看统计数据
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  // 今日 PV
  const todayPV = dbGet(
    "SELECT COUNT(*) AS cnt FROM analytics WHERE action='pageview' AND date(created_at)=?",
    [today]
  );
  // 今日 UV（不同 IP）
  const todayUV = dbGet(
    "SELECT COUNT(DISTINCT ip) AS cnt FROM analytics WHERE action='pageview' AND date(created_at)=?",
    [today]
  );
  // 今日下载
  const todayDL = dbGet(
    "SELECT COUNT(*) AS cnt FROM analytics WHERE action='download' AND date(created_at)=?",
    [today]
  );
  // 今日平均停留（秒）
  const avgDuration = dbGet(
    "SELECT ROUND(AVG(CAST(value AS REAL))) AS cnt FROM analytics WHERE action='duration' AND date(created_at)=?",
    [today]
  );
  // 累计数据
  const totalPV = dbGet("SELECT COUNT(*) AS cnt FROM analytics WHERE action='pageview'");
  const totalDL = dbGet("SELECT COUNT(*) AS cnt FROM analytics WHERE action='download'");

  // 最近 7 天各维度趋势
  const trendPV = dbAll("SELECT date(created_at) AS dt, COUNT(*) AS cnt FROM analytics WHERE action='pageview' AND created_at >= datetime('now','-7 days','localtime') GROUP BY dt ORDER BY dt");
  const trendUV = dbAll("SELECT date(created_at) AS dt, COUNT(DISTINCT ip) AS cnt FROM analytics WHERE action='pageview' AND created_at >= datetime('now','-7 days','localtime') GROUP BY dt ORDER BY dt");
  const trendDL = dbAll("SELECT date(created_at) AS dt, COUNT(*) AS cnt FROM analytics WHERE action='download' AND created_at >= datetime('now','-7 days','localtime') GROUP BY dt ORDER BY dt");
  const trendDur = dbAll("SELECT date(created_at) AS dt, ROUND(AVG(CAST(value AS REAL))) AS cnt FROM analytics WHERE action='duration' AND created_at >= datetime('now','-7 days','localtime') GROUP BY dt ORDER BY dt");

  // 今日每小时 PV
  const hourlyPV = dbAll(
    "SELECT strftime('%H', created_at) AS hr, COUNT(*) AS cnt FROM analytics WHERE action='pageview' AND date(created_at)=? GROUP BY hr ORDER BY hr",
    [today]
  );

  // 今日登录统计
  const todayAdminLogin = dbGet(
    "SELECT COUNT(*) AS cnt FROM analytics WHERE action='admin_login' AND date(created_at)=?",
    [today]
  );
  const todayAdminLoginFailed = dbGet(
    "SELECT COUNT(*) AS cnt FROM analytics WHERE action='admin_login_failed' AND date(created_at)=?",
    [today]
  );
  // 今日兑换统计
  const todayRedeem = dbGet(
    "SELECT COUNT(*) AS cnt FROM analytics WHERE action='redeem_success' AND date(created_at)=?",
    [today]
  );
  const todayRedeemFailed = dbGet(
    "SELECT COUNT(*) AS cnt FROM analytics WHERE action='redeem_failed' AND date(created_at)=?",
    [today]
  );

  // 最新 10 条原始记录（用于调试）
  const recent = dbAll(
    "SELECT action, ip, value, session_id, created_at FROM analytics ORDER BY id DESC LIMIT 10"
  );

  res.json({
    today: {
      pv: todayPV ? todayPV.cnt : 0,
      uv: todayUV ? todayUV.cnt : 0,
      downloads: todayDL ? todayDL.cnt : 0,
      avgDurationSec: avgDuration ? (avgDuration.cnt || 0) : 0,
      adminLogin: todayAdminLogin ? todayAdminLogin.cnt : 0,
      adminLoginFailed: todayAdminLoginFailed ? todayAdminLoginFailed.cnt : 0,
      redeem: todayRedeem ? todayRedeem.cnt : 0,
      redeemFailed: todayRedeemFailed ? todayRedeemFailed.cnt : 0,
    },
    totalPV: totalPV ? totalPV.cnt : 0,
    totalDL: totalDL ? totalDL.cnt : 0,
    trends: { pv: trendPV, uv: trendUV, dl: trendDL, dur: trendDur },
    hourlyPV,
    recent,
  });
});

// tkey 安全校验（防路径穿越）
function isValidTkey(key) {
  if (typeof key !== 'string') return false;
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 120) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  if (/[<>:"/\\|?*\x00-\x1F]/.test(trimmed)) return false;
  return trimmed === key;
}

// ==================== 模板管理 ====================

function getDiskTemplates() {
  syncTemplatesFromDisk();
  const meta = new Map(dbAll('SELECT tkey, distance, category FROM templates ORDER BY id')
    .map(t => [t.tkey, t]));
  const submissionStatus = new Map(dbAll('SELECT tkey, status FROM route_submissions WHERE status != \'rejected\' ORDER BY id DESC')
    .map(t => [t.tkey, t.status]));

  return getTemplateDirs().map(tkey => {
    const m = meta.get(tkey) || {};
    return {
      tkey,
      name: tkey,
      distance: m.distance || null,
      category: m.category || 'cycling',
      status: submissionStatus.get(tkey) || 'approved',
    };
  });
}

// 获取所有服务器模板（公开接口，磁盘目录名即模板名）
app.get('/api/templates', (req, res) => {
  res.json({ templates: getDiskTemplates().filter(t => t.status !== 'pending').map(({ status, ...t }) => t) });
});

// 管理员获取所有模板（含投稿中的）
app.get('/api/admin/templates', requireAdmin, (req, res) => {
  res.json({ templates: getDiskTemplates() });
});

// 管理员重命名模板
app.put('/api/admin/templates/:key', requireAdmin, (req, res) => {
  const { key } = req.params;
  const { name } = req.body || {};
  if (!isValidTkey(key)) return res.status(400).json({ ok: false, error: '无效的模板标识' });
  if (!name || !String(name).trim()) return res.status(400).json({ ok: false, error: '名称不能为空' });

  const trimmed = String(name).trim();
  if (!isValidTkey(trimmed)) return res.status(400).json({ ok: false, error: '名称包含不能用于文件夹的字符' });

  const oldDir = path.join(TEMPLATE_ROOT, key);
  const newDir = path.join(TEMPLATE_ROOT, trimmed);
  if (!fs.existsSync(oldDir)) return res.status(404).json({ ok: false, error: '模板文件夹不存在' });
  if (key !== trimmed && fs.existsSync(newDir)) {
    return res.status(409).json({ ok: false, error: '同名模板文件夹已存在' });
  }

  if (key !== trimmed) fs.renameSync(oldDir, newDir);
  db.run('UPDATE templates SET tkey = ?, name = ? WHERE tkey = ?', [trimmed, trimmed, key]);
  db.run('UPDATE route_submissions SET tkey = ? WHERE tkey = ?', [trimmed, key]);
  saveDb();

  console.log(`[模板] 重命名: ${key} → ${trimmed}`);
  res.json({ ok: true, key: trimmed, name: trimmed });
});

// 管理员删除模板
app.delete('/api/admin/templates/:key', requireAdmin, (req, res) => {
  const { key } = req.params;
  if (!isValidTkey(key)) return res.status(400).json({ ok: false, error: '无效的模板标识' });

  try {
    // 删除模板文件
    removeTemplateDir(key);

    // 删除数据库记录
    db.run('DELETE FROM templates WHERE tkey = ?', [key]);
    db.run('DELETE FROM route_submissions WHERE tkey = ?', [key]);
    saveDb();

    console.log(`[模板] 已删除: ${key}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[模板] 删除失败:', e);
    res.status(500).json({ ok: false, error: '删除失败: ' + e.message });
  }
});

// 管理员保存模板（需认证）
app.post('/api/admin/templates', requireAdmin, (req, res) => {
  const { name, key: tkey, cells, distance, category, keepDuplicate } = req.body || {};
  if (!isValidTkey(tkey)) return res.status(400).json({ error: '无效的模板标识' });
  if (!name || !cells || cells.length !== 9) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const dist = (typeof distance === 'number' && isFinite(distance) && distance > 0) ? Math.round(distance * 100) / 100 : null;
  const cat = ['cycling', 'hiking', 'travel'].includes(category) ? category : 'cycling';
  const effectiveKey = templateExists(tkey) ? findAvailableTemplateKey(tkey) : tkey;

  // 创建模板目录
  const tplDir = path.join(TEMPLATE_ROOT, effectiveKey);
  try {
    if (!fs.existsSync(tplDir)) fs.mkdirSync(tplDir, { recursive: true });

    // 保存 9 张 PNG
    const slots = ['1_1','1_2','1_3','2_1','2_2','2_3','3_1','3_2','3_3'];
    for (let i = 0; i < 9; i++) {
      const base64Data = cells[i].replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(path.join(tplDir, `grid_${slots[i]}.png`), Buffer.from(base64Data, 'base64'));
    }

    // 写入数据库
    db.run('INSERT OR REPLACE INTO templates (tkey, name, distance, category) VALUES (?, ?, ?, ?)', [effectiveKey, effectiveKey, dist, cat]);
    saveDb();

    console.log(`[模板] 管理员保存: ${effectiveKey}`);
    res.json({ ok: true, key: effectiveKey, name: effectiveKey });
  } catch (e) {
    console.error('[模板] 保存失败:', e.message);
    res.status(500).json({ error: '保存失败: ' + e.message });
  }
});

// ==================== 路线投稿 ====================

app.post('/api/submit-route', (req, res) => {
  const { title, description, name, key: tkey, cells, keepDuplicate } = req.body || {};

  // 验证
  if (!isValidTkey(tkey)) return res.json({ ok: false, error: '无效的模板标识' });
  if (!title || String(title).trim().length < 3) {
    return res.json({ ok: false, error: '标题不能少于 3 个字' });
  }
  if (!description || String(description).trim().length < 20) {
    return res.json({ ok: false, error: '正文不能少于 20 个字' });
  }
  if (!name || !tkey || !cells || cells.length !== 9) {
    return res.json({ ok: false, error: '模板数据不完整' });
  }

  try {
    const effectiveKey = templateExists(tkey) ? findAvailableTemplateKey(tkey) : tkey;

    // 保存模板 PNG
    const tplDir = path.join(TEMPLATE_ROOT, effectiveKey);
    if (!fs.existsSync(tplDir)) fs.mkdirSync(tplDir, { recursive: true });
    const slots = ['1_1','1_2','1_3','2_1','2_2','2_3','3_1','3_2','3_3'];
    for (let i = 0; i < 9; i++) {
      const base64Data = cells[i].replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(path.join(tplDir, `grid_${slots[i]}.png`), Buffer.from(base64Data, 'base64'));
    }

    // 写入投稿记录
    db.run('INSERT OR REPLACE INTO route_submissions (title, description, tkey, status) VALUES (?, ?, ?, ?)',
      [String(title).trim(), String(description).trim(), effectiveKey, 'pending']);
    saveDb();

    console.log(`[投稿] ${title} (${effectiveKey})`);
    res.json({ ok: true, key: effectiveKey, name: effectiveKey, message: '投稿成功！管理员审核后将会上线' });
  } catch (e) {
    console.error('[投稿] 失败:', e.message);
    res.status(500).json({ ok: false, error: '保存失败' });
  }
});

// 管理员查看投稿列表
app.get('/api/admin/submissions', requireAdmin, (req, res) => {
  const rows = dbAll('SELECT id, title, description, tkey, status, created_at FROM route_submissions ORDER BY id DESC');
  res.json({ submissions: rows });
});

// 审核投稿（通过/拒绝）
app.post('/api/admin/submissions/review', requireAdmin, (req, res) => {
  const { id, status } = req.body || {};
  if (!id || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ ok: false, error: '参数错误' });
  }

  const row = dbGet('SELECT * FROM route_submissions WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ ok: false, error: '投稿不存在' });

  db.run('UPDATE route_submissions SET status = ? WHERE id = ?', [status, id]);
  saveDb();

  // 通过时自动加入模板列表
  if (status === 'approved') {
    // 模板 PNG 已在投稿时保存到 public/templates/{tkey}/
    db.run('INSERT OR REPLACE INTO templates (tkey, name) VALUES (?, ?)', [row.tkey, row.tkey]);
    saveDb();
    console.log(`[模板] 审核通过: ${row.tkey}`);
  } else {
    // 拒绝时删除模板文件
    try {
      removeTemplateDir(row.tkey);
    } catch (e) {}
  }

  res.json({ ok: true });
});

// ==================== 启动 ====================

(async () => {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`[服务] 旅行记忆已启动: http://localhost:${PORT}`);
  });
})();
