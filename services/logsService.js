const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

const dbPath = path.join(dataDir, 'signals.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite:', err.message);
  } else {
    console.log('✅ Connected to SQLite database');
  }
});

// Initialize the table if it doesn't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      notes TEXT,
      entry REAL,
      tp1 REAL,
      tp2 REAL,
      sl REAL,
      position_size REAL,
      status TEXT DEFAULT 'sent'
    )
  `, (err) => {
    if (err) {
      console.error('Table creation error:', err.message);
    } else {
      console.log('✅ Signals table ready');
    }
    // Add new columns if they don't exist (run these once or handle errors)
db.run('ALTER TABLE signals ADD COLUMN open_time TEXT', (err) => { if (err && !err.message.includes('duplicate column')) console.error('Add open_time error:', err.message); });
db.run('ALTER TABLE signals ADD COLUMN close_time TEXT', (err) => { if (err && !err.message.includes('duplicate column')) console.error('Add close_time error:', err.message); });
db.run('ALTER TABLE signals ADD COLUMN exit_price REAL', (err) => { if (err && !err.message.includes('duplicate column')) console.error('Add exit_price error:', err.message); });
db.run('ALTER TABLE signals ADD COLUMN pnl_percentage REAL', (err) => { if (err && !err.message.includes('duplicate column')) console.error('Add pnl_percentage error:', err.message); });
  });
});

async function logSignal(symbol, signalData) {
  return new Promise((resolve, reject) => {
    const { signal, notes, entry, tp1, tp2, sl, positionSize } = signalData;
    const timestamp = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO signals (timestamp, symbol, signal_type, notes, entry, tp1, tp2, sl, position_size, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      timestamp, symbol, signal || 'Unknown', notes || null, entry || null, tp1 || null, tp2 || null, sl || null, positionSize || null, 'sent'
    , function (err) {
      if (err) {
        console.error(`Log error for ${symbol}:`, err.message);
        reject(err);
      } else {
        console.log(`✅ Signal logged for ${symbol} (ID: ${this.lastID})`);
        resolve(this.lastID);
      }
    });
    stmt.finalize();
  });
}

async function getSignals(options = {}) {
  const { symbol, limit = 50, fromDate, status } = options;
  let query = 'SELECT * FROM signals';
  const params = [];
  const whereClauses = [];

  if (symbol) {
    whereClauses.push('symbol = ?');
    params.push(symbol);
  }
  if (fromDate) {
    whereClauses.push('timestamp >= ?');
    params.push(fromDate);
  }
  if (status) {
    whereClauses.push('status = ?');
    params.push(status);
  }

  if (whereClauses.length > 0) {
    query += ' WHERE ' + whereClauses.join(' AND ');
  }
  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// Graceful shutdown
process.on('SIGTERM', () => db.close());
process.on('SIGINT', () => db.close());

module.exports = { logSignal, getSignals };
