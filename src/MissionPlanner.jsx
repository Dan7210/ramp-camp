import React, { useEffect, useRef, useState } from 'react';
import 'ol/ol.css';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import OSM from 'ol/source/OSM';
import XYZ from 'ol/source/XYZ';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import { Translate, Modify } from 'ol/interaction';
import { fromLonLat, toLonLat } from 'ol/proj';
import { Style, Circle, Fill, Stroke, Text } from 'ol/style';

import faaAirports from './airports.json';
import gpsWaypoints from './waypoints.csv';
import './MapApp.css';
import './MissionPlanner.css';

const parseDMSCoords = (dmsStr) => {
  if (!dmsStr) return null;
  const parts = dmsStr.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const parsePart = (str) => {
    const match = str.match(/^(\d+)-(\d+)-([\d.]+)([NSEW])$/);
    if (!match) return null;
    const degrees = Number.parseFloat(match[1]);
    const minutes = Number.parseFloat(match[2]);
    const seconds = Number.parseFloat(match[3]);
    const value = degrees + minutes / 60 + seconds / 3600;
    return match[4] === 'S' || match[4] === 'W' ? -value : value;
  };

  const lat = parsePart(parts[0]);
  const lon = parsePart(parts[1]);
  return lat !== null && lon !== null ? { lat, lon } : null;
};

const extractCoords = (obj) => {
  if (!obj) return null;
  if (Array.isArray(obj) && obj.length >= 2) {
    const lon = Number.parseFloat(obj[0]);
    const lat = Number.parseFloat(obj[1]);
    return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
  }
  const lon = Number.parseFloat(obj.lon ?? obj.longitude ?? obj.lng);
  const lat = Number.parseFloat(obj.lat ?? obj.latitude);
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
};

const getMissionError = (missionData) => {
  if (!missionData) return 'No mission data provided.';
  if (!extractCoords(missionData.origin || missionData.originCoords)) {
    return 'Missing or invalid Origin coordinates.';
  }
  if (!extractCoords(missionData.airport)) {
    return 'Missing or invalid Destination Airport coordinates.';
  }
  return null;
};

const createInitialWaypoints = (missionData) => {
  const origin = extractCoords(missionData?.origin || missionData?.originCoords);
  const airport = extractCoords(missionData?.airport);
  if (!origin || !airport) return [];

  return [
    { id: 'origin_wp', name: 'Origin Marker', type: 'origin', ...origin },
    {
      id: `apt_${missionData.airport.icao || missionData.airport.id || 'dest'}`,
      name: missionData.airport.name || 'Destination Airport',
      type: 'airport',
      icao: missionData.airport.icao || 'N/A',
      surface: missionData.airport.surface || 'Unknown',
      lengthFeet: missionData.airport.lengthFeet || null,
      ...airport
    }
  ];
};

const calculateNM = (p1, p2) => {
  const rad = Math.PI / 180;
  const dLat = (p2.lat - p1.lat) * rad;
  const dLon = (p2.lon - p1.lon) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(p1.lat * rad) * Math.cos(p2.lat * rad) * Math.sin(dLon / 2) ** 2;
  return (6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))) / 1852;
};

