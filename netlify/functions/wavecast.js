// ============================================================
// LACFD LIFEGUARD — WaveCast SoCal Forecast Proxy
// Netlify serverless function — fetches the WaveCast SoCal
// forecast page (published Sun/Tue/Thu) and returns the
// parsed report text + embedded images to the marine weather dashboard.
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
        // Use a desktop UA — some sites serve stripped mobile HTML without images
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Referer': 'https://wavecast.com/',
      }
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        const nextUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchPage(nextUrl, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, status: res.statusCode, finalUrl: url }));
    }).on('error', reject);
  });
}

// Resolve a relative URL to absolute
function resolveUrl(src, base) {
  if (!src) return null;
  src = src.trim();
  if (!src || src === '#' || src.startsWith('javascript:')) return null;
  try {
    return new URL(src, base).href;
  } catch(e) {
    return null;
  }
}

// Extract the best src from an <img> tag's attribute string.
// WordPress lazy-loading hides the real URL in data-src / data-lazy-src / srcset.
function extractImgSrc(attrs, base) {
  // Ordered priority: real src attrs first, then lazy-load fallbacks
  const attrNames = [
    'data-lazy-src', 'data-src', 'data-original', 'data-full-url',
    'data-large-file', 'data-medium-file',
    'src',
  ];

  for (const attr of attrNames) {
    const re = new RegExp(`${attr}=["']([^"']+)["']`, 'i');
    const m = attrs.match(re);
    if (m && m[1] && !m[1].startsWith('data:') && m[1].trim()) {
      return resolveUrl(m[1], base);
    }
  }

  // Also check srcset — take the last (largest) URL
  const srcsetMatch = attrs.match(/srcset=["']([^"']+)["']/i);
  if (srcsetMatch) {
    const parts = srcsetMatch[1].split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!parts[i].startsWith('data:')) {
        return resolveUrl(parts[i], base);
      }
    }
  }

  return null;
}

// Returns true for images that look like content charts, not icons/logos.
// Intentionally permissive — better to include a few extras than miss real charts.
function isContentImage(src) {
  if (!src) return false;
  if (src.startsWith('data:')) return false;
  // Skip WordPress core UI assets
  if (/wp-includes\/images/i.test(src)) return false;
  if (/\/emoji\//i.test(src)) return false;
  // Skip gravatar profile pictures
  if (/gravatar\.com/i.test(src)) return false;
  // Must be a raster image — accept jpg, png, gif, webp, and URLs with no extension
  // (CDN-served images sometimes have no extension in the path)
  const lower = src.toLowerCase();
  if (/\.(svg|ico|cur|bmp)(\?|$)/.test(lower)) return false;
  // Skip very short filenames — likely tracking pixels or spacers
  const fname = (src.split('/').pop() || '').split('?')[0];
  if (fname.length < 4) return false;
  return true;
}

// Extract page title
function extractTitle(html) {
  const match =
    html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return 'WaveCast SoCal Forecast';
  return match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().split('|')[0].trim();
}

// Scan ALL img tags across the full HTML and return deduplicated content images.
// This is the reliable fallback — it doesn't depend on content-area extraction.
function extractAllImages(html, base) {
  const seen = new Set();
  const images = [];

  const imgRe = /<img\b([^>]*?)(?:\/>|>)/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const src = extractImgSrc(m[1], base);
    if (src && isContentImage(src) && !seen.has(src)) {
      seen.add(src);
      const altMatch = m[1].match(/alt=["']([^"']*)["']/i);
      const alt = altMatch ? altMatch[1].trim() : '';
      images.push({ src, alt });
    }
  }

  return images;
}

// Extract the main forecast text, replacing inline images with [[IMG:url|alt]] tokens.
function extractContent(html, base) {
  // Remove noisy chrome
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, '');

  // Try to find the main post content block — try multiple selectors
  // Use a greedy inner match for divs so we don't stop at the first nested </div>
  let contentHtml = null;

  // Strategy 1: <article> tag (most reliable on WordPress)
  const articleMatch = cleaned.match(/<article\b[^>]*>([\s\S]*)<\/article>/i);
  if (articleMatch && articleMatch[1].length > 300) {
    contentHtml = articleMatch[1];
  }

  // Strategy 2: .entry-content or .post-content div — use greedy match
  if (!contentHtml) {
    const divMatch = cleaned.match(/<div[^>]*class="[^"]*(?:entry|post)[- ]content[^"]*"[^>]*>([\s\S]*)<\/div>/i);
    if (divMatch && divMatch[1].length > 300) {
      contentHtml = divMatch[1];
    }
  }

  // Strategy 3: <main> tag
  if (!contentHtml) {
    const mainMatch = cleaned.match(/<main\b[^>]*>([\s\S]*)<\/main>/i);
    if (mainMatch && mainMatch[1].length > 300) {
      contentHtml = mainMatch[1];
    }
  }

  // Fallback: use the whole cleaned HTML
  if (!contentHtml) contentHtml = cleaned;

  // ── Replace <img> tags with inline tokens BEFORE stripping HTML ──────────
  contentHtml = contentHtml.replace(/<img\b([^>]*?)(?:\/>|>)/gi, (match, attrs) => {
    const src = extractImgSrc(attrs, base);
    if (src && isContentImage(src)) {
      const altMatch = attrs.match(/alt=["']([^"']*)["']/i);
      const alt = (altMatch ? altMatch[1] : '').replace(/[|\n]/g, ' ').trim();
      return `\n[[IMG:${src}|${alt}]]\n`;
    }
    return '';
  });

  // Convert HTML to structured plain text
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
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  // Strip WaveCast subscribe/nav boilerplate before the forecast body
  const cutMarkers = [
    'Get notified when this report is updated.',
    'Get notified when this report is updated',
    'Subscribe to be notified:',
  ];
  for (const marker of cutMarkers) {
    const idx = text.indexOf(marker);
    if (idx !== -1) {
      text = text.slice(idx + marker.length).trim();
      break;
    }
  }

  // Remove surf-chart nav block (but keep any [[IMG:...]] tokens)
  text = text
    .replace(/Surf Charts for SoCal[^\[]*?Sunset Cliffs/gi, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  return text;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { html, status, finalUrl } = await fetchPage('https://wavecast.com/socal/');
    const base = finalUrl || 'https://wavecast.com/socal/';

    if (status !== 200) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `WaveCast returned HTTP ${status}` })
      };
    }

    const title = extractTitle(html);
    const text = extractContent(html, base);

    // Also extract a deduplicated image list from the full page as a reliable
    // fallback — the frontend will use this if inline tokens didn't parse correctly.
    // Filter out images already present as tokens in the text.
    const tokenUrls = new Set();
    const tokenRe = /\[\[IMG:([^\|]+)\|/g;
    let tm;
    while ((tm = tokenRe.exec(text)) !== null) tokenUrls.add(tm[1]);

    const allImages = extractAllImages(html, base)
      .filter(img => !tokenUrls.has(img.src)); // don't duplicate inline tokens

    // No hard character limit — WaveCast forecasts can be long
    // Netlify function response limit is 6MB; a text forecast is well under that

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        title,
        text,
        images: allImages,           // full-page image list (fallback gallery)
        imageCount: allImages.length, // debug: how many images were found
        tokenCount: tokenUrls.size,   // debug: how many inline tokens were found
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
