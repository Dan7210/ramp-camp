import { useEffect, useRef, useState } from 'react';
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
import Overlay from 'ol/Overlay';
import { fromLonLat, toLonLat } from 'ol/proj';
import { Style, Circle, Fill, Stroke, Text } from 'ol/style';

import MissionPlanner from './MissionPlanner';
import faaAirports from './airports.json';
import './MapApp.css';

const KPDK_COORDS = [-84.3020, 33.8756];
const MULTI_STORAGE_KEY = 'rampcamp_saved_queries';

export default function MapApp() {
  const mapElement = useRef(null);
  const tooltipElement = useRef(null);
  const mapRef = useRef(null);
  const overlayRef = useRef(null);
  const vectorSourceRef = useRef(new VectorSource());
  const abortControllerRef = useRef(null);

  // Layer references for dynamic layer toggling
  const osmLayerRef = useRef(null);
  const satelliteLayerRef = useRef(null);
  const aeronauticalLayerRef = useRef(null);

  // Navigation / View State
  const [currentView, setCurrentView] = useState('map'); // 'map' | 'planner'
  const [selectedMission, setSelectedMission] = useState(null);

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

  // Map Layer Selection state
  const [activeBaseLayer, setActiveBaseLayer] = useState('osm');

  // Lazy initialize state from localStorage
  const [savedStates, setSavedStates] = useState(() => {
    try {
      const saved = localStorage.getItem(MULTI_STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [selectedSaveKey, setSelectedSaveKey] = useState('');

  // ---------------------------------------------------------------------------
  // HELPER & RENDER FUNCTIONS (Declared before useEffect to avoid TDZ errors)
  // ---------------------------------------------------------------------------

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

      const surfaceLower = apt.surface ? apt.surface.toLowerCase() : '';
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

  const findNearestAirport = (coords) => {
    const [lon, lat] = coords;
    let closestApt = null;
    let minDistanceNM = Infinity;

    faaAirports.forEach((apt) => {
      const distMeters = getDistanceInMeters(lon, lat, apt.lon, apt.lat);
      const distNM = distMeters / 1852;
      if (distNM < minDistanceNM) {
        minDistanceNM = distNM;
        closestApt = apt;
      }
    });

    return closestApt;
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

  // ---------------------------------------------------------------------------
  // MAP EFFECT
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (currentView !== 'map') return;

    const osmLayer = new TileLayer({
      source: new OSM(),
      visible: true
    });
    osmLayerRef.current = osmLayer;

    const satelliteLayer = new TileLayer({
      source: new XYZ({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maxZoom: 19,
        attributions: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
      }),
      visible: false
    });
    satelliteLayerRef.current = satelliteLayer;

    const aeronauticalLayer = new TileLayer({
      source: new XYZ({
        url: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}?cacheKey=80de4464e4be2193',
        maxZoom: 14,
        attributions: 'Federal Aviation Administration, Aeronautical Information Services'
      }),
      visible: false
    });
    aeronauticalLayerRef.current = aeronauticalLayer;

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
            stroke: new Stroke({ color: '#8f02c7', width: 4, lineDash: [6, 4] }),
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
      layers: [osmLayer, satelliteLayer, aeronauticalLayer, vectorLayer],
      overlays: [overlay],
      view: new View({
        center: fromLonLat(centerCoords),
        zoom: 9
      })
    });

    updateOriginMarker(centerCoords);

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
        if (mapElement.current) mapElement.current.style.cursor = '';
      }
    });

    mapRef.current = initialMap;

    if (cachedData) {
      renderFilteredResults(cachedData, airportRadiusMiles, campRadiusMiles, surfaceFilter, accessFilter, minRunwayLength);
    }

    return () => initialMap.setTarget(null);
  }, [currentView]);

  // ---------------------------------------------------------------------------
  // HANDLERS
  // ---------------------------------------------------------------------------

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

    const matchingAirports = faaAirports.filter((apt) => {
      const distMeters = getDistanceInMeters(lon, lat, apt.lon, apt.lat);
      const distNM = distMeters / 1852;
      if (distNM > airportRadiusMiles) return false;

      if (accessFilter === 'public' && !apt.isPublic) return false;
      if (accessFilter === 'private' && apt.isPublic) return false;

      const surfaceLower = apt.surface ? apt.surface.toLowerCase() : '';
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

    const evaluatedAirports = [];

    for (const apt of matchingAirports) {
      if (controller.signal.aborted) return;

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

  const handleSaveState = () => {
    const uniqueId = `query_${crypto.randomUUID()}`;
    const nearestApt = findNearestAirport(centerCoords);
    const aptIdentifier = nearestApt 
      ? `${nearestApt.icao || nearestApt.id || 'N/A'}`
      : `${centerCoords[1].toFixed(3)}, ${centerCoords[0].toFixed(3)}`;
    
    const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const displayLabel = `Near ${aptIdentifier} - ${timeString}`;
    
    const stateToSave = {
      id: uniqueId,
      label: displayLabel,
      centerCoords,
      airportRadiusMiles,
      campRadiusMiles,
      maxQueriedAirportRadius,
      maxQueriedCampRadius,
      surfaceFilter,
      accessFilter,
      minRunwayLength,
      cachedData,
      isLocked
    };

    const updatedMap = { ...savedStates, [uniqueId]: stateToSave };
    setSavedStates(updatedMap);
    setSelectedSaveKey(uniqueId);
    localStorage.setItem(MULTI_STORAGE_KEY, JSON.stringify(updatedMap));
    setStatusLog(`Saved query: ${displayLabel}`);
  };

  const handleLoadState = () => {
    if (!selectedSaveKey || !savedStates[selectedSaveKey]) return;
    const parsed = savedStates[selectedSaveKey];

    setCenterCoords(parsed.centerCoords);
    setAirportRadiusMiles(parsed.airportRadiusMiles);
    setCampRadiusMiles(parsed.campRadiusMiles);
    setMaxQueriedAirportRadius(parsed.maxQueriedAirportRadius);
    setMaxQueriedCampRadius(parsed.maxQueriedCampRadius);
    setSurfaceFilter(parsed.surfaceFilter);
    setAccessFilter(parsed.accessFilter);
    setMinRunwayLength(parsed.minRunwayLength);
    setCachedData(parsed.cachedData);
    setIsLocked(parsed.isLocked);

    if (mapRef.current && parsed.centerCoords) {
      mapRef.current.getView().setCenter(fromLonLat(parsed.centerCoords));
    }

    if (parsed.cachedData) {
      renderFilteredResults(
        parsed.cachedData,
        parsed.airportRadiusMiles,
        parsed.campRadiusMiles,
        parsed.surfaceFilter,
        parsed.accessFilter,
        parsed.minRunwayLength
      );
    } else {
      updateOriginMarker(parsed.centerCoords);
    }

    setStatusLog(`Loaded saved query: ${parsed.label}`);
  };

  const handleRemoveAirport = (icaoOrId) => {
    if (!cachedData) return;
    const updatedAirports = cachedData.airports.filter(
      (apt) => (apt.icao || apt.id || apt.name) !== icaoOrId
    );

    const updatedData = { ...cachedData, airports: updatedAirports };
    setCachedData(updatedData);
    renderFilteredResults(updatedData, airportRadiusMiles, campRadiusMiles, surfaceFilter, accessFilter, minRunwayLength);
  };

  const handleRemoveCampsite = (campId) => {
    if (!cachedData) return;
    const updatedAirports = cachedData.airports.map((apt) => ({
      ...apt,
      connections: apt.connections.filter(({ camp }) => camp.id !== campId)
    })).filter((apt) => apt.connections.length > 0);

    const updatedData = { ...cachedData, airports: updatedAirports };
    setCachedData(updatedData);
    renderFilteredResults(updatedData, airportRadiusMiles, campRadiusMiles, surfaceFilter, accessFilter, minRunwayLength);
  };

  const handleExportResults = () => {
    if (results.airports.length === 0) return;

    let textOutput = `========================================\n`;
    textOutput += `RAMPCAMP TRIP PLANNING REPORT\n`;
    textOutput += `Origin: ${centerCoords[1].toFixed(4)}, ${centerCoords[0].toFixed(4)}\n`;
    textOutput += `Flight Radius: ${airportRadiusMiles} NM | Road Radius: ${campRadiusMiles} Mi\n`;
    textOutput += `========================================\n\n`;

    results.airports.forEach((apt, idx) => {
      textOutput += `${idx + 1}. AIRPORT: ${apt.name} (${apt.icao || 'N/A'})\n`;
      textOutput += `   Distance from Origin: ${apt.distFromCenterNM.toFixed(1)} NM\n`;
      textOutput += `   Surface: ${apt.surface} | Runway: ${apt.lengthFeet || 'N/A'} ft\n`;
      textOutput += `   Access: ${apt.isPublic ? 'Public' : 'Private'}\n`;
      textOutput += `   Nearby Campsites:\n`;

      const validConns = apt.connections.filter(
        ({ route }) => parseFloat(route.distanceMiles) <= campRadiusMiles
      );

      validConns.forEach(({ camp, route }) => {
        textOutput += `     - ${camp.name}\n`;
        textOutput += `       Road Distance: ${route.distanceMiles} miles\n`;
        textOutput += `       Fee: ${camp.fee} | Capacity: ${camp.capacity}\n`;
        textOutput += `       Coordinates: ${camp.lat}, ${camp.lon}\n`;
      });
      textOutput += `----------------------------------------\n`;
    });

    const blob = new Blob([textOutput], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `rampcamp_itinerary_${Date.now()}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Fixed payload format to provide both array & object formats for origin coordinates
  const handleSelectMission = (airport, camp, route) => {
    // Standardize airport coordinates
    const normalizedAirport = {
      ...airport,
      lon: airport.lon ?? airport.longitude ?? airport.lng,
      lat: airport.lat ?? airport.latitude
    };

    // Standardize campsite coordinates
    const normalizedCamp = {
      ...camp,
      lon: camp.lon ?? camp.longitude ?? camp.lng,
      lat: camp.lat ?? camp.latitude
    };

    setSelectedMission({
      origin: {
        lon: centerCoords[0],
        lat: centerCoords[1]
      },
      originCoords: centerCoords,
      airport: normalizedAirport,
      campsite: normalizedCamp,
      route
    });
    
    setCurrentView('planner');
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

  const savedKeysList = Object.keys(savedStates);

  // Render Mission Planner view if triggered
  if (currentView === 'planner' && selectedMission) {
    return (
      <MissionPlanner 
        missionData={selectedMission} 
        onBack={() => setCurrentView('map')} 
      />
    );
  }

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

        <div className="save-load-group">
          <button onClick={handleSaveState} disabled={loading || !cachedData} className="btn-save">
            Save Current Query
          </button>
          
          <div className="load-select-wrapper">
            <select 
              value={selectedSaveKey} 
              onChange={(e) => setSelectedSaveKey(e.target.value)}
              className="select-saved"
              disabled={savedKeysList.length === 0 || loading}
            >
              <option value="">Select Saved Query...</option>
              {savedKeysList.map((key) => (
                <option key={key} value={key}>
                  {savedStates[key].label}
                </option>
              ))}
            </select>
            <button 
              onClick={handleLoadState} 
              disabled={!selectedSaveKey || loading} 
              className="btn-load"
            >
              Load
            </button>
          </div>
        </div>

        <div className="action-buttons">
          <button onClick={handleExportResults} disabled={results.airports.length === 0} className="btn-export">
            Export Remaining Itinerary (.txt)
          </button>
        </div>

        <div className="status-card">{statusLog}</div>

        <div className="sidebar-section matches-section">
          <div className="section-title">Matches ({results.airports.length} Airports, {results.campsites.length} Campsites)</div>
          <div className="interactive-list">
            {results.airports.map((apt) => {
              const aptId = apt.icao || apt.id || apt.name;
              return (
                <div key={aptId} className="list-item-airport">
                  <div className="item-header">
                    <strong>✈ {apt.name} ({apt.icao || 'N/A'})</strong>
                    <button onClick={() => handleRemoveAirport(aptId)} className="btn-remove" title="Remove Airport">✕</button>
                  </div>
                  <div className="campsite-sublist">
                    {apt.connections
                      .filter(({ route }) => parseFloat(route.distanceMiles) <= campRadiusMiles)
                      .map(({ camp, route }) => (
                        <div key={camp.id} className="list-item-campsite">
                          <span 
                            style={{ cursor: 'pointer', flex: 1 }}
                            onClick={() => handleSelectMission(apt, camp, route)}
                            title="Click to plan mission"
                          >
                            ⛺ {camp.name} ({route.distanceMiles} mi)
                          </span>
                          <button 
                            onClick={() => handleSelectMission(apt, camp, route)}
                            className="btn-plan-sm"
                            title="Plan Mission"
                            style={{ marginRight: '4px' }}
                          >
                            Plan
                          </button>
                          <button onClick={() => handleRemoveCampsite(camp.id)} className="btn-remove-sm" title="Remove Campsite">✕</button>
                        </div>
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="map-container" ref={mapElement}>
        <div className="map-overlay-controls">
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
            <div className="legend-title">Legend</div>
            <div className="legend-list">
              <div><span className="dot-origin">●</span> Origin Location</div>
              <div><span className="dot-airport">●</span> Airport</div>
              <div><span className="dot-campsite">●</span> Campsite</div>
              <div><span className="line-flight">--</span> Flight Leg</div>
              <div><span className="line-road">―</span> Road Leg</div>
            </div>
          </div>
        </div>

        <div ref={tooltipElement} className="ol-tooltip">
          {tooltipData && (
            <div>
              <strong>{tooltipData.name}</strong>
              {tooltipData.type === 'airport' && (
                <div>
                  <small>ICAO: {tooltipData.details.icao || 'N/A'}</small><br />
                  <small>Surface: {tooltipData.details.surface}</small><br />
                  <small>Runway: {tooltipData.details.lengthFeet} ft</small>
                </div>
              )}
              {tooltipData.type === 'campsite' && (
                <div>
                  <small>Fee: {tooltipData.details.fee}</small><br />
                  <small>Capacity: {tooltipData.details.capacity}</small>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}