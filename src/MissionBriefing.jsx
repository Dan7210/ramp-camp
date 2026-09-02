import { useMemo, useState, useEffect, useCallback } from 'react';
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

const NOTAM_ENDPOINT = 'https://adsb-radar.duckdns.org:3000/api/notams/route';

const toNumber = (value) => Number(value) || 0;

const formatDuration = (hours) => {
  const minutes = Math.round(hours * 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const findAirport = (waypoint) => {
  if (!waypoint) return null;
  const searchId = (waypoint.icao || waypoint.id || '').replace(/^apt_/, '').toUpperCase();
  if (searchId && searchId !== 'ORIGIN_WP' && searchId !== 'N/A') {
    const found = faaAirports.find((a) => a.icao?.toUpperCase() === searchId || a.id?.toUpperCase() === searchId);
    if (found) return found;
  }
  if (waypoint.lat && waypoint.lon) {
    let closestApt = null;
    let minDistance = Infinity;
    faaAirports.forEach((apt) => {
      const dLat = apt.lat - waypoint.lat;
      const dLon = apt.lon - waypoint.lon;
      const distSq = dLat * dLat + dLon * dLon;
      if (distSq < minDistance) {
        minDistance = distSq;
        closestApt = apt;
      }
    });
    if (minDistance < 0.01) return closestApt;
  }
  return null;
};

// Calculate Minimum and Maximum Crosswind Components across all runways
const calculateCrosswinds = (windDir, windSpeed, windGust, runways) => {
  if (windDir === null || windSpeed === null) return { min: 0, max: 0 };
  const maxVelocity = windSpeed + (windGust ? (windGust - windSpeed) : 0);
  if (windSpeed === 0 || windDir === 0) return { min: 0, max: 0 };
  if (!runways || runways.length === 0) return { min: 0, max: maxVelocity };

  let minCrosswind = Infinity;
  let maxCrosswind = 0;

  runways.forEach((rw) => {
    const headings = [];
    if (typeof rw === 'string') {
      const match = rw.match(/\d+/g);
      if (match) match.forEach(num => headings.push(parseInt(num, 10) * 10));
    } else if (rw.heading) {
      headings.push(rw.heading);
      headings.push((rw.heading + 180) % 360);
    }

    headings.forEach((heading) => {
      const angleRad = ((windDir - heading) * Math.PI) / 180;
      const crosswind = Math.abs(maxVelocity * Math.sin(angleRad));
      if (crosswind < minCrosswind) minCrosswind = crosswind;
      if (crosswind > maxCrosswind) maxCrosswind = crosswind;
    });
  });

  return {
    min: minCrosswind === Infinity ? 0 : Math.round(minCrosswind),
    max: Math.round(maxCrosswind)
  };
};

// FAA Flight Category Evaluator
const evaluateFlightCategory = (ceilingFeet, visibilitySm) => {
  const c = ceilingFeet !== null ? ceilingFeet : Infinity;
  const v = visibilitySm !== null ? visibilitySm : Infinity;

  let ceilingCat = 'VFR';
  if (c < 500) ceilingCat = 'LIFR';
  else if (c < 1000) ceilingCat = 'IFR';
  else if (c <= 3000) ceilingCat = 'MVFR';

  let visCat = 'VFR';
  if (v < 1) visCat = 'LIFR';
  else if (v < 3) visCat = 'IFR';
  else if (v <= 5) visCat = 'MVFR';

  const order = { LIFR: 4, IFR: 3, MVFR: 2, VFR: 1 };
  const category = order[ceilingCat] >= order[visCat] ? ceilingCat : visCat;

  const ceilingStr = c === Infinity ? 'CLR/Unlimited' : `${c} ft`;
  const visStr = v === Infinity ? 'Unrestricted' : `${v} SM`;

  let reason = [];
  if (category === 'VFR') {
    reason.push(`Ceiling (${ceilingStr}) > 3,000 ft & Vis (${visStr}) > 5 SM`);
  } else {
    if (ceilingCat === category) reason.push(`Ceiling ${ceilingStr} (${ceilingCat})`);
    if (visCat === category) reason.push(`Visibility ${visStr} (${visCat})`);
  }

  return { category, reason: reason.join(' & ') };
};

// Extracts active TAF group matching target UTC (Zulu) timestamp
const extractActiveTafSegment = (rawTaf, targetUtcDate) => {
  if (!rawTaf) return rawTaf;
  const targetTime = targetUtcDate.getTime();

  const parts = rawTaf.split(/(?=\b(?:FM\d{6}|TEMPO|BECMG)\b)/);
  let selectedGroup = parts[0];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const fmMatch = part.match(/FM(\d{2})(\d{2})(\d{2})/);
    if (fmMatch) {
      const now = new Date();
      const fmDate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), parseInt(fmMatch[1], 10), parseInt(fmMatch[2], 10), parseInt(fmMatch[3], 10));
      if (targetTime >= fmDate) {
        selectedGroup = part;
      }
    }
  }
  return selectedGroup;
};

