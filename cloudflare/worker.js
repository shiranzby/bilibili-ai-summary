/**
 * Bilibili AI Summary — Cloudflare Worker (v3.0)
 * ==============================================
 * - Redesigned Editorial Light & Studio Dark Web UI (single-file SPA)
 * - Full Markdown → Rich Editorial HTML rendering
 * - Admin Auth (HMAC-SHA256 signed session tokens)
 * - Online Monitor & Daily Briefing Settings (stored in R2)
 * - 4 Open-Source Email Styles with Live Interactive Visual Preview
 * - Native Shy Cron (cron.shyapi.de5.net) Auto-Sync & Trigger Endpoint
 */

const MAX_RESULTS = 10;
const HISTORY_KEY = 'history/shared.json';
const MONITOR_CONFIG_KEY = 'config/monitor.json';
const MONITOR_ARCHIVE_KEY = 'monitor_archive/latest.json';
const BILI_PROXY_DEF = 'https://bilisum-bili-proxy.vercel.app';
const GH_OWNER_DEF = 'shiranzby';
const GH_REPO_DEF = 'bilibili-ai-summary';
const CRON_TASK_ID = 'bilisum-daily-monitor';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Monitor-Token, X-Cron-Secret',
};

const DEFAULT_MONITOR_CONFIG = {
  enabled: true,
  schedule_mode: 'times', // 'times' | 'every_6h' | 'every_12h' | 'custom'
  times_cst: ['08:00', '20:00'],
  cron_utc: '0 0,12 * * *',
  up_list: [
    { mid: 21131684, name: '刺客边风', face: 'https://i2.hdslb.com/bfs/face/7d8e287d403f0b3f2fcc6b5f61417ed9ee7b530d.jpg' },
    { mid: 448165099, name: '军情D7处', face: 'https://i1.hdslb.com/bfs/face/5e9ad8be00b4bcc62681d46ea4549bc44b3a88b2.jpg' },
    { mid: 346563107, name: '波士顿圆脸', face: 'https://i2.hdslb.com/bfs/face/f8f0fc4114bb06a87481abe12faa006a383cbe6d.jpg' },
    { mid: 72275943, name: '古必的精读书柜', face: 'https://i0.hdslb.com/bfs/face/7a6f456f98dff1ad76e95157d2278e092b35a99f.jpg' },
    { mid: 413486376, name: '十万个挑战', face: 'https://i0.hdslb.com/bfs/face/95774d9dc096c918dc908e59c0c687c671acb3b2.jpg' },
    { mid: 406636263, name: 'HOLA小测佬', face: 'https://i0.hdslb.com/bfs/face/8d076e9dffc6457c18d050b20195aba05c9996ea.jpg' },
  ],
  email_style: 'editorial',
  merge_emails: true,
  smtp_to: '',
  check_window_hours: 72,
  max_videos_per_run: 5,
};

// ═══════════════════════════════════════════════════════
// Helpers & Responses
// ═══════════════════════════════════════════════════════

function uuid() { return crypto.randomUUID(); }
function nowISO() { return new Date().toISOString(); }

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function base64UrlEncode(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function safeEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

// ═══════════════════════════════════════════════════════
// Auth (HMAC-SHA256 Signed Session Token)
// ═══════════════════════════════════════════════════════

async function getSigningKey(env) {
  const secret = env.SESSION_SECRET || env.CRON_TRIGGER_SECRET || env.ADMIN_PASSWORD || env.GH_TOKEN || 'bilisum-dev-secret';
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function createSessionToken(env, username) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000; // 7 days
  const payload = JSON.stringify({ u: username, exp });
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await getSigningKey(env);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64 = base64UrlEncode(new Uint8Array(sigBuf));
  return { token: `${payloadB64}.${sigB64}`, expires_at: new Date(exp).toISOString() };
}

async function verifySessionToken(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const parts = m[1].trim().split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await getSigningKey(env);
    const sigBytes = base64UrlDecode(sigB64);
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payloadB64));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return { username: payload.u || 'admin', exp: payload.exp };
  } catch {
    return null;
  }
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const expectedUser = (env.ADMIN_USERNAME || 'shiran').trim();
  const expectedPass = env.ADMIN_PASSWORD || '';

  if (!expectedPass) {
    return errorResponse('服务端尚未配置 ADMIN_PASSWORD Secret，请先通过 wrangler secret put ADMIN_PASSWORD 配置', 503);
  }
  if (!safeEqual(username, expectedUser) || !safeEqual(password, expectedPass)) {
    return errorResponse('账号或密码错误', 401);
  }
  const sess = await createSessionToken(env, expectedUser);
  return jsonResponse({ ok: true, username: expectedUser, token: sess.token, expires_at: sess.expires_at });
}

async function handleAuthMe(request, env) {
  const sess = await verifySessionToken(request, env);
  if (!sess) return jsonResponse({ authenticated: false, username: '' });
  return jsonResponse({ authenticated: true, username: sess.username });
}

// ═══════════════════════════════════════════════════════
// GitHub Actions Helpers
// ═══════════════════════════════════════════════════════

async function dispatchWorkflow(env, inputs) {
  const owner = env.GH_OWNER || GH_OWNER_DEF;
  const repo = env.GH_REPO || GH_REPO_DEF;
  const dispatchUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/summary.yml/dispatches`;
  const ghResp = await fetch(dispatchUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${env.GH_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'bilibili-ai-summary-worker/3.0',
    },
    body: JSON.stringify({ ref: env.GH_REF || 'main', inputs }),
  });
  return ghResp;
}

async function fetchGHRunId(env) {
  const owner = env.GH_OWNER || GH_OWNER_DEF;
  const repo = env.GH_REPO || GH_REPO_DEF;
  const token = env.GH_TOKEN || '';
  if (!token) return null;
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?event=workflow_dispatch&per_page=5`;
  try {
    const resp = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'bilibili-ai-summary-worker/3.0',
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const runs = data.workflow_runs || [];
    return runs.length > 0 ? runs[0].id : null;
  } catch {
    return null;
  }
}

async function captureRunId(env, jobId) {
  if (!env.BILIBILI_BUCKET || !env.GH_TOKEN) return;
  const runId = await fetchGHRunId(env);
  if (runId) {
    try {
      const existing = await env.BILIBILI_BUCKET.get(`pending/${jobId}.json`);
      if (existing) {
        const jobData = await existing.json();
        jobData.run_id = runId;
        await env.BILIBILI_BUCKET.put(`pending/${jobId}.json`, JSON.stringify(jobData), {
          httpMetadata: { contentType: 'application/json' },
        });
      }
    } catch {}
  }
}

async function fetchGHRunStatus(env, runId) {
  const owner = env.GH_OWNER || GH_OWNER_DEF;
  const repo = env.GH_REPO || GH_REPO_DEF;
  const token = env.GH_TOKEN || '';
  if (!token || !runId) return null;
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'bilibili-ai-summary-worker/3.0',
      },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function ghStatusToSteps(ghStatus, ghConclusion, startedAt) {
  const steps = [
    { name: '任务创建', done: true, active: false },
    { name: '下载音频', done: false, active: false },
    { name: '语音转录', done: false, active: false },
    { name: 'AI总结', done: false, active: false },
    { name: '完成', done: false, active: false },
  ];
  if (ghStatus === 'queued') {
    steps[0].active = true;
  } else if (ghStatus === 'in_progress') {
    const elapsed = startedAt ? (Date.now() - new Date(startedAt).getTime()) / 1000 : 0;
    const doneCount = elapsed < 15 ? 0 : elapsed < 35 ? 1 : elapsed < 75 ? 2 : 3;
    for (let i = 1; i <= doneCount && i < 5; i++) steps[i].done = true;
    const next = Math.min(doneCount + 1, 4);
    if (next < 5) steps[next].active = true;
  } else if (ghStatus === 'completed') {
    if (ghConclusion === 'success') {
      steps.forEach(s => { s.done = true; s.active = false; });
    } else {
      steps[4].failed = true;
    }
  }
  return steps;
}

// ═══════════════════════════════════════════════════════
// Monitor Config + Shy Cron Sync (cron.shyapi.de5.net)
// ═══════════════════════════════════════════════════════

function cstTimesToUtcCron(timesCst, scheduleMode, customCron) {
  if (scheduleMode === 'every_6h') return '0 */6 * * *';
  if (scheduleMode === 'every_12h') return '0 0,12 * * *';
  if (scheduleMode === 'custom' && customCron && customCron.trim().split(/\s+/).length === 5) {
    return customCron.trim();
  }
  // Convert Beijing Time (UTC+8) HH:MM list -> UTC cron
  const valid = (Array.isArray(timesCst) ? timesCst : [])
    .map(t => String(t || '').trim())
    .filter(t => /^\d{1,2}:\d{2}$/.test(t));
  if (valid.length === 0) return '0 0,12 * * *';

  // Use the minute of the first time slot (standard 5-field cron shares one minute field)
  const firstMin = parseInt(valid[0].split(':')[1], 10);
  const minute = Number.isFinite(firstMin) && firstMin >= 0 && firstMin <= 59 ? firstMin : 0;
  const utcHours = [];
  for (const t of valid) {
    const h = parseInt(t.split(':')[0], 10);
    if (Number.isFinite(h) && h >= 0 && h <= 23) {
      const uh = (h - 8 + 24) % 24;
      if (!utcHours.includes(uh)) utcHours.push(uh);
    }
  }
  utcHours.sort((a, b) => a - b);
  return `${minute} ${utcHours.join(',')} * * *`;
}

async function readMonitorConfig(env) {
  const defaultFaceMap = new Map(DEFAULT_MONITOR_CONFIG.up_list.map(u => [Number(u.mid), u.face]));
  if (!env.BILIBILI_BUCKET) return { ...DEFAULT_MONITOR_CONFIG };
  try {
    const obj = await env.BILIBILI_BUCKET.get(MONITOR_CONFIG_KEY);
    if (!obj) return { ...DEFAULT_MONITOR_CONFIG };
    const saved = await obj.json();
    const merged = { ...DEFAULT_MONITOR_CONFIG, ...saved };
    if (Array.isArray(merged.up_list)) {
      merged.up_list = merged.up_list.map(u => ({
        mid: Number(u.mid),
        name: u.name || String(u.mid),
        face: (u.face || defaultFaceMap.get(Number(u.mid)) || '').replace(/^http:\/\//, 'https://'),
      }));
    }
    return merged;
  } catch {
    return { ...DEFAULT_MONITOR_CONFIG };
  }
}

async function syncToShyCron(env, config, originUrl) {
  const cronBase = (env.CRON_BASE_URL || '').trim().replace(/\/+$/, '');
  const cronUser = (env.CRON_USERNAME || '').trim();
  const cronPass = env.CRON_PASSWORD || '';
  const triggerSecret = env.CRON_TRIGGER_SECRET || '';

  if (!cronBase || !cronUser || !cronPass) {
    return { ok: false, skipped: true, reason: '未配置 CRON_BASE_URL / CRON_USERNAME / CRON_PASSWORD' };
  }

  try {
    // 1. Login to Shy Cron
    const loginResp = await fetch(`${cronBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cronUser, password: cronPass }),
    });
    if (!loginResp.ok) {
      return { ok: false, error: `Shy Cron 登录失败 (HTTP ${loginResp.status})` };
    }
    const setCookie = loginResp.headers.get('set-cookie') || '';
    const cookieMatch = setCookie.match(/shy_cron_session=([^;]+)/);
    if (!cookieMatch) {
      return { ok: false, error: 'Shy Cron 未返回会话 Cookie' };
    }
    const cookieHeader = `shy_cron_session=${cookieMatch[1]}`;

    // 2. Check existing task for expected_updated_at
    let expectedUpdatedAt = null;
    try {
      const listResp = await fetch(`${cronBase}/api/tasks`, {
        headers: { 'Cookie': cookieHeader },
      });
      if (listResp.ok) {
        const listData = await listResp.json();
        const found = (listData.tasks || []).find(item => item?.task?.id === CRON_TASK_ID);
        if (found?.task?.updated_at) {
          expectedUpdatedAt = found.task.updated_at;
        }
      }
    } catch {}

    // 3. Upsert task in Shy Cron
    const callbackTarget = `${originUrl.replace(/\/+$/, '')}/api/cron-trigger`;
    const payload = {
      id: CRON_TASK_ID,
      name: 'B站AI摘要 · UP主定时监控日报',
      project_id: 'bilisum',
      project_name: 'B站AI摘要',
      environment: 'production',
      cron: config.cron_utc || '0 0,12 * * *',
      offset_minutes: 0,
      url: callbackTarget,
      method: 'POST',
      enabled: Boolean(config.enabled),
      timeout_seconds: 25,
      retries: 1,
      headers: triggerSecret ? { 'X-Cron-Secret': triggerSecret } : {},
      body: JSON.stringify({ source: 'shy-cron', task: CRON_TASK_ID }),
    };
    if (expectedUpdatedAt) {
      payload.expected_updated_at = expectedUpdatedAt;
    }

    const saveResp = await fetch(`${cronBase}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieHeader,
      },
      body: JSON.stringify(payload),
    });
    const saveText = await saveResp.text();
    let saveData = {};
    try { saveData = JSON.parse(saveText); } catch {}
    if (!saveResp.ok) {
      return { ok: false, error: `同步任务失败 (HTTP ${saveResp.status}): ${saveText.slice(0, 180)}` };
    }
    return {
      ok: true,
      task_id: saveData?.task?.id || CRON_TASK_ID,
      cron_utc: saveData?.task?.cron || payload.cron,
      enabled: payload.enabled,
      next_run_at: saveData?.state?.next_run_at || '',
      target_url: callbackTarget,
    };
  } catch (e) {
    return { ok: false, error: `Shy Cron 网络异常: ${e.message}` };
  }
}

async function handleGetMonitorConfig(request, env) {
  // Allow either logged-in admin OR GitHub Actions with X-Monitor-Token
  const sess = await verifySessionToken(request, env);
  const monToken = request.headers.get('X-Monitor-Token') || '';
  const hasServiceAuth = Boolean(env.CRON_TRIGGER_SECRET && safeEqual(monToken, env.CRON_TRIGGER_SECRET));

  if (!sess && !hasServiceAuth) {
    return errorResponse('需要登录管理员账号', 401);
  }
  const config = await readMonitorConfig(env);
  return jsonResponse({ ok: true, config });
}

