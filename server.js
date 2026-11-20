import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, DEFAULT_SETTINGS } from './lib/db.js';
import { hashPassword, verifyPassword, signToken, verifyToken, parseCookies } from './lib/auth.js';
import { createLivekit } from './lib/livekit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }
const env = process.env;

const PORT = Number(env.PORT) || 3000;
const APP_URL = (env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE = APP_URL.startsWith('https://');
const DATA_DIR = path.resolve(__dirname, env.DATA_DIR || 'data');
const REC_DIR = path.join(DATA_DIR, 'recordings');
const PUB = path.join(__dirname, 'public');
const MAX_REC_BYTES = (Number(env.MAX_RECORDING_MB) || 1024) * 1024 * 1024;
const FILES_DIR = path.join(DATA_DIR, 'files');
const MAX_FILE_BYTES = (Number(env.MAX_FILE_MB) || 50) * 1024 * 1024;
fs.mkdirSync(REC_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

function loadSecret() {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 16) return env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();

const LK_WS = env.LIVEKIT_URL || 'ws://localhost:7880';
const LK_HTTP = env.LIVEKIT_HTTP_URL || LK_WS.replace(/^ws/, 'http');
const lk = createLivekit({
  apiKey: env.LIVEKIT_API_KEY || 'devkey',
  apiSecret: env.LIVEKIT_API_SECRET || 'secret-secret-secret-secret-123456',
  wsUrl: LK_WS,
  httpUrl: LK_HTTP,
});

const db = openDb(path.join(DATA_DIR, 'app.db'));
const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };
const S = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const toInt = (v, def, min = -Infinity, max = Infinity) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

// ---------- settings ----------
function getSettings() {
  const o = { ...DEFAULT_SETTINGS };
  for (const r of all('SELECT key,value FROM settings')) o[r.key] = r.value;
  return o;
}
const PUBLIC_SETTING_KEYS = ['site_name', 'site_tagline', 'allow_registration', 'primary_color', 'support_text', 'footer_text'];
const ADMIN_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

// ---------- bootstrap admin ----------
if (!one("SELECT id FROM users WHERE role='admin'")) {
  const email = S(env.ADMIN_EMAIL) || 'admin@example.com';
  let pw = env.ADMIN_PASSWORD;
  let generated = false;
  if (!pw || pw.length < 8) { pw = crypto.randomBytes(9).toString('base64url'); generated = true; }
  const def = one('SELECT id FROM plans WHERE is_default=1');
  run('INSERT OR REPLACE INTO users(name,email,password_hash,role,plan_id) VALUES (?,?,?,?,?)', 'مدیر سیستم', email, hashPassword(pw), 'admin', def?.id ?? null);
  console.log('\n=== اولین ادمین ساخته شد ===');
  console.log(`ایمیل: ${email}`);
  if (generated) console.log(`رمز عبور (فقط همین یک بار نمایش داده می‌شود): ${pw}`);
  console.log('===========================\n');
}

// ---------- helpers ----------
function planOf(u) {
  if (u.role === 'admin') return { id: 0, name: 'مدیر سیستم', price: 0, max_rooms: 9999, max_participants: 1000, allow_recording: 1 };
  const def = one('SELECT * FROM plans WHERE is_default=1') || { id: 0, name: 'رایگان', price: 0, max_rooms: 1, max_participants: 10, allow_recording: 0 };
  const p = u.plan_id ? one('SELECT * FROM plans WHERE id=?', u.plan_id) : null;
  const expired = u.plan_expires && Date.parse(u.plan_expires) < Date.now();
  return !p || expired ? def : p;
}
function publicUser(u) {
  const plan = planOf(u);
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, plan, plan_expires: u.plan_expires,
    rooms_used: one('SELECT COUNT(*) c FROM rooms WHERE owner_id=?', u.id).c,
  };
}
function randSlug(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(len);
  return Array.from(b, (x) => chars[x % chars.length]).join('');
}
function roomView(r) {
  const { password_hash, ...rest } = r;
  return { ...rest, has_password: !!password_hash };
}
function ownRoom(user, slug) {
  const r = one('SELECT * FROM rooms WHERE slug=?', slug);
  if (!r) fail(404, 'اتاق پیدا نشد');
  if (r.owner_id !== user.id && user.role !== 'admin') fail(403, 'دسترسی ندارید');
  return r;
}
function removeRecordingFiles(where, ...args) {
  for (const r of all(`SELECT file FROM recordings WHERE ${where}`, ...args)) {
    try { fs.unlinkSync(path.join(REC_DIR, path.basename(r.file))); } catch { /* already gone */ }
  }
}
function removeFileRows(where, ...args) {
  for (const r of all(`SELECT file FROM room_files WHERE ${where}`, ...args)) {
    try { fs.unlinkSync(path.join(FILES_DIR, path.basename(r.file))); } catch { /* already gone */ }
  }
}
function applyPlan(userId, planId) {
  const plan = one('SELECT * FROM plans WHERE id=?', planId);
  const user = one('SELECT * FROM users WHERE id=?', userId);
  if (!plan || !user) return;
  let expires = null;
  if (plan.duration_days > 0) {
    const base = user.plan_id === plan.id && user.plan_expires && Date.parse(user.plan_expires) > Date.now() ? Date.parse(user.plan_expires) : Date.now();
    expires = new Date(base + plan.duration_days * 86400000).toISOString();
  }
  run('UPDATE users SET plan_id=?, plan_expires=? WHERE id=?', plan.id, expires, userId);
}
const lkParticipant = (p) => ({
  identity: p.identity, name: p.name, metadata: p.metadata,
});
async function lkCall(method, body) {
  try { return await lk.rpc(method, body); } catch (e) {
    console.error('[livekit]', method, e.message);
    throw new HttpError(503, 'سرور تماس تصویری (LiveKit) در دسترس نیست');
  }
}

// ---------- rate limit ----------
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600000)) hits.delete(k); }, 600000).unref();

