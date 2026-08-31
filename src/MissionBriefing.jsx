import { useMemo, useState } from 'react';
import faaAirports from './airports.json';
import './MissionBriefing.css';

const DEFAULT_PERFORMANCE = {
  climbKt: 90,
  climbGph: 12,
  climbFpm: 700,
  cruiseKt: 115,
  cruiseGph: 9,
  descentKt: 105,
  descentGph: 6.5,
  descentFpm: 600
};

const toNumber = (value) => Number(value) || 0;

const formatDuration = (hours) => {
  const minutes = Math.round(hours * 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const findAirport = (waypoint) => {
  if (!waypoint) return null;
  return faaAirports.find((airport) =>
    airport.icao === waypoint.icao || airport.id === waypoint.icao || airport.id === waypoint.id?.replace(/^apt_/, '')
  );
};

/**
 * Utility to parse raw METAR text into a human-readable object
 * and calculate Pressure and Density Altitude.
 */
const parseMetar = (raw, airportElevation = 0) => {
  const text = raw || "";
  const result = {
    raw: text,
    icao: '',
    wind: 'Calm',
    temp: null,
    dewpoint: null,
    altimeter: 29.92,
    pressureAlt: airportElevation,
    densityAlt: airportElevation,
    isParsed: false
  };

  try {
    // Basic ICAO extraction
    const icaoMatch = text.match(/^([A-Z]{4})/);
    if (icaoMatch) result.icao = icaoMatch[1];

    // Wind: Look for 3 digits + 2-3 digits + optional G + KT
    const windMatch = text.match(/(\d{3})(\d{2,3})(G\d{2})?KT/);
    if (windMatch) {
      const dir = windMatch[1];
      const speed = windMatch[2];
      const gust = windMatch[3] ? ` G${windMatch[3].replace('G', '')}` : '';
      result.wind = `Wind ${dir}° at ${speed}kt${gust}`;
    }

    // Temperature and Dewpoint: Look for DD/DD pattern (e.g., 22/10)
    const tempMatch = text.match(/(\d{2})\/(\d{2})/);
    if (tempMatch) {
      result.temp = parseInt(tempMatch[1], 10);
      result.dewpoint = parseInt(tempMatch[2], 10);
    }

    // Altimeter: Look for A0000
    const altMatch = text.match(/A(\d{4})/);
    if (altMatch) {
      result.altimeter = parseInt(altMatch[1], 10) / 100;
    }

    // --- Altitude Calculations ---
    // Pressure Altitude = (Standard Pressure - Altimeter) * 1000 + Elevation
    result.pressureAlt = ((29.92 - result.altimeter) * 1000) + airportElevation;

    // Density Altitude calculation
    if (result.temp !== null) {
      // ISA Temp = 15 - (2 * (Elevation / 1000))
      const isaTemp = 15 - (2 * (airportElevation / 1000));
      // DA = PA + (120 * (OAT - ISA_Temp))
      result.densityAlt = result.pressureAlt + (120 * (result.temp - isaTemp));
      result.isParsed = true;
    }
  } catch (e) {
    console.error("METAR Parsing error", e);
  }

  return result;
};

export default function MissionBriefing({ missionPlan, onBack }) {
  const [etd, setEtd] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const [performance, setPerformance] = useState(DEFAULT_PERFORMANCE);
  const [weather, setWeather] = useState({ status: 'Not requested', metars: [], tafs: [], notams: [] });
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState('');
  const [notamsReviewed, setNotamsReviewed] = useState(false);

  const destination = missionPlan.waypoints.at(-1);
  const destinationAirport = findAirport(destination);
  
  // Identify specific airports for NOTAMs (Departure and Destination)
  const departureAirport = findAirport(missionPlan.waypoints[0]);
  const criticalAirportIds = useMemo(() => {
    const ids = [];
    if (departureAirport?.icao) ids.push(departureAirport.icao);
    if (destinationAirport?.icao) ids.push(destinationAirport.icao);
    return ids;
  }, [departureAirport, destinationAirport]);

  const allAirportIds = useMemo(() => [...new Set(
    missionPlan.waypoints
      .filter((waypoint) => waypoint.type === 'airport' && waypoint.icao && waypoint.icao !== 'N/A')
      .map((waypoint) => waypoint.icao)
  )], [missionPlan.waypoints]);

  const fuelPlan = useMemo(() => {
    const rows = missionPlan.legs.map((leg, index) => {
      const selectedAltitude = toNumber(leg.selectedMslFeet);
      const previousAltitude = index === 0 ? 0 : toNumber(missionPlan.legs[index - 1].selectedMslFeet);
      const nextAltitude = index === missionPlan.legs.length - 1 ? 0 : toNumber(missionPlan.legs[index + 1].selectedMslFeet);
      
      const climbFeet = Math.max(0, selectedAltitude - previousAltitude);
      const descentFeet = Math.max(0, selectedAltitude - nextAltitude);
      
      // Climb segment
      const climbHours = climbFeet / Math.max(1, toNumber(performance.climbFpm)) / 60;
      const climbDist = climbHours * toNumber(performance.climbKt);
      const climbGal = climbHours * toNumber(performance.climbGph);

      // Descent segment
      const descentHours = descentFeet / Math.max(1, toNumber(performance.descentFpm)) / 60;
      const descentDist = descentHours * toNumber(performance.descentKt);
      const descentGal = descentHours * toNumber(performance.descentGph);

      // Cruise segment
      const cruiseDistance = Math.max(0, leg.distNM - climbDist - descentDist);
      const cruiseHours = cruiseDistance / Math.max(1, toNumber(performance.cruiseKt));
      const cruiseGal = cruiseHours * toNumber(performance.cruiseGph);

      const totalHours = climbHours + cruiseHours + descentHours;
      const totalGallons = climbGal + cruiseGal + descentGal;

      return { 
        ...leg, 
        climbFeet, descentFeet, cruiseDistance, 
        climb: { h: climbHours, g: climbGal },
        cruise: { h: cruiseHours, g: cruiseGal },
        descent: { h: descentHours, g: descentGal },
        hours: totalHours, 
        gallons: totalGallons 
      };
    });

    return {
      rows,
      totalHours: rows.reduce((total, leg) => total + leg.hours, 0),
      totalGallons: rows.reduce((total, leg) => total + leg.gallons, 0),
      totalDist: rows.reduce((total, leg) => total + leg.distNM, 0)
    };
  }, [missionPlan.legs, performance]);

  const updatePerformance = (field, value) => {
    setPerformance((previous) => ({ ...previous, [field]: value }));
  };

  const loadBriefingData = async () => {
    if (allAirportIds.length === 0) return;
    setWeatherLoading(true);
    setWeatherError('');
    try {
      const allIdsParam = encodeURIComponent(allAirportIds.join(','));
      const critIdsParam = encodeURIComponent(criticalAirportIds.join(','));

      const [metarRes, tafRes, notamRes] = await Promise.all([
        fetch(`/aviationweather/metar?ids=${allIdsParam}&format=json&taf=false`),
        fetch(`/aviationweather/taf?ids=${allIdsParam}&format=json`),
        fetch(`/aviationweather/notam?ids=${critIdsParam}&format=json`)
      ]);

      if (!metarRes.ok || !tafRes.ok || !notamRes.ok) {
        throw new Error('Failed to fetch aviation data.');
      }

      const [metars, tafs, notams] = await Promise.all([
        metarRes.json(),
        tafRes.json(),
        notamRes.json()
      ]);

      // Process METARs with parsing logic
      const processedMetars = (Array.isArray(metars) ? metars : []).map(m => {
        // Attempt to find elevation for this specific airport from our local JSON
        const airport = findAirport({ icao: m.icaoId });
        const elev = airport?.lengthFeet || 0; // using lengthFeet as proxy if elevation is missing in JSON structure
        return parseMetar(m.rawOb || m.raw_text, elev);
      });

      setWeather({ 
        status: `Retrieved for ETD ${etd}`, 
        metars: processedMetars, 
        tafs: Array.isArray(tafs) ? tafs : [], 
        notams: Array.isArray(notams) ? notams : [] 
      });
    } catch (error) {
      setWeatherError(error instanceof Error ? error.message : 'Unable to retrieve data.');
    } finally {
      setWeatherLoading(false);
    }
  };

  return (
    <div className="nwkraft-page">
      <aside className="nwkraft-sidebar">
        <h2 className="brand">RampCamp</h2>
        <p>For General Aviation and Camping enthusiasts.</p>
        <button type="button" className="btn-back" onClick={onBack}>← Return to planning</button>

        <label className="briefing-label">
          Estimated time of departure
          <input type="datetime-local" value={etd} onChange={(e) => setEtd(e.target.value)} />
        </label>

        <section className="briefing-section">
          <h3 className="sidebar-h3">Aircraft performance</h3>
          <div className="performance-grid">
            {[
              ['climbKt', 'Climb KTAS'], ['climbGph', 'Climb GPH'], ['climbFpm', 'Climb fpm'],
              ['cruiseKt', 'Cruise KTAS'], ['cruiseGph', 'Cruise GPH'],
              ['descentKt', 'Descent KTAS'], ['descentGph', 'Descent GPH'], ['descentFpm', 'Descent fpm']
            ].map(([field, label]) => (
              <label key={field} className="briefing-label">{label}
                <input type="number" min="0" step="0.1" value={performance[field]} onChange={(e) => updatePerformance(field, e.target.value)} />
              </label>
            ))}
          </div>
        </section>

        <section className="briefing-section">
          <h3 className="sidebar-h3">Data Fetching</h3>
          <button type="button" className="btn-plan-sm" onClick={loadBriefingData} disabled={weatherLoading}>
            {weatherLoading ? 'Loading...' : 'Refresh Weather & NOTAMs'}
          </button>
          <div className="notam-status">
            <label className="notam-check">
              <input type="checkbox" checked={notamsReviewed} onChange={(e) => setNotamsReviewed(e.target.checked)} /> 
              I reviewed NOTAMs.
            </label>
          </div>
        </section>
      </aside>

      <main className="nwkraft-content">
        <header>
          <h1>NWKRAFT Mission Briefing</h1>
          <p>ETD: {etd || 'Not set'} · NOTAM Status: {notamsReviewed ? '✅ Reviewed' : '❌ Pending'}</p>
        </header>

        {/* 1. WEATHER SECTION (Now above route) */}
        <section className="briefing-section">
          <h3 className="section-h3">Weather & NOTAMs</h3>
          {weatherError && <p className="briefing-error">{weatherError}</p>}
          
          {/* Weather Cards */}
          <div className="weather-grid">
            {weather.metars.map((m, i) => (
              <div key={i} className="weather-card">
                <div className="weather-card-header">
                  <strong>{m.icao} METAR</strong>
                  <small>{m.isParsed ? 'Parsed' : 'Raw'}</small>
                </div>
                {m.isParsed ? (
                  <div className="weather-details">
                    <p className="wind-highlight">🌬️ {m.wind}</p>
                    <p>🌡️ {m.temp}°C (Dew: {m.dewpoint}°C)</p>
                    <div className="alt-metrics">
                      <span>P-Alt: <strong>{Math.round(m.pressureAlt)} ft</strong></span>
                      <span>D-Alt: <strong>{Math.round(m.densityAlt)} ft</strong></span>
                    </div>
                  </div>
                ) : (
                  <pre className="raw-text">{m.raw}</pre>
                )}
              </div>
            ))}
          </div>

          {/* TAFs */}
          {weather.tafs.length > 0 && (
            <div className="taf-section">
              <h4>Forecasts (TAF)</h4>
              {weather.tafs.map((t, i) => (
                <pre key={i} className="raw-text">{t.rawTAF || t.raw_text}</pre>
              ))}
            </div>
          )}

          {/* NOTAMs */}
          {weather.notams.length > 0 && (
            <div className="notam-section">
              <h4>Applicable NOTAMs</h4>
              <ul className="notam-list">
                {weather.notams.map((n, i) => (
                  <li key={i} className="notam-item">
                    <span className="notam-code">{n.notamText?.substring(0, 10) || '...'}</span> {n.notamText}
                  </li>
                ))}
              </ul>
            </div>
          )}
          
          {!weatherLoading && weather.metars.length === 0 && (
            <p className="empty-state">No weather data loaded. Click "Refresh" to pull latest reports.</p>
          )}
        </section>

        {/* 2. ROUTE & FUEL SECTION */}
        <section className="briefing-section">
          <h3 className="section-h3">Route & Fuel Projection</h3>
          <div className="fuel-totals">
            <span>Total Distance: <strong>{fuelPlan.totalDist.toFixed(1)} NM</strong></span>
            <span>Est. Time: <strong>{formatDuration(fuelPlan.totalHours)}</strong></span>
            <span>Total Fuel: <strong>{fuelPlan.totalGallons.toFixed(1)} gal</strong></span>
          </div>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Leg</th>
                  <th>MSL</th>
                  <th>Dist</th>
                  <th>Climb / Desc</th>
                  <th>Time</th>
                  <th>Fuel Breakdown (C / Cr / D)</th>
                </tr>
              </thead>
              <tbody>
                {fuelPlan.rows.map((leg, index) => (
                  <tr key={leg.id}>
                    <td>{index + 1}. {leg.start.name} → {leg.end.name}</td>
                    <td>{Number(leg.selectedMslFeet).toLocaleString()} ft</td>
                    <td>{leg.distNM.toFixed(1)} NM</td>
                    <td className="small-text">
                      +{leg.climbFeet.toLocaleString()}<br/>
                      −{leg.descentFeet.toLocaleString()}
                    </td>
                    <td>{formatDuration(leg.hours)}</td>
                    <td className="fuel-breakdown">
                      <span className="fuel-pill climb">{leg.climb.g.toFixed(1)}g</span>
                      <span className="fuel-pill cruise">{leg.cruise.g.toFixed(1)}g</span>
                      <span className="fuel-pill descent">{leg.descent.g.toFixed(1)}g</span>
                      <span className="total-gal"> = {leg.gallons.toFixed(1)}g</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="briefing-section">
          <h3 className="section-h3">Destination Reference</h3>
          {destinationAirport ? (
            <div className="dest-info">
              <strong>{destinationAirport.icao || destinationAirport.id}</strong> — {destinationAirport.name}<br/>
              Runway: <strong>{destinationAirport.lengthFeet?.toLocaleString() || 'N/A'} ft</strong> ({destinationAirport.surface || 'unknown surface'})
            </div>
          ) : (
            <p>No destination airport record found.</p>
          )}
        </section>
      </main>
    </div>
  );
}
