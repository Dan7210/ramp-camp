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
 * Parses raw METAR text into human-readable format and calculates altitudes.
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
    const icaoMatch = text.match(/^([A-Z]{4})/);
    if (icaoMatch) result.icao = icaoMatch[1];

    // Wind parsing
    const windMatch = text.match(/(\d{3})(\d{2,3})(G\d{2})?KT/);
    if (windMatch) {
      const dir = windMatch[1];
      const speed = windMatch[2];
      const gust = windMatch[3] ? ` G${windMatch[3].replace('G', '')}` : '';
      result.wind = `${dir}° at ${speed}kt${gust}`;
    }

    // Temp/Dewpoint parsing
    const tempMatch = text.match(/(\d{2})\/(\d{2})/);
    if (tempMatch) {
      result.temp = parseInt(tempMatch[1], 10);
      result.dewpoint = parseInt(tempMatch[2], 10);
    }

    // Altimeter parsing
    const altMatch = text.match(/A(\d{4})/);
    if (altMatch) {
      result.altimeter = parseInt(altMatch[1], 10) / 100;
    }

    // Pressure Altitude = (29.92 - Altimeter) * 1000 + Elevation
    result.pressureAlt = ((29.92 - result.altimeter) * 1000) + airportElevation;

    // Density Altitude
    if (result.temp !== null) {
      const isaTemp = 15 - (2 * (airportElevation / 1000));
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
  const [weather, setWeather] = useState({ status: 'Not requested', metars: [], tafs: [] });
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState('');
  const [notamsReviewed, setNotamsReviewed] = useState(false);

  const destination = missionPlan.waypoints.at(-1);
  const destinationAirport = findAirport(destination);
  
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
      
      const climbHours = climbFeet / Math.max(1, toNumber(performance.climbFpm)) / 60;
      const climbDist = climbHours * toNumber(performance.climbKt);
      const climbGal = climbHours * toNumber(performance.climbGph);

      const descentHours = descentFeet / Math.max(1, toNumber(performance.descentFpm)) / 60;
      const descentDist = descentHours * toNumber(performance.descentKt);
      const descentGal = descentHours * toNumber(performance.descentGph);

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
    setPerformance((prev) => ({ ...prev, [field]: value }));
  };

  const loadWeather = async () => {
    if (allAirportIds.length === 0) return;
    setWeatherLoading(true);
    setWeatherError('');
    try {
      const ids = encodeURIComponent(allAirportIds.join(','));
      // Note: We only fetch METAR and TAF per instructions
      const [metarRes, tafRes] = await Promise.all([
        fetch(`/aviationweather/metar?ids=${ids}&format=json&taf=false`),
        fetch(`/aviationweather/taf?ids=${ids}&format=json`)
      ]);

      if (!metarRes.ok || !tafRes.ok) {
        throw new Error('Aviation Weather service unavailable.');
      }

      const [metars, tafs] = await Promise.all([metarRes.json(), tafRes.json()]);

      const processedMetars = (Array.isArray(metars) ? metars : []).map(m => {
        const airport = findAirport({ icao: m.icaoId });
        // FIX: Check for elevation, msl, or alt. Do NOT use lengthFeet for altitude math.
        const elev = airport?.elevation || airport?.msl || airport?.alt || 0;
        return parseMetar(m.rawOb || m.raw_text, elev);
      });

      setWeather({ 
        status: `Updated for ${etd}`, 
        metars: processedMetars, 
        tafs: Array.isArray(tafs) ? tafs : [] 
      });
    } catch (error) {
      setWeatherError(error instanceof Error ? error.message : 'Unable to retrieve weather.');
    } finally {
      setWeatherLoading(false);
    }
  };

  return (
    <div className="nwkraft-page">
      <aside className="nwkraft-sidebar">
        <h2 className="brand">RampCamp</h2>
        <button type="button" className="btn-back" onClick={onBack}>← Back</button>

        <label className="briefing-label">
          ETD
          <input type="datetime-local" value={etd} onChange={(e) => setEtd(e.target.value)} />
        </label>

        <section className="briefing-section">
          <h3 className="sidebar-h3">Performance</h3>
          <div className="performance-grid">
            {[
              ['climbKt', 'Climb KTAS'], ['climbGph', 'Climb GPH'], ['climbFpm', 'Climb fpm'],
              ['cruiseKt', 'Cruise KTAS'], ['cruiseGph', 'Cruise GPH'],
              ['descentKt', 'Descent KTAS'], ['descentGph', 'Descent GPH'], ['descentFpm', 'Descent fpm']
            ].map(([field, label]) => (
              <label key={field} className="briefing-label">{label}
                <input type="number" step="0.1" value={performance[field]} onChange={(e) => updatePerformance(field, e.target.value)} />
              </label>
            ))}
          </div>
        </section>

        <section className="briefing-section">
          <h3 className="sidebar-h3">Weather Data</h3>
          <button type="button" className="btn-plan-sm" onClick={loadWeather} disabled={weatherLoading}>
            {weatherLoading ? 'Loading...' : 'Refresh METAR/TAF'}
          </button>
        </section>
      </aside>

      <main className="nwkraft-content">
        <header>
          <h1>NWKRAFT Mission Briefing</h1>
          <p>ETD: {etd} | NOTAM Review: {notamsReviewed ? '✅' : '❌'}</p>
        </header>

        {/* SECTION 1: NOTAMS (Mimicking NWKRAFT order) */}
        <section className="briefing-section notam-section">
          <h3 className="section-h3">NOTAMs</h3>
          <div className="notam-box">
            <a href="https://notams.aim.faa.gov/notamSearch/" target="_blank" rel="noreferrer" className="btn-link">
              Open FAA NOTAM Search
            </a>
            <label className="notam-check">
              <input type="checkbox" checked={notamsReviewed} onChange={(e) => setNotamsReviewed(e.target.checked)} />
              I have reviewed the applicable NOTAMs for this flight.
            </label>
          </div>
        </section>

        {/* SECTION 2: WEATHER (Automatic) */}
        <section className="briefing-section">
          <h3 className="section-h3">Weather (METAR/TAF)</h3>
          {weatherError && <p className="briefing-error">{weatherError}</p>}
          
          <div className="weather-grid">
            {weather.metars.map((m, i) => (
              <div key={i} className="weather-card">
                <div className="weather-card-header">
                  <strong>{m.icao}</strong>
                </div>
                
                {m.isParsed ? (
                  <div className="weather-plain-english">
                    <p className="wind-line">🌬️ {m.wind}</p>
                    <p className="temp-line">🌡️ {m.temp}°C / Dew: {m.dewpoint}°C</p>
                    <div className="alt-line">
                      <span>P-Alt: <strong>{Math.round(m.pressureAlt)}'</strong></span>
                      <span>D-Alt: <strong>{Math.round(m.densityAlt)}'</strong></span>
                    </div>
                  </div>
                ) : (
                  <p className="parsing-error">Unable to parse METAR</p>
                )}

                <div className="weather-encoded-small">
                  <pre>{m.raw}</pre>
                </div>
              </div>
            ))}
          </div>

          {weather.tafs.length > 0 && (
            <div className="taf-container">
              <h4>Forecasts (TAF)</h4>
              {weather.tafs.map((t, i) => (
                <div key={i} className="taf-card">
                   <div className="weather-encoded-small">
                     <pre>{t.rawTAF || t.raw_text}</pre>
                   </div>
                </div>
              ))}
            </div>
          )}

          {!weatherLoading && weather.metars.length === 0 && !weatherError && (
            <p className="empty-msg">No weather data loaded.</p>
          )}
        </section>

        {/* SECTION 3: ROUTE & FUEL */}
        <section className="briefing-section">
          <h3 className="section-h3">Route & Fuel Projection</h3>
          <div className="fuel-totals">
            <span>{fuelPlan.totalDist.toFixed(1)} NM</span>
            <span>{formatDuration(fuelPlan.totalHours)}</span>
            <span>{fuelPlan.totalGallons.toFixed(1)} Gal</span>
          </div>

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Leg</th>
                  <th>MSL</th>
                  <th>Dist</th>
                  <th>Climb/Desc</th>
                  <th>Time</th>
                  <th>Fuel (C / Cr / D)</th>
                </tr>
              </thead>
              <tbody>
                {fuelPlan.rows.map((leg, index) => (
                  <tr key={leg.id}>
                    <td>{index + 1}. {leg.start.name} ➡️ {leg.end.name}</td>
                    <td>{Number(leg.selectedMslFeet).toLocaleString()} ft</td>
                    <td>{leg.distNM.toFixed(1)} NM</td>
                    <td className="small-text">
                      +{leg.climbFeet.toLocaleString()}<br/>
                      −{leg.descentFeet.toLocaleString()}
                    </td>
                    <td>{formatDuration(leg.hours)}</td>
                    <td className="fuel-breakdown">
                      <span className="pill-climb">{leg.climb.g.toFixed(2)}g + </span>
                      <span className="pill-cruise">{leg.cruise.g.toFixed(2)}g + </span>
                      <span className="pill-desc">{leg.descent.g.toFixed(2)}g</span>
                      <span className="total-sum"> = {leg.gallons.toFixed(2)}g</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="briefing-section">
          <h3 className="section-h3">Destination</h3>
          {destinationAirport ? (
            <div className="dest-card">
              <strong>{destinationAirport.icao || destinationAirport.id}</strong> — {destinationAirport.name}<br/>
              Runway: {destinationAirport.lengthFeet?.toLocaleString() || 'N/A'} ft ({destinationAirport.surface || 'unknown'})
            </div>
          ) : <p>No destination info.</p>}
        </section>
      </main>
    </div>
  );
}
