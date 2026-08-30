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

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const KPDK_COORDS = [-84.3020, 33.8756];

export default function MapApp() {
  const mapElement = useRef(null);
  const mapRef = useRef(null);
  const vectorSourceRef = useRef(new VectorSource());

  const [centerCoords, setCenterCoords] = useState(KPDK_COORDS);
  const [airportRadiusMiles, setAirportRadiusMiles] = useState(50);
  const [campRadiusMiles, setCampRadiusMiles] = useState(15);
  const [surfaceFilter, setSurfaceFilter] = useState('any');
  const [accessFilter, setAccessFilter] = useState('any');
  const [minRunwayLength, setMinRunwayLength] = useState(0);
  
  const [loading, setLoading] = useState(false);
  const [statusLog, setStatusLog] = useState('Click anywhere on the map to place origin marker.');
  const [results, setResults] = useState({ airports: [], campsites: [] });

  const updateOriginMarker = (coords) => {
    const features = vectorSourceRef.current.getFeatures();
    features.forEach((f) => {
      if (f.get('type') === 'center') vectorSourceRef.current.removeFeature(f);
    });

    vectorSourceRef.current.addFeature(
      new Feature({
        geometry: new Point(fromLonLat(coords)),
        type: 'center'
      })
    );
  };

  useEffect(() => {
    const vectorLayer = new VectorLayer({
      source: vectorSourceRef.current,
      style: (feature) => {
        const type = feature.get('type');
        const labelText = feature.get('label') || '';

        if (type === 'center') {
          return new Style({
            image: new Circle({
              radius: 9,
              fill: new Fill({ color: '#f43f5e' }),
              stroke: new Stroke({ color: '#ffffff', width: 3 })
            })
          });
        }

        if (type === 'airport') {
          return new Style({
            image: new Circle({
              radius: 7,
              fill: new Fill({ color: '#3b82f6' }),
              stroke: new Stroke({ color: '#ffffff', width: 2 })
            }),
            text: new Text({
              text: feature.get('name'),
              offsetY: -14,
              font: 'bold 11px sans-serif',
              fill: new Fill({ color: '#1e293b' }),
              stroke: new Stroke({ color: '#ffffff', width: 3 })
            })
          });
        }

        if (type === 'campsite') {
          return new Style({
            image: new Circle({
              radius: 6,
              fill: new Fill({ color: '#10b981' }),
              stroke: new Stroke({ color: '#ffffff', width: 2 })
            }),
            text: new Text({
              text: feature.get('name'),
              offsetY: 14,
              font: '10px sans-serif',
              fill: new Fill({ color: '#064e3b' }),
              stroke: new Stroke({ color: '#ffffff', width: 3 })
            })
          });
        }

        if (type === 'line-center-airport') {
          return new Style({
            stroke: new Stroke({ color: '#0284c7', width: 2, lineDash: [6, 4] }),
            text: new Text({
              text: labelText,
              font: 'bold 11px sans-serif',
              placement: 'line',
              textBaseline: 'bottom',
              fill: new Fill({ color: '#0369a1' }),
              stroke: new Stroke({ color: '#ffffff', width: 3 })
            })
          });
        }

        if (type === 'route-airport-camp') {
          return new Style({
            stroke: new Stroke({ color: '#f97316', width: 3 }),
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
        center: fromLonLat(KPDK_COORDS),
        zoom: 9
      })
    });

    updateOriginMarker(KPDK_COORDS);

    initialMap.on('singleclick', (evt) => {
      const lonLat = toLonLat(evt.coordinate);
      setCenterCoords(lonLat);
      updateOriginMarker(lonLat);
    });

    mapRef.current = initialMap;
    return () => initialMap.setTarget(null);
  }, []);

  const getRoadRoute = async (startLon, startLat, endLon, endLat) => {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.code === 'Ok' && data.routes.length > 0) {
        const route = data.routes[0];
        const coordinates = route.geometry.coordinates.map((c) => fromLonLat(c));
        const distanceMiles = (route.distance / 1609.34).toFixed(1);
        return { coordinates, distanceMiles };
      }
    } catch (e) {
      console.warn('OSRM routing failed, falling back to straight line.', e);
    }

    const distMeters = getDistanceInMeters(startLon, startLat, endLon, endLat);
    return {
      coordinates: [fromLonLat([startLon, startLat]), fromLonLat([endLon, endLat])],
      distanceMiles: (distMeters / 1609.34).toFixed(1)
    };
  };

  const getDistanceInMeters = (lon1, lat1, lon2, lat2) => {
    const R = 6371000;
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const handleSearch = async () => {
    setLoading(true);
    setStatusLog('Querying Overpass API...');
    
    vectorSourceRef.current.clear();
    updateOriginMarker(centerCoords);

    const [lon, lat] = centerCoords;
    const airportRadiusMeters = airportRadiusMiles * 1609.34;
    const campRadiusMeters = campRadiusMiles * 1609.34;
    const totalSearchRadius = airportRadiusMeters + campRadiusMeters;

    let overpassQuery = `[out:json][timeout:45];\n(\n`;
    overpassQuery += `  node["aeroway"="aerodrome"](around:${airportRadiusMeters},${lat},${lon});\n`;
    overpassQuery += `  way["aeroway"="aerodrome"](around:${airportRadiusMeters},${lat},${lon});\n`;
    overpassQuery += `  node["tourism"="camp_site"](around:${totalSearchRadius},${lat},${lon});\n`;
    overpassQuery += `  way["tourism"="camp_site"](around:${totalSearchRadius},${lat},${lon});\n`;
    overpassQuery += `);\nout center;`;

    let data = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(overpassQuery)}`
        });
        if (response.ok) {
          data = await response.json();
          break;
        }
      } catch (err) {
        console.error(err);
      }
    }

    if (!data || !data.elements) {
      setStatusLog('Search failed: Overpass server unresponsive.');
      setLoading(false);
      return;
    }

    const airportsRaw = [];
    const campsitesRaw = [];

    data.elements.forEach((elem) => {
      const eLat = elem.lat || elem.center?.lat;
      const eLon = elem.lon || elem.center?.lon;
      if (!eLat || !eLon) return;

      const tags = elem.tags || {};
      const name = tags.name || tags['seamark:name'] || 'Unnamed Facility';

      if (tags.aeroway === 'aerodrome') {
        const surface = tags.surface || tags['aeroway:surface'] || 'unknown';
        const access = tags.access || 'public';
        const lengthFeet = tags.length ? parseFloat(tags.length) * (tags.length.includes('m') ? 3.28084 : 1) : 0;

        airportsRaw.push({ id: elem.id, name, lat: eLat, lon: eLon, surface, access, lengthFeet });
      } else if (tags.tourism === 'camp_site') {
        campsitesRaw.push({ id: elem.id, name, lat: eLat, lon: eLon });
      }
    });

    const filteredAirports = airportsRaw.filter((apt) => {
      if (accessFilter === 'public' && apt.access === 'private') return false;
      if (accessFilter === 'private' && apt.access !== 'private') return false;

      const isPaved = ['asphalt', 'concrete', 'paved'].includes(apt.surface.toLowerCase());
      if (surfaceFilter === 'paved' && !isPaved) return false;
      if (surfaceFilter === 'unpaved' && isPaved) return false;

      if (minRunwayLength > 0 && apt.lengthFeet > 0 && apt.lengthFeet < minRunwayLength) return false;

      return true;
    });

    setStatusLog(`Calculating road routes for ${filteredAirports.length} qualifying airports...`);

    const validAirports = [];
    const campsitesDict = {};

    for (const apt of filteredAirports) {
      const nearbyCamps = [];

      for (const camp of campsitesRaw) {
        const directMeters = getDistanceInMeters(apt.lon, apt.lat, camp.lon, camp.lat);
        if (directMeters <= campRadiusMeters * 1.5) {
          nearbyCamps.push(camp);
        }
      }

      const validRouteConnections = [];
      for (const camp of nearbyCamps) {
        const route = await getRoadRoute(apt.lon, apt.lat, camp.lon, camp.lat);
        if (parseFloat(route.distanceMiles) <= campRadiusMiles) {
          validRouteConnections.push({ camp, route });
        }
      }

      if (validRouteConnections.length > 0) {
        const aptGeom = fromLonLat([apt.lon, apt.lat]);

        vectorSourceRef.current.addFeature(
          new Feature({ geometry: new Point(aptGeom), name: apt.name, type: 'airport' })
        );
        validAirports.push(apt);

        const distFromCenterMeters = getDistanceInMeters(lon, lat, apt.lon, apt.lat);
        const distNM = (distFromCenterMeters / 1852).toFixed(1);
        vectorSourceRef.current.addFeature(
          new Feature({
            geometry: new LineString([fromLonLat([lon, lat]), aptGeom]),
            type: 'line-center-airport',
            label: `${distNM} NM`
          })
        );

        validRouteConnections.forEach(({ camp, route }) => {
          const campGeom = fromLonLat([camp.lon, camp.lat]);

          if (!campsitesDict[camp.id]) {
            vectorSourceRef.current.addFeature(
              new Feature({ geometry: new Point(campGeom), name: camp.name, type: 'campsite' })
            );
            campsitesDict[camp.id] = camp;
          }

          vectorSourceRef.current.addFeature(
            new Feature({
              geometry: new LineString(route.coordinates),
              type: 'route-airport-camp',
              label: `${route.distanceMiles} mi (Road)`
            })
          );
        });
      }
    }

    const matchedCampsites = Object.values(campsitesDict);
    setResults({ airports: validAirports, campsites: matchedCampsites });
    setStatusLog(`Found ${validAirports.length} airports with road-accessible campsites within ${campRadiusMiles} miles.`);
    setLoading(false);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', fontFamily: 'Inter, system-ui, sans-serif', background: '#0f172a', color: '#f8fafc' }}>
      <div style={{ width: '360px', padding: '1.5rem', background: '#1e293b', overflowY: 'auto', borderRight: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.4rem', color: '#38bdf8', fontWeight: 700 }}>Air & Camp Explorer</h2>
          <p style={{ margin: '4px 0 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>
            Click anywhere on the map to re-position your origin.
          </p>
        </div>

        <div style={{ background: '#0f172a', padding: '0.75rem', borderRadius: '6px', border: '1px solid #334155', fontSize: '0.85rem' }}>
          <span style={{ color: '#94a3b8' }}>Origin:</span> {centerCoords[1].toFixed(4)}, {centerCoords[0].toFixed(4)}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1' }}>Flight Radius: {airportRadiusMiles} NM</label>
            <input type="range" min="10" max="150" value={airportRadiusMiles} onChange={(e) => setAirportRadiusMiles(Number(e.target.value))} style={{ width: '100%' }} />
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1' }}>Road Radius to Camp: {campRadiusMiles} Miles</label>
            <input type="range" min="1" max="50" value={campRadiusMiles} onChange={(e) => setCampRadiusMiles(Number(e.target.value))} style={{ width: '100%' }} />
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1' }}>Surface Type</label>
            <select value={surfaceFilter} onChange={(e) => setSurfaceFilter(e.target.value)} style={{ width: '100%', padding: '0.5rem', background: '#0f172a', color: '#fff', border: '1px solid #334155', borderRadius: '4px', marginTop: '4px' }}>
              <option value="any">Any Surface</option>
              <option value="paved">Paved Only (Asphalt/Concrete)</option>
              <option value="unpaved">Unpaved Only (Turf/Grass/Dirt)</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1' }}>Airport Access</label>
            <select value={accessFilter} onChange={(e) => setAccessFilter(e.target.value)} style={{ width: '100%', padding: '0.5rem', background: '#0f172a', color: '#fff', border: '1px solid #334155', borderRadius: '4px', marginTop: '4px' }}>
              <option value="any">Public & Private</option>
              <option value="public">Public Access Only</option>
              <option value="private">Private Access Only</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1' }}>Min Runway Length: {minRunwayLength} ft</label>
            <input type="range" min="0" max="8000" step="500" value={minRunwayLength} onChange={(e) => setMinRunwayLength(Number(e.target.value))} style={{ width: '100%' }} />
          </div>
        </div>

        <button onClick={handleSearch} disabled={loading} style={{ padding: '0.75rem', background: loading ? '#475569' : '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '0.9rem' }}>
          {loading ? 'Searching...' : 'Find Airports & Campsites'}
        </button>

        <div style={{ padding: '0.75rem', background: '#0f172a', borderRadius: '6px', border: '1px solid #334155', fontSize: '0.75rem', color: '#94a3b8' }}>
          {statusLog}
        </div>

        <div style={{ borderTop: '1px solid #334155', paddingTop: '1rem', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.8rem' }}>
          <div style={{ fontWeight: 600, color: '#cbd5e1', marginBottom: '4px' }}>Legend</div>
          <div><span style={{ color: '#f43f5e' }}>●</span> Origin Location</div>
          <div><span style={{ color: '#3b82f6' }}>●</span> Airport</div>
          <div><span style={{ color: '#10b981' }}>●</span> Campsite</div>
          <div><span style={{ color: '#0284c7' }}>┈</span> Direct Air Path (NM)</div>
          <div><span style={{ color: '#f97316' }}>━</span> Road/Path Driving Distance (Miles)</div>
        </div>

        <div style={{ borderTop: '1px solid #334155', paddingTop: '1rem' }}>
          <div style={{ fontWeight: 600, color: '#cbd5e1', marginBottom: '4px', fontSize: '0.85rem' }}>Matches</div>
          <div style={{ fontSize: '0.9rem', color: '#38bdf8' }}>Airports: <strong>{results.airports.length}</strong></div>
          <div style={{ fontSize: '0.9rem', color: '#34d399' }}>Campsites: <strong>{results.campsites.length}</strong></div>
        </div>
      </div>

      <div ref={mapElement} style={{ flex: 1, height: '100%' }} />
    </div>
  );
}