// News + earnings calendar — extracted from server.mjs. Owns its cache; no shared state.
// newsCache/NEWS_TTL are consumed by the /api/news/ route in server.mjs (per-symbol
// EN+AR article cache), so they are exported rather than kept module-private.
export const newsCache = new Map();
export const NEWS_TTL  = 30 * 60 * 1000;

export async function fetchGoogleNews(query, hl = 'en', gl = 'SA', ceid = 'SA:en') {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title   = (block.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/) || block.match(/<title>([^<]+)<\/title>/))?.[1]?.trim() || '';
    const link    = block.match(/<link>([^<]+)<\/link>/)?.[1]?.trim() || block.match(/<guid[^>]*>([^<]+)<\/guid>/)?.[1]?.trim() || '';
    const pubDate = block.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]?.trim() || '';
    const source  = (block.match(/<source[^>]*>([^<]+)<\/source>/) || block.match(/<source[^>]*\/?>/))?.[1]?.trim() || '';
    if (title && link) {
      items.push({ title, url: link, source, published: pubDate, lang: hl === 'ar' ? 'ar' : 'en' });
      if (items.length >= 8) break;
    }
  }
  return items;
}

// token was previously read from state.settings?.finnhub_token; now passed by the caller.
export async function getEarningsCalendar(sym, token) {
  if (!token) return null;
  const base = sym.includes(":") ? sym.split(":")[1] : sym;
  const today = new Date().toISOString().split("T")[0];
  const ahead = new Date(Date.now() + 35 * 864e5).toISOString().split("T")[0];
  try {
    const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${ahead}&symbol=${base}&token=${token}`);
    const d = await r.json();
    return d?.earningsCalendar?.[0] || null;
  } catch (_) { return null; }
}
