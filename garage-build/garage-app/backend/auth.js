const bcrypt = require('bcryptjs');
const { db, generateToken } = require('./database');

const SESSION_DAYS = 30;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// ─── Rate limiting ───
function getRecentFailures(username, ip) {
  const cutoff = `datetime('now', '-${LOCKOUT_MINUTES} minutes')`;
  return db.prepare(`
    SELECT COUNT(*) AS n FROM login_attempts
    WHERE success = 0 AND attempted_at > ${cutoff}
    AND (username = ? OR ip = ?)
  `).get(username, ip).n;
}

function recordAttempt(username, ip, success) {
  db.prepare(`INSERT INTO login_attempts (username, ip, success) VALUES (?, ?, ?)`).run(username, ip, success ? 1 : 0);
}

// ─── Session management ───
function createSession(userId, userAgent) {
  const token = generateToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)
  `).run(token, userId, expires, userAgent || '');
  return { token, expires };
}

function destroySession(token) {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

function destroyAllUserSessions(userId) {
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
}

function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.is_admin, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);
  return row || null;
}

// ─── User CRUD ───
function userExists(username) {
  return !!db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(username);
}

function userCount() {
  return db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
}

async function createUser(username, password, isAdmin = false) {
  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)
  `).run(username, hash, isAdmin ? 1 : 0);
  return { id: result.lastInsertRowid, username, is_admin: isAdmin };
}

async function verifyPassword(username, password) {
  const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
  if (!user) {
    // Constant-time fake compare to prevent username enumeration
    await bcrypt.compare(password, '$2a$12$invalidhashinvalidhashinvalidhashinvalidhashinvalidhash');
    return null;
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(user.id);
  return { id: user.id, username: user.username, is_admin: !!user.is_admin };
}

async function changePassword(userId, oldPassword, newPassword) {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  if (!user) throw new Error('User not found');
  const ok = await bcrypt.compare(oldPassword, user.password_hash);
  if (!ok) throw new Error('Current password is incorrect');
  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, userId);
  destroyAllUserSessions(userId);
}

function listUsers() {
  return db.prepare(`
    SELECT id, username, is_admin, created_at, last_login,
      (SELECT COUNT(*) FROM cars WHERE user_id = users.id AND is_active = 1) AS car_count
    FROM users ORDER BY created_at
  `).all();
}

function deleteUser(userId) {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
}

// ─── Express middleware ───
function authMiddleware(req, res, next) {
  const token = req.cookies?.session;
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

function adminMiddleware(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ─── Validation ───
function validateUsername(u) {
  if (!u || typeof u !== 'string') return 'Username required';
  if (u.length < 3) return 'Username must be at least 3 characters';
  if (u.length > 32) return 'Username too long';
  if (!/^[a-zA-Z0-9._-]+$/.test(u)) return 'Username can only contain letters, numbers, dots, dashes, underscores';
  return null;
}

function validatePassword(p) {
  if (!p || typeof p !== 'string') return 'Password required';
  if (p.length < 6) return 'Password must be at least 6 characters';
  if (p.length > 200) return 'Password too long';
  return null;
}

module.exports = {
  authMiddleware,
  adminMiddleware,
  createSession,
  destroySession,
  destroyAllUserSessions,
  getSessionUser,
  userExists,
  userCount,
  createUser,
  verifyPassword,
  changePassword,
  listUsers,
  deleteUser,
  getRecentFailures,
  recordAttempt,
  validateUsername,
  validatePassword,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MINUTES,
};