// Parse raw METAR line
const parseMetar = (rawText) => {
  if (!rawText) return null;
  const res = {
    obsTime: null,
    windDir: 0,
    windSpeed: 0,
    windGust: null,
    windStr: 'Calm',
    temp: 15,
    dewpoint: 10,
    altimeter: 29.92,
    visibility: 10,
    ceiling: null
  };

  const timeMatch = rawText.match(/(\d{2})(\d{2})(\d{2})Z/);
  if (timeMatch) {
    const now = new Date();
    res.obsTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), parseInt(timeMatch[3], 10)));
  }

  const windMatch = rawText.match(/(VRB|\d{3})(\d{2,3})(G\d{2,3})?KT/);
  if (windMatch) {
    res.windDir = windMatch[1] === 'VRB' ? 0 : parseInt(windMatch[1], 10);
    res.windSpeed = parseInt(windMatch[2], 10);
    res.windGust = windMatch[3] ? parseInt(windMatch[3].replace('G', ''), 10) : null;
    res.windStr = res.windSpeed === 0 ? 'Calm' : `${windMatch[1]}° at ${res.windSpeed}kt${res.windGust ? ` G${res.windGust}kt` : ''}`;
  }

  const tempMatch = rawText.match(/(M?\d{2})\/(M?\d{2})/);
  if (tempMatch) {
    res.temp = parseInt(tempMatch[1].replace('M', '-'), 10);
    res.dewpoint = parseInt(tempMatch[2].replace('M', '-'), 10);
  }

  const altMatch = rawText.match(/A(\d{4})/);
  if (altMatch) res.altimeter = parseInt(altMatch[1], 10) / 100;

  const visMatch = rawText.match(/(P?\d+\/\d+|P?\d+)\s*SM/);
  if (visMatch) {
    const v = visMatch[1].replace('P', '');
    res.visibility = v.includes('/') ? v.split('/')[0] / v.split('/')[1] : parseInt(v, 10);
  }

  const cloudMatches = [...rawText.matchAll(/(BKN|OVC)(\d{3})/g)];
  if (cloudMatches.length > 0) {
    res.ceiling = Math.min(...cloudMatches.map(m => parseInt(m[2], 10) * 100));
  }

  return res;
};

