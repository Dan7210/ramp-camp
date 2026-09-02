require('dotenv').config();
const express = require('express'), axios = require('axios'), Database = require('better-sqlite3'), { XMLParser } = require('fast-xml-parser'), cors = require('cors'), fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib'), { promisify } = require('util'), { execFile } = require('child_process');
const gunzip = promisify(zlib.gunzip), execFileAsync = promisify(execFile), app = express();
app.use(cors()); app.use(express.json({ limit: '2mb' }));

const { PORT = 3000, NMS_CLIENT_ID, NMS_CLIENT_SECRET, NMS_BASE_URL = 'https://api-staging.cgifederal-aim.com', NOTAM_DB_PATH = path.join(__dirname, 'data', 'notams.db'), NOTAM_SYNC_INTERVAL_MS = 180000, NOTAM_INITIAL_LOAD_STALE_MS = 21600000, NOTAM_DELTA_LOOKBACK_MS = 300000, DUCKDNS_HOST = 'adsb-radar.duckdns.org', SERVER_PROTOCOL = 'AUTO' } = process.env;
const BASE_URL = NMS_BASE_URL, HTTPS_KEY = process.env.HTTPS_KEY || `/etc/letsencrypt/live/${DUCKDNS_HOST}/privkey.pem`, HTTPS_CERT = process.env.HTTPS_CERT || `/etc/letsencrypt/live/${DUCKDNS_HOST}/fullchain.pem`;

if (!NMS_CLIENT_ID || !NMS_CLIENT_SECRET) console.warn('[CONFIG] NMS_CLIENT_ID / NMS_CLIENT_SECRET are not set.');
fs.mkdirSync(path.dirname(NOTAM_DB_PATH), { recursive: true });
const db = new Database(NOTAM_DB_PATH);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS notams (id TEXT PRIMARY KEY, nms_id TEXT, facility TEXT, airport_name TEXT, type TEXT, classification TEXT, effective_start TEXT, effective_end TEXT, latitude REAL, longitude REAL, radius_nm REAL, coordinates TEXT, text TEXT, raw_json TEXT, updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_notams_facility ON notams(facility); CREATE INDEX IF NOT EXISTS idx_notams_effective_end ON notams(effective_end); CREATE INDEX IF NOT EXISTS idx_notams_lat_lon ON notams(latitude, longitude); CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

const getState = k => db.prepare('SELECT value FROM sync_state WHERE key = ?').get(k)?.value || null, setState = (k, v) => db.prepare('INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
let cachedToken = null, tokenExpirationTime = 0, tokenPromise = null;
const getBearerToken = () => {
  if (cachedToken && Date.now() < tokenExpirationTime - 30000) return cachedToken;
  if (tokenPromise) return tokenPromise;
  return (tokenPromise = axios.post(`${NMS_BASE_URL}/v1/auth/token`, 'grant_type=client_credentials', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${NMS_CLIENT_ID}:${NMS_CLIENT_SECRET}`).toString('base64')}` }, timeout: 60000 }).then(r => { cachedToken = r.data.access_token; tokenExpirationTime = Date.now() + r.data.expires_in * 1000; return cachedToken; }).finally(() => { tokenPromise = null; }));
};

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSIgnore: false }), deepFind = (obj, k) => { if (!obj || typeof obj !== 'object') return null; if (k in obj) return obj[k]; for (const key in obj) { const r = deepFind(obj[key], k); if (r) return r; } return null; }, firstNumber = v => { if (!v) return null; const m = String(v).match(/-?\d+(?:\.\d+)?/g); return m ? Number(m[0]) : null; };

// Drop and re-create airports table to cleanly capture codes from CSV
db.exec(`
  DROP TABLE IF EXISTS airports;
  CREATE TABLE airports (
    icao TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lon REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_airports_icao ON airports(icao);
`);

