// ============================================================
// LACFD Lifeguard — LA County Beach Water Quality Proxy
// Netlify serverless function — scrapes and parses the
// LA County Dept of Public Health beach advisory page.
//
// Deploy to: netlify/functions/beachwater.js
// Endpoint:  /.netlify/functions/beachwater
// ============================================================

const LACOUNTY_URL =
  'https://publichealth.lacounty.gov/phcommon/public/eh/water_quality/beach_grades.cfm';

// Known LA County beaches with their zone for grouping
const KNOWN_BEACHES = [
  'Zuma Beach','Malibu Surfrider','Malibu Lagoon','Las Virgenes',
  'Las Tunas','Topanga','Will Rogers','Santa Monica Pier','Santa Monica',
  'Venice','Dockweiler','El Porto','Manhattan Beach','Hermosa Beach Pier',
  'Hermosa Beach','Redondo Beach Pier','Redondo Beach','Torrance Beach',
  'White Point','Cabrillo Beach','Long Beach','Alamitos Bay','Seal Beach',
];

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=1800', // cache 30 min
  };

  try {
    const resp = await fetch(LACOUNTY_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LACFD-Marine-Report/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      return { statusCode: resp.status, headers,
        body: JSON.stringify({ error: 'lacounty_fetch_failed', status: resp.status }) };
    }

    const html = await resp.text();
    const result = parseBeachPage(html);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result),
    };

  } catch (err) {
    console.error('Beach water quality error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'proxy_error', message: err.message }),
    };
  }
};

function parseBeachPage(html) {
  const beaches = [];
  let rainAdvisory = null;
  let lastUpdated = null;

  // ── Rain / blanket advisory ────────────────────────────────────────────
  // These appear as prominent banners on the LA County page
  const rainMatch = html.match(
    /rain\s+advisory[^<]{0,300}/i
  );
  if (rainMatch) {
    // Extract the advisory text and any expiry time
    const fullText = rainMatch[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    rainAdvisory = fullText.slice(0, 300);
  }

  // Also look for "Ocean Water Quality Rain Advisory" banner
  const bannerMatch = html.match(
    /Ocean\s+Water\s+Quality[^<]{0,400}/i
  );
  if (bannerMatch && !rainAdvisory) {
    rainAdvisory = bannerMatch[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  // ── Last updated date ─────────────────────────────────────────────────
  const dateMatch = html.match(
    /(?:Updated|Last\s+Updated|As\s+of)[:\s]+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i
  );
  if (dateMatch) lastUpdated = dateMatch[1];

  // ── Per-beach status rows ─────────────────────────────────────────────
  // The LA County page uses table rows or divs like:
  //   <td>Beach Name</td><td>OPEN / ADVISORY / CLOSED</td>
  // Try several patterns

  // Pattern 1: table rows with beach name + grade
  const tableRowPattern = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const rows = html.match(tableRowPattern) || [];

  for (const row of rows) {
    const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    if (cells.length < 2) continue;

    const name = cells[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const statusRaw = cells[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

    if (!name || name.length < 3) continue;

    // Check if this looks like a beach name
    const isBeach = KNOWN_BEACHES.some(b =>
      name.toUpperCase().includes(b.toUpperCase()) ||
      b.toUpperCase().includes(name.toUpperCase().slice(0, 6))
    ) || /beach|pier|cove|lagoon|bay/i.test(name);

    if (!isBeach) continue;

    const status = classifyStatus(statusRaw);
    beaches.push({ name, status, raw: statusRaw });
  }

  // Pattern 2: if no table rows found, look for divs with beach names
  if (beaches.length === 0) {
    for (const beachName of KNOWN_BEACHES) {
      const pattern = new RegExp(
        beachName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '[^<]{0,200}(OPEN|CLOSED|ADVISORY|POOR|A|B|C|D|F)',
        'i'
      );
      const m = html.match(pattern);
      if (m) {
        const status = classifyStatus(m[1].toUpperCase());
        beaches.push({ name: beachName, status, raw: m[1] });
      }
    }
  }

  // Pattern 3: extract grade letters (A/B/C/D/F) near beach names
  if (beaches.length === 0) {
    const gradePattern = /([A-Z][a-zA-Z\s]{3,30}(?:Beach|Pier|Cove|Lagoon))[^<]{0,100}grade[^<]{0,50}([A-F])/gi;
    let gm;
    while ((gm = gradePattern.exec(html)) !== null) {
      const name = gm[1].trim();
      const grade = gm[2].toUpperCase();
      beaches.push({ name, status: gradeToStatus(grade), grade, raw: grade });
    }
  }

  return {
    beaches,
    rainAdvisory,
    lastUpdated,
    source: 'LA County Dept of Public Health',
    url: LACOUNTY_URL,
    fetched: new Date().toISOString(),
    beachCount: beaches.length,
  };
}

function classifyStatus(raw) {
  if (!raw) return 'unknown';
  const s = raw.toUpperCase();
  if (s.includes('CLOSE') || s.includes('PROHIBIT') || s === 'F' || s === 'D') return 'closed';
  if (s.includes('ADVISORY') || s.includes('WARN') || s.includes('CAUTION') ||
      s === 'C' || s === 'POOR') return 'advisory';
  if (s.includes('OPEN') || s.includes('SAFE') || s === 'A' || s === 'B' ||
      s.includes('GOOD') || s.includes('EXCELLENT')) return 'safe';
  return 'unknown';
}

function gradeToStatus(grade) {
  if (['A','B'].includes(grade)) return 'safe';
  if (['C'].includes(grade)) return 'advisory';
  if (['D','F'].includes(grade)) return 'closed';
  return 'unknown';
}
