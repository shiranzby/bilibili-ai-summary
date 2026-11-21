const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function getBiliHeaders() {
  let cookie = (process.env.BILI_COOKIE || '').trim();
  const debug = { region: process.env.VERCEL_REGION || 'unknown' };

  try {
    const spiResp = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': BILI_UA, 'Referer': 'https://www.bilibili.com/' },
    });
    debug.spi_status = spiResp.status;
    if (spiResp.ok) {
      const spi = await spiResp.json();
      const parts = [];
      if (cookie) parts.push(cookie);
      if (spi?.data?.b_3) parts.push(`buvid3=${spi.data.b_3}`);
      if (spi?.data?.b_4) parts.push(`buvid4=${spi.data.b_4}`);
      cookie = parts.join('; ');
    }
  } catch (e) {
    debug.spi_err = e.message;
  }

  const headers = {
    'User-Agent': BILI_UA,
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (cookie) headers['Cookie'] = cookie;
  return { headers, debug };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const bvid = String(req.query.bvid || '').trim();
  if (!/^BV[a-zA-Z0-9]{8,12}$/.test(bvid)) {
    return res.status(400).json({ ok: false, error: 'invalid bvid' });
  }

  const { headers, debug } = await getBiliHeaders();

  let info = null;
  let cid = null;
  let audioUrls = [];

  // 1. Video info via x/web-interface/view
  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { headers });
    debug.view_http = r.status;
    const d = await r.json();
    debug.view_code = d.code;
    debug.view_msg = d.message || '';
    if (d.code === 0 && d.data) {
      info = d.data;
      cid = d.data.cid || d.data.pages?.[0]?.cid || null;
    }
  } catch (e) {
    debug.view_err = e.message;
  }

  // 2. Fallback to x/player/pagelist for cid
  if (!cid) {
    try {
      const r = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`, { headers });
      const d = await r.json();
      debug.pagelist_code = d.code;
      if (d.code === 0 && Array.isArray(d.data) && d.data.length > 0) {
        cid = d.data[0].cid;
      }
    } catch (e) {
      debug.pagelist_err = e.message;
    }
  }

  // 3. Audio stream URLs via x/player/playurl (sorted smallest bandwidth first for STT)
  if (cid) {
    try {
      const r = await fetch(
        `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16&qn=16&fourk=1`,
        { headers }
      );
      const d = await r.json();
      debug.playurl_code = d.code;
      debug.playurl_msg = d.message || '';
      const audios = d?.data?.dash?.audio || [];
      if (d.code === 0 && audios.length > 0) {
        const sorted = [...audios].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
        for (const tr of sorted) {
          if (tr.baseUrl) audioUrls.push(tr.baseUrl);
          for (const bk of tr.backupUrl || []) {
            if (bk) audioUrls.push(bk);
          }
        }
      }
    } catch (e) {
      debug.playurl_err = e.message;
    }
  }

  const compactInfo = info ? {
    bvid: info.bvid || bvid,
    cid: cid || info.cid,
    title: info.title || '',
    desc: info.desc || '',
    pic: (info.pic || '').replace(/^http:\/\//, 'https://'),
    duration: info.duration || 0,
    pubdate: info.pubdate || null,
    owner: info.owner || {},
    pages: (info.pages || []).slice(0, 5).map(p => ({ cid: p.cid, page: p.page, part: p.part })),
  } : null;

  return res.status(200).json({
    ok: Boolean(cid || compactInfo),
    bvid,
    cid,
    info: compactInfo,
    audio_urls: audioUrls,
    debug,
  });
}
