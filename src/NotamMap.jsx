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
import CircularPolygon from 'ol/geom/Polygon';
import Overlay from 'ol/Overlay';
import { fromLonLat } from 'ol/proj';
import { Style, Circle as CircleStyle, Fill, Stroke } from 'ol/style';

export default function NotamMap({ notams, hoveredNotamId, onHoverNotam }) {
  const mapElement = useRef(null);
  const tooltipElement = useRef(null);
  const mapRef = useRef(null);
  const vectorSourceRef = useRef(new VectorSource());
  const overlayRef = useRef(null);

  useEffect(() => {
    const vectorLayer = new VectorLayer({
      source: vectorSourceRef.current,
      style: (feature) => {
        const isHovered = feature.get('id') === hoveredNotamId;
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
        onHoverNotam(feature.get('id'));
        overlay.setPosition(coordinates);
        if (mapElement.current) mapElement.current.style.cursor = 'pointer';
      } else {
        onHoverNotam(null);
        overlay.setPosition(undefined);
        if (mapElement.current) mapElement.current.style.cursor = '';
      }
    });

    mapRef.current = initialMap;

    return () => initialMap.setTarget(null);
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;

    vectorSourceRef.current.clear();
    const validCoords = [];

    notams.forEach((notam) => {
      let rawLat = notam.lat ?? notam.latitude ?? notam.coordinates?.[0] ?? notam.coordinates?.[1];
      let rawLon = notam.lon ?? notam.longitude ?? notam.coordinates?.[1] ?? notam.coordinates?.[0];

      if (Array.isArray(notam.coordinates)) {
        // If coordinate array has latitude in [0] and longitude in [1], swap them
        if (Math.abs(notam.coordinates[0]) <= 90 && Math.abs(notam.coordinates[1]) > 90) {
          rawLat = notam.coordinates[0];
          rawLon = notam.coordinates[1];
        } else {
          rawLon = notam.coordinates[0];
          rawLat = notam.coordinates[1];
        }
      }

      const lat = Number(rawLat);
      const lon = Number(rawLon);

      if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0) {
        // Ensure lat/lon aren't inverted (US Latitudes ~24 to 50, Longitudes ~-125 to -66)
        const finalLat = Math.abs(lat) > 90 ? lon : lat;
        const finalLon = Math.abs(lat) > 90 ? lat : lon;

        const centerCoords = fromLonLat([finalLon, finalLat]);
        validCoords.push(centerCoords);

        const radiusMiles = notam.radiusMiles || notam.radius || 0;

        if (radiusMiles > 0) {
          const radiusMeters = radiusMiles * 1609.34;
          const circleFeature = new Feature({
            geometry: CircularPolygon.fromCircle(new Point(centerCoords).getGeometry(), radiusMeters),
            id: notam.id,
            text: notam.text,
            level: notam.level
          });
          vectorSourceRef.current.addFeature(circleFeature);
        } else {
          const pointFeature = new Feature({
            geometry: new Point(centerCoords),
            id: notam.id,
            text: notam.text,
            level: notam.level
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

  useEffect(() => {
    vectorSourceRef.current.changed();
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