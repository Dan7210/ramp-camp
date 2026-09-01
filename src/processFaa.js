import fs from 'fs';
import csv from 'csv-parser';

const AIRPORTS_CSV = './airports.csv';
const RUNWAYS_CSV = './runways.csv';
const OUTPUT_JSON = './src/airports.json';

// Detect tab or comma delimiters automatically based on header line
const getDelimiter = (filePath) => {
  const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
  return firstLine.includes('\t') ? '\t' : ',';
};

const processData = async () => {
  const runwaysBySite = {};

  // Step 1: Read and aggregate runways by Site Id
  console.log('Processing runways.csv...');
  await new Promise((resolve, reject) => {
    fs.createReadStream(RUNWAYS_CSV)
      .pipe(csv({ separator: getDelimiter(RUNWAYS_CSV) }))
      .on('data', (row) => {
        const siteId = (row['Site Id'] || '').trim();
        const length = parseInt(row['Length'] || '0', 10);
        const surface = (row['Surface Type Condition'] || 'Unknown').trim();
        
        // Extract runway orientation (e.g. "09/27" using Base and Reciprocal IDs, or fallback to Runway Id)
        const baseEnd = (row['Base End Id'] || '').trim();
        const reciprocalEnd = (row['Reciprocal End Id'] || '').trim();
        let orientation = (row['Runway Id'] || '').trim();
        
        if (baseEnd && reciprocalEnd) {
          orientation = `${baseEnd}/${reciprocalEnd}`;
        }

        if (siteId) {
          if (!runwaysBySite[siteId]) {
            runwaysBySite[siteId] = { 
              maxRunwayLength: 0, 
              primarySurface: 'Unknown',
              orientations: [] 
            };
          }

          // Collect all unique runway orientations for the airport
          if (orientation && !runwaysBySite[siteId].orientations.includes(orientation)) {
            runwaysBySite[siteId].orientations.push(orientation);
          }

          // Track longest runway and its associated surface
          if (length > runwaysBySite[siteId].maxRunwayLength) {
            runwaysBySite[siteId].maxRunwayLength = length;
            runwaysBySite[siteId].primarySurface = surface;
          }
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  const airports = [];

  // Step 2: Read airports.csv and join with runway aggregated data
  console.log('Processing airports.csv...');
  await new Promise((resolve, reject) => {
    fs.createReadStream(AIRPORTS_CSV)
      .pipe(csv({ separator: getDelimiter(AIRPORTS_CSV) }))
      .on('data', (row) => {
        const facilityType = (row['Facility Type'] || '').trim().toUpperCase();
        const use = (row['Use'] || '').trim().toUpperCase();
        const lat = parseFloat(row['ARP Latitude DD']);
        const lon = parseFloat(row['ARP Longitude DD']);
        const elevation = parseFloat(row['Elevation']);

        if (facilityType === 'AIRPORT' && !isNaN(lat) && !isNaN(lon)) {
          const siteId = (row['Site Id'] || '').trim();
          const locId = (row['Loc Id'] || '').trim();
          const icaoId = (row['ICAO Id'] || '').trim();
          
          const runwayData = runwaysBySite[siteId] || { 
            maxRunwayLength: 0, 
            primarySurface: 'Unknown',
            orientations: []
          };

          airports.push({
            id: locId,
            icao: icaoId !== '' ? icaoId : locId,
            name: (row['Name'] || 'Unnamed Airport').trim(),
            lat: lat,
            lon: lon,
            elevationFeet: !isNaN(elevation) ? elevation : null,
            isPublic: use === 'PU',
            access: use === 'PU' ? 'Public' : 'Private',
            surface: runwayData.primarySurface,
            lengthFeet: runwayData.maxRunwayLength,
            runwayOrientations: runwayData.orientations
          });
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(airports));
  console.log(`Successfully written ${airports.length} enriched airports to ${OUTPUT_JSON}`);
};

processData().catch(console.error);