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

export default function MissionPlanner({ missionData, onBack }) {
  const mapElement = useRef(null);
  const mapRef = useRef(null);
  const vectorSourceRef = useRef(new VectorSource());

  // Layer references for dynamic layer toggling
  const osmLayerRef = useRef(null);
  const satelliteLayerRef = useRef(null);
  const aeronauticalLayerRef = useRef(null);

  const [plannerError, setPlannerError] = useState(null);
  const [activeBaseLayer, setActiveBaseLayer] = useState('osm');

  // Loaded navigation fixes dataset
  const [navFixes, setNavFixes] = useState([]);

  // Waypoints sequence
  const [waypoints, setWaypoints] = useState([]);

  // UI state for search insertion
  const [activeAddIndex, setActiveAddIndex] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  // Helper to parse DMS strings like "42-07-12.6800N 071-08-30.3400W" into { lat, lon }
  const parseDMSCoords = (dmsStr) => {
    if (!dmsStr) return null;
    const parts = dmsStr.trim().split(/\s+/);
    if (parts.length < 2) return null;

    const parsePart = (str) => {
      const match = str.match(/^(\d+)-(\d+)-([\d.]+)([NSEW])$/);
      if (!match) return null;
      const deg = parseFloat(match[1]);
      const min = parseFloat(match[2]);
      const sec = parseFloat(match[3]);
      const dir = match[4];
      let val = deg + min / 60 + sec / 3600;
      if (dir === 'S' || dir === 'W') val = -val;
      return val;
    };

    const lat = parsePart(parts[0]);
    const lon = parsePart(parts[1]);

    return (lat !== null && lon !== null) ? { lat, lon } : null;
  };

  // Safely extract coordinates from varying object structures
  const extractCoords = (obj) => {
    if (!obj) return null;
    if (Array.isArray(obj) && obj.length >= 2) {
      const lon = parseFloat(obj[0]);
      const lat = parseFloat(obj[1]);
      return (!isNaN(lon) && !isNaN(lat)) ? { lon, lat } : null;
    }
    const lon = parseFloat(obj.lon ?? obj.longitude ?? obj.lng);
    const lat = parseFloat(obj.lat ?? obj.latitude);
    return (!isNaN(lon) && !isNaN(lat)) ? { lon, lat } : null;
  };

  // Great Circle distance calculation in NM
  const calculateNM = (p1, p2) => {
    const rad = Math.PI / 180;
    const dLat = (p2.lat - p1.lat) * rad;
    const dLon = (p2.lon - p1.lon) * rad;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(p1.lat * rad) * Math.cos(p2.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return (6371000 * c) / 1852;
  };

  const calculateLegs = () => {
    const legs = [];
    let totalNM = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const start = waypoints[i];
      const end = waypoints[i + 1];
      const dist = calculateNM(start, end);
      totalNM += dist;
      legs.push({ start, end, distNM: dist });
    }
    return { legs, totalNM };
  };

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

  // Initialize payload waypoints
  useEffect(() => {
    if (!missionData) {
      setPlannerError('No mission data provided.');
      return;
    }

    const origin = extractCoords(missionData.origin || missionData.originCoords);
    const airport = extractCoords(missionData.airport);

    if (!origin) {
      setPlannerError('Missing or invalid Origin coordinates.');
      return;
    }
    if (!airport) {
      setPlannerError('Missing or invalid Destination Airport coordinates.');
      return;
    }

    const initialList = [
      {
        id: 'origin_wp',
        name: 'Origin Marker',
        type: 'origin',
        lon: origin.lon,
        lat: origin.lat
      },
      {
        id: `apt_${missionData.airport.icao || missionData.airport.id || 'dest'}`,
        name: missionData.airport.name || 'Destination Airport',
        type: 'airport',
        icao: missionData.airport.icao || 'N/A',
        surface: missionData.airport.surface || 'Unknown',
        lengthFeet: missionData.airport.lengthFeet || null,
        lon: airport.lon,
        lat: airport.lat
      }
    ];

    setWaypoints(initialList);
  }, [missionData]);

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
  }, [waypoints.length]);

  // Handle layer switching
  const handleBaseLayerChange = (layerType) => {
    setActiveBaseLayer(layerType);
    if (!osmLayerRef.current || !satelliteLayerRef.current || !aeronauticalLayerRef.current) return;

    if (layerType === 'osm') {
      osmLayerRef.current.setVisible(true);
      satelliteLayerRef.current.setVisible(false);
      aeronauticalLayerRef.current.setVisible(false);
    } else if (layerType === 'satellite') {
      osmLayerRef.current.setVisible(false);
      satelliteLayerRef.current.setVisible(true);
      aeronauticalLayerRef.current.setVisible(false);
    } else if (layerType === 'faa') {
      osmLayerRef.current.setVisible(true);
      satelliteLayerRef.current.setVisible(false);
      aeronauticalLayerRef.current.setVisible(true);
    }
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

  const { legs, totalNM } = calculateLegs();

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
    <div className="app-container">
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
          Tip: Drag flight route lines or waypoints on the map to modify legs.
        </div>
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
              <div><span className="dot-origin">●</span> Origin / Endpoints</div>
              <div><span className="dot-airport">●</span> Destination / Airfield</div>
              <div><span style={{ color: '#8f02c7' }}>●</span> Waypoint / GPS Fix</div>
              <div><span className="line-flight">--</span> Flight Leg Path</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}