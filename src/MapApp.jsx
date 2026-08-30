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
import Overlay from 'ol/Overlay';
import { fromLonLat, toLonLat } from 'ol/proj';
import { Style, Circle, Fill, Stroke, Text } from 'ol/style';
import './MapApp.css';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const KPDK_COORDS = [-84.3020, 33.8756];

export default function MapApp() {
  const mapElement = useRef(null);
  const tooltipElement = useRef(null);
  const mapRef = useRef(null);
  const overlayRef = useRef(null);
  const vectorSourceRef = useRef(new VectorSource());

  const [centerCoords, setCenterCoords] = useState(KPDK_COORDS);
  const [airportRadiusMiles, setAirportRadiusMiles] = useState(50);
  const [campRadiusMiles, setCampRadiusMiles] = useState(15);
  const [surfaceFilter, setSurfaceFilter] = useState('any');
  const [accessFilter, setAccessFilter] = useState('any');
  const [minRunwayLength, setMinRunwayLength] = useState(0);

  const [loading, setLoading] = useState(false);
  const [statusLog, setStatusLog] = useState('Click anywhere on map to set origin marker.');
  const [results, setResults] = useState({ airports: [], campsites: [] });
  const [tooltipData, setTooltipData] = useState(null);

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

    const overlay = new Overlay({
      element: tooltipElement.current,
      offset: [0, -10],
      positioning: 'bottom-center'
    });
    overlayRef.current = overlay;

    const initialMap = new Map({
      target: mapElement.current,
      layers: [new TileLayer({ source: new OSM() }), vectorLayer],
      overlays: [overlay],
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

    initialMap.on('pointermove', (evt) => {
      if (evt.dragging) {
        overlay.setPosition(undefined);
        return;
      }

      const feature = initialMap.forEachFeatureAtPixel(evt.pixel, (f) => f);
      const featureType = feature?.get('type');

      if (feature && (featureType === 'airport' || featureType === 'campsite')) {
        const coordinates = feature.getGeometry().getCoordinates();
        const payload = feature.get('payload');
        
        setTooltipData({
          type: featureType,
          name: feature.get('name'),
          details: payload
        });

        overlay.setPosition(coordinates);
        mapElement.current.style.cursor = 'pointer';
      } else {
        overlay.setPosition(undefined);
        mapElement.current.style.cursor = '';
      }
    });

    mapRef.current = initialMap;
    return () => initialMap.setTarget(null);
  }, []);

  const handleClearResults = () => {
    vectorSourceRef.current.clear();
    updateOriginMarker(centerCoords);
    setResults({ airports: [], campsites: [] });
    if (overlayRef.current) overlayRef.current.setPosition(undefined);
    setStatusLog('Results cleared. Ready for search.');
  };

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
      console.warn('OSRM routing fallback used.', e);
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
    if (overlayRef.current) overlayRef.current.setPosition(undefined);

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
      setStatusLog('Search failed: Overpass servers unresponsive.');
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
        const surface = tags.surface || tags['aeroway:surface'] || 'Unknown';
        const access = tags.access || 'Public';
        const lengthFeet = tags.length ? Math.round(parseFloat(tags.length) * (tags.length.includes('m') ? 3.28084 : 1)) : 0;
        const icao = tags.icao || tags['ref:icao'] || 'N/A';

        airportsRaw.push({ id: elem.id, name, lat: eLat, lon: eLon, surface, access, lengthFeet, icao });
      } else if (tags.tourism === 'camp_site') {
        const fee = tags.fee || 'Unknown';
        const capacity = tags.capacity || 'N/A';
        campsitesRaw.push({ id: elem.id, name, lat: eLat, lon: eLon, fee, capacity });
      }
    });

    const filteredAirports = airportsRaw.filter((apt) => {
      if (accessFilter === 'public' && apt.access.toLowerCase() === 'private') return false;
      if (accessFilter === 'private' && apt.access.toLowerCase() !== 'private') return false;

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
          new Feature({
            geometry: new Point(aptGeom),
            name: apt.name,
            type: 'airport',
            payload: apt
          })
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
              new Feature({
                geometry: new Point(campGeom),
                name: camp.name,
                type: 'campsite',
                payload: camp
              })
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
    setStatusLog(`Found ${validAirports.length} airports connected to campsites via road.`);
    setLoading(false);
  };

  return (
    <div className="app-container">
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>RampCamp</h2>
          <p>For General Aviation and Camping enthusiasts.</p>
        </div>

        <div className="origin-card">
          <span className="label">Origin:</span> {centerCoords[1].toFixed(4)}, {centerCoords[0].toFixed(4)}
        </div>

        <div className="sidebar-header">
          <p>Click anywhere on the map to set origin marker.</p>
        </div>

        <div className="filter-group">
          <div className="control-item">
            <label>Flight Radius: {airportRadiusMiles} NM</label>
            <input type="range" min="10" max="500" value={airportRadiusMiles} onChange={(e) => setAirportRadiusMiles(Number(e.target.value))} />
          </div>

          <div className="control-item">
            <label>Road Radius to Camp: {campRadiusMiles} Miles</label>
            <input type="range" min="1" max="25" value={campRadiusMiles} onChange={(e) => setCampRadiusMiles(Number(e.target.value))} />
          </div>

          <div className="control-item">
            <label>Surface Type</label>
            <select value={surfaceFilter} onChange={(e) => setSurfaceFilter(e.target.value)}>
              <option value="any">Any Surface</option>
              <option value="paved">Paved Only (Asphalt/Concrete)</option>
              <option value="unpaved">Unpaved Only (Turf/Grass/Dirt)</option>
            </select>
          </div>

          <div className="control-item">
            <label>Airport Access</label>
            <select value={accessFilter} onChange={(e) => setAccessFilter(e.target.value)}>
              <option value="any">Public & Private</option>
              <option value="public">Public Access Only</option>
              <option value="private">Private Access Only</option>
            </select>
          </div>

          <div className="control-item">
            <label>Min Runway Length: {minRunwayLength} ft</label>
            <input type="range" min="0" max="8000" step="500" value={minRunwayLength} onChange={(e) => setMinRunwayLength(Number(e.target.value))} />
          </div>
        </div>

        <div className="action-buttons">
          <button onClick={handleSearch} disabled={loading} className="btn-search">
            {loading ? 'Searching...' : 'Find Matches'}
          </button>
          <button 
            onClick={handleClearResults} 
            disabled={loading || (results.airports.length === 0 && results.campsites.length === 0)} 
            className="btn-clear"
          >
            Clear
          </button>
        </div>

        <div className="status-card">{statusLog}</div>

        <div className="sidebar-section">
          <div className="section-title">Legend</div>
          <div className="legend-list">
            <div><span className="dot-origin">●</span> Origin Location</div>
            <div><span className="dot-airport">●</span> Airport</div>
            <div><span className="dot-campsite">●</span> Campsite</div>
            <div><span className="line-air">┈</span> Direct Air Path (NM)</div>
            <div><span className="line-road">━</span> Driving Route (Miles)</div>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="section-title">Matches</div>
          <div className="result-stat-airport">Airports: <strong>{results.airports.length}</strong></div>
          <div className="result-stat-campsite">Campsites: <strong>{results.campsites.length}</strong></div>
        </div>
      </div>

      <div className="map-container" ref={mapElement}>
        {/* Dynamic Tooltip Overlay Element */}
        <div ref={tooltipElement} className="ol-tooltip">
          {tooltipData && (
            <>
              <div className="ol-tooltip-header">{tooltipData.name}</div>
              {tooltipData.type === 'airport' && tooltipData.details && (
                <div>
                  <div>ICAO: <strong>{tooltipData.details.icao}</strong></div>
                  <div>Surface: <strong>{tooltipData.details.surface}</strong></div>
                  <div>Access: <strong>{tooltipData.details.access}</strong></div>
                  {tooltipData.details.lengthFeet > 0 && (
                    <div>Est. Length: <strong>{tooltipData.details.lengthFeet} ft</strong></div>
                  )}
                  <span className="ol-tooltip-badge badge-airport">Airport</span>
                </div>
              )}
              {tooltipData.type === 'campsite' && tooltipData.details && (
                <div>
                  <div>Fee Info: <strong>{tooltipData.details.fee}</strong></div>
                  <div>Capacity: <strong>{tooltipData.details.capacity}</strong></div>
                  <span className="ol-tooltip-badge badge-campsite">Campsite</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}