// Blends METAR base with superceding TAF/MOS forecasts
const buildBlendedWeather = (apt, rawMetar, rawTaf, rawMos, targetEtdIso) => {
  const elev = apt?.elevationFeet || apt?.elevation || 0;
  const targetUtcDate = targetEtdIso ? new Date(targetEtdIso) : new Date();

  const metarData = parseMetar(rawMetar);
  
  const result = {
    icao: apt?.icao || apt?.id || 'UNKNOWN',
    rawMetar: rawMetar || 'No METAR available',
    rawForecast: null,
    isStale: false,
    sources: { wind: 'METAR', visibility: 'METAR', ceiling: 'METAR', densityAlt: 'METAR' },
    windDir: metarData?.windDir || 0,
    windSpeed: metarData?.windSpeed || 0,
    windGust: metarData?.windGust || null,
    windStr: metarData?.windStr || 'Calm',
    temp: metarData?.temp ?? 15,
    dewpoint: metarData?.dewpoint ?? 10,
    altimeter: metarData?.altimeter ?? 29.92,
    visibility: metarData?.visibility ?? 10,
    ceiling: metarData?.ceiling ?? null,
    pressureAlt: elev,
    densityAlt: elev,
    minCrosswind: 0,
    maxCrosswind: 0,
    flightCategory: { category: 'VFR', reason: '' }
  };

  if (metarData?.obsTime) {
    const diffMinutes = (targetUtcDate.getTime() - metarData.obsTime.getTime()) / (1000 * 60);
    if (diffMinutes > 30) result.isStale = true;
  }

  let activeForecastText = null;
  let forecastType = null;

  if (rawTaf) {
    activeForecastText = extractActiveTafSegment(rawTaf, targetUtcDate);
    forecastType = 'TAF';
  } else if (rawMos) {
    activeForecastText = rawMos;
    forecastType = 'MOS';
  }

  if (activeForecastText) {
    result.rawForecast = `${forecastType}: ${activeForecastText.trim()}`;

    const fWind = activeForecastText.match(/(VRB|\d{3})(\d{2,3})(G\d{2,3})?KT/);
    if (fWind) {
      result.windDir = fWind[1] === 'VRB' ? 0 : parseInt(fWind[1], 10);
      result.windSpeed = parseInt(fWind[2], 10);
      result.windGust = fWind[3] ? parseInt(fWind[3].replace('G', ''), 10) : null;
      result.windStr = result.windSpeed === 0 ? 'Calm' : `${fWind[1]}° at ${result.windSpeed}kt${result.windGust ? ` G${result.windGust}kt` : ''}`;
      result.sources.wind = forecastType;
    }

    const fVis = activeForecastText.match(/(P?\d+\/\d+|P?\d+)\s*SM/);
    if (fVis) {
      const v = fVis[1].replace('P', '');
      result.visibility = v.includes('/') ? v.split('/')[0] / v.split('/')[1] : parseInt(v, 10);
      result.sources.visibility = forecastType;
    }

    const fClouds = [...activeForecastText.matchAll(/(BKN|OVC)(\d{3})/g)];
    if (fClouds.length > 0) {
      result.ceiling = Math.min(...fClouds.map(m => parseInt(m[2], 10) * 100));
      result.sources.ceiling = forecastType;
    } else if (activeForecastText.includes('SKC') || activeForecastText.includes('CLR') || activeForecastText.includes('FEW') || activeForecastText.includes('SCT')) {
      result.ceiling = null;
      result.sources.ceiling = forecastType;
    }
  }

  result.pressureAlt = Math.round(((29.92 - result.altimeter) * 1000) + elev);
  const isaTemp = 15 - (1.98 * (elev / 1000));
  result.densityAlt = Math.round(result.pressureAlt + (120 * (result.temp - isaTemp)));

  const xw = calculateCrosswinds(result.windDir, result.windSpeed, result.windGust, apt?.runways);
  result.minCrosswind = xw.min;
  result.maxCrosswind = xw.max;

  result.flightCategory = evaluateFlightCategory(result.ceiling, result.visibility);

  return result;
};

const isDaytime = (date) => {
  const hours = date.getHours();
  return hours >= 6 && hours < 18;
};

// Helper for NOTAM classification and priority styling
const categorizeNotam = (notam) => {
  const text = (notam.text || '').toUpperCase();
  
  if (text.includes('TFR') || text.includes('RESTRICTED') || text.includes('PROHIBITED') || text.includes('SECURITY')) {
    return { category: 'TFR / Airspace Constraints', level: 'critical', badge: 'RED' };
  }
  if (text.includes('RWY') || text.includes('RUNWAY') || text.includes('CLSD') || text.includes('CLOSED')) {
    return { category: 'Runways & Aerodrome Ops', level: 'critical', badge: 'RED' };
  }
  if (text.includes('OBST') || text.includes('TOWER') || text.includes('CRANE') || text.includes('LIGHT')) {
    return { category: 'Obstacles & Hazards', level: 'warning', badge: 'ORANGE' };
  }
  if (text.includes('NAV') || text.includes('ILS') || text.includes('VOR') || text.includes('GPS') || text.includes('WAAS') || text.includes('PROC')) {
    return { category: 'Navigational Aids & Approaches', level: 'caution', badge: 'YELLOW' };
  }
  if (text.includes('TWY') || text.includes('TAXIWAY') || text.includes('APRON') || text.includes('RAMP')) {
    return { category: 'Taxiways & Aprons', level: 'info', badge: 'BLUE' };
  }
  if (text.includes('SVC') || text.includes('FUEL') || text.includes('COM') || text.includes('TWR')) {
    return { category: 'Services & Communications', level: 'info', badge: 'BLUE' };
  }
  return { category: 'General / Other', level: 'low', badge: 'GRAY' };
};