async function handleSaveMonitorConfig(request, env) {
  const sess = await verifySessionToken(request, env);
  if (!sess) return errorResponse('需要登录管理员账号', 401);

  const body = await request.json().catch(() => ({}));
  const prev = await readMonitorConfig(env);

  const validStyles = ['editorial', 'minimal', 'bilibili', 'compact'];
  const emailStyle = validStyles.includes(body.email_style) ? body.email_style : (prev.email_style || 'editorial');
  const scheduleMode = ['times', 'every_6h', 'every_12h', 'custom'].includes(body.schedule_mode)
    ? body.schedule_mode
    : 'times';
  const timesCst = Array.isArray(body.times_cst)
    ? body.times_cst.map(s => String(s || '').trim()).filter(s => /^\d{1,2}:\d{2}$/.test(s))
    : prev.times_cst;

  const upList = [];
  if (Array.isArray(body.up_list)) {
    const seen = new Set();
    for (const item of body.up_list) {
      const mid = parseInt(typeof item === 'object' ? item.mid : item, 10);
      if (Number.isFinite(mid) && mid > 0 && !seen.has(mid)) {
        seen.add(mid);
        const rawFace = (typeof item === 'object' && item.face) ? String(item.face).trim() : '';
        upList.push({
          mid,
          name: typeof item === 'object' && item.name ? String(item.name).slice(0, 60) : String(mid),
          face: rawFace.replace(/^http:\/\//, 'https://').slice(0, 240),
        });
      }
    }
  }

  const cronUtc = cstTimesToUtcCron(timesCst, scheduleMode, body.cron_utc);
  const newConfig = {
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
    schedule_mode: scheduleMode,
    times_cst: timesCst.length > 0 ? timesCst : ['08:00', '20:00'],
    cron_utc: cronUtc,
    up_list: upList.length > 0 ? upList : prev.up_list,
    email_style: emailStyle,
    merge_emails: body.merge_emails !== undefined ? Boolean(body.merge_emails) : true,
    smtp_to: String(body.smtp_to || '').trim().slice(0, 120),
    check_window_hours: Math.max(6, Math.min(720, parseInt(body.check_window_hours || '72', 10) || 72)),
    max_videos_per_run: Math.max(1, Math.min(20, parseInt(body.max_videos_per_run || '5', 10) || 5)),
    updated_at: nowISO(),
    updated_by: sess.username,
  };

  if (env.BILIBILI_BUCKET) {
    await env.BILIBILI_BUCKET.put(MONITOR_CONFIG_KEY, JSON.stringify(newConfig), {
      httpMetadata: { contentType: 'application/json' },
    });
  }

  // Prefer custom domain bilisum.cc.cd if accessed via it, otherwise current origin
  const reqOrigin = new URL(request.url).origin;
  const cronSync = await syncToShyCron(env, newConfig, reqOrigin);

  // Persist last cron sync status inside config for visibility
  newConfig.last_cron_sync = { ...cronSync, synced_at: nowISO() };
  if (env.BILIBILI_BUCKET) {
    await env.BILIBILI_BUCKET.put(MONITOR_CONFIG_KEY, JSON.stringify(newConfig), {
      httpMetadata: { contentType: 'application/json' },
    });
  }

  return jsonResponse({ ok: true, config: newConfig, cron_sync: cronSync });
}

async function handleUpLookup(request, env) {
  const sess = await verifySessionToken(request, env);
  if (!sess) return errorResponse('需要登录管理员账号', 401);

  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  const match = q.match(/(?:space\.bilibili\.com\/|^)(\d{1,15})/);
  if (!match) return errorResponse('请输入有效的 UP 主 UID 或主页链接（如 space.bilibili.com/346563107）', 400);
  const mid = match[1];

  const proxyBase = (env.BILI_PROXY_URL || BILI_PROXY_DEF).replace(/\/+$/, '');
  try {
    const r = await fetch(`${proxyBase}/api/bili-card?mid=${mid}`);
    const d = await r.json();
    if (d.ok) {
      return jsonResponse({
        ok: true,
        mid: Number(mid),
        name: d.name || mid,
        face: (d.face || '').replace(/^http:\/\//, 'https://'),
        fans: d.fans || 0,
      });
    }
    return jsonResponse({ ok: true, mid: Number(mid), name: mid, face: '', note: '未查到昵称，已按 UID 添加' });
  } catch {
    return jsonResponse({ ok: true, mid: Number(mid), name: mid, face: '', note: '昵称解析超时，已按 UID 添加' });
  }
}

async function handleCronTrigger(request, env) {
  const url = new URL(request.url);
  const secret = request.headers.get('X-Cron-Secret') || url.searchParams.get('secret') || '';
  if (!env.CRON_TRIGGER_SECRET || !safeEqual(secret, env.CRON_TRIGGER_SECRET)) {
    return errorResponse('Invalid cron secret', 401);
  }
  const cfg = await readMonitorConfig(env);
  if (cfg.enabled === false) {
    return jsonResponse({ ok: true, skipped: true, reason: 'monitor disabled in config' }, 200);
  }
  const ghResp = await dispatchWorkflow(env, { bvid: '', email_style: cfg.email_style || 'editorial' });
  if (!ghResp.ok && ghResp.status !== 204) {
    const errText = await ghResp.text().catch(() => '');
    return errorResponse(`GitHub dispatch failed: HTTP ${ghResp.status} ${errText.slice(0, 120)}`, 502);
  }
  return jsonResponse({ ok: true, triggered_at: nowISO(), email_style: cfg.email_style || 'editorial' }, 202);
}

async function handleManualMonitorRun(request, env) {
  const sess = await verifySessionToken(request, env);
  if (!sess) return errorResponse('需要登录管理员账号', 401);
  const cfg = await readMonitorConfig(env);
  const ghResp = await dispatchWorkflow(env, { bvid: '', email_style: cfg.email_style || 'editorial' });
  if (!ghResp.ok && ghResp.status !== 204) {
    const errText = await ghResp.text().catch(() => '');
    return errorResponse(`触发失败: HTTP ${ghResp.status} ${errText.slice(0, 120)}`, 502);
  }
  return jsonResponse({ ok: true, message: '已触发 GitHub Actions 监控任务，约 1~2 分钟后完成' }, 202);
}

async function readMonitorArchive(env) {
  if (!env.BILIBILI_BUCKET) return [];
  try {
    const obj = await env.BILIBILI_BUCKET.get(MONITOR_ARCHIVE_KEY);
    if (!obj) return [];
    const data = await obj.json();
    return Array.isArray(data.videos) ? data.videos : [];
  } catch {
    return [];
  }
}

async function handlePostMonitorArchive(request, env) {
  const monToken = request.headers.get('X-Monitor-Token') || '';
  if (!env.CRON_TRIGGER_SECRET || !safeEqual(monToken, env.CRON_TRIGGER_SECRET)) {
    return errorResponse('Invalid monitor token', 401);
  }
  if (!env.BILIBILI_BUCKET) return errorResponse('R2 未配置', 503);
  const body = await request.json().catch(() => ({}));
  const incoming = Array.isArray(body.videos) ? body.videos : [];
  const existing = await readMonitorArchive(env);
  const byBvid = new Map();
  existing.forEach(v => { if (v && v.bvid) byBvid.set(v.bvid, v); });
  incoming.forEach(v => {
    if (v && v.bvid) {
      byBvid.set(v.bvid, {
        bvid: v.bvid,
        mid: Number(v.mid) || 0,
        up_name: v.up_name || '',
        title: v.title || v.bvid,
        summary: v.summary || '',
        duration: v.duration || '',
        pub_time: v.pub_time || '',
        url: v.url || `https://www.bilibili.com/video/${v.bvid}`,
        created: v.created || 0,
        archived_at: nowISO(),
      });
    }
  });
  const merged = Array.from(byBvid.values())
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .slice(0, 150);
  await env.BILIBILI_BUCKET.put(MONITOR_ARCHIVE_KEY, JSON.stringify({ videos: merged, updated_at: nowISO() }), {
    httpMetadata: { contentType: 'application/json' },
  });
  return jsonResponse({ ok: true, total: merged.length });
}

async function handleGetMonitorArchive(request, env) {
  const sess = await verifySessionToken(request, env);
  if (!sess) return errorResponse('需要登录管理员账号', 401);
  const midFilter = parseInt(new URL(request.url).searchParams.get('mid') || '0', 10);
  let videos = await readMonitorArchive(env);
  if (midFilter) videos = videos.filter(v => Number(v.mid) === midFilter);
  return jsonResponse({ ok: true, videos });
}

async function handleGetUpVideos(request, env, ctx) {
  const sess = await verifySessionToken(request, env);
  if (!sess) return errorResponse('需要登录管理员账号', 401);

  const reqUrl = new URL(request.url);
  const midParam = (reqUrl.searchParams.get('mid') || '').trim();
  const ps = Math.min(parseInt(reqUrl.searchParams.get('ps') || '16', 10) || 16, 30);
  const forceRefresh = reqUrl.searchParams.get('refresh') === '1';

  // Cloudflare Edge Cache (5 min TTL) for fast reloads unless ?refresh=1
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKeyUrl = new URL(reqUrl.origin + '/__cache/up-videos');
  cacheKeyUrl.searchParams.set('mid', midParam);
  cacheKeyUrl.searchParams.set('ps', String(ps));
  const cacheReq = new Request(cacheKeyUrl.toString(), { method: 'GET' });
  if (cache && !forceRefresh) {
    const hit = await cache.match(cacheReq);
    if (hit) {
      const cloned = new Response(hit.body, hit);
      cloned.headers.set('X-Feed-Cache', 'HIT');
      return cloned;
    }
  }

  const proxyBase = (env.BILI_PROXY_URL || BILI_PROXY_DEF).replace(/\/+$/, '');
  const cfg = await readMonitorConfig(env);
  const upMetaMap = new Map((cfg.up_list || []).map(u => [Number(u.mid), u]));
  const archive = await readMonitorArchive(env);
  const summaryMap = new Map();
  archive.forEach(v => { if (v && v.bvid) summaryMap.set(v.bvid, v); });

  const mapVlist = (vlist, midNum) => {
    const meta = upMetaMap.get(midNum) || {};
    return (vlist || []).map(v => {
      const arch = summaryMap.get(v.bvid);
      const rawPic = (v.pic || '').replace(/^http:\/\//, 'https://');
      return {
        bvid: v.bvid,
        mid: midNum,
        author: v.author || meta.name || String(midNum),
        face: (meta.face || '').replace(/^http:\/\//, 'https://'),
        title: v.title || v.bvid,
        description: v.description || '',
        duration: v.length || '',
        created: v.created || 0,
        play: v.play || 0,
        danmaku: v.video_review || 0,
        pic: rawPic,
        url: `https://www.bilibili.com/video/${v.bvid}`,
        summary: arch ? arch.summary : '',
        archived: Boolean(arch && arch.summary),
      };
    });
  };

  const respondCached = (payload) => {
    const resp = new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Feed-Cache': 'MISS',
      },
    });
    if (cache && ctx && payload.ok && Array.isArray(payload.videos) && payload.videos.length > 0) {
      ctx.waitUntil(cache.put(cacheReq, resp.clone()));
    }
    return resp;
  };

  if (midParam === 'all') {
    const ups = (cfg.up_list || []).slice(0, 12);
    const perUp = Math.max(4, Math.min(8, Math.ceil(24 / Math.max(1, ups.length))));
    const results = await Promise.all(
      ups.map(async u => {
        try {
          const r = await fetch(`${proxyBase}/api/bili-up?mid=${u.mid}&pn=1&ps=${perUp}`);
          const d = await r.json();
          return mapVlist(d?.data?.list?.vlist || [], Number(u.mid));
        } catch {
          return [];
        }
      })
    );
    const merged = results.flat().sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 40);
    return respondCached({ ok: true, mid: 'all', videos: merged, cached_at: nowISO() });
  }

  if (!/^\d+$/.test(midParam)) return errorResponse('无效的 UP 主 UID', 400);
  const midNum = Number(midParam);

  try {
    const r = await fetch(`${proxyBase}/api/bili-up?mid=${midNum}&pn=1&ps=${ps}`);
    const d = await r.json();
    const items = mapVlist(d?.data?.list?.vlist || [], midNum);
    return respondCached({ ok: true, mid: midNum, videos: items, code: d.code, cached_at: nowISO() });
  } catch (e) {
    const fallback = archive.filter(v => Number(v.mid) === midNum);
    return jsonResponse({ ok: true, mid: midNum, videos: fallback, warning: '实时列表拉取失败，仅显示历史归档: ' + e.message });
  }
}

// ═══════════════════════════════════════════════════════
// R2 Storage & History & Jobs
// ═══════════════════════════════════════════════════════

async function cleanupExcessResults(R2) {
  const objects = [];
  let cursor;
  do {
    const listed = await R2.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      if (obj.key.startsWith('results/')) objects.push({ key: obj.key, uploaded: obj.uploaded });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  objects.sort((a, b) => new Date(a.uploaded) - new Date(b.uploaded));
  const toDelete = objects.slice(0, Math.max(0, objects.length - MAX_RESULTS));
  for (const obj of toDelete) await R2.delete(obj.key);
  return toDelete.length;
}

async function handleGetHistory(request, env) {
  if (!env.BILIBILI_BUCKET) return jsonResponse({ error: 'R2 not configured' }, 503);
  try {
    const obj = await env.BILIBILI_BUCKET.get(HISTORY_KEY);
    if (!obj) return jsonResponse([]);
    const data = await obj.json();
    return jsonResponse(data.jobs || []);
  } catch {
    return jsonResponse([]);
  }
}

async function handlePostHistory(request, env) {
  if (!env.BILIBILI_BUCKET) return jsonResponse({ error: 'R2 not configured' }, 503);
  try {
    const body = await request.json();
    const trimmed = (body.jobs || []).slice(0, 100);
    await env.BILIBILI_BUCKET.put(HISTORY_KEY, JSON.stringify({ jobs: trimmed, updated_at: nowISO() }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return jsonResponse({ ok: true, count: trimmed.length });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

async function handleDeleteHistory(request, env) {
  if (!env.BILIBILI_BUCKET) return jsonResponse({ error: 'R2 not configured' }, 503);
  await env.BILIBILI_BUCKET.delete(HISTORY_KEY);
  return jsonResponse({ ok: true });
}

function formatSecDuration(sec) {
  const s = parseInt(sec, 10) || 0;
  if (s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

async function handleSubmit(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const url = body.url;
  const summary_template = body.summary_template || '';
  const custom_email = body.email || '';
  const email_style = body.email_style || 'editorial';
  const send_email = body.send_email === false ? false : true;
  if (!url || typeof url !== 'string') {
    return errorResponse('请提供 B站视频 URL 或 BV 号');
  }

  let bvid = url.trim();
  const bvMatch = bvid.match(/BV[a-zA-Z0-9]{8,12}/);
  if (bvMatch) bvid = bvMatch[0];
  else {
    const avMatch = bvid.match(/[Aa][Vv](\d+)/);
    if (avMatch) bvid = 'av' + avMatch[1];
    else {
      const urlM = bvid.match(/bilibili\.com\/video\/([A-Za-z0-9]+)/i);
      if (urlM) bvid = urlM[1];
    }
  }
  if (!/^BV[a-zA-Z0-9]{8,12}$/.test(bvid) && !/^av\d+$/i.test(bvid)) {
    return errorResponse('无法解析视频 ID，请输入 B站视频链接或 BV 号');
  }

  // Resolve real video title / owner / duration immediately so pending card never shows bare BV id
  let title = String(body.title || '').trim();
  let owner = String(body.owner || '').trim();
  let duration = String(body.duration || '').trim();
  if (!title && /^BV/i.test(bvid)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3200);
      const proxyBase = (env.BILI_PROXY_URL || BILI_PROXY_DEF).replace(/\/+$/, '');
      const ir = await fetch(`${proxyBase}/api/bili-info?bvid=${encodeURIComponent(bvid)}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (ir.ok) {
        const idata = await ir.json();
        const info = idata?.info;
        if (info) {
          title = info.title || '';
          owner = info.owner?.name || '';
          duration = formatSecDuration(info.duration);
        }
      }
    } catch {}
  }

  const jobId = uuid();
  const job = {
    id: jobId, bvid, url: bvid, status: 'pending',
    created_at: nowISO(), updated_at: nowISO(),
    summary: null, title: title || bvid, owner, duration,
    error: '', email_style, send_email,
  };

  if (env.BILIBILI_BUCKET) {
    env.BILIBILI_BUCKET.put(`pending/${jobId}.json`, JSON.stringify(job), {
      httpMetadata: { contentType: 'application/json' },
    }).catch(() => {});
  }

  const inputs = { bvid, job_id: jobId, send_email: send_email ? 'true' : 'false' };
  if (summary_template) inputs.summary_template = summary_template;
  if (custom_email) inputs.email = custom_email;
  if (email_style) inputs.email_style = email_style;

  try {
    const ghResp = await dispatchWorkflow(env, inputs);
    if (ghResp.status !== 204 && ghResp.status !== 201 && ghResp.status !== 200) {
      if (env.BILIBILI_BUCKET) cleanupExcessResults(env.BILIBILI_BUCKET).catch(() => {});
      return jsonResponse({
        job_id: jobId, bvid, title: job.title, owner, duration, status: 'pending',
        warning: 'GitHub Actions 触发可能失败: HTTP ' + ghResp.status,
      }, 201);
    }
    ctx.waitUntil(captureRunId(env, jobId));
  } catch (err) {
    console.error('GitHub dispatch error:', err.message);
  }

  if (env.BILIBILI_BUCKET) cleanupExcessResults(env.BILIBILI_BUCKET).catch(() => {});
  return jsonResponse({ job_id: jobId, bvid, title: job.title, owner, duration, status: 'pending' }, 201);
}

async function handleListJobs(request, env) {
  if (!env.BILIBILI_BUCKET) {
    return jsonResponse({ jobs: [], total: 0, note: 'R2 未配置' });
  }
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const jobs = [];
  let cursor;
  do {
    const listed = await env.BILIBILI_BUCKET.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      if (jobs.length >= limit) break;
      if (!obj.key.startsWith('pending/') && !obj.key.startsWith('results/')) continue;
      const raw = await env.BILIBILI_BUCKET.get(obj.key);
      if (!raw) continue;
      const job = await raw.json();
      if (status && job.status !== status) continue;
      jobs.push(job);
    }
    if (jobs.length >= limit) break;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  jobs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return jsonResponse({ jobs, total: jobs.length });
}

async function handleGetJob(request, env, jobId) {
  if (!env.BILIBILI_BUCKET) return errorResponse('R2 未配置', 503);
  let raw = await env.BILIBILI_BUCKET.get(`pending/${jobId}.json`);
  if (!raw) raw = await env.BILIBILI_BUCKET.get(`results/${jobId}.json`);
  if (!raw) return errorResponse('任务不存在', 404);
  const job = await raw.json();
  if (job.status !== 'completed' && job.status !== 'failed' && job.run_id) {
    const ghRun = await fetchGHRunStatus(env, job.run_id);
    if (ghRun) {
      job.gh_status = ghRun.status;
      job.gh_conclusion = ghRun.conclusion;
      job.gh_html_url = ghRun.html_url;
      job.gh_steps = ghStatusToSteps(ghRun.status, ghRun.conclusion, job.created_at);
    }
  }
  return jsonResponse(job);
}

async function handleDeleteJob(request, env, jobId) {
  if (!env.BILIBILI_BUCKET) return jsonResponse({ deleted: true, job_id: jobId });
  let deleted = false;
  if (await env.BILIBILI_BUCKET.get(`pending/${jobId}.json`)) {
    await env.BILIBILI_BUCKET.delete(`pending/${jobId}.json`); deleted = true;
  }
  if (await env.BILIBILI_BUCKET.get(`results/${jobId}.json`)) {
    await env.BILIBILI_BUCKET.delete(`results/${jobId}.json`); deleted = true;
  }
  if (!deleted) return errorResponse('任务不存在', 404);
  return jsonResponse({ deleted: true, job_id: jobId });
}

async function handleCallback(request, env) {
  if (!env.BILIBILI_BUCKET) return errorResponse('R2 未配置', 503);
  const body = await request.json();
  const { job_id, bvid, status, summary, transcript, title, timings, owner, pubdate, duration, error, error_stage, error_hint } = body;
  if (!job_id || !bvid) return errorResponse('缺少 job_id 或 bvid', 400);
  const pending = await env.BILIBILI_BUCKET.get(`pending/${job_id}.json`);
  if (!pending) return errorResponse('任务不存在或已处理', 404);

  const result = {
    id: job_id, bvid, status: status || 'completed',
    summary: summary || null,
    transcript: transcript || '',
    title: title || '',
    timings: timings || {},
    owner: owner || '',
    pubdate: pubdate || null,
    duration: duration || '',
    error: error || '',
    error_stage: error_stage || '',
    error_hint: error_hint || '',
    completed_at: nowISO(),
    video_url: `https://www.bilibili.com/video/${bvid}`,
  };
  await env.BILIBILI_BUCKET.put(`results/${job_id}.json`, JSON.stringify(result), {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.BILIBILI_BUCKET.delete(`pending/${job_id}.json`);
  return jsonResponse({ status: 'ok', job_id });
}

async function handleStats(request, env) {
  if (!env.BILIBILI_BUCKET) {
    return jsonResponse({ mode: 'localstorage', max_results: MAX_RESULTS });
  }
  let pending = 0, completed = 0;
  let cursor;
  do {
    const listed = await env.BILIBILI_BUCKET.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      if (obj.key.startsWith('pending/')) pending++;
      if (obj.key.startsWith('results/')) completed++;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return jsonResponse({ mode: 'r2', pending_jobs: pending, completed_jobs: completed, max_results: MAX_RESULTS });
}

async function handleCron(event, env) {
  if (!env.BILIBILI_BUCKET) return;
  await cleanupExcessResults(env.BILIBILI_BUCKET);
}

// ═══════════════════════════════════════════════════════
// Redesigned Frontend SPA (Editorial Light + Studio Dark)
// ═══════════════════════════════════════════════════════

function generateFrontendPage() {
  return String.raw`<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>B站AI摘要 · Bilibili AI Summary</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#F8F9FA;--surface:#FFFFFF;--surface-2:#F3F4F6;--surface-hover:#F9FAFB;
  --border:#E5E7EB;--border-strong:#D1D5DB;
  --text:#111827;--soft:#4B5563;--muted:#9CA3AF;
  --brand:#FB7299;--brand-dark:#E11D48;--brand-soft:#FFF1F5;--brand-border:#FECDD3;
  --cta:#111827;--cta-hover:#1F2937;--cta-text:#FFFFFF;
  --ok:#10B981;--ok-soft:#ECFDF5;--ok-text:#047857;
  --err:#EF4444;--err-soft:#FEF2F2;--err-border:#FECACA;--err-text:#B91C1C;
  --warn:#F59E0B;--warn-soft:#FFFBEB;
  --shadow-sm:0 1px 2px rgba(16,24,40,.04);
  --shadow-md:0 4px 16px rgba(16,24,40,.06);
  --shadow-lg:0 20px 48px rgba(16,24,40,.14);
}
[data-theme="dark"]{
  --bg:#0B0D12;--surface:#13161F;--surface-2:#1B202C;--surface-hover:#181C27;
  --border:rgba(255,255,255,.09);--border-strong:rgba(255,255,255,.16);
  --text:#F3F4F6;--soft:#CBD5E1;--muted:#6B7280;
  --brand:#FB7299;--brand-dark:#FDA4AF;--brand-soft:rgba(251,114,153,.13);--brand-border:rgba(251,114,153,.32);
  --cta:#FB7299;--cta-hover:#F43F7A;--cta-text:#FFFFFF;
  --ok:#10B981;--ok-soft:rgba(16,185,129,.14);--ok-text:#6EE7B7;
  --err:#F87171;--err-soft:rgba(239,68,68,.12);--err-border:rgba(239,68,68,.28);--err-text:#FCA5A5;
  --warn:#FBBF24;--warn-soft:rgba(245,158,11,.14);
  --shadow-sm:0 1px 2px rgba(0,0,0,.3);
  --shadow-md:0 4px 18px rgba(0,0,0,.35);
  --shadow-lg:0 24px 56px rgba(0,0,0,.6);
}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI','Microsoft YaHei',sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;overflow:hidden}
button,input,select,textarea{font-family:inherit;color:inherit}
button{cursor:pointer}
.hidden{display:none!important}
svg.ic{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}

/* Unified Form Controls */
.ctrl{width:100%;height:38px;padding:0 12px;font-size:13px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);outline:none;transition:border-color .15s,box-shadow .15s}
.ctrl:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.ctrl::placeholder{color:var(--muted)}
select.ctrl{appearance:none;-webkit-appearance:none;padding-right:32px}
textarea.ctrl{height:auto;min-height:78px;padding:9px 12px;resize:vertical;line-height:1.55}

/* Custom Card-Style Select Dropdown (No Native Double-Arrow or Black Popup) */
.c-select{position:relative;width:100%}
.c-select-native{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
.c-select-btn{width:100%;height:38px;padding:0 12px;font-size:13px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;transition:border-color .15s,box-shadow .15s,background .15s}
.c-select-btn:hover{border-color:var(--border-strong);background:var(--surface-hover)}
.c-select.open .c-select-btn{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.c-select-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.c-select-chev{color:var(--muted);transition:transform .2s cubic-bezier(.22,1,.36,1);flex-shrink:0}
.c-select.open .c-select-chev{transform:rotate(180deg);color:var(--brand-dark)}
.c-select-menu{position:absolute;left:0;right:0;top:calc(100% + 6px);background:var(--surface);border:1px solid var(--border);border-radius:11px;box-shadow:var(--shadow-md);padding:5px;z-index:260;opacity:0;transform:translateY(-6px) scale(.98);pointer-events:none;transition:opacity .16s ease,transform .18s cubic-bezier(.22,1,.36,1);max-height:240px;overflow-y:auto}
.c-select.open .c-select-menu{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.c-select.drop-up .c-select-menu{top:auto;bottom:calc(100% + 6px);transform:translateY(6px) scale(.98)}
.c-select.drop-up.open .c-select-menu{transform:translateY(0) scale(1)}
.c-select-opt{width:100%;border:none;background:transparent;padding:8px 10px;border-radius:7px;font-size:13px;color:var(--soft);display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;transition:background .12s,color .12s}
.c-select-opt:hover{background:var(--surface-2);color:var(--text)}
.c-select-opt.selected{background:var(--brand-soft);color:var(--brand-dark);font-weight:600}
.c-select-chk{opacity:0;flex-shrink:0}
.c-select-opt.selected .c-select-chk{opacity:1}

/* Animated Toggle Switch */
.tog-switch{position:relative;display:inline-flex;align-items:center;width:40px;height:22px;flex-shrink:0;cursor:pointer}
.tog-switch input{opacity:0;width:0;height:0;position:absolute}
.tog-track{position:absolute;inset:0;background:var(--border-strong);border-radius:999px;transition:background .22s ease}
.tog-thumb{position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.22);transition:transform .24s cubic-bezier(.22,1,.36,1)}
.tog-switch input:checked + .tog-track{background:var(--brand)}
.tog-switch input:checked ~ .tog-thumb{transform:translateX(18px)}

/* Panel & Sliding Pill Animations */
@keyframes panelFadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
.anim-in{animation:panelFadeIn .22s cubic-bezier(.22,1,.36,1)}
.seg-slider{position:absolute;top:3px;bottom:3px;left:0;border-radius:7px;background:var(--surface);box-shadow:var(--shadow-sm);z-index:0;pointer-events:none;transition:transform .26s cubic-bezier(.22,1,.36,1),width .26s cubic-bezier(.22,1,.36,1);will-change:transform,width}

/* Layout */
.app{display:grid;grid-template-columns:var(--sidebar-w,336px) 1px 1fr;height:100vh}
.divider{background:var(--border);cursor:col-resize;position:relative;transition:background .15s}
.divider:hover,.divider.dragging{background:var(--brand)}
.divider::after{content:'';position:absolute;left:-4px;right:-4px;top:0;bottom:0}

/* Sidebar */
.sidebar{background:var(--surface);display:flex;flex-direction:column;height:100vh;overflow:hidden;padding:18px 18px 16px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.brand-icon{width:34px;height:34px;border-radius:10px;background:var(--brand);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 3px 10px rgba(251,114,153,.26)}
.brand-title{font-size:17px;font-weight:800;letter-spacing:-.2px;color:var(--text)}
.brand-sub{font-size:11px;color:var(--muted);margin-top:1px}

/* Top-Left Mode Switcher inside Sidebar */
.side-switcher{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:4px;background:var(--surface-2);padding:3px;border-radius:10px;border:1px solid var(--border);margin-bottom:14px;flex-shrink:0}
.side-sw-btn{position:relative;z-index:1;border:none;background:transparent;height:32px;border-radius:7px;font-size:13px;font-weight:600;color:var(--soft);white-space:nowrap;transition:color .2s ease;display:inline-flex;align-items:center;justify-content:center;gap:5px}
.side-sw-btn:hover{color:var(--text)}
.side-sw-btn.active{color:var(--text)}
.side-pane{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}

/* Submit Bar */
.input-shell{display:flex;align-items:center;gap:6px;background:var(--bg);border:1px solid var(--border);border-radius:11px;padding:4px 4px 4px 12px;transition:border-color .15s,box-shadow .15s}
.input-shell:focus-within{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.input-shell input{flex:1;min-width:0;border:none;background:transparent;font-size:13px;outline:none;height:34px;color:var(--text)}
.input-shell input::placeholder{color:var(--muted)}
.btn-submit{border:none;background:var(--cta);color:var(--cta-text);height:34px;padding:0 14px;border-radius:8px;font-size:13px;font-weight:600;white-space:nowrap;flex-shrink:0;transition:background .15s}
.btn-submit:hover{background:var(--cta-hover)}
.btn-submit:disabled{opacity:.5;cursor:not-allowed}

/* Advanced Collapsible Panel */
.adv-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;margin-top:10px;background:transparent;border:1px solid transparent;border-radius:8px;color:var(--soft);font-size:12.5px;font-weight:500;padding:6px 8px;transition:background .15s,color .15s}
.adv-toggle:hover{background:var(--surface-2);color:var(--text)}
.adv-toggle .caret{transition:transform .18s ease}
.adv-toggle.open .caret{transform:rotate(180deg)}
.adv-box{margin-top:6px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:11px;display:flex;flex-direction:column;gap:10px}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:12px;font-weight:600;color:var(--soft);white-space:nowrap}

/* Toast */
.sb-toast{margin-top:10px;padding:9px 12px;border-radius:9px;font-size:12.5px;line-height:1.5;display:none}
.sb-toast.show{display:block}
.sb-toast.ok{background:var(--ok-soft);color:var(--ok-text)}
.sb-toast.err{background:var(--err-soft);color:var(--err-text);border:1px solid var(--err-border)}
.sb-toast.info{background:var(--surface-2);color:var(--soft)}

/* History & Monitored UP Lists in Sidebar */
.history-wrap{flex:1;min-height:0;display:flex;flex-direction:column;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
.search-box{position:relative;margin-bottom:10px}
.search-box .ctrl{padding-left:34px;background-color:var(--bg);height:36px}
.search-box .s-ic{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none;display:flex}
.quick-add-box{padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:10px;margin-bottom:12px}
.quick-add-label{font-size:11.5px;font-weight:600;color:var(--soft);margin-bottom:6px;display:block}
.quick-add-row{display:flex;gap:6px;align-items:center}
.quick-add-row .ctrl{height:34px;font-size:12.5px;flex:1;min-width:0}
.quick-add-row .btn{height:34px;padding:0 12px;font-size:12.5px}

.history-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 2px}
.history-head h3{font-size:12.5px;font-weight:700;color:var(--soft);display:inline-flex;align-items:center;gap:6px}
.count-pill{font-size:11px;font-weight:600;color:var(--muted);background:var(--surface-2);padding:1px 7px;border-radius:999px}
.text-btn{background:none;border:none;font-size:12px;color:var(--muted);padding:3px 7px;border-radius:6px;white-space:nowrap}
.text-btn:hover{color:var(--text);background:var(--surface-2)}
.text-btn.danger{color:var(--err)}
.batch-bar{display:flex;align-items:center;gap:6px;margin-bottom:8px;padding:6px 8px;background:var(--surface-2);border-radius:8px;font-size:12px}

.history-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px}
.history-list::-webkit-scrollbar{width:5px}
.history-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:99px}
.h-card{position:relative;padding:11px 12px;border:1px solid var(--border);border-radius:11px;background:var(--surface);cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s;display:flex;align-items:flex-start;gap:9px}
.h-card:hover{background:var(--surface-hover);border-color:var(--border-strong)}
.h-card.active{border-color:var(--text);box-shadow:var(--shadow-sm);background:var(--surface)}
[data-theme="dark"] .h-card.active{border-color:var(--brand);box-shadow:inset 3px 0 0 var(--brand)}
.h-body{flex:1;min-width:0}
.h-title{font-size:13px;font-weight:600;line-height:1.45;color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:4px}
.h-meta{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;padding-top:4px}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot.ok{background:var(--ok)}
.dot.pending{background:var(--warn);animation:pulse 1.4s infinite}
.dot.err{background:var(--err)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.h-del{opacity:0;background:none;border:none;color:var(--muted);padding:2px 4px;border-radius:5px;display:inline-flex;transition:opacity .12s,color .12s}
.h-card:hover .h-del{opacity:1}
.h-del:hover{color:var(--err);background:var(--err-soft)}
.h-chk{margin-top:3px;accent-color:var(--brand)}

/* Sidebar Monitored UP Card */
.up-side-card{padding:9px 11px;border:1px solid var(--border);border-radius:11px;background:var(--surface);cursor:pointer;transition:border-color .15s,background .15s;display:flex;align-items:center;gap:10px}
.up-side-card:hover{background:var(--surface-hover);border-color:var(--border-strong)}
.up-side-card.active{border-color:var(--brand);background:var(--brand-soft)}
.up-ava{width:34px;height:34px;border-radius:50%;object-fit:cover;background:var(--surface-2);flex-shrink:0;border:1px solid var(--border)}
.up-ava-fb{width:34px;height:34px;border-radius:50%;background:var(--surface-2);color:var(--soft);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:1px solid var(--border)}
.up-side-info{flex:1;min-width:0}
.up-side-name{font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.up-side-uid{font-size:11.5px;color:var(--muted);font-family:Consolas,monospace;margin-top:1px}
.up-side-card .h-del{opacity:0}
.up-side-card:hover .h-del{opacity:1}

/* Main Workspace */
.main{display:flex;flex-direction:column;height:100vh;overflow:hidden;background:var(--bg);min-width:0}

/* Topbar */
.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;height:56px;padding:0 28px;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
.topbar-title{font-size:14px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-sub{font-size:12px;color:var(--muted);font-weight:400;margin-left:10px}
.topbar-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.pill-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);font-size:12.5px;font-weight:600;white-space:nowrap;transition:border-color .15s,background .15s}
.pill-btn:hover{border-color:var(--border-strong);background:var(--surface-hover)}
.pill-btn.authed{border-color:var(--brand-border);background:var(--brand-soft);color:var(--brand-dark)}
.icon-btn{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--soft);flex-shrink:0}
.icon-btn:hover{border-color:var(--border-strong);color:var(--text);background:var(--surface-hover)}

.content-scroll{flex:1;overflow-y:auto;padding:20px 28px 44px}
.content-inner{max-width:960px;margin:0 auto;transition:max-width .15s}
.content-inner.wide-feed{max-width:1400px}

/* Stepper */
.stepper{display:flex;align-items:center;justify-content:space-between;gap:6px;background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:9px 16px;margin-bottom:14px;font-size:12.5px}
.st-item{display:inline-flex;align-items:center;gap:6px;color:var(--muted);white-space:nowrap;font-weight:500}
.st-item.done{color:var(--text)}
.st-item.done .st-dot{background:var(--ok);border-color:var(--ok);color:#fff}
.st-item.active{color:var(--brand-dark);font-weight:600}
.st-item.active .st-dot{border-color:var(--brand);background:var(--brand-soft)}
.st-dot{width:16px;height:16px;border-radius:50%;border:1.5px solid var(--border-strong);display:inline-flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0}
.st-line{flex:1;height:1px;background:var(--border);min-width:12px}
.st-line.done{background:var(--ok);opacity:.45}
.st-badge{padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.st-badge.ok{background:var(--ok-soft);color:var(--ok-text)}
.st-badge.err{background:var(--err-soft);color:var(--err-text)}
.st-badge.pending{background:var(--warn-soft);color:#B45309}

/* Empty State */
.empty-state{margin:48px auto;max-width:480px;text-align:center;padding:40px 28px;background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-sm)}
.empty-ic{width:48px;height:48px;margin:0 auto 14px;border-radius:12px;background:var(--brand-soft);color:var(--brand);display:flex;align-items:center;justify-content:center}
.empty-state h2{font-size:17px;font-weight:700;margin-bottom:8px}
.empty-state p{font-size:13.5px;color:var(--soft);line-height:1.7}

/* Video Header Card */
.video-head{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 22px;margin-bottom:14px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;box-shadow:var(--shadow-sm)}
.vh-left{min-width:0;flex:1}
.vh-title{font-size:18.5px;font-weight:800;line-height:1.4;color:var(--text);margin-bottom:10px;word-break:break-word}
.vh-title a{color:inherit;text-decoration:none}
.vh-title a:hover{color:var(--brand-dark)}
.vh-pills{display:flex;flex-wrap:wrap;gap:7px}
.meta-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;background:var(--surface-2);color:var(--soft);font-size:12px;font-weight:500;white-space:nowrap}
.watch-btn{display:inline-flex;align-items:center;gap:5px;height:34px;padding:0 13px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);font-size:12.5px;font-weight:600;text-decoration:none;white-space:nowrap;flex-shrink:0;transition:border-color .15s,color .15s}
.watch-btn:hover{border-color:var(--brand);color:var(--brand)}

/* View Tabs + Independent Action Buttons */
.view-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.seg-tabs{position:relative;display:inline-flex;background:var(--surface-2);padding:3px;border-radius:10px;border:1px solid var(--border)}
.seg-tab{position:relative;z-index:1;border:none;background:transparent;padding:6px 14px;border-radius:7px;font-size:13px;font-weight:600;color:var(--soft);white-space:nowrap;transition:color .2s ease}
.seg-tab:hover{color:var(--text)}
.seg-tab.active{color:var(--text)}
.action-group{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.act-btn{display:inline-flex;align-items:center;gap:5px;height:33px;padding:0 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--soft);font-size:12.5px;font-weight:600;white-space:nowrap;transition:border-color .15s,color .15s,background .15s}
.act-btn:hover{border-color:var(--border-strong);color:var(--text);background:var(--surface-hover)}

/* Reading Panels */
.reader-grid{display:grid;grid-template-columns:1fr;gap:16px}
.reader-grid.split{grid-template-columns:1.15fr 1fr;align-items:start}
.reader-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px 26px;box-shadow:var(--shadow-sm)}
.panel-label{font-size:11.5px;font-weight:700;letter-spacing:.7px;color:var(--muted);text-transform:uppercase;margin-bottom:14px}

/* Rendered Rich Summary */
.md-theme-box{background:var(--brand-soft);border-left:3.5px solid var(--brand);border-radius:0 10px 10px 0;padding:14px 18px;margin-bottom:20px}
.md-theme-label{font-size:12px;font-weight:700;color:var(--brand-dark);letter-spacing:.4px;margin-bottom:5px}
.md-theme-body{font-size:14.5px;line-height:1.75;color:var(--text);font-weight:500}
.md-sec-title{font-size:15.5px;font-weight:800;color:var(--text);margin:18px 0 11px}
.md-list{list-style:none;display:flex;flex-direction:column;gap:10px;margin-bottom:18px}
.md-list li{display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:1.75;color:var(--soft)}
.md-num{min-width:22px;height:22px;border-radius:50%;background:var(--surface-2);color:var(--brand-dark);font-size:11.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;margin-top:2px;flex-shrink:0}
.md-list strong,.md-p strong{color:var(--text);font-weight:650}
.md-p{font-size:14px;line-height:1.8;color:var(--soft);margin-bottom:10px}
.md-conclusion{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-top:8px}
.md-conclusion-label{font-size:12px;font-weight:700;color:var(--soft);margin-bottom:5px}
.md-conclusion-body{font-size:13.8px;line-height:1.75;color:var(--soft)}
.md-note{font-size:12px;color:var(--muted);margin-top:8px}
.md-code{background:var(--surface-2);color:var(--brand-dark);padding:1px 6px;border-radius:4px;font-size:12.5px;font-family:Consolas,monospace}
.transcript-box{font-size:13.8px;line-height:1.85;color:var(--soft);white-space:pre-wrap;word-break:break-word;max-height:72vh;overflow-y:auto}
.pending-banner{padding:28px 20px;text-align:center;color:var(--soft);font-size:14px}

/* Failure Diagnostic Card */
.diag-card{background:var(--err-soft);border:1px solid var(--err-border);border-radius:12px;padding:18px 20px}
.diag-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.diag-title{font-size:14.5px;font-weight:700;color:var(--err-text)}
.diag-stage{font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--surface);border:1px solid var(--err-border);color:var(--err-text)}
.diag-rows{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.65;color:var(--text)}
.diag-row{display:grid;grid-template-columns:76px 1fr;gap:8px}
.diag-key{color:var(--soft);font-weight:600}
.diag-foot{margin-top:14px;padding-top:12px;border-top:1px dashed var(--err-border);display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}

/* UP Monitor Feed — Bilibili / YouTube Video Cover Grid */
.mon-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:18px;padding:14px 18px;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow-sm)}
.mon-tb-left h2{font-size:16.5px;font-weight:800;margin-bottom:3px}
.mon-tb-left p{font-size:12.5px;color:var(--soft)}
.mon-tb-actions{display:flex;gap:8px;flex-wrap:wrap}

.video-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(256px,1fr));gap:22px 16px}
.v-card{display:flex;flex-direction:column;min-width:0}
.v-thumb-link{position:relative;display:block;width:100%;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:var(--surface-2);border:1px solid var(--border);text-decoration:none}
.v-thumb-link img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .28s ease}
.v-card:hover .v-thumb-link img{transform:scale(1.035)}
.v-dur{position:absolute;right:8px;bottom:8px;background:rgba(15,17,22,.82);color:#fff;font-size:11.5px;font-weight:600;padding:2px 6px;border-radius:5px;line-height:1.3;font-variant-numeric:tabular-nums;letter-spacing:.2px}
.v-sum-badge{position:absolute;left:8px;top:8px;background:rgba(16,185,129,.92);color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px}
.v-body{display:flex;align-items:flex-start;gap:10px;padding-top:10px}
.v-ava{width:34px;height:34px;border-radius:50%;object-fit:cover;background:var(--surface-2);border:1px solid var(--border);flex-shrink:0;margin-top:2px}
.v-ava-fb{width:34px;height:34px;border-radius:50%;background:var(--surface-2);color:var(--soft);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);flex-shrink:0;margin-top:2px}
.v-meta-col{flex:1;min-width:0}
.v-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;font-weight:700;line-height:1.42;color:var(--text);text-decoration:none;margin-bottom:5px;word-break:break-word}
.v-title:hover{color:var(--brand-dark)}
.v-author{font-size:12.5px;color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.v-stats{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:7px}
.v-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}
.v-time-pill{display:inline-block;background:var(--surface-2);color:var(--soft);font-size:11px;font-weight:500;padding:2px 8px;border-radius:999px;white-space:nowrap}
.v-act-row{display:inline-flex;align-items:center;gap:6px}
.v-act-btn{border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:7px;white-space:nowrap;transition:all .15s}
.v-act-btn:hover{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-soft)}
.v-act-btn.primary{background:var(--cta);color:var(--cta-text);border-color:transparent}
.v-act-btn.primary:hover{background:var(--cta-hover);color:var(--cta-text)}

/* Modals */
.modal-backdrop{position:fixed;inset:0;background:rgba(10,12,18,.52);backdrop-filter:blur(4px);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-lg);width:100%;max-width:420px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden}
.modal.wide{max-width:860px}
.modal.reader{max-width:740px}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border);gap:12px}
.modal-head h2{font-size:16px;font-weight:800;line-height:1.4}
.modal-body{padding:20px 22px;overflow-y:auto;flex:1}
.modal-foot{padding:14px 22px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--bg);flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border-radius:9px;font-size:13px;font-weight:600;border:1px solid var(--border);background:var(--surface);color:var(--text);white-space:nowrap;text-decoration:none;transition:background .15s,border-color .15s}
.btn:hover{background:var(--surface-hover);border-color:var(--border-strong)}
.btn-sm{height:30px;padding:0 11px;font-size:12px;border-radius:7px}
.btn-primary{background:var(--cta);color:var(--cta-text);border-color:transparent}
.btn-primary:hover{background:var(--cta-hover);border-color:transparent}
.btn-brand{background:var(--brand);color:#fff;border-color:transparent}
.btn-brand:hover{opacity:.92;border-color:transparent}

/* Modal Form Sections */
.m-tabs{position:relative;display:inline-flex;gap:4px;margin-bottom:18px;background:var(--surface-2);padding:3px;border-radius:9px;border:1px solid var(--border)}
.m-tab{position:relative;z-index:1;border:none;background:transparent;padding:6px 14px;border-radius:7px;font-size:13px;font-weight:600;color:var(--soft);white-space:nowrap;transition:color .2s ease}
.m-tab:hover{color:var(--text)}
.m-tab.active{color:var(--text)}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.form-section{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px}
.sec-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.sec-head h4{font-size:13.5px;font-weight:700;color:var(--text)}
.chip-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:12.5px}
.chip b{font-weight:600;color:var(--text)}
.chip small{color:var(--muted);font-family:Consolas,monospace;font-size:11px}
.chip button{border:none;background:none;color:var(--muted);font-size:14px;line-height:1;padding:0 2px}
.chip button:hover{color:var(--err)}
.inline-add{display:flex;gap:8px;align-items:center}
.inline-add .ctrl{flex:1;min-width:0}
.switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.switch-row input[type=checkbox]{width:18px;height:18px;accent-color:var(--brand);cursor:pointer;flex-shrink:0}
.cron-badge{font-family:Consolas,monospace;font-size:12px;padding:3px 9px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--brand-dark);white-space:nowrap}

/* Email Style Selector */
.style-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
.style-card{border:2px solid var(--border);border-radius:11px;padding:8px;background:var(--surface);cursor:pointer;transition:all .15s;text-align:left}
.style-card:hover{border-color:var(--border-strong)}
.style-card.selected{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.style-thumb{height:66px;border-radius:7px;overflow:hidden;border:1px solid var(--border);margin-bottom:7px;display:flex;flex-direction:column}
.st-hd{height:19px;padding:4px 6px;display:flex;align-items:center;gap:4px}
.st-bar{height:4px;border-radius:2px;width:45%}
.st-bd{flex:1;padding:5px 6px;display:flex;flex-direction:column;gap:4px}
.st-line{height:4px;border-radius:2px;background:#e5e7eb}
.style-name{font-size:12.5px;font-weight:700;color:var(--text)}
.style-desc{font-size:11px;color:var(--muted);margin-top:2px}
.email-preview-frame{width:100%;height:370px;border:1px solid var(--border);border-radius:10px;background:#fff}

/* Responsive */
@media(max-width:1100px){
  .app{grid-template-columns:300px 1px 1fr}
  .topbar{padding:0 18px}
  .content-scroll{padding:18px}
}
@media(max-width:860px){
  html,body{overflow:auto;height:auto}
  .app{grid-template-columns:1fr;height:auto;min-height:100vh}
  .sidebar{height:auto;overflow:visible;border-bottom:1px solid var(--border)}
  .history-list{max-height:260px}
  .divider{display:none}
  .main{height:auto;overflow:visible}
  .topbar{padding:10px 16px;height:auto}
  .content-scroll{padding:16px}
  .stepper{padding:8px 10px;font-size:11.5px;gap:4px}
  .st-dot{width:14px;height:14px}
  .video-head{flex-direction:column}
  .reader-grid.split{grid-template-columns:1fr}
  .style-grid{grid-template-columns:repeat(2,1fr)}
  .form-row{grid-template-columns:1fr}
  .video-grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
}
</style>
</head>
<body>
<div class="app" id="appRoot">
  <!-- LEFT SIDEBAR -->
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 3l3 3M16 3l-3 3"/>
          <rect x="3" y="6" width="18" height="14" rx="4"/>
          <path d="M9 12v2M15 12v2"/>
        </svg>
      </div>
      <div>
        <div class="brand-title">B站AI摘要</div>
        <div class="brand-sub">视频语音转录 · 精炼日报</div>
      </div>
    </div>

    <!-- Top-Left Sidebar Mode Switcher -->
    <div class="side-switcher" id="sideSwitcher">
      <span class="seg-slider"></span>
      <button class="side-sw-btn active" data-page="workspace" onclick="switchPage('workspace')">单条摘要</button>
      <button class="side-sw-btn" data-page="monitor" onclick="switchPage('monitor')">UP主监控</button>
    </div>

    <!-- SIDEBAR PANE A: SINGLE VIDEO WORKSPACE -->
    <div class="side-pane" id="sidebarWorkspace">
      <div class="input-shell">
        <input id="videoUrl" type="text" placeholder="输入B站视频链接或 BV 号..." autocomplete="off" onkeydown="if(event.key==='Enter')submitVideo()">
        <button class="btn-submit" id="submitBtn" onclick="submitVideo()">开始总结</button>
      </div>

      <button class="adv-toggle" id="advToggleBtn" type="button" onclick="toggleAdv()">
        <span>高级配置（模板 / 邮箱 / 样式）</span>
        <svg class="ic caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
      </button>

      <div class="adv-box hidden" id="advBox">
        <div class="field">
          <label>总结模板</label>
          <select class="ctrl" id="tplPreset" onchange="onTplPreset()">
            <option value="">默认精炼日报模板</option>
            <option value="notes">深度结构化笔记</option>
            <option value="quotes">金句与核心观点提取</option>
            <option value="custom">自定义提示词模板</option>
          </select>
        </div>
        <div class="field hidden" id="customTplWrap">
          <label>自定义模板（含 {content} 占位符）</label>
          <textarea class="ctrl" id="customTpl" placeholder="请根据以下视频内容提取核心干货：\n{content}"></textarea>
        </div>
        <div class="field">
          <label>单条结果接收邮箱（可选）</label>
          <input class="ctrl" id="customEmail" type="email" placeholder="留空则发至默认邮箱">
        </div>
        <div class="field">
          <label>单条邮件样式</label>
          <select class="ctrl" id="singleEmailStyle">
            <option value="editorial">编辑部日报（深色报头 · 默认）</option>
            <option value="minimal">极简纸刊（纯白 Notion 风）</option>
            <option value="bilibili">B站元气粉（樱花粉渐变）</option>
            <option value="compact">极速速览（高密度紧凑）</option>
          </select>
        </div>
      </div>

      <div class="sb-toast" id="sbToast"></div>

      <div class="history-wrap">
        <div class="search-box">
          <span class="s-ic">
            <svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          </span>
          <input class="ctrl" id="searchInput" type="text" placeholder="搜索历史记录..." oninput="renderList()">
        </div>
        <div class="history-head">
          <h3>历史记录 <span class="count-pill" id="countPill">0</span></h3>
          <button class="text-btn" id="batchToggleBtn" onclick="toggleBatchMode()">管理</button>
        </div>
        <div class="batch-bar hidden" id="batchBar">
          <button class="text-btn" onclick="selectAllJobs()">全选</button>
          <button class="text-btn" onclick="invertSelectJobs()">反选</button>
          <button class="text-btn danger" style="margin-left:auto" onclick="deleteSelectedJobs()">删除已选</button>
        </div>
        <div class="history-list" id="historyList"></div>
      </div>
    </div>

    <!-- SIDEBAR PANE B: MONITORED UP CREATORS -->
    <div class="side-pane hidden" id="sidebarMonitor">
      <div class="search-box">
        <span class="s-ic">
          <svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        </span>
        <input class="ctrl" id="upSearchInput" type="text" placeholder="搜索已监控 UP 主（昵称或 UID）..." oninput="renderUpSidebar()">
      </div>

      <!-- Quick Add Monitor Control between Search Box and UP List -->
      <div class="quick-add-box">
        <span class="quick-add-label">添加监控 UP 主</span>
        <div class="quick-add-row">
          <input class="ctrl" id="sideAddUpInput" type="text" placeholder="输入 UID 或主页链接..." onkeydown="if(event.key==='Enter')quickAddMonitorUp()">
          <button class="btn btn-primary" type="button" id="sideAddUpBtn" onclick="quickAddMonitorUp()">添加</button>
        </div>
        <div class="sb-toast" id="sideUpToast" style="margin-top:8px"></div>
      </div>

      <div class="history-head">
        <h3>已监控 UP 主 <span class="count-pill" id="upSideCount">0</span></h3>
        <button class="text-btn" onclick="openMonitorModal()">完整配置</button>
      </div>
      <div class="history-list" id="upSideList"></div>
    </div>
  </aside>

  <div class="divider" id="divider"></div>

  <!-- RIGHT MAIN PANEL -->
  <main class="main">
    <header class="topbar">
      <div style="min-width:0;display:flex;align-items:baseline">
        <span class="topbar-title" id="topbarTitle">单条视频摘要</span>
        <span class="topbar-sub" id="topbarSub"></span>
      </div>

      <div class="topbar-actions">
        <button class="pill-btn" id="settingsBtn" onclick="openSettingsModal()">
          <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span>设置</span>
        </button>
        <button class="pill-btn" id="monitorBtn" onclick="openMonitorEntry()">
          <span id="monitorBtnIcon"></span>
          <span id="monitorBtnText">登录管理</span>
        </button>
        <button class="icon-btn" id="themeBtn" onclick="toggleTheme()" title="切换浅色 / 暗色主题"></button>
      </div>
    </header>

    <div class="content-scroll">
      <div class="content-inner" id="contentInner">
        <!-- PAGE 1: SINGLE VIDEO WORKSPACE -->
        <div id="pageWorkspace">
          <div class="stepper hidden" id="stepperBar"></div>

          <div class="empty-state" id="emptyState">
            <div class="empty-ic">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
            <h2>粘贴 B 站链接，一键提炼视频精华</h2>
            <p>支持 B 站完整链接、分享文案或 BV / av 号。系统自动提取音频、免费语音转文字并生成结构化摘要；切换左侧「UP主监控」可浏览全部订阅 UP 主的封面动态流。</p>
          </div>

          <div id="detailView" class="hidden">
            <section class="video-head">
              <div class="vh-left">
                <h1 class="vh-title"><a id="dTitleLink" href="#" target="_blank" rel="noopener">—</a></h1>
                <div class="vh-pills" id="dPills"></div>
              </div>
              <a class="watch-btn" id="dWatchLink" href="#" target="_blank" rel="noopener">
                <span>在B站观看</span>
                <svg class="ic" viewBox="0 0 24 24"><path d="M7 17L17 7M7 7h10v10"/></svg>
              </a>
            </section>

            <div class="view-bar">
              <div class="seg-tabs" id="segTabs">
                <span class="seg-slider"></span>
                <button class="seg-tab active" data-mode="summary" onclick="setViewMode('summary')">AI 总结</button>
                <button class="seg-tab" data-mode="transcript" onclick="setViewMode('transcript')">完整转录</button>
                <button class="seg-tab" data-mode="split" onclick="setViewMode('split')">分栏对照</button>
              </div>
              <div class="action-group">
                <button class="act-btn" id="copyBtn" onclick="copyCurrent()">
                  <svg class="ic" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  <span>复制</span>
                </button>
                <button class="act-btn" onclick="exportFile('md')">
                  <svg class="ic" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span>导出 MD</span>
                </button>
                <button class="act-btn" onclick="exportFile('txt')">
                  <span>导出 TXT</span>
                </button>
              </div>
            </div>

            <div class="reader-grid" id="readerGrid">
              <article class="reader-card" id="summaryPanel">
                <div class="panel-label hidden" id="summaryPanelLabel">AI 总结</div>
                <div id="summaryContent"></div>
              </article>
              <article class="reader-card hidden" id="transcriptPanel">
                <div class="panel-label">完整语音转录</div>
                <div class="transcript-box" id="transcriptContent"></div>
              </article>
            </div>
          </div>
        </div>

        <!-- PAGE 2: MONITORED UP CREATORS VIDEO COVER GRID -->
        <div id="pageMonitor" class="hidden">
          <div class="mon-toolbar">
            <div class="mon-tb-left">
              <h2 id="monFeedHeading">全部监控 UP 主动态</h2>
              <p id="monSummaryLine">正在加载监控配置...</p>
            </div>
            <div class="mon-tb-actions">
              <button class="btn" id="refreshFeedBtn" onclick="fetchUpFeed(selectedUpMid, true)">刷新动态</button>
              <button class="btn" onclick="openMonitorModal()">定时与样式设置</button>
              <button class="btn btn-primary" onclick="triggerMonitorNow('feedToast')">立即巡检</button>
            </div>
          </div>
          <div class="sb-toast" id="feedToast" style="margin-bottom:14px"></div>

          <div class="video-grid" id="upFeedGrid"></div>
        </div>
      </div>
    </div>
  </main>
</div>

<!-- INLINE SUMMARY READER MODAL (FOR VIDEO COVER CARDS) -->
<div class="modal-backdrop hidden" id="summaryModal" onclick="if(event.target===this)closeModal('summaryModal')">
  <div class="modal reader">
    <div class="modal-head">
      <h2 id="smTitle">视频 AI 摘要</h2>
      <button class="icon-btn" onclick="closeModal('summaryModal')" aria-label="关闭">
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body" id="smBody"></div>
    <div class="modal-foot">
      <a class="btn" id="smWatchLink" href="#" target="_blank" rel="noopener">在B站观看 ↗</a>
      <div style="display:flex;gap:8px">
        <button class="btn" id="smCopyBtn" onclick="copyModalSummary()">复制摘要</button>
        <button class="btn btn-primary" onclick="closeModal('summaryModal')">关闭</button>
      </div>
    </div>
  </div>
</div>

<!-- SETTINGS MODAL (PREFERENCES + SINGLE-VIDEO EMAIL TOGGLE) -->
<div class="modal-backdrop hidden" id="settingsModal" onclick="if(event.target===this)closeModal('settingsModal')">
  <div class="modal reader">
    <div class="modal-head">
      <div>
        <h2>偏好与系统设置</h2>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">配置保存在当前浏览器，即时生效于后续单条视频摘要任务</div>
      </div>
      <button class="icon-btn" onclick="closeModal('settingsModal')" aria-label="关闭">
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="form-section">
        <div class="sec-head">
          <h4>单条摘要邮件通知</h4>
        </div>
        <div class="switch-row" style="margin-bottom:14px">
          <div>
            <div style="font-size:13.5px;font-weight:700">单条视频总结完成后发送邮件</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px">关闭后，网页端手动提交的单条视频总结仅保存在页面与 R2，不再发送邮箱提醒</div>
          </div>
          <label class="tog-switch">
            <input type="checkbox" id="prefSendEmail">
            <span class="tog-track"></span>
            <span class="tog-thumb"></span>
          </label>
        </div>
        <div class="form-row">
          <div class="field">
            <label>默认单条邮件样式</label>
            <select class="ctrl" id="prefEmailStyle">
              <option value="editorial">编辑部日报（深色报头 · 默认）</option>
              <option value="minimal">极简纸刊（纯白 Notion 风）</option>
              <option value="bilibili">B站元气粉（樱花粉渐变）</option>
              <option value="compact">极速速览（高密度紧凑）</option>
            </select>
          </div>
          <div class="field">
            <label>默认单条接收邮箱（可选）</label>
            <input class="ctrl" id="prefDefaultEmail" type="email" placeholder="留空则使用服务端默认邮箱">
          </div>
        </div>
      </div>

      <div class="form-section">
        <div class="sec-head">
          <h4>摘要与阅读偏好</h4>
        </div>
        <div class="form-row">
          <div class="field">
            <label>默认总结模板</label>
            <select class="ctrl" id="prefDefaultTpl">
              <option value="">默认精炼日报模板</option>
              <option value="notes">深度结构化笔记</option>
              <option value="quotes">金句与核心观点提取</option>
            </select>
          </div>
          <div class="field">
            <label>默认阅读视图</label>
            <select class="ctrl" id="prefDefaultView">
              <option value="summary">AI 总结</option>
              <option value="transcript">完整转录</option>
              <option value="split">分栏对照</option>
            </select>
          </div>
        </div>
      </div>

      <div class="form-section" style="margin-bottom:0">
        <div class="sec-head">
          <h4>缓存与运行状态</h4>
          <span class="cron-badge" id="sysStatsBadge">读取中...</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <span style="font-size:12.5px;color:var(--soft)">如发现 UP 主动态未及时更新，可清空本地动态缓存重新拉取</span>
          <button class="btn btn-sm" type="button" onclick="clearAllFeedCacheFromSettings()">清空 UP 主动态缓存</button>
        </div>
      </div>
      <div class="sb-toast" id="settingsToast"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" type="button" onclick="resetUserPrefs()">恢复默认</button>
      <div style="display:flex;gap:8px">
        <button class="btn" type="button" onclick="closeModal('settingsModal')">取消</button>
        <button class="btn btn-brand" type="button" onclick="saveUserPrefs()">保存设置</button>
      </div>
    </div>
  </div>
</div>

<!-- LOGIN MODAL -->
<div class="modal-backdrop hidden" id="loginModal" onclick="if(event.target===this)closeModal('loginModal')">
  <div class="modal">
    <div class="modal-head">
      <h2>管理员登录</h2>
      <button class="icon-btn" onclick="closeModal('loginModal')" aria-label="关闭">
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--soft);margin-bottom:14px;line-height:1.65">
        登录后可切换「UP主监控」浏览订阅封面动态流，并在线配置监控名单、Shy Cron 定时策略与日报邮件样式。
      </p>
      <div class="field" style="margin-bottom:12px">
        <label>账号</label>
        <input class="ctrl" id="loginUser" type="text" placeholder="请输入管理员账号" value="shiran">
      </div>
      <div class="field">
        <label>密码</label>
        <input class="ctrl" id="loginPass" type="password" placeholder="请输入管理员密码" onkeydown="if(event.key==='Enter')doLogin()">
      </div>
      <div class="sb-toast" id="loginToast"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal('loginModal')">取消</button>
      <button class="btn btn-primary" id="loginSubmitBtn" onclick="doLogin()">登录</button>
    </div>
  </div>
</div>

<!-- MONITOR & DAILY BRIEFING SETTINGS MODAL -->
<div class="modal-backdrop hidden" id="monitorModal" onclick="if(event.target===this)closeModal('monitorModal')">
  <div class="modal wide">
    <div class="modal-head">
      <div>
        <h2>监控与日报样式配置</h2>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">配置保存在 Cloudflare R2，定时策略自动同步至 Shy Cron</div>
      </div>
      <button class="icon-btn" onclick="closeModal('monitorModal')" aria-label="关闭">
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="m-tabs" id="monitorTabs">
        <span class="seg-slider"></span>
        <button class="m-tab active" data-mtab="schedule" onclick="switchMonitorTab('schedule')">定时与 UP 主监控</button>
        <button class="m-tab" data-mtab="email" onclick="switchMonitorTab('email')">邮件样式与实时预览</button>
      </div>

      <!-- TAB 1 -->
      <div id="mTabSchedule">
        <div class="form-section">
          <div class="switch-row">
            <div>
              <div style="font-size:13.5px;font-weight:700">启用自动定时监控</div>
              <div style="font-size:12px;color:var(--muted);margin-top:2px">开启后通过 Shy Cron 按设定时间自动触发 GitHub Actions 抓取新视频</div>
            </div>
            <label class="tog-switch">
              <input type="checkbox" id="cfgEnabled" checked>
              <span class="tog-track"></span>
              <span class="tog-thumb"></span>
            </label>
          </div>
        </div>

        <div class="form-section">
          <div class="sec-head">
            <h4>定时运行计划（北京时间 UTC+8）</h4>
            <span class="cron-badge" id="cronUtcPreview">UTC Cron: 0 0,12 * * *</span>
          </div>
          <div class="form-row">
            <div class="field">
              <label>调度模式</label>
              <select class="ctrl" id="cfgScheduleMode" onchange="onScheduleModeChange()">
                <option value="times">指定每天运行时间（北京时间）</option>
                <option value="every_12h">每 12 小时（08:00 / 20:00）</option>
                <option value="every_6h">每 6 小时运行一次</option>
                <option value="custom">自定义 5 位 UTC Cron 表达式</option>
              </select>
            </div>
            <div class="field" id="customCronWrap" style="display:none">
              <label>UTC Cron 表达式（5位）</label>
              <input class="ctrl" id="cfgCustomCron" type="text" placeholder="0 0,12 * * *" oninput="updateCronPreview()">
            </div>
            <div class="field" id="timeAddWrap">
              <label>添加每日运行时间点</label>
              <div class="inline-add">
                <input class="ctrl" id="newTimeInput" type="time" value="08:00">
                <button class="btn" type="button" onclick="addTimeSlot()">+ 添加</button>
              </div>
            </div>
          </div>
          <div class="chip-list" id="timeChips"></div>
          <div id="cronSyncStatus" style="margin-top:10px;font-size:12px;color:var(--muted)"></div>
        </div>

        <div class="form-section">
          <div class="sec-head">
            <h4>监控 UP 主列表（<span id="upCountLabel">0</span> 位）</h4>
          </div>
          <div class="inline-add">
            <input class="ctrl" id="newUpInput" type="text" placeholder="输入 UP 主 UID 或主页链接（如 346563107 或 https://space.bilibili.com/346563107）" onkeydown="if(event.key==='Enter')addUpCreator()">
            <button class="btn btn-primary" type="button" id="addUpBtn" onclick="addUpCreator()">解析并添加</button>
          </div>
          <div class="chip-list" id="upChips"></div>
        </div>

        <div class="form-section" style="margin-bottom:0">
          <div class="sec-head">
            <h4>扫描策略</h4>
          </div>
          <div class="form-row">
            <div class="field">
              <label>扫描时间窗口</label>
              <select class="ctrl" id="cfgWindowHours">
                <option value="24">最近 24 小时</option>
                <option value="48">最近 48 小时</option>
                <option value="72">最近 72 小时（3天）</option>
                <option value="168">最近 7 天</option>
              </select>
            </div>
            <div class="field">
              <label>单次每位 UP 主最多处理条数</label>
              <select class="ctrl" id="cfgMaxVideos">
                <option value="3">最多 3 支</option>
                <option value="5">最多 5 支</option>
                <option value="10">最多 10 支</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 2 -->
      <div id="mTabEmail" class="hidden">
        <div class="form-section">
          <div class="sec-head">
            <h4>选择日报邮件样式（点击切换实时预览）</h4>
          </div>
          <div class="style-grid" id="styleGrid">
            <button type="button" class="style-card" data-style="editorial" onclick="selectEmailStyle('editorial')">
              <div class="style-thumb" style="background:#f8fafc">
                <div class="st-hd" style="background:#111827;border-top:3px solid #fb7299"><div class="st-bar" style="background:#fff"></div></div>
                <div class="st-bd">
                  <div style="height:12px;background:#fff5f7;border-left:2px solid #fb7299;border-radius:2px"></div>
                  <div class="st-line" style="width:85%"></div>
                  <div class="st-line" style="width:65%"></div>
                </div>
              </div>
              <div class="style-name">编辑部日报</div>
              <div class="style-desc">深炭灰报头 · 珊瑚粉饰条</div>
            </button>
            <button type="button" class="style-card" data-style="minimal" onclick="selectEmailStyle('minimal')">
              <div class="style-thumb" style="background:#ffffff">
                <div class="st-hd" style="background:#ffffff;border-top:3px solid #111827;border-bottom:1px solid #e5e7eb"><div class="st-bar" style="background:#111827"></div></div>
                <div class="st-bd">
                  <div style="height:12px;background:#f9fafb;border-left:2px solid #111827;border-radius:2px"></div>
                  <div class="st-line" style="width:80%"></div>
                  <div class="st-line" style="width:60%"></div>
                </div>
              </div>
              <div class="style-name">极简纸刊</div>
              <div class="style-desc">纯白留白 · Notion 质感</div>
            </button>
            <button type="button" class="style-card" data-style="bilibili" onclick="selectEmailStyle('bilibili')">
              <div class="style-thumb" style="background:#fffbfc">
                <div class="st-hd" style="background:linear-gradient(135deg,#fb7299,#ff8fab)"><div class="st-bar" style="background:#fff"></div></div>
                <div class="st-bd">
                  <div style="height:12px;background:#fff1f5;border-left:2px solid #fb7299;border-radius:2px"></div>
                  <div class="st-line" style="width:82%;background:#fbcfe8"></div>
                  <div class="st-line" style="width:62%;background:#fce7f3"></div>
                </div>
              </div>
              <div class="style-name">B站元气粉</div>
              <div class="style-desc">樱花粉渐变 · 社区轻快</div>
            </button>
            <button type="button" class="style-card" data-style="compact" onclick="selectEmailStyle('compact')">
              <div class="style-thumb" style="background:#ffffff">
                <div class="st-hd" style="background:#0f172a;border-top:3px solid #38bdf8"><div class="st-bar" style="background:#7dd3fc"></div></div>
                <div class="st-bd" style="gap:3px">
                  <div style="height:9px;background:#f0f9ff;border-left:2px solid #0284c7"></div>
                  <div class="st-line" style="width:90%"></div>
                  <div class="st-line" style="width:75%"></div>
                  <div class="st-line" style="width:68%"></div>
                </div>
              </div>
              <div class="style-name">极速速览</div>
              <div class="style-desc">高密度紧凑 · 多UP扫读</div>
            </button>
          </div>

          <div class="form-row">
            <div class="switch-row" style="height:38px;padding:0 12px;background:var(--surface);border:1px solid var(--border);border-radius:9px">
              <span style="font-size:12.5px;font-weight:600">多 UP 主合并为同一封日报</span>
              <label class="tog-switch">
                <input type="checkbox" id="cfgMergeEmails" checked onchange="renderEmailPreview()">
                <span class="tog-track"></span>
                <span class="tog-thumb"></span>
              </label>
            </div>
            <div class="field">
              <input class="ctrl" id="cfgSmtpTo" type="email" placeholder="自定义收件邮箱（留空用默认 Secret）">
            </div>
          </div>
        </div>

        <div style="font-size:12px;font-weight:700;color:var(--soft);margin-bottom:8px">实时仿真日报预览（标题均可直接跳转 B 站原视频页）</div>
        <iframe id="emailPreviewFrame" class="email-preview-frame" title="邮件样式预览"></iframe>
      </div>

      <div class="sb-toast" id="monitorToast"></div>
    </div>
    <div class="modal-foot">
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" type="button" onclick="doLogout()">退出登录</button>
        <button class="btn" type="button" id="runNowBtn" onclick="triggerMonitorNow('monitorToast')">立即运行一次监控</button>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" type="button" onclick="closeModal('monitorModal')">关闭</button>
        <button class="btn btn-brand" type="button" id="saveMonitorBtn" onclick="saveMonitorConfig()">保存并同步定时任务</button>
      </div>
    </div>
  </div>
</div>

<script>
const LS_JOBS = 'bilisum_jobs_v3';
const LS_THEME = 'bilisum_theme_v3';
const LS_AUTH = 'bilisum_auth_token';
const LS_USER = 'bilisum_auth_user';

let currentPage = 'workspace';
let selectedJobId = null;
let selectedUpMid = 'all';
let currentFeedVideos = [];
let modalSummaryRaw = '';
let viewMode = 'summary';
let batchMode = false;
let selectedIds = [];
let pollTimers = {};
let authUser = '';
let monitorConfig = {
  enabled: true,
  schedule_mode: 'times',
  times_cst: ['08:00', '20:00'],
  cron_utc: '0 0,12 * * *',
  up_list: [],
  email_style: 'editorial',
  merge_emails: true,
  smtp_to: '',
  check_window_hours: 72,
  max_videos_per_run: 5,
};

const TPL_PRESETS = {
  notes: '请将以下视频内容整理为结构化深度笔记，包含核心论点、论据案例、关键数据与行动建议：\n{content}',
  quotes: '请提取以下视频中的核心观点与高价值原话金句（5-8条），并附简要背景解读：\n{content}',
};

const SVG_LOCK = '<svg class="ic" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const SVG_SLIDERS = '<svg class="ic" viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>';
const SVG_SUN = '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const SVG_MOON = '<svg class="ic" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const SVG_CLOSE_SM = '<svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function normStatus(st) {
  if (st === 'done' || st === 'success' || st === 'completed') return 'completed';
  if (st === 'failed' || st === 'error') return 'failed';
  return 'pending';
}

function showToast(elId, msg, kind) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = 'sb-toast show ' + (kind || 'info');
  if (kind === 'ok' || kind === 'info') setTimeout(() => { el.classList.remove('show'); }, 4500);
}

function fmtCount(n) {
  const num = Number(n) || 0;
  if (num >= 100000000) return (num / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿次';
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + ' 万次';
  return num + ' 次';
}

function fmtDanmaku(n) {
  const num = Number(n) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + ' 万弹幕';
  return num + ' 弹幕';
}

function fmtRelativeTime(unixSec) {
  if (!unixSec) return '';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(unixSec));
  if (diff < 3600) return Math.max(1, Math.floor(diff / 60)) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  const days = Math.floor(diff / 86400);
  if (days < 7) return days + '天前';
  if (days < 30) return Math.floor(days / 7) + '个星期前';
  if (days < 365) return Math.floor(days / 30) + '个月前';
  return Math.floor(days / 365) + '年前';
}

// ── Theme ──
function initTheme() {
  const saved = localStorage.getItem(LS_THEME) || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('themeBtn').innerHTML = saved === 'dark' ? SVG_SUN : SVG_MOON;
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(LS_THEME, next);
  document.getElementById('themeBtn').innerHTML = next === 'dark' ? SVG_SUN : SVG_MOON;
}

// ── Sidebar Divider Drag ──
(function initDivider() {
  const div = document.getElementById('divider');
  let dragging = false;
  div.addEventListener('mousedown', () => { dragging = true; div.classList.add('dragging'); document.body.style.userSelect = 'none'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.max(260, Math.min(480, e.clientX));
    document.getElementById('appRoot').style.setProperty('--sidebar-w', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; div.classList.remove('dragging'); document.body.style.userSelect = '';
  });
})();

// ── Advanced Panel ──
function toggleAdv() {
  const box = document.getElementById('advBox');
  const btn = document.getElementById('advToggleBtn');
  const isNowHidden = box.classList.toggle('hidden');
  btn.classList.toggle('open', !isNowHidden);
}
function onTplPreset() {
  const v = document.getElementById('tplPreset').value;
  document.getElementById('customTplWrap').classList.toggle('hidden', v !== 'custom');
}

// ── Smooth Sliding Pill Indicator & Micro-Fade Helper ──
function moveSlider(containerId, instant) {
  const box = document.getElementById(containerId);
  if (!box) return;
  const slider = box.querySelector('.seg-slider');
  const active = box.querySelector('.active');
  if (!slider || !active || active.offsetWidth === 0) return;
  if (instant) {
    const prev = slider.style.transition;
    slider.style.transition = 'none';
    slider.style.width = active.offsetWidth + 'px';
    slider.style.transform = 'translateX(' + active.offsetLeft + 'px)';
    slider.offsetHeight; // force reflow
    slider.style.transition = prev || '';
  } else {
    slider.style.width = active.offsetWidth + 'px';
    slider.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  }
}

function updateAllSliders(instant) {
  ['sideSwitcher', 'segTabs', 'monitorTabs'].forEach(id => moveSlider(id, instant));
}

function playAnim(el) {
  if (!el) return;
  el.classList.remove('anim-in');
  void el.offsetWidth;
  el.classList.add('anim-in');
}

window.addEventListener('resize', () => updateAllSliders(true));

// ── Custom Card-Style Select Dropdown Engine ──
const SVG_CHEV = '<svg class="ic c-select-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
const SVG_CHK = '<svg class="ic c-select-chk" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

function closeAllCustomSelects(exceptWrap) {
  document.querySelectorAll('.c-select.open').forEach(w => {
    if (w !== exceptWrap) w.classList.remove('open', 'drop-up');
  });
}

function syncCustomSelect(sel) {
  if (typeof sel === 'string') sel = document.getElementById(sel);
  if (!sel || !sel._csWrap) return;
  const wrap = sel._csWrap;
  const opt = sel.options[sel.selectedIndex] || sel.options[0];
  wrap.querySelector('.c-select-label').textContent = opt ? opt.textContent : '';
  wrap.querySelectorAll('.c-select-opt').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.val === sel.value);
  });
}

function syncAllCustomSelects() {
  document.querySelectorAll('select.c-select-native').forEach(syncCustomSelect);
}

function initCustomSelects() {
  document.querySelectorAll('select.ctrl').forEach(sel => {
    if (sel._csWrap) return;
    const wrap = document.createElement('div');
    wrap.className = 'c-select';
    sel.parentNode.insertBefore(wrap, sel);
    sel.classList.add('c-select-native');
    wrap.appendChild(sel);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'c-select-btn';
    btn.innerHTML = '<span class="c-select-label"></span>' + SVG_CHEV;

    const menu = document.createElement('div');
    menu.className = 'c-select-menu';

    Array.from(sel.options).forEach(o => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'c-select-opt';
      item.dataset.val = o.value;
      item.innerHTML = '<span>' + esc(o.textContent) + '</span>' + SVG_CHK;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        sel.value = o.value;
        syncCustomSelect(sel);
        wrap.classList.remove('open', 'drop-up');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      menu.appendChild(item);
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !wrap.classList.contains('open');
      closeAllCustomSelects(wrap);
      if (willOpen) {
        const rect = btn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        wrap.classList.toggle('drop-up', spaceBelow < 210);
        wrap.classList.add('open');
      } else {
        wrap.classList.remove('open', 'drop-up');
      }
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    sel._csWrap = wrap;
    syncCustomSelect(sel);
  });
}

document.addEventListener('click', () => closeAllCustomSelects(null));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllCustomSelects(null); });

// ── Top-Left Sidebar Switcher (Single Video vs UP Monitor) ──
async function switchPage(page) {
  if (page === 'monitor' && !authUser) {
    openModal('loginModal');
    setTimeout(() => document.getElementById('loginPass').focus(), 60);
    return;
  }
  currentPage = page;
  document.querySelectorAll('#sideSwitcher .side-sw-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  moveSlider('sideSwitcher');
  const sbWs = document.getElementById('sidebarWorkspace');
  const sbMon = document.getElementById('sidebarMonitor');
  const pgWs = document.getElementById('pageWorkspace');
  const pgMon = document.getElementById('pageMonitor');
  sbWs.classList.toggle('hidden', page !== 'workspace');
  sbMon.classList.toggle('hidden', page !== 'monitor');
  pgWs.classList.toggle('hidden', page !== 'workspace');
  pgMon.classList.toggle('hidden', page !== 'monitor');
  playAnim(page === 'workspace' ? sbWs : sbMon);
  playAnim(page === 'workspace' ? pgWs : pgMon);
  document.getElementById('contentInner').classList.toggle('wide-feed', page === 'monitor');

  if (page === 'workspace') {
    document.getElementById('topbarTitle').textContent = '单条视频摘要';
    document.getElementById('topbarSub').textContent = '';
    requestAnimationFrame(() => moveSlider('segTabs', true));
  } else {
    document.getElementById('topbarTitle').textContent = 'UP主监控动态';
    await loadMonitorPage();
  }
}

// ── Jobs Storage ──
function getJobs() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_JOBS) || localStorage.getItem('b2t_jobs_v2') || '[]');
    return Array.isArray(raw) ? raw.map(j => ({ ...j, status: normStatus(j.status) })) : [];
  } catch { return []; }
}
function saveJobs(jobs, syncR2 = true) {
  const normalized = jobs.map(j => ({ ...j, status: normStatus(j.status) }));
  localStorage.setItem(LS_JOBS, JSON.stringify(normalized));
  renderList();
  if (syncR2) {
    fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobs: normalized.slice(0, 100) }),
    }).catch(() => {});
  }
}

async function syncFromR2() {
  try {
    const r = await fetch('/api/history');
    if (!r.ok) return;
    const remote = await r.json();
    if (!Array.isArray(remote) || remote.length === 0) return;
    const local = getJobs();
    const map = new Map();
    remote.forEach(j => { if (j && j.id) map.set(j.id, { ...j, status: normStatus(j.status) }); });
    local.forEach(j => {
      if (j && j.id) {
        const prev = map.get(j.id);
        if (!prev || (j.status === 'completed' && prev.status !== 'completed')) map.set(j.id, j);
      }
    });
    const merged = Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    localStorage.setItem(LS_JOBS, JSON.stringify(merged));
    renderList();
    if (!selectedJobId && merged.length > 0) selectJob(merged[0].id);
  } catch {}
}

// ── User Preferences (Settings Page) ──
const LS_PREFS = 'bilisum_prefs_v1';
const DEFAULT_PREFS = {
  send_email_on_single: true,
  default_email_style: 'editorial',
  default_email: '',
  default_tpl: '',
  default_view: 'summary',
};

function getUserPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(LS_PREFS) || '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function applyUserPrefsToUi() {
  const p = getUserPrefs();
  const stEl = document.getElementById('singleEmailStyle');
  const emEl = document.getElementById('customEmail');
  const tplEl = document.getElementById('tplPreset');
  if (stEl) { stEl.value = p.default_email_style || 'editorial'; syncCustomSelect(stEl); }
  if (emEl && !emEl.value) emEl.value = p.default_email || '';
  if (tplEl) { tplEl.value = p.default_tpl || ''; syncCustomSelect(tplEl); onTplPreset(); }
  if (p.default_view && ['summary', 'transcript', 'split'].includes(p.default_view)) {
    viewMode = p.default_view;
    document.querySelectorAll('#segTabs .seg-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === viewMode));
  }
}

async function openSettingsModal() {
  const p = getUserPrefs();
  document.getElementById('prefSendEmail').checked = p.send_email_on_single !== false;
  document.getElementById('prefEmailStyle').value = p.default_email_style || 'editorial';
  document.getElementById('prefDefaultEmail').value = p.default_email || '';
  document.getElementById('prefDefaultTpl').value = p.default_tpl || '';
  document.getElementById('prefDefaultView').value = p.default_view || 'summary';
  syncAllCustomSelects();
  openModal('settingsModal');
  const badge = document.getElementById('sysStatsBadge');
  badge.textContent = '读取中...';
  try {
    const s = await fetch('/api/stats').then(r => r.json());
    badge.textContent = '存储: ' + String(s.mode || 'r2').toUpperCase() + ' · 待处理 ' + (s.pending_jobs || 0) + ' · 已归档 ' + (s.completed_jobs || 0);
  } catch {
    badge.textContent = '状态读取失败';
  }
}

function saveUserPrefs() {
  const prefs = {
    send_email_on_single: document.getElementById('prefSendEmail').checked,
    default_email_style: document.getElementById('prefEmailStyle').value || 'editorial',
    default_email: document.getElementById('prefDefaultEmail').value.trim(),
    default_tpl: document.getElementById('prefDefaultTpl').value || '',
    default_view: document.getElementById('prefDefaultView').value || 'summary',
  };
  localStorage.setItem(LS_PREFS, JSON.stringify(prefs));
  applyUserPrefsToUi();
  applyViewMode();
  requestAnimationFrame(() => moveSlider('segTabs', true));
  showToast('settingsToast', '偏好设置已保存并立即生效', 'ok');
  setTimeout(() => closeModal('settingsModal'), 600);
}

function resetUserPrefs() {
  localStorage.removeItem(LS_PREFS);
  applyUserPrefsToUi();
  openSettingsModal();
  showToast('settingsToast', '已恢复默认设置', 'info');
}

function clearAllFeedCacheFromSettings() {
  clearFeedCache(null);
  prefetchDone = false;
  showToast('settingsToast', '已清空所有 UP 主动态本地缓存', 'ok');
}

// ── Submit Video ──
async function submitVideo(overrideUrl, meta) {
  const input = document.getElementById('videoUrl');
  const raw = (overrideUrl !== undefined ? String(overrideUrl) : input.value).trim();
  if (!raw) { showToast('sbToast', '请输入 B 站视频链接或 BV 号', 'err'); return; }

  const prefs = getUserPrefs();
  const preset = document.getElementById('tplPreset').value;
  let tpl = '';
  if (preset === 'custom') tpl = document.getElementById('customTpl').value.trim();
  else if (TPL_PRESETS[preset]) tpl = TPL_PRESETS[preset];

  const email = document.getElementById('customEmail').value.trim() || prefs.default_email || '';
  const email_style = document.getElementById('singleEmailStyle').value || prefs.default_email_style || 'editorial';
  const send_email = prefs.send_email_on_single !== false;

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = '提交中...';

  try {
    const reqBody = {
      url: raw,
      summary_template: tpl,
      email,
      email_style,
      send_email,
    };
    if (meta && meta.title) reqBody.title = meta.title;
    if (meta && meta.owner) reqBody.owner = meta.owner;
    if (meta && meta.duration) reqBody.duration = meta.duration;

    const resp = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    const data = await resp.json();
    if (!resp.ok) {
      showToast('sbToast', data.error || '提交失败', 'err');
      return;
    }
    const newJob = {
      id: data.job_id,
      bvid: data.bvid,
      title: data.title || (meta && meta.title) || data.bvid,
      owner: data.owner || (meta && meta.owner) || '',
      duration: data.duration || (meta && meta.duration) || '',
      status: 'pending',
      created_at: new Date().toISOString(),
      video_url: 'https://www.bilibili.com/video/' + data.bvid,
    };
    const jobs = [newJob, ...getJobs().filter(j => j.id !== newJob.id)];
    saveJobs(jobs);
    if (overrideUrl === undefined) input.value = '';
    showToast('sbToast', send_email ? '已提交处理队列（完成后将同步发邮件）' : '已提交处理队列（已按设置关闭单条邮件通知）', 'ok');
    if (currentPage !== 'workspace') await switchPage('workspace');
    selectJob(newJob.id);
    startPolling(newJob.id);
  } catch (e) {
    showToast('sbToast', '网络错误: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '开始总结';
  }
}

function submitVideoFromFeed(idx) {
  const v = currentFeedVideos[idx];
  if (!v) return;
  submitVideo(v.bvid, { title: v.title || '', owner: v.author || '', duration: v.duration || '' });
}

function startPolling(jobId) {
  if (pollTimers[jobId]) clearInterval(pollTimers[jobId]);
  let ticks = 0;
  pollTimers[jobId] = setInterval(async () => {
    ticks++;
    if (ticks > 90) { clearInterval(pollTimers[jobId]); delete pollTimers[jobId]; return; }
    try {
      const r = await fetch('/api/jobs/' + encodeURIComponent(jobId));
      if (!r.ok) return;
      const data = await r.json();
      data.status = normStatus(data.status);
      const jobs = getJobs();
      const idx = jobs.findIndex(j => j.id === jobId);
      if (idx >= 0) {
        jobs[idx] = { ...jobs[idx], ...data };
        const finished = data.status === 'completed' || data.status === 'failed';
        saveJobs(jobs, finished);
        if (selectedJobId === jobId) renderDetail(jobs[idx]);
        if (finished) {
          clearInterval(pollTimers[jobId]);
          delete pollTimers[jobId];
        }
      }
    } catch {}
  }, 4000);
}

// ── History List ──
function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + p(d.getMonth()+1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function renderList() {
  const kw = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  const jobs = getJobs();
  document.getElementById('countPill').textContent = String(jobs.length);
  const filtered = kw ? jobs.filter(j =>
    (j.title || '').toLowerCase().includes(kw) ||
    (j.bvid || '').toLowerCase().includes(kw) ||
    (j.owner || '').toLowerCase().includes(kw)
  ) : jobs;

  const container = document.getElementById('historyList');
  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:28px 12px;color:var(--muted);font-size:12.5px">暂无匹配的历史记录</div>';
    return;
  }

  container.innerHTML = filtered.map(j => {
    const active = j.id === selectedJobId && currentPage === 'workspace' ? ' active' : '';
    const st = normStatus(j.status);
    const dotCls = st === 'completed' ? 'ok' : (st === 'failed' ? 'err' : 'pending');
    const metaParts = [];
    if (j.owner) metaParts.push(j.owner);
    if (j.duration) metaParts.push(j.duration);
    else if (j.timings && j.timings.total) metaParts.push(j.timings.total + 's');
    metaParts.push(j.bvid || '');
    const chk = batchMode
      ? '<input type="checkbox" class="h-chk" ' + (selectedIds.includes(j.id) ? 'checked' : '') + ' onclick="event.stopPropagation();toggleSelectId(\'' + esc(j.id) + '\')">'
      : '';
    return '<div class="h-card' + active + '" onclick="selectJob(\'' + esc(j.id) + '\')">' +
      chk +
      '<div class="h-body">' +
        '<div class="h-title">' + esc(j.title || j.bvid || '处理中...') + '</div>' +
        '<div class="h-meta">' + esc(metaParts.join(' · ')) + '</div>' +
      '</div>' +
      '<div class="h-right">' +
        '<span class="dot ' + dotCls + '"></span>' +
        (!batchMode ? '<button class="h-del" title="删除" onclick="event.stopPropagation();deleteOneJob(\'' + esc(j.id) + '\')">' + SVG_CLOSE_SM + '</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

function selectJob(id) {
  if (currentPage !== 'workspace') switchPage('workspace');
  selectedJobId = id;
  const job = getJobs().find(j => j.id === id);
  renderList();
  if (!job) return;
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('detailView').classList.remove('hidden');
  renderDetail(job);
  if (normStatus(job.status) === 'pending') startPolling(job.id);
}

function deleteOneJob(id) {
  const jobs = getJobs().filter(j => j.id !== id);
  if (selectedJobId === id) {
    selectedJobId = jobs[0] ? jobs[0].id : null;
    if (!selectedJobId) {
      document.getElementById('emptyState').classList.remove('hidden');
      document.getElementById('detailView').classList.add('hidden');
      document.getElementById('stepperBar').classList.add('hidden');
    }
  }
  saveJobs(jobs);
  if (selectedJobId) selectJob(selectedJobId);
  fetch('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
}

function toggleBatchMode() {
  batchMode = !batchMode;
  selectedIds = [];
  document.getElementById('batchBar').classList.toggle('hidden', !batchMode);
  document.getElementById('batchToggleBtn').textContent = batchMode ? '完成' : '管理';
  renderList();
}
function toggleSelectId(id) {
  const i = selectedIds.indexOf(id);
  if (i >= 0) selectedIds.splice(i, 1); else selectedIds.push(id);
}
function selectAllJobs() { selectedIds = getJobs().map(j => j.id); renderList(); }
function invertSelectJobs() { const set = new Set(selectedIds); selectedIds = getJobs().map(j => j.id).filter(id => !set.has(id)); renderList(); }
function deleteSelectedJobs() {
  if (!selectedIds.length) return;
  if (!confirm('确定删除已勾选的 ' + selectedIds.length + ' 条记录？')) return;
  const set = new Set(selectedIds);
  const jobs = getJobs().filter(j => !set.has(j.id));
  selectedIds = [];
  if (set.has(selectedJobId)) {
    selectedJobId = jobs[0] ? jobs[0].id : null;
    if (!selectedJobId) {
      document.getElementById('emptyState').classList.remove('hidden');
      document.getElementById('detailView').classList.add('hidden');
    }
  }
  saveJobs(jobs);
  if (selectedJobId) selectJob(selectedJobId);
}

// ── Rich Markdown → Editorial HTML Renderer ──
function inlineMd(text) {
  let s = esc(text);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\x60([^\x60]+)\x60/g, '<code class="md-code">$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--brand);text-decoration:none">$1</a>');
  return s;
}

function detectSectionKind(line) {
  const c = line.replace(/^[#\s\-*•]+/, '').replace(/\*\*/g, '').replace(/[:：]+$/, '').trim();
  // Never treat failure notices like "（AI总结失败，仅完成语音识别）" as section headings
  if (!c || c.startsWith('（') || c.startsWith('(') || c.includes('失败') || c.includes('无法')) return null;
  if (c.length <= 16) {
    if (c.includes('核心主题') || c.includes('核心观点') || c.includes('一句话总结')) return 'theme';
    if (c.includes('要点提炼') || c.includes('核心要点') || c.includes('关键要点')) return 'points';
    if (c === '总结' || c === '结语' || c === '总结洞察' || c.endsWith('总结')) return 'conclusion';
  }
  return null;
}

function renderRichSummary(md) {
  if (!md || !md.trim()) return '<div class="pending-banner">暂无 AI 总结内容</div>';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let cur = { kind: 'body', lines: [] };
  function pushCur() { if (cur.lines.length) sections.push(cur); }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^[-*_]{3,}$/.test(line)) continue;
    if (/^#\s+/.test(line) && !line.startsWith('##')) continue;

    const kind = detectSectionKind(line);
    if (kind) { pushCur(); cur = { kind, lines: [] }; continue; }
    const inlineSec = line.match(/^(?:[-*•]\s*)?(?:[^\w\u4e00-\u9fa5]*)\*\*(核心主题|要点提炼|总结|核心观点)\*\*\s*[:：]\s*(.+)$/);
    if (inlineSec) {
      pushCur();
      cur = { kind: detectSectionKind(inlineSec[1]) || 'body', lines: [inlineSec[2].trim()] };
      continue;
    }
    cur.lines.push(line);
  }
  pushCur();

  return sections.map(sec => {
    if (sec.kind === 'theme') {
      return '<div class="md-theme-box"><div class="md-theme-label">核心主题</div><div class="md-theme-body">' +
        sec.lines.map(inlineMd).join('<br>') + '</div></div>';
    }
    if (sec.kind === 'points') {
      const items = sec.lines.map((l, idx) => {
        const mNum = l.match(/^(\d+)[.、)]\s*(.+)$/);
        const mBul = l.match(/^[-*•]\s+(.+)$/);
        if (mNum) return '<li><span class="md-num">' + esc(mNum[1]) + '</span><div>' + inlineMd(mNum[2]) + '</div></li>';
        if (mBul) return '<li><span class="md-num">·</span><div>' + inlineMd(mBul[1]) + '</div></li>';
        return '<li><span class="md-num">' + (idx + 1) + '</span><div>' + inlineMd(l) + '</div></li>';
      }).join('');
      return '<div class="md-sec-title">要点提炼</div><ul class="md-list">' + items + '</ul>';
    }
    if (sec.kind === 'conclusion') {
      const notes = [], body = [];
      sec.lines.forEach(l => {
        if (l.includes('字幕可能不完整') || /^(?:\*\*)?注[:：]/.test(l)) notes.push(inlineMd(l));
        else body.push(inlineMd(l));
      });
      return '<div class="md-conclusion"><div class="md-conclusion-label">总结洞察</div><div class="md-conclusion-body">' +
        body.join('<br>') + '</div>' + (notes.length ? '<div class="md-note">' + notes.join(' ') + '</div>' : '') + '</div>';
    }
    return sec.lines.map(l => {
      if (/^#{2,4}\s+/.test(l)) return '<div class="md-sec-title">' + inlineMd(l.replace(/^#{2,4}\s+/, '')) + '</div>';
      if (/^[-*•]\s+/.test(l)) return '<div class="md-p" style="padding-left:14px">• ' + inlineMd(l.replace(/^[-*•]\s+/, '')) + '</div>';
      return '<p class="md-p">' + inlineMd(l) + '</p>';
    }).join('');
  }).join('');
}

// ── Failure Diagnostics Renderer ──
const STAGE_LABELS = {
  id_parse: '视频 ID 解析',
  video_info: '获取视频信息',
  playurl: '解析音频流',
  cdn_download: '下载 B 站音频',
  stt: '免费语音转文字',
  summarize: 'AI 生成总结',
};

function renderFailureDiagnostics(job) {
  let stage = job.error_stage || '';
  let errText = job.error || '';
  let hint = job.error_hint || '';

  if (!stage) {
    const bvid = String(job.bvid || '');
    const totalSec = job.timings && job.timings.total ? Number(job.timings.total) : null;
    if (/^av\d+$/i.test(bvid) && totalSec !== null && totalSec <= 3) {
      stage = 'video_info';
      errText = errText || '旧版后端未兼容 av 号直接查询，或该视频已被删除/设为不可见（耗时 ' + totalSec + 's 即中断）';
      hint = hint || '当前新版已支持 av 号解析；请确认该视频在 B 站可正常公开打开，然后点击下方「重新处理此视频」重试。';
    } else if (totalSec !== null && totalSec <= 5) {
      stage = 'playurl';
      errText = errText || '在获取视频信息或音频流阶段快速中断（耗时 ' + totalSec + 's）';
      hint = hint || '常见原因：当时 B 站封禁了 GitHub Actions 节点 (-412)、视频为大会员/充电专属、或稿件已下架。现已接入中继与 WBI 签名，可直接重试。';
    } else {
      stage = 'stt';
      errText = errText || '语音识别阶段未能返回有效文本内容';
      hint = hint || '常见原因：硅基流动语音识别接口临时波动 (500/超时)、音频无有效人声或文件过大。可点击下方按钮重新处理，或在 GitHub Secrets 配置免费的 GROQ_API_KEY。';
    }
  }

  const stageLabel = STAGE_LABELS[stage] || stage || '处理链路';
  return '<div class="diag-card">' +
    '<div class="diag-head">' +
      '<div class="diag-title">处理失败 · 故障定位</div>' +
      '<span class="diag-stage">异常环节：' + esc(stageLabel) + '</span>' +
    '</div>' +
    '<div class="diag-rows">' +
      '<div class="diag-row"><span class="diag-key">报错详情</span><span>' + esc(errText || '未能获取视频文字内容') + '</span></div>' +
      '<div class="diag-row"><span class="diag-key">可能原因</span><span>' + esc(hint || '请检查视频是否公开可播放，或稍后重试。') + '</span></div>' +
    '</div>' +
    '<div class="diag-foot">' +
      '<span style="font-size:12px;color:var(--soft)">视频 ID：<code>' + esc(job.bvid || '') + '</code></span>' +
      '<button class="btn btn-sm btn-primary" onclick="submitVideo(\'' + esc(job.bvid || '') + '\')">重新处理此视频</button>' +
    '</div>' +
  '</div>';
}

// ── Detail View & Stepper ──
function renderStepper(job) {
  const bar = document.getElementById('stepperBar');
  bar.classList.remove('hidden');
  const st = normStatus(job.status);
  let steps = job.gh_steps;
  if (!steps) {
    const doneAll = st === 'completed';
    const fail = st === 'failed';
    steps = [
      { name: '任务创建', done: true, active: false },
      { name: '下载音频', done: doneAll, active: !doneAll && !fail },
      { name: '语音转录', done: doneAll, active: false },
      { name: 'AI 总结', done: doneAll, active: false },
    ];
  } else {
    steps = steps.slice(0, 4);
  }

  const badgeHtml = st === 'completed'
    ? '<span class="st-badge ok">已完成</span>'
    : (st === 'failed' ? '<span class="st-badge err">处理失败</span>' : '<span class="st-badge pending">处理中</span>');

  const items = steps.map((s, i) => {
    const cls = s.done ? 'st-item done' : (s.active ? 'st-item active' : 'st-item');
    const dot = s.done ? '<span class="st-dot">&#10003;</span>' : '<span class="st-dot">' + (i + 1) + '</span>';
    const line = '<span class="st-line' + (s.done ? ' done' : '') + '"></span>';
    return '<span class="' + cls + '">' + dot + '<span>' + esc(s.name) + '</span></span>' + line;
  }).join('');

  bar.innerHTML = items + badgeHtml;
}

function renderDetail(job) {
  renderStepper(job);
  const videoUrl = job.video_url || ('https://www.bilibili.com/video/' + job.bvid);
  const titleLink = document.getElementById('dTitleLink');
  titleLink.textContent = job.title || job.bvid || '处理中...';
  titleLink.href = videoUrl;
  document.getElementById('dWatchLink').href = videoUrl;

  const pills = [];
  if (job.owner) pills.push('UP主：' + job.owner);
  if (job.duration) pills.push('时长 ' + job.duration);
  if (job.bvid) pills.push(job.bvid);
  if (job.timings && job.timings.total) pills.push('耗时 ' + job.timings.total + 's');
  else if (job.created_at) pills.push(fmtShortDate(job.created_at));
  document.getElementById('dPills').innerHTML = pills.map(p => '<span class="meta-pill">' + esc(p) + '</span>').join('');

  const st = normStatus(job.status);
  const rawSummary = (job.summary || '').trim();
  const isSummaryFailed = job.error_stage === 'summarize' || rawSummary.startsWith('（AI总结失败') || rawSummary.startsWith('(AI总结失败');

  if (st === 'pending') {
    document.getElementById('summaryContent').innerHTML = '<div class="pending-banner">GitHub Actions 正在提取音频、免费语音转文字并生成 AI 摘要，页面会自动刷新...</div>';
    document.getElementById('transcriptContent').textContent = '等待转录完成...';
  } else if (st === 'failed') {
    document.getElementById('summaryContent').innerHTML = renderFailureDiagnostics(job);
    document.getElementById('transcriptContent').textContent = job.transcript || '无转录内容';
  } else if (isSummaryFailed) {
    const tLen = (job.transcript || '').length;
    const sumDiagJob = {
      ...job,
      error_stage: 'summarize',
      error: job.error || 'AI 总结阶段失败（大概率因长视频文本量触发硅基流动免费模型 TPM 每分钟 Token 限流 429）',
      error_hint: job.error_hint || ('好消息：完整语音转录（共 ' + tLen + ' 字符）已成功保存，你可以直接点击上方「完整转录」查看；后端现已升级自动采样与多免费模型切换，点击右侧「重新处理此视频」即可生成总结。'),
    };
    document.getElementById('summaryContent').innerHTML = renderFailureDiagnostics(sumDiagJob);
    document.getElementById('transcriptContent').textContent = job.transcript || '（该任务无语音转录文本）';
  } else {
    let notice = '';
    if (job.error_hint) notice = '<div class="sb-toast show info" style="margin:0 0 14px 0">' + esc(job.error_hint) + '</div>';
    document.getElementById('summaryContent').innerHTML = notice + renderRichSummary(rawSummary);
    document.getElementById('transcriptContent').textContent = job.transcript || '（该任务无语音转录文本）';
  }
  applyViewMode();
  requestAnimationFrame(() => moveSlider('segTabs', true));
}

function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('#segTabs .seg-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  moveSlider('segTabs');
  applyViewMode();
  playAnim(document.getElementById('readerGrid'));
}

function applyViewMode() {
  const grid = document.getElementById('readerGrid');
  const sp = document.getElementById('summaryPanel');
  const tp = document.getElementById('transcriptPanel');
  const spLbl = document.getElementById('summaryPanelLabel');
  grid.classList.toggle('split', viewMode === 'split');
  sp.classList.toggle('hidden', viewMode === 'transcript');
  tp.classList.toggle('hidden', viewMode === 'summary');
  spLbl.classList.toggle('hidden', viewMode !== 'split');
}

function copyCurrent() {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job) return;
  const txt = viewMode === 'transcript' ? (job.transcript || '') : (job.summary || '');
  navigator.clipboard.writeText(txt).then(() => {
    const btn = document.getElementById('copyBtn');
    const span = btn.querySelector('span');
    if (span) { span.textContent = '已复制'; setTimeout(() => { span.textContent = '复制'; }, 1600); }
  }).catch(() => {});
}

function exportFile(ext) {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job) return;
  const content = ext === 'md'
    ? ('# ' + (job.title || job.bvid) + '\n\n> 链接: https://www.bilibili.com/video/' + job.bvid + '\n\n' + (job.summary || '') + (job.transcript ? '\n\n---\n\n## 完整转录\n\n' + job.transcript : ''))
    : ((job.title || job.bvid) + '\nhttps://www.bilibili.com/video/' + job.bvid + '\n\n' + (job.summary || '') + (job.transcript ? '\n\n---\n完整转录：\n' + job.transcript : ''));
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (job.bvid || 'summary') + '.' + ext;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Auth ──
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function getAuthToken() { return localStorage.getItem(LS_AUTH) || ''; }

async function checkAuth() {
  const tok = getAuthToken();
  if (!tok) { updateAuthUi(''); return; }
  try {
    const r = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + tok } });
    const d = await r.json();
    if (d.authenticated) updateAuthUi(d.username);
    else { localStorage.removeItem(LS_AUTH); updateAuthUi(''); }
  } catch { updateAuthUi(''); }
}

function updateAuthUi(user) {
  authUser = user || '';
  const btn = document.getElementById('monitorBtn');
  const ic = document.getElementById('monitorBtnIcon');
  const tx = document.getElementById('monitorBtnText');

  if (authUser) {
    btn.classList.add('authed');
    ic.innerHTML = SVG_SLIDERS;
    tx.textContent = authUser + ' · 监控设置';
  } else {
    btn.classList.remove('authed');
    ic.innerHTML = SVG_LOCK;
    tx.textContent = '登录管理';
    if (currentPage === 'monitor') switchPage('workspace');
  }
}

async function openMonitorEntry() {
  if (!authUser) {
    openModal('loginModal');
    setTimeout(() => document.getElementById('loginPass').focus(), 60);
    return;
  }
  await openMonitorModal();
}

async function openMonitorModal() {
  openModal('monitorModal');
  requestAnimationFrame(() => moveSlider('monitorTabs', true));
  await loadMonitorConfig();
}

async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const btn = document.getElementById('loginSubmitBtn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json();
    if (!r.ok) { showToast('loginToast', d.error || '登录失败', 'err'); return; }
    localStorage.setItem(LS_AUTH, d.token);
    localStorage.setItem(LS_USER, d.username);
    updateAuthUi(d.username);
    closeModal('loginModal');
    document.getElementById('loginPass').value = '';
    await switchPage('monitor');
  } catch (e) {
    showToast('loginToast', '网络错误: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function doLogout() {
  localStorage.removeItem(LS_AUTH);
  localStorage.removeItem(LS_USER);
  updateAuthUi('');
  closeModal('monitorModal');
  showToast('sbToast', '已退出管理员登录', 'info');
}

// ── UP Monitor Sidebar + Video Cover Grid ──
async function loadMonitorPage() {
  await loadMonitorConfig();
  updateMonitorHeaderSummary();
  renderUpSidebar();
  await fetchUpFeed(selectedUpMid || 'all');
}

function updateMonitorHeaderSummary() {
  const ups = monitorConfig.up_list || [];
  const styleNames = { editorial: '编辑部日报', minimal: '极简纸刊', bilibili: 'B站元气粉', compact: '极速速览' };
  const statusStr = monitorConfig.enabled !== false ? '定时监控运行中' : '定时监控已暂停';
  const timeStr = monitorConfig.schedule_mode === 'times'
    ? ('北京时间 ' + (monitorConfig.times_cst || []).join('、'))
    : ('UTC Cron ' + (monitorConfig.cron_utc || ''));
  document.getElementById('monSummaryLine').textContent =
    statusStr + ' · ' + timeStr + ' · 共监控 ' + ups.length + ' 位 UP 主 · 样式：' + (styleNames[monitorConfig.email_style] || '编辑部日报');
}

function renderUpSidebar() {
  const kw = (document.getElementById('upSearchInput').value || '').trim().toLowerCase();
  const ups = monitorConfig.up_list || [];
  document.getElementById('upSideCount').textContent = String(ups.length);

  const filtered = kw ? ups.filter(u =>
    String(u.name || '').toLowerCase().includes(kw) || String(u.mid || '').includes(kw)
  ) : ups;

  const listEl = document.getElementById('upSideList');
  let html = '';

  if (!kw) {
    html += '<div class="up-side-card' + (selectedUpMid === 'all' ? ' active' : '') + '" onclick="selectMonitorUp(\'all\')">' +
      '<div class="up-ava-fb">全</div>' +
      '<div class="up-side-info">' +
        '<div class="up-side-name">全部监控 UP 主</div>' +
        '<div class="up-side-uid">聚合最新动态 · ' + ups.length + ' 位</div>' +
      '</div>' +
    '</div>';
  }

  if (!filtered.length) {
    html += '<div style="text-align:center;padding:24px 12px;color:var(--muted);font-size:12.5px">暂无匹配的 UP 主</div>';
  } else {
    html += filtered.map(u => {
      const active = String(selectedUpMid) === String(u.mid) ? ' active' : '';
      const faceUrl = u.face ? (u.face.replace(/^http:\/\//, 'https://') + '@96w_96h_1c.webp') : '';
      const ava = faceUrl
        ? '<img class="up-ava" src="' + esc(faceUrl) + '" referrerpolicy="no-referrer" alt="">'
        : '<div class="up-ava-fb">' + esc((u.name || String(u.mid)).slice(0, 1)) + '</div>';
      return '<div class="up-side-card' + active + '" onclick="selectMonitorUp(' + Number(u.mid) + ')">' +
        ava +
        '<div class="up-side-info">' +
          '<div class="up-side-name">' + esc(u.name || u.mid) + '</div>' +
          '<div class="up-side-uid">UID ' + esc(u.mid) + '</div>' +
        '</div>' +
        '<button class="h-del" title="取消监控" onclick="event.stopPropagation();quickRemoveMonitorUp(' + Number(u.mid) + ')">' + SVG_CLOSE_SM + '</button>' +
      '</div>';
    }).join('');
  }
  listEl.innerHTML = html;
}

async function selectMonitorUp(mid) {
  selectedUpMid = mid;
  renderUpSidebar();
  const ups = monitorConfig.up_list || [];
  if (mid === 'all') {
    document.getElementById('monFeedHeading').textContent = '全部监控 UP 主动态';
    document.getElementById('topbarSub').textContent = '全部 UP 主';
  } else {
    const found = ups.find(u => Number(u.mid) === Number(mid));
    const label = found ? found.name : ('UID ' + mid);
    document.getElementById('monFeedHeading').textContent = label + ' · 最新视频';
    document.getElementById('topbarSub').textContent = label + ' (' + mid + ')';
  }
  await fetchUpFeed(mid);
}

async function quickAddMonitorUp() {
  const inp = document.getElementById('sideAddUpInput');
  const q = inp.value.trim();
  if (!q) return;
  const btn = document.getElementById('sideAddUpBtn');
  btn.disabled = true;
  btn.textContent = '添加中...';
  try {
    const r = await fetch('/api/up-lookup?q=' + encodeURIComponent(q), {
      headers: { 'Authorization': 'Bearer ' + getAuthToken() },
    });
    const d = await r.json();
    if (!r.ok) { showToast('sideUpToast', d.error || '解析失败', 'err'); return; }
    if (!monitorConfig.up_list) monitorConfig.up_list = [];
    const exists = monitorConfig.up_list.some(x => Number(x.mid) === Number(d.mid));
    if (!exists) {
      monitorConfig.up_list.push({ mid: Number(d.mid), name: d.name || String(d.mid), face: d.face || '' });
      const sr = await fetch('/api/monitor-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
        body: JSON.stringify(monitorConfig),
      });
      const sd = await sr.json();
      if (sr.ok && sd.config) monitorConfig = sd.config;
    }
    inp.value = '';
    clearFeedCache('all');
    updateMonitorHeaderSummary();
    renderUpSidebar();
    showToast('sideUpToast', '已添加监控：' + (d.name || d.mid), 'ok');
    await selectMonitorUp(Number(d.mid));
  } catch (e) {
    showToast('sideUpToast', '添加异常：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '添加';
  }
}

async function quickRemoveMonitorUp(mid) {
  const found = (monitorConfig.up_list || []).find(u => Number(u.mid) === Number(mid));
  if (!confirm('确定取消监控「' + (found ? found.name : mid) + '」？')) return;
  monitorConfig.up_list = (monitorConfig.up_list || []).filter(u => Number(u.mid) !== Number(mid));
  try {
    const sr = await fetch('/api/monitor-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
      body: JSON.stringify(monitorConfig),
    });
    const sd = await sr.json();
    if (sr.ok && sd.config) monitorConfig = sd.config;
    if (String(selectedUpMid) === String(mid)) selectedUpMid = 'all';
    clearFeedCache('all');
    clearFeedCache(mid);
    updateMonitorHeaderSummary();
    renderUpSidebar();
    await selectMonitorUp(selectedUpMid);
  } catch (e) {
    showToast('sideUpToast', '移除失败：' + e.message, 'err');
  }
}

// ── Multi-Layer UP Feed Cache (Memory + sessionStorage, 10 min TTL) ──
const SS_FEED_CACHE = 'bilisum_up_feed_cache_v1';
const FEED_CACHE_TTL_MS = 10 * 60 * 1000;
const feedMemCache = new Map();
let prefetchDone = false;

function readFeedCache(key) {
  const k = String(key || 'all');
  if (feedMemCache.has(k)) return feedMemCache.get(k);
  try {
    const store = JSON.parse(sessionStorage.getItem(SS_FEED_CACHE) || '{}');
    if (store[k] && Array.isArray(store[k].videos)) {
      feedMemCache.set(k, store[k]);
      return store[k];
    }
  } catch {}
  return null;
}

function writeFeedCache(key, videos) {
  const k = String(key || 'all');
  const entry = { videos, ts: Date.now() };
  feedMemCache.set(k, entry);
  try {
    const store = JSON.parse(sessionStorage.getItem(SS_FEED_CACHE) || '{}');
    store[k] = entry;
    // Keep up to 25 cached UP entries in sessionStorage
    const keys = Object.keys(store);
    if (keys.length > 25) {
      keys.sort((a, b) => (store[a].ts || 0) - (store[b].ts || 0));
      keys.slice(0, keys.length - 25).forEach(old => delete store[old]);
    }
    sessionStorage.setItem(SS_FEED_CACHE, JSON.stringify(store));
  } catch {}
}

function clearFeedCache(key) {
  if (key) {
    feedMemCache.delete(String(key));
  } else {
    feedMemCache.clear();
  }
  try {
    if (key) {
      const store = JSON.parse(sessionStorage.getItem(SS_FEED_CACHE) || '{}');
      delete store[String(key)];
      sessionStorage.setItem(SS_FEED_CACHE, JSON.stringify(store));
    } else {
      sessionStorage.removeItem(SS_FEED_CACHE);
    }
  } catch {}
}

function renderFeedCards(vids) {
  const grid = document.getElementById('upFeedGrid');
  currentFeedVideos = vids;
  if (!vids.length) {
    grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:36px">暂未获取到公开视频</div>';
    return;
  }
  grid.innerHTML = vids.map((v, idx) => {
    const coverUrl = v.pic ? (v.pic.replace(/^http:\/\//, 'https://') + '@672w_378h_1c.webp') : '';
    const faceUrl = v.face ? (v.face.replace(/^http:\/\//, 'https://') + '@96w_96h_1c.webp') : '';
    const hasSum = Boolean(v.summary);
    const statsStr = [fmtCount(v.play), fmtDanmaku(v.danmaku)].join(' · ');
    const relTime = fmtRelativeTime(v.created);

    const avaHtml = faceUrl
      ? '<img class="v-ava" src="' + esc(faceUrl) + '" referrerpolicy="no-referrer" alt="">'
      : '<div class="v-ava-fb">' + esc((v.author || 'UP').slice(0, 1)) + '</div>';

    return '<article class="v-card">' +
      '<a class="v-thumb-link" href="' + esc(v.url) + '" target="_blank" rel="noopener">' +
        (coverUrl ? '<img src="' + esc(coverUrl) + '" referrerpolicy="no-referrer" loading="lazy" alt="">' : '') +
        (hasSum ? '<span class="v-sum-badge">已有摘要</span>' : '') +
        (v.duration ? '<span class="v-dur">' + esc(v.duration) + '</span>' : '') +
      '</a>' +
      '<div class="v-body">' +
        avaHtml +
        '<div class="v-meta-col">' +
          '<a class="v-title" href="' + esc(v.url) + '" target="_blank" rel="noopener" title="' + esc(v.title) + '">' + esc(v.title) + '</a>' +
          '<div class="v-author">' + esc(v.author || '') + '</div>' +
          '<div class="v-stats">' + esc(statsStr) + '</div>' +
          '<div class="v-foot">' +
            (relTime ? '<span class="v-time-pill">' + esc(relTime) + '</span>' : '<span></span>') +
            '<div class="v-act-row">' +
              (hasSum ? '<button class="v-act-btn" onclick="openFeedSummaryModal(' + idx + ')">查看摘要</button>' : '') +
              '<button class="v-act-btn primary" onclick="submitVideoFromFeed(' + idx + ')">' + (hasSum ? '重算' : '一键总结') + '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</article>';
  }).join('');
  playAnim(grid);
}

function prefetchTopUpsQuietly() {
  if (prefetchDone || !authUser) return;
  prefetchDone = true;
  const ups = (monitorConfig.up_list || []).slice(0, 6);
  ups.forEach((u, i) => {
    const k = String(u.mid);
    const existing = readFeedCache(k);
    if (existing && (Date.now() - existing.ts) < FEED_CACHE_TTL_MS) return;
    setTimeout(() => {
      if (!authUser) return;
      fetch('/api/up-videos?mid=' + encodeURIComponent(k) + '&ps=16', {
        headers: { 'Authorization': 'Bearer ' + getAuthToken() },
      }).then(r => r.ok ? r.json() : null).then(d => {
        if (d && Array.isArray(d.videos)) writeFeedCache(k, d.videos);
      }).catch(() => {});
    }, 600 + i * 350);
  });
}

async function fetchUpFeed(mid, forceRefresh) {
  const key = String(mid || 'all');
  const grid = document.getElementById('upFeedGrid');
  const refBtn = document.getElementById('refreshFeedBtn');
  const cached = !forceRefresh ? readFeedCache(key) : null;
  const isFresh = cached && (Date.now() - cached.ts) < FEED_CACHE_TTL_MS;

  // Instant 0ms render if cached
  if (cached) {
    renderFeedCards(cached.videos);
    if (isFresh) {
      prefetchTopUpsQuietly();
      return;
    }
  } else {
    grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:36px">正在加载视频封面与最新动态...</div>';
  }

  if (refBtn && forceRefresh) { refBtn.disabled = true; refBtn.textContent = '刷新中...'; }
  try {
    const url = '/api/up-videos?mid=' + encodeURIComponent(key) + '&ps=16' + (forceRefresh ? '&refresh=1' : '');
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + getAuthToken() } });
    const d = await r.json();
    if (!r.ok) {
      if (!cached) grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;color:var(--err-text)">拉取失败：' + esc(d.error || ('HTTP ' + r.status)) + '</div>';
      return;
    }
    const vids = d.videos || [];
    writeFeedCache(key, vids);
    // Only overwrite grid if user is still viewing this same UP
    if (String(selectedUpMid || 'all') === key) {
      renderFeedCards(vids);
    }
    if (forceRefresh) showToast('feedToast', '动态已刷新（共 ' + vids.length + ' 条）', 'ok');
    prefetchTopUpsQuietly();
  } catch (e) {
    if (!cached) grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;color:var(--err-text)">网络异常：' + esc(e.message) + '</div>';
  } finally {
    if (refBtn) { refBtn.disabled = false; refBtn.textContent = '刷新动态'; }
  }
}

function openFeedSummaryModal(idx) {
  const v = currentFeedVideos[idx];
  if (!v) return;
  modalSummaryRaw = v.summary || '';
  document.getElementById('smTitle').textContent = v.title || v.bvid;
  document.getElementById('smWatchLink').href = v.url || ('https://www.bilibili.com/video/' + v.bvid);
  document.getElementById('smBody').innerHTML = renderRichSummary(modalSummaryRaw);
  openModal('summaryModal');
}

function copyModalSummary() {
  navigator.clipboard.writeText(modalSummaryRaw || '').then(() => {
    const b = document.getElementById('smCopyBtn');
    b.textContent = '已复制';
    setTimeout(() => { b.textContent = '复制摘要'; }, 1500);
  }).catch(() => {});
}

// ── Monitor Settings Modal Logic ──
function switchMonitorTab(tab) {
  document.querySelectorAll('#monitorTabs .m-tab').forEach(b => b.classList.toggle('active', b.dataset.mtab === tab));
  moveSlider('monitorTabs');
  const sEl = document.getElementById('mTabSchedule');
  const eEl = document.getElementById('mTabEmail');
  sEl.classList.toggle('hidden', tab !== 'schedule');
  eEl.classList.toggle('hidden', tab !== 'email');
  playAnim(tab === 'schedule' ? sEl : eEl);
  if (tab === 'email') renderEmailPreview();
}

async function loadMonitorConfig() {
  try {
    const r = await fetch('/api/monitor-config', { headers: { 'Authorization': 'Bearer ' + getAuthToken() } });
    if (r.status === 401) { doLogout(); openModal('loginModal'); return; }
    const d = await r.json();
    if (d.config) monitorConfig = d.config;
    hydrateMonitorForm();
  } catch (e) {
    showToast('monitorToast', '加载配置失败: ' + e.message, 'err');
  }
}

function hydrateMonitorForm() {
  document.getElementById('cfgEnabled').checked = monitorConfig.enabled !== false;
  document.getElementById('cfgScheduleMode').value = monitorConfig.schedule_mode || 'times';
  document.getElementById('cfgCustomCron').value = monitorConfig.cron_utc || '0 0,12 * * *';
  document.getElementById('cfgWindowHours').value = String(monitorConfig.check_window_hours || 72);
  document.getElementById('cfgMaxVideos').value = String(monitorConfig.max_videos_per_run || 5);
  document.getElementById('cfgMergeEmails').checked = monitorConfig.merge_emails !== false;
  document.getElementById('cfgSmtpTo').value = monitorConfig.smtp_to || '';
  syncAllCustomSelects();
  onScheduleModeChange();
  renderTimeChips();
  renderUpChips();
  selectEmailStyle(monitorConfig.email_style || 'editorial');
  requestAnimationFrame(() => moveSlider('monitorTabs', true));

  const syncEl = document.getElementById('cronSyncStatus');
  if (monitorConfig.last_cron_sync) {
    const s = monitorConfig.last_cron_sync;
    syncEl.innerHTML = s.ok
      ? ('已同步至 Shy Cron（任务 ID: <code>' + esc(s.task_id) + '</code> · 下次运行: ' + esc(s.next_run_at || '已调度') + '）')
      : ('上次 Shy Cron 同步提示：' + esc(s.error || s.reason || '未同步'));
  } else {
    syncEl.textContent = '保存后将自动同步至 Shy Cron（cron.shyapi.de5.net）';
  }
}

function onScheduleModeChange() {
  const mode = document.getElementById('cfgScheduleMode').value;
  document.getElementById('customCronWrap').style.display = mode === 'custom' ? 'flex' : 'none';
  document.getElementById('timeAddWrap').style.display = mode === 'times' ? 'flex' : 'none';
  document.getElementById('timeChips').style.display = mode === 'times' ? 'flex' : 'none';
  updateCronPreview();
}

function computeClientUtcCron() {
  const mode = document.getElementById('cfgScheduleMode').value;
  if (mode === 'every_6h') return '0 */6 * * *';
  if (mode === 'every_12h') return '0 0,12 * * *';
  if (mode === 'custom') return document.getElementById('cfgCustomCron').value.trim() || '0 0,12 * * *';
  const times = monitorConfig.times_cst || ['08:00', '20:00'];
  if (!times.length) return '0 0,12 * * *';
  const min = parseInt(times[0].split(':')[1], 10) || 0;
  const hrs = [];
  times.forEach(t => {
    const h = (parseInt(t.split(':')[0], 10) - 8 + 24) % 24;
    if (!hrs.includes(h)) hrs.push(h);
  });
  hrs.sort((a, b) => a - b);
  return min + ' ' + hrs.join(',') + ' * * *';
}

function updateCronPreview() {
  document.getElementById('cronUtcPreview').textContent = 'UTC Cron: ' + computeClientUtcCron();
}

function renderTimeChips() {
  const list = monitorConfig.times_cst || [];
  document.getElementById('timeChips').innerHTML = list.map((t, i) =>
    '<span class="chip"><b>北京时间 ' + esc(t) + '</b><button type="button" onclick="removeTimeSlot(' + i + ')">×</button></span>'
  ).join('');
  updateCronPreview();
}

function addTimeSlot() {
  const val = document.getElementById('newTimeInput').value;
  if (!val) return;
  if (!monitorConfig.times_cst) monitorConfig.times_cst = [];
  if (!monitorConfig.times_cst.includes(val)) {
    monitorConfig.times_cst.push(val);
    monitorConfig.times_cst.sort();
  }
  renderTimeChips();
}

function removeTimeSlot(idx) {
  monitorConfig.times_cst.splice(idx, 1);
  if (monitorConfig.times_cst.length === 0) monitorConfig.times_cst = ['08:00'];
  renderTimeChips();
}

function renderUpChips() {
  const ups = monitorConfig.up_list || [];
  document.getElementById('upCountLabel').textContent = String(ups.length);
  document.getElementById('upChips').innerHTML = ups.map((u, i) =>
    '<span class="chip"><b>' + esc(u.name || u.mid) + '</b><small>' + esc(u.mid) + '</small><button type="button" onclick="removeUp(' + i + ')">×</button></span>'
  ).join('');
}

async function addUpCreator() {
  const inp = document.getElementById('newUpInput');
  const q = inp.value.trim();
  if (!q) return;
  const btn = document.getElementById('addUpBtn');
  btn.disabled = true;
  btn.textContent = '解析中...';
  try {
    const r = await fetch('/api/up-lookup?q=' + encodeURIComponent(q), {
      headers: { 'Authorization': 'Bearer ' + getAuthToken() },
    });
    const d = await r.json();
    if (!r.ok) { showToast('monitorToast', d.error || '解析失败', 'err'); return; }
    if (!monitorConfig.up_list) monitorConfig.up_list = [];
    if (!monitorConfig.up_list.some(x => Number(x.mid) === Number(d.mid))) {
      monitorConfig.up_list.push({ mid: Number(d.mid), name: d.name || String(d.mid), face: d.face || '' });
    }
    inp.value = '';
    renderUpChips();
    showToast('monitorToast', '已添加 UP 主：' + (d.name || d.mid), 'ok');
  } catch (e) {
    showToast('monitorToast', '解析异常: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '解析并添加';
  }
}

function removeUp(idx) {
  monitorConfig.up_list.splice(idx, 1);
  renderUpChips();
}

// ── Email Style Live Preview ──
const PREVIEW_THEMES = {
  editorial: {
    name:'编辑部日报', pageBg:'#f3f4f6', bodyBg:'#f8fafc', hdBg:'#111827', hdTop:'4px solid #fb7299',
    hdTitle:'#ffffff', hdMeta:'#9ca3af', p1Bg:'rgba(251,114,153,.16)', p1C:'#fda4af', p1B:'rgba(251,114,153,.35)',
    p2Bg:'rgba(255,255,255,.08)', p2C:'#e5e7eb', p2B:'rgba(255,255,255,.14)', accent:'#fb7299', accentDark:'#e11d48',
    thBg:'#fff5f7', thB:'#fb7299', bgBadge:'#fff1f5', cBadge:'#e11d48', bBadge:'#fecdd3', btnBg:'#111827', compact:false
  },
  minimal: {
    name:'极简纸刊', pageBg:'#ffffff', bodyBg:'#ffffff', hdBg:'#ffffff', hdTop:'3px solid #111827',
    hdTitle:'#111827', hdMeta:'#6b7280', p1Bg:'#f3f4f6', p1C:'#111827', p1B:'#e5e7eb',
    p2Bg:'#f9fafb', p2C:'#4b5563', p2B:'#e5e7eb', accent:'#111827', accentDark:'#111827',
    thBg:'#f9fafb', thB:'#111827', bgBadge:'#f3f4f6', cBadge:'#374151', bBadge:'#e5e7eb', btnBg:'#111827', compact:false
  },
  bilibili: {
    name:'B站元气粉', pageBg:'#fff7f9', bodyBg:'#fffbfc', hdBg:'linear-gradient(135deg,#fb7299,#ff8fab)', hdTop:'none',
    hdTitle:'#ffffff', hdMeta:'rgba(255,255,255,.9)', p1Bg:'rgba(255,255,255,.22)', p1C:'#ffffff', p1B:'rgba(255,255,255,.35)',
    p2Bg:'rgba(255,255,255,.16)', p2C:'#ffffff', p2B:'rgba(255,255,255,.28)', accent:'#fb7299', accentDark:'#ec4899',
    thBg:'#fff1f5', thB:'#fb7299', bgBadge:'#ffe4ec', cBadge:'#db2777', bBadge:'#fbcfe8', btnBg:'#fb7299', compact:false
  },
  compact: {
    name:'极速速览', pageBg:'#f1f5f9', bodyBg:'#ffffff', hdBg:'#0f172a', hdTop:'3px solid #38bdf8',
    hdTitle:'#f8fafc', hdMeta:'#94a3b8', p1Bg:'rgba(56,189,248,.16)', p1C:'#7dd3fc', p1B:'rgba(56,189,248,.3)',
    p2Bg:'rgba(255,255,255,.08)', p2C:'#cbd5e1', p2B:'rgba(255,255,255,.14)', accent:'#0284c7', accentDark:'#0369a1',
    thBg:'#f0f9ff', thB:'#0284c7', bgBadge:'#e0f2fe', cBadge:'#0369a1', bBadge:'#bae6fd', btnBg:'#0f172a', compact:true
  }
};

function selectEmailStyle(style) {
  monitorConfig.email_style = PREVIEW_THEMES[style] ? style : 'editorial';
  document.querySelectorAll('.style-card').forEach(c => c.classList.toggle('selected', c.dataset.style === monitorConfig.email_style));
  renderEmailPreview();
}

function renderEmailPreview() {
  const st = monitorConfig.email_style || 'editorial';
  const th = PREVIEW_THEMES[st] || PREVIEW_THEMES.editorial;
  const merge = document.getElementById('cfgMergeEmails').checked;
  const pad = th.compact ? '12px 14px' : '18px 20px';
  const fs = th.compact ? '12px' : '13px';
  const hb = st === 'minimal' ? 'border-bottom:1px solid #e5e7eb;' : '';
  const url1 = 'https://www.bilibili.com/video/BV149ypz6Ehs';
  const url2 = 'https://www.bilibili.com/video/BV19Vsq6xEW9';

  const html = '<!doctype html><html><body style="margin:0;padding:14px;background:' + th.pageBg + ';font-family:-apple-system,PingFang SC,sans-serif;color:#111827">' +
    '<div style="max-width:600px;margin:0 auto">' +
      '<div style="background:' + th.hdBg + ';border-top:' + th.hdTop + ';border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;' + hb + 'border-radius:12px 12px 0 0;padding:18px 20px">' +
        '<div style="font-size:10px;letter-spacing:1.2px;color:' + th.hdMeta + ';margin-bottom:5px">BILIBILI AI DAILY BRIEFING · 2026年11月21日</div>' +
        '<div style="font-size:19px;font-weight:800;color:' + th.hdTitle + ';margin-bottom:9px">B站视频 AI 日报</div>' +
        '<span style="display:inline-block;background:' + th.p1Bg + ';color:' + th.p1C + ';border:1px solid ' + th.p1B + ';border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;margin-right:6px">' + (merge ? '覆盖 2 位 UP 主' : '按 UP 主分封推送') + '</span>' +
        '<span style="display:inline-block;background:' + th.p2Bg + ';color:' + th.p2C + ';border:1px solid ' + th.p2B + ';border-radius:999px;padding:2px 9px;font-size:11px">共 ' + (merge ? '2' : '1') + ' 支新视频</span>' +
      '</div>' +
      '<div style="background:' + th.bodyBg + ';border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:16px">' +
        (merge ? '<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;line-height:1.8">' +
          '<div style="font-size:10px;font-weight:700;color:#6b7280;margin-bottom:4px">本期速览 · TABLE OF CONTENTS</div>' +
          '<div><b style="color:' + th.accent + ';margin-right:5px">01</b><a href="' + url1 + '" target="_blank" style="color:#1f2937;text-decoration:none;border-bottom:1px solid #e5e7eb"><b style="color:' + th.accentDark + '">[波士顿圆脸]</b> 前所未见：巴西亚马逊原始部落拖家带口现身求救</a></div>' +
          '<div><b style="color:' + th.accent + ';margin-right:5px">02</b><a href="' + url2 + '" target="_blank" style="color:#1f2937;text-decoration:none;border-bottom:1px solid #e5e7eb"><b style="color:' + th.accentDark + '">[刺客边风]</b> 开源本地光猫配置解析工具实测</a></div>' +
        '</div>' : '') +
        '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:' + pad + '">' +
          '<div style="margin-bottom:7px"><span style="font-family:Consolas,monospace;font-size:11px;color:#9ca3af;margin-right:6px">#01</span><span style="display:inline-block;background:' + th.bgBadge + ';color:' + th.cBadge + ';border:1px solid ' + th.bBadge + ';border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;margin-right:6px">波士顿圆脸</span><span style="font-size:11px;color:#9ca3af">时长 11:16 · 11-20 10:49</span></div>' +
          '<div style="font-size:15px;font-weight:700;margin-bottom:10px"><a href="' + url1 + '" target="_blank" style="color:#111827;text-decoration:none">前所未见：巴西亚马逊原始部落拖家带口现身求救</a></div>' +
          '<div style="background:' + th.thBg + ';border-left:3px solid ' + th.thB + ';border-radius:0 6px 6px 0;padding:9px 12px;margin-bottom:10px"><div style="font-size:10px;font-weight:700;color:' + th.accentDark + ';margin-bottom:3px">核心主题</div><div style="font-size:' + fs + ';line-height:1.6">记录巴西亚马逊与世隔绝原始部落携家带口现身求救事件，剖析雨林生态与现代疾病风险。</div></div>' +
          '<div style="font-size:' + fs + ';line-height:1.65;color:#374151;margin-bottom:10px"><div><b style="color:' + th.accent + '">1.</b> <b>罕见接触</b>：二三十名阿瓦人主动接触原住民哨所索要食物。</div><div><b style="color:' + th.accent + '">2.</b> <b>生存威胁</b>：非法淘金与盗伐加剧，挤压原住民生存空间。</div></div>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;border-top:1px dashed #e5e7eb;padding-top:9px"><a href="' + url1 + '" target="_blank" style="background:' + th.btnBg + ';color:#fff;padding:5px 11px;border-radius:6px;font-size:11.5px;font-weight:600;text-decoration:none">前往 B 站观看 ↗</a><span style="font-size:11px;color:#9ca3af;font-family:Consolas,monospace">BV149ypz6Ehs</span></div>' +
        '</div>' +
      '</div>' +
    '</div></body></html>';
  document.getElementById('emailPreviewFrame').srcdoc = html;
}

async function saveMonitorConfig() {
  const btn = document.getElementById('saveMonitorBtn');
  btn.disabled = true;
  btn.textContent = '保存并同步中...';
  const payload = {
    enabled: document.getElementById('cfgEnabled').checked,
    schedule_mode: document.getElementById('cfgScheduleMode').value,
    times_cst: monitorConfig.times_cst,
    cron_utc: document.getElementById('cfgCustomCron').value.trim(),
    up_list: monitorConfig.up_list,
    email_style: monitorConfig.email_style,
    merge_emails: document.getElementById('cfgMergeEmails').checked,
    smtp_to: document.getElementById('cfgSmtpTo').value.trim(),
    check_window_hours: parseInt(document.getElementById('cfgWindowHours').value, 10) || 72,
    max_videos_per_run: parseInt(document.getElementById('cfgMaxVideos').value, 10) || 5,
  };
  try {
    const r = await fetch('/api/monitor-config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getAuthToken(),
      },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) { showToast('monitorToast', d.error || '保存失败', 'err'); return; }
    monitorConfig = d.config;
    hydrateMonitorForm();
    if (currentPage === 'monitor') {
      updateMonitorHeaderSummary();
      renderUpSidebar();
    }
    if (d.cron_sync && d.cron_sync.ok) {
      showToast('monitorToast', '配置已保存并成功同步至 Shy Cron（' + d.cron_sync.cron_utc + '）', 'ok');
    } else {
      showToast('monitorToast', '已保存到 R2，但 Cron 同步提示：' + (d.cron_sync?.error || d.cron_sync?.reason || '未知'), 'err');
    }
  } catch (e) {
    showToast('monitorToast', '保存异常: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并同步定时任务';
  }
}

async function triggerMonitorNow(toastId) {
  const tid = toastId || 'monitorToast';
  try {
    const r = await fetch('/api/monitor-run', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + getAuthToken() },
    });
    const d = await r.json();
    if (!r.ok) showToast(tid, d.error || '触发失败', 'err');
    else showToast(tid, d.message || '已触发监控任务', 'ok');
  } catch (e) {
    showToast(tid, '触发异常: ' + e.message, 'err');
  }
}

// ── Init ──
initTheme();
initCustomSelects();
applyUserPrefsToUi();
checkAuth();
renderList();
const initJobs = getJobs();
if (initJobs.length > 0) selectJob(initJobs[0].id);
initJobs.forEach(j => { if (normStatus(j.status) === 'pending') startPolling(j.id); });
syncFromR2();
requestAnimationFrame(() => updateAllSliders(true));
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/auth/login' && request.method === 'POST') return await handleLogin(request, env);
      if (path === '/api/auth/me' && request.method === 'GET') return await handleAuthMe(request, env);
      if (path === '/api/monitor-config' && request.method === 'GET') return await handleGetMonitorConfig(request, env);
      if (path === '/api/monitor-config' && request.method === 'POST') return await handleSaveMonitorConfig(request, env);
      if (path === '/api/up-lookup' && request.method === 'GET') return await handleUpLookup(request, env);
      if (path === '/api/up-videos' && request.method === 'GET') return await handleGetUpVideos(request, env, ctx);
      if (path === '/api/monitor-archive' && request.method === 'GET') return await handleGetMonitorArchive(request, env);
      if (path === '/api/monitor-archive' && request.method === 'POST') return await handlePostMonitorArchive(request, env);
      if (path === '/api/cron-trigger' && (request.method === 'POST' || request.method === 'GET')) return await handleCronTrigger(request, env);
      if (path === '/api/monitor-run' && request.method === 'POST') return await handleManualMonitorRun(request, env);

      if (path === '/api/submit' && request.method === 'POST') return await handleSubmit(request, env, ctx);
      if (path === '/api/history' && request.method === 'GET') return await handleGetHistory(request, env);
      if (path === '/api/history' && request.method === 'POST') return await handlePostHistory(request, env);
      if (path === '/api/history' && request.method === 'DELETE') return await handleDeleteHistory(request, env);
      if (path === '/api/jobs' && request.method === 'GET') return await handleListJobs(request, env);
      if (path.startsWith('/api/jobs/') && request.method === 'GET') return await handleGetJob(request, env, path.replace('/api/jobs/', ''));
      if (path.startsWith('/api/jobs/') && request.method === 'DELETE') return await handleDeleteJob(request, env, path.replace('/api/jobs/', ''));
      if (path === '/api/stats' && request.method === 'GET') return await handleStats(request, env);
      if (path === '/api/callback' && request.method === 'POST') return await handleCallback(request, env);
      if (path === '/' || path === '/index.html') return htmlResponse(generateFrontendPage());

      return errorResponse('Not Found', 404);
    } catch (err) {
      console.error('Worker error:', err);
      return errorResponse('Internal Server Error: ' + err.message, 500);
    }
  },

  async scheduled(event, env, ctx) {
    await handleCron(event, env);
  },
};
