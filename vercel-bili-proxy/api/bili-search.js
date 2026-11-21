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

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '');
}

function parseDurationStr(d) {
  if (typeof d === 'number') return d;
  const parts = String(d || '').split(':').map(n => parseInt(n, 10) || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const kw = String(req.query.kw || '').trim();
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const order = String(req.query.order || 'pubdate').trim();
  if (!kw) return res.status(400).json({ ok: false, error: 'missing kw' });

  const cookie = await getBiliCookie();
  const headers = {
    'User-Agent': UA,
    Referer: 'https://search.bilibili.com/',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  try {
    let items = [];
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(kw)}&order=${encodeURIComponent(order)}&page=${page}`;
    const r = await fetch(url, { headers });
    const j = await r.json();
    let list = Array.isArray(j?.data?.result) ? j.data.result : [];

    if (!list.length) {
      const r2 = await fetch(`https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(kw)}`, { headers });
      const j2 = await r2.json();
      const videoMod = (j2?.data?.result || []).find(m => m?.result_type === 'video');
      list = Array.isArray(videoMod?.data) ? videoMod.data : [];
    }

    items = list
      .filter(v => v && v.bvid)
      .slice(0, 20)
      .map(v => {
        let pic = String(v.pic || '').trim();
        if (pic.startsWith('//')) pic = 'https:' + pic;
        else pic = pic.replace(/^http:\/\//, 'https://');
        return {
          bvid: v.bvid,
          title: stripTags(v.title),
          cover: pic,
          duration: parseDurationStr(v.duration),
          pubdate: v.pubdate || 0,
          owner: { name: v.author || '', mid: String(v.mid || '') },
          play: v.play || 0,
          danmaku: v.danmaku || v.video_review || 0,
        };
      });

    return res.status(200).json({ ok: true, kw, items });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e), items: [] });
  }
}
