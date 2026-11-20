import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [alg, s, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(h, 'hex');
    const got = crypto.scryptSync(pw, Buffer.from(s, 'hex'), expected.length);
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

const mac = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest();

export function signToken(payload, secret, ttlSec) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  return body + '.' + mac(body, secret).toString('base64url');
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = mac(body, secret);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
