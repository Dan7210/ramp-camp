require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const https = require('https');
const fs = require('fs');
const cors = require('cors');

const app = express();

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.NMS_CLIENT_ID;
const CLIENT_SECRET = process.env.NMS_CLIENT_SECRET;
const BASE_URL = process.env.NMS_BASE_URL || 'https://api-staging.cgifederal-aim.com';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minute cache TTL
const API_DELAY_MS = 1050;          // Enforce > 1 second between raw FAA calls

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSIgnore: false
});

let cachedToken = null;
let tokenExpirationTime = 0;
let tokenPromise = null;

// Storage structures for caching and global queueing
const notamCache = new Map();
const globalRequestQueue = [];
let isProcessingQueue = false;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Great Circle distance calculation (Nautical Miles)
 */
function calculateDistanceNM(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Manages Bearer Token generation and reuse
 */
async function getBearerToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpirationTime - 30000) {
    return cachedToken;
  }

  if (tokenPromise) return tokenPromise;

  const authUrl = `${BASE_URL}/v1/auth/token`;
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  tokenPromise = (async () => {
    try {
      console.log(`[AUTH] Requesting Bearer Token...`);
      const response = await axios.post(
        authUrl,
        'grant_type=client_credentials',
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${credentials}`
          }
        }
      );

      const { access_token, expires_in } = response.data;
      cachedToken = access_token;
      tokenExpirationTime = Date.now() + (parseInt(expires_in, 10) * 1000);
      return cachedToken;
    } catch (error) {
      console.error('[AUTH ERROR]', error.response?.data || error.message);
      throw new Error('FAA Authentication failed.');
    } finally {
      tokenPromise = null;
    }
  })();

  return tokenPromise;
}

/**
 * Converts a parameter query object into a unique string key for caching
 */
function getCacheKey(params) {
  if (params.location) return `LOC:${params.location.toUpperCase()}`;
  if (params.latitude && params.longitude) {
    return `GEO:${params.latitude.toFixed(3)},${params.longitude.toFixed(3)}:${params.radius}`;
  }
  return JSON.stringify(params);
}

/**
 * Raw call to FAA API. Should only be called through the rate-limited queue worker.
 */
async function executeFaaApiCall(params) {
  const token = await getBearerToken();
  const url = `${BASE_URL}/nmsapi/v1/notams`;

  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'nmsResponseFormat': 'AIXM'
      },
      params
    });

    if (response.data && response.data.data && Array.isArray(response.data.data.aixm)) {
      return response.data.data.aixm;
    }
    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    console.error(`[API ERROR] Params:`, params, `| Error:`, err.response?.data || err.message);
    return [];
  }
}

/**
 * Queue processing engine. Ensures global FAA requests strictly follow 1 req/sec pacing.
 */
async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (globalRequestQueue.length > 0) {
    const { params, resolve, reject } = globalRequestQueue.shift();
    const cacheKey = getCacheKey(params);
    const now = Date.now();

    if (notamCache.has(cacheKey)) {
      const cached = notamCache.get(cacheKey);
      if (now - cached.timestamp < CACHE_TTL_MS) {
        resolve(cached.data);
        continue;
      }
    }

    try {
      console.log(`[QUEUE WORKER] Fetching live FAA data for key: ${cacheKey}`);
      const xmlData = await executeFaaApiCall(params);
      
      notamCache.set(cacheKey, { timestamp: now, data: xmlData });
      
      resolve(xmlData);
    } catch (err) {
      reject(err);
    }

    if (globalRequestQueue.length > 0) {
      await delay(API_DELAY_MS);
    }
  }

  isProcessingQueue = false;
}

/**
 * Fetches NOTAMs by either returning fresh cached data or queuing a network request
 */
function enqueueFetchNotams(params) {
  const cacheKey = getCacheKey(params);
  const now = Date.now();

  if (notamCache.has(cacheKey)) {
    const cached = notamCache.get(cacheKey);
    if (now - cached.timestamp < CACHE_TTL_MS) {
      console.log(`[CACHE HIT] Serving key from 15m cache: ${cacheKey}`);
      return Promise.resolve(cached.data);
    }
  }

  console.log(`[CACHE MISS] Enqueueing request for key: ${cacheKey}`);
  return new Promise((resolve, reject) => {
    globalRequestQueue.push({ params, resolve, reject });
    processQueue();
  });
}

/**
 * Airport location resolver
 */
async function resolveToCoordinates(input) {
  if (typeof input === 'object' && input.lat !== undefined && input.lng !== undefined) {
    return { lat: parseFloat(input.lat), lng: parseFloat(input.lng) };
  }

  if (typeof input === 'string' && input.includes(',')) {
    const [lat, lng] = input.split(',').map(v => parseFloat(v.trim()));
    if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
  }

  if (typeof input === 'string' && /^[A-Z0-9]{3,4}$/i.test(input.trim())) {
    const code = input.trim().toUpperCase();
    const localDb = {
      'KPDK': { lat: 33.8756, lng: -84.3020 },
      'PDK': { lat: 33.8756, lng: -84.3020 },
      'KAVL': { lat: 35.4361, lng: -82.5420 },
      'AVL': { lat: 35.4361, lng: -82.5420 }
    };
    if (localDb[code]) return localDb[code];

    try {
      const res = await axios.get(`https://www.airport-data.com/api/ap_info.json?icao=${code}`);
      if (res.data && res.data.latitude && res.data.longitude) {
        return { lat: parseFloat(res.data.latitude), lng: parseFloat(res.data.longitude) };
      }
    } catch {
      console.warn(`[LOOKUP WARN] Could not resolve coordinates for ${code}.`);
    }
  }

  return null;
}

/**
 * Normalizes deep AIXM XML structures to flat JSON
 */
function normalizeAixmNotam(parsedXml) {
  try {
    const basicMessage = parsedXml?.AIXMBasicMessage;
    const eventMember = basicMessage?.hasMember?.['event:Event'];
    const timeSlice = eventMember?.['event:timeSlice']?.['event:EventTimeSlice'];
    const textNotam = timeSlice?.['event:textNOTAM']?.['event:NOTAM'];
    const extension = timeSlice?.['event:extension']?.['fnse:EventExtension'];
    const validTime = timeSlice?.['gml:validTime']?.['gml:TimePeriod'];

    let rawText = textNotam?.['event:text'] || '';
    if (!rawText && textNotam?.['event:translation']) {
      const translations = Array.isArray(textNotam['event:translation']) 
        ? textNotam['event:translation'] 
        : [textNotam['event:translation']];
      
      const icaoTranslation = translations.find(t => t?.['event:NOTAMTranslation']?.['event:type'] === 'OTHER:ICAO');
      rawText = icaoTranslation?.['event:NOTAMTranslation']?.['event:formattedText']?.['html:div']?.['#text'] || '';
    }

    const series = textNotam?.['event:series'] || '';
    const number = textNotam?.['event:number'] || '';
    const year = textNotam?.['event:year'] ? String(textNotam['event:year']).slice(-2) : '';
    const notamId = series && number ? `${series}${String(number).padStart(4, '0')}/${year}` : 'N/A';

    return {
      id: notamId,
      facility: extension?.['fnse:icaoLocation'] || textNotam?.['event:location'] || 'UNKNOWN',
      airportName: extension?.['fnse:airportname'] || '',
      type: textNotam?.['event:type'] || 'N',
      effectiveStart: validTime?.['gml:beginPosition'] || null,
      effectiveEnd: validTime?.['gml:endPosition'] || null,
      coordinates: textNotam?.['event:coordinates'] || null,
      radiusNM: textNotam?.['event:radius'] || null,
      text: rawText.replace(/<pre>|<\/pre>/gi, '').trim(),
      classification: extension?.['fnse:classification'] || 'CIVIL'
    };
  } catch {
    return { raw: parsedXml };
  }
}

app.post('/api/notams/route', async (req, res) => {
  try {
    const { origin, destination, waypoints = [], radius = 20 } = req.body;

    if (!origin || !destination) {
      return res.status(400).json({ error: 'Both "origin" and "destination" are required.' });
    }

    const rawPoints = [origin, ...waypoints, destination];
    const queryList = [];

    // 1. Collect Location queries
    for (const pt of rawPoints) {
      if (typeof pt === 'string' && /^[A-Z0-9]{3,4}$/i.test(pt.trim())) {
        queryList.push({ location: pt.trim().toUpperCase() });
      }
    }

    // 2. Resolve coordinates
    const resolvedCoords = [];
    for (const pt of rawPoints) {
      const coord = await resolveToCoordinates(pt);
      if (coord) resolvedCoords.push(coord);
    }

    // 3. Distance sampling corridor
    const STEP_DISTANCE_NM = radius * 1.5;
    for (let i = 0; i < resolvedCoords.length - 1; i++) {
      const start = resolvedCoords[i];
      const end = resolvedCoords[i + 1];

      const segmentDist = calculateDistanceNM(start.lat, start.lng, end.lat, end.lng);
      const steps = Math.floor(segmentDist / STEP_DISTANCE_NM);

      queryList.push({ latitude: start.lat, longitude: start.lng, radius });

      for (let s = 1; s <= steps; s++) {
        const fraction = (s * STEP_DISTANCE_NM) / segmentDist;
        const interpLat = start.lat + (end.lat - start.lat) * fraction;
        const interpLng = start.lng + (end.lng - start.lng) * fraction;

        queryList.push({
          latitude: Number(interpLat.toFixed(4)),
          longitude: Number(interpLng.toFixed(4)),
          radius
        });
      }
    }

    if (resolvedCoords.length > 0) {
      const last = resolvedCoords[resolvedCoords.length - 1];
      queryList.push({ latitude: last.lat, longitude: last.lng, radius });
    }

    // 4. Concurrently request points through the thread-safe queue/cache system
    const rawXmlPromises = queryList.map(params => enqueueFetchNotams(params));
    const results = await Promise.all(rawXmlPromises);
    const rawXmlNotams = results.flat();

    // 5. Deduplicate and normalize to JSON
    const uniqueXmlStrings = Array.from(new Set(rawXmlNotams));
    const cleanedNotams = uniqueXmlStrings.map(xmlStr => {
      try {
        const parsed = xmlParser.parse(xmlStr);
        return normalizeAixmNotam(parsed);
      } catch {
        return null;
      }
    }).filter(Boolean);

    return res.json({
      count: cleanedNotams.length,
      corridorRadiusNM: radius,
      resolvedWaypoints: resolvedCoords,
      notams: cleanedNotams
    });

  } catch (error) {
    console.error('[ROUTE ERROR]', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Load SSL certificates and create HTTPS server
const sslOptions = {
  key: fs.readFileSync('/etc/letsencrypt/live/adsb-radar.duckdns.org/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/adsb-radar.duckdns.org/fullchain.pem')
};

https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
  console.log(`Secure FAA NMS NOTAM Service running at https://adsb-radar.duckdns.org:${PORT}/api/notams/route`);
});