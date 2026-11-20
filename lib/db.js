import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  site_name: 'کلاس‌آنلاین',
  site_tagline: 'کلاس و جلسه آنلاین با ویدیو، صدا، وایت‌بورد و ضبط جلسه',
  allow_registration: '1',
  primary_color: '#4f46e5',
  support_text: '',
  footer_text: '',
  card_number: '',
  card_owner: '',
  payment_note: 'پس از واریز، شماره پیگیری را در داشبورد ثبت کنید تا پرداخت شما تأیید شود.',
};

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0,
      duration_days INTEGER NOT NULL DEFAULT 30, max_rooms INTEGER NOT NULL DEFAULT 1,
      max_participants INTEGER NOT NULL DEFAULT 10, allow_recording INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
      plan_id INTEGER REFERENCES plans(id), plan_expires TEXT, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS rooms(
      id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'class', max_participants INTEGER NOT NULL DEFAULT 50,
      password_hash TEXT, allow_guests INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS attendance(
      id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER, display_name TEXT NOT NULL, role TEXT,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')), left_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_att_room ON attendance(room_id);
    CREATE INDEX IF NOT EXISTS idx_att_joined ON attendance(joined_at);
    CREATE TABLE IF NOT EXISTS recordings(
      id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL, file TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'recording', created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS room_files(
      id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL, file TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payments(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id INTEGER NOT NULL REFERENCES plans(id), amount INTEGER NOT NULL, method TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', authority TEXT, ref_id TEXT, note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  if (!db.prepare('SELECT id FROM plans LIMIT 1').get()) {
    const ins = db.prepare(
      'INSERT INTO plans(name,price,duration_days,max_rooms,max_participants,allow_recording,is_default,sort) VALUES (?,?,?,?,?,?,?,?)'
    );
    ins.run('رایگان', 0, 0, 1, 10, 0, 1, 1);
    ins.run('پایه', 150000, 30, 5, 50, 1, 0, 2);
    ins.run('حرفه‌ای', 450000, 30, 20, 200, 1, 0, 3);
  }
  return db;
}
