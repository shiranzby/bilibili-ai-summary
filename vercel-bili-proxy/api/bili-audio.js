const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ALLOWED_SUFFIXES = [
  '.bilivideo.com',
  '.bilivideo.cn',
  '.hdslb.com',
  '.akamaized.net',
  '.biliapi.net',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const target = String(req.query.url || '').trim();
  if (!target) return res.status(400).json({ error: 'missing url' });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }

  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !ALLOWED_SUFFIXES.some(s => host.endsWith(s))) {
    return res.status(403).json({ error: 'forbidden host' });
  }

  const headers = {
    'User-Agent': BILI_UA,
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
  };

  // Support Range requests (client downloads in <= 3MB chunks to stay under Vercel 4.5MB body limit)
  const rangeHeader = req.headers['range'] || req.query.range;
  if (rangeHeader) {
    headers['Range'] = String(rangeHeader);
  }

  try {
    const upstream = await fetch(target, { headers });
    const ct = upstream.headers.get('content-type') || 'audio/mp4';
    const cr = upstream.headers.get('content-range');
    const cl = upstream.headers.get('content-length');

    if (upstream.status !== 200 && upstream.status !== 206) {
      return res.status(upstream.status).json({
        error: `upstream HTTP ${upstream.status}`,
        host,
      });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', ct);
    if (cr) res.setHeader('Content-Range', cr);
    res.setHeader('Content-Length', String(buf.length));
    if (cl) res.setHeader('X-Upstream-Content-Length', cl);
    res.setHeader('Accept-Ranges', 'bytes');
    return res.status(upstream.status).send(buf);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
