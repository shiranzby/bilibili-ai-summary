const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const mid = String(req.query.mid || '').trim();
  const pn = parseInt(String(req.query.pn || '1'), 10) || 1;
  const ps = Math.min(parseInt(String(req.query.ps || '30'), 10) || 30, 50);
  if (!/^\d+$/.test(mid)) {
    return res.status(400).json({ code: -400, message: 'invalid mid' });
  }

  let cookie = (process.env.BILI_COOKIE || '').trim();
  try {
    const spiResp = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': BILI_UA, 'Referer': 'https://www.bilibili.com/' },
    });
    if (spiResp.ok) {
      const spi = await spiResp.json();
      const parts = [];
      if (cookie) parts.push(cookie);
      if (spi?.data?.b_3) parts.push(`buvid3=${spi.data.b_3}`);
      if (spi?.data?.b_4) parts.push(`buvid4=${spi.data.b_4}`);
      cookie = parts.join('; ');
    }
  } catch (_) {}

  const headers = {
    'User-Agent': BILI_UA,
    'Referer': 'https://space.bilibili.com/',
    'Origin': 'https://space.bilibili.com',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (cookie) headers['Cookie'] = cookie;

  try {
    const r = await fetch(
      `https://api.bilibili.com/x/space/arc/search?mid=${mid}&pn=${pn}&ps=${ps}&order=pubdate`,
      { headers }
    );
    const d = await r.json();
    return res.status(200).json(d);
  } catch (e) {
    return res.status(502).json({ code: -502, message: e.message });
  }
}
