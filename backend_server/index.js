require('dotenv').config();
const container = require('rhea');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

// -----------------------------------------------------------------------------
// 1. Environment & Configuration Setup
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 8000;
const DB_PATH = process.env.DB_PATH || './notams.db';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:5173', 'http://localhost:3000'];

const SWIFT_CONFIG = {
  host: process.env.SWIFT_HOST,
  port: parseInt(process.env.SWIFT_PORT || '55443', 10),
  username: process.env.SWIFT_USER,
  password: process.env.SWIFT_PASS,
  vpn: process.env.SWIFT_VPN || 'AIM_FNS',
  queue: process.env.SWIFT_QUEUE
};

// Validate required parameters on startup
if (!SWIFT_CONFIG.host || !SWIFT_CONFIG.username || !SWIFT_CONFIG.password || !SWIFT_CONFIG.queue) {
  console.error('[FATAL ERROR] Missing required SWIFT configuration in .env file.');
  process.exit(1);
}

// Ensure Solace queue address prefixing for AMQP 1.0 routing
const QUEUE_ADDRESS = SWIFT_CONFIG.queue.startsWith('queue://')
  ? SWIFT_CONFIG.queue
  : `queue://${SWIFT_CONFIG.queue}`;

// -----------------------------------------------------------------------------
// 2. Database Initialization (SQLite)
// -----------------------------------------------------------------------------
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
      issue_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// -----------------------------------------------------------------------------
// 3. AIXM Parsing Helper
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// 4. AMQP Ingestion Engine (rhea + FAA Solace Broker)
// -----------------------------------------------------------------------------
container.on('error', (err) => {
  console.error('[AMQP CONTAINER ERROR]', err.message || err);
});

container.on('connection_open', () => {
  console.log('[SWIFT] Successfully connected and session opened with FAA Solace Broker.');
});

container.on('connection_close', (context) => {
  const error = context.connection.error;
  if (error) {
    console.warn(`[SWIFT DISCONNECTED] Broker closed connection: ${error.condition} - ${error.description}`);
  } else {
    console.warn('[SWIFT DISCONNECTED] Connection closed. Reconnecting...');
  }
});

container.on('disconnected', (context) => {
  const error = context.connection.error;
  console.warn('[SWIFT DISCONNECTED] Transport layer dropped connection.', error ? error.message : '');
});

container.on('message', (context) => {
  let rawXml = '';
  const body = context.message.body;

  // Handle varying Solace AMQP message body encodings
  if (typeof body === 'string') {
    rawXml = body;
  } else if (Buffer.isBuffer(body)) {
    rawXml = body.toString('utf-8');
  } else if (body && body.content) {
    rawXml = Buffer.isBuffer(body.content) 
      ? body.content.toString('utf-8') 
      : String(body.content);
  } else if (Array.isArray(body)) {
    rawXml = Buffer.concat(body).toString('utf-8');
  } else {
    rawXml = JSON.stringify(body);
  }

  console.log(`[RAW RECEIVED] Length: ${rawXml.length} bytes | Preview: ${rawXml.substring(0, 100).replace(/\r?\n|\r/g, '')}...`);

  const parsed = parseAixmNotam(rawXml);

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
      console.error('[DB INSERT ERROR]', err.message);
    } else {
      console.log(`[INGESTED] ID: ${parsed.notamId} | Facility: ${parsed.facility}`);
    }
  });
});

// Establish Solace Connection
const connection = container.connect({
  host: SWIFT_CONFIG.host,
  port: SWIFT_CONFIG.port,
  transport: 'tls',
  username: SWIFT_CONFIG.username,
  password: SWIFT_CONFIG.password,
  hostname: SWIFT_CONFIG.vpn,
  properties: {
    'tenant-id': SWIFT_CONFIG.vpn
  },
  reconnect: true,
  reconnect_limit: 100,
  initial_reconnect_delay: 2000,
  max_reconnect_delay: 30000
});

// Open Receiver with explicit credit replenishment and auto-acknowledgment
connection.open_receiver({
  source: {
    address: QUEUE_ADDRESS,
    durable: 2,
    expiry_policy: 'never'
  },
  credit_window: 10,
  autoaccept: true
});

console.log(`[SWIFT] Receiver initializing for ${QUEUE_ADDRESS} on ${SWIFT_CONFIG.host}:${SWIFT_CONFIG.port} (VPN: ${SWIFT_CONFIG.vpn})`);

// -----------------------------------------------------------------------------
// 5. Express REST API Server
// -----------------------------------------------------------------------------
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
  console.log(`[REST API] Express server running on port ${PORT}`);
});