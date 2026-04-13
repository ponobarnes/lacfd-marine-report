// ============================================================
// LACFD Lifeguard — Surfline API Proxy (v2)
// Netlify serverless function — Node 18+, uses global fetch.
// Fetches wave, rating, conditions, and wind data from
// Surfline's internal API with full browser-like headers to
// pass Cloudflare bot detection.
//
// Deploy to: netlify/functions/surfline.js
// Endpoint:  /.netlify/functions/surfline?spotId=XXX
// ============================================================

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=900', // 15-min cache
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const spotId = event.queryStringParameters?.spotId;

  if (!spotId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing spotId' }) };
  }

  // Strict 24-char hex format — prevent injection
  if (!/^[a-f0-9]{24}$/i.test(spotId)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid spotId format' }) };
  }

  // Full Chrome-like headers — Surfline/Cloudflare checks these
  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin': 'https://www.surfline.com',
    'Referer': `https://www.surfline.com/surf-report/spot/${spotId}`,
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  const BASE = 'https://services.surfline.com/kbyg/spots/forecasts';
  // Note: encode brackets for query string safety
  const UNITS = 'units%5BswellHeight%5D=FT&units%5BwaveHeight%5D=FT&units%5BwindSpeed%5D=MPH';

  const safeFetch = async (url) => {
    const res = await fetch(url, { headers: browserHeaders });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body });
    }
    return res.json();
  };

  try {
    const [waveData, ratingData, condData, windData] = await Promise.all([
      safeFetch(`${BASE}/wave?spotId=${spotId}&days=1&intervalHours=1&cacheEnabled=true&${UNITS}`),
      safeFetch(`${BASE}/rating?spotId=${spotId}&days=1&intervalHours=1&cacheEnabled=true`).catch(() => null),
      safeFetch(`${BASE}/conditions?spotId=${spotId}&days=2&cacheEnabled=true`).catch(() => null),
      safeFetch(`${BASE}/wind?spotId=${spotId}&days=1&intervalHours=1&cacheEnabled=true&${UNITS}`).catch(() => null),
    ]);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ waveData, ratingData, condData, windData }),
    };

  } catch (e) {
    const isBlocked = e.status === 403 || e.status === 429 || e.status === 401;
    console.error(`Surfline proxy error [spotId=${spotId}] HTTP ${e.status || '?'}:`, e.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({
        error: isBlocked ? 'surfline_blocked' : 'surfline_fetch_failed',
        status: e.status || 0,
        detail: e.message,
      }),
    };
  }
};
