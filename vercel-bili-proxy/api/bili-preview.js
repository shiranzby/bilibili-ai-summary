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

  const bvid = String(req.query.bvid || '').trim();
  const rawCid = String(req.query.cid || '').trim();
  const rawPage = parseInt(String(req.query.p || '1'), 10) || 1;
  if (!/^BV[0-9A-Za-z]{6,}$/.test(bvid)) {
    return res.status(400).json({ ok: false, error: 'invalid bvid' });
  }

  const cookie = await getBiliCookie();
  const headers = {
    'User-Agent': UA,
    Referer: `https://www.bilibili.com/video/${bvid}`,
    ...(cookie ? { Cookie: cookie } : {}),
  };

  let cid = rawCid;
  let duration = 0;

  if (!cid) {
    try {
      const vr = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers });
      const vj = await vr.json();
      if (vj?.code === 0 && vj?.data) {
        const pages = vj.data.pages || [];
        const targetPage = pages.find(p => p.page === rawPage) || pages[0];
        cid = String(targetPage?.cid || vj.data.cid || '');
        duration = targetPage?.duration || vj.data.duration || 0;
      }
    } catch {}
  }

  if (!cid) {
    return res.status(200).json({ ok: false, bvid, error: 'cid not found', video_urls: [] });
  }

  const videoUrls = [];
  const attempts = [
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=1&qn=32&platform=html5&high_quality=1`,
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=1&qn=16`,
  ];

  for (const url of attempts) {
    try {
      const pr = await fetch(url, { headers });
      const pj = await pr.json();
      const durl = pj?.data?.durl || [];
      for (const item of durl) {
        if (item?.url && !videoUrls.includes(item.url)) videoUrls.push(item.url);
        for (const bak of item?.backup_url || []) {
          if (bak && !videoUrls.includes(bak)) videoUrls.push(bak);
        }
      }
      if (videoUrls.length) break;
    } catch {}
  }

  return res.status(200).json({
    ok: videoUrls.length > 0,
    bvid,
    cid,
    duration,
    video_urls: videoUrls,
  });
}
