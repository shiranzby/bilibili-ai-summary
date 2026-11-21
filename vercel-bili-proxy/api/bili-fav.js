const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function getBiliCookie() {
  try {
    const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    });
    const j = await r.json();
    const d = j?.data || {};
    if (d.b_3 && d.b_4) return `buvid3=${d.b_3}; buvid4=${d.b_4}`;
  } catch {}
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const rawFid = String(req.query.fid || '').trim();
  const fidMatch = rawFid.match(/(?:fid=|medialist\/ml)(\d+)/i) || rawFid.match(/^(\d+)$/);
  const fid = fidMatch ? fidMatch[1] : '';
  const pn = Math.max(1, parseInt(String(req.query.pn || '1'), 10) || 1);
  const ps = Math.min(20, Math.max(1, parseInt(String(req.query.ps || '20'), 10) || 20));

  if (!fid) {
    return res.status(400).json({ ok: false, error: 'invalid fid' });
  }

  const cookie = await getBiliCookie();
  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  try {
    const url = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${fid}&pn=${pn}&ps=${ps}&platform=web`;
    const r = await fetch(url, { headers });
    const j = await r.json();
    if (j?.code !== 0 || !j?.data) {
      return res.status(200).json({ ok: false, error: j?.message || 'fav fetch failed', code: j?.code });
    }
    const info = j.data.info || {};
    const medias = Array.isArray(j.data.medias) ? j.data.medias : [];
    const items = medias
      .filter(m => m && m.bvid && m.attr !== 9)
      .map(m => ({
        bvid: m.bvid,
        title: m.title || '',
        cover: String(m.cover || '').replace(/^http:\/\//, 'https://'),
        duration: m.duration || 0,
        pubtime: m.pubtime || m.ctime || 0,
        owner: {
          name: m.upper?.name || '',
          mid: m.upper?.mid || '',
          face: String(m.upper?.face || '').replace(/^http:\/\//, 'https://'),
        },
        link: `https://www.bilibili.com/video/${m.bvid}`,
      }));

    return res.status(200).json({
      ok: true,
      fid,
      title: info.title || '',
      media_count: info.media_count || items.length,
      has_more: Boolean(j.data.has_more),
      items,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