const calculateCourse = (start, end) => {
  const rad = Math.PI / 180;
  const y = Math.sin((end.lon - start.lon) * rad) * Math.cos(end.lat * rad);
  const x = Math.cos(start.lat * rad) * Math.sin(end.lat * rad)
    - Math.sin(start.lat * rad) * Math.cos(end.lat * rad) * Math.cos((end.lon - start.lon) * rad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

const roundTo500 = (altitude) => Math.ceil(altitude / 500) * 500;

const getAltitudeSuggestion = (start, end, analysis) => {
  const course = Math.round(calculateCourse(start, end));
  const vfrAltitude = course < 180 ? 5500 : 4500;
  const terrainMslFeet = analysis?.terrainMslFeet ?? null;
  const suggestedMslFeet = roundTo500(Math.max(terrainMslFeet ?? 0, analysis?.airspaceMslFeet ?? vfrAltitude));
  return {
    course,
    suggestedMslFeet,
    terrainMslFeet,
    airspaceMslFeet: analysis?.airspaceMslFeet ?? null,
    rationale: analysis ? [
      `Approximate course ${course}° true; verify magnetic variation before using the VFR hemispheric rule.`,
      `USGS EPQS corridor high point ${analysis.highestTerrainFeet.toLocaleString()} ft MSL; +500 ft terrain minimum ${terrainMslFeet.toLocaleString()} ft MSL.`,
      ...analysis.airspaceNotes
    ] : [
      `Approximate course ${course}° true; verify magnetic variation before using the VFR hemispheric rule.`,
      'Run “Analyze route safety” to sample USGS terrain and query FAA Class B/C/D airspace.',
      'FAA sectional, NOTAM, and TFR review remains required before flight.'
    ]
  };
};

const getCorridorSamples = (start, end, distanceNm) => {
  const count = Math.min(20, Math.max(4, Math.ceil(distanceNm / 5) + 1));
  const courseRadians = calculateCourse(start, end) * Math.PI / 180;
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    const lat = start.lat + (end.lat - start.lat) * ratio;
    const lon = start.lon + (end.lon - start.lon) * ratio;
    return [-0.5, 0, 0.5].map((offsetNm) => {
      const rightBearing = courseRadians + Math.PI / 2;
      const northNm = Math.cos(rightBearing) * offsetNm;
      const eastNm = Math.sin(rightBearing) * offsetNm;
      return {
        lat: lat + northNm / 60,
        lon: lon + eastNm / (60 * Math.max(0.1, Math.cos(lat * Math.PI / 180)))
      };
    });
  }).flat();
};

const getElevation = async ({ lat, lon }) => {
  const parameters = new URLSearchParams({ x: String(lon), y: String(lat), units: 'Feet', wkid: '4326', includeDate: 'false' });
  const response = await fetch(`/usgs-epqs?${parameters}`);
  if (!response.ok) throw new Error(`USGS EPQS returned ${response.status}.`);
  const data = await response.json();
  const elevation = Number(data.value ?? data.USGS_Elevation_Point_Query_Service?.Elevation_Query?.Elevation);
  if (!Number.isFinite(elevation)) throw new Error('USGS EPQS returned no usable elevation.');
  return elevation;
};

const getIntersectingAirspace = async (start, end) => {
  const geometry = JSON.stringify({
    paths: [[[start.lon, start.lat], [end.lon, end.lat]]],
    spatialReference: { wkid: 4326 }
  });
  const parameters = new URLSearchParams({
    f: 'json',
    where: "CLASS IN ('B','C','D')",
    geometry,
    geometryType: 'esriGeometryPolyline',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'IDENT,NAME,CLASS,LOWER_DESC,LOWER_VAL,LOWER_UOM,UPPER_DESC,UPPER_VAL,UPPER_UOM',
    returnGeometry: 'false'
  });
  const response = await fetch(`/faa-airspace?${parameters}`);
  if (!response.ok) throw new Error(`FAA airspace service returned ${response.status}.`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'FAA airspace query failed.');
  return (data.features || []).map((feature) => feature.attributes);
};

const describeAirspace = (airspaces, terrainMslFeet, defaultVfrMslFeet) => {
  const notes = [];
  let airspaceMslFeet = defaultVfrMslFeet;
  airspaces.forEach((airspace) => {
    const lower = Number(airspace.LOWER_VAL);
    const upper = Number(airspace.UPPER_VAL);
    const label = `${airspace.CLASS || 'Class'} ${airspace.NAME || airspace.IDENT || 'airspace'}`;
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
      notes.push(`${label}: FAA vertical limits require chart review (${airspace.LOWER_DESC || 'lower not parsed'} to ${airspace.UPPER_DESC || 'upper not parsed'}).`);
      return;
    }
    if (terrainMslFeet >= lower && terrainMslFeet <= upper) {
      notes.push(`${label}: terrain minimum ${terrainMslFeet.toLocaleString()} ft intersects FAA limits ${lower.toLocaleString()}–${upper.toLocaleString()} ft; airspace penetration may be unavoidable.`);
      return;
    }
    if (defaultVfrMslFeet >= lower && defaultVfrMslFeet <= upper) {
      if (terrainMslFeet < lower - 500) {
        airspaceMslFeet = Math.min(airspaceMslFeet, lower - 500);
        notes.push(`${label}: FAA limits ${lower.toLocaleString()}–${upper.toLocaleString()} ft; underflight is available above the terrain minimum.`);
      } else {
        airspaceMslFeet = Math.max(airspaceMslFeet, upper + 500);
        notes.push(`${label}: FAA limits ${lower.toLocaleString()}–${upper.toLocaleString()} ft; recommendation raised to overfly.`);
      }
      return;
    }
    notes.push(`${label}: FAA limits ${lower.toLocaleString()}–${upper.toLocaleString()} ft; current suggestion remains outside this shelf.`);
  });
  return { airspaceMslFeet, airspaceNotes: notes.length ? notes : ['No FAA Class B/C/D polygons intersected the route centerline.'] };
};

