// Vercel Serverless Function - /api/availability
// Fetches Airbnb iCal feeds and returns blocked dates as JSON
// Called by the website to show real-time availability

export default async function handler(req, res) {
  // Allow CORS from your domain
  res.setHeader('Access-Control-Allow-Origin', 'https://www.chasestay.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=3600'); // Cache for 1 hour

  const { property } = req.query;

  // iCal URLs per property - multiple sources are merged for the same property
  const ICAL_URLS = {
    'apt1':    [process.env.ICAL_APT1    || ''],
    'apt2':    [process.env.ICAL_APT2    || ''],
    'apt3':    [process.env.ICAL_APT3    || ''],
    'apt4':    [process.env.ICAL_APT4    || ''],
    'apt7':    [process.env.ICAL_APT7    || ''],
    'rotunda': [process.env.ICAL_ROTUNDA || ''],
    'orion':   [
      process.env.ICAL_ORION    || '',  // Airbnb
      process.env.ICAL_ORION_YR || '',  // Your.Rentals
    ],
  };

  // If specific property requested, fetch just that one
  // Otherwise fetch all
  const toFetch = property && ICAL_URLS[property]
    ? { [property]: ICAL_URLS[property] }
    : ICAL_URLS;

  const results = {};

  for (const [key, urls] of Object.entries(toFetch)) {
    const validUrls = urls.filter(u => u);

    if (validUrls.length === 0) {
      results[key] = { error: 'No iCal URL configured', blockedDates: [] };
      continue;
    }

    try {
      // Fetch all sources for this property in parallel
      const fetches = validUrls.map(url =>
        fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 ChasestayCalendar/1.0' },
          signal: AbortSignal.timeout(8000)
        }).then(r => r.ok ? r.text() : Promise.resolve(''))
          .catch(() => '')
      );

      const icals = await Promise.all(fetches);

      // Parse and merge blocked dates from all sources
      const allBlocked = icals.flatMap(ical => ical ? parseICal(ical) : []);

      // Deduplicate by start+end
      const seen = new Set();
      const blockedDates = allBlocked.filter(b => {
        const key = `${b.start}|${b.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      results[key] = { blockedDates, lastUpdated: new Date().toISOString() };

    } catch (err) {
      results[key] = { error: err.message, blockedDates: [] };
    }
  }

  res.status(200).json(results);
}

// Parse iCal format and extract blocked date ranges
function parseICal(ical) {
  const blocked = [];
  const lines = ical.split(/\r?\n/);
  let inEvent = false;
  let dtStart = null;
  let dtEnd = null;
  let summary = '';

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      inEvent = true;
      dtStart = null;
      dtEnd = null;
      summary = '';
    }

    if (inEvent) {
      if (line.startsWith('DTSTART')) {
        const val = line.split(':')[1]?.trim();
        dtStart = parseICalDate(val);
      }
      if (line.startsWith('DTEND')) {
        const val = line.split(':')[1]?.trim();
        dtEnd = parseICalDate(val);
      }
      if (line.startsWith('SUMMARY')) {
        summary = line.split(':').slice(1).join(':').trim();
      }

      if (line.startsWith('END:VEVENT') && dtStart && dtEnd) {
        // Generate all dates in the range
        const dates = [];
        const current = new Date(dtStart);
        const end = new Date(dtEnd);

        while (current < end) {
          dates.push(current.toISOString().split('T')[0]);
          current.setDate(current.getDate() + 1);
        }

        blocked.push({
          start: dtStart,
          end: dtEnd,
          summary: summary || 'Booked',
          dates
        });

        inEvent = false;
      }
    }
  }

  // Filter to only future dates
  const today = new Date().toISOString().split('T')[0];
  return blocked.filter(b => b.end >= today);
}

function parseICalDate(val) {
  if (!val) return null;
  // Handle both YYYYMMDD and YYYYMMDDTHHMMSSZ formats
  const clean = val.replace(/[TZ]/g, '');
  const y = clean.substring(0, 4);
  const m = clean.substring(4, 6);
  const d = clean.substring(6, 8);
  return `${y}-${m}-${d}`;
}
