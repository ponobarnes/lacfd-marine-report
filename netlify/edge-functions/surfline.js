// ============================================================
// LACFD Lifeguard — Surfline Edge Function Proxy
//
// Netlify Edge Function (runs on Deno / Cloudflare edge network).
// By running ON Cloudflare's infrastructure, requests to
// Surfline's Cloudflare-protected API may bypass IP blocking.
//
// Deploy to: netlify/edge-functions/surfline.js
// Configured in netlify.toml at path: /api/surfline
//
// NOTE: Edge functions use ES Modules + Deno globals.
//       No require(), no exports.handler.
// ============================================================

export default async function handler(request) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: CORS });
  }

  const url    = new URL(request.url);
  const spotId = url.searchParams.get('spotId');

  if (!spotId) {
    return new Response(
      JSON.stringify({ error: 'Missing spotId parameter' }),
      { status: 400, headers: CORS }
    );
  }

  // Strict 24-char hex format — prevent injection
  if (!/^[a-f0-9]{24}$/i.test(spotId)) {
    return new Response(
      JSON.stringify({ error: 'Invalid spotId format' }),
      { status: 400, headers: CORS }
    );
  }

  // Full browser-like headers — same as a Chrome user on surfline.com
  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
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

  const BASE  = 'https://services.surfline.com/kbyg/spots/forecasts';
  const UNITS = 'units%5BswellHeight%5D=FT&units%5BwaveHeight%5D=FT&units%5BwindSpeed%5D=MPH';

  try {
    // Fetch all four data types in parallel
    const [waveResp, ratingResp, condResp, windResp] = await Promise.all([
      fetch(`${BASE}/wave?spotId=${spotId}&days=1&intervalHours=1&cacheEnabled=true&${UNITS}`,    { headers: browserHeaders }),
      fetch(`${BASE}/rating?spotId=${spotId}&days=1&intervalHours=1&cacheEnabled=true`,           { headers: browserHeaders }),
      fetch(`${BASE}/conditions?spotId=${spotId}&days=2&cacheEnabled=true`,                       { headers: browserHeaders }),
      fetch(`${BASE}/wind?spotId=${spotId}&days=1&intervalHours=1&cacheEnabled=true&${UNITS}`,    { headers: browserHeaders }),
    ]);

    // If the primary wave endpoint is blocked, report it clearly
    if (!waveResp.ok) {
      const bodyText = await waveResp.text().catch(() => '');
      const isBlocked = waveResp.status === 403 || waveResp.status === 429 || waveResp.status === 401;
      return new Response(
        JSON.stringify({
          error: isBlocked ? 'surfline_blocked' : 'surfline_api_error',
          status: waveResp.status,
          detail: `Wave endpoint returned HTTP ${waveResp.status}`,
          body: bodyText.slice(0, 200),
        }),
        { status: 502, headers: CORS }
      );
    }

    const [waveData, ratingData, condData, windData] = await Promise.all([
      waveResp.json(),
      ratingResp.ok  ? ratingResp.json()  : Promise.resolve(null),
      condResp.ok    ? condResp.json()    : Promise.resolve(null),
      windResp.ok    ? windResp.json()    : Promise.resolve(null),
    ]);

    return new Response(
      JSON.stringify({ waveData, ratingData, condData, windData }),
      {
        status: 200,
        headers: {
          ...CORS,
          'Cache-Control': 'public, max-age=900', // 15-min cache on edge
        },
      }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'edge_fetch_failed', detail: err.message }),
      { status: 502, headers: CORS }
    );
  }
}