export default function MissionPlanner({ missionData, onBack, onProceed }) {
  const mapElement = useRef(null);
  const mapRef = useRef(null);
  const vectorSourceRef = useRef(new VectorSource());

  // Layer references for dynamic layer toggling
  const osmLayerRef = useRef(null);
  const satelliteLayerRef = useRef(null);
  const aeronauticalLayerRef = useRef(null);

  const [activeBaseLayer, setActiveBaseLayer] = useState('osm');

  // Loaded navigation fixes dataset
  const [navFixes, setNavFixes] = useState([]);

  // Waypoints sequence
  const [waypoints, setWaypoints] = useState(() => createInitialWaypoints(missionData));
  const [selectedAltitudes, setSelectedAltitudes] = useState({});
  const [routeAnalysis, setRouteAnalysis] = useState({});
  const [analysisStatus, setAnalysisStatus] = useState('Not analyzed');
  const [analysisError, setAnalysisError] = useState('');

  // UI state for search insertion
  const [activeAddIndex, setActiveAddIndex] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  // Load and parse GPS navigation fixes CSV file
  useEffect(() => {
    let isMounted = true;
    const loadNavFixes = async () => {
      try {
        const response = await fetch(gpsWaypoints);
        if (!response.ok) return;
        const text = await response.text();
        const lines = text.split(/\r?\n/);

        const parsedFixes = [];
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          // Support CSV comma or tab delimited
          const cols = line.includes('\t') ? line.split('\t') : line.split(',');
          if (cols.length >= 3) {
            const identifier = cols[0].trim().replace(/^"|"$/g, '');
            const state = cols[1].trim().replace(/^"|"$/g, '');
            const rawCoords = cols.slice(2).join(' ').trim().replace(/^"|"$/g, '');
            const coords = parseDMSCoords(rawCoords);

            if (coords) {
              parsedFixes.push({
                identifier,
                state,
                lat: coords.lat,
                lon: coords.lon,
                type: 'fix'
              });
            }
          }
        }
        if (isMounted) {
          setNavFixes(parsedFixes);
        }
      } catch (err) {
        console.warn('Could not load waypoints.csv:', err);
      }
    };

    loadNavFixes();
    return () => { isMounted = false; };
  }, []);

  // OpenLayers Map initialization with layer support
  useEffect(() => {
    if (waypoints.length === 0 || !mapElement.current) return;

    vectorSourceRef.current.clear();
    const lineCoords = [];

    // Plot Waypoints
    waypoints.forEach((wp, idx) => {
      const projCoords = fromLonLat([wp.lon, wp.lat]);
      lineCoords.push(projCoords);

      const feature = new Feature({
        geometry: new Point(projCoords),
        waypointId: wp.id,
        waypointIndex: idx,
        type: wp.type,
        name: wp.name
      });

      vectorSourceRef.current.addFeature(feature);
    });

    // Plot Flight Route Line
    const routeFeature = new Feature({
      geometry: new LineString(lineCoords),
      type: 'flight-route'
    });
    vectorSourceRef.current.addFeature(routeFeature);

    // Vector Layer & Styling
    const vectorLayer = new VectorLayer({
      source: vectorSourceRef.current,
      style: (feature) => {
        const type = feature.get('type');
        const name = feature.get('name') || '';

        if (type === 'origin') {
          return new Style({
            image: new Circle({
              radius: 9,
              fill: new Fill({ color: '#f43f5e' }),
              stroke: new Stroke({ color: '#ffffff', width: 3 })
            }),
            text: new Text({
              text: name,
              offsetY: -14,
              font: 'bold 11px sans-serif',
              fill: new Fill({ color: '#881337' }),
              stroke: new Stroke({ color: '#ffffff', width: 3 })
            })
          });
        }

        if (type === 'airport') {
          return new Style({
            image: new Circle({
              radius: 8,
              fill: new Fill({ color: '#3b82f6' }),
              stroke: new Stroke({ color: '#ffffff', width: 2 })
            }),
            text: new Text({
              text: name,
              offsetY: -14,
              font: 'bold 11px sans-serif',
              fill: new Fill({ color: '#1e3a8a' }),
              stroke: new Stroke({ color: '#ffffff', width: 3 })
            })
          });
        }

        if (type === 'fix' || type === 'custom') {
          return new Style({
            image: new Circle({
              radius: 7,
              fill: new Fill({ color: '#8f02c7' }),
              stroke: new Stroke({ color: '#ffffff', width: 2 })
            }),
            text: new Text({
              text: name,
              offsetY: -12,
              font: 'bold 10px sans-serif',
              fill: new Fill({ color: '#4c1d95' }),
              stroke: new Stroke({ color: '#ffffff', width: 3 })
            })
          });
        }

        if (type === 'flight-route') {
          return new Style({
            stroke: new Stroke({
              color: '#8f02c7',
              width: 4,
              lineDash: [6, 4]
            })
          });
        }
      }
    });

    // Base Layers
    const osmLayer = new TileLayer({
      source: new OSM(),
      visible: activeBaseLayer === 'osm'
    });
    osmLayerRef.current = osmLayer;

    const satelliteLayer = new TileLayer({
      source: new XYZ({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maxZoom: 19,
        attributions: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
      }),
      visible: activeBaseLayer === 'satellite'
    });
    satelliteLayerRef.current = satelliteLayer;

    const aeronauticalLayer = new TileLayer({
      source: new XYZ({
        url: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}?cacheKey=80de4464e4be2193',
        maxZoom: 14,
        attributions: 'Federal Aviation Administration, Aeronautical Information Services'
      }),
      visible: activeBaseLayer === 'faa'
    });
    aeronauticalLayerRef.current = aeronauticalLayer;

    const map = new Map({
      target: mapElement.current,
      layers: [osmLayer, satelliteLayer, aeronauticalLayer, vectorLayer],
      view: new View({
        center: lineCoords[0],
        zoom: 9
      })
    });

    const extent = vectorSourceRef.current.getExtent();
    if (extent && !extent.includes(Infinity)) {
      map.getView().fit(extent, { padding: [60, 60, 60, 60], maxZoom: 12 });
    }

    // Drag-to-reroute interactions
    const modify = new Modify({
      source: vectorSourceRef.current,
      filter: (feature) => feature.get('type') === 'flight-route'
    });

    modify.on('modifyend', (evt) => {
      const modifiedFeatures = evt.features.getArray();
      const routeFeat = modifiedFeatures.find((f) => f.get('type') === 'flight-route');

      if (routeFeat) {
        const newCoordinates = routeFeat.getGeometry().getCoordinates();
        const updatedWaypoints = newCoordinates.map((coord, idx) => {
          const [lon, lat] = toLonLat(coord);
          if (idx === 0) return waypoints[0];
          if (idx === newCoordinates.length - 1) return waypoints[waypoints.length - 1];
          if (waypoints[idx] && idx < waypoints.length - 1) {
            return { ...waypoints[idx], lon, lat };
          }
          return {
            id: `custom_wp_${crypto.randomUUID().slice(0, 8)}`,
            name: `User Fix ${idx}`,
            type: 'custom',
            lon,
            lat
          };
        });
        setWaypoints(updatedWaypoints);
      }
    });

    // Fix Issue #1: Translate interaction ONLY permits dragging user-inserted custom drag points.
    // Fixed waypoints (origin, destination airport, typed GPS fixes) are locked.
    const translate = new Translate({
      filter: (feature) => feature.get('type') === 'custom'
    });

    translate.on('translateend', (evt) => {
      const movedFeature = evt.features.getArray()[0];
      if (movedFeature) {
        const wpId = movedFeature.get('waypointId');
        const [lon, lat] = toLonLat(movedFeature.getGeometry().getCoordinates());

        setWaypoints((prev) =>
          prev.map((wp) => (wp.id === wpId ? { ...wp, lon, lat } : wp))
        );
      }
    });

    map.addInteraction(modify);
    map.addInteraction(translate);

    mapRef.current = map;

    return () => map.setTarget(null);
  }, [activeBaseLayer, waypoints]);

  // Handle layer switching
  const handleBaseLayerChange = (layerType) => {
    setActiveBaseLayer(layerType);
  };

  const handleRemoveWaypoint = (idToRemove) => {
    setWaypoints((prev) => prev.filter((wp) => wp.id !== idToRemove));
  };

  // Search query across both FAA Airports and GPS Fixes
  const handleSearchWaypoints = (query) => {
    setSearchQuery(query);
    if (!query || query.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    const q = query.toLowerCase().trim();
    
    const matchedAirports = faaAirports
      .filter((apt) => {
        const nameMatch = apt.name && apt.name.toLowerCase().includes(q);
        const icaoMatch = apt.icao && apt.icao.toLowerCase().includes(q);
        const idMatch = apt.id && apt.id.toLowerCase().includes(q);
        return nameMatch || icaoMatch || idMatch;
      })
      .slice(0, 4)
      .map((apt) => ({
        id: `apt_${apt.icao || apt.id}_${crypto.randomUUID().slice(0, 4)}`,
        name: apt.name,
        type: 'airport',
        icao: apt.icao || apt.id || 'N/A',
        surface: apt.surface || 'Unknown',
        lengthFeet: apt.lengthFeet || null,
        lon: apt.lon,
        lat: apt.lat
      }));

    const matchedFixes = navFixes
      .filter((fix) => fix.identifier.toLowerCase().startsWith(q))
      .slice(0, 4)
      .map((fix) => ({
        id: `fix_${fix.identifier}_${crypto.randomUUID().slice(0, 4)}`,
        name: `Fix: ${fix.identifier}`,
        type: 'fix',
        lon: fix.lon,
        lat: fix.lat
      }));

    setSearchResults([...matchedAirports, ...matchedFixes]);
  };

  const handleAddWaypoint = (wpItem, insertIndex) => {
    const updated = [...waypoints];
    updated.splice(insertIndex + 1, 0, wpItem);
    setWaypoints(updated);

    setActiveAddIndex(null);
    setSearchQuery('');
    setSearchResults([]);
  };

  const analyzeRouteSafety = async () => {
    const legsToAnalyze = waypoints.slice(0, -1).map((start, index) => ({
      id: `${start.id}-${waypoints[index + 1].id}`,
      start,
      end: waypoints[index + 1],
      distanceNm: calculateNM(start, waypoints[index + 1])
    }));
    if (legsToAnalyze.length === 0) return;

    setAnalysisStatus('Analyzing terrain and FAA airspace…');
    setAnalysisError('');
    try {
      const analyses = await Promise.all(legsToAnalyze.map(async (leg) => {
        const elevations = await Promise.all(getCorridorSamples(leg.start, leg.end, leg.distanceNm).map(getElevation));
        const highestTerrainFeet = Math.ceil(Math.max(...elevations));
        const terrainMslFeet = highestTerrainFeet + 500;
        const airspaces = await getIntersectingAirspace(leg.start, leg.end);
        const vfrAltitude = calculateCourse(leg.start, leg.end) < 180 ? 4500 : 5500;
        return [leg.id, {
          highestTerrainFeet,
          terrainMslFeet,
          ...describeAirspace(airspaces, terrainMslFeet, vfrAltitude),
          airspaceCount: airspaces.length
        }];
      }));
      setRouteAnalysis(Object.fromEntries(analyses));
      setAnalysisStatus('Route safety analysis complete');
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : 'Route safety analysis could not be completed.');
      setAnalysisStatus('Analysis unavailable');
    }
  };

  const plannerError = getMissionError(missionData);
  const legs = waypoints.slice(0, -1).map((start, index) => {
    const end = waypoints[index + 1];
    const id = `${start.id}-${end.id}`;
    const suggestion = getAltitudeSuggestion(start, end, routeAnalysis[id]);
    return {
      id,
      start,
      end,
      distNM: calculateNM(start, end),
      ...suggestion,
      selectedMslFeet: selectedAltitudes[`${start.id}-${end.id}`] ?? ''
    };
  });
  const totalNM = legs.reduce((total, leg) => total + leg.distNM, 0);
  const allLegsHaveAltitude = legs.length > 0 && legs.every((leg) => Number(leg.selectedMslFeet) > 0);

  if (plannerError) {
    return (
      <div className="app-container">
        <div className="sidebar" style={{ padding: '20px' }}>
          <button onClick={onBack} className="btn-clear" style={{ marginBottom: '16px' }}>
            ← Back to Map
          </button>
          <div className="status-card" style={{ color: '#ef4444' }}>
            {plannerError}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container mission-planner">
      {/* Sidebar - Matching MapApp header and structure */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>RampCamp</h2>
          <p>For General Aviation and Camping enthusiasts.</p>
        </div>

        <button onClick={onBack} className="btn-back" style={{ width: '100%', marginBottom: '12px' }}>
          ← Back to Map Search
        </button>

        <div className="origin-card">
          <span className="label">Total Flight Distance:</span> {totalNM.toFixed(1)} NM
        </div>

        <div className="route-analysis-card">
          <div>
            <strong>Route Safety Analysis</strong>
            <span>{analysisStatus}</span>
          </div>
          <button type="button" className="btn-search" onClick={analyzeRouteSafety} disabled={analysisStatus.includes('Analyzing')}>
            {analysisStatus.includes('Analyzing') ? 'Analyzing…' : 'Analyze terrain & airspace'}
          </button>
          {analysisError && <small className="analysis-error">{analysisError}</small>}
        </div>

        <div className="sidebar-section matches-section">
          <div className="section-title">Air Waypoints & Route ({waypoints.length})</div>
          
          <div className="interactive-list">
            {waypoints.map((wp, idx) => {
              const isEndpoint = idx === 0 || idx === waypoints.length - 1;
              const legToNext = legs[idx];

              return (
                <React.Fragment key={wp.id}>
                  {/* Waypoint Card */}
                  <div className="list-item-airport" style={{ position: 'relative' }}>
                    <div className="item-header">
                      <strong>
                        {wp.type === 'origin' && '📍 '}
                        {wp.type === 'airport' && '✈ '}
                        {wp.type === 'fix' && '🛈 '}
                        {wp.type === 'custom' && '📌 '}
                        {wp.name} {wp.icao ? `(${wp.icao})` : ''}
                      </strong>

                      {/* Remove button (Disabled for Origin & Final Destination) */}
                      {!isEndpoint && (
                        <button
                          onClick={() => handleRemoveWaypoint(wp.id)}
                          className="btn-remove"
                          title="Remove Waypoint"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
                      {wp.lat.toFixed(4)}°, {wp.lon.toFixed(4)}°
                      {wp.lengthFeet && ` | ${wp.lengthFeet}ft ${wp.surface}`}
                    </div>
                  </div>

                  {/* Leg distance info & Waypoint insertion tool */}
                  {idx < waypoints.length - 1 && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        margin: '6px 0',
                        gap: '4px'
                      }}
                    >
                      <div
                        style={{
                          fontSize: '11px',
                          fontWeight: 'bold',
                          color: '#8f02c7',
                          background: '#f3e8ff',
                          padding: '2px 8px',
                          borderRadius: '10px'
                        }}
                      >
                        ↓ Leg {idx + 1}: {legToNext ? legToNext.distNM.toFixed(1) : 0} NM
                      </div>

                      {legToNext && (
                        <div className="altitude-card">
                          <strong>Suggested minimum cruise: {legToNext.suggestedMslFeet.toLocaleString()} MSL</strong>
                          <ul>
                            {legToNext.rationale.map((reason) => <li key={reason}>{reason}</li>)}
                          </ul>
                          <label className="altitude-label">
                            Selected cruise MSL altitude
                          </label>
                          <div className="altitude-input-row">
                            <input
                              type="number"
                              min="500"
                              step="500"
                              inputMode="numeric"
                              aria-label={`Selected MSL altitude for leg ${idx + 1}`}
                              placeholder={`${legToNext.suggestedMslFeet}`}
                              value={legToNext.selectedMslFeet}
                              onChange={(event) => setSelectedAltitudes((previous) => ({
                                ...previous,
                                [legToNext.id]: event.target.value
                              }))}
                              className="altitude-input"
                            />
                            <button
                              type="button"
                              className="btn-plan-sm"
                              onClick={() => setSelectedAltitudes((previous) => ({
                                ...previous,
                                [legToNext.id]: String(legToNext.suggestedMslFeet)
                              }))}
                              style={{ padding: '4px 7px', fontSize: '10px' }}
                            >
                              Use suggestion
                            </button>
                          </div>
                        </div>
                      )}

                      {activeAddIndex === idx ? (
                        <div
                          style={{
                            width: '100%',
                            background: '#ffffff',
                            border: '1px solid #cbd5e1',
                            borderRadius: '6px',
                            padding: '8px',
                            marginTop: '4px'
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                            <strong style={{ fontSize: '11px' }}>Add Airport / GPS Fix</strong>
                            <button
                              onClick={() => setActiveAddIndex(null)}
                              className="btn-remove-sm"
                              style={{ border: 'none', background: 'none' }}
                            >
                              ✕
                            </button>
                          </div>

                          <input
                            type="text"
                            placeholder="Search Airport ID or GPS Fix (e.g. AAALL)..."
                            value={searchQuery}
                            onChange={(e) => handleSearchWaypoints(e.target.value)}
                            style={{
                              width: '100%',
                              padding: '6px',
                              fontSize: '12px',
                              borderRadius: '4px',
                              border: '1px solid #cbd5e1',
                              boxSizing: 'border-box'
                            }}
                          />

                          {searchResults.length > 0 && (
                            <div
                              style={{
                                maxHeight: '130px',
                                overflowY: 'auto',
                                marginTop: '6px',
                                border: '1px solid #e2e8f0',
                                borderRadius: '4px'
                              }}
                            >
                              {searchResults.map((res) => (
                                <div
                                  key={res.id}
                                  onClick={() => handleAddWaypoint(res, idx)}
                                  style={{
                                    padding: '6px',
                                    fontSize: '11px',
                                    cursor: 'pointer',
                                    borderBottom: '1px solid #f1f5f9'
                                  }}
                                  className="search-result-row"
                                >
                                  <strong>{res.type === 'fix' ? `${res.name}` : `${res.icao} - ${res.name}`}</strong>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setActiveAddIndex(idx);
                            setSearchQuery('');
                            setSearchResults([]);
                          }}
                          className="btn-plan-sm"
                          style={{
                            fontSize: '10px',
                            padding: '2px 10px',
                            backgroundColor: '#0284c7'
                          }}
                        >
                          + Insert Waypoint
                        </button>
                      )}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        <div className="status-card" style={{ marginTop: 'auto' }}>
          Tip: Drag flight route lines or waypoints on the map to modify legs. Altitude suggestions are planning aids, not a substitute for a current FAA briefing.
        </div>

        <button
          type="button"
          className="btn-plan"
          disabled={!allLegsHaveAltitude}
          onClick={() => onProceed?.({ missionData, waypoints, legs })}
          style={{ width: '100%', marginTop: '12px', opacity: allLegsHaveAltitude ? 1 : 0.55 }}
          title={allLegsHaveAltitude ? 'Continue to the NWKRAFT mission briefing' : 'Select an MSL altitude for every leg first'}
        >
          Continue to NWKRAFT Mission Briefing
        </button>
      </div>

      {/* Map Container */}
      <div className="map-container" ref={mapElement}>
        <div className="map-overlay-controls">
          {/* Layer Selector */}
          <div className="map-layer-selector">
            <div className="layer-selector-title">Map View</div>
            <select
              value={activeBaseLayer}
              onChange={(e) => handleBaseLayerChange(e.target.value)}
              className="select-layer"
            >
              <option value="osm">Standard (OSM)</option>
              <option value="satellite">Satellite (Esri)</option>
              <option value="faa">Aeronautical (FAA)</option>
            </select>
          </div>

          <div className="map-legend">
            <div className="legend-title">Flight Plan Legend</div>
            <div className="legend-list">
              <div><span className="dot-origin">●</span> Origin</div>
              <div><span className="dot-airport">●</span> Destination</div>
              <div><span style={{ color: '#8f02c7' }}>●</span> Enroute Waypoint</div>
              <div><span className="line-flight">--</span> Flight Leg Path</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
