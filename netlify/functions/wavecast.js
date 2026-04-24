// ============================================================
// LACFD LIFEGUARD — WaveCast SoCal Forecast Proxy
// Fetches the WaveCast SoCal RSS feed (WordPress always puts real
// absolute image URLs in RSS — no JS lazy-loading to work around).
// Falls back to scraping the HTML page if the feed fails.
//
// Deploy to: netlify/functions/wavecast.js
// Available at: /.netlify/functions/wavecast
// ============================================================

const https = require('https');
const http  = require('http');

// ── HTTP fetch with redirect support ─────────────────────────────────────
function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Referer': 'https://wavecast.com/',
      }
    }, res => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(next, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ body: data, status: res.statusCode }));
    }).on('error', reject);
  });
}

// ── Resolve relative URL ──────────────────────────────────────────────────
function resolveUrl(src, base) {
  if (!src) return null;
  src = src.trim();
  if (!src || src.startsWith('javascript:')) return null;
  try { return new URL(src, base).href; } catch(e) { return null; }
}

// ── Is this a real content image (not an icon/pixel/gravatar)? ────────────
function isContentImage(src) {
  if (!src || src.startsWith('data:')) return false;
  if (/wp-includes\/images/i.test(src)) return false;
  if (/gravatar\.com|\/emoji\//i.test(src)) return false;
  if (/\.(svg|ico|cur|bmp)(\?|$)/i.test(src)) return false;
  const fname = (src.split('/').pop() || '').split('?')[0];
  if (fname.length < 4) return false;
  return true;
}

// ── Parse the WordPress RSS/Atom feed ────────────────────────────────────
// RSS always contains real absolute image URLs — no JS lazy-loading.
function parseRSS(xml, base) {
  // Grab the first <item>
  const itemMatch = xml.match(/<item\b[^>]*>([\s\S]*?)<\/item>/i);
  if (!itemMatch) return null;
  const item = itemMatch[1];

  // Title
  const titleMatch = item.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'WaveCast SoCal Forecast';

  // Full content — WordPress puts it in <content:encoded> or <description>
  const contentMatch =
    item.match(/<content:encoded[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/i) ||
    item.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
  const rawContent = contentMatch ? contentMatch[1] : '';

  // Extract images from the RSS content HTML — these are always real URLs
  const images = [];
  const seen = new Set();
  const imgRe = /<img\b([^>]*?)(?:\/>|>)/gi;
  let m;
  while ((m = imgRe.exec(rawContent)) !== null) {
    const srcMatch = m[1].match(/src=["']([^"']+)["']/i);
    const src = srcMatch ? resolveUrl(srcMatch[1], base) : null;
    if (src && isContentImage(src) && !seen.has(src)) {
      seen.add(src);
      const altMatch = m[1].match(/alt=["']([^"']*)["']/i);
      images.push({ src, alt: altMatch ? altMatch[1].trim() : '' });
    }
  }

  // Also grab <enclosure> image tags
  const encRe = /<enclosure\b[^>]*type=["']image[^"']*["'][^>]*url=["']([^"']+)["'][^>]*\/?>/gi;
  while ((m = encRe.exec(item)) !== null) {
    const src = resolveUrl(m[1], base);
    if (src && isContentImage(src) && !seen.has(src)) {
      seen.add(src);
      images.push({ src, alt: '' });
    }
  }

  // Convert RSS content HTML to text, replacing images with tokens
  let html = rawContent;

  // Re-scan and token-ize images in order of appearance
  html = html.replace(/<img\b([^>]*?)(?:\/>|>)/gi, (match, attrs) => {
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    const src = srcMatch ? resolveUrl(srcMatch[1], base) : null;
    if (src && isContentImage(src)) {
      const altMatch = attrs.match(/alt=["']([^"']*)["']/i);
      const alt = (altMatch ? altMatch[1] : '').replace(/[|\n]/g, ' ').trim();
      return `\n[[IMG:${src}|${alt}]]\n`;
    }
    return '';
  });

  // Strip remaining HTML → plain text
  let text = html
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n■ $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n▸ $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n$1\n')
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n$1\n')
    .replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n  • $1')
    .replace(/<hr[^>]*>/gi, '\n────────────────────\n')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '$1')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#8212;/g, '—').replace(/&#8211;/g, '–')
    .replace(/&#8216;|&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#[0-9]+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  // Strip subscribe boilerplate
  for (const marker of ['Get notified when this report is updated.', 'Subscribe to be notified:']) {
    const idx = text.indexOf(marker);
    if (idx !== -1) { text = text.slice(idx + marker.length).trim(); break; }
  }
  text = text
    .replace(/Surf Charts for SoCal[^\[]*?Sunset Cliffs/gi, '')
    // Strip donation / fundraising lines
    .replace(/Why Donate\??/gi, '')
    .replace(/See donation progress report\.?/gi, '')
    .replace(/donation progress report\.?/gi, '')
    .replace(/\bDonate\b.*\n/gi, '')
    .replace(/\n{4,}/g, '\n\n\n').trim();

  return { title, text, images };
}

// ── Fallback: scrape the HTML page (text only, no images) ─────────────────
function scrapeHTML(html, base) {
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, '');

  const titleMatch = cleaned.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
                     cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g,'').trim().split('|')[0].trim()
    : 'WaveCast SoCal Forecast';

  const articleMatch = cleaned.match(/<article\b[^>]*>([\s\S]*)<\/article>/i);
  const contentHtml = (articleMatch && articleMatch[1].length > 300)
    ? articleMatch[1] : cleaned;

  let text = contentHtml
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n■ $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n▸ $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n$1\n')
    .replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n  • $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#8212;/g,'—').replace(/&#8211;/g,'–')
    .replace(/[ \t]+/g,' ').replace(/\n{4,}/g,'\n\n\n').trim();

  for (const marker of ['Get notified when this report is updated.', 'Subscribe to be notified:']) {
    const idx = text.indexOf(marker);
    if (idx !== -1) { text = text.slice(idx + marker.length).trim(); break; }
  }
  text = text
    .replace(/Why Donate\??/gi, '')
    .replace(/See donation progress report\.?/gi, '')
    .replace(/donation progress report\.?/gi, '')
    .replace(/\bDonate\b.*\n/gi, '')
    .replace(/\n{3,}/g, '\n\n').trim();

  return { title, text, images: [] };
}

// ── Handler ───────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const BASE = 'https://wavecast.com/socal/';

  try {
    // ── Try RSS feed first ────────────────────────────────────────────────
    let result = null;
    let source = 'rss';
    try {
      const { body: rssBody, status: rssStatus } = await fetchUrl('https://wavecast.com/socal/feed/');
      if (rssStatus === 200 && rssBody.includes('<rss') || rssBody.includes('<feed')) {
        result = parseRSS(rssBody, BASE);
      }
    } catch(e) {
      console.warn('RSS fetch failed:', e.message);
    }

    // ── Fall back to HTML page scrape ─────────────────────────────────────
    if (!result) {
      source = 'html';
      const { body: htmlBody, status } = await fetchUrl(BASE);
      if (status !== 200) {
        return { statusCode: 502, headers, body: JSON.stringify({ error: `WaveCast returned HTTP ${status}` }) };
      }
      result = scrapeHTML(htmlBody, BASE);
    }

    const { title, text, images } = result;

    // Count inline tokens for debug
    const tokenCount = (text.match(/\[\[IMG:/g) || []).length;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        title, text,
        source,
        url: BASE,
        fetched: new Date().toISOString(),
      })
    };

  } catch(e) {
    console.error('WaveCast proxy error:', e.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'WaveCast fetch failed', detail: e.message })
    };
  }
};
