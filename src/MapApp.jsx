import { useEffect, useRef, useState } from 'react';
import 'ol/ol.css';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import OSM from 'ol/source/OSM';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import { fromLonLat, toLonLat } from 'ol/proj';
import { Style, Circle, Fill, Stroke, Text } from 'ol/style';

// Public Overpass Mirrored Endpoints for Failover
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

export default function MapApp() {
  const mapElement = useRef(null);
  const mapRef = useRef(null);
  const vectorSourceRef = useRef(new VectorSource());

  // Search Parameters
  const [centerCoords, setCenterCoords] = useState([-97.7431, 30.2672]); // [lon, lat] default Austin, TX
  const [airportRadiusMiles, setAirportRadiusMiles] = useState(50);
  const [campRadiusMiles, setCampRadiusMiles] = useState(15);
  const [loading, setLoading] = useState(false);
  const [statusLog, setStatusLog] = useState('');
  const [results, setResults] = useState({ airports: [], campsites: [] });
  const [requireCampsites, setRequireCampsites] = useState(false);

  // Great Circle distance helper
  const getDistanceInMeters = (lon1, lat1, lon2, lat2) => {
    const R = 6371000; // Earth radius in meters
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  // Initialize Map & Dynamic Styles
  useEffect(() => {
    const vectorLayer = new VectorLayer({
      source: vectorSourceRef.current,
      style: (feature) => {
        const type = feature.get('type');
        const labelText = feature.get('label') || '';

        // 1. Center Origin Marker
        if (type === 'center') {
          return new Style({
            image: new Circle({
              radius: 9,
              fill: new Fill({ color: '#ef4444' }),
              stroke: new Stroke({ color: '#ffffff', width: 2 })
            })
          });
        }

        // 2. Airport Marker
        if (type === 'airport') {
          return new Style({
            image: new Circle({
              radius: 8,
              fill: new Fill({ color: '#2563eb' }),
              stroke: new Stroke({ color: '#ffffff', width: 2 })
            }),
            text: new Text({
              text: feature.get('name'),
              offsetY: -14,
              fill: new Fill({ color: '#1e3a8a' }),
              stroke: new Stroke({ color: '#ffffff', width: 2 })
            })
          });
        }

        // 3. Campsite Marker
        if (type === 'campsite') {
          return new Style({
            image: new Circle({
              radius: 6,
              fill: new Fill({ color: '#16a34a' }),
              stroke: new Stroke({ color: '#ffffff', width: 1.5 })
            }),
            text: new Text({
              text: feature.get('name'),
              offsetY: 14,
              fill: new Fill({ color: '#14532d' }),
              stroke: new Stroke({ color: '#ffffff', width: 2 })
            })
          });
        }

        // 4. Distance Line: Center -> Airport (Solid Line, NM)
        if (type === 'line-center-airport') {
          return new Style({
            stroke: new Stroke({ color: '#0284c7', width: 2 }),
            text: new Text({
              text: labelText,
              font: 'bold 12px sans-serif',
              placement: 'line',
              textBaseline: 'bottom',
              fill: new Fill({ color: '#0369a1' }),
              stroke: new Stroke({ color: '#ffffff', width: 3 })
            })
          });
        }

        // 5. Distance Line: Airport -> Campsite (Dotted Line, SM)
        if (type === 'line-airport-camp') {
          return new Style({
            stroke: new Stroke({ color: '#ea580c', width: 2, lineDash: [4, 6] }),
            text: new Text({
              text: labelText,
              font: 'bold 11px sans-serif',
              placement: 'line',
              textBaseline: 'bottom',
              fill: new Fill({ color: '#c2410c' }),
              stroke: new Stroke({ color: '#ffffff', width: 3 })
            })
          });
        }
      }
    });

    const initialMap = new Map({
      target: mapElement.current,
      layers: [new TileLayer({ source: new OSM() }), vectorLayer],
      view: new View({
        center: fromLonLat(centerCoords),
        zoom: 8
      })
    });

    // Update center coordinates on click
    initialMap.on('singleclick', (evt) => {
      const lonLat = toLonLat(evt.coordinate);
      setCenterCoords(lonLat);
    });

    mapRef.current = initialMap;
    return () => initialMap.setTarget(null);
  }, []);

  const handleSearch = async () => {
    setLoading(true);
    setStatusLog('Initializing spatial search...');
    vectorSourceRef.current.clear();

    const [lon, lat] = centerCoords;
    const airportRadiusMeters = airportRadiusMiles * 1609.34;
    const campRadiusMeters = campRadiusMiles * 1609.34;
    
    // The absolute furthest a campsite could be from center
    const totalMaxRadiusMeters = airportRadiusMeters + campRadiusMeters; 

    console.group('--- OVERPASS SPATIAL QUERY START ---');
    console.log(`[Config] Origin: Lat ${lat.toFixed(4)}, Lon ${lon.toFixed(4)}`);
    console.log(`[Config] Airport Radius: ${airportRadiusMiles} mi`);
    console.log(`[Config] Filter Campsites: ${requireCampsites ? 'YES' : 'NO'}`);

    vectorSourceRef.current.addFeature(
      new Feature({
        geometry: new Point(fromLonLat([lon, lat])),
        type: 'center'
      })
    );

    let overpassQuery = `[out:json][timeout:45];\n(\n`;
    overpassQuery += `  node["aeroway"="aerodrome"](around:${airportRadiusMeters},${lat},${lon});\n`;
    overpassQuery += `  way["aeroway"="aerodrome"](around:${airportRadiusMeters},${lat},${lon});\n`;
    
    if (requireCampsites) {
      overpassQuery += `  node["tourism"="camp_site"](around:${totalMaxRadiusMeters},${lat},${lon});\n`;
      overpassQuery += `  way["tourism"="camp_site"](around:${totalMaxRadiusMeters},${lat},${lon});\n`;
    }
    
    overpassQuery += `);\nout center;`;

    let data = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        console.log(`[HTTP POST] Attempting server: ${endpoint}`);
        setStatusLog(`Contacting API server (${new URL(endpoint).hostname})...`);

        const startTime = performance.now();
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(overpassQuery)}`
        });

        const duration = (performance.now() - startTime).toFixed(0);
        console.log(`[HTTP Response] Code: ${response.status} (${duration}ms)`);

        if (response.ok) {
          data = await response.json();
          break;
        }
      } catch (err) {
        console.error(`[Network Error] Endpoint ${endpoint} failed:`, err);
      }
    }

    if (!data || !data.elements) {
      setStatusLog('Search failed: API servers unresponsive.');
      console.groupEnd();
      setLoading(false);
      return;
    }

    console.log(`[Overpass Elements Found] Total Elements: ${data.elements.length}`);

    const airportsRaw = [];
    const campsitesRaw = [];

    data.elements.forEach((elem) => {
      const eLat = elem.lat || elem.center?.lat;
      const eLon = elem.lon || elem.center?.lon;
      if (!eLat || !eLon) return;

      const name = elem.tags?.name || elem.tags?.['seamark:name'] || 'Unnamed';
      if (elem.tags?.aeroway === 'aerodrome') {
        airportsRaw.push({ id: elem.id, name, lat: eLat, lon: eLon });
      } else if (elem.tags?.tourism === 'camp_site') {
        campsitesRaw.push({ id: elem.id, name, lat: eLat, lon: eLon });
      }
    });

    console.log(`[Parsed Structures] Airports: ${airportsRaw.length}, Campsites: ${campsitesRaw.length}`);

    // --- CLIENT-SIDE DISTANCE FILTERING & LINKING ---
    const linkedAirports = [];
    const campsitesDictionary = {}; // Using standard JS Object to avoid Map prototype issues

    airportsRaw.forEach((apt) => {
      const localCampsites = [];
      
      if (requireCampsites) {
        campsitesRaw.forEach((camp) => {
          const distMeters = getDistanceInMeters(apt.lon, apt.lat, camp.lon, camp.lat);
          if (distMeters <= campRadiusMeters) {
            localCampsites.push({ ...camp, distMeters });
          }
        });

        // Skip airports with no qualifying campsites nearby
        if (localCampsites.length === 0) return;
      }

      const aptGeom = fromLonLat([apt.lon, apt.lat]);

      // Add Airport Point
      vectorSourceRef.current.addFeature(
        new Feature({ geometry: new Point(aptGeom), name: apt.name, type: 'airport' })
      );
      linkedAirports.push(apt);

      // Line: Origin -> Airport (NM)
      const distFromCenterMeters = getDistanceInMeters(lon, lat, apt.lon, apt.lat);
      const distNM = (distFromCenterMeters / 1852).toFixed(1);
      vectorSourceRef.current.addFeature(
        new Feature({
          geometry: new LineString([fromLonLat([lon, lat]), aptGeom]),
          type: 'line-center-airport',
          label: `${distNM} NM`
        })
      );

      // Render lines to nearby campsites
      localCampsites.forEach((camp) => {
        const campGeom = fromLonLat([camp.lon, camp.lat]);

        // Deduplicate campsite point features
        if (!campsitesDictionary[camp.id]) {
          vectorSourceRef.current.addFeature(
            new Feature({ geometry: new Point(campGeom), name: camp.name, type: 'campsite' })
          );
          campsitesDictionary[camp.id] = camp;
        }

        // Add Airport -> Campsite connecting line (SM)
        const distSM = (camp.distMeters / 1609.34).toFixed(1);
        vectorSourceRef.current.addFeature(
          new Feature({
            geometry: new LineString([aptGeom, campGeom]),
            type: 'line-airport-camp',
            label: `${distSM} SM`
          })
        );
      });
    });

    const finalCampsitesArray = Object.values(campsitesDictionary);
    console.log(`[Map Rendering] Plotted ${linkedAirports.length} Airports & ${finalCampsitesArray.length} Campsites.`);
    console.groupEnd();

    setResults({ airports: linkedAirports, campsites: finalCampsitesArray });
    setStatusLog(`Done. Displaying ${linkedAirports.length} matching airports and ${finalCampsitesArray.length} campsites.`);
    setLoading(false);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', fontFamily: 'sans-serif' }}>
      {/* Control Panel Sidebar */}
      <div style={{ width: '340px', padding: '1.25rem', background: '#f8fafc', overflowY: 'auto', borderRight: '1px solid #e2e8f0' }}>
        <h2 style={{ marginTop: 0 }}>Air & Camp Finder</h2>
        <p style={{ fontSize: '0.85rem', color: '#64748b' }}>
          Click map to position center origin point.
        </p>

        <div style={{ marginBottom: '1rem', fontSize: '0.9rem' }}>
          <strong>Center:</strong> {centerCoords[1].toFixed(4)}, {centerCoords[0].toFixed(4)}
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>Origin to Airport Radius (Miles)</label>
          <input 
            type="number" 
            value={airportRadiusMiles} 
            onChange={(e) => setAirportRadiusMiles(Number(e.target.value))}
            style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>Airport to Campsite Radius (Miles)</label>
          <input 
            type="number" 
            value={campRadiusMiles} 
            onChange={(e) => setCampRadiusMiles(Number(e.target.value))}
            style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input 
            type="checkbox" 
            id="toggleCampsites"
            checked={requireCampsites} 
            onChange={(e) => setRequireCampsites(e.target.checked)}
            style={{ width: '16px', height: '16px', cursor: 'pointer' }}
          />
          <label htmlFor="toggleCampsites" style={{ fontSize: '0.85rem', cursor: 'pointer', fontWeight: 'bold' }}>
            Filter by nearby campsites
          </label>
        </div>

        <button 
          onClick={handleSearch} 
          disabled={loading}
          style={{ width: '100%', padding: '0.75rem', background: loading ? '#94a3b8' : '#2563eb', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
        >
          {loading ? 'Searching...' : 'Find Matches'}
        </button>

        {/* Live Logs Display */}
        {statusLog && (
          <div style={{ marginTop: '1rem', padding: '0.5rem', background: '#e2e8f0', borderRadius: '4px', fontSize: '0.75rem', color: '#334155' }}>
            {statusLog}
          </div>
        )}

        {/* Legend */}
        <div style={{ marginTop: '1.5rem', borderTop: '1px solid #cbd5e1', paddingTop: '1rem' }}>
          <h4 style={{ margin: '0 0 0.5rem 0' }}>Legend</h4>
          <div style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div><span style={{ color: '#ef4444' }}>●</span> Center Location</div>
            <div><span style={{ color: '#2563eb' }}>●</span> Airport</div>
            <div><span style={{ color: '#16a34a' }}>●</span> Campsite</div>
            <div><span style={{ color: '#0284c7' }}>━</span> Center to Airport (Nautical Miles)</div>
            <div><span style={{ color: '#ea580c' }}>┈</span> Airport to Campsite (Statute Miles)</div>
          </div>
        </div>

        {/* Results Overview */}
        <div style={{ marginTop: '1.5rem', borderTop: '1px solid #cbd5e1', paddingTop: '1rem' }}>
          <h4 style={{ margin: '0 0 0.5rem 0' }}>Results Summary</h4>
          <p style={{ margin: '4px 0', fontSize: '0.9rem' }}>Airports: <strong>{results.airports.length}</strong></p>
          <p style={{ margin: '4px 0', fontSize: '0.9rem' }}>Campsites: <strong>{results.campsites.length}</strong></p>
        </div>
      </div>

      {/* Map Canvas */}
      <div ref={mapElement} style={{ flex: 1, height: '100%' }} />
    </div>
  );
}