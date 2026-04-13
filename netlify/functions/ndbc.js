// ============================================================
// LACFD Lifeguard — NOAA NDBC Buoy Proxy
// Netlify serverless function — fetches real-time wave buoy
// observations from NOAA's National Data Buoy Center for
// nearshore stations in the LA County operational area.
//
// Deploy to: netlify/functions/ndbc.js
// Endpoint:  /.netlify/functions/ndbc
// ============================================================

// NDBC stations covering LA County coast and offshore waters
const STATIONS = [
  { id: '46221', name: 'Santa Monica Basin',   area: 'Inner SM Bay',   lat: 33.859, lon: -118.633, depth: 'nearshore' },
  { id: '46222', name: 'San Pedro Channel',    area: 'South Bay',      lat: 33.621, lon: -118.317, depth: 'nearshore' },
  { id: '46253', name: 'San Pedro Ch. North',  area: 'San Pedro',      lat: 33.769, lon: -118.238, depth: 'nearshore' },
  { id: '46025', name: 'Santa Monica Bay',     area: 'Outer SM Bay',   lat: 33.749, lon: -119.053, depth: 'offshore'  },
  { id: '46086', name: 'San Clemente Basin',   area: 'Offshore S.',    lat: 32.491, lon: -118.040, depth: 'offshore'  },
];

// Parse a NOAA NDBC realtime2 text file.
// Format: two # header lines then data rows, newest first.
// Columns: YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
function parseNDBCText(text) {
  const lines = text.trim().split('\n');
  // Skip header lines (start with #)
  const dataLines = lines.filter(l => l.trim() && !l.startsWith('#'));
  if (!dataLines.length) return null;

  // Most recent observation is first data line
  const cols = dataLines[0].trim().split(/\s+/);
  if (cols.length < 15) return null;

  const num = (v) => (v === 'MM' || v === null) ? null : parseFloat(v);

  const yr   = parseInt(cols[0]);
  const mo   = parseInt(cols[1]);
  const dy   = parseInt(cols[2]);
  const hr   = parseInt(cols[3]);
  const mn   = parseInt(cols[4]);

  // Build observation timestamp (UTC)
  const obsTime = new Date(Date.UTC(yr, mo - 1, dy, hr, mn));

  return {
    time:            obsTime.toISOString(),
    windDir:         num(cols[5]),   // degrees true
    windSpeedMs:     num(cols[6]),   // m/s
    gustMs:          num(cols[7]),   // m/s
    waveHeightM:     num(cols[8]),   // significant wave height, meters
    dominantPeriod:  num(cols[9]),   // seconds
    avgPeriod:       num(cols[10]),  // seconds
    waveDir:         num(cols[11]),  // mean wave direction, degrees
    pressureHpa:     num(cols[12]),  // hPa
    airTempC:        num(cols[13]),  // °C
    waterTempC:      num(cols[14]),  // °C
  };
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=600', // 10-min cache — buoys update every 30 min
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const results = await Promise.all(
      STATIONS.map(async (s) => {
        try {
          const res = await fetch(
            `https://www.ndbc.noaa.gov/data/realtime2/${s.id}.txt`,
            { headers: { 'User-Agent': 'LACFD-Marine-Report/2.0 (govt operational use; contact pono.barnes@gmail.com)' } }
          );
          if (!res.ok) return { ...s, error: `NDBC returned HTTP ${res.status}` };
          const text = await res.text();
          const obs  = parseNDBCText(text);
          if (!obs) return { ...s, error: 'parse_failed' };
          return { ...s, obs };
        } catch (e) {
          return { ...s, error: e.message };
        }
      })
    );

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ stations: results, fetched: new Date().toISOString() }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
