const express = require('express');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set.');

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));

if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. Configure PostgreSQL on Render.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      booking_date TEXT NOT NULL,
      table_name TEXT NOT NULL,
      drink TEXT NOT NULL,
      start_minute INTEGER NOT NULL,
      end_minute INTEGER NOT NULL,
      start_text TEXT NOT NULL,
      end_text TEXT NOT NULL,
      price INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('held','paid','cancelled')),
      created_at TEXT NOT NULL,
      hold_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_date_table
      ON bookings(booking_date, table_name, start_minute, end_minute, status);
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at BIGINT NOT NULL
    );
  `);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

async function requireAdmin(req, res, next) {
  try {
    const token = parseCookies(req).segretto_admin;
    if (!token) return res.status(401).json({error:'Unauthorized'});
    const hash = hashToken(token);
    const result = await pool.query('SELECT expires_at FROM admin_sessions WHERE token_hash=$1', [hash]);
    const row = result.rows[0];
    if (!row || Number(row.expires_at) < Date.now()) {
      if (row) await pool.query('DELETE FROM admin_sessions WHERE token_hash=$1', [hash]);
      return res.status(401).json({error:'Unauthorized'});
    }
    next();
  } catch (err) { next(err); }
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

const drinks = {
  'سيجريتو لاتيه': 28,
  'قهوة مختصة V60': 35,
  'إسبريسو': 20,
  'كابوتشينو': 30,
  'كرواسون ومشروب ساخن': 45
};

function parseTime(value) {
  if (!value) return NaN;
  let s = String(value).trim()
    .replace(/[أإآ]/g, 'ا')
    .replace(/صباحا|صباحًا|ص/g, 'AM')
    .replace(/مساءا|مساءً|مساء|م/g, 'PM')
    .replace(/\s+/g, ' ')
    .toUpperCase();
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})\s*(AM|PM)$/);
  if (!m) return NaN;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return NaN;
  if (m[3] === 'AM') { if (hour === 12) hour = 0; }
  else if (hour !== 12) hour += 12;
  return hour * 60 + minute;
}
function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

async function cleanupExpiredHolds(client = pool) {
  await client.query(`
    UPDATE bookings SET status='cancelled'
    WHERE status='held' AND hold_expires_at IS NOT NULL AND hold_expires_at < $1
  `, [new Date().toISOString()]);
}

async function conflictExists(client, date, table, start, end) {
  await cleanupExpiredHolds(client);
  const result = await client.query(`
    SELECT start_minute, end_minute FROM bookings
    WHERE booking_date=$1 AND table_name=$2 AND status IN ('held','paid')
  `, [date, table]);
  return result.rows.some(r => overlaps(start, end, r.start_minute, r.end_minute));
}

app.get('/api/tables', async (req, res, next) => {
  try {
    const date = String(req.query.date || '');
    if (!validDate(date)) return res.status(400).json({error:'تاريخ غير صالح.'});
    await cleanupExpiredHolds();
    const result = await pool.query(`
      SELECT table_name, start_minute, end_minute FROM bookings
      WHERE booking_date=$1 AND status IN ('held','paid')
    `, [date]);
    const tables = [];
    for (let i = 1; i <= 20; i++) {
      const name = `طاولة رقم ${i}`;
      tables.push({name, available: !result.rows.some(r => r.table_name === name)});
    }
    res.json({tables});
  } catch (err) { next(err); }
});

app.post('/api/bookings/hold', async (req, res, next) => {
  const {name, phone, bookingDate, table, drink, startTime, endTime} = req.body || {};
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 100)
    return res.status(400).json({error:'الاسم غير صالح.'});
  if (typeof phone !== 'string' || !/^[0-9+\-\s()]{7,20}$/.test(phone))
    return res.status(400).json({error:'رقم الهاتف غير صالح.'});
  if (!validDate(bookingDate)) return res.status(400).json({error:'تاريخ غير صالح.'});
  if (!/^طاولة رقم (?:[1-9]|1[0-9]|20)$/.test(table || '')) return res.status(400).json({error:'الطاولة غير صالحة.'});
  if (!Object.prototype.hasOwnProperty.call(drinks, drink)) return res.status(400).json({error:'المشروب غير صالح.'});
  const start = parseTime(startTime), end = parseTime(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    return res.status(400).json({error:'وقت الحجز غير صالح.'});

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize bookings for the exact day/table so two simultaneous requests cannot both pass the check.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${bookingDate}|${table}`]);
    if (await conflictExists(client, bookingDate, table, start, end)) {
      await client.query('ROLLBACK');
      return res.status(409).json({error:'الطاولة محجوزة بالفعل في هذه الفترة.'});
    }
    const id = crypto.randomUUID();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await client.query(`
      INSERT INTO bookings
      (id,name,phone,booking_date,table_name,drink,start_minute,end_minute,start_text,end_text,price,status,created_at,hold_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'held',$12,$13)
    `, [id, name.trim(), phone.trim(), bookingDate, table, drink, start, end,
        String(startTime).trim(), String(endTime).trim(), drinks[drink], new Date().toISOString(), expires]);
    await client.query('COMMIT');
    res.status(201).json({holdId:id, bookingDate, table, drink, startTime, endTime, price:drinks[drink]});
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    next(err);
  } finally { client.release(); }
});