export default function MissionBriefing({ missionPlan, onBack }) {
  const [etd, setEtd] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const [performance, setPerformance] = useState(DEFAULT_PERFORMANCE);
  
  const [margins, setMargins] = useState({
    takeoffDist: 0,
    landingDist: 0,
    safetyMultiplier: 1.5,
    gasMarginMinutes: 30,
    alternateAirport: null,
    alternateSearchQuery: ''
  });

  const [isMarginManual, setIsMarginManual] = useState(false);
  const [altSearchResults, setAltSearchResults] = useState([]);

  const [weather, setWeather] = useState({ reports: [] });
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState('');
  const [notamsReviewed, setNotamsReviewed] = useState(false);

  // NOTAM State
  const [notams, setNotams] = useState([]);
  const [notamsLoading, setNotamsLoading] = useState(false);
  const [notamsError, setNotamsError] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('ALL');

  const departureAirport = useMemo(() => findAirport(missionPlan.waypoints?.[0] || missionPlan.legs?.[0]?.start), [missionPlan]);
  const destinationAirport = useMemo(() => findAirport(missionPlan.waypoints.at(-1)), [missionPlan]);

  const relevantAirports = useMemo(() => {
    return [
      { role: 'Departure', apt: departureAirport },
      { role: 'Arrival', apt: destinationAirport },
      { role: 'Alternate', apt: margins.alternateAirport }
    ].filter(item => item.apt !== null);
  }, [departureAirport, destinationAirport, margins.alternateAirport]);

  const activeGasMargin = useMemo(() => {
    if (isMarginManual) return toNumber(margins.gasMarginMinutes);
    const startTime = new Date(etd);
    const totalFlightHours = missionPlan.legs.reduce((acc, leg) => acc + (leg.distNM / (performance.cruiseKt || 100)), 0);
    const endTime = new Date(startTime.getTime() + totalFlightHours * 3600000);
    return (isDaytime(startTime) && isDaytime(endTime)) ? 30 : 45;
  }, [etd, missionPlan.legs, performance.cruiseKt, isMarginManual, margins.gasMarginMinutes]);

  const fuelPlan = useMemo(() => {
    const rows = missionPlan.legs.map((leg, index) => {
      const selectedAltitude = toNumber(leg.selectedMslFeet);

      let previousAltitude;
      if (index === 0) {
        const originAirport = findAirport(leg.start);
        previousAltitude = originAirport ? toNumber(originAirport.elevationFeet) : 0;
      } else {
        previousAltitude = toNumber(missionPlan.legs[index - 1].selectedMslFeet);
      }

      let nextAltitude;
      if (index === missionPlan.legs.length - 1) {
        const destAirport = findAirport(leg.end);
        nextAltitude = destAirport ? toNumber(destAirport.elevationFeet) : 0;
      } else {
        nextAltitude = toNumber(missionPlan.legs[index + 1].selectedMslFeet);
      }

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
        climbFeet, 
        descentFeet, 
        cruiseDistance, 
        climb: { h: climbHours, g: climbGal },
        cruise: { h: cruiseHours, g: cruiseGal },
        descent: { h: descentHours, g: descentGal },
        hours: totalHours, 
        gallons: totalGallons 
      };
    });

    const baseHours = rows.reduce((total, leg) => total + leg.hours, 0);
    const baseGallons = rows.reduce((total, leg) => total + leg.gallons, 0);
    const totalDist = rows.reduce((total, leg) => total + leg.distNM, 0);
    const marginGallons = (activeGasMargin / 60) * toNumber(performance.cruiseGph);

    return { rows, totalHours: baseHours, totalGallons: baseGallons + marginGallons, totalDist, marginGallons };
  }, [missionPlan.legs, performance, activeGasMargin]);

  const fetchNotamsForLegs = useCallback(async () => {
    if (!missionPlan.legs || missionPlan.legs.length === 0) return;

    setNotamsLoading(true);
    setNotamsError('');

    try {
      // Gather all leg fetches
      const legPromises = missionPlan.legs.map((leg) => {
        const originCode = leg.start?.icao || leg.start?.id || 'UNKNOWN';
        const destCode = leg.end?.icao || leg.end?.id || 'UNKNOWN';

        return fetch(NOTAM_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            origin: originCode,
            destination: destCode,
            radius: 20
          })
        })
          .then(res => res.ok ? res.json() : Promise.reject(`HTTP ${res.status}`))
          .then(data => data.notams || [])
          .catch(err => {
            console.warn(`Failed fetching NOTAMs for leg ${originCode}->${destCode}:`, err);
            return [];
          });
      });

      const results = await Promise.all(legPromises);
      const flatNotams = results.flat();

      // Deduplicate by ID and Text
      const seen = new Set();
      const uniqueNotams = [];

      for (const item of flatNotams) {
        const key = `${item.id || ''}_${item.text || ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          const meta = categorizeNotam(item);
          uniqueNotams.push({ ...item, ...meta });
        }
      }

      setNotams(uniqueNotams);
    } catch {
      setNotamsError('Error fetching NOTAMs from server endpoint.');
    } finally {
      setNotamsLoading(false);
    }
  }, [missionPlan.legs]);

  useEffect(() => {
    fetchNotamsForLegs();
  }, [fetchNotamsForLegs]);

  const categoriesList = useMemo(() => {
    const cats = new Set(notams.map(n => n.category));
    return ['ALL', ...Array.from(cats)];
  }, [notams]);

  const filteredNotams = useMemo(() => {
    if (selectedCategory === 'ALL') return notams;
    return notams.filter(n => n.category === selectedCategory);
  }, [notams, selectedCategory]);

  const runwaySafety = useMemo(() => {
    const checks = [];
    const multiplier = toNumber(margins.safetyMultiplier);
    const tDistReq = toNumber(margins.takeoffDist) * multiplier;
    const lDistReq = toNumber(margins.landingDist) * multiplier;

    const checkRunway = (airport, type, reqDist) => {
      if (!airport || !airport.lengthFeet) return;
      const isSufficient = airport.lengthFeet >= reqDist;
      checks.push({
        name: airport.icao || airport.id,
        type,
        status: isSufficient ? '✅ Sufficient' : '❌ Insufficient',
        isError: !isSufficient
      });
    };

    checkRunway(departureAirport, 'Origin (Takeoff)', tDistReq);
    checkRunway(destinationAirport, 'Destination (Takeoff)', tDistReq);
    checkRunway(destinationAirport, 'Destination (Landing)', lDistReq);

    if (margins.alternateAirport) {
      checkRunway(margins.alternateAirport, 'Alternate (Takeoff)', tDistReq);
      checkRunway(margins.alternateAirport, 'Alternate (Landing)', lDistReq);
    }

    return checks;
  }, [margins.safetyMultiplier, margins.takeoffDist, margins.landingDist, departureAirport, destinationAirport, margins.alternateAirport]);

  const updatePerformance = (field, value) => setPerformance((prev) => ({ ...prev, [field]: value }));

  const updateMargin = (field, value) => {
    setMargins((prev) => ({ ...prev, [field]: value }));
    if (field === 'gasMarginMinutes') setIsMarginManual(true);
  };

  const handleAlternateSearch = (val) => {
    setMargins(prev => ({ ...prev, alternateSearchQuery: val }));
    if (val.length < 2) {
      setAltSearchResults([]);
      return;
    }
    const q = val.toLowerCase();
    const matches = faaAirports
      .filter(a => a.icao?.toLowerCase().includes(q) || a.name?.toLowerCase().includes(q))
      .slice(0, 5)
      .map(a => ({ id: a.icao || a.id, name: a.name, icao: a.icao, lengthFeet: a.lengthFeet, surface: a.surface, elevationFeet: a.elevationFeet }));
    setAltSearchResults(matches);
  };

  const selectAlternate = (apt) => {
    setMargins(prev => ({ ...prev, alternateAirport: apt, alternateSearchQuery: apt.name }));
    setAltSearchResults([]);
  };

  const loadWeather = async () => {
    const icaos = relevantAirports.map(r => r.apt?.icao || r.apt?.id).filter(Boolean);
    if (icaos.length === 0) return;

    setWeatherLoading(true);
    setWeatherError('');

    try {
      const ids = encodeURIComponent([...new Set(icaos)].join(','));
      const [metarRes, tafRes, mosRes] = await Promise.all([
        fetch(`/aviationweather/metar?ids=${ids}&format=json`),
        fetch(`/aviationweather/taf?ids=${ids}&format=json`).catch(() => ({ ok: false })),
        fetch(`/aviationweather/mos?ids=${ids}&format=json`).catch(() => ({ ok: false }))
      ]);

      const metars = metarRes.ok ? await metarRes.json() : [];
      const tafs = tafRes.ok ? await tafRes.json() : [];
      const mos = mosRes.ok ? await mosRes.json() : [];

      const reports = relevantAirports.map(({ role, apt }) => {
        const id = (apt?.icao || apt?.id || '').toUpperCase();
        const rawM = (Array.isArray(metars) ? metars : []).find(m => m.icaoId?.toUpperCase() === id)?.rawOb;
        const rawT = (Array.isArray(tafs) ? tafs : []).find(t => t.icaoId?.toUpperCase() === id)?.rawTAF;
        const rawMo = (Array.isArray(mos) ? mos : []).find(m => m.icaoId?.toUpperCase() === id)?.rawMOS;

        const blended = buildBlendedWeather(apt, rawM, rawT, rawMo, etd);
        return { role, apt, ...blended };
      });

      setWeather({ reports });
    } catch {
      setWeatherError('Failed to fetch weather telemetry.');
    } finally {
      setWeatherLoading(false);
    }
  };

  const getCategoryClass = (cat) => {
    switch (cat) {
      case 'VFR': return 'cat-badge-vfr';
      case 'MVFR': return 'cat-badge-mvfr';
      case 'IFR': return 'cat-badge-ifr';
      case 'LIFR': return 'cat-badge-lifr';
      default: return '';
    }
  };

  return (
    <div className="nwkraft-page">
      <aside className="nwkraft-sidebar">
        <h2 className="brand">RampCamp</h2>
        <button type="button" className="btn-back" onClick={onBack}>← Back</button>

        <label className="briefing-label">
          ETD (Local)
          <input type="datetime-local" value={etd} onChange={(e) => setEtd(e.target.value)} />
        </label>

        <section className="briefing-section">
          <h3 className="sidebar-h3">Aircraft Performance</h3>
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
          <h3 className="sidebar-h3">Options</h3>
          <div className="performance-grid">
            {[
              ['takeoffDist', 'Takeoff Distance (ft)'],
              ['landingDist', 'Landing Distance (ft)'],
              ['safetyMultiplier', 'FICON Multiplier'],
              ['gasMarginMinutes', 'Gas Margin (min)']
            ].map(([field, label]) => (
              <label key={field} className="briefing-label">{label}
                <input 
                  type="number" 
                  step={field === 'safetyMultiplier' ? '0.1' : '1.5'} 
                  value={isMarginManual && field === 'gasMarginMinutes' ? margins.gasMarginMinutes : (field === 'gasMarginMinutes' ? activeGasMargin : margins[field])} 
                  onChange={(e) => updateMargin(field, e.target.value)} 
                />
              </label>
            ))}
          </div>

          <div className="briefing-label" style={{ marginTop: '12px' }}>
            Alternate Airport
            <div className="search-container-wrapper">
              <input 
                className="search-input"
                type="text" 
                placeholder="Search ICAO/Name..."
                value={margins.alternateSearchQuery}
                onChange={(e) => handleAlternateSearch(e.target.value)}
              />
              {altSearchResults.length > 0 && (
                <div className="search-dropdown-container">
                  {altSearchResults.map(res => (
                    <div key={res.id} className="search-result-item" onClick={() => selectAlternate(res)}>
                      {res.icao || res.id} - {res.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {margins.alternateAirport && (
              <button 
                className="btn-remove-sm" 
                style={{ fontSize: '10px', marginTop: '4px' }}
                onClick={() => setMargins(p => ({ ...p, alternateAirport: null, alternateSearchQuery: '' }))}
              >
                Clear Alternate
              </button>
            )}
          </div>
        </section>

        <section className="briefing-section">
          <button type="button" className="btn-plan-sm" onClick={loadWeather} disabled={weatherLoading}>
            {weatherLoading ? 'Updating Weather...' : 'Refresh Weather'}
          </button>
        </section>
      </aside>

      <main className="nwkraft-content">
        <header>
          <h1>NWKRAFT Mission Briefing</h1>
          <p>ETD Target UTC: {new Date(etd).toISOString().replace('.000', '')} | NOTAM Review: {notamsReviewed ? '✅' : '❌'}</p>
        </header>

        <section className="briefing-section notam-section">
          <div className="notam-header-controls">
            <h3 className="section-h3" style={{ margin: 0 }}>Route NOTAMs ({filteredNotams.length})</h3>
            
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <select 
                className="notam-category-select"
                value={selectedCategory} 
                onChange={(e) => setSelectedCategory(e.target.value)}
              >
                {categoriesList.map(cat => (
                  <option key={cat} value={cat}>{cat === 'ALL' ? 'All Categories' : cat}</option>
                ))}
              </select>

              <button className="btn-refresh-sm" onClick={fetchNotamsForLegs} disabled={notamsLoading}>
                {notamsLoading ? 'Fetching...' : 'Reload NOTAMs'}
              </button>
            </div>
          </div>

          {notamsError && <p className="briefing-error">{notamsError}</p>}

          <div className="notam-scroll-container">
            {notamsLoading ? (
              <p className="empty-msg">Querying route corridors for active NOTAMs...</p>
            ) : filteredNotams.length === 0 ? (
              <p className="empty-msg">No NOTAMs found for the selected category.</p>
            ) : (
              filteredNotams.map((n, idx) => (
                <div key={idx} className={`notam-card notam-${n.level}`}>
                  <div className="notam-card-header">
                    <div>
                      <span className="notam-id">{n.id}</span>
                      <span className="notam-facility">[{n.facility}]</span>
                    </div>
                    <span className={`notam-badge badge-${n.badge}`}>{n.category}</span>
                  </div>
                  <p className="notam-text">{n.text}</p>
                  {(n.effectiveStart || n.effectiveEnd) && (
                    <div className="notam-dates">
                      Effective: {n.effectiveStart ? new Date(n.effectiveStart).toUTCString() : 'Immediate'} 
                      {n.effectiveEnd ? ` ➔ ${new Date(n.effectiveEnd).toUTCString()}` : ' ➔ Permanent / UFN'}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="notam-box" style={{ marginTop: '10px' }}>
            <label className="notam-check">
              <input type="checkbox" checked={notamsReviewed} onChange={(e) => setNotamsReviewed(e.target.checked)} />
              I have reviewed the applicable NOTAMs for this flight.
            </label>
          </div>
        </section>

        <section className="briefing-section">
          <h3 className="section-h3">Terminal Weather Breakdown</h3>
          {weatherError && <p className="briefing-error">{weatherError}</p>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px' }}>
            {weather.reports.length > 0 ? (
              weather.reports.map((m, i) => (
                <div key={i} style={{ background: '#1e293b', padding: '16px', borderRadius: '8px', border: '1px solid #334155' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <strong>{m.role}: {m.icao}</strong>
                    <span className={`cat-badge ${getCategoryClass(m.flightCategory.category)}`}>
                      {m.flightCategory.category}
                    </span>
                  </div>

                  {m.isStale && (
                    <div style={{ background: '#78350f', color: '#fef08a', padding: '4px 8px', borderRadius: '4px', fontSize: '11px', marginBottom: '8px' }}>
                      ⚠️ METAR &gt;30m past observation time.
                    </div>
                  )}

                  <div style={{ fontSize: '13px', display: 'grid', gap: '6px' }}>
                    <p><strong>Reason:</strong> {m.flightCategory.reason}</p>
                    <p>🌬️ <strong>Wind:</strong> {m.windStr} <span className="source-tag">[{m.sources.wind}]</span></p>
                    <p>📐 <strong>Crosswind Range:</strong> {m.minCrosswind} kt (Min) — {m.maxCrosswind} kt (Max)</p>
                    <p>👁️ <strong>Visibility:</strong> {m.visibility} SM <span className="source-tag">[{m.sources.visibility}]</span></p>
                    <p>☁️ <strong>Ceiling:</strong> {m.ceiling ? `${m.ceiling} ft` : 'CLR/Unlimited'} <span className="source-tag">[{m.sources.ceiling}]</span></p>
                    <p>🌡️ <strong>Temp / Dewpoint:</strong> {m.temp}°C / {m.dewpoint}°C <span className="source-tag">[METAR]</span></p>
                    <p>🎚️ <strong>Altimeter:</strong> {m.altimeter.toFixed(2)} inHg <span className="source-tag">[METAR]</span></p>

                    <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid #334155', display: 'flex', justifyContent: 'space-between' }}>
                      <span>P-Alt: <strong>{m.pressureAlt.toLocaleString()}'</strong></span>
                      <span>D-Alt: <strong>{m.densityAlt.toLocaleString()}'</strong></span>
                    </div>
                  </div>

                  <div style={{ marginTop: '10px', fontSize: '11px', background: '#0f172a', padding: '6px', borderRadius: '4px', overflowX: 'auto' }}>
                    <code>METAR: {m.rawMetar}</code>
                    {m.rawForecast && <code style={{ display: 'block', marginTop: '4px', color: '#38bdf8' }}>{m.rawForecast}</code>}
                  </div>
                </div>
              ))
            ) : (
              <p className="empty-msg">Click "Refresh Weather" to load combined weather reports.</p>
            )}
          </div>
        </section>

        <section className="briefing-section">
          <h3 className="section-h3">Runway Safety</h3>
          <div className="runway-safety-grid" style={{ display: 'grid', gap: '8px' }}>
            {runwaySafety.length > 0 ? runwaySafety.map((check, i) => (
              <div key={i} style={{ 
                padding: '8px', 
                borderRadius: '4px', 
                background: check.isError ? '#450a0a' : '#064e3b',
                border: `1px solid ${check.isError ? '#ef4444' : '#22c55e'}`,
                fontSize: '14px'
              }}>
                <strong>{check.name} [{check.type}]:</strong> {check.status}
              </div>
            )) : <p className="empty-msg">Enter takeoff/landing distances to validate runway lengths.</p>}
          </div>
        </section>

        <section className="briefing-section">
          <h3 className="section-h3">Required Fuel Projection</h3>
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
                  <th>Climb/Descent</th>
                  <th>Time</th>
                  <th>Fuel (Climb / Cruise / Descent)</th>
                </tr>
              </thead>
              <tbody>
                {fuelPlan.rows.map((leg, index) => (
                  <tr key={leg.id}>
                    <td>{index + 1}. {leg.start.name} ➡️ {leg.end.name} ({leg.end.icao})</td>
                    <td>{Number(leg.selectedMslFeet).toLocaleString()} ft</td>
                    <td>{leg.distNM.toFixed(1)} NM</td>
                    <td className="small-text">+{leg.climbFeet.toLocaleString()}<br/>−{leg.descentFeet.toLocaleString()}</td>
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
      </main>
    </div>
  );
}