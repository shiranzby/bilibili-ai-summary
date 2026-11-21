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

function fmtTs(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `[${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}]`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const bvid = String(req.query.bvid || '').trim();
  let cid = String(req.query.cid || '').trim();
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

  if (!cid) {
    try {
      const vr = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers });
      const vj = await vr.json();
      const pages = vj?.data?.pages || [];
      const target = pages.find(p => p.page === rawPage) || pages[0];
      cid = String(target?.cid || vj?.data?.cid || '');
    } catch {}
  }

  if (!cid) {
    return res.status(200).json({ ok: false, bvid, error: 'cid not found' });
  }

  try {
    const r = await fetch(`https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`, { headers });
    const j = await r.json();
    const subs = j?.data?.subtitle?.subtitles || [];
    if (!subs.length) {
      return res.status(200).json({ ok: false, bvid, cid, reason: 'no_subtitles' });
    }
    const preferred =
      subs.find(s => /^zh-CN$/i.test(s.lan)) ||
      subs.find(s => /^zh/i.test(s.lan)) ||
      subs.find(s => /ai-zh/i.test(s.lan)) ||
      subs[0];

    let subUrl = String(preferred?.subtitle_url || '').trim();
    if (!subUrl) {
      return res.status(200).json({ ok: false, bvid, cid, reason: 'empty_subtitle_url' });
    }
    if (subUrl.startsWith('//')) subUrl = 'https:' + subUrl;

    const sr = await fetch(subUrl, { headers: { 'User-Agent': UA } });
    const sj = await sr.json();
    const body = Array.isArray(sj?.body) ? sj.body : [];
    const lines = body
      .map(item => {
        const content = String(item?.content || '').trim();
        if (!content) return '';
        return `${fmtTs(item.from)} ${content}`;
      })
      .filter(Boolean);

    return res.status(200).json({
      ok: lines.length > 0,
      bvid,
      cid,
      lan: preferred.lan || '',
      lines_count: lines.length,
      text: lines.join('\n'),
    });
  } catch (e) {
    return res.status(200).json({ ok: false, bvid, cid, error: String(e?.message || e) });
  }
}
