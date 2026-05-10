const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { db, seedAudiA6 } = require('./database');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.set('trust proxy', true); // for correct IP behind reverse proxies
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Multer for photo uploads
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safe = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: false, // user opted out of HTTPS-only for now
  maxAge: 30 * 24 * 60 * 60 * 1000,
  path: '/',
};

// ═══════════════════════════════════════════════════
// AUTH ROUTES (public)
// ═══════════════════════════════════════════════════

// Status — does the system have any users yet?
app.get('/api/auth/status', (req, res) => {
  const hasUsers = auth.userCount() > 0;
  const me = auth.getSessionUser(req.cookies?.session);
  res.json({
    has_users: hasUsers,
    authenticated: !!me,
    user: me ? { id: me.id, username: me.username, is_admin: !!me.is_admin } : null,
  });
});

// Register — only allowed when there are no users (first user becomes admin)
// OR when an existing admin creates a new user (handled separately under /api/users)
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  const uErr = auth.validateUsername(username);
  if (uErr) return res.status(400).json({ error: uErr });
  const pErr = auth.validatePassword(password);
  if (pErr) return res.status(400).json({ error: pErr });

  if (auth.userCount() > 0) {
    return res.status(403).json({ error: 'Registration closed. Ask an admin to create your account.' });
  }
  if (auth.userExists(username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  try {
    const user = await auth.createUser(username, password, true); // first user = admin

    // Migrate any orphaned cars (with NULL user_id) to this first admin
    const orphaned = db.prepare(`UPDATE cars SET user_id = ? WHERE user_id IS NULL`).run(user.id);
    if (orphaned.changes > 0) {
      console.log(`📦 Migrated ${orphaned.changes} existing cars to admin user`);
    }

    const session = auth.createSession(user.id, req.headers['user-agent']);
    res.cookie('session', session.token, COOKIE_OPTS);
    res.json({ user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const failures = auth.getRecentFailures(username, ip);
  if (failures >= auth.MAX_FAILED_ATTEMPTS) {
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${auth.LOCKOUT_MINUTES} minutes.`,
    });
  }

  const user = await auth.verifyPassword(username, password);
  auth.recordAttempt(username, ip, !!user);

  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const session = auth.createSession(user.id, req.headers['user-agent']);
  res.cookie('session', session.token, COOKIE_OPTS);
  res.json({ user });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) auth.destroySession(token);
  res.clearCookie('session', COOKIE_OPTS);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════
// PROTECTED ROUTES (require auth)
// ═══════════════════════════════════════════════════
const requireAuth = auth.authMiddleware;
const requireAdmin = [requireAuth, auth.adminMiddleware];

// Helper: ensure car belongs to current user
function userOwnsCar(carId, userId) {
  const car = db.prepare(`SELECT user_id FROM cars WHERE id = ?`).get(carId);
  return car && car.user_id === userId;
}

// ─── Account ───
app.get('/api/account/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/account/password', requireAuth, async (req, res) => {
  const { old_password, new_password } = req.body;
  const pErr = auth.validatePassword(new_password);
  if (pErr) return res.status(400).json({ error: pErr });
  try {
    await auth.changePassword(req.user.id, old_password, new_password);
    res.clearCookie('session', COOKIE_OPTS);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Admin: user management ───
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(auth.listUsers());
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, password, is_admin } = req.body;
  const uErr = auth.validateUsername(username);
  if (uErr) return res.status(400).json({ error: uErr });
  const pErr = auth.validatePassword(password);
  if (pErr) return res.status(400).json({ error: pErr });
  if (auth.userExists(username)) return res.status(409).json({ error: 'Username already taken' });
  try {
    const user = await auth.createUser(username, password, !!is_admin);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  auth.deleteUser(targetId);
  res.json({ ok: true });
});

app.post('/api/users/:id/reset-password', requireAdmin, async (req, res) => {
  const { new_password } = req.body;
  const pErr = auth.validatePassword(new_password);
  if (pErr) return res.status(400).json({ error: pErr });
  const targetId = parseInt(req.params.id);
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(new_password, 12);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, targetId);
  auth.destroyAllUserSessions(targetId);
  res.json({ ok: true });
});

// ─── Cars (user-scoped) ───
app.get('/api/cars', requireAuth, (req, res) => {
  const cars = db.prepare(`
    SELECT * FROM cars WHERE user_id = ? AND is_active = 1 ORDER BY created_at
  `).all(req.user.id);
  res.json(cars);
});

app.post('/api/cars', requireAuth, (req, res) => {
  const { name, make, model, year, vin, plate, current_km, notes, seed_audi,
          color, trim, power_hp, torque_nm, tune_stage, tune_power_hp, tune_torque_nm } = req.body;

  // Auto-fill Audi A6 C8 45 TFSI defaults if user picks the seed and didn't provide values
  const isAudiA6 = seed_audi || (
    (make || '').toLowerCase().includes('audi') &&
    (model || '').toLowerCase().includes('a6')
  );
  const finalColor = color || (isAudiA6 ? 'Daytona Grey Pearl' : null);
  const finalTrim = trim || (isAudiA6 ? 'Premium' : null);
  const finalPowerHp = power_hp != null ? power_hp : (isAudiA6 ? 261 : null);
  const finalTorqueNm = torque_nm != null ? torque_nm : (isAudiA6 ? 370 : null);

  const result = db.prepare(`
    INSERT INTO cars (user_id, name, make, model, year, vin, plate, current_km, notes,
                      color, trim, power_hp, torque_nm, tune_stage, tune_power_hp, tune_torque_nm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, name, make, model, year, vin, plate, current_km || 0, notes,
         finalColor, finalTrim, finalPowerHp, finalTorqueNm,
         tune_stage || null, tune_power_hp || null, tune_torque_nm || null);

  if (seed_audi) seedAudiA6(result.lastInsertRowid);

  const car = db.prepare(`SELECT * FROM cars WHERE id = ?`).get(result.lastInsertRowid);
  res.json(car);
});

app.put('/api/cars/:id', requireAuth, (req, res) => {
  const carId = parseInt(req.params.id);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });
  const { name, make, model, year, vin, plate, current_km, notes,
          color, trim, power_hp, torque_nm, tune_stage, tune_power_hp, tune_torque_nm,
          engine, cylinders } = req.body;
  db.prepare(`
    UPDATE cars SET name=?, make=?, model=?, year=?, vin=?, plate=?, current_km=?, notes=?,
                    color=?, trim=?, power_hp=?, torque_nm=?, tune_stage=?, tune_power_hp=?, tune_torque_nm=?,
                    engine=?, cylinders=?
    WHERE id = ? AND user_id = ?
  `).run(name, make, model, year, vin, plate, current_km, notes,
         color || null, trim || null,
         power_hp != null ? power_hp : null, torque_nm != null ? torque_nm : null,
         tune_stage || null,
         tune_power_hp != null ? tune_power_hp : null,
         tune_torque_nm != null ? tune_torque_nm : null,
         engine || null,
         cylinders !== '' && cylinders != null ? parseInt(cylinders) : null,
         carId, req.user.id);
  res.json(db.prepare(`SELECT * FROM cars WHERE id = ?`).get(carId));
});

// Upload car photo
app.post('/api/cars/:id/photo', requireAuth, upload.single('photo'), (req, res) => {
  const carId = parseInt(req.params.id);
  if (!userOwnsCar(carId, req.user.id)) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    return res.status(404).json({ error: 'Not found' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Delete old photo if exists
  const old = db.prepare(`SELECT photo_filename FROM cars WHERE id = ?`).get(carId);
  if (old?.photo_filename) {
    const oldPath = path.join(UPLOADS_DIR, old.photo_filename);
    if (fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch {}
  }

  db.prepare(`UPDATE cars SET photo_filename = ? WHERE id = ?`).run(req.file.filename, carId);
  res.json({ filename: req.file.filename });
});

// Delete car photo
app.delete('/api/cars/:id/photo', requireAuth, (req, res) => {
  const carId = parseInt(req.params.id);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });
  const car = db.prepare(`SELECT photo_filename FROM cars WHERE id = ?`).get(carId);
  if (car?.photo_filename) {
    const filePath = path.join(UPLOADS_DIR, car.photo_filename);
    if (fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch {}
  }
  db.prepare(`UPDATE cars SET photo_filename = NULL WHERE id = ?`).run(carId);
  res.json({ ok: true });
});

// ─── AI helpers ───────────────────────────────────────────────────────────────
async function callMistral(systemPrompt, userPrompt, maxTokens = 3000) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY not configured in docker-compose.yml');
  const body = JSON.stringify({
    model: 'mistral-small-latest',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: maxTokens,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mistral.ai',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.choices[0].message.content);
        } catch (e) { reject(new Error('Failed to parse AI response')); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}
function extractJSON(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/([\[{][\s\S]*[\]}])/);
  const parsed = JSON.parse(m ? m[1] : text);
  if (Array.isArray(parsed)) return parsed;
  // Mistral sometimes wraps the array in an object — unwrap it
  const firstArray = Object.values(parsed).find(v => Array.isArray(v));
  if (firstArray) return firstArray;
  return parsed;
}
function mergeAISchedule(carId, items) {
  const existing = db.prepare(`SELECT id, name_en FROM service_items WHERE car_id = ?`).all(carId);
  const byName = new Map(existing.map(e => [e.name_en.toLowerCase().trim(), e.id]));
  const updateStmt = db.prepare(`UPDATE service_items SET category=?, part_number=?, interval_km=?, interval_months=?, is_condition_based=?, notes=? WHERE id=?`);
  const insertStmt = db.prepare(`INSERT INTO service_items (car_id, category, name_en, name_ar, part_number, interval_km, interval_months, is_condition_based, sort_order, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let updated = 0, added = 0;
  const txn = db.transaction(() => {
    items.forEach((item, idx) => {
      const key = (item.name_en || '').toLowerCase().trim();
      const existingId = byName.get(key);
      if (existingId) {
        updateStmt.run(item.category || 'Routine', item.part_number || null, item.interval_km || null, item.interval_months || null, item.is_condition_based || 0, item.notes || null, existingId);
        updated++;
      } else {
        const base = db.prepare(`SELECT COUNT(*) as c FROM service_items WHERE car_id=?`).get(carId).c;
        insertStmt.run(carId, item.category || 'Routine', item.name_en, item.name_ar || null, item.part_number || null, item.interval_km || null, item.interval_months || null, item.is_condition_based || 0, base + idx, item.notes || null);
        added++; byName.set(key, -1);
      }
    });
  });
  txn();
  return { updated, added, total: items.length };
}

app.get('/api/ai/status', requireAuth, (req, res) => {
  res.json({ configured: !!process.env.MISTRAL_API_KEY });
});

app.post('/api/cars/:id/ai-schedule', requireAuth, async (req, res) => {
  const carId = parseInt(req.params.id);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });
  const car = db.prepare(`SELECT * FROM cars WHERE id = ?`).get(carId);
  const desc = [car.year, car.make, car.model, car.engine, car.trim].filter(Boolean).join(' ');
  if (!desc) return res.status(400).json({ error: 'Set at least make/model/year before refreshing' });
  try {
    const text = await callMistral(
      'You are a certified automotive technician. Output ONLY a raw JSON array with no wrapper object, no markdown, no explanation.',
      `Generate the complete manufacturer maintenance schedule for: ${desc}.\n\nOutput a raw JSON array (starting with [ and ending with ]). Each element:\n{"category":"Routine"|"Ignition"|"Cooling"|"Brakes"|"Suspension"|"Gaskets"|"Tyres"|"Other","name_en":"item name","name_ar":"Arabic name or null","part_number":"OEM part number or null","interval_km":integer or null,"interval_months":integer or null,"is_condition_based":0 or 1,"notes":"brief note or null"}\n\nInclude: engine oil & filter, air filter, cabin filter, spark plugs (petrol only), brake fluid, coolant, transmission fluid, brake pads (front+rear), brake discs (front+rear), tyre rotation, wiper blades, battery, timing belt/chain inspection, and any model-specific items. Use official manufacturer intervals.`
    );
    let items;
    try { items = extractJSON(text); } catch (e) {
      console.error('[AI schedule] parse error. Raw response:', text);
      throw new Error('AI returned unexpected format');
    }
    if (!Array.isArray(items)) {
      console.error('[AI schedule] not an array. Raw response:', text);
      throw new Error('AI returned unexpected format');
    }
    res.json(mergeAISchedule(carId, items));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/items/:id/ai-parts', requireAuth, async (req, res) => {
  const itemId = parseInt(req.params.id);
  if (!userOwnsItem(itemId, req.user.id)) return res.status(404).json({ error: 'Not found' });
  const item = db.prepare(`SELECT si.*, c.make, c.model, c.year, c.engine FROM service_items si JOIN cars c ON c.id = si.car_id WHERE si.id = ?`).get(itemId);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const carDesc = [item.year, item.make, item.model, item.engine].filter(Boolean).join(' ') || 'unknown vehicle';
  try {
    const text = await callMistral(
      'You are an automotive parts expert. Respond ONLY with a valid JSON array — no markdown, no explanations.',
      `For a ${carDesc}, the service item is: "${item.name_en}"${item.part_number ? ` (OEM: ${item.part_number})` : ''}.\n\nList 3-5 quality aftermarket alternatives from brands like Mahle, Mann-Filter, Hengst, Bosch, Valeo, NGK, Denso, ACDelco, Fram, Wix, Filtron, etc.\n\nReturn JSON: [{"brand":"Brand","part_number":"XXXXX"}]\n\nOnly include part numbers you are confident about. Return [] if uncertain.`,
      1200
    );
    const parts = extractJSON(text);
    if (!Array.isArray(parts)) throw new Error('Unexpected format');
    res.json(parts.slice(0, 8));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save car photo downloaded from a Wikimedia URL
app.post('/api/cars/:id/photo-from-url', requireAuth, async (req, res) => {
  const carId = parseInt(req.params.id);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });
  if (!/^https:\/\/upload\.wikimedia\.org\//.test(url)) {
    return res.status(400).json({ error: 'Only Wikimedia image URLs are supported' });
  }

  const rawExt = (url.match(/\.(\w{2,5})(?:[?#/]|$)/i)?.[1] || 'jpg').toLowerCase();
  const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
  if (!['jpg', 'png', 'webp', 'gif'].includes(ext)) return res.status(400).json({ error: 'Unsupported image type' });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const destPath = path.join(UPLOADS_DIR, filename);

  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      let totalSize = 0;
      https.get(url, { headers: { 'User-Agent': 'GarageApp/1.0 (self-hosted)' } }, (response) => {
        if (response.statusCode !== 200) {
          file.close(); fs.unlink(destPath, () => {});
          return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        }
        response.on('data', chunk => {
          totalSize += chunk.length;
          if (totalSize > 15 * 1024 * 1024) {
            response.destroy(); file.close(); fs.unlink(destPath, () => {});
            reject(new Error('Image too large'));
          }
        });
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', err => { fs.unlink(destPath, () => {}); reject(err); });
      }).on('error', err => { fs.unlink(destPath, () => {}); reject(err); });
    });

    const old = db.prepare(`SELECT photo_filename FROM cars WHERE id = ?`).get(carId);
    if (old?.photo_filename) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, old.photo_filename)); } catch {}
    }
    db.prepare(`UPDATE cars SET photo_filename = ? WHERE id = ?`).run(filename, carId);
    res.json({ filename });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Download failed' });
  }
});

app.delete('/api/cars/:id', requireAuth, (req, res) => {
  const carId = parseInt(req.params.id);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE cars SET is_active = 0 WHERE id = ? AND user_id = ?`).run(carId, req.user.id);
  res.json({ ok: true });
});

// ─── Service items ───
app.get('/api/cars/:carId/items', requireAuth, (req, res) => {
  const carId = parseInt(req.params.carId);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const items = db.prepare(`
    SELECT si.*,
      (SELECT json_object(
        'id', sl.id, 'service_date', sl.service_date, 'odometer_km', sl.odometer_km,
        'cost', sl.cost, 'currency', sl.currency, 'workshop', sl.workshop, 'notes', sl.notes
      ) FROM service_log sl
        WHERE sl.service_item_id = si.id
        ORDER BY sl.odometer_km DESC LIMIT 1) AS last_service_json
    FROM service_items si
    WHERE si.car_id = ?
    ORDER BY si.category, si.sort_order, si.id
  `).all(carId);

  const car = db.prepare(`SELECT current_km FROM cars WHERE id = ?`).get(carId);
  const currentKm = car ? car.current_km : 0;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const enriched = items.map(it => {
    const last = it.last_service_json ? JSON.parse(it.last_service_json) : null;
    let next_due_km = null;
    let next_due_date = null;
    let days_until = null;
    let status = 'ok';

    if (it.is_condition_based) {
      status = 'condition';
    } else {
      // KM-based check
      let kmStatus = null;
      if (it.interval_km) {
        const baseKm = last ? last.odometer_km : 0;
        next_due_km = baseKm + it.interval_km;
        const remaining = next_due_km - currentKm;
        if (!last && currentKm >= it.interval_km) kmStatus = 'overdue';
        else if (remaining < 0) kmStatus = 'overdue';
        else if (remaining < 1500) kmStatus = 'due_soon';
        else if (last) kmStatus = 'ok';
        else kmStatus = 'never';
      }

      // Time-based check
      let timeStatus = null;
      if (it.interval_months && last && last.service_date) {
        const lastDate = new Date(last.service_date);
        const due = new Date(lastDate);
        due.setMonth(due.getMonth() + it.interval_months);
        next_due_date = due.toISOString().slice(0, 10);
        const msPerDay = 1000 * 60 * 60 * 24;
        days_until = Math.floor((due.getTime() - today.getTime()) / msPerDay);
        if (days_until < 0) timeStatus = 'overdue';
        else if (days_until < 30) timeStatus = 'due_soon';
        else timeStatus = 'ok';
      } else if (it.interval_months && !last) {
        timeStatus = 'never';
      }

      // Combine: worst status wins
      const order = { ok: 0, never: 1, due_soon: 2, overdue: 3 };
      const candidates = [kmStatus, timeStatus].filter(Boolean);
      if (candidates.length === 0) {
        status = 'ok';
      } else {
        status = candidates.reduce((a, b) => (order[a] >= order[b] ? a : b));
      }
    }

    delete it.last_service_json;
    return { ...it, last_service: last, next_due_km, next_due_date, days_until, status };
  });

  res.json(enriched);
});

app.post('/api/cars/:carId/items', requireAuth, (req, res) => {
  const carId = parseInt(req.params.carId);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });
  const { category, name_en, name_ar, part_number, interval_km, interval_months, is_condition_based, notes } = req.body;
  const result = db.prepare(`
    INSERT INTO service_items (car_id, category, name_en, name_ar, part_number, interval_km, interval_months, is_condition_based, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(carId, category, name_en, name_ar, part_number, interval_km, interval_months, is_condition_based ? 1 : 0, notes);
  res.json({ id: result.lastInsertRowid });
});

function userOwnsItem(itemId, userId) {
  const row = db.prepare(`
    SELECT c.user_id FROM service_items si JOIN cars c ON c.id = si.car_id WHERE si.id = ?
  `).get(itemId);
  return row && row.user_id === userId;
}

app.put('/api/items/:id', requireAuth, (req, res) => {
  const itemId = parseInt(req.params.id);
  if (!userOwnsItem(itemId, req.user.id)) return res.status(404).json({ error: 'Not found' });
  const { category, name_en, name_ar, part_number, interval_km, interval_months, is_condition_based, notes } = req.body;
  db.prepare(`
    UPDATE service_items SET category=?, name_en=?, name_ar=?, part_number=?, interval_km=?, interval_months=?, is_condition_based=?, notes=?
    WHERE id = ?
  `).run(category, name_en, name_ar, part_number, interval_km, interval_months, is_condition_based ? 1 : 0, notes, itemId);
  res.json({ ok: true });
});

// Quick part-number/interval-only update
app.patch('/api/items/:id/part', requireAuth, (req, res) => {
  const itemId = parseInt(req.params.id);
  if (!userOwnsItem(itemId, req.user.id)) return res.status(404).json({ error: 'Not found' });
  const { part_number, interval_km, interval_months } = req.body;

  // Build SET clause dynamically based on what's provided
  const updates = [];
  const values = [];
  if (part_number !== undefined) {
    updates.push('part_number = ?');
    values.push(part_number || null);
  }
  if (interval_km !== undefined) {
    updates.push('interval_km = ?');
    values.push(interval_km != null ? parseInt(interval_km) || null : null);
  }
  if (interval_months !== undefined) {
    updates.push('interval_months = ?');
    values.push(interval_months != null ? parseInt(interval_months) || null : null);
  }
  if (updates.length === 0) return res.json({ ok: true });

  values.push(itemId);
  db.prepare(`UPDATE service_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// ─── Part alternatives ───
app.get('/api/items/:id/parts', requireAuth, (req, res) => {
  const itemId = parseInt(req.params.id);
  if (!userOwnsItem(itemId, req.user.id)) return res.status(404).json({ error: 'Not found' });
  const parts = db.prepare(`SELECT * FROM part_alternatives WHERE service_item_id = ? ORDER BY type DESC, id`).all(itemId);
  res.json(parts);
});

app.post('/api/items/:id/parts', requireAuth, (req, res) => {
  const itemId = parseInt(req.params.id);
  if (!userOwnsItem(itemId, req.user.id)) return res.status(404).json({ error: 'Not found' });
  const { brand, part_number, type } = req.body;
  if (!brand || !part_number) return res.status(400).json({ error: 'brand and part_number required' });
  const result = db.prepare(`
    INSERT INTO part_alternatives (service_item_id, brand, part_number, type) VALUES (?, ?, ?, ?)
  `).run(itemId, brand.trim(), part_number.trim(), type === 'oem' ? 'oem' : 'aftermarket');
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/parts/:altId', requireAuth, (req, res) => {
  const altId = parseInt(req.params.altId);
  const row = db.prepare(`
    SELECT c.user_id FROM part_alternatives pa
    JOIN service_items si ON si.id = pa.service_item_id
    JOIN cars c ON c.id = si.car_id
    WHERE pa.id = ?
  `).get(altId);
  if (!row || row.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM part_alternatives WHERE id = ?`).run(altId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════
// FUEL LOG
// ═══════════════════════════════════════════════════
app.get('/api/cars/:carId/fuel', requireAuth, (req, res) => {
  const carId = parseInt(req.params.carId);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const fills = db.prepare(`
    SELECT * FROM fuel_log WHERE car_id = ? ORDER BY odometer_km DESC, fill_date DESC
  `).all(carId);

  // Compute economy between consecutive full-tank fills
  // Sort ascending by km for calc, then reverse
  const ascending = [...fills].sort((a, b) => a.odometer_km - b.odometer_km);
  const enriched = ascending.map((f, idx) => {
    if (idx === 0 || !f.full_tank) return { ...f, km_since: null, kml: null, l100: null, cost_per_km: null };
    const prev = ascending[idx - 1];
    const km_since = f.odometer_km - prev.odometer_km;
    if (km_since <= 0 || !f.full_tank) return { ...f, km_since: null, kml: null, l100: null, cost_per_km: null };
    const kml = +(km_since / f.liters).toFixed(2);
    const l100 = +((f.liters / km_since) * 100).toFixed(2);
    const cost_per_km = +(f.total_cost / km_since).toFixed(3);
    return { ...f, km_since, kml, l100, cost_per_km };
  });
  // Return most-recent first
  res.json(enriched.reverse());
});

app.post('/api/cars/:carId/fuel', requireAuth, (req, res) => {
  const carId = parseInt(req.params.carId);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const { fill_date, odometer_km, liters, total_cost, currency, fuel_type, station, full_tank, notes } = req.body;
  if (!fill_date || !odometer_km || !liters || total_cost == null) {
    return res.status(400).json({ error: 'date, odometer, liters, and cost are required' });
  }

  const result = db.prepare(`
    INSERT INTO fuel_log (car_id, fill_date, odometer_km, liters, total_cost, currency, fuel_type, station, full_tank, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(carId, fill_date, parseInt(odometer_km) || 0, parseFloat(liters) || 0,
         parseFloat(total_cost) || 0, currency || 'SAR', fuel_type || '95',
         station || null, full_tank ? 1 : 0, notes || null);

  // Update car's current_km if higher
  db.prepare(`UPDATE cars SET current_km = MAX(current_km, ?) WHERE id = ?`).run(parseInt(odometer_km) || 0, carId);

  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/fuel/:id', requireAuth, (req, res) => {
  const fid = parseInt(req.params.id);
  const row = db.prepare(`
    SELECT f.*, c.user_id FROM fuel_log f JOIN cars c ON c.id = f.car_id WHERE f.id = ?
  `).get(fid);
  if (!row || row.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM fuel_log WHERE id = ?`).run(fid);
  res.json({ ok: true });
});

app.get('/api/cars/:carId/fuel/stats', requireAuth, (req, res) => {
  const carId = parseInt(req.params.carId);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const fills = db.prepare(`SELECT * FROM fuel_log WHERE car_id = ? ORDER BY odometer_km ASC`).all(carId);
  if (fills.length < 2) {
    return res.json({
      total_spent: fills.reduce((s, f) => s + f.total_cost, 0),
      total_liters: fills.reduce((s, f) => s + f.liters, 0),
      fill_count: fills.length,
      avg_kml: null, avg_l100: null, avg_cost_per_km: null,
      monthly: [],
    });
  }

  // Compute averages over full tanks only
  let totalKm = 0, totalLiters = 0, totalCost = 0;
  for (let i = 1; i < fills.length; i++) {
    if (!fills[i].full_tank) continue;
    const km = fills[i].odometer_km - fills[i - 1].odometer_km;
    if (km <= 0) continue;
    totalKm += km;
    totalLiters += fills[i].liters;
    totalCost += fills[i].total_cost;
  }

  const avg_kml = totalLiters > 0 ? +(totalKm / totalLiters).toFixed(2) : null;
  const avg_l100 = totalKm > 0 ? +((totalLiters / totalKm) * 100).toFixed(2) : null;
  const avg_cost_per_km = totalKm > 0 ? +(totalCost / totalKm).toFixed(3) : null;

  // Monthly aggregation
  const monthlyMap = {};
  fills.forEach(f => {
    const month = f.fill_date.slice(0, 7);
    if (!monthlyMap[month]) monthlyMap[month] = { month, cost: 0, liters: 0, fills: 0 };
    monthlyMap[month].cost += f.total_cost;
    monthlyMap[month].liters += f.liters;
    monthlyMap[month].fills += 1;
  });
  const monthly = Object.values(monthlyMap).sort((a, b) => a.month.localeCompare(b.month));

  res.json({
    total_spent: fills.reduce((s, f) => s + f.total_cost, 0),
    total_liters: fills.reduce((s, f) => s + f.liters, 0),
    fill_count: fills.length,
    avg_kml, avg_l100, avg_cost_per_km,
    last_full: fills[fills.length - 1].odometer_km,
    currency: fills[fills.length - 1].currency || 'SAR',
    monthly,
  });
});

// ═══════════════════════════════════════════════════
// SERVICE TEMPLATES (workshop bundles)
// ═══════════════════════════════════════════════════
app.get('/api/cars/:carId/templates', requireAuth, (req, res) => {
  const carId = parseInt(req.params.carId);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const templates = db.prepare(`SELECT * FROM templates WHERE car_id = ? ORDER BY name`).all(carId);
  const enriched = templates.map(t => {
    const items = db.prepare(`
      SELECT ti.id, ti.service_item_id, ti.estimated_cost, si.name_en, si.category, si.part_number
      FROM template_items ti
      JOIN service_items si ON si.id = ti.service_item_id
      WHERE ti.template_id = ?
      ORDER BY si.category
    `).all(t.id);
    const total = items.reduce((s, i) => s + (i.estimated_cost || 0), 0);
    return { ...t, items, item_count: items.length, total_estimated: total };
  });
  res.json(enriched);
});

app.post('/api/cars/:carId/templates', requireAuth, (req, res) => {
  const carId = parseInt(req.params.carId);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const { name, workshop, notes, items } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const result = db.prepare(`
    INSERT INTO templates (car_id, name, workshop, notes) VALUES (?, ?, ?, ?)
  `).run(carId, name, workshop || null, notes || null);

  const tid = result.lastInsertRowid;
  if (Array.isArray(items)) {
    const stmt = db.prepare(`
      INSERT INTO template_items (template_id, service_item_id, estimated_cost) VALUES (?, ?, ?)
    `);
    items.forEach(it => {
      stmt.run(tid, parseInt(it.service_item_id), parseFloat(it.estimated_cost) || 0);
    });
  }
  res.json({ id: tid });
});

app.put('/api/templates/:id', requireAuth, (req, res) => {
  const tid = parseInt(req.params.id);
  const t = db.prepare(`
    SELECT t.*, c.user_id FROM templates t JOIN cars c ON c.id = t.car_id WHERE t.id = ?
  `).get(tid);
  if (!t || t.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });

  const { name, workshop, notes, items } = req.body;
  db.prepare(`UPDATE templates SET name = ?, workshop = ?, notes = ? WHERE id = ?`)
    .run(name || t.name, workshop || null, notes || null, tid);

  if (Array.isArray(items)) {
    db.prepare(`DELETE FROM template_items WHERE template_id = ?`).run(tid);
    const stmt = db.prepare(`
      INSERT INTO template_items (template_id, service_item_id, estimated_cost) VALUES (?, ?, ?)
    `);
    items.forEach(it => {
      stmt.run(tid, parseInt(it.service_item_id), parseFloat(it.estimated_cost) || 0);
    });
  }
  res.json({ ok: true });
});

app.delete('/api/templates/:id', requireAuth, (req, res) => {
  const tid = parseInt(req.params.id);
  const t = db.prepare(`
    SELECT t.user_id FROM templates t JOIN cars c ON c.id = t.car_id WHERE t.id = ?
  `).get(tid);
  // Different join — let me redo:
  const t2 = db.prepare(`
    SELECT c.user_id FROM templates t JOIN cars c ON c.id = t.car_id WHERE t.id = ?
  `).get(tid);
  if (!t2 || t2.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM templates WHERE id = ?`).run(tid);
  res.json({ ok: true });
});

// Apply template — log all items in template at once
app.post('/api/templates/:id/apply', requireAuth, (req, res) => {
  const tid = parseInt(req.params.id);
  const t = db.prepare(`
    SELECT t.*, c.user_id, c.id AS car_id_check FROM templates t JOIN cars c ON c.id = t.car_id WHERE t.id = ?
  `).get(tid);
  if (!t || t.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });

  const { service_date, odometer_km, currency, workshop, notes } = req.body;
  if (!service_date || odometer_km == null) {
    return res.status(400).json({ error: 'date and odometer required' });
  }

  const items = db.prepare(`
    SELECT * FROM template_items WHERE template_id = ?
  `).all(tid);
  if (items.length === 0) return res.status(400).json({ error: 'Template has no items' });

  const insertStmt = db.prepare(`
    INSERT INTO service_log (service_item_id, car_id, service_date, odometer_km, cost, currency, workshop, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const txn = db.transaction(() => {
    items.forEach(it => {
      insertStmt.run(
        it.service_item_id, t.car_id,
        service_date, parseInt(odometer_km) || 0,
        it.estimated_cost || 0, currency || 'SAR',
        workshop || t.workshop || null,
        notes || `Applied from template: ${t.name}`
      );
    });
    db.prepare(`UPDATE cars SET current_km = MAX(current_km, ?) WHERE id = ?`).run(parseInt(odometer_km) || 0, t.car_id);
  });
  txn();
  res.json({ logged: items.length });
});

// Refresh Audi A6 schedule on existing car (preserves service history)
// Updates intervals + part numbers on matching items by name_en, adds any missing items
app.post('/api/cars/:carId/refresh-audi-schedule', requireAuth, (req, res) => {
  const carId = parseInt(req.params.carId);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const { refreshAudiA6Schedule } = require('./database');
  const result = refreshAudiA6Schedule(carId);
  res.json(result);
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  const itemId = parseInt(req.params.id);
  if (!userOwnsItem(itemId, req.user.id)) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM service_items WHERE id = ?`).run(itemId);
  res.json({ ok: true });
});

// ─── Service log ───
app.get('/api/items/:itemId/logs', requireAuth, (req, res) => {
  const itemId = parseInt(req.params.itemId);
  if (!userOwnsItem(itemId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const logs = db.prepare(`
    SELECT sl.*,
      (SELECT json_group_array(json_object(
        'id', a.id, 'filename', a.filename, 'original_name', a.original_name, 'mime_type', a.mime_type
      )) FROM attachments a WHERE a.log_id = sl.id) AS attachments_json
    FROM service_log sl WHERE sl.service_item_id = ?
    ORDER BY sl.odometer_km DESC
  `).all(itemId);
  res.json(logs.map(l => ({ ...l, attachments: JSON.parse(l.attachments_json || '[]') })));
});

app.post('/api/items/:itemId/logs', requireAuth, (req, res) => {
  const itemId = parseInt(req.params.itemId);
  if (!userOwnsItem(itemId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const { service_date, odometer_km, cost, currency, workshop, notes } = req.body;
  const item = db.prepare(`SELECT car_id FROM service_items WHERE id = ?`).get(itemId);

  const result = db.prepare(`
    INSERT INTO service_log (service_item_id, car_id, service_date, odometer_km, cost, currency, workshop, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(itemId, item.car_id, service_date, odometer_km, cost || 0, currency || 'SAR', workshop, notes);

  db.prepare(`UPDATE cars SET current_km = MAX(current_km, ?) WHERE id = ?`).run(odometer_km, item.car_id);
  res.json({ id: result.lastInsertRowid });
});

function userOwnsLog(logId, userId) {
  const row = db.prepare(`
    SELECT c.user_id FROM service_log sl JOIN cars c ON c.id = sl.car_id WHERE sl.id = ?
  `).get(logId);
  return row && row.user_id === userId;
}

app.delete('/api/logs/:id', requireAuth, (req, res) => {
  const logId = parseInt(req.params.id);
  if (!userOwnsLog(logId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const attachments = db.prepare(`SELECT filename FROM attachments WHERE log_id = ?`).all(logId);
  attachments.forEach(a => {
    const filePath = path.join(UPLOADS_DIR, a.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });
  db.prepare(`DELETE FROM service_log WHERE id = ?`).run(logId);
  res.json({ ok: true });
});

// ─── Attachments ───
app.post('/api/logs/:logId/attachments', requireAuth, upload.array('files', 10), (req, res) => {
  const logId = parseInt(req.params.logId);
  if (!userOwnsLog(logId, req.user.id)) {
    // Clean up uploaded files since we won't use them
    (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(404).json({ error: 'Not found' });
  }
  const stmt = db.prepare(`
    INSERT INTO attachments (log_id, filename, original_name, mime_type, size)
    VALUES (?, ?, ?, ?, ?)
  `);
  const files = (req.files || []).map(f => {
    const r = stmt.run(logId, f.filename, f.originalname, f.mimetype, f.size);
    return { id: r.lastInsertRowid, filename: f.filename, original_name: f.originalname, mime_type: f.mimetype };
  });
  res.json(files);
});

app.delete('/api/attachments/:id', requireAuth, (req, res) => {
  const attId = parseInt(req.params.id);
  const att = db.prepare(`
    SELECT a.*, c.user_id FROM attachments a
    JOIN service_log sl ON sl.id = a.log_id
    JOIN cars c ON c.id = sl.car_id
    WHERE a.id = ?
  `).get(attId);
  if (!att || att.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(UPLOADS_DIR, att.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare(`DELETE FROM attachments WHERE id = ?`).run(attId);
  res.json({ ok: true });
});

// Serve uploads — but only to authenticated users (their own files)
app.get('/uploads/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename;

  // Check if it's a car photo
  const car = db.prepare(`SELECT user_id FROM cars WHERE photo_filename = ?`).get(filename);
  if (car && car.user_id === req.user.id) {
    return res.sendFile(path.join(UPLOADS_DIR, filename));
  }

  // Check if it's a service log attachment
  const att = db.prepare(`
    SELECT a.filename, c.user_id FROM attachments a
    JOIN service_log sl ON sl.id = a.log_id
    JOIN cars c ON c.id = sl.car_id
    WHERE a.filename = ?
  `).get(filename);
  if (att && att.user_id === req.user.id) {
    return res.sendFile(path.join(UPLOADS_DIR, filename));
  }

  res.status(404).send('Not found');
});

// ─── Dashboard ───
app.get('/api/cars/:carId/dashboard', requireAuth, (req, res) => {
  const carId = parseInt(req.params.carId);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const car = db.prepare(`SELECT * FROM cars WHERE id = ?`).get(carId);
  const totalCost = db.prepare(`SELECT COALESCE(SUM(cost), 0) AS total FROM service_log WHERE car_id = ?`).get(carId);
  const recentLogs = db.prepare(`
    SELECT sl.*, si.name_en, si.category FROM service_log sl
    JOIN service_items si ON si.id = sl.service_item_id
    WHERE sl.car_id = ? ORDER BY sl.service_date DESC LIMIT 10
  `).all(carId);

  res.json({ car, total_cost: totalCost.total, recent_logs: recentLogs });
});

// ─── Exports ───
app.get('/api/cars/:carId/export.xlsx', requireAuth, async (req, res) => {
  const carId = parseInt(req.params.carId);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const car = db.prepare(`SELECT * FROM cars WHERE id = ?`).get(carId);
  const items = db.prepare(`
    SELECT si.*,
      (SELECT MAX(odometer_km) FROM service_log WHERE service_item_id = si.id) AS last_km,
      (SELECT MAX(service_date) FROM service_log WHERE service_item_id = si.id) AS last_date,
      (SELECT COALESCE(SUM(cost), 0) FROM service_log WHERE service_item_id = si.id) AS total_cost
    FROM service_items si WHERE si.car_id = ?
    ORDER BY si.category, si.sort_order
  `).all(carId);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Schedule');
  ws.columns = [
    { header: 'Category', key: 'category', width: 14 },
    { header: 'Item (EN)', key: 'name_en', width: 40 },
    { header: 'Item (AR)', key: 'name_ar', width: 30 },
    { header: 'Part #', key: 'part_number', width: 16 },
    { header: 'Interval (km)', key: 'interval_km', width: 14 },
    { header: 'Last Service (km)', key: 'last_km', width: 16 },
    { header: 'Last Date', key: 'last_date', width: 14 },
    { header: 'Next Due (km)', key: 'next_due', width: 14 },
    { header: 'Total Cost', key: 'total_cost', width: 12 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };

  items.forEach(it => {
    ws.addRow({
      category: it.category, name_en: it.name_en, name_ar: it.name_ar,
      part_number: it.part_number, interval_km: it.interval_km,
      last_km: it.last_km, last_date: it.last_date,
      next_due: it.last_km && it.interval_km ? it.last_km + it.interval_km : (it.interval_km || ''),
      total_cost: it.total_cost,
    });
  });

  const logs = db.prepare(`
    SELECT sl.*, si.name_en, si.category FROM service_log sl
    JOIN service_items si ON si.id = sl.service_item_id
    WHERE sl.car_id = ? ORDER BY sl.service_date DESC
  `).all(carId);
  const ws2 = wb.addWorksheet('Service Log');
  ws2.columns = [
    { header: 'Date', key: 'service_date', width: 12 },
    { header: 'Category', key: 'category', width: 14 },
    { header: 'Service', key: 'name_en', width: 40 },
    { header: 'Odometer (km)', key: 'odometer_km', width: 14 },
    { header: 'Cost', key: 'cost', width: 10 },
    { header: 'Currency', key: 'currency', width: 8 },
    { header: 'Workshop', key: 'workshop', width: 20 },
    { header: 'Notes', key: 'notes', width: 30 },
  ];
  ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  logs.forEach(l => ws2.addRow(l));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${car.name.replace(/[^a-z0-9]/gi, '_')}_maintenance.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

app.get('/api/cars/:carId/export.pdf', requireAuth, (req, res) => {
  const carId = parseInt(req.params.carId);
  if (!userOwnsCar(carId, req.user.id)) return res.status(404).json({ error: 'Not found' });

  const car = db.prepare(`SELECT * FROM cars WHERE id = ?`).get(carId);
  const logs = db.prepare(`
    SELECT sl.*, si.name_en, si.category FROM service_log sl
    JOIN service_items si ON si.id = sl.service_item_id
    WHERE sl.car_id = ? ORDER BY sl.service_date DESC
  `).all(carId);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${car.name.replace(/[^a-z0-9]/gi, '_')}_log.pdf"`);
  doc.pipe(res);

  doc.fontSize(20).fillColor('#1F4E78').text(`${car.name} — Service Log`, { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#666').text(
    `${car.year || ''} ${car.make || ''} ${car.model || ''}  •  Current: ${car.current_km.toLocaleString()} km`,
    { align: 'center' }
  );
  doc.moveDown();

  const totalCost = logs.reduce((s, l) => s + (l.cost || 0), 0);
  doc.fontSize(11).fillColor('#000').text(`Total entries: ${logs.length}    Total spent: ${totalCost.toFixed(2)} ${logs[0]?.currency || 'SAR'}`);
  doc.moveDown();

  logs.forEach(l => {
    doc.fontSize(11).fillColor('#1F4E78').text(`${l.service_date} — ${l.name_en}`, { continued: false });
    doc.fontSize(9).fillColor('#444').text(
      `   ${l.odometer_km.toLocaleString()} km  •  ${l.cost || 0} ${l.currency}  •  ${l.workshop || '—'}`
    );
    if (l.notes) doc.fontSize(9).fillColor('#666').text(`   ${l.notes}`);
    doc.moveDown(0.4);
  });

  doc.end();
});

// ─── Static frontend (public) ───
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔧 Garage running on http://0.0.0.0:${PORT}`);
  console.log(`📁 Data dir: ${DATA_DIR}`);
  console.log(`👥 Users in database: ${auth.userCount()}`);
});
