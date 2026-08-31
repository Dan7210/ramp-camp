require('dotenv').config();
const container = require('rhea');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

// Environment & Config Setup
const PORT = process.env.PORT || 8000;
const DB_PATH = process.env.DB_PATH || './notams.db';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000'];

const SWIFT_CONFIG = {
  host: process.env.SWIFT_HOST,
  port: parseInt(process.env.SWIFT_PORT || '5671', 10),
  username: process.env.SWIFT_USER,
  password: process.env.SWIFT_PASS,
  queue: process.env.SWIFT_QUEUE,
  transport: 'tls',
  reconnect: true
};

// Validate critical secrets before booting
if (!SWIFT_CONFIG.username || !SWIFT_CONFIG.password || !SWIFT_CONFIG.queue) {
  console.error('[ERROR] Missing required SWIFT credentials in .env file.');
  process.exit(1);
}

// Database Initialization
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error(`[DB ERROR] Failed to connect to SQLite at ${DB_PATH}:`, err.message);
    process.exit(1);
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS notams (
      notam_id TEXT PRIMARY KEY,
      facility TEXT,
      raw_text TEXT,
      issue_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      cancellation_flag INTEGER DEFAULT 0
    )
  `);
});

// AMQP Ingestion Engine
function parseAixmNotam(xmlString) {
  const idMatch = xmlString.match(/<aixm:id>(.*?)<\/aixm:id>/) || xmlString.match(/<id>(.*?)<\/id>/);
  const facilityMatch = xmlString.match(/<aixm:location>(.*?)<\/aixm:location>/) || xmlString.match(/<location>(.*?)<\/location>/);
  const textMatch = xmlString.match(/<aixm:text>(.*?)<\/aixm:text>/) || xmlString.match(/<text>(.*?)<\/text>/);

  return {
    notamId: idMatch ? idMatch[1] : `NOTAM-${Date.now()}`,
    facility: facilityMatch ? facilityMatch[1] : 'GENERIC',
    rawText: textMatch ? textMatch[1] : xmlString
  };
}

container.on('message', (context) => {
  const payload = context.message.body ? context.message.body.toString() : '';
  const parsed = parseAixmNotam(payload);

  const query = `
    INSERT INTO notams (notam_id, facility, raw_text, issue_time)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(notam_id) DO UPDATE SET
      facility = excluded.facility,
      raw_text = excluded.raw_text,
      issue_time = CURRENT_TIMESTAMP;
  `;

  db.run(query, [parsed.notamId, parsed.facility, parsed.rawText], (err) => {
    if (err) {
      console.error('[INGEST ERROR] Failed to store NOTAM:', err.message);
    } else {
      console.log(`[INGESTED] ID: ${parsed.notamId} | Facility: ${parsed.facility}`);
    }
  });
});

container.on('error', (err) => {
  console.error('[AMQP ERROR] Connection error:', err);
});

// Start AMQP Listener
const connection = container.connect({
  host: SWIFT_CONFIG.host,
  port: SWIFT_CONFIG.port,
  transport: SWIFT_CONFIG.transport,
  username: SWIFT_CONFIG.username,
  password: SWIFT_CONFIG.password,
  reconnect: SWIFT_CONFIG.reconnect
});

connection.open_receiver(SWIFT_CONFIG.queue);
console.log(`[SWIFT] Listener connected to ${SWIFT_CONFIG.host}:${SWIFT_CONFIG.port} (Queue: ${SWIFT_CONFIG.queue})`);

//EXPRESS REST API Server
const app = express();

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS policy violation'));
    }
  },
  methods: ['GET']
}));

app.get('/api/notams', (req, res) => {
  const { facility, limit = 50 } = req.query;
  const parsedLimit = parseInt(limit, 10);

  let query = 'SELECT * FROM notams';
  const params = [];

  if (facility) {
    query += ' WHERE facility = ?';
    params.push(facility.toUpperCase());
  }

  query += ' ORDER BY issue_time DESC LIMIT ?';
  params.push(parsedLimit);

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database query failed' });
    }
    res.json(rows);
  });
});

app.listen(PORT, () => {
  console.log(`[REST API] Server running on port ${PORT}`);
});