// ---------- routing ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
}

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let n = 0, done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > limit) { done = true; reject(new HttpError(413, 'حجم درخواست زیاد است')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (!n) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new HttpError(400, 'درخواست نامعتبر است')); }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}
function currentUser(req) {
  const p = verifyToken(parseCookies(req.headers.cookie || '').sid, SECRET);
  return p?.uid ? one('SELECT * FROM users WHERE id=? AND active=1', p.uid) || null : null;
}
function setSession(res, uid) {
  const t = signToken({ uid }, SECRET, 30 * 86400);
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${SECURE ? '; Secure' : ''}`);
}
const clientIp = (req) => (env.TRUST_PROXY === '1' ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';

// ================= API: auth / public =================
route('GET', '/api/settings/public', () => {
  const s = getSettings();
  return Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, s[k]]));
});
route('GET', '/api/plans', () => all('SELECT * FROM plans WHERE active=1 ORDER BY sort,id'));

route('POST', '/api/auth/register', ({ body, res, ip }) => {
  if (getSettings().allow_registration !== '1') fail(403, 'ثبت‌نام در حال حاضر غیرفعال است');
  if (limited('reg:' + ip, 10, 3600000)) fail(429, 'تعداد درخواست‌ها زیاد است، بعداً تلاش کنید');
  const name = S(body.name, 60), email = S(body.email, 120).toLowerCase(), pw = typeof body.password === 'string' ? body.password : '';
  if (name.length < 2) fail(400, 'نام را وارد کنید');
  if (!emailRe.test(email)) fail(400, 'ایمیل نامعتبر است');
  if (pw.length < 8) fail(400, 'رمز عبور باید حداقل ۸ کاراکتر باشد');
  if (one('SELECT id FROM users WHERE email=?', email)) fail(409, 'این ایمیل قبلاً ثبت شده است');
  const def = one('SELECT id FROM plans WHERE is_default=1');
  const r = run('INSERT INTO users(name,email,password_hash,plan_id) VALUES (?,?,?,?)', name, email, hashPassword(pw), def?.id ?? null);
  setSession(res, Number(r.lastInsertRowid));
  return publicUser(one('SELECT * FROM users WHERE id=?', r.lastInsertRowid));
});

route('POST', '/api/auth/login', ({ body, res, ip }) => {
  const email = S(body.email, 120).toLowerCase(), pw = typeof body.password === 'string' ? body.password : '';
  if (limited('login:' + ip, 20, 600000) || limited('login:' + email, 8, 600000)) fail(429, 'تلاش‌های ناموفق زیاد بود؛ چند دقیقه بعد دوباره امتحان کنید');
  const u = one('SELECT * FROM users WHERE email=?', email);
  if (!u || !verifyPassword(pw, u.password_hash)) fail(401, 'ایمیل یا رمز عبور اشتباه است');
  if (!u.active) fail(403, 'حساب شما غیرفعال شده است');
  run("UPDATE users SET last_login=datetime('now') WHERE id=?", u.id);
  setSession(res, u.id);
  return publicUser(u);
});

route('POST', '/api/auth/logout', ({ res }) => {
  res.setHeader('Set-Cookie', `sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${SECURE ? '; Secure' : ''}`);
  return { ok: true };
});

route('GET', '/api/me', ({ user }) => (user ? publicUser(user) : { guest: true }));

route('PATCH', '/api/me', ({ user, body }) => {
  const name = S(body.name, 60);
  if (name) run('UPDATE users SET name=? WHERE id=?', name, user.id);
  if (body.new_password) {
    if (!verifyPassword(String(body.current_password || ''), user.password_hash)) fail(400, 'رمز فعلی اشتباه است');
    if (String(body.new_password).length < 8) fail(400, 'رمز جدید باید حداقل ۸ کاراکتر باشد');
    run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(String(body.new_password)), user.id);
  }
  return publicUser(one('SELECT * FROM users WHERE id=?', user.id));
}, { auth: 'user' });

// ================= API: rooms =================
route('GET', '/api/rooms', ({ user }) =>
  all('SELECT * FROM rooms WHERE owner_id=? ORDER BY id DESC', user.id).map((r) => ({
    ...roomView(r),
    recordings: one('SELECT COUNT(*) c FROM recordings WHERE room_id=?', r.id).c,
  })), { auth: 'user' });

function roomFields(body, plan, existing = {}) {
  const f = {};
  if (body.title !== undefined) { f.title = S(body.title, 100); if (!f.title) fail(400, 'عنوان اتاق را وارد کنید'); }
  if (body.mode !== undefined) f.mode = body.mode === 'meeting' ? 'meeting' : 'class';
  if (body.max_participants !== undefined) f.max_participants = toInt(body.max_participants, 50, 2, plan.max_participants);
  if (body.allow_guests !== undefined) f.allow_guests = body.allow_guests ? 1 : 0;
  if (body.status !== undefined) f.status = body.status === 'closed' ? 'closed' : 'open';
  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 4) fail(400, 'رمز اتاق باید حداقل ۴ کاراکتر باشد');
    f.password_hash = hashPassword(body.password);
  } else if (body.clear_password) f.password_hash = null;
  return { ...existing, ...f };
}

route('POST', '/api/rooms', ({ user, body }) => {
  const plan = planOf(user);
  if (one('SELECT COUNT(*) c FROM rooms WHERE owner_id=?', user.id).c >= plan.max_rooms) fail(403, `سقف تعداد اتاق در پلن «${plan.name}» پر شده است`);
  const f = roomFields({ title: body.title, mode: body.mode, max_participants: body.max_participants ?? 50, allow_guests: body.allow_guests ?? true, password: body.password }, plan);
  if (!f.title) fail(400, 'عنوان اتاق را وارد کنید');
  const slug = randSlug();
  run('INSERT INTO rooms(slug,title,owner_id,mode,max_participants,password_hash,allow_guests) VALUES (?,?,?,?,?,?,?)',
    slug, f.title, user.id, f.mode ?? 'class', f.max_participants ?? 50, f.password_hash ?? null, f.allow_guests ?? 1);
  return roomView(one('SELECT * FROM rooms WHERE slug=?', slug));
}, { auth: 'user' });

route('PATCH', '/api/rooms/:slug', ({ user, params, body }) => {
  const r = ownRoom(user, params.slug);
  const owner = one('SELECT * FROM users WHERE id=?', r.owner_id);
  const f = roomFields(body, planOf(owner));
  const keys = Object.keys(f);
  if (keys.length) run(`UPDATE rooms SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`, ...keys.map((k) => f[k]), r.id);
  return roomView(one('SELECT * FROM rooms WHERE id=?', r.id));
}, { auth: 'user' });

route('DELETE', '/api/rooms/:slug', async ({ user, params }) => {
  const r = ownRoom(user, params.slug);
  removeRecordingFiles('room_id=?', r.id);
  removeFileRows('room_id=?', r.id);
  run('DELETE FROM rooms WHERE id=?', r.id);
  lk.rpc('DeleteRoom', { room: r.slug }).catch(() => {});
  return { ok: true };
}, { auth: 'user' });

route('GET', '/api/rooms/:slug/info', ({ params }) => {
  const r = one('SELECT r.*, u.name AS owner_name FROM rooms r JOIN users u ON u.id=r.owner_id WHERE r.slug=?', params.slug);
  if (!r) fail(404, 'اتاق پیدا نشد');
  return { title: r.title, mode: r.mode, status: r.status, allow_guests: !!r.allow_guests, has_password: !!r.password_hash, owner_name: r.owner_name };
});

route('POST', '/api/rooms/:slug/join', async ({ params, body, user, ip }) => {
  const r = one('SELECT * FROM rooms WHERE slug=?', params.slug);
  if (!r) fail(404, 'اتاق پیدا نشد');
  if (r.status !== 'open') fail(403, 'این اتاق بسته است');
  if (!user && !r.allow_guests) fail(401, 'برای ورود به این اتاق باید وارد حساب کاربری شوید');
  const isHost = !!user && (user.id === r.owner_id || user.role === 'admin');
  if (r.password_hash && !isHost) {
    if (limited('roompw:' + ip + r.id, 10, 600000)) fail(429, 'تلاش‌های زیاد؛ بعداً دوباره امتحان کنید');
    if (!verifyPassword(String(body.password || ''), r.password_hash)) fail(403, 'رمز اتاق اشتباه است');
  }
  const displayName = user ? user.name : S(body.name, 40);
  if (!displayName) fail(400, 'نام خود را وارد کنید');

  const owner = one('SELECT * FROM users WHERE id=?', r.owner_id);
  const limit = Math.min(r.max_participants, planOf(owner).max_participants);
  await lkCall('CreateRoom', { name: r.slug, empty_timeout: 600, max_participants: limit });

  const role = isHost ? 'host' : user ? 'participant' : 'guest';
  const canPublish = isHost || r.mode === 'meeting';
  const identity = (user ? `u${user.id}` : 'g') + '-' + crypto.randomBytes(4).toString('hex');
  const token = lk.accessToken({
    identity, name: displayName, metadata: JSON.stringify({ role, uid: user?.id ?? null }),
    // canUpdateOwnMetadata is deliberately NOT granted: the role lives in metadata and other clients trust it.
    grants: { room: r.slug, roomJoin: true, canPublish, canSubscribe: true, canPublishData: true },
  });
  const a = run('INSERT INTO attendance(room_id,user_id,display_name,role) VALUES (?,?,?,?)', r.id, user?.id ?? null, displayName, role);
  return {
    url: lk.wsUrl, token, identity, role, name: displayName,
    room: { slug: r.slug, title: r.title, mode: r.mode },
    can_record: isHost && !!planOf(owner).allow_recording,
    leaveToken: signToken({ aid: Number(a.lastInsertRowid) }, SECRET, 24 * 3600),
    fileToken: signToken({ rs: r.slug }, SECRET, 24 * 3600),   // lets this participant fetch the room's presentation files
  };
});

route('POST', '/api/rooms/:slug/leave', ({ body }) => {
  const p = verifyToken(body.leaveToken, SECRET);
  if (p?.aid) run("UPDATE attendance SET left_at=datetime('now') WHERE id=? AND left_at IS NULL", p.aid);
  return { ok: true };
});

route('POST', '/api/rooms/:slug/host', async ({ user, params, body }) => {
  const r = ownRoom(user, params.slug);
  const action = S(body.action, 20), identity = S(body.identity, 64);
  if (action !== 'end' && !/^[\w-]{1,64}$/.test(identity)) fail(400, 'شناسه نامعتبر');
  if (action === 'end') { await lkCall('DeleteRoom', { room: r.slug }); return { ok: true }; }
  if (action === 'remove') { await lkCall('RemoveParticipant', { room: r.slug, identity }); return { ok: true }; }
  if (action === 'mute') {
    const trackSid = S(body.trackSid, 64);
    if (!/^[\w-]{1,64}$/.test(trackSid)) fail(400, 'شناسه نامعتبر');
    await lkCall('MutePublishedTrack', { room: r.slug, identity, track_sid: trackSid, muted: true });
    return { ok: true };
  }
  if (action === 'promote' || action === 'demote') {
    const list = await lkCall('ListParticipants', { room: r.slug });
    const p = (list.participants || []).find((x) => x.identity === identity);
    if (!p) fail(404, 'شرکت‌کننده پیدا نشد');
    let meta = {};
    try { meta = JSON.parse(p.metadata || '{}'); } catch { /* keep empty */ }
    if (meta.role === 'host') fail(400, 'نقش میزبان قابل تغییر نیست');
    const up = action === 'promote';
    meta.role = up ? 'presenter' : (meta.uid ? 'participant' : 'guest');
    await lkCall('UpdateParticipant', {
      room: r.slug, identity, metadata: JSON.stringify(meta),
      permission: { can_subscribe: true, can_publish: up || r.mode === 'meeting', can_publish_data: true },
    });
    return { ok: true, role: meta.role };
  }
  fail(400, 'عملیات نامعتبر');
}, { auth: 'user' });

// ================= API: recordings =================
route('POST', '/api/rooms/:slug/recordings', ({ user, params }) => {
  const r = ownRoom(user, params.slug);
  if (!planOf(one('SELECT * FROM users WHERE id=?', r.owner_id)).allow_recording) fail(403, 'پلن شما امکان ضبط جلسه را ندارد');
  const file = `rec-${r.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webm`;
  fs.writeFileSync(path.join(REC_DIR, file), '');
  const x = run('INSERT INTO recordings(room_id,user_id,file) VALUES (?,?,?)', r.id, user.id, file);
  return { id: Number(x.lastInsertRowid) };
}, { auth: 'user' });

function ownRecording(user, id) {
  const rec = one('SELECT rec.*, r.owner_id, r.title AS room_title FROM recordings rec JOIN rooms r ON r.id=rec.room_id WHERE rec.id=?', Number(id));
  if (!rec) fail(404, 'ضبط پیدا نشد');
  if (rec.owner_id !== user.id && user.role !== 'admin') fail(403, 'دسترسی ندارید');
  return rec;
}

route('PUT', '/api/recordings/:id/chunk', async ({ user, params, req }) => {
  const rec = ownRecording(user, params.id);
  if (rec.status !== 'recording') fail(409, 'ضبط بسته شده است');
  const limit = MAX_REC_BYTES - rec.size;
  let n = 0;
  const out = fs.createWriteStream(path.join(REC_DIR, path.basename(rec.file)), { flags: 'a' });
  await new Promise((resolve, reject) => {
    req.on('data', (c) => { n += c.length; if (n > limit) { req.unpipe(out); out.end(); reject(new HttpError(413, 'حجم ضبط از سقف مجاز بیشتر شد')); } });
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    req.pipe(out);
  });
  run('UPDATE recordings SET size=size+? WHERE id=?', n, rec.id);
  return { ok: true };
}, { auth: 'user', raw: true });

route('POST', '/api/recordings/:id/finish', ({ user, params }) => {
  const rec = ownRecording(user, params.id);
  run("UPDATE recordings SET status='done', finished_at=datetime('now') WHERE id=?", rec.id);
  return { ok: true };
}, { auth: 'user' });

route('GET', '/api/rooms/:slug/recordings', ({ user, params }) => {
  const r = ownRoom(user, params.slug);
  return all('SELECT id,size,status,created_at,finished_at FROM recordings WHERE room_id=? ORDER BY id DESC', r.id);
}, { auth: 'user' });

route('DELETE', '/api/recordings/:id', ({ user, params }) => {
  const rec = ownRecording(user, params.id);
  removeRecordingFiles('id=?', rec.id);
  run('DELETE FROM recordings WHERE id=?', rec.id);
  return { ok: true };
}, { auth: 'user' });

route('GET', '/api/recordings/:id/file', ({ user, params, req, res, query }) => {
  const rec = ownRecording(user, params.id);
  const file = path.join(REC_DIR, path.basename(rec.file));
  let st;
  try { st = fs.statSync(file); } catch { fail(404, 'فایل پیدا نشد'); }
  const headers = { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' };
  if (query.get('download')) headers['Content-Disposition'] = `attachment; filename="recording-${rec.id}.webm"`;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && st.size > 0) {
    let start = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  fs.createReadStream(file).pipe(res);
}, { auth: 'user', raw: true });

// ================= API: presentation files (PDF / PowerPoint) =================
const OFFICE_EXT = new Set(['.ppt', '.pptx', '.pps', '.ppsx', '.odp']);
const MAX_FILES_PER_ROOM = 30;
const execP = (cmd, args, opts) => new Promise((resolve, reject) => execFile(cmd, args, opts, (e, out) => (e ? reject(e) : resolve(out))));

// PowerPoint files are converted to PDF on the server with LibreOffice (optional dependency).
const officeCandidates = [env.SOFFICE_PATH, 'soffice', 'libreoffice',
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice'].filter(Boolean);
let officeCmd = null;
const officeReady = (async () => {
  for (const c of officeCandidates) {
    try { await execP(c, ['--version'], { timeout: 20000 }); officeCmd = c; break; } catch { /* try next */ }
  }
  console.log(officeCmd ? `LibreOffice found (${officeCmd}) — PowerPoint upload enabled` : 'LibreOffice not found — only PDF upload works (install LibreOffice to accept PowerPoint)');
})();

let convQueue = Promise.resolve();   // one conversion at a time
function convertToPdf(src) {
  const job = convQueue.then(async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'));
    try {
      await execP(officeCmd, ['--headless', '--norestore', '--nolockcheck', '--nologo',
        `-env:UserInstallation=${pathToFileURL(path.join(work, 'profile')).href}`,
        '--convert-to', 'pdf', '--outdir', work, src], { timeout: 180000, env: { ...process.env, HOME: work } });
      const out = path.join(work, path.basename(src, path.extname(src)) + '.pdf');
      if (!fs.existsSync(out)) throw new Error('no output file');
      const dest = src + '.pdf';
      fs.copyFileSync(out, dest);
      return dest;
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  });
  convQueue = job.catch(() => {});
  return job;
}

const cleanName = (n) => path.basename(String(n || 'file')).replace(/[\u0000-\u001f<>:"|?*\\/]/g, '').trim().slice(0, 120) || 'file';
const head = (file) => { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(1024); return b.subarray(0, fs.readSync(fd, b, 0, 1024, 0)); } finally { fs.closeSync(fd); } };
const looksPdf = (b) => b.includes('%PDF-');
const looksOffice = (b) => (b[0] === 0x50 && b[1] === 0x4b) || (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0);
const unlinkQuiet = (f) => { try { fs.unlinkSync(f); } catch { /* ignore */ } };

route('GET', '/api/rooms/:slug/files', async ({ user, params }) => {
  const r = ownRoom(user, params.slug);
  await officeReady;
  return {
    items: all('SELECT id,name,size,created_at FROM room_files WHERE room_id=? ORDER BY id DESC', r.id),
    max_mb: Math.round(MAX_FILE_BYTES / 1048576), office: !!officeCmd,
  };
}, { auth: 'user' });

route('PUT', '/api/rooms/:slug/files', async ({ user, params, req, query }) => {
  const r = ownRoom(user, params.slug);
  if (one('SELECT COUNT(*) c FROM room_files WHERE room_id=?', r.id).c >= MAX_FILES_PER_ROOM) fail(400, `حداکثر ${MAX_FILES_PER_ROOM} فایل برای هر اتاق مجاز است؛ چند فایل قدیمی را حذف کنید`);
  const name = cleanName(query.get('name'));
  const ext = path.extname(name).toLowerCase();
  if (ext !== '.pdf' && !OFFICE_EXT.has(ext)) fail(400, 'فقط فایل PDF یا پاورپوینت (PPTX، PPT، ODP) پذیرفته می‌شود');
  if (Number(req.headers['content-length'] || 0) > MAX_FILE_BYTES) fail(413, `حجم فایل بیشتر از ${Math.round(MAX_FILE_BYTES / 1048576)} مگابایت است`);
  await officeReady;
  if (ext !== '.pdf' && !officeCmd) fail(501, 'تبدیل پاورپوینت روی این سرور فعال نیست. فایل را در PowerPoint با «Save as → PDF» ذخیره و PDF را بارگذاری کنید (یا LibreOffice را روی سرور نصب کنید).');

  const tmp = path.join(FILES_DIR, `up-${crypto.randomBytes(8).toString('hex')}${ext}`);
  const created = [tmp];
  try {
    let n = 0;
    const counter = new Transform({ transform(chunk, _e, cb) { n += chunk.length; n > MAX_FILE_BYTES ? cb(new HttpError(413, `حجم فایل بیشتر از ${Math.round(MAX_FILE_BYTES / 1048576)} مگابایت است`)) : cb(null, chunk); } });
    await pipeline(req, counter, fs.createWriteStream(tmp));
    if (!n) fail(400, 'فایل خالی است');
    const h = head(tmp);
    let pdfPath = tmp;
    if (ext === '.pdf') { if (!looksPdf(h)) fail(400, 'این فایل یک PDF معتبر نیست'); }
    else {
      if (!looksOffice(h)) fail(400, 'این فایل یک پاورپوینت معتبر نیست');
      try { pdfPath = await convertToPdf(tmp); created.push(pdfPath); }
      catch (e) { console.error('[convert]', e.message); fail(422, 'تبدیل پاورپوینت به PDF ناموفق بود. فایل را به‌صورت PDF ذخیره و بارگذاری کنید.'); }
      if (!looksPdf(head(pdfPath))) fail(422, 'تبدیل پاورپوینت به PDF ناموفق بود.');
    }
    const finalName = `f-${r.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
    fs.renameSync(pdfPath, path.join(FILES_DIR, finalName));
    created.splice(created.indexOf(pdfPath), 1);
    const size = fs.statSync(path.join(FILES_DIR, finalName)).size;
    const x = run('INSERT INTO room_files(room_id,name,file,size) VALUES (?,?,?,?)', r.id, name, finalName, size);
    return { id: Number(x.lastInsertRowid), name, size };
  } finally { created.forEach(unlinkQuiet); }
}, { auth: 'user', raw: true });

