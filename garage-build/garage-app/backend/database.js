const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'garage.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    user_agent TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    ip TEXT,
    success INTEGER DEFAULT 0,
    attempted_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    make TEXT,
    model TEXT,
    year INTEGER,
    vin TEXT,
    plate TEXT,
    current_km INTEGER DEFAULT 0,
    notes TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS service_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    car_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    name_en TEXT NOT NULL,
    name_ar TEXT,
    part_number TEXT,
    interval_km INTEGER,
    interval_months INTEGER,
    is_condition_based INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    notes TEXT,
    FOREIGN KEY (car_id) REFERENCES cars(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS service_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_item_id INTEGER NOT NULL,
    car_id INTEGER NOT NULL,
    service_date TEXT NOT NULL,
    odometer_km INTEGER NOT NULL,
    cost REAL DEFAULT 0,
    currency TEXT DEFAULT 'SAR',
    workshop TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (service_item_id) REFERENCES service_items(id) ON DELETE CASCADE,
    FOREIGN KEY (car_id) REFERENCES cars(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT,
    mime_type TEXT,
    size INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (log_id) REFERENCES service_log(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS fuel_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    car_id INTEGER NOT NULL,
    fill_date TEXT NOT NULL,
    odometer_km INTEGER NOT NULL,
    liters REAL NOT NULL,
    total_cost REAL NOT NULL,
    currency TEXT DEFAULT 'SAR',
    fuel_type TEXT DEFAULT '95',
    station TEXT,
    full_tank INTEGER DEFAULT 1,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (car_id) REFERENCES cars(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    car_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    workshop TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (car_id) REFERENCES cars(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS template_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL,
    service_item_id INTEGER NOT NULL,
    estimated_cost REAL DEFAULT 0,
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
    FOREIGN KEY (service_item_id) REFERENCES service_items(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_log_car ON service_log(car_id);
  CREATE INDEX IF NOT EXISTS idx_log_item ON service_log(service_item_id);
  CREATE INDEX IF NOT EXISTS idx_items_car ON service_items(car_id);
  CREATE INDEX IF NOT EXISTS idx_cars_user ON cars(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_ip ON login_attempts(ip, attempted_at);
  CREATE INDEX IF NOT EXISTS idx_fuel_car ON fuel_log(car_id, fill_date DESC);
  CREATE INDEX IF NOT EXISTS idx_template_car ON templates(car_id);

  CREATE TABLE IF NOT EXISTS part_alternatives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_item_id INTEGER NOT NULL,
    brand TEXT NOT NULL,
    part_number TEXT NOT NULL,
    type TEXT DEFAULT 'aftermarket',
    FOREIGN KEY (service_item_id) REFERENCES service_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_parts_item ON part_alternatives(service_item_id);
`);

// ─── Migration: add user_id column to existing cars table if missing ───
function migrate() {
  const cols = db.prepare("PRAGMA table_info(cars)").all();
  const colNames = cols.map(c => c.name);

  if (!colNames.includes('user_id')) {
    console.log('🔄 Migrating: adding user_id to cars');
    db.exec(`ALTER TABLE cars ADD COLUMN user_id INTEGER`);
  }
  if (!colNames.includes('photo_filename')) {
    console.log('🔄 Migrating: adding photo_filename to cars');
    db.exec(`ALTER TABLE cars ADD COLUMN photo_filename TEXT`);
  }
  if (!colNames.includes('color')) {
    console.log('🔄 Migrating: adding color/trim/power fields to cars');
    db.exec(`ALTER TABLE cars ADD COLUMN color TEXT`);
    db.exec(`ALTER TABLE cars ADD COLUMN trim TEXT`);
    db.exec(`ALTER TABLE cars ADD COLUMN power_hp INTEGER`);
    db.exec(`ALTER TABLE cars ADD COLUMN torque_nm INTEGER`);
    db.exec(`ALTER TABLE cars ADD COLUMN tune_stage TEXT`);
    db.exec(`ALTER TABLE cars ADD COLUMN tune_power_hp INTEGER`);
    db.exec(`ALTER TABLE cars ADD COLUMN tune_torque_nm INTEGER`);
  }
}
migrate();

// ─── Session cleanup (run on startup + every hour) ───
function cleanupSessions() {
  const result = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  if (result.changes > 0) console.log(`🧹 Cleaned ${result.changes} expired sessions`);
  // Clean old login attempts (keep last 24h)
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-24 hours')").run();
}
cleanupSessions();
setInterval(cleanupSessions, 60 * 60 * 1000);

// ─── Audi A6 schedule seed (2023 official spec, hot-climate oil interval) ───
function seedAudiA6(carId) {
  const items = [
    // ─── Routine ─── (oil 10k km hot-climate, official Audi 15k otherwise)
    ['Routine', 'Engine Oil & Filter (0W-20 VW 508 00) — 5.2 L', 'تغيير زيت المحرك + فلتر الزيت', '06L115562B', 10000, 12, 0],
    ['Routine', 'Fluids Level Check', 'فحص مستوى السوائل', null, 10000, null, 0],
    ['Routine', 'Tyre Pressure & Condition', 'فحص الإطارات والضغط', null, 10000, null, 0],
    ['Routine', 'Brake Visual Inspection', 'فحص المكابح (بصري)', null, 15000, null, 0],
    ['Routine', 'Cabin / Pollen Filter', 'تغيير فلتر الكابين', '4M0819439B', 30000, 24, 0],
    ['Routine', 'Engine Air Filter', 'تغيير فلتر الهواء', '4K0133844E', 90000, null, 0],
    ['Routine', 'Standard Service (chassis, lubrication, lighting)', 'فحص شامل', null, 30000, 24, 0],
    ['Routine', 'Brake Fluid (DOT 4 LV) — 1.0 L', 'تغيير سائل الفرامل', 'B000750M3', null, 24, 0],
    ['Routine', 'Battery Test (AGM)', 'فحص البطارية', null, 30000, null, 0],
    ['Routine', 'Accessory / Ribbed V-Belt', 'حزام الإكسسوارات', '06L903137L', 90000, null, 0],
    ['Routine', 'S-Tronic (DL382) Oil + Filter', 'زيت ناقل الحركة + فلتر', '0CK398009', 60000, null, 0],
    ['Routine', 'Quattro / Rear Diff Oil', 'زيت الديفرنشل الخلفي', 'G055175A2', 60000, null, 0],
    ['Routine', 'A/C Service (R1234yf, 510 g)', 'صيانة المكيف والفريون', null, 60000, null, 0],
    ['Routine', 'Coolant Change (G13) — 10.0 L', 'تغيير سائل التبريد', 'G013A8JM1', null, 60, 0],

    // ─── Ignition & Fuel ─── (spark plugs 64k mi official, kept at 60k for hot climate)
    ['Ignition', 'Spark Plugs (4 pcs)', 'شمعات الإشعال', '06K905601B', 60000, 72, 0],
    ['Ignition', 'Ignition Coils (4 pcs)', 'بوبينات الإشعال', '06L905110K', 120000, null, 0],
    ['Ignition', 'Intake Valve Carbon Cleaning', 'تنظيف الكربون', null, 120000, null, 0],
    ['Ignition', 'PCV Valve Inspection', 'فحص صمام PCV', '06K103495AS', 120000, null, 0],
    ['Ignition', 'High Pressure Fuel Pump Inspection', 'فحص مضخة الوقود عالية الضغط', '06L127025M', null, null, 1],
    ['Ignition', 'Fuel Injectors', 'بخاخات الوقود', '06L906036H', null, null, 1],

    // ─── Cooling ───
    ['Cooling', 'Thermostat Housing', 'بيت الثرموستات', '06L121111H', null, null, 1],
    ['Cooling', 'Coolant Hoses Inspection', 'فحص خراطيم التبريد', null, null, null, 1],
    ['Cooling', 'Coolant Expansion Tank', 'خزان التبريد التمددي', '8W0121403J', null, null, 1],
    ['Cooling', 'Water Pump', 'مضخة الماء', '06L121011', null, null, 1],

    // ─── Gaskets ───
    ['Gaskets', 'Valve Cover Gasket', 'جوان غطاء الكامات', '06K103483F', null, null, 1],
    ['Gaskets', 'Oil Filter Housing Gasket', 'جوان بيت فلتر الزيت', '06L115441', null, null, 1],
    ['Gaskets', 'Oil Pan Gasket / Sealant', 'جوان كرتير الزيت', '06L103153D', null, null, 1],
    ['Gaskets', 'Camshaft Adjuster Seals', 'سيلات الكام فيزر', '06L109571', null, null, 1],
    ['Gaskets', 'Turbo Oil & Coolant Line Gaskets', 'جوانات أنابيب التيربو', null, null, null, 1],
    ['Gaskets', 'Timing Chain Inspection (NO belt)', 'فحص جنزير التوقيت', null, null, null, 1],

    // ─── Brakes ───
    ['Brakes', 'Front Brake Pads', 'تيل المكابح الأمامي', '4M0698151AG', 50000, null, 0],
    ['Brakes', 'Rear Brake Pads', 'تيل المكابح الخلفي', '4M0698451N', 50000, null, 0],
    ['Brakes', 'Front Brake Discs', 'ديسكات المكابح الأمامية', '4M0615301AT', 100000, null, 0],
    ['Brakes', 'Rear Brake Discs', 'ديسكات المكابح الخلفية', '4M0615601P', 100000, null, 0],
    ['Brakes', 'Caliper Guide Pins Clean & Grease', 'تشحيم مسامير الكاليبر', null, null, null, 1],

    // ─── Suspension ───
    ['Suspension', 'Front Control Arm Bushings', 'كراسي المقصات الأمامية', '4K0407151', null, null, 1],
    ['Suspension', 'Tie Rod Ends', 'بيلات الدركسيون', '4M0419811B', null, null, 1],
    ['Suspension', 'Sway Bar End Links', 'جوانات الموازن', '4K0411317A', null, null, 1],
    ['Suspension', 'Strut Mounts', 'قواعد المساعدات', '4K0412377', null, null, 1],

    // ─── Tyres & Other ───
    ['Tyres', 'Tyre Rotation', 'تدوير الإطارات', null, 10000, null, 0],
    ['Tyres', 'Wheel Alignment Check', 'فحص ترصيص العجلات', null, 30000, null, 0],
    ['Other', 'AGM Battery (register with VAG-COM)', 'البطارية AGM', '000915105DH', null, 60, 0],
    ['Other', 'Engine & Transmission Mounts', 'كراسي المحرك والقير', '4M0199371AS', null, null, 1],
    ['Other', 'Cowl / Wiper Drainage Cleaning', 'تنظيف مصارف ماء الكاولة', null, null, 12, 0],
    ['Other', 'Wiper Blades', 'مساحات الزجاج', '4G1955425D', null, 12, 0],
    ['Other', 'Fragrance Cartridges (if PR 2V9)', 'كرتاج العطر', null, null, 24, 0],
  ];

  const stmt = db.prepare(`
    INSERT INTO service_items (car_id, category, name_en, name_ar, part_number, interval_km, interval_months, is_condition_based, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows) => {
    rows.forEach((row, idx) => {
      stmt.run(carId, row[0], row[1], row[2], row[3], row[4], row[5], row[6], idx);
    });
  });
  insertMany(items);
}

// ─── Refresh Audi A6 schedule on an existing car ───
// Updates intervals + part numbers + Arabic names on items that match by name_en.
// Adds any new items from the latest seed. Does NOT delete user-modified items
// or any items not in the seed (so user customizations survive).
function refreshAudiA6Schedule(carId) {
  // Re-build seed items list (same as seedAudiA6 but as data, not insert)
  const seedItems = [
    ['Routine', 'Engine Oil & Filter (0W-20 VW 508 00) — 5.2 L', 'تغيير زيت المحرك + فلتر الزيت', '06L115562B', 10000, 12, 0],
    ['Routine', 'Fluids Level Check', 'فحص مستوى السوائل', null, 10000, null, 0],
    ['Routine', 'Tyre Pressure & Condition', 'فحص الإطارات والضغط', null, 10000, null, 0],
    ['Routine', 'Brake Visual Inspection', 'فحص المكابح (بصري)', null, 15000, null, 0],
    ['Routine', 'Cabin / Pollen Filter', 'تغيير فلتر الكابين', '4M0819439B', 30000, 24, 0],
    ['Routine', 'Engine Air Filter', 'تغيير فلتر الهواء', '4K0133844E', 90000, null, 0],
    ['Routine', 'Standard Service (chassis, lubrication, lighting)', 'فحص شامل', null, 30000, 24, 0],
    ['Routine', 'Brake Fluid (DOT 4 LV) — 1.0 L', 'تغيير سائل الفرامل', 'B000750M3', null, 24, 0],
    ['Routine', 'Battery Test (AGM)', 'فحص البطارية', null, 30000, null, 0],
    ['Routine', 'Accessory / Ribbed V-Belt', 'حزام الإكسسوارات', '06L903137L', 90000, null, 0],
    ['Routine', 'S-Tronic (DL382) Oil + Filter', 'زيت ناقل الحركة + فلتر', '0CK398009', 60000, null, 0],
    ['Routine', 'Quattro / Rear Diff Oil', 'زيت الديفرنشل الخلفي', 'G055175A2', 60000, null, 0],
    ['Routine', 'A/C Service (R1234yf, 510 g)', 'صيانة المكيف والفريون', null, 60000, null, 0],
    ['Routine', 'Coolant Change (G13) — 10.0 L', 'تغيير سائل التبريد', 'G013A8JM1', null, 60, 0],
    ['Ignition', 'Spark Plugs (4 pcs)', 'شمعات الإشعال', '06K905601B', 60000, 72, 0],
    ['Ignition', 'Ignition Coils (4 pcs)', 'بوبينات الإشعال', '06L905110K', 120000, null, 0],
    ['Ignition', 'Intake Valve Carbon Cleaning', 'تنظيف الكربون', null, 120000, null, 0],
    ['Ignition', 'PCV Valve Inspection', 'فحص صمام PCV', '06K103495AS', 120000, null, 0],
    ['Ignition', 'High Pressure Fuel Pump Inspection', 'فحص مضخة الوقود عالية الضغط', '06L127025M', null, null, 1],
    ['Ignition', 'Fuel Injectors', 'بخاخات الوقود', '06L906036H', null, null, 1],
    ['Cooling', 'Thermostat Housing', 'بيت الثرموستات', '06L121111H', null, null, 1],
    ['Cooling', 'Coolant Hoses Inspection', 'فحص خراطيم التبريد', null, null, null, 1],
    ['Cooling', 'Coolant Expansion Tank', 'خزان التبريد التمددي', '8W0121403J', null, null, 1],
    ['Cooling', 'Water Pump', 'مضخة الماء', '06L121011', null, null, 1],
    ['Gaskets', 'Valve Cover Gasket', 'جوان غطاء الكامات', '06K103483F', null, null, 1],
    ['Gaskets', 'Oil Filter Housing Gasket', 'جوان بيت فلتر الزيت', '06L115441', null, null, 1],
    ['Gaskets', 'Oil Pan Gasket / Sealant', 'جوان كرتير الزيت', '06L103153D', null, null, 1],
    ['Gaskets', 'Camshaft Adjuster Seals', 'سيلات الكام فيزر', '06L109571', null, null, 1],
    ['Gaskets', 'Turbo Oil & Coolant Line Gaskets', 'جوانات أنابيب التيربو', null, null, null, 1],
    ['Gaskets', 'Timing Chain Inspection (NO belt)', 'فحص جنزير التوقيت', null, null, null, 1],
    ['Brakes', 'Front Brake Pads', 'تيل المكابح الأمامي', '4M0698151AG', 50000, null, 0],
    ['Brakes', 'Rear Brake Pads', 'تيل المكابح الخلفي', '4M0698451N', 50000, null, 0],
    ['Brakes', 'Front Brake Discs', 'ديسكات المكابح الأمامية', '4M0615301AT', 100000, null, 0],
    ['Brakes', 'Rear Brake Discs', 'ديسكات المكابح الخلفية', '4M0615601P', 100000, null, 0],
    ['Brakes', 'Caliper Guide Pins Clean & Grease', 'تشحيم مسامير الكاليبر', null, null, null, 1],
    ['Suspension', 'Front Control Arm Bushings', 'كراسي المقصات الأمامية', '4K0407151', null, null, 1],
    ['Suspension', 'Tie Rod Ends', 'بيلات الدركسيون', '4M0419811B', null, null, 1],
    ['Suspension', 'Sway Bar End Links', 'جوانات الموازن', '4K0411317A', null, null, 1],
    ['Suspension', 'Strut Mounts', 'قواعد المساعدات', '4K0412377', null, null, 1],
    ['Tyres', 'Tyre Rotation', 'تدوير الإطارات', null, 10000, null, 0],
    ['Tyres', 'Wheel Alignment Check', 'فحص ترصيص العجلات', null, 30000, null, 0],
    ['Other', 'AGM Battery (register with VAG-COM)', 'البطارية AGM', '000915105DH', null, 60, 0],
    ['Other', 'Engine & Transmission Mounts', 'كراسي المحرك والقير', '4M0199371AS', null, null, 1],
    ['Other', 'Cowl / Wiper Drainage Cleaning', 'تنظيف مصارف ماء الكاولة', null, null, 12, 0],
    ['Other', 'Wiper Blades', 'مساحات الزجاج', '4G1955425D', null, 12, 0],
    ['Other', 'Fragrance Cartridges (if PR 2V9)', 'كرتاج العطر', null, null, 24, 0],
  ];

  // Old name → new name mappings (for items that got renamed in this update)
  const renames = {
    'Full Inspection Service': 'Standard Service (chassis, lubrication, lighting)',
    'Engine Oil & Filter (0W-20 VW 508 00) — 5.2 L': 'Engine Oil & Filter (0W-20 VW 508 00) — 5.2 L', // unchanged
    'Brake Fluid (DOT 4 LV)': 'Brake Fluid (DOT 4 LV) — 1.0 L',
    'A/C Service & Refrigerant (R1234yf)': 'A/C Service (R1234yf, 510 g)',
    'Coolant Change (G13)': 'Coolant Change (G13) — 10.0 L',
    'Rear Diff / Quattro Oil': 'Quattro / Rear Diff Oil',
  };

  const existing = db.prepare(`SELECT id, name_en FROM service_items WHERE car_id = ?`).all(carId);
  const existingByName = new Map(existing.map(e => [e.name_en, e.id]));

  let updated = 0, added = 0, renamed = 0;

  const updateStmt = db.prepare(`
    UPDATE service_items
    SET category = ?, name_en = ?, name_ar = ?, part_number = ?,
        interval_km = ?, interval_months = ?, is_condition_based = ?, sort_order = ?
    WHERE id = ?
  `);
  const insertStmt = db.prepare(`
    INSERT INTO service_items (car_id, category, name_en, name_ar, part_number, interval_km, interval_months, is_condition_based, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    seedItems.forEach((row, idx) => {
      const [cat, nameEn, nameAr, pn, ikm, imo, cond] = row;

      // Try direct match first
      let existingId = existingByName.get(nameEn);

      // Try matching via rename map (find old name that maps to this new name)
      if (!existingId) {
        for (const [oldName, newName] of Object.entries(renames)) {
          if (newName === nameEn && existingByName.has(oldName)) {
            existingId = existingByName.get(oldName);
            renamed++;
            break;
          }
        }
      }

      if (existingId) {
        updateStmt.run(cat, nameEn, nameAr, pn, ikm, imo, cond, idx, existingId);
        updated++;
      } else {
        insertStmt.run(carId, cat, nameEn, nameAr, pn, ikm, imo, cond, idx);
        added++;
      }
    });
  });
  txn();

  return { updated, added, renamed, total: seedItems.length };
}
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { db, seedAudiA6, refreshAudiA6Schedule, generateToken };
