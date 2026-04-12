// ============================================================
// LACFD LIFEGUARD — WaveCast SoCal Forecast Proxy
// Netlify serverless function — fetches the WaveCast SoCal
// forecast page (published Sun/Tue/Thu) and returns the
// parsed report text to the marine weather dashboard.
//
// Deploy to: netlify/functions/wavecast.js
// Available at: /.netlify/functions/wavecast
// ============================================================

const https = require('https');
const http = require('http');

// Helper: fetch a URL with redirect support
function fetchPage(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));

    const lib = url.startsWith('https') ? https : http;

    lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Referer': 'https://wavecast.com/',
      }
    }, (res) => {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        const nextUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchPage(nextUrl, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, status: res.statusCode, url }));
    }).on('error', reject);
  });
}

// Extract page title
function extractTitle(html) {
  const match =
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return 'WaveCast SoCal Forecast';
  return match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().split('|')[0].trim();
}

// Extract the main forecast text from the page HTML
function extractContent(html) {
  // Remove noisy sections
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, '');

  // Try to isolate the main article/post content
  const contentPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class="[^"]*entry[- ]content[^"]*"[^>]*>([\s\S]*?)<\/div\s*>/i,
    /<div[^>]*class="[^"]*post[- ]content[^"]*"[^>]*>([\s\S]*?)<\/div\s*>/i,
    /<div[^>]*class="[^"]*forecast[^"]*"[^>]*>([\s\S]*?)<\/div\s*>/i,
    /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div\s*>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
  ];

  let contentHtml = null;
  for (const pattern of contentPatterns) {
    const match = cleaned.match(pattern);
    if (match && match[1] && match[1].length > 300) {
      contentHtml = match[1];
      break;
    }
  }

  if (!contentHtml) contentHtml = cleaned;

  // Convert block-level HTML to readable plain text with structure
  let text = contentHtml
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n■ $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n▸ $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n$1\n')
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n$1\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n  • $1')
    .replace(/<hr[^>]*>/gi, '\n────────────────────\n')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '$1')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8212;/g, '—')
    .replace(/&#8211;/g, '–')
    .replace(/&#8216;|&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#[0-9]+;/g, ' ')
    // Clean whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  return text;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    // Cache for 1 hour — WaveCast only publishes Sun/Tue/Thu so no need to hammer it
    'Cache-Control': 'public, max-age=3600',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { html, status } = await fetchPage('https://wavecast.com/socal/');

    if (status !== 200) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `WaveCast returned HTTP ${status}` })
      };
    }

    const title = extractTitle(html);
    const text = extractContent(html);

    // Trim to a reasonable size but keep full forecast content
    const trimmed = text.length > 10000
      ? text.substring(0, 10000) + '\n\n[See full report at wavecast.com/socal/]'
      : text;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        title,
        text: trimmed,
        url: 'https://wavecast.com/socal/',
        fetched: new Date().toISOString(),
      })
    };

  } catch (e) {
    console.error('WaveCast proxy error:', e.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'WaveCast fetch failed', detail: e.message })
    };
  }
};