app.post('/api/payments/create-checkout', async (req, res, next) => {
  try {
    const {holdId} = req.body || {};
    if (!holdId) return res.status(400).json({error:'الحجز المؤقت غير صالح.'});
    const result = await pool.query('SELECT id,status,hold_expires_at FROM bookings WHERE id=$1', [holdId]);
    const row = result.rows[0];
    if (!row || row.status !== 'held') return res.status(404).json({error:'الحجز المؤقت غير موجود.'});
    if (row.hold_expires_at && row.hold_expires_at < new Date().toISOString()) {
      await pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [holdId]);
      return res.status(410).json({error:'انتهت مدة الحجز المؤقت.'});
    }
    const gateway = process.env.PAYMENT_CHECKOUT_URL;
    if (!gateway) return res.json({checkoutUrl:null});
    const url = new URL(gateway); url.searchParams.set('holdId', holdId);
    res.json({checkoutUrl:url.toString()});
  } catch (err) { next(err); }
});

app.post('/api/admin/login', async (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    const expected = String(process.env.ADMIN_PASSWORD || '');
    if (!expected || password !== expected) return res.status(401).json({error:'بيانات الدخول غير صحيحة'});
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    await pool.query('INSERT INTO admin_sessions (token_hash,expires_at) VALUES ($1,$2)', [hashToken(token), expiresAt]);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `segretto_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`);
    res.json({ok:true});
  } catch (err) { next(err); }
});

app.post('/api/admin/logout', requireAdmin, async (req, res, next) => {
  try {
    const token = parseCookies(req).segretto_admin;
    if (token) await pool.query('DELETE FROM admin_sessions WHERE token_hash=$1', [hashToken(token)]);
    res.setHeader('Set-Cookie', 'segretto_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ok:true});
  } catch (err) { next(err); }
});

app.get('/api/admin/bookings', requireAdmin, async (req, res, next) => {
  try {
    await cleanupExpiredHolds();
    const result = await pool.query(`
      SELECT id,name,phone,booking_date AS "bookingDate",table_name AS "tableName",
             drink,start_text AS "startTime",end_text AS "endTime",price,status,created_at AS "createdAt"
      FROM bookings ORDER BY booking_date DESC, start_minute ASC
    `);
    res.json({bookings:result.rows});
  } catch (err) { next(err); }
});

app.use(express.static(require('path').join(__dirname, 'public'), { extensions:['html'], dotfiles:'deny' }));
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
app.use((req,res) => res.status(404).json({error:'Not found'}));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({error:'حدث خطأ في السيرفر.'});
});

initDb()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Segreto server running on port ${PORT}`)))
  .catch(err => { console.error('Database initialization failed:', err); process.exit(1); });
