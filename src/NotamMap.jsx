import { useEffect, useRef } from 'react';
import 'ol/ol.css';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import OSM from 'ol/source/OSM';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { circular as circularPolygon } from 'ol/geom/Polygon';
import Overlay from 'ol/Overlay';
import { fromLonLat } from 'ol/proj';
import { Style, Circle as CircleStyle, Fill, Stroke } from 'ol/style';

function parseIcaoCoordinates(coordStr) {
  if (typeof coordStr !== 'string') return null;
  const match = coordStr.match(/^(\d{2,6})([NS])(\d{3,7})([EW])$/i);
  if (!match) return null;

  const [, latStr, latDir, lonStr, lonDir] = match;

  const parseDMS = (str) => {
    if (str.length === 2 || str.length === 3) return parseFloat(str);
    if (str.length === 4 || str.length === 5) {
      return parseFloat(str.slice(0, -2)) + parseFloat(str.slice(-2)) / 60;
    }
    return parseFloat(str.slice(0, -4)) + parseFloat(str.slice(-4, -2)) / 60 + parseFloat(str.slice(-2)) / 3600;
  };

  let lat = parseDMS(latStr);
  let lon = parseDMS(lonStr);

  if (latDir.toUpperCase() === 'S') lat = -lat;
  if (lonDir.toUpperCase() === 'W') lon = -lon;

  return { lat, lon };
}

export default function NotamMap({ notams = [], hoveredNotamId, onHoverNotam }) {
  const mapElement = useRef(null);
  const tooltipElement = useRef(null);
  const mapRef = useRef(null);
  const vectorSourceRef = useRef(new VectorSource());
  const overlayRef = useRef(null);
  
  // Refs to avoid map re-creation when callbacks or hover props change
  const hoveredNotamIdRef = useRef(hoveredNotamId);
  const onHoverNotamRef = useRef(onHoverNotam);
  const lastPlottedKeyRef = useRef('');

  useEffect(() => {
    hoveredNotamIdRef.current = hoveredNotamId;
  }, [hoveredNotamId]);

  useEffect(() => {
    onHoverNotamRef.current = onHoverNotam;
  }, [onHoverNotam]);

  // Map Setup Effect - Runs ONLY ONCE on mount
  useEffect(() => {
    const vectorLayer = new VectorLayer({
      source: vectorSourceRef.current,
      style: (feature) => {
        const isHovered = feature.get('id') === hoveredNotamIdRef.current;
        const level = feature.get('level') || 'low';

        let color = '#475569';
        if (level === 'critical') color = '#ef4444';
        else if (level === 'warning') color = '#f97316';
        else if (level === 'caution') color = '#eab308';
        else if (level === 'info') color = '#0284c7';

        const strokeWidth = isHovered ? 4 : 2;
        const radius = isHovered ? 10 : 7;

        if (feature.getGeometry().getType() === 'Point') {
          return new Style({
            image: new CircleStyle({
              radius,
              fill: new Fill({ color }),
              stroke: new Stroke({ color: '#ffffff', width: strokeWidth })
            })
          });
        }

        return new Style({
          stroke: new Stroke({ color, width: strokeWidth }),
          fill: new Fill({ color: color + '33' })
        });
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
      layers: [
        new TileLayer({ source: new OSM() }),
        vectorLayer
      ],
      overlays: [overlay],
      view: new View({
        center: fromLonLat([-98.5795, 39.8283]),
        zoom: 4
      })
    });

    initialMap.on('pointermove', (evt) => {
      if (evt.dragging) {
        overlay.setPosition(undefined);
        return;
      }

      const feature = initialMap.forEachFeatureAtPixel(evt.pixel, (f) => f);
      if (feature) {
        const coordinates = evt.coordinate;
        if (onHoverNotamRef.current) {
          onHoverNotamRef.current(feature.get('id'));
        }
        overlay.setPosition(coordinates);
        if (mapElement.current) mapElement.current.style.cursor = 'pointer';
      } else {
        if (onHoverNotamRef.current) {
          onHoverNotamRef.current(null);
        }
        overlay.setPosition(undefined);
        if (mapElement.current) mapElement.current.style.cursor = '';
      }
    });

    mapRef.current = initialMap;

    return () => {
      initialMap.setTarget(null);
    };
  }, []); // Run ONCE on mount

  // Vector Feature Data Update Effect
  useEffect(() => {
    if (!mapRef.current) return;

    // Guard against re-fitting if NOTAM set hasn't changed
    const currentKey = notams.map((n) => n.id || n.text).join('|');
    if (currentKey === lastPlottedKeyRef.current) return;
    lastPlottedKeyRef.current = currentKey;

    vectorSourceRef.current.clear();
    const validCoords = [];

    notams.forEach((notam) => {
      let lat = null;
      let lon = null;

      if (typeof notam.coordinates === 'string') {
        const parsed = parseIcaoCoordinates(notam.coordinates);
        if (parsed) {
          lat = parsed.lat;
          lon = parsed.lon;
        }
      } else if (Array.isArray(notam.coordinates) && notam.coordinates.length >= 2) {
        lat = Number(notam.coordinates[1]);
        lon = Number(notam.coordinates[0]);
      } else if (notam.lat && notam.lng) {
        lat = Number(notam.lat);
        lon = Number(notam.lng);
      }

      if (lat !== null && lon !== null && !isNaN(lat) && !isNaN(lon)) {
        const finalLat = Math.abs(lat) > 90 ? lon : lat;
        const finalLon = Math.abs(lat) > 90 ? lat : lon;

        const centerCoords = fromLonLat([finalLon, finalLat]);
        validCoords.push(centerCoords);

        const radiusMiles = notam.radiusNM || notam.radiusMiles || 0;

        if (radiusMiles > 0) {
          const radiusMeters = radiusMiles * 1852;
          const circleGeom = circularPolygon([finalLon, finalLat], radiusMeters, 64)
            .transform('EPSG:4326', mapRef.current.getView().getProjection());

          const circleFeature = new Feature({
            geometry: circleGeom,
            id: notam.id,
            text: notam.text,
            level: notam.classification || notam.level
          });
          vectorSourceRef.current.addFeature(circleFeature);
        } else {
          const pointFeature = new Feature({
            geometry: new Point(centerCoords),
            id: notam.id,
            text: notam.text,
            level: notam.classification || notam.level
          });
          vectorSourceRef.current.addFeature(pointFeature);
        }
      }
    });

    if (validCoords.length > 0) {
      const extent = vectorSourceRef.current.getExtent();
      mapRef.current.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 10 });
    }
  }, [notams]);

  // Re-render layer style smoothly on hover state changes
  useEffect(() => {
    if (vectorSourceRef.current) {
      vectorSourceRef.current.changed();
    }
  }, [hoveredNotamId]);

  const activeNotam = notams.find((n) => n.id === hoveredNotamId);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: '6px', overflow: 'hidden' }}>
      <div ref={mapElement} style={{ width: '100%', height: '100%' }} />
      <div ref={tooltipElement} className="ol-tooltip">
        {activeNotam && (
          <div style={{ maxWidth: '250px', fontSize: '11px', color: '#f8fafc' }}>
            <strong>{activeNotam.id} [{activeNotam.facility}]</strong>
            <p style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap' }}>{activeNotam.text}</p>
          </div>
        )}
      </div>
    </div>
  );
}