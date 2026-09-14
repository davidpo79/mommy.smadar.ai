import crypto from 'node:crypto';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import { config, isTeamGated } from './config.js';

const MANAGER_COOKIE = 'mommy_session';
const TEAM_COOKIE = 'mommy_team';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(payload)
    .digest('base64url');
}

/** Constant-time string comparison that does not leak length via early exit. */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function issueToken(role) {
  const body = b64url(
    JSON.stringify({
      role,
      exp: Math.floor(Date.now() / 1000) + config.sessionMaxAgeSeconds,
      iat: Math.floor(Date.now() / 1000),
    })
  );
  return `${body}.${sign(body)}`;
}

function readToken(token, expectedRole) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.', 2);
  const expected = sign(body);
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (claims.role !== expectedRole) return null;
    if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

function cookieOptions(req, maxAge) {
  const secure = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge,
  };
}

export function setManagerCookie(req, res) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(
      MANAGER_COOKIE,
      issueToken('manager'),
      cookieOptions(req, config.sessionMaxAgeSeconds)
    )
  );
}

export function setTeamCookie(req, res) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(
      TEAM_COOKIE,
      issueToken('team'),
      cookieOptions(req, config.sessionMaxAgeSeconds)
    )
  );
}

export function clearSessionCookies(req, res) {
  res.setHeader('Set-Cookie', [
    serializeCookie(MANAGER_COOKIE, '', cookieOptions(req, 0)),
    serializeCookie(TEAM_COOKIE, '', cookieOptions(req, 0)),
  ]);
}

/** Populates req.session = { isManager, canRead } for every request. */
export function sessionMiddleware(req, _res, next) {
  const cookies = parseCookie(req.headers.cookie || '');
  const isManager = Boolean(readToken(cookies[MANAGER_COOKIE], 'manager'));
  const hasTeam = Boolean(readToken(cookies[TEAM_COOKIE], 'team'));
  req.session = {
    isManager,
    // Managers always read. Team readers need a cookie only when a team code
    // is configured; otherwise the schedule is open to anyone with the link.
    canRead: isManager || !isTeamGated() || hasTeam,
  };
  next();
}

export function requireManager(req, res, next) {
  if (req.session?.isManager) return next();
  console.warn(
    `[auth] manager-only endpoint refused ${req.method} ${req.path} ip=${clientIp(req)}`
  );
  return res.status(401).json({ error: 'manager_required' });
}

export function requireRead(req, res, next) {
  if (req.session?.canRead) return next();
  return res.status(401).json({ error: 'access_code_required' });
}

export function clientIp(req) {
  return (req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
}

// ---------------------------------------------------------------------------
// Simple in-memory throttle for code-entry endpoints. Good enough for a
// single-service deployment and keeps brute force out of the logs and the DB.
// ---------------------------------------------------------------------------
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function throttleAuth(req, res, next) {
  const key = clientIp(req) || 'unknown';
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || now - record.first > WINDOW_MS) {
    attempts.set(key, { first: now, count: 1 });
    return next();
  }
  record.count += 1;
  if (record.count > MAX_ATTEMPTS) {
    console.warn(`[auth] throttled ip=${key} attempts=${record.count}`);
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  return next();
}

export function resetThrottle(req) {
  attempts.delete(clientIp(req) || 'unknown');
}

// Periodically drop stale throttle entries so the map cannot grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, value] of attempts) {
    if (value.first < cutoff) attempts.delete(key);
  }
}, WINDOW_MS).unref();
