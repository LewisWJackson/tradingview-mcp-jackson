/**
 * auth.mjs — JWT + password hashing + user CRUD
 * Zero external dependencies — uses Node built-ins only.
 */

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

// ── JWT ───────────────────────────────────────────────────────────────────────
// Read JWT_SECRET lazily on first use — ESM hoists imports, so reading it at
// module-eval time runs BEFORE the entrypoint loads dotenv, yielding an empty env.
let _jwtSecret = null;
function getJwtSecret() {
  if (_jwtSecret) return _jwtSecret;
  if (process.env.JWT_SECRET) {
    _jwtSecret = process.env.JWT_SECRET;
  } else {
    _jwtSecret = randomBytes(32).toString('hex');
    console.warn('[auth] JWT_SECRET not set — sessions will reset on restart. Add JWT_SECRET=<random-string> to your .env');
  }
  return _jwtSecret;
}

const ALG_HDR = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export function signJWT(payload, expiresInDays = 30) {
  const now  = Math.floor(Date.now() / 1000);
  const data = { ...payload, iat: now, exp: now + expiresInDays * 86400 };
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig  = createHmac('sha256', getJwtSecret()).update(`${ALG_HDR}.${body}`).digest('base64url');
  return `${ALG_HDR}.${body}.${sig}`;
}

export function verifyJWT(token) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const [hdr, body, sig] = parts;
  const expected = createHmac('sha256', getJwtSecret()).update(`${hdr}.${body}`).digest('base64url');
  if (!timingSafeEqual(Buffer.from(sig + '='.repeat((4 - sig.length % 4) % 4), 'base64'), Buffer.from(expected + '='.repeat((4 - expected.length % 4) % 4), 'base64'))) {
    throw new Error('signature');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('expired');
  return payload;
}

// ── Passwords ─────────────────────────────────────────────────────────────────
export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString('hex');
    scrypt(password, salt, 64, (err, hash) => {
      if (err) reject(err);
      else resolve(`${salt}:${hash.toString('hex')}`);
    });
  });
}

export function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return resolve(false);
    scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else {
        try { resolve(timingSafeEqual(Buffer.from(hash, 'hex'), derived)); }
        catch { resolve(false); }
      }
    });
  });
}

export function generateId() {
  return randomBytes(12).toString('hex');
}

// ── User CRUD ─────────────────────────────────────────────────────────────────
export const users = {
  create(data) {
    const id = generateId();
    db.prepare(`
      INSERT INTO users (id, email, username, password_hash, display_name, avatar_url, provider, provider_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.email || null, data.username || null, data.password_hash || null,
           data.display_name || null, data.avatar_url || null,
           data.provider || 'local', data.provider_id || null);
    return id;
  },

  byId(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  },

  byEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
  },

  byUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
  },

  byIdentifier(identifier) {
    const lower = (identifier || '').toLowerCase();
    return db.prepare('SELECT * FROM users WHERE lower(email)=? OR lower(username)=?').get(lower, lower) || null;
  },

  byProvider(provider, providerId) {
    return db.prepare('SELECT * FROM users WHERE provider=? AND provider_id=?').get(provider, providerId) || null;
  },

  touchLogin(id) {
    db.prepare(`UPDATE users SET last_login=datetime('now') WHERE id=?`).run(id);
  },

  updateProfile(id, { display_name, avatar_url, username }) {
    const u = this.byId(id);
    if (!u) return false;
    db.prepare(`UPDATE users SET display_name=COALESCE(?,display_name), avatar_url=COALESCE(?,avatar_url), username=COALESCE(?,username) WHERE id=?`)
      .run(display_name ?? null, avatar_url ?? null, username ?? null, id);
    return true;
  },

  safeView(u) {
    if (!u) return null;
    const { password_hash, ...safe } = u;
    return safe;
  },
};
