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

import faaAirports from './airports.json';
import './MapApp.css';

const KPDK_COORDS = [-84.3020, 33.8756];

export default function MapApp() {
  const mapElement = useRef(null);
  const tooltipElement = useRef(null);
  const mapRef = useRef(null);
  const overlayRef = useRef(null);
  const vectorSourceRef = useRef(new VectorSource());
  const abortControllerRef = useRef(null);

  const [centerCoords, setCenterCoords] = useState(KPDK_COORDS);
  const [airportRadiusMiles, setAirportRadiusMiles] = useState(50);
  const [campRadiusMiles, setCampRadiusMiles] = useState(15);
  
  const [maxQueriedAirportRadius, setMaxQueriedAirportRadius] = useState(150);
  const [maxQueriedCampRadius, setMaxQueriedCampRadius] = useState(50);

  const [surfaceFilter, setSurfaceFilter] = useState('any');
  const [accessFilter, setAccessFilter] = useState('public');
  const [minRunwayLength, setMinRunwayLength] = useState(0);

  const [loading, setLoading] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [statusLog, setStatusLog] = useState('Click anywhere on map to set origin marker.');
  
  const [cachedData, setCachedData] = useState(null);
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
      setIsLocked((locked) => {
        if (locked) return locked;
        const lonLat = toLonLat(evt.coordinate);
        setCenterCoords(lonLat);
        updateOriginMarker(lonLat);
        return false;
      });
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

  const getRoadRoute = async (startLon, startLat, endLon, endLat, signal) => {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&geometries=geojson`;
      const res = await fetch(url, { signal });
      const data = await res.json();

      if (data.code === 'Ok' && data.routes.length > 0) {
        const route = data.routes[0];
        const coordinates = route.geometry.coordinates.map((c) => fromLonLat(c));
        const distanceMiles = (route.distance / 1609.34).toFixed(1);
        return { coordinates, distanceMiles };
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }

    const distMeters = getDistanceInMeters(startLon, startLat, endLon, endLat);
    return {
      coordinates: [fromLonLat([startLon, startLat]), fromLonLat([endLon, endLat])],
      distanceMiles: (distMeters / 1609.34).toFixed(1)
    };
  };

  // Fast Bounding Box Calculation for a single area-of-interest query
  const getAreaBoundingBox = (lat, lon, airportRadiusNM, campRadiusMiles) => {
    const totalMeters = (airportRadiusNM * 1852) + (campRadiusMiles * 1609.34);
    const latDelta = totalMeters / 111139;
    const lonDelta = totalMeters / (111139 * Math.cos(lat * (Math.PI / 180)));

    const south = (lat - latDelta).toFixed(4);
    const north = (lat + latDelta).toFixed(4);
    const west = (lon - lonDelta).toFixed(4);
    const east = (lon + lonDelta).toFixed(4);

    return `${south},${west},${north},${east}`;
  };

  const fetchAreaCampsites = async (bbox, signal) => {
    const query = `[out:json][timeout:25];(node["tourism"="camp_site"](${bbox});way["tourism"="camp_site"](${bbox}););out center;`;
    
    const endpoints = [
      `/overpass?data=${encodeURIComponent(query)}`,
      `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
      `https://lz4.overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, { signal });
        if (res.ok) return await res.json();
      } catch (err) {
        if (err.name === 'AbortError') throw err;
      }
    }
    return null;
  };

  const handleSearch = async () => {
    setLoading(true);
    setIsLocked(true);
    setStatusLog('Filtering FAA airports from local dataset...');

    vectorSourceRef.current.clear();
    updateOriginMarker(centerCoords);
    if (overlayRef.current) overlayRef.current.setPosition(undefined);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const [lon, lat] = centerCoords;
    const searchCampRadiusMeters = campRadiusMiles * 1609.34;

    // STEP 1: Filter CSV airports first in local memory
    const matchingAirports = faaAirports.filter((apt) => {
      const distMeters = getDistanceInMeters(lon, lat, apt.lon, apt.lat);
      const distNM = distMeters / 1852;
      if (distNM > airportRadiusMiles) return false;

      if (accessFilter === 'public' && !apt.isPublic) return false;
      if (accessFilter === 'private' && apt.isPublic) return false;

      const surfaceLower = apt.surface.toLowerCase();
      const isPaved = surfaceLower.includes('asph') || surfaceLower.includes('conc') || surfaceLower.includes('paved');
      if (surfaceFilter === 'paved' && !isPaved) return false;
      if (surfaceFilter === 'unpaved' && isPaved) return false;

      if (minRunwayLength > 0 && apt.lengthFeet > 0 && apt.lengthFeet < minRunwayLength) return false;

      apt.distFromCenterNM = distNM;
      return true;
    });

    if (matchingAirports.length === 0) {
      setStatusLog('No FAA airports match your criteria in this radius.');
      setLoading(false);
      return;
    }

    // STEP 2: Single Bounding Box query to Overpass for all area campsites
    setStatusLog(`Querying regional campsites for ${matchingAirports.length} candidate airports...`);
    const bbox = getAreaBoundingBox(lat, lon, airportRadiusMiles, campRadiusMiles);
    const campsiteData = await fetchAreaCampsites(bbox, controller.signal);

    if (!campsiteData) {
      setStatusLog('Campsite query failed or timed out. Try reducing search radius.');
      setLoading(false);
      return;
    }

    const allCampsites = (campsiteData.elements || [])
      .map((elem) => ({
        id: elem.id,
        name: elem.tags?.name || 'Unnamed Campsite',
        lat: elem.lat || elem.center?.lat,
        lon: elem.lon || elem.center?.lon,
        fee: elem.tags?.fee || 'Unknown',
        capacity: elem.tags?.capacity || 'N/A'
      }))
      .filter((c) => c.lat && c.lon);

    setStatusLog(`Evaluating driving connections across ${allCampsites.length} campsites...`);

    // STEP 3: Match campsites to airports locally using straight-line distance, then batch OSRM
    const evaluatedAirports = [];

    for (const apt of matchingAirports) {
      if (controller.signal.aborted) return;

      // Filter campsites near THIS specific airport
      const nearbyCamps = allCampsites.filter((camp) => {
        const directMeters = getDistanceInMeters(apt.lon, apt.lat, camp.lon, camp.lat);
        return directMeters <= searchCampRadiusMeters;
      });

      if (nearbyCamps.length === 0) continue;

      const routePromises = nearbyCamps.map(async (camp) => {
        const route = await getRoadRoute(apt.lon, apt.lat, camp.lon, camp.lat, controller.signal);
        return { camp, route };
      });

      const routeResults = await Promise.all(routePromises);
      const validConnections = routeResults.filter(
        ({ route }) => parseFloat(route.distanceMiles) <= campRadiusMiles
      );

      if (validConnections.length > 0) {
        evaluatedAirports.push({
          ...apt,
          connections: validConnections
        });
      }
    }

    setMaxQueriedAirportRadius(airportRadiusMiles);
    setMaxQueriedCampRadius(campRadiusMiles);

    const fullDataset = { origin: [lon, lat], airports: evaluatedAirports };
    setCachedData(fullDataset);

    renderFilteredResults(fullDataset, airportRadiusMiles, campRadiusMiles, surfaceFilter, accessFilter, minRunwayLength);

    setStatusLog(`Done. Found ${evaluatedAirports.length} airports with nearby campsites.`);
    setLoading(false);
    abortControllerRef.current = null;
  };

  const renderFilteredResults = (dataset, airRadiusLimit, campRadiusLimit, surfaceMode, accessMode, minRunway) => {
    if (!dataset) return;

    vectorSourceRef.current.clear();
    const [lon, lat] = dataset.origin;
    updateOriginMarker([lon, lat]);
    if (overlayRef.current) overlayRef.current.setPosition(undefined);

    const validAirports = [];
    const campsitesDict = {};

    dataset.airports.forEach((apt) => {
      if (apt.distFromCenterNM > airRadiusLimit) return;

      if (accessMode === 'public' && !apt.isPublic) return;
      if (accessMode === 'private' && apt.isPublic) return;

      const surfaceLower = apt.surface.toLowerCase();
      const isPaved = surfaceLower.includes('asph') || surfaceLower.includes('conc') || surfaceLower.includes('paved');
      if (surfaceMode === 'paved' && !isPaved) return;
      if (surfaceMode === 'unpaved' && isPaved) return;

      if (minRunway > 0 && apt.lengthFeet > 0 && apt.lengthFeet < minRunway) return;

      const validConnections = apt.connections.filter(
        ({ route }) => parseFloat(route.distanceMiles) <= campRadiusLimit
      );

      if (validConnections.length > 0) {
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

        vectorSourceRef.current.addFeature(
          new Feature({
            geometry: new LineString([fromLonLat([lon, lat]), aptGeom]),
            type: 'line-center-airport',
            label: `${apt.distFromCenterNM.toFixed(1)} NM`
          })
        );

        validConnections.forEach(({ camp, route }) => {
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
    });

    const matchedCampsites = Object.values(campsitesDict);
    setResults({ airports: validAirports, campsites: matchedCampsites });
  };

  const handleClearResults = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    setLoading(false);
    setIsLocked(false);
    setCachedData(null);
    setResults({ airports: [], campsites: [] });
    
    setMaxQueriedAirportRadius(150);
    setMaxQueriedCampRadius(50);

    vectorSourceRef.current.clear();
    updateOriginMarker(centerCoords);
    if (overlayRef.current) overlayRef.current.setPosition(undefined);
    setStatusLog('Results cleared. Origin unlocked.');
  };

  const handleAirportRadiusChange = (val) => {
    setAirportRadiusMiles(val);
    if (cachedData) {
      renderFilteredResults(cachedData, val, campRadiusMiles, surfaceFilter, accessFilter, minRunwayLength);
    }
  };

  const handleCampRadiusChange = (val) => {
    setCampRadiusMiles(val);
    if (cachedData) {
      renderFilteredResults(cachedData, airportRadiusMiles, val, surfaceFilter, accessFilter, minRunwayLength);
    }
  };

  const handleSurfaceChange = (val) => {
    setSurfaceFilter(val);
    if (cachedData) {
      renderFilteredResults(cachedData, airportRadiusMiles, campRadiusMiles, val, accessFilter, minRunwayLength);
    }
  };

  const handleAccessChange = (val) => {
    setAccessFilter(val);
    if (cachedData) {
      renderFilteredResults(cachedData, airportRadiusMiles, campRadiusMiles, surfaceFilter, val, minRunwayLength);
    }
  };

  const handleRunwayChange = (val) => {
    setMinRunwayLength(val);
    if (cachedData) {
      renderFilteredResults(cachedData, airportRadiusMiles, campRadiusMiles, surfaceFilter, accessFilter, val);
    }
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
          {isLocked && <span className="locked-badge">[LOCKED]</span>}
        </div>

        <div className="filter-group">
          <div className="control-item">
            <label>Flight Radius: {airportRadiusMiles} NM</label>
            <input 
              type="range" 
              min="10" 
              max={maxQueriedAirportRadius} 
              value={airportRadiusMiles} 
              onChange={(e) => handleAirportRadiusChange(Number(e.target.value))} 
            />
          </div>

          <div className="control-item">
            <label>Road Radius to Camp: {campRadiusMiles} Miles</label>
            <input 
              type="range" 
              min="1" 
              max={maxQueriedCampRadius} 
              value={campRadiusMiles} 
              onChange={(e) => handleCampRadiusChange(Number(e.target.value))} 
            />
          </div>

          <div className="control-item">
            <label>Surface Type</label>
            <select value={surfaceFilter} onChange={(e) => handleSurfaceChange(e.target.value)}>
              <option value="any">Any Surface</option>
              <option value="paved">Paved Only (Asphalt/Concrete)</option>
              <option value="unpaved">Unpaved Only (Turf/Grass/Dirt)</option>
            </select>
          </div>

          <div className="control-item">
            <label>Airport Access</label>
            <select value={accessFilter} onChange={(e) => handleAccessChange(e.target.value)}>
              <option value="public">Public Access Only</option>
              <option value="private">Private Access Only</option>
              <option value="any">Public & Private</option>
            </select>
          </div>

          <div className="control-item">
            <label>Min Runway Length: {minRunwayLength} ft</label>
            <input 
              type="range" 
              min="0" 
              max="8000" 
              step="500" 
              value={minRunwayLength} 
              onChange={(e) => handleRunwayChange(Number(e.target.value))} 
            />
          </div>
        </div>

        <div className="action-buttons">
          <button onClick={handleSearch} disabled={loading} className="btn-search">
            {loading ? 'Searching...' : 'Find Matches'}
          </button>
          <button onClick={handleClearResults} className="btn-clear">
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
        <div ref={tooltipElement} className="ol-tooltip">
          {tooltipData && (
            <>
              <div className="ol-tooltip-header">{tooltipData.name}</div>
              {tooltipData.type === 'airport' && tooltipData.details && (
                <div>
                  <div>ICAO/ID: <strong>{tooltipData.details.icao}</strong></div>
                  <div>Surface: <strong>{tooltipData.details.surface}</strong></div>
                  <div>Access: <strong>{tooltipData.details.access}</strong></div>
                  {tooltipData.details.lengthFeet > 0 && (
                    <div>Primary Runway: <strong>{tooltipData.details.lengthFeet} ft</strong></div>
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