route('DELETE', '/api/files/:id', ({ user, params }) => {
  const f = one('SELECT f.*, r.owner_id FROM room_files f JOIN rooms r ON r.id=f.room_id WHERE f.id=?', Number(params.id));
  if (!f) fail(404, 'فایل پیدا نشد');
  if (f.owner_id !== user.id && user.role !== 'admin') fail(403, 'دسترسی ندارید');
  unlinkQuiet(path.join(FILES_DIR, path.basename(f.file)));
  run('DELETE FROM room_files WHERE id=?', f.id);
  return { ok: true };
}, { auth: 'user' });

// Served to everyone who joined the room (signed token from /join) and to the room owner / admins.
route('GET', '/api/files/:id', ({ user, params, query, req, res }) => {
  const f = one('SELECT f.*, r.slug, r.owner_id FROM room_files f JOIN rooms r ON r.id=f.room_id WHERE f.id=?', Number(params.id));
  if (!f) fail(404, 'فایل پیدا نشد');
  const tok = verifyToken(query.get('t'), SECRET);
  if (!((tok && tok.rs === f.slug) || (user && (user.id === f.owner_id || user.role === 'admin')))) fail(403, 'دسترسی ندارید');
  const file = path.join(FILES_DIR, path.basename(f.file));
  let st;
  try { st = fs.statSync(file); } catch { fail(404, 'فایل پیدا نشد'); }
  const headers = { 'Content-Type': 'application/pdf', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=600', 'Content-Disposition': 'inline' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && st.size > 0 && (m[1] !== '' || m[2] !== '')) {
    let start = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  fs.createReadStream(file).pipe(res);
}, { raw: true });

// ================= API: payments =================
const ZP_BASE = env.ZARINPAL_SANDBOX === '1' ? 'https://sandbox.zarinpal.com' : 'https://payment.zarinpal.com';

route('POST', '/api/payments/checkout', async ({ user, body }) => {
  const plan = one('SELECT * FROM plans WHERE id=? AND active=1', toInt(body.planId, 0));
  if (!plan) fail(404, 'پلن پیدا نشد');
  if (plan.price <= 0) { applyPlan(user.id, plan.id); return { activated: true }; }
  const pending = one("SELECT COUNT(*) c FROM payments WHERE user_id=? AND status='pending'", user.id).c;
  if (pending >= 5) fail(429, 'چند پرداخت در انتظار دارید؛ ابتدا آن‌ها را نهایی کنید');
  const s = getSettings();
  if (env.ZARINPAL_MERCHANT_ID) {
    const x = run("INSERT INTO payments(user_id,plan_id,amount,method) VALUES (?,?,?,'zarinpal')", user.id, plan.id, plan.price);
    const pid = Number(x.lastInsertRowid);
    try {
      const r = await fetch(`${ZP_BASE}/pg/v4/payment/request.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ merchant_id: env.ZARINPAL_MERCHANT_ID, amount: plan.price, currency: 'IRT', description: `خرید پلن ${plan.name}`, callback_url: `${APP_URL}/api/payments/callback?pid=${pid}`, metadata: { email: user.email } }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json();
      const authority = j?.data?.authority;
      if (!authority) throw new Error(JSON.stringify(j?.errors || j));
      run('UPDATE payments SET authority=? WHERE id=?', authority, pid);
      return { redirect: `${ZP_BASE}/pg/StartPay/${authority}` };
    } catch (e) {
      console.error('[zarinpal request]', e.message);
      run("UPDATE payments SET status='failed' WHERE id=?", pid);
      fail(502, 'اتصال به درگاه پرداخت برقرار نشد');
    }
  }
  if (!s.card_number) fail(503, 'روش پرداخت هنوز توسط مدیر تنظیم نشده است');
  const x = run("INSERT INTO payments(user_id,plan_id,amount,method) VALUES (?,?,?,'manual')", user.id, plan.id, plan.price);
  return { manual: true, paymentId: Number(x.lastInsertRowid), amount: plan.price, card_number: s.card_number, card_owner: s.card_owner, note: s.payment_note };
}, { auth: 'user' });

route('POST', '/api/payments/:id/receipt', ({ user, params, body }) => {
  const p = one("SELECT * FROM payments WHERE id=? AND user_id=? AND method='manual' AND status='pending'", Number(params.id), user.id);
  if (!p) fail(404, 'پرداخت پیدا نشد');
  const ref = S(body.ref, 80);
  if (!ref) fail(400, 'شماره پیگیری را وارد کنید');
  run('UPDATE payments SET ref_id=? WHERE id=?', ref, p.id);
  return { ok: true };
}, { auth: 'user' });

route('GET', '/api/payments', ({ user }) =>
  all('SELECT p.*, pl.name AS plan_name FROM payments p JOIN plans pl ON pl.id=p.plan_id WHERE p.user_id=? ORDER BY p.id DESC LIMIT 50', user.id), { auth: 'user' });

route('GET', '/api/payments/callback', async ({ query, res }) => {
  const redirect = (q) => { res.writeHead(302, { Location: `/dashboard?${q}` }); res.end(); };
  const p = one("SELECT * FROM payments WHERE id=? AND method='zarinpal' AND status='pending'", Number(query.get('pid')));
  if (!p || query.get('Authority') !== p.authority) return redirect('pay=invalid');
  if (query.get('Status') !== 'OK') { run("UPDATE payments SET status='failed' WHERE id=?", p.id); return redirect('pay=failed'); }
  try {
    const r = await fetch(`${ZP_BASE}/pg/v4/payment/verify.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ merchant_id: env.ZARINPAL_MERCHANT_ID, amount: p.amount, authority: p.authority }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    if (j?.data?.code === 100 || j?.data?.code === 101) {
      run("UPDATE payments SET status='paid', ref_id=?, paid_at=datetime('now') WHERE id=?", String(j.data.ref_id ?? ''), p.id);
      applyPlan(p.user_id, p.plan_id);
      return redirect('pay=ok');
    }
  } catch (e) { console.error('[zarinpal verify]', e.message); }
  run("UPDATE payments SET status='failed' WHERE id=?", p.id);
  redirect('pay=failed');
}, { raw: true });

// ================= API: admin =================
const A = { auth: 'admin' };

route('GET', '/api/admin/stats', async () => {
  const daily = all("SELECT date(joined_at) d, COUNT(*) c FROM attendance WHERE joined_at >= date('now','-13 days') GROUP BY d ORDER BY d");
  const minutes = one("SELECT COALESCE(SUM(MIN((julianday(COALESCE(left_at, datetime('now'))) - julianday(joined_at)) * 1440, 360)),0) m FROM attendance WHERE joined_at >= date('now','-30 days')").m;
  return {
    users: one('SELECT COUNT(*) c FROM users').c,
    new_users_7d: one("SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now','-7 days')").c,
    rooms: one('SELECT COUNT(*) c FROM rooms').c,
    joins_30d: one("SELECT COUNT(*) c FROM attendance WHERE joined_at >= date('now','-30 days')").c,
    minutes_30d: Math.round(minutes),
    revenue: one("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='paid'").s,
    revenue_30d: one("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='paid' AND paid_at >= datetime('now','-30 days')").s,
    pending_payments: one("SELECT COUNT(*) c FROM payments WHERE status='pending' AND ref_id IS NOT NULL").c,
    recordings_bytes: one('SELECT COALESCE(SUM(size),0) s FROM recordings').s,
    daily,
  };
}, A);

route('GET', '/api/admin/live', async () => {
  try {
    const data = await lk.rpc('ListRooms', {});
    return {
      ok: true,
      rooms: (data.rooms || []).map((r) => {
        const row = one('SELECT title FROM rooms WHERE slug=?', r.name);
        return { slug: r.name, title: row?.title || r.name, participants: r.num_participants ?? r.numParticipants ?? 0 };
      }),
    };
  } catch (e) { return { ok: false, error: 'LiveKit در دسترس نیست', rooms: [] }; }
}, A);

route('GET', '/api/admin/users', ({ query }) => {
  const q = '%' + S(query.get('q') || '', 60) + '%';
  const page = toInt(query.get('page'), 1, 1), size = 25;
  const where = 'WHERE (name LIKE ? OR email LIKE ?)';
  const total = one(`SELECT COUNT(*) c FROM users ${where}`, q, q).c;
  const items = all(`SELECT u.id,u.name,u.email,u.role,u.active,u.plan_id,u.plan_expires,u.created_at,u.last_login,
      (SELECT COUNT(*) FROM rooms WHERE owner_id=u.id) AS rooms FROM users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`, q, q, size, (page - 1) * size);
  return { items, total, page, size };
}, A);

route('POST', '/api/admin/users', ({ body }) => {
  const name = S(body.name, 60), email = S(body.email, 120).toLowerCase(), pw = String(body.password || '');
  if (name.length < 2 || !emailRe.test(email) || pw.length < 8) fail(400, 'نام، ایمیل معتبر و رمز حداقل ۸ کاراکتری لازم است');
  if (one('SELECT id FROM users WHERE email=?', email)) fail(409, 'این ایمیل قبلاً ثبت شده است');
  const x = run('INSERT INTO users(name,email,password_hash,role,plan_id,plan_expires) VALUES (?,?,?,?,?,?)',
    name, email, hashPassword(pw), body.role === 'admin' ? 'admin' : 'user', body.plan_id ? toInt(body.plan_id, null) : one('SELECT id FROM plans WHERE is_default=1')?.id ?? null, S(body.plan_expires, 40) || null);
  return { id: Number(x.lastInsertRowid) };
}, A);

route('PATCH', '/api/admin/users/:id', ({ user, params, body }) => {
  const id = Number(params.id);
  const u = one('SELECT * FROM users WHERE id=?', id);
  if (!u) fail(404, 'کاربر پیدا نشد');
  const sets = [], vals = [];
  const set = (k, v) => { sets.push(k + '=?'); vals.push(v); };
  if (body.name !== undefined) { const n = S(body.name, 60); if (n.length < 2) fail(400, 'نام نامعتبر'); set('name', n); }
  if (body.email !== undefined) {
    const e = S(body.email, 120).toLowerCase();
    if (!emailRe.test(e)) fail(400, 'ایمیل نامعتبر');
    if (one('SELECT id FROM users WHERE email=? AND id<>?', e, id)) fail(409, 'این ایمیل قبلاً ثبت شده است');
    set('email', e);
  }
  if (body.role !== undefined) set('role', body.role === 'admin' ? 'admin' : 'user');
  if (body.active !== undefined) set('active', body.active ? 1 : 0);
  if (body.plan_id !== undefined) set('plan_id', body.plan_id ? toInt(body.plan_id, null) : null);
  if (body.plan_expires !== undefined) set('plan_expires', S(body.plan_expires, 40) || null);
  if (body.password) { if (String(body.password).length < 8) fail(400, 'رمز باید حداقل ۸ کاراکتر باشد'); set('password_hash', hashPassword(String(body.password))); }
  if (id === user.id && ((body.role !== undefined && body.role !== 'admin') || body.active === false || body.active === 0)) fail(400, 'نمی‌توانید نقش یا وضعیت حساب خودتان را کاهش دهید');
  if (sets.length) run(`UPDATE users SET ${sets.join(',')} WHERE id=?`, ...vals, id);
  return { ok: true };
}, A);

route('DELETE', '/api/admin/users/:id', ({ user, params }) => {
  const id = Number(params.id);
  if (id === user.id) fail(400, 'نمی‌توانید حساب خودتان را حذف کنید');
  removeRecordingFiles('room_id IN (SELECT id FROM rooms WHERE owner_id=?)', id);
  removeFileRows('room_id IN (SELECT id FROM rooms WHERE owner_id=?)', id);
  run('DELETE FROM users WHERE id=?', id);
  return { ok: true };
}, A);

route('GET', '/api/admin/rooms', ({ query }) => {
  const q = '%' + S(query.get('q') || '', 60) + '%';
  const page = toInt(query.get('page'), 1, 1), size = 25;
  const where = 'WHERE (r.title LIKE ? OR r.slug LIKE ? OR u.name LIKE ?)';
  const total = one(`SELECT COUNT(*) c FROM rooms r JOIN users u ON u.id=r.owner_id ${where}`, q, q, q).c;
  const items = all(`SELECT r.id,r.slug,r.title,r.mode,r.status,r.max_participants,r.created_at,u.name AS owner_name,
      (SELECT COUNT(*) FROM attendance WHERE room_id=r.id) AS joins FROM rooms r JOIN users u ON u.id=r.owner_id ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`, q, q, q, size, (page - 1) * size);
  return { items, total, page, size };
}, A);

route('PATCH', '/api/admin/rooms/:id', ({ params, body }) => {
  const r = one('SELECT * FROM rooms WHERE id=?', Number(params.id));
  if (!r) fail(404, 'اتاق پیدا نشد');
  if (body.status !== undefined) run('UPDATE rooms SET status=? WHERE id=?', body.status === 'closed' ? 'closed' : 'open', r.id);
  if (body.max_participants !== undefined) run('UPDATE rooms SET max_participants=? WHERE id=?', toInt(body.max_participants, r.max_participants, 2, 1000), r.id);
  if (body.status === 'closed') lk.rpc('DeleteRoom', { room: r.slug }).catch(() => {});
  return { ok: true };
}, A);

route('POST', '/api/admin/rooms/:id/end', async ({ params }) => {
  const r = one('SELECT * FROM rooms WHERE id=?', Number(params.id));
  if (!r) fail(404, 'اتاق پیدا نشد');
  await lkCall('DeleteRoom', { room: r.slug });
  return { ok: true };
}, A);

route('DELETE', '/api/admin/rooms/:id', ({ params }) => {
  const r = one('SELECT * FROM rooms WHERE id=?', Number(params.id));
  if (!r) fail(404, 'اتاق پیدا نشد');
  removeRecordingFiles('room_id=?', r.id);
  removeFileRows('room_id=?', r.id);
  run('DELETE FROM rooms WHERE id=?', r.id);
  lk.rpc('DeleteRoom', { room: r.slug }).catch(() => {});
  return { ok: true };
}, A);

route('GET', '/api/admin/plans', () => all('SELECT p.*, (SELECT COUNT(*) FROM users WHERE plan_id=p.id) AS users FROM plans p ORDER BY sort,id'), A);

function planFields(body) {
  const name = S(body.name, 60);
  if (!name) fail(400, 'نام پلن را وارد کنید');
  return [name, toInt(body.price, 0, 0), toInt(body.duration_days, 30, 0), toInt(body.max_rooms, 1, 1, 9999), toInt(body.max_participants, 10, 2, 1000),
    body.allow_recording ? 1 : 0, body.active === false || body.active === 0 ? 0 : 1, toInt(body.sort, 0)];
}
route('POST', '/api/admin/plans', ({ body }) => {
  const x = run('INSERT INTO plans(name,price,duration_days,max_rooms,max_participants,allow_recording,active,sort) VALUES (?,?,?,?,?,?,?,?)', ...planFields(body));
  return { id: Number(x.lastInsertRowid) };
}, A);
route('PATCH', '/api/admin/plans/:id', ({ params, body }) => {
  const p = one('SELECT * FROM plans WHERE id=?', Number(params.id));
  if (!p) fail(404, 'پلن پیدا نشد');
  const f = planFields({ ...p, ...body });
  if (p.is_default && f[6] === 0) fail(400, 'پلن پیش‌فرض را نمی‌توان غیرفعال کرد');
  run('UPDATE plans SET name=?,price=?,duration_days=?,max_rooms=?,max_participants=?,allow_recording=?,active=?,sort=? WHERE id=?', ...f, p.id);
  if (body.is_default) { run('UPDATE plans SET is_default=0'); run('UPDATE plans SET is_default=1, active=1 WHERE id=?', p.id); }
  return { ok: true };
}, A);
route('DELETE', '/api/admin/plans/:id', ({ params }) => {
  const p = one('SELECT * FROM plans WHERE id=?', Number(params.id));
  if (!p) fail(404, 'پلن پیدا نشد');
  if (p.is_default) fail(400, 'پلن پیش‌فرض قابل حذف نیست');
  if (one('SELECT COUNT(*) c FROM users WHERE plan_id=?', p.id).c || one('SELECT COUNT(*) c FROM payments WHERE plan_id=?', p.id).c) fail(409, 'این پلن استفاده شده است؛ به‌جای حذف آن را غیرفعال کنید');
  run('DELETE FROM plans WHERE id=?', p.id);
  return { ok: true };
}, A);

route('GET', '/api/admin/payments', ({ query }) => {
  const status = S(query.get('status') || '', 20);
  const items = all(`SELECT p.*, u.name AS user_name, u.email, pl.name AS plan_name FROM payments p
    JOIN users u ON u.id=p.user_id JOIN plans pl ON pl.id=p.plan_id ${status ? 'WHERE p.status=?' : ''} ORDER BY p.id DESC LIMIT 200`, ...(status ? [status] : []));
  return { items };
}, A);
route('POST', '/api/admin/payments/:id/approve', ({ params }) => {
  const p = one("SELECT * FROM payments WHERE id=? AND status='pending'", Number(params.id));
  if (!p) fail(404, 'پرداخت در انتظار پیدا نشد');
  run("UPDATE payments SET status='paid', paid_at=datetime('now') WHERE id=?", p.id);
  applyPlan(p.user_id, p.plan_id);
  return { ok: true };
}, A);
route('POST', '/api/admin/payments/:id/reject', ({ params, body }) => {
  const p = one("SELECT * FROM payments WHERE id=? AND status='pending'", Number(params.id));
  if (!p) fail(404, 'پرداخت در انتظار پیدا نشد');
  run("UPDATE payments SET status='rejected', note=? WHERE id=?", S(body.note, 200) || null, p.id);
  return { ok: true };
}, A);

route('GET', '/api/admin/settings', () => ({ ...getSettings(), zarinpal: !!env.ZARINPAL_MERCHANT_ID, livekit_url: LK_WS }), A);
route('PUT', '/api/admin/settings', ({ body }) => {
  for (const k of ADMIN_SETTING_KEYS) {
    if (body[k] === undefined) continue;
    let v = S(String(body[k]), 500);
    if (k === 'primary_color' && !/^#[0-9a-fA-F]{6}$/.test(v)) fail(400, 'رنگ باید به شکل #RRGGBB باشد');
    if (k === 'allow_registration') v = body[k] === true || v === '1' ? '1' : '0';
    run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
  }
  return { ok: true };
}, A);

// ================= static files =================
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' };
const PAGES = { '/': '/index.html', '/login': '/auth.html', '/dashboard': '/dashboard.html', '/admin': '/admin.html' };

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (PAGES[rel]) rel = PAGES[rel];
  else if (/^\/r\/[\w-]+$/.test(rel)) rel = '/room.html';
  const full = path.join(PUB, path.normalize(rel));
  if (!full.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 — صفحه پیدا نشد'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

// ================= server =================
const lkOrigins = [LK_WS, LK_WS.replace(/^ws/, 'http')].join(' ');
const CSP = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ${lkOrigins}; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;

async function handle(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }

  let matched = null, params = {};
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (m) { matched = r; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); break; }
  }
  if (!matched) return send(res, 404, { error: 'یافت نشد' });

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let same = false;
      try { same = new URL(req.headers.origin).host === req.headers.host; } catch { /* invalid origin */ }
      if (!same) fail(403, 'درخواست از مبدأ نامعتبر');
    }
    const user = currentUser(req);
    if (matched.opts.auth && !user) fail(401, 'ابتدا وارد حساب کاربری شوید');
    if (matched.opts.auth === 'admin' && user.role !== 'admin') fail(403, 'دسترسی ندارید');
    const body = matched.opts.raw || req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE' ? {} : await readJson(req);
    const out = await matched.handler({ req, res, params, query: url.searchParams, user, body, ip: clientIp(req) });
    if (!res.headersSent && !res.writableEnded) send(res, 200, out ?? { ok: true });
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'خطای داخلی سرور' });
  }
}

http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); try { res.end(); } catch { /* ignore */ } }); })
  .listen(PORT, () => console.log(`Server running at ${APP_URL} (port ${PORT}) — LiveKit: ${LK_WS}`));