// Load and parse airports.csv
try {
  const airportFilePath = path.join(__dirname, 'data', 'airports.csv');
  if (fs.existsSync(airportFilePath)) {
    const fileContent = fs.readFileSync(airportFilePath, 'utf8');
    const lines = fileContent.split(/\r?\n/);
    
    if (lines.length > 0) {
      // Simple CSV line tokenizer handling quoted fields
      const parseCSVLine = (line) => {
        const res = [];
        let cur = '', inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (c === '"') { inQuotes = !inQuotes; }
          else if (c === ',' && !inQuotes) { res.push(cur.trim()); cur = ''; }
          else { cur += c; }
        }
        res.push(cur.trim());
        return res.map(v => v.replace(/^"|"$/g, ''));
      };

      const headers = parseCSVLine(lines[0]);
      const locIdIdx = headers.indexOf('Loc Id');
      const icaoIdx = headers.indexOf('ICAO Id');
      const latIdx = headers.indexOf('ARP Latitude DD');
      const lonIdx = headers.indexOf('ARP Longitude DD');

      if (latIdx !== -1 && lonIdx !== -1) {
        const insertAirport = db.prepare('INSERT OR IGNORE INTO airports (icao, lat, lon) VALUES (?, ?, ?)');
        const insertMany = db.transaction((rows) => {
          for (let i = 1; i < rows.length; i++) {
            if (!rows[i]) continue;
            const cols = parseCSVLine(rows[i]);
            const lat = Number(cols[latIdx]);
            const lon = Number(cols[lonIdx]);

            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              if (locIdIdx !== -1 && cols[locIdIdx]) {
                insertAirport.run(cols[locIdIdx].trim().toUpperCase(), lat, lon);
              }
              if (icaoIdx !== -1 && cols[icaoIdx]) {
                insertAirport.run(cols[icaoIdx].trim().toUpperCase(), lat, lon);
              }
            }
          }
        });
        insertMany(lines);
        console.log(`[INIT] Loaded airport coordinates from airports.csv into database.`);
      } else {
        console.warn('[INIT] Could not find required lat/lon columns in airports.csv headers.');
      }
    }
  }
} catch (err) {
  console.warn('[INIT] Could not load airports.csv:', err.message);
}

const getAirportCoords = db.prepare('SELECT lat, lon FROM airports WHERE icao = ?');

