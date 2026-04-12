// ============================================================
// LACFD LIFEGUARD — Surfline API Proxy
// Netlify serverless function — runs server-side so CORS
// doesn't apply. Fetches wave, rating, conditions, and wind
// data from Surfline's internal API and returns it to the
// report page.
//
// Deploy this file to: netlify/functions/surfline.js
// It will be available at: /.netlify/functions/surfline?spotId=XXX
// ============================================================

const https = require('https');

// Helper: fetch a URL and return parsed JSON
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        // Surfline's API expects a browser-like User-Agent
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Referer': 'https://www.surfline.com/',
        'Origin': 'https://www.surfline.com',
        'Accept': 'application/json',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=900', // cache 15 min
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const spotId = event.queryStringParameters?.spotId;
  if (!spotId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing spotId parameter' })
    };
  }

  // Validate spotId format to prevent injection
  if (!/^[a-f0-9]{24}$/i.test(spotId)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid spotId format' })
    };
  }

  const BASE = 'https://services.surfline.com/kbyg/spots/forecasts';
  const UNITS = 'units%5BswellHeight%5D=FT&units%5BwaveHeight%5D=FT&units%5BwindSpeed%5D=MPH';

  try {
    // Fetch all four data types in parallel
    const [waveData, ratingData, condData, windData] = await Promise.all([
      fetchJSON(`${BASE}/wave?spotId=${spotId}&days=1&intervalHours=1&cacheEnabled=true&${UNITS}`),
      fetchJSON(`${BASE}/rating?spotId=${spotId}&days=1&intervalHours=1&cacheEnabled=true`),
      fetchJSON(`${BASE}/conditions?spotId=${spotId}&days=2&cacheEnabled=true`),
      fetchJSON(`${BASE}/wind?spotId=${spotId}&days=1&intervalHours=1&cacheEnabled=true&${UNITS}`),
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ waveData, ratingData, condData, windData })
    };

  } catch(e) {
    console.error('Surfline proxy error for spot', spotId, ':', e.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Surfline fetch failed', detail: e.message })
    };
  }
};
