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

export default function MissionBriefing({ missionPlan, onBack }) {
  const [etd, setEtd] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const [performance, setPerformance] = useState(DEFAULT_PERFORMANCE);
  const [weather, setWeather] = useState({ status: 'Not requested', metars: [], tafs: [] });
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState('');
  const [notamsReviewed, setNotamsReviewed] = useState(false);

  const destination = missionPlan.waypoints.at(-1);
  const destinationAirport = findAirport(destination);
  const airportIds = useMemo(() => [...new Set(
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
      const descentHours = descentFeet / Math.max(1, toNumber(performance.descentFpm)) / 60;
      const climbDistance = climbHours * toNumber(performance.climbKt);
      const descentDistance = descentHours * toNumber(performance.descentKt);
      const cruiseDistance = Math.max(0, leg.distNM - climbDistance - descentDistance);
      const cruiseHours = cruiseDistance / Math.max(1, toNumber(performance.cruiseKt));
      const hours = climbHours + cruiseHours + descentHours;
      const gallons = climbHours * toNumber(performance.climbGph)
        + cruiseHours * toNumber(performance.cruiseGph)
        + descentHours * toNumber(performance.descentGph);
      return { ...leg, climbFeet, descentFeet, cruiseDistance, hours, gallons };
    });
    return {
      rows,
      totalHours: rows.reduce((total, leg) => total + leg.hours, 0),
      totalGallons: rows.reduce((total, leg) => total + leg.gallons, 0)
    };
  }, [missionPlan.legs, performance]);

  const updatePerformance = (field, value) => {
    setPerformance((previous) => ({ ...previous, [field]: value }));
  };

  const loadWeather = async () => {
    if (airportIds.length === 0) return;
    setWeatherLoading(true);
    setWeatherError('');
    try {
      const ids = encodeURIComponent(airportIds.join(','));
      const [metarResponse, tafResponse] = await Promise.all([
        fetch(`/aviationweather/metar?ids=${ids}&format=json&taf=false`),
        fetch(`/aviationweather/taf?ids=${ids}&format=json`)
      ]);
      if (!metarResponse.ok || !tafResponse.ok) {
        throw new Error('Aviation Weather returned an unavailable response.');
      }
      const [metars, tafs] = await Promise.all([metarResponse.json(), tafResponse.json()]);
      setWeather({ status: `Retrieved for ETD ${etd}`, metars: Array.isArray(metars) ? metars : [], tafs: Array.isArray(tafs) ? tafs : [] });
    } catch (error) {
      setWeatherError(error instanceof Error ? error.message : 'Unable to retrieve Aviation Weather data.');
    } finally {
      setWeatherLoading(false);
    }
  };

  return (
    <div className="nwkraft-page">
      <aside className="nwkraft-sidebar">
        <h2>RampCamp</h2>
        <p>For General Aviation and Camping enthusiasts.</p>
        <button type="button" className="btn-back" onClick={onBack}>← Return to altitude planning</button>

        <label className="briefing-label">
          Estimated time of departure
          <input type="datetime-local" value={etd} onChange={(event) => setEtd(event.target.value)} />
        </label>

        <section className="briefing-section">
          <h3>Aircraft performance</h3>
          <div className="performance-grid">
            {[
              ['climbKt', 'Climb KTAS'], ['climbGph', 'Climb GPH'], ['climbFpm', 'Climb ft/min'],
              ['cruiseKt', 'Cruise KTAS'], ['cruiseGph', 'Cruise GPH'],
              ['descentKt', 'Descent KTAS'], ['descentGph', 'Descent GPH'], ['descentFpm', 'Descent ft/min']
            ].map(([field, label]) => (
              <label key={field} className="briefing-label">{label}
                <input type="number" min="0" step="0.1" value={performance[field]} onChange={(event) => updatePerformance(field, event.target.value)} />
              </label>
            ))}
          </div>
        </section>

        <section className="briefing-section">
          <h3>FAA sources</h3>
          <button type="button" className="btn-plan-sm" onClick={loadWeather} disabled={weatherLoading}>
            {weatherLoading ? 'Loading Aviation Weather…' : 'Load METARs & TAFs'}
          </button>
          <a href="https://notams.aim.faa.gov/notamSearch/" target="_blank" rel="noreferrer">Open FAA NOTAM Search</a>
          <label className="notam-check"><input type="checkbox" checked={notamsReviewed} onChange={(event) => setNotamsReviewed(event.target.checked)} /> I reviewed applicable NOTAMs for this ETD.</label>
        </section>
      </aside>

      <main className="nwkraft-content">
        <header>
          <h1>NWKRAFT Mission Plan</h1>
          <p>ETD: {etd || 'Not set'} · NOTAM review: {notamsReviewed ? 'confirmed by pilot' : 'pending'}</p>
        </header>

        <section className="briefing-section">
          <h3>Route and fuel projection</h3>
          <div className="fuel-totals">
            <span>{fuelPlan.rows.reduce((total, leg) => total + leg.distNM, 0).toFixed(1)} NM</span>
            <span>{formatDuration(fuelPlan.totalHours)}</span>
            <span>{fuelPlan.totalGallons.toFixed(1)} gal</span>
          </div>
          <table>
            <thead><tr><th>Leg</th><th>Selected MSL</th><th>Distance</th><th>Climb / descent</th><th>Time</th><th>Fuel</th></tr></thead>
            <tbody>{fuelPlan.rows.map((leg, index) => (
              <tr key={leg.id}>
                <td>{index + 1}. {leg.start.name} → {leg.end.name}</td>
                <td>{Number(leg.selectedMslFeet).toLocaleString()} ft</td>
                <td>{leg.distNM.toFixed(1)} NM</td>
                <td>+{leg.climbFeet.toLocaleString()} / −{leg.descentFeet.toLocaleString()} ft</td>
                <td>{formatDuration(leg.hours)}</td>
                <td>{leg.gallons.toFixed(1)} gal</td>
              </tr>
            ))}</tbody>
          </table>
        </section>

        <section className="briefing-section">
          <h3>Destination runway reference</h3>
          {destinationAirport ? <p>{destinationAirport.icao || destinationAirport.id} — {destinationAirport.name}: <strong>{destinationAirport.lengthFeet?.toLocaleString() || 'Unknown'} ft</strong>, {destinationAirport.surface || 'surface unknown'} (from airports.json).</p> : <p>No matching airport record found in airports.json.</p>}
        </section>

        <section className="briefing-section">
          <h3>Current weather — AviationWeather.gov</h3>
          <p>{weather.status}</p>
          {weatherError && <p className="briefing-error">{weatherError}</p>}
          {weather.metars.map((report) => <pre key={`${report.icaoId}-${report.obsTime}`}>{report.rawOb || report.raw_text || JSON.stringify(report)}</pre>)}
          {weather.tafs.map((report) => <pre key={`${report.icaoId}-${report.issueTime}`}>{report.rawTAF || report.raw_text || JSON.stringify(report)}</pre>)}
          {!weatherError && weather.metars.length === 0 && weather.tafs.length === 0 && <p>Load current METARs and TAFs for the airport waypoints above.</p>}
        </section>
      </main>
    </div>
  );
}