const extractCoordinates = (mObj, rawText = '') => {
  // 1. Capture AIXM Polygons (gml:posList)
  const posList = deepFind(mObj, 'gml:posList') || deepFind(mObj, 'posList');
  if (posList?.['#text'] || typeof posList === 'string') {
    const coords = (posList['#text'] || posList).trim().split(/\s+/).map(Number);
    const pts = [];
    for (let i = 0; i < coords.length; i += 2) {
      if (Number.isFinite(coords[i]) && Number.isFinite(coords[i+1])) {
        pts.push(Math.abs(coords[i]) <= 90 ? { latitude: coords[i], longitude: coords[i+1] } : { latitude: coords[i+1], longitude: coords[i] });
      }
    }
    if (pts.length > 1) {
      return {
        latitude: pts.reduce((a, p) => a + p.latitude, 0) / pts.length,
        longitude: pts.reduce((a, p) => a + p.longitude, 0) / pts.length,
        polygon: pts
      };
    }
  }

  // 2. Capture Single Points (gml:pos)
  const posStr = deepFind(mObj, 'gml:pos') || deepFind(mObj, 'pos');
  if (posStr?.['#text'] || typeof posStr === 'string') {
    const p = (posStr['#text'] || posStr).trim().split(/\s+/).map(Number);
    if (p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
      return Math.abs(p[0]) <= 90 ? { latitude: p[0], longitude: p[1], polygon: null } : { latitude: p[1], longitude: p[0], polygon: null };
    }
  }

  // 3. Regex Fallback for Text-based Coordinates
  if (rawText) {
    // Strip HTML entities that interrupt coordinate pairs
    const cleanText = rawText.replace(/&#\w+;/g, ' '); 
    // Matches: DDMM(SS.ss)N [space/dash] DDDMM(SS.ss)W
    const regex = /\b(\d{2})(\d{2})(\d{2}(?:\.\d+)?)?([NS])[\s\-]*(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)?([EW])\b/gi;
    const matches = [...cleanText.matchAll(regex)];

    if (matches.length > 0) {
      const pts = matches.map(m => {
        const [, ld, lm, ls, lDir, od, om, os, oDir] = m;
        // Parse degrees, minutes, and optional seconds (now supporting decimals)
        let lat = parseInt(ld, 10) + parseInt(lm, 10) / 60 + (ls ? parseFloat(ls) / 3600 : 0);
        let lon = parseInt(od, 10) + parseInt(om, 10) / 60 + (os ? parseFloat(os) / 3600 : 0);
        
        return { 
          latitude: lDir.toUpperCase() === 'S' ? -lat : lat, 
          longitude: oDir.toUpperCase() === 'W' ? -lon : lon 
        };
      }).filter(Boolean);

      if (pts.length === 1) return { ...pts[0], polygon: null };
      if (pts.length > 1) return { 
        latitude: pts.reduce((a, p) => a + p.latitude, 0) / pts.length, 
        longitude: pts.reduce((a, p) => a + p.longitude, 0) / pts.length, 
        polygon: pts 
      };
    }
  }
  return null;
};

const normalizeAixmNotam = pXml => {
  try {
    const ev = deepFind(pXml, 'event:Event') || pXml, txt = deepFind(ev, 'event:textNOTAM'), ext = deepFind(ev, 'fnse:EventExtension'), vt = deepFind(ev, 'gml:validTime') || deepFind(ev, 'validTime');
    let rt = deepFind(txt, 'event:text') || '';
    if (!rt) { const tr = [].concat(deepFind(txt, 'event:translation') || []); const ic = tr.find(t => deepFind(t, 'event:type') === 'OTHER:ICAO'); rt = deepFind(ic, '#text') || deepFind(ic, 'event:formattedText') || ''; }
    
    const ser = deepFind(txt, 'event:series') || '', num = deepFind(txt, 'event:number') || '', yr = deepFind(txt, 'event:year') ? String(deepFind(txt, 'event:year')).slice(-2) : '', nms = deepFind(ev, 'event:nmsId') || deepFind(ev, 'event:id') || ev['@_gml:id'] || null;
    
    let facility = deepFind(ext, 'fnse:icaoLocation') || deepFind(txt, 'event:location') || 'UNKNOWN';
    facility = String(facility).trim().toUpperCase();

    // Extract coordinates via XML / text regex first
    let pt = extractCoordinates(ev, rt);

    // Fallback: If no coordinates found, check airport database using facility code
    if (!pt && facility && facility !== 'UNKNOWN') {
      const apMatch = getAirportCoords.get(facility);
      if (apMatch) {
        pt = { latitude: apMatch.lat, longitude: apMatch.lon, polygon: null };
      }
    }

    return { 
      id: ser && num ? `${ser}${String(num).padStart(4, '0')}/${yr}` : String(nms || ''), 
      nmsId: nms ? String(nms) : null, 
      facility: facility, 
      airportName: deepFind(ext, 'fnse:airportname') || '', 
      type: deepFind(txt, 'event:type') || 'N', 
      effectiveStart: deepFind(vt, 'gml:beginPosition') || deepFind(vt, 'beginPosition') || null, 
      effectiveEnd: deepFind(vt, 'gml:endPosition') || deepFind(vt, 'endPosition') || null, 
      coordinates: pt?.polygon ? JSON.stringify(pt.polygon) : null, 
      latitude: pt?.latitude ?? null, 
      longitude: pt?.longitude ?? null, 
      radiusNM: firstNumber(deepFind(txt, 'event:radius')), 
      text: String(rt).replace(/<pre>|<\/pre>/gi, '').trim(), 
      classification: deepFind(ext, 'fnse:classification') || 'CIVIL', 
      raw: pXml 
    };
  } catch { return { id: null, raw: pXml }; }
};

const decompressIfNeeded = async buf => {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return gunzip(buf);
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-notam-')), zp = path.join(tmp, 'il.zip');
    try { fs.writeFileSync(zp, buf); await execFileAsync('unzip', ['-o', zp, '-d', tmp]); const f = fs.readdirSync(tmp).filter(n => n !== 'il.zip'); return fs.readFileSync(path.join(tmp, f[0])); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return buf;
};

const upsertNotam = db.prepare(`INSERT INTO notams (id, nms_id, facility, airport_name, type, classification, effective_start, effective_end, latitude, longitude, radius_nm, coordinates, text, raw_json, updated_at) VALUES (@id, @nmsId, @facility, @airportName, @type, @classification, @effectiveStart, @effectiveEnd, @latitude, @longitude, @radiusNM, @coordinates, @text, @rawJson, @updatedAt) ON CONFLICT(id) DO UPDATE SET nms_id=excluded.nms_id, facility=excluded.facility, airport_name=excluded.airport_name, type=excluded.type, classification=excluded.classification, effective_start=excluded.effective_start, effective_end=excluded.effective_end, latitude=excluded.latitude, longitude=excluded.longitude, radius_nm=excluded.radius_nm, coordinates=excluded.coordinates, text=excluded.text, raw_json=excluded.raw_json, updated_at=excluded.updated_at`);
const deleteNotam = db.prepare('DELETE FROM notams WHERE id = ? OR nms_id = ?'), toPrim = v => v === undefined || v === null ? null : (typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : String(v));
const saveNotam = n => {
  if (!n?.id || n.id === 'N/A') return false;
  upsertNotam.run({ id: toPrim(n.id), nmsId: toPrim(n.nmsId), facility: toPrim(n.facility) || 'UNKNOWN', airportName: toPrim(n.airportName) || '', type: toPrim(n.type) || 'N', classification: toPrim(n.classification) || 'CIVIL', effectiveStart: toPrim(n.effectiveStart), effectiveEnd: toPrim(n.effectiveEnd), latitude: typeof n.latitude === 'number' ? n.latitude : null, longitude: typeof n.longitude === 'number' ? n.longitude : null, radiusNM: typeof n.radiusNM === 'number' ? n.radiusNM : null, coordinates: typeof n.coordinates === 'string' ? n.coordinates : (n.coordinates ? JSON.stringify(n.coordinates) : null), text: toPrim(n.text) || '', rawJson: typeof n.raw === 'string' ? n.raw : JSON.stringify(n.raw), updatedAt: new Date().toISOString() });
  return true;
};

const extractAixmMembers = (obj, res = []) => {
  if (!obj || typeof obj !== 'object') return res;
  if (obj.AIXMBasicMessage) return extractAixmMembers(obj.AIXMBasicMessage, res);
  if (obj.hasMember) { [].concat(obj.hasMember).forEach(m => extractAixmMembers(m, res)); return res; }
  if (obj['event:Event'] || obj.Event || obj.timeSlice) { res.push(obj['event:Event'] || obj.Event || obj); return res; }
  for (const k of Object.keys(obj)) if (typeof obj[k] === 'object') extractAixmMembers(obj[k], res);
  return res;
};

let syncInProgress = false;
const performInitialLoad = async () => {
  const t = await getBearerToken(), r = await axios.get(`${BASE_URL}/nmsapi/v1/notams/il`, { headers: { Authorization: `Bearer ${t}` }, maxRedirects: 0, validateStatus: s => s >= 200 && s < 400 });
  const b = [302, 307].includes(r.status) ? Buffer.from((await axios.get(r.headers.location.startsWith('http') ? r.headers.location : `${BASE_URL}${r.headers.location}`, { headers: { Authorization: `Bearer ${t}` }, responseType: 'arraybuffer' })).data) : Buffer.from(r.data);
  const rm = extractAixmMembers(xmlParser.parse((await decompressIfNeeded(b)).toString('utf8')));
  db.transaction(() => rm.forEach(m => saveNotam(normalizeAixmNotam({ AIXMBasicMessage: { hasMember: { 'event:Event': m } } }))))();
  const now = new Date().toISOString(); ['last_initial_load', 'last_successful_sync'].forEach(k => setState(k, now)); setState('last_sync_type', 'initial_load');
};

const performDeltaSync = async () => {
  const f = new Date(getState('last_successful_sync') ? new Date(getState('last_successful_sync')).getTime() - NOTAM_DELTA_LOOKBACK_MS : Date.now() - NOTAM_DELTA_LOOKBACK_MS).toISOString();
  const r = await axios.get(`${BASE_URL}/nmsapi/v1/notams`, { headers: { Authorization: `Bearer ${await getBearerToken()}`, nmsResponseFormat: 'AIXM' }, params: { lastUpdatedDate: f } });
  const ri = [].concat(r.data?.data?.aixm || r.data || []);
  db.transaction(() => ri.forEach(rw => { try { const n = normalizeAixmNotam(typeof rw === 'string' ? xmlParser.parse(rw) : rw); if (!n.id || n.id === 'N/A') return; if (/(CANCEL|CANCELLED|WITHDRAWN)/i.test(`${n.type} ${n.text}`)) deleteNotam.run(n.id, n.nmsId || ''); else saveNotam(n); } catch {} }))();
  const now = new Date().toISOString(); setState('last_successful_sync', now); setState('last_sync_type', 'delta'); setState('last_delta_count', ri.length);
};

const synchronizeNotams = async (f = false) => {
  if (syncInProgress) return; syncInProgress = true;
  try { const li = getState('last_initial_load'), ls = getState('last_successful_sync'); if (f || !li || !ls || (Date.now() - new Date(li).getTime() > NOTAM_INITIAL_LOAD_STALE_MS)) await performInitialLoad(); else await performDeltaSync(); }
  catch (e) { setState('last_sync_error', new Date().toISOString()); setState('last_sync_error_message', e.message); } finally { syncInProgress = false; }
};

const calcDistNM = (l1, n1, l2, n2) => 3440.065 * 2 * Math.atan2(Math.sqrt(Math.sin((l2 - l1) * Math.PI / 360) ** 2 + Math.cos(l1 * Math.PI / 180) * Math.cos(l2 * Math.PI / 180) * Math.sin((n2 - n1) * Math.PI / 360) ** 2), Math.sqrt(1 - (Math.sin((l2 - l1) * Math.PI / 360) ** 2 + Math.cos(l1 * Math.PI / 180) * Math.cos(l2 * Math.PI / 180) * Math.sin((n2 - n1) * Math.PI / 360) ** 2)));
const queryNearbyNotams = (lat, lon, rNM) => db.prepare('SELECT * FROM notams WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?').all(lat - rNM / 60, lat + rNM / 60, lon - rNM / (60 * Math.max(Math.cos(lat * Math.PI / 180), 0.1)), lon + rNM / (60 * Math.max(Math.cos(lat * Math.PI / 180), 0.1))).map(row => ({ row, dist: calcDistNM(lat, lon, row.latitude, row.longitude) })).filter(i => i.dist <= rNM).map(({ row, dist }) => ({ id: row.id, nmsId: row.nms_id, facility: row.facility, airportName: row.airport_name, type: row.type, classification: row.classification, effectiveStart: row.effective_start, effectiveEnd: row.effective_end, coordinates: row.coordinates, radiusNM: row.radius_nm, text: row.text, distanceNM: Number(dist.toFixed(2)) }));

app.get('/api/notams/status', (req, res) => res.json({ count: db.prepare('SELECT COUNT(*) AS c FROM notams').get().c, lastInitialLoad: getState('last_initial_load'), lastSuccessfulSync: getState('last_successful_sync'), syncInProgress, databasePath: NOTAM_DB_PATH }));
app.get('/api/debug/notams', (req, res) => res.json({ 
  total: db.prepare('SELECT COUNT(*) AS c FROM notams').get().c, 
  parsedLocations: db.prepare('SELECT COUNT(*) AS c FROM notams WHERE latitude IS NOT NULL OR coordinates IS NOT NULL').get().c,
  pointOnlyLocations: db.prepare('SELECT COUNT(*) AS c FROM notams WHERE latitude IS NOT NULL AND coordinates IS NULL').get().c,
  polygonRegions: db.prepare('SELECT COUNT(*) AS c FROM notams WHERE coordinates IS NOT NULL').get().c,
  missingLocations: db.prepare('SELECT COUNT(*) AS c FROM notams WHERE latitude IS NULL AND coordinates IS NULL').get().c,
  byClassification: db.prepare('SELECT classification, COUNT(*) AS count FROM notams GROUP BY classification').all() 
}));
app.post('/api/debug/sync', (req, res) => { if (syncInProgress) return res.status(409).json({ error: 'Sync running' }); synchronizeNotams(String(req.query.initial).toLowerCase() === 'true'); res.status(202).json({ message: 'Sync started' }); });
app.get('/api/notams/nearby', (req, res) => { const lat = Number(req.query.latitude), lon = Number(req.query.longitude), r = Number(req.query.radius || 50); if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Missing coordinates' }); res.json({ notams: queryNearbyNotams(lat, lon, r) }); });
app.post('/api/notams/route', async (req, res) => {
  const { origin, destination, waypoints = [], radius = 5 } = req.body;
  if (!origin || !destination) return res.status(400).json({ error: 'Origin and destination required' });
  const resolve = async (i) => typeof i === 'object' ? { lat: Number(i.lat), lng: Number(i.lng) } : { lat: 33.8756, lng: -84.3020 }, pts = await Promise.all([origin, ...waypoints, destination].map(resolve)), all = new Map();
  pts.forEach(p => p && queryNearbyNotams(p.lat, p.lng, radius).forEach(n => all.set(n.id, n)));
  res.json({ notams: Array.from(all.values()) });
});
app.get('/api/debug/missing', (req, res) => res.json({ 
  samples: db.prepare('SELECT id, facility, type, text FROM notams WHERE latitude IS NULL AND coordinates IS NULL ORDER BY RANDOM() LIMIT 10').all() 
}));

(SERVER_PROTOCOL === 'HTTPS' || (SERVER_PROTOCOL === 'AUTO' && fs.existsSync(HTTPS_KEY) && fs.existsSync(HTTPS_CERT)) ? require('https').createServer({ key: fs.readFileSync(HTTPS_KEY), cert: fs.readFileSync(HTTPS_CERT) }, app) : app).listen(PORT, '0.0.0.0', () => console.log(`NOTAM service running on port ${PORT}`));
setTimeout(() => synchronizeNotams().catch(console.error), 1000); setInterval(() => synchronizeNotams().catch(console.error), NOTAM_SYNC_INTERVAL_MS);
process.on('SIGINT', () => { db.close(); process.exit(0); }); process.on('SIGTERM', () => { db.close(); process.exit(0); });
