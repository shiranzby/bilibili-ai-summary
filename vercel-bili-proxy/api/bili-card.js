const BILI_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const mid = String(req.query.mid || '').trim();
  if (!/^\d+$/.test(mid)) {
    return res.status(400).json({ ok: false, error: 'invalid mid' });
  }

  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`, {
      headers: {
        'User-Agent': BILI_MOBILE_UA,
        'Referer': 'https://m.bilibili.com/',
        'Accept': 'application/json, text/plain, */*',
      },
    });
    const d = await r.json();
    if (d.code === 0 && d.data?.card) {
      const c = d.data.card;
      return res.status(200).json({
        ok: true,
        mid: Number(mid),
        name: c.name || mid,
        face: c.face || '',
        sign: c.sign || '',
        fans: d.data.follower || 0,
      });
    }
    return res.status(200).json({ ok: false, mid: Number(mid), error: d.message || 'not found' });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
}
