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
import { fromLonLat, toLonLat } from 'ol/proj';
import { Style, Circle, Fill, Stroke } from 'ol/style';

export default function MapApp() {
  const mapElement = useRef(null);
  const mapRef = useRef(null);
  const vectorSourceRef = useRef(new VectorSource());

  // Search Parameters
  const [centerCoords, setCenterCoords] = useState([-84.3835, 33.7554]); // [lon, lat] default Atlanta, GA
  const [airportRadiusMiles, setAirportRadiusMiles] = useState(50);
  const [campRadiusMiles, setCampRadiusMiles] = useState(15);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState({ airports: [], campsites: [] });

  // Initialize Map
  useEffect(() => {
    const vectorLayer = new VectorLayer({
      source: vectorSourceRef.current,
      style: (feature) => {
        const type = feature.get('type');
        if (type === 'airport') {
          return new Style({
            image: new Circle({
              radius: 8,
              fill: new Fill({ color: '#2563eb' }),
              stroke: new Stroke({ color: '#ffffff', width: 2 })
            })
          });
        }
        return new Style({
          image: new Circle({
            radius: 6,
            fill: new Fill({ color: '#16a34a' }),
            stroke: new Stroke({ color: '#ffffff', width: 1.5 })
          })
        });
      }
    });

    const initialMap = new Map({
      target: mapElement.current,
      layers: [
        new TileLayer({ source: new OSM() }),
        vectorLayer
      ],
      view: new View({
        center: fromLonLat([-84.3835, 33.7554]),
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

  // Fetch Spatial Data
    const handleSearch = async () => {
    setLoading(true);
    vectorSourceRef.current.clear();

    const airportRadiusMeters = airportRadiusMiles * 1609.34;
    const campRadiusMeters = campRadiusMiles * 1609.34;
    const [lon, lat] = centerCoords;

    const overpassQuery = `
        [out:json][timeout:25];
        nwr["aeroway"="aerodrome"](around:${airportRadiusMeters},${lat},${lon})->.airports;
        nwr["tourism"="camp_site"](around.airports:${campRadiusMeters})->.campsites;
        (.airports; .campsites;);
        out center;
    `;

    try {
        const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `data=${encodeURIComponent(overpassQuery)}`
        });

        // 1. Check if server returned a non-200 HTTP status (e.g., 504 Timeout or 429 Rate Limit)
        if (!response.ok) {
        throw new Error(`Server Error: ${response.status} ${response.statusText}`);
        }

        // 2. Safely parse JSON
        const data = await response.json();

        if (!data || !data.elements) {
        throw new Error('Invalid or empty response format from Overpass API');
        }

        const airports = [];
        const campsites = [];

        data.elements.forEach((item) => {
        const itemLat = item.lat || item.center?.lat;
        const itemLon = item.lon || item.center?.lon;
        if (!itemLat || !itemLon) return;

        const isAirport = item.tags?.aeroway === 'aerodrome';
        const feature = new Feature({
            geometry: new Point(fromLonLat([itemLon, itemLat])),
            name: item.tags?.name || (isAirport ? 'Unnamed Airport' : 'Unnamed Campsite'),
            type: isAirport ? 'airport' : 'campsite'
        });

        vectorSourceRef.current.addFeature(feature);

        if (isAirport) {
            airports.push({ name: item.tags?.name, icao: item.tags?.icao, lat: itemLat, lon: itemLon });
        } else {
            campsites.push({ name: item.tags?.name, lat: itemLat, lon: itemLon });
        }
        });

        setResults({ airports, campsites });
    } catch (err) {
        console.error('Search failed:', err);
        alert(`Search error: ${err.message}. Check browser console for details.`);
    } finally {
        // 3. ALWAYS runs regardless of success or failure
        setLoading(false);
    }
    };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      {/* Sidebar Controls */}
      <div style={{ width: '320px', padding: '1.5rem', background: '#f8fafc', overflowY: 'auto' }}>
        <h2>Air & Camp Finder</h2>
        <p style={{ fontSize: '0.85rem', color: '#64748b' }}>
          Click anywhere on the map to place search origin.
        </p>

        <div style={{ marginBottom: '1rem' }}>
          <label><b>Center:</b> {centerCoords[1].toFixed(4)}, {centerCoords[0].toFixed(4)}</label>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label>Airport Search Radius (Miles)</label>
          <input 
            type="number" 
            value={airportRadiusMiles} 
            onChange={(e) => setAirportRadiusMiles(Number(e.target.value))}
            style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
          />
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label>Campsite Radius from Airport (Miles)</label>
          <input 
            type="number" 
            value={campRadiusMiles} 
            onChange={(e) => setCampRadiusMiles(Number(e.target.value))}
            style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
          />
        </div>

        <button 
          onClick={handleSearch} 
          disabled={loading}
          style={{ width: '100%', padding: '0.75rem', background: '#2563eb', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
        >
          {loading ? 'Searching...' : 'Find Matches'}
        </button>

        {/* Results Overview */}
        <div style={{ marginTop: '1.5rem' }}>
          <h3>Results Found</h3>
          <p><b>Airports:</b> {results.airports.length}</p>
          <p><b>Campsites:</b> {results.campsites.length}</p>
        </div>
      </div>

      {/* Map Element */}
      <div ref={mapElement} style={{ flex: 1, height: '100%' }} />
    </div>
  );
}