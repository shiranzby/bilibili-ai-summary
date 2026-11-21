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
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, must-revalidate',
    },
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

const LIBRARY_KEY = 'config/library.json';
const DEFAULT_LIBRARY = {
  folders: [
    { id: 'tech', name: '科技', color: '#2563EB' },
    { id: 'history', name: '历史', color: '#D97706' },
    { id: 'game', name: '游戏', color: '#7C3AED' },
    { id: 'software', name: '软件', color: '#059669' },
  ],
  job_tags: {},
  up_tags: {},
  watch_later: [],
  favorites: [],
};

function sanitizeLibrary(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const folders = Array.isArray(src.folders) && src.folders.length
    ? src.folders.slice(0, 40).map(f => ({
        id: String(f.id || '').trim().slice(0, 32) || ('f_' + Date.now()),
        name: String(f.name || '').trim().slice(0, 20) || '未命名',
        color: /^#[0-9a-fA-F]{3,8}$/.test(String(f.color || '')) ? String(f.color) : '#2563EB',
      }))
    : DEFAULT_LIBRARY.folders.map(f => ({ ...f }));
  const validIds = new Set(folders.map(f => f.id));
  const cleanTagMap = (m) => {
    const out = {};
    if (m && typeof m === 'object') {
      Object.keys(m).slice(0, 500).forEach(k => {
        const arr = Array.isArray(m[k]) ? [...new Set(m[k].map(String).filter(id => validIds.has(id)))] : [];
        if (arr.length) out[String(k)] = arr;
      });
    }
    return out;
  };
  const cleanVidList = (arr) => {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const v of arr) {
      if (!v || !v.bvid) continue;
      const bvid = String(v.bvid).trim();
      if (!bvid || seen.has(bvid)) continue;
      seen.add(bvid);
      out.push({
        bvid,
        job_id: String(v.job_id || ''),
        mid: Number(v.mid) || 0,
        title: String(v.title || bvid).slice(0, 180),
        author: String(v.author || '').slice(0, 60),
        face: String(v.face || '').slice(0, 300),
        pic: String(v.pic || '').slice(0, 300),
        duration: String(v.duration || '').slice(0, 20),
        play: Number(v.play) || 0,
        danmaku: Number(v.danmaku) || 0,
        created: Number(v.created) || 0,
        url: String(v.url || `https://www.bilibili.com/video/${bvid}`).slice(0, 300),
        added_at: String(v.added_at || nowISO()),
      });
      if (out.length >= 300) break;
    }
    return out;
  };
  return {
    folders,
    job_tags: cleanTagMap(src.job_tags),
    up_tags: cleanTagMap(src.up_tags),
    watch_later: cleanVidList(src.watch_later),
    favorites: cleanVidList(src.favorites),
    updated_at: src.updated_at || nowISO(),
  };
}

async function readLibrary(env) {
  if (!env.BILIBILI_BUCKET) return sanitizeLibrary(DEFAULT_LIBRARY);
  try {
    const obj = await env.BILIBILI_BUCKET.get(LIBRARY_KEY);
    if (!obj) return sanitizeLibrary(DEFAULT_LIBRARY);
    return sanitizeLibrary(await obj.json());
  } catch {
    return sanitizeLibrary(DEFAULT_LIBRARY);
  }
}

async function handleGetLibrary(request, env) {
  const lib = await readLibrary(env);
  return jsonResponse({ ok: true, library: lib });
}

async function handleSaveLibrary(request, env) {
  const sess = await verifySessionToken(request, env);
  if (!sess) return errorResponse('需要登录管理员账号以同步云端标签库', 401);
  if (!env.BILIBILI_BUCKET) return errorResponse('R2 未配置', 503);
  const body = await request.json().catch(() => ({}));
  const clean = sanitizeLibrary(body.library || body);
  clean.updated_at = nowISO();
  await env.BILIBILI_BUCKET.put(LIBRARY_KEY, JSON.stringify(clean), {
    httpMetadata: { contentType: 'application/json' },
  });
  return jsonResponse({ ok: true, library: clean });
}

async function fetchBiliUpPage(proxyBase, mid, pn, ps) {
  const url = `${proxyBase}/api/bili-up?mid=${mid}&pn=${pn}&ps=${ps}`;
  const delays = [400, 900];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (r.ok) {
        const d = await r.json();
        if (d && (d.code === 0 || Array.isArray(d?.data?.list?.vlist))) return d;
      }
    } catch {}
    if (attempt < delays.length) await new Promise(res => setTimeout(res, delays[attempt]));
  }
  return null;
}

async function handleGetUpVideos(request, env, ctx) {
  const sess = await verifySessionToken(request, env);
  if (!sess) return errorResponse('需要登录管理员账号', 401);

  const reqUrl = new URL(request.url);
  const midParam = (reqUrl.searchParams.get('mid') || '').trim();
  const midsParam = (reqUrl.searchParams.get('mids') || '').trim();
  const pn = Math.max(1, Math.min(parseInt(reqUrl.searchParams.get('pn') || '1', 10) || 1, 50));
  const ps = Math.max(4, Math.min(parseInt(reqUrl.searchParams.get('ps') || '20', 10) || 20, 30));
  const forceRefresh = reqUrl.searchParams.get('refresh') === '1';

  // Cloudflare Edge Cache (5 min TTL) per (mid, mids, pn, ps) unless ?refresh=1
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKeyUrl = new URL(reqUrl.origin + '/__cache/up-videos-v2');
  cacheKeyUrl.searchParams.set('mid', midParam);
  if (midsParam) cacheKeyUrl.searchParams.set('mids', midsParam);
  cacheKeyUrl.searchParams.set('pn', String(pn));
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

  if (midParam === 'all' || midParam === 'group') {
    let ups = (cfg.up_list || []).slice(0, 15);
    if (midsParam) {
      const allow = new Set(midsParam.split(',').map(s => Number(s.trim())).filter(n => n > 0));
      ups = ups.filter(u => allow.has(Number(u.mid)));
    }
    if (!ups.length) {
      return respondCached({ ok: true, mid: midParam, pn, ps, total: 0, has_more: false, videos: [], cached_at: nowISO() });
    }
    const perUp = ups.length <= 2 ? 12 : (ups.length <= 5 ? 8 : 6);
    const allVids = [];
    let anyMore = false;
    let totalCount = 0;

    // Staggered batches of 3 to avoid Bilibili burst rate-limits
    for (let i = 0; i < ups.length; i += 3) {
      const batch = ups.slice(i, i + 3);
      const batchRes = await Promise.all(
        batch.map(async u => {
          const d = await fetchBiliUpPage(proxyBase, Number(u.mid), pn, perUp);
          const vlist = d?.data?.list?.vlist || [];
          const cnt = Number(d?.data?.page?.count || 0);
          return { mid: Number(u.mid), items: mapVlist(vlist, Number(u.mid)), cnt };
        })
      );
      batchRes.forEach(r => {
        totalCount += r.cnt;
        if (r.items.length > 0 && (r.cnt > pn * perUp || (r.cnt === 0 && r.items.length >= perUp))) anyMore = true;
        allVids.push(...r.items);
      });
      if (i + 3 < ups.length) await new Promise(res => setTimeout(res, 90));
    }

    const seen = new Set();
    const merged = allVids
      .filter(v => { if (!v.bvid || seen.has(v.bvid)) return false; seen.add(v.bvid); return true; })
      .sort((a, b) => (b.created || 0) - (a.created || 0));

    return respondCached({
      ok: true,
      mid: midParam,
      pn,
      ps: perUp,
      total: totalCount,
      has_more: anyMore,
      videos: merged,
      cached_at: nowISO(),
    });
  }

  if (!/^\d+$/.test(midParam)) return errorResponse('无效的 UP 主 UID', 400);
  const midNum = Number(midParam);

  try {
    const d = await fetchBiliUpPage(proxyBase, midNum, pn, ps);
    if (!d) throw new Error('代理暂不可用，请稍后重试');
    const items = mapVlist(d?.data?.list?.vlist || [], midNum);
    const total = Number(d?.data?.page?.count || 0);
    const hasMore = items.length > 0 && (total > 0 ? (pn * ps) < total : items.length >= ps);
    return respondCached({
      ok: true,
      mid: midNum,
      pn,
      ps,
      total,
      has_more: hasMore,
      videos: items,
      code: d.code,
      cached_at: nowISO(),
    });
  } catch (e) {
    const fallback = pn === 1 ? archive.filter(v => Number(v.mid) === midNum) : [];
    return jsonResponse({ ok: true, mid: midNum, pn, ps, total: fallback.length, has_more: false, videos: fallback, warning: '实时列表拉取失败: ' + e.message });
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
// Fast Edge AI (100% Free SiliconFlow LLM Pool: Re-Summarize & Video Q&A)
// ═══════════════════════════════════════════════════════

const FREE_EDGE_LLMS = [
  'Qwen/Qwen3-8B',
  'THUDM/GLM-4-9B-0414',
  'Qwen/Qwen2.5-7B-Instruct',
];

function smartTrimText(text, maxChars = 9000) {
  const s = String(text || '');
  if (s.length <= maxChars) return { text: s, trimmed: false };
  const head = Math.floor(maxChars * 0.40);
  const mid = Math.floor(maxChars * 0.28);
  const tail = maxChars - head - mid;
  const midStart = Math.max(head, Math.floor((s.length - mid) / 2));
  return {
    text: s.slice(0, head) + '\n\n[...中段部分内容已省略...]\n\n' + s.slice(midStart, midStart + mid) + '\n\n[...后段部分内容已省略...]\n\n' + s.slice(-tail),
    trimmed: true,
  };
}

async function callFreeSiliconFlowChat(env, messages, maxTokens = 1600) {
  const apiKey = (env.SILICONFLOW_API_KEY || '').trim();
  if (!apiKey) throw new Error('Worker 未配置 SILICONFLOW_API_KEY');

  let lastErr = '';
  for (const model of FREE_EDGE_LLMS) {
    const payload = {
      model,
      messages,
      temperature: 0.35,
      max_tokens: maxTokens,
    };
    if (model.toLowerCase().includes('qwen3')) payload.enable_thinking = false;

    try {
      const resp = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(26000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const content = (data?.choices?.[0]?.message?.content || '').trim();
        if (content) return { content, model };
      } else {
        const errBody = await resp.text().catch(() => '');
        lastErr = `${model} HTTP ${resp.status}: ${errBody.slice(0, 140)}`;
        if (resp.status === 401 || resp.status === 403) break;
      }
    } catch (e) {
      lastErr = `${model} 异常: ${e.message}`;
    }
  }
  throw new Error(lastErr || '免费 AI 模型调用失败');
}

const RESUMMARIZE_PROMPTS = {
  daily: {
    sys: `你是一个专业的视频内容分析师。根据视频转录文本生成高可读性日报简报，严格按以下 Markdown 结构输出：

**核心主题**
用 1-2 句话直接点明视频核心议题与结论。

**要点提炼**
用编号列表列出 4-6 个关键信息点，每条采用「**关键词/小标题**：精炼阐述（1-2句话）」格式。

**总结**
用 2-3 句话凝练视频背后的核心视角与价值。`,
  },
  notes: {
    sys: `你是一个专业知识整理专家。请将视频转录整理为结构化深度笔记，包含：
**核心主题**（一句话概括）
**要点提炼**（6-8条带「**主题词**：详细论点+具体案例或数据」的编号条目）
**总结**（可落地的实践建议与思考延伸）`,
  },
  quotes: {
    sys: `你是内容策展编辑。请提炼视频中最有洞察力的观点与金句，使用以下结构：
**核心主题**（视频最核心的一句洞察）
**要点提炼**（5-7条编号观点，格式为「**金句/观点**：结合上下文的简明解读」）
**总结**（适合转发分享的一段精华推荐语）`,
  },
  flashcards: {
    sys: `你是高效学习教练。请把视频核心知识改写为「问答记忆卡片」，使用以下结构：
**核心主题**（本视频最值得掌握的核心概念）
**要点提炼**（5-6组编号问答，格式为「**问：核心问题？** 答：精准简洁的答案」）
**总结**（一句话复习口诀或记忆框架）`,
  },
};

async function handleResummarize(request, env) {
  const body = await request.json().catch(() => ({}));
  const transcript = String(body.transcript || '').trim();
  const title = String(body.title || '').trim();
  const style = RESUMMARIZE_PROMPTS[body.style] ? body.style : 'daily';
  const jobId = String(body.job_id || '').trim();

  if (transcript.length < 30) {
    return errorResponse('当前任务缺少足够长度的转录文本，无法直接重生成，请重新处理整个视频', 400);
  }

  const t0 = Date.now();
  const { text: trimmed, trimmed: wasTrimmed } = smartTrimText(transcript, 6000);
  const note = wasTrimmed ? '\n\n[注：原视频较长，已按开篇/中段/结尾采样精简]' : '';
  const messages = [
    { role: 'system', content: RESUMMARIZE_PROMPTS[style].sys },
    { role: 'user', content: `视频标题：${title || '未命名视频'}\n\n转录内容：\n---\n${trimmed}\n---${note}` },
  ];

  try {
    const { content, model } = await callFreeSiliconFlowChat(env, messages, 1200);
    const elapsed = Number(((Date.now() - t0) / 1000).toFixed(1));

    // Persist updated summary to R2 result if exists
    if (jobId && env.BILIBILI_BUCKET) {
      try {
        const obj = await env.BILIBILI_BUCKET.get(`results/${jobId}.json`);
        if (obj) {
          const rec = await obj.json();
          rec.summary = content;
          rec.error = '';
          rec.error_stage = '';
          rec.error_hint = '';
          rec.summary_style = style;
          rec.updated_at = nowISO();
          await env.BILIBILI_BUCKET.put(`results/${jobId}.json`, JSON.stringify(rec), {
            httpMetadata: { contentType: 'application/json' },
          });
        }
      } catch {}
    }
    return jsonResponse({ ok: true, summary: content, model, style, elapsed });
  } catch (e) {
    return errorResponse('AI 重生成失败：' + e.message, 502);
  }
}

async function handleVideoChat(request, env) {
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  const transcript = String(body.transcript || '').trim();
  const summary = String(body.summary || '').trim();
  const history = Array.isArray(body.messages) ? body.messages : [];

  if (!transcript && !summary) {
    return errorResponse('当前视频暂无转录或摘要内容，无法对话', 400);
  }
  if (history.length === 0) {
    return errorResponse('请输入你要追问的问题', 400);
  }

  const contextSource = transcript || summary;
  const { text: ctxText } = smartTrimText(contextSource, 5500);
  const sysPrompt = `你是一位严谨的 B 站视频内容助手。请严格基于下面提供的视频标题、摘要与转录内容回答用户追问。
要求：
1. 用简洁清晰的中文回答，适当分点排版
2. 只依据视频内容回答；若视频中未提及，请明确告知「视频中未提及该信息」，不要编造
3. 回答精炼直接，切中要点

【视频标题】${title || '未知'}
【已有摘要】
${summary.slice(0, 1500)}

【视频转录节选】
${ctxText}`;

  const safeTurns = history.slice(-8).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 1200),
  }));

  try {
    const { content, model } = await callFreeSiliconFlowChat(
      env,
      [{ role: 'system', content: sysPrompt }, ...safeTurns],
      1200
    );
    return jsonResponse({ ok: true, reply: content, model });
  } catch (e) {
    return errorResponse('AI 追问失败：' + e.message, 502);
  }
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
<title>B站AI摘要 · 视频知识库工作台</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#F6F7F9;--surface:#FFFFFF;--surface-2:#ECEEF2;--surface-3:#F3F4F6;--surface-hover:#F9FAFB;
  --border:#E5E7EB;--border-strong:#D1D5DB;
  --text:#111827;--soft:#4B5563;--muted:#9CA3AF;
  --brand:#FB7299;--brand-dark:#E11D48;--brand-soft:#FFF1F5;--brand-border:#FECDD3;
  --cta:#111827;--cta-hover:#1F2937;--cta-text:#FFFFFF;
  --ok:#10B981;--ok-soft:#ECFDF5;--ok-text:#047857;
  --err:#EF4444;--err-soft:#FEF2F2;--err-border:#FECACA;--err-text:#B91C1C;
  --warn:#F59E0B;--warn-soft:#FFFBEB;--warn-text:#B45309;
  --shadow-sm:0 1px 2px rgba(16,24,40,.05);
  --shadow-pill:0 2px 8px rgba(15,23,42,.11),0 0 0 1px rgba(15,23,42,.05);
  --shadow-md:0 6px 20px rgba(16,24,40,.08);
  --shadow-lg:0 24px 54px rgba(16,24,40,.16);
  --reader-fs:14px;
}
[data-theme="dark"]{
  --bg:#0B0D12;--surface:#131722;--surface-2:#0F121A;--surface-3:#1B2030;--surface-hover:#181D2B;
  --border:rgba(255,255,255,.09);--border-strong:rgba(255,255,255,.17);
  --text:#F3F4F6;--soft:#CBD5E1;--muted:#6B7280;
  --brand:#FB7299;--brand-dark:#FDA4AF;--brand-soft:rgba(251,114,153,.13);--brand-border:rgba(251,114,153,.32);
  --cta:#FB7299;--cta-hover:#F43F7A;--cta-text:#FFFFFF;
  --ok:#10B981;--ok-soft:rgba(16,185,129,.14);--ok-text:#6EE7B7;
  --err:#F87171;--err-soft:rgba(239,68,68,.12);--err-border:rgba(239,68,68,.28);--err-text:#FCA5A5;
  --warn:#FBBF24;--warn-soft:rgba(245,158,11,.14);--warn-text:#FCD34D;
  --shadow-sm:0 1px 3px rgba(0,0,0,.32);
  --shadow-pill:0 2px 10px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.12);
  --shadow-md:0 8px 24px rgba(0,0,0,.42);
  --shadow-lg:0 26px 60px rgba(0,0,0,.65);
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
textarea.ctrl{height:auto;min-height:84px;padding:10px 12px;resize:vertical;line-height:1.55}

/* Custom Card-Style Select */
.c-select{position:relative;width:100%}
.c-select-native{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
.c-select-btn{width:100%;height:38px;padding:0 12px;font-size:13px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;transition:border-color .15s,box-shadow .15s,background .15s}
.c-select-btn:hover{border-color:var(--border-strong);background:var(--surface-hover)}
.c-select.open .c-select-btn{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.c-select-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.c-select-chev{color:var(--muted);transition:transform .22s cubic-bezier(.34,1.35,.64,1);flex-shrink:0}
.c-select.open .c-select-chev{transform:rotate(180deg);color:var(--brand-dark)}
.c-select-menu{position:absolute;left:0;right:0;top:calc(100% + 6px);background:var(--surface);border:1px solid var(--border);border-radius:11px;box-shadow:var(--shadow-md);padding:5px;z-index:260;opacity:0;transform:translateY(-6px) scale(.98);pointer-events:none;transition:opacity .16s ease,transform .2s cubic-bezier(.22,1,.36,1);max-height:240px;overflow-y:auto}
.c-select.open .c-select-menu{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.c-select.drop-up .c-select-menu{top:auto;bottom:calc(100% + 6px);transform:translateY(6px) scale(.98)}
.c-select.drop-up.open .c-select-menu{transform:translateY(0) scale(1)}
.c-select-opt{width:100%;border:none;background:transparent;padding:8px 10px;border-radius:7px;font-size:13px;color:var(--soft);display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;transition:background .12s,color .12s}
.c-select-opt:hover{background:var(--surface-3);color:var(--text)}
.c-select-opt.selected{background:var(--brand-soft);color:var(--brand-dark);font-weight:600}
.c-select-chk{opacity:0;flex-shrink:0}
.c-select-opt.selected .c-select-chk{opacity:1}

/* Toggle Switch */
.tog-switch{position:relative;display:inline-flex;align-items:center;width:40px;height:22px;flex-shrink:0;cursor:pointer}
.tog-switch input{opacity:0;width:0;height:0;position:absolute}
.tog-track{position:absolute;inset:0;background:var(--border-strong);border-radius:999px;transition:background .22s ease}
.tog-thumb{position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.22);transition:transform .28s cubic-bezier(.34,1.38,.64,1)}
.tog-switch input:checked + .tog-track{background:var(--brand)}
.tog-switch input:checked ~ .tog-thumb{transform:translateX(18px)}

/* Spring Sliding Pill & Panel Animations */
@keyframes panelFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes modalPop{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
.anim-in{animation:panelFadeIn .24s cubic-bezier(.22,1,.36,1)}
.seg-slider{
  position:absolute;top:3px;bottom:3px;left:0;border-radius:7px;
  background:var(--surface);box-shadow:var(--shadow-pill);z-index:0;pointer-events:none;
  transition:transform .34s cubic-bezier(.34,1.38,.64,1),width .34s cubic-bezier(.34,1.38,.64,1);
  will-change:transform,width;
}
[data-theme="dark"] .seg-slider{background:var(--surface-3)}

/* Layout */
.app{display:grid;grid-template-columns:var(--sidebar-w,342px) 1px 1fr;height:100vh}
.divider{background:var(--border);cursor:col-resize;position:relative;transition:background .15s}
.divider:hover,.divider.dragging{background:var(--brand)}
.divider::after{content:'';position:absolute;left:-4px;right:-4px;top:0;bottom:0}

/* Sidebar */
.sidebar{background:var(--surface);display:flex;flex-direction:column;height:100vh;overflow:hidden;padding:18px 16px 14px}
.brand{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;padding:0 2px}
.brand-l{display:flex;align-items:center;gap:10px}
.brand-icon{width:34px;height:34px;border-radius:10px;background:var(--brand);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 3px 10px rgba(251,114,153,.28)}
.brand-title{font-size:17px;font-weight:800;letter-spacing:-.2px;color:var(--text)}
.brand-sub{font-size:11px;color:var(--muted);margin-top:1px}
.brand-home-btn{border:none;background:var(--surface-3);color:var(--soft);height:28px;padding:0 9px;border-radius:7px;font-size:11.5px;font-weight:600}
.brand-home-btn:hover{color:var(--text);background:var(--surface-2)}

/* Top-Left Mode Switcher */
.side-switcher{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:4px;background:var(--surface-2);padding:3px;border-radius:10px;border:1px solid var(--border);margin-bottom:14px;flex-shrink:0}
.side-sw-btn{position:relative;z-index:1;border:none;background:transparent;height:32px;border-radius:7px;font-size:13px;font-weight:600;color:var(--soft);white-space:nowrap;transition:color .22s ease;display:inline-flex;align-items:center;justify-content:center;gap:5px}
.side-sw-btn:hover{color:var(--text)}
.side-sw-btn.active{color:var(--text)}
.side-pane{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}

/* Submit Bar */
.input-shell{display:flex;align-items:center;gap:6px;background:var(--bg);border:1px solid var(--border);border-radius:11px;padding:4px 4px 4px 12px;transition:border-color .15s,box-shadow .15s}
.input-shell:focus-within{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.input-shell input{flex:1;min-width:0;border:none;background:transparent;font-size:13px;outline:none;height:34px;color:var(--text)}
.input-shell input::placeholder{color:var(--muted)}
.btn-submit{border:none;background:var(--cta);color:var(--cta-text);height:34px;padding:0 13px;border-radius:8px;font-size:13px;font-weight:600;white-space:nowrap;flex-shrink:0;transition:background .15s}
.btn-submit:hover{background:var(--cta-hover)}
.btn-submit:disabled{opacity:.5;cursor:not-allowed}

.sub-actions{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:8px}
.adv-toggle{display:inline-flex;align-items:center;gap:5px;background:transparent;border:none;border-radius:7px;color:var(--soft);font-size:12px;font-weight:500;padding:5px 7px;transition:background .15s,color .15s}
.adv-toggle:hover{background:var(--surface-3);color:var(--text)}
.adv-toggle .caret{transition:transform .2s ease}
.adv-toggle.open .caret{transform:rotate(180deg)}
.adv-box{margin-top:6px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:11px;display:flex;flex-direction:column;gap:10px}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:12px;font-weight:600;color:var(--soft);white-space:nowrap}

/* History & Filter Tabs */
.history-wrap{flex:1;min-height:0;display:flex;flex-direction:column;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
.search-box{position:relative;margin-bottom:9px}
.search-box .ctrl{padding-left:34px;background-color:var(--bg);height:35px}
.search-box .s-ic{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none;display:flex}

.h-filter-tabs{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:2px;background:var(--surface-2);padding:3px;border-radius:9px;border:1px solid var(--border);margin-bottom:10px}
.h-ftab{position:relative;z-index:1;border:none;background:transparent;height:26px;border-radius:6px;font-size:11.5px;font-weight:600;color:var(--soft);transition:color .2s}
.h-ftab.active{color:var(--text)}

.quick-add-box{padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:10px;margin-bottom:12px}
.quick-add-label{font-size:11.5px;font-weight:600;color:var(--soft);margin-bottom:6px;display:block}
.quick-add-row{display:flex;gap:6px;align-items:center}
.quick-add-row .ctrl{height:34px;font-size:12.5px;flex:1;min-width:0}
.quick-add-row .btn{height:34px;padding:0 12px;font-size:12.5px}

.history-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;padding:0 2px}
.history-head h3{font-size:12px;font-weight:700;color:var(--soft);display:inline-flex;align-items:center;gap:6px}
.count-pill{font-size:11px;font-weight:600;color:var(--muted);background:var(--surface-3);padding:1px 7px;border-radius:999px}
.text-btn{background:none;border:none;font-size:12px;color:var(--muted);padding:3px 7px;border-radius:6px;white-space:nowrap}
.text-btn:hover{color:var(--text);background:var(--surface-3)}
.text-btn.danger{color:var(--err)}
.batch-bar{display:flex;align-items:center;gap:6px;margin-bottom:8px;padding:6px 8px;background:var(--surface-3);border-radius:8px;font-size:12px}

.history-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:7px;padding-right:2px}
.history-list::-webkit-scrollbar{width:5px}
.history-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:99px}
.h-card{position:relative;padding:10px 12px;border:1px solid var(--border);border-radius:11px;background:var(--surface);cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s,transform .15s;display:flex;align-items:flex-start;gap:9px}
.h-card:hover{background:var(--surface-hover);border-color:var(--border-strong)}
.h-card.active{border-color:var(--text);box-shadow:var(--shadow-sm)}
[data-theme="dark"] .h-card.active{border-color:var(--brand);box-shadow:inset 3px 0 0 var(--brand)}
.h-body{flex:1;min-width:0}
.h-title{font-size:13px;font-weight:600;line-height:1.42;color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:4px}
.h-meta{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h-right{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0;padding-top:3px}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot.ok{background:var(--ok)}
.dot.pending{background:var(--warn);animation:pulse 1.4s infinite}
.dot.err{background:var(--err)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.h-del{opacity:0;background:none;border:none;color:var(--muted);padding:2px 4px;border-radius:5px;display:inline-flex;transition:opacity .12s,color .12s}
.h-card:hover .h-del{opacity:1}
.h-del:hover{color:var(--err);background:var(--err-soft)}
.h-star-dot{color:#F59E0B;display:inline-flex}
.h-chk{margin-top:3px;accent-color:var(--brand)}

/* Sidebar UP Card */
.up-side-card{padding:9px 11px;border:1px solid var(--border);border-radius:11px;background:var(--surface);cursor:pointer;transition:border-color .15s,background .15s;display:flex;align-items:center;gap:10px}
.up-side-card:hover{background:var(--surface-hover);border-color:var(--border-strong)}
.up-side-card.active{border-color:var(--brand);background:var(--brand-soft)}
.up-ava{width:34px;height:34px;border-radius:50%;object-fit:cover;background:var(--surface-3);flex-shrink:0;border:1px solid var(--border)}
.up-ava-fb{width:34px;height:34px;border-radius:50%;background:var(--surface-3);color:var(--soft);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:1px solid var(--border)}
.up-side-info{flex:1;min-width:0}
.up-side-name{font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.up-side-uid{font-size:11.5px;color:var(--muted);font-family:Consolas,monospace;margin-top:1px}
.up-side-card .h-del{opacity:0}
.up-side-card:hover .h-del{opacity:1}

/* Main Workspace */
.main{display:flex;flex-direction:column;height:100vh;overflow:hidden;background:var(--bg);min-width:0}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;height:56px;padding:0 28px;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
.topbar-title{font-size:14.5px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-sub{font-size:12px;color:var(--muted);font-weight:400;margin-left:10px;white-space:nowrap}
.topbar-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.pill-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);font-size:12.5px;font-weight:600;white-space:nowrap;transition:border-color .15s,background .15s}
.pill-btn:hover{border-color:var(--border-strong);background:var(--surface-hover)}
.pill-btn.authed{border-color:var(--brand-border);background:var(--brand-soft);color:var(--brand-dark)}
.icon-btn{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--soft);flex-shrink:0;transition:border-color .15s,color .15s,background .15s}
.icon-btn:hover{border-color:var(--border-strong);color:var(--text);background:var(--surface-hover)}

.content-scroll{flex:1;overflow-y:auto;scrollbar-gutter:stable;padding:22px 28px 48px}
.content-inner{max-width:980px;margin:0 auto}
.content-inner.wide-feed{max-width:100%}

/* Dashboard Overview (Empty / Home State) */
.dash-hero{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:26px 28px;margin-bottom:16px;box-shadow:var(--shadow-sm)}
.dash-hero h2{font-size:20px;font-weight:800;margin-bottom:6px;letter-spacing:-.2px}
.dash-hero p{font-size:13.5px;color:var(--soft);line-height:1.65;max-width:680px}
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:16px 18px;box-shadow:var(--shadow-sm)}
.kpi-label{font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px}
.kpi-val{font-size:24px;font-weight:800;color:var(--text);font-variant-numeric:tabular-nums}
.kpi-sub{font-size:11.5px;color:var(--soft);margin-top:4px}
.recent-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.recent-card{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:16px 18px;cursor:pointer;transition:border-color .15s,transform .15s,box-shadow .15s}
.recent-card:hover{border-color:var(--brand);transform:translateY(-2px);box-shadow:var(--shadow-md)}
.recent-card h4{font-size:14px;font-weight:700;line-height:1.45;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.recent-card p{font-size:12px;color:var(--muted)}

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
.st-badge.pending{background:var(--warn-soft);color:var(--warn-text)}

/* Video Header Card */
.video-head{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 22px;margin-bottom:14px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;box-shadow:var(--shadow-sm)}
.vh-left{min-width:0;flex:1}
.vh-title{font-size:18.5px;font-weight:800;line-height:1.4;color:var(--text);margin-bottom:10px;word-break:break-word}
.vh-title a{color:inherit;text-decoration:none}
.vh-title a:hover{color:var(--brand-dark)}
.vh-pills{display:flex;flex-wrap:wrap;gap:7px}
.meta-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;background:var(--surface-3);color:var(--soft);font-size:12px;font-weight:500;white-space:nowrap}
.meta-pill.saved{background:var(--ok-soft);color:var(--ok-text);font-weight:600}
.vh-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.star-btn{height:34px;padding:0 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--soft);font-size:12.5px;font-weight:600;display:inline-flex;align-items:center;gap:5px;transition:all .15s;white-space:nowrap}
.star-btn:hover{border-color:var(--border-strong);color:var(--text)}
.star-btn.starred{border-color:#FCD34D;background:var(--warn-soft);color:#B45309}
.wl-btn{height:34px;padding:0 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--soft);font-size:12.5px;font-weight:600;display:inline-flex;align-items:center;gap:5px;transition:all .15s;white-space:nowrap}
.wl-btn:hover{border-color:var(--border-strong);color:var(--text)}
.wl-btn.active{border-color:#93C5FD;background:rgba(37,99,235,.10);color:#2563EB}
[data-theme="dark"] .wl-btn.active{border-color:rgba(96,165,250,.45);background:rgba(59,130,246,.16);color:#93C5FD}
.watch-btn{display:inline-flex;align-items:center;gap:5px;height:34px;padding:0 13px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);font-size:12.5px;font-weight:600;text-decoration:none;white-space:nowrap;flex-shrink:0;transition:border-color .15s,color .15s}
.watch-btn:hover{border-color:var(--brand);color:var(--brand)}

/* Tag Folders & Watch Later System */
.folder-bar{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;align-items:center}
.folder-chip{display:inline-flex;align-items:center;gap:5px;height:25px;padding:0 9px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--soft);font-size:11.5px;font-weight:600;white-space:nowrap;transition:border-color .15s,background .15s,color .15s}
.folder-chip:hover{border-color:var(--border-strong);color:var(--text);background:var(--surface-hover)}
.folder-chip.active{border-color:var(--brand-border);background:var(--brand-soft);color:var(--brand-dark)}
.folder-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.folder-cnt{font-size:10.5px;opacity:.75;font-weight:500}
.folder-add-btn{display:inline-flex;align-items:center;gap:3px;height:25px;padding:0 8px;border-radius:999px;border:1px dashed var(--border-strong);background:transparent;color:var(--muted);font-size:11.5px;font-weight:600;white-space:nowrap;transition:all .15s}
.folder-add-btn:hover{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-soft)}

.mini-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.mini-tag{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:5px;font-size:10.5px;font-weight:600;background:var(--surface-3);color:var(--soft);line-height:1.45}
.mini-tag.wl{background:rgba(37,99,235,.10);color:#2563EB}
[data-theme="dark"] .mini-tag.wl{background:rgba(59,130,246,.18);color:#93C5FD}

.vh-tag-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;position:relative}
.tag-pill{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11.5px;font-weight:600}
.tag-pill button{border:none;background:none;color:var(--muted);font-size:13px;line-height:1;padding:0 1px;cursor:pointer}
.tag-pill button:hover{color:var(--err)}
.tag-add-btn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;border-radius:999px;border:1px dashed var(--border-strong);background:transparent;color:var(--soft);font-size:11.5px;font-weight:600;transition:all .15s}
.tag-add-btn:hover{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-soft)}

.tag-popover{position:fixed;z-index:260;min-width:200px;max-width:250px;background:var(--surface);border:1px solid var(--border-strong);border-radius:12px;box-shadow:var(--shadow-lg);padding:6px;animation:modalPop .14s cubic-bezier(.22,1,.36,1)}
.tag-pop-head{font-size:11px;font-weight:700;color:var(--muted);padding:5px 8px 6px;display:flex;align-items:center;justify-content:space-between}
.tag-pop-item{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 9px;border:none;background:transparent;border-radius:8px;font-size:12.5px;font-weight:500;color:var(--text);text-align:left;cursor:pointer}
.tag-pop-item:hover{background:var(--surface-hover)}
.tag-pop-item.selected{background:var(--brand-soft);color:var(--brand-dark);font-weight:600}
.tag-pop-left{display:inline-flex;align-items:center;gap:7px;min-width:0}
.tag-pop-sep{height:1px;background:var(--border);margin:5px 2px}

.up-side-acts{display:flex;align-items:center;gap:2px;flex-shrink:0}
.up-tag-btn{border:none;background:none;color:var(--muted);width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .15s,color .15s,background .15s}
.up-side-card:hover .up-tag-btn,.up-side-card.active .up-tag-btn{opacity:1}
.up-tag-btn:hover{color:var(--brand-dark);background:var(--brand-soft)}

.v-thumb-wrap{position:relative;width:100%}
.v-quick-acts{position:absolute;top:8px;right:8px;display:flex;gap:5px;z-index:3;opacity:0;transition:opacity .16s ease}
.v-card:hover .v-quick-acts,.v-quick-acts.has-active{opacity:1}
.v-qbtn{width:28px;height:28px;border-radius:8px;border:1px solid rgba(255,255,255,.22);background:rgba(15,17,22,.72);backdrop-filter:blur(6px);color:#fff;display:inline-flex;align-items:center;justify-content:center;transition:transform .12s,background .15s,border-color .15s}
.v-qbtn:hover{background:rgba(15,17,22,.92);transform:scale(1.06)}
.v-qbtn.wl-on{background:#2563EB;border-color:#60A5FA;color:#fff}
.v-qbtn.fav-on{background:#D97706;border-color:#FCD34D;color:#fff}

.feed-footer{margin-top:26px;display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px 0 8px}
.feed-load-btn{height:38px;padding:0 22px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:8px;box-shadow:var(--shadow-sm);transition:all .15s}
.feed-load-btn:hover{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-soft)}
.feed-load-btn:disabled{opacity:.65;cursor:default}
.feed-meta-note{font-size:12px;color:var(--muted)}

.color-swatches{display:flex;gap:7px;flex-wrap:wrap;margin-top:6px}
.color-sw{width:24px;height:24px;border-radius:50%;border:2px solid transparent;cursor:pointer;transition:transform .12s,box-shadow .12s}
.color-sw:hover{transform:scale(1.1)}
.color-sw.active{box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--text)}
.folder-mgr-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.folder-mgr-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg)}
.folder-mgr-left{display:flex;align-items:center;gap:9px;min-width:0}
.folder-mgr-name{font-size:13.5px;font-weight:700;color:var(--text)}
.folder-mgr-stat{font-size:11.5px;color:var(--muted)}

/* View Tabs + Independent Action Buttons */
.view-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.seg-tabs{position:relative;display:inline-flex;background:var(--surface-2);padding:3px;border-radius:10px;border:1px solid var(--border)}
.seg-tab{position:relative;z-index:1;border:none;background:transparent;padding:6px 14px;border-radius:7px;font-size:13px;font-weight:600;color:var(--soft);white-space:nowrap;transition:color .22s ease}
.seg-tab:hover{color:var(--text)}
.seg-tab.active{color:var(--text)}
.action-group{display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap}
.act-btn{display:inline-flex;align-items:center;gap:5px;height:33px;padding:0 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--soft);font-size:12.5px;font-weight:600;white-space:nowrap;transition:border-color .15s,color .15s,background .15s}
.act-btn:hover{border-color:var(--border-strong);color:var(--text);background:var(--surface-hover)}

/* Instant Style Switch Bar inside Summary Card */
.style-switch-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:14px;margin-bottom:18px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.style-pills{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.style-pill{border:1px solid var(--border);background:var(--bg);color:var(--soft);height:28px;padding:0 11px;border-radius:999px;font-size:12px;font-weight:600;transition:all .15s}
.style-pill:hover{border-color:var(--brand);color:var(--brand-dark)}
.style-pill.active{border-color:var(--brand-border);background:var(--brand-soft);color:var(--brand-dark)}
.style-pill:disabled{opacity:.5;cursor:not-allowed}
.fs-group{display:inline-flex;align-items:center;gap:4px}
.fs-btn{width:28px;height:28px;border:1px solid var(--border);background:var(--surface);color:var(--soft);border-radius:7px;font-size:12px;font-weight:700}
.fs-btn:hover{color:var(--text);border-color:var(--border-strong)}

/* Reading Panels */
.reader-grid{display:grid;grid-template-columns:1fr;gap:16px}
.reader-grid.split{grid-template-columns:1.15fr 1fr;align-items:start}
.reader-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px 26px;box-shadow:var(--shadow-sm)}
.panel-label{font-size:11.5px;font-weight:700;letter-spacing:.7px;color:var(--muted);text-transform:uppercase;margin-bottom:12px}

/* Rendered Rich Summary */
.md-theme-box{background:var(--brand-soft);border-left:3.5px solid var(--brand);border-radius:0 10px 10px 0;padding:14px 18px;margin-bottom:20px}
.md-theme-label{font-size:12px;font-weight:700;color:var(--brand-dark);letter-spacing:.4px;margin-bottom:5px}
.md-theme-body{font-size:calc(var(--reader-fs) + .5px);line-height:1.75;color:var(--text);font-weight:500}
.md-sec-title{font-size:calc(var(--reader-fs) + 1.5px);font-weight:800;color:var(--text);margin:18px 0 11px}
.md-list{list-style:none;display:flex;flex-direction:column;gap:10px;margin-bottom:18px}
.md-list li{display:flex;align-items:flex-start;gap:10px;font-size:var(--reader-fs);line-height:1.78;color:var(--soft)}
.md-num{min-width:22px;height:22px;border-radius:50%;background:var(--surface-3);color:var(--brand-dark);font-size:11.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;margin-top:2px;flex-shrink:0}
.md-list strong,.md-p strong{color:var(--text);font-weight:650}
.md-p{font-size:var(--reader-fs);line-height:1.82;color:var(--soft);margin-bottom:10px}
.md-conclusion{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-top:8px}
.md-conclusion-label{font-size:12px;font-weight:700;color:var(--soft);margin-bottom:5px}
.md-conclusion-body{font-size:var(--reader-fs);line-height:1.75;color:var(--soft)}
.md-note{font-size:12px;color:var(--muted);margin-top:8px}
.md-code{background:var(--surface-3);color:var(--brand-dark);padding:1px 6px;border-radius:4px;font-size:12.5px;font-family:Consolas,monospace}

/* Transcript Search Bar & Highlight */
.tr-search-bar{display:flex;align-items:center;gap:8px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border)}
.tr-search-bar .ctrl{height:34px;font-size:12.5px;flex:1}
.tr-match-count{font-size:12px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.transcript-box{font-size:var(--reader-fs);line-height:1.88;color:var(--soft);white-space:pre-wrap;word-break:break-word;max-height:66vh;overflow-y:auto}
.transcript-box mark{background:#FEF08A;color:#111827;padding:0 2px;border-radius:3px}
.transcript-box mark.cur-match{background:#FB7299;color:#fff}

/* Mindmap View */
.mm-wrap{display:flex;flex-direction:column;gap:14px}
.mm-root{background:var(--cta);color:var(--cta-text);padding:14px 18px;border-radius:12px;font-size:15px;font-weight:700;line-height:1.45}
.mm-branches{display:flex;flex-direction:column;gap:10px;padding-left:20px;border-left:2px solid var(--brand-border)}
.mm-node{position:relative;background:var(--bg);border:1px solid var(--border);border-radius:11px;padding:12px 15px}
.mm-node::before{content:'';position:absolute;left:-21px;top:20px;width:19px;height:2px;background:var(--brand-border)}
.mm-node-head{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer}
.mm-node-title{font-size:13.5px;font-weight:700;color:var(--text)}
.mm-node-tag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--brand-soft);color:var(--brand-dark);white-space:nowrap}
.mm-children{margin-top:10px;padding-left:16px;border-left:1.5px dashed var(--border-strong);display:flex;flex-direction:column;gap:7px}
.mm-leaf{font-size:13px;line-height:1.65;color:var(--soft);padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px}
.mm-leaf strong{color:var(--text)}

/* AI Chat Panel */
.chat-panel{display:flex;flex-direction:column;min-height:460px;max-height:68vh}
.chat-quick-row{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}
.chat-chip{border:1px solid var(--border);background:var(--bg);color:var(--soft);padding:5px 11px;border-radius:999px;font-size:12px;font-weight:500;transition:all .15s}
.chat-chip:hover{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-soft)}
.chat-messages{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:4px 2px 14px}
.chat-msg{max-width:86%;padding:11px 14px;border-radius:12px;font-size:13.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.chat-msg.user{align-self:flex-end;background:var(--cta);color:var(--cta-text);border-bottom-right-radius:4px}
.chat-msg.assistant{align-self:flex-start;background:var(--bg);border:1px solid var(--border);color:var(--text);border-bottom-left-radius:4px}
.chat-msg.assistant strong{color:var(--text)}
.chat-input-bar{display:flex;gap:8px;padding-top:12px;border-top:1px solid var(--border)}
.chat-input-bar .ctrl{flex:1}

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

/* UP Monitor Video Cover Grid & Skeleton */
.mon-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:18px;padding:14px 18px;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow-sm)}
.mon-tb-left h2{font-size:16.5px;font-weight:800;margin-bottom:3px}
.mon-tb-left p{font-size:12.5px;color:var(--soft)}
.mon-tb-actions{display:flex;gap:8px;flex-wrap:wrap}

.video-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(256px,1fr));gap:22px 16px}
.v-card{display:flex;flex-direction:column;min-width:0}
.v-thumb-link{position:relative;display:block;width:100%;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:var(--surface-3);border:1px solid var(--border);text-decoration:none}
.v-thumb-link img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .28s ease}
.v-card:hover .v-thumb-link img{transform:scale(1.035)}
.v-dur{position:absolute;right:8px;bottom:8px;background:rgba(15,17,22,.82);color:#fff;font-size:11.5px;font-weight:600;padding:2px 6px;border-radius:5px;line-height:1.3;font-variant-numeric:tabular-nums}
.v-sum-badge{position:absolute;left:8px;top:8px;background:rgba(16,185,129,.92);color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px}
.v-body{display:flex;align-items:flex-start;gap:10px;padding-top:10px}
.v-ava{width:34px;height:34px;border-radius:50%;object-fit:cover;background:var(--surface-3);border:1px solid var(--border);flex-shrink:0;margin-top:2px}
.v-ava-fb{width:34px;height:34px;border-radius:50%;background:var(--surface-3);color:var(--soft);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);flex-shrink:0;margin-top:2px}
.v-meta-col{flex:1;min-width:0}
.v-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;font-weight:700;line-height:1.42;color:var(--text);text-decoration:none;margin-bottom:5px;word-break:break-word}
.v-title:hover{color:var(--brand-dark)}
.v-author{font-size:12.5px;color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.v-stats{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:7px}
.v-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}
.v-time-pill{display:inline-block;background:var(--surface-3);color:var(--soft);font-size:11px;font-weight:500;padding:2px 8px;border-radius:999px;white-space:nowrap}
.v-act-row{display:inline-flex;align-items:center;gap:6px}
.v-act-btn{border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:7px;white-space:nowrap;transition:all .15s}
.v-act-btn:hover{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-soft)}
.v-act-btn.primary{background:var(--cta);color:var(--cta-text);border-color:transparent}
.v-act-btn.primary:hover{background:var(--cta-hover);color:var(--cta-text)}

.skel{background:linear-gradient(90deg,var(--surface-3) 25%,var(--surface-2) 50%,var(--surface-3) 75%);background-size:200% 100%;animation:shimmer 1.3s infinite linear;border-radius:8px}

/* Modals */
.modal-backdrop{position:fixed;inset:0;background:rgba(10,12,18,.52);backdrop-filter:blur(4px);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-lg);width:100%;max-width:440px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;animation:modalPop .2s cubic-bezier(.22,1,.36,1)}
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

.m-tabs{position:relative;display:inline-flex;gap:4px;margin-bottom:18px;background:var(--surface-2);padding:3px;border-radius:9px;border:1px solid var(--border)}
.m-tab{position:relative;z-index:1;border:none;background:transparent;padding:6px 14px;border-radius:7px;font-size:13px;font-weight:600;color:var(--soft);white-space:nowrap;transition:color .22s ease}
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
.cron-badge{font-family:Consolas,monospace;font-size:12px;padding:3px 9px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--brand-dark);white-space:nowrap}

/* Inline & Floating Toasts */
.sb-toast{margin-top:8px;padding:8px 11px;border-radius:8px;font-size:12.5px;line-height:1.5;display:none}
.sb-toast.show{display:block}
.sb-toast.ok{background:var(--ok-soft);color:var(--ok-text)}
.sb-toast.err{background:var(--err-soft);color:var(--err-text);border:1px solid var(--err-border)}
.sb-toast.info{background:var(--surface-3);color:var(--soft)}

.global-toast{position:fixed;right:24px;bottom:24px;z-index:400;padding:11px 16px;border-radius:11px;font-size:13px;font-weight:600;background:var(--cta);color:var(--cta-text);box-shadow:var(--shadow-lg);opacity:0;transform:translateY(14px);pointer-events:none;transition:opacity .22s ease,transform .24s cubic-bezier(.22,1,.36,1)}
.global-toast.show{opacity:1;transform:translateY(0)}
.global-toast.err{background:#DC2626;color:#fff}

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

@media(max-width:1100px){
  .app{grid-template-columns:300px 1px 1fr}
  .topbar{padding:0 18px}
  .content-scroll{padding:18px}
  .kpi-grid{grid-template-columns:repeat(2,1fr)}
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
  .video-head{flex-direction:column}
  .reader-grid.split,.recent-grid,.form-row{grid-template-columns:1fr}
  .style-grid{grid-template-columns:repeat(2,1fr)}
  .video-grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
}
</style>
</head>
<body>
<div class="app" id="appRoot">
  <!-- LEFT SIDEBAR -->
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-l">
        <div class="brand-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3l3 3M16 3l-3 3"/>
            <rect x="3" y="6" width="18" height="14" rx="4"/>
            <path d="M9 12v2M15 12v2"/>
          </svg>
        </div>
        <div>
          <div class="brand-title">B站AI摘要</div>
          <div class="brand-sub">视频语音转录 · 知识工作台</div>
        </div>
      </div>
      <button class="brand-home-btn" onclick="showDashboard()" title="查看知识库概览">概览</button>
    </div>

    <!-- Top-Left Sidebar Switcher -->
    <div class="side-switcher" id="sideSwitcher">
      <span class="seg-slider"></span>
      <button class="side-sw-btn active" data-page="workspace" onclick="switchPage('workspace')">单条摘要</button>
      <button class="side-sw-btn" data-page="monitor" onclick="switchPage('monitor')">UP主监控</button>
    </div>

    <!-- SIDEBAR A: SINGLE VIDEO WORKSPACE -->
    <div class="side-pane" id="sidebarWorkspace">
      <div class="input-shell">
        <input id="videoUrl" type="text" placeholder="输入B站视频链接或 BV 号..." autocomplete="off" onkeydown="if(event.key==='Enter')submitVideo()">
        <button class="btn-submit" id="submitBtn" onclick="submitVideo()">开始总结</button>
      </div>

      <div class="sub-actions">
        <button class="adv-toggle" id="advToggleBtn" type="button" onclick="toggleAdv()">
          <span>高级配置</span>
          <svg class="ic caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <button class="adv-toggle" type="button" onclick="openModal('batchModal')">
          <span>批量提交</span>
        </button>
      </div>

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

      <div class="history-wrap">
        <div class="search-box">
          <span class="s-ic">
            <svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          </span>
          <input class="ctrl" id="searchInput" type="text" placeholder="搜索标题、UP主或 BV 号..." oninput="renderList()">
        </div>

        <div class="h-filter-tabs" id="historyFilterTabs">
          <span class="seg-slider"></span>
          <button class="h-ftab active" data-hf="all" onclick="setHistoryFilter('all')">全部</button>
          <button class="h-ftab" data-hf="starred" onclick="setHistoryFilter('starred')">收藏</button>
          <button class="h-ftab" data-hf="watchlater" onclick="setHistoryFilter('watchlater')">稍后再看</button>
          <button class="h-ftab" data-hf="failed" onclick="setHistoryFilter('failed')">失败</button>
        </div>

        <div class="folder-bar" id="wsFolderBar"></div>

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

    <!-- SIDEBAR B: MONITORED UP CREATORS -->
    <div class="side-pane hidden" id="sidebarMonitor">
      <div class="search-box">
        <span class="s-ic">
          <svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        </span>
        <input class="ctrl" id="upSearchInput" type="text" placeholder="搜索已监控 UP 主（昵称或 UID）..." oninput="renderUpSidebar()">
      </div>

      <div class="quick-add-box">
        <span class="quick-add-label">添加监控 UP 主</span>
        <div class="quick-add-row">
          <input class="ctrl" id="sideAddUpInput" type="text" placeholder="输入 UID 或主页链接..." onkeydown="if(event.key==='Enter')quickAddMonitorUp()">
          <button class="btn btn-primary" type="button" id="sideAddUpBtn" onclick="quickAddMonitorUp()">添加</button>
        </div>
        <div class="sb-toast" id="sideUpToast"></div>
      </div>

      <div class="folder-bar" id="monFolderBar"></div>

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

    <div class="content-scroll" id="contentScroll">
      <div class="content-inner" id="contentInner">
        <!-- PAGE 1: WORKSPACE -->
        <div id="pageWorkspace">
          <div class="stepper hidden" id="stepperBar"></div>

          <!-- DASHBOARD OVERVIEW STATE -->
          <div id="dashboardView">
            <div class="dash-hero">
              <h2>B站视频 AI 知识工作台</h2>
              <p>粘贴 B 站链接即可完成免费语音转录与结构化提炼；支持秒速切换多风格重总结、可视化思维导图、全文关键词检索、围绕视频多轮 AI 追问以及导出分享长图。</p>
            </div>
            <div class="kpi-grid" id="kpiGrid"></div>
            <div style="font-size:13px;font-weight:700;color:var(--soft);margin-bottom:10px">最近完成的视频摘要</div>
            <div class="recent-grid" id="recentGrid"></div>
          </div>

          <!-- VIDEO DETAIL WORKSPACE -->
          <div id="detailView" class="hidden">
            <section class="video-head">
              <div class="vh-left">
                <h1 class="vh-title"><a id="dTitleLink" href="#" target="_blank" rel="noopener">—</a></h1>
                <div class="vh-pills" id="dPills"></div>
                <div class="vh-tag-row" id="dTagRow"></div>
              </div>
              <div class="vh-actions">
                <button class="wl-btn" id="wlBtn" onclick="toggleWatchLaterCurrent()">
                  <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>
                  <span id="wlBtnText">稍后再看</span>
                </button>
                <button class="star-btn" id="starBtn" onclick="toggleStarCurrent()">
                  <svg class="ic" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                  <span id="starBtnText">收藏</span>
                </button>
                <a class="watch-btn" id="dWatchLink" href="#" target="_blank" rel="noopener">
                  <span>在B站观看</span>
                  <svg class="ic" viewBox="0 0 24 24"><path d="M7 17L17 7M7 7h10v10"/></svg>
                </a>
              </div>
            </section>

            <div class="view-bar">
              <div class="seg-tabs" id="segTabs">
                <span class="seg-slider"></span>
                <button class="seg-tab active" data-mode="summary" onclick="setViewMode('summary')">AI 总结</button>
                <button class="seg-tab" data-mode="mindmap" onclick="setViewMode('mindmap')">思维导图</button>
                <button class="seg-tab" data-mode="transcript" onclick="setViewMode('transcript')">完整转录</button>
                <button class="seg-tab" data-mode="split" onclick="setViewMode('split')">分栏对照</button>
                <button class="seg-tab" data-mode="chat" onclick="setViewMode('chat')">AI 追问</button>
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
                <button class="act-btn" onclick="exportFile('txt')"><span>导出 TXT</span></button>
                <button class="act-btn" onclick="exportPosterPng()"><span>分享长图</span></button>
              </div>
            </div>

            <div class="reader-grid" id="readerGrid">
              <!-- SUMMARY PANEL -->
              <article class="reader-card" id="summaryPanel">
                <div class="style-switch-bar" id="styleSwitchBar">
                  <div class="style-pills">
                    <span style="font-size:12px;color:var(--muted);font-weight:600;margin-right:2px">秒速重总结：</span>
                    <button class="style-pill" data-rs="daily" onclick="resummarizeCurrent('daily')">精炼日报</button>
                    <button class="style-pill" data-rs="notes" onclick="resummarizeCurrent('notes')">深度笔记</button>
                    <button class="style-pill" data-rs="quotes" onclick="resummarizeCurrent('quotes')">金句观点</button>
                    <button class="style-pill" data-rs="flashcards" onclick="resummarizeCurrent('flashcards')">学习闪卡</button>
                  </div>
                  <div class="fs-group">
                    <button class="fs-btn" onclick="adjustReaderFont(-1)" title="缩小字号">A-</button>
                    <button class="fs-btn" onclick="adjustReaderFont(1)" title="放大字号">A+</button>
                  </div>
                </div>
                <div class="panel-label hidden" id="summaryPanelLabel">AI 总结</div>
                <div id="summaryContent"></div>
              </article>

              <!-- MINDMAP PANEL -->
              <article class="reader-card hidden" id="mindmapPanel">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
                  <div class="panel-label" style="margin:0">结构化思维导图（点击节点可折叠）</div>
                  <button class="btn btn-sm" onclick="copyMindmapOutline()">复制导图大纲</button>
                </div>
                <div id="mindmapContent"></div>
              </article>

              <!-- TRANSCRIPT PANEL -->
              <article class="reader-card hidden" id="transcriptPanel">
                <div class="panel-label">完整语音转录</div>
                <div class="tr-search-bar">
                  <input class="ctrl" id="trSearchInput" type="text" placeholder="在转录文本中搜索关键词..." oninput="highlightTranscript()">
                  <span class="tr-match-count" id="trMatchCount"></span>
                  <button class="btn btn-sm" onclick="jumpTrMatch(-1)">上一处</button>
                  <button class="btn btn-sm" onclick="jumpTrMatch(1)">下一处</button>
                </div>
                <div class="transcript-box" id="transcriptContent"></div>
              </article>

              <!-- AI CHAT PANEL -->
              <article class="reader-card hidden" id="chatPanel">
                <div class="chat-panel">
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                    <div class="panel-label" style="margin:0">基于本视频内容的 AI 多轮追问（100% 免费模型 · 秒级响应）</div>
                    <button class="text-btn" onclick="clearVideoChat()">清空对话</button>
                  </div>
                  <div class="chat-quick-row">
                    <button class="chat-chip" onclick="sendVideoChat('请提取视频中提到的所有工具、网站、书籍或核心概念清单')">提取工具与概念清单</button>
                    <button class="chat-chip" onclick="sendVideoChat('请用通俗易懂的大白话，给完全零基础的新手重新讲解一遍这个视频的核心内容')">用大白话给新手讲一遍</button>
                    <button class="chat-chip" onclick="sendVideoChat('视频中有哪些核心论点、潜在争议或需要注意的前提条件？')">梳理核心论点与争议</button>
                    <button class="chat-chip" onclick="sendVideoChat('请帮我把视频干货改写成一篇适合发小红书或朋友圈的精炼笔记（300字以内）')">改写为社媒精华笔记</button>
                  </div>
                  <div class="chat-messages" id="chatMessages"></div>
                  <div class="chat-input-bar">
                    <input class="ctrl" id="chatInput" type="text" placeholder="围绕这个视频继续提问，按 Enter 发送..." onkeydown="if(event.key==='Enter')sendVideoChat()">
                    <button class="btn btn-primary" id="chatSendBtn" onclick="sendVideoChat()">发送</button>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </div>

        <!-- PAGE 2: UP MONITOR COVER GRID -->
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
          <div class="feed-footer" id="feedFooter"></div>
          <div id="feedSentinel" style="height:2px"></div>
        </div>
      </div>
    </div>
  </main>
</div>

<!-- GLOBAL FLOATING TOAST -->
<div class="global-toast" id="globalToast"></div>

<!-- TAG PICKER POPOVER -->
<div class="tag-popover hidden" id="tagPopover"></div>

<!-- TAG FOLDER MANAGER MODAL -->
<div class="modal-backdrop hidden" id="tagManagerModal" onclick="if(event.target===this)closeModal('tagManagerModal')">
  <div class="modal">
    <div class="modal-head">
      <div>
        <h2>标签文件夹管理</h2>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">同时适用于单条摘要分类与 UP 主分组，登录后自动同步至云端</div>
      </div>
      <button class="icon-btn" onclick="closeModal('tagManagerModal')" aria-label="关闭">
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>新建标签文件夹</label>
        <div style="display:flex;gap:8px">
          <input class="ctrl" id="newFolderNameInput" type="text" maxlength="16" placeholder="例如：科技、历史、游戏、AI工具..." onkeydown="if(event.key==='Enter')createNewFolder()">
          <button class="btn btn-primary" type="button" onclick="createNewFolder()">创建</button>
        </div>
        <div class="color-swatches" id="folderColorSwatches"></div>
      </div>
      <div style="font-size:12px;font-weight:700;color:var(--soft);margin-top:16px">已有标签文件夹</div>
      <div class="folder-mgr-list" id="folderMgrList"></div>
    </div>
    <div class="modal-foot">
      <span style="font-size:12px;color:var(--muted)" id="librarySyncHint">本地已保存</span>
      <button class="btn btn-primary" onclick="closeModal('tagManagerModal')">完成</button>
    </div>
  </div>
</div>

<!-- BATCH SUBMIT MODAL -->
<div class="modal-backdrop hidden" id="batchModal" onclick="if(event.target===this)closeModal('batchModal')">
  <div class="modal">
    <div class="modal-head">
      <h2>批量提交视频链接</h2>
      <button class="icon-btn" onclick="closeModal('batchModal')" aria-label="关闭">
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>每行粘贴一个 B 站视频链接或 BV 号（单次最多 5 条）</label>
        <textarea class="ctrl" id="batchUrlsInput" style="min-height:130px" placeholder="https://www.bilibili.com/video/BV149ypz6Ehs&#10;BV1ZssS6iEB9"></textarea>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal('batchModal')">取消</button>
      <button class="btn btn-primary" id="batchSubmitBtn" onclick="submitBatchVideos()">加入处理队列</button>
    </div>
  </div>
</div>

<!-- INLINE SUMMARY READER MODAL -->
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

<!-- SETTINGS MODAL -->
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
        <div class="sec-head"><h4>单条摘要邮件通知</h4></div>
        <div class="switch-row" style="margin-bottom:14px">
          <div>
            <div style="font-size:13.5px;font-weight:700">单条视频总结完成后发送邮件</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px">关闭后，网页端手动提交的单条视频总结仅保存在页面与 R2，不再发邮件</div>
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
        <div class="sec-head"><h4>摘要与阅读偏好</h4></div>
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
              <option value="mindmap">思维导图</option>
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
          <div class="sec-head"><h4>扫描策略</h4></div>
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
          <div class="sec-head"><h4>选择日报邮件样式（点击切换实时预览）</h4></div>
          <div class="style-grid" id="styleGrid">
            <button type="button" class="style-card" data-style="editorial" onclick="selectEmailStyle('editorial')">
              <div class="style-thumb" style="background:#f8fafc">
                <div class="st-hd" style="background:#111827;border-top:3px solid #fb7299"><div class="st-bar" style="background:#fff"></div></div>
                <div class="st-bd"><div style="height:12px;background:#fff5f7;border-left:2px solid #fb7299;border-radius:2px"></div><div class="st-line" style="width:85%"></div><div class="st-line" style="width:65%"></div></div>
              </div>
              <div class="style-name">编辑部日报</div>
              <div class="style-desc">深炭灰报头 · 珊瑚粉饰条</div>
            </button>
            <button type="button" class="style-card" data-style="minimal" onclick="selectEmailStyle('minimal')">
              <div class="style-thumb" style="background:#ffffff">
                <div class="st-hd" style="background:#ffffff;border-top:3px solid #111827;border-bottom:1px solid #e5e7eb"><div class="st-bar" style="background:#111827"></div></div>
                <div class="st-bd"><div style="height:12px;background:#f9fafb;border-left:2px solid #111827;border-radius:2px"></div><div class="st-line" style="width:80%"></div><div class="st-line" style="width:60%"></div></div>
              </div>
              <div class="style-name">极简纸刊</div>
              <div class="style-desc">纯白留白 · Notion 质感</div>
            </button>
            <button type="button" class="style-card" data-style="bilibili" onclick="selectEmailStyle('bilibili')">
              <div class="style-thumb" style="background:#fffbfc">
                <div class="st-hd" style="background:linear-gradient(135deg,#fb7299,#ff8fab)"><div class="st-bar" style="background:#fff"></div></div>
                <div class="st-bd"><div style="height:12px;background:#fff1f5;border-left:2px solid #fb7299;border-radius:2px"></div><div class="st-line" style="width:82%;background:#fbcfe8"></div><div class="st-line" style="width:62%;background:#fce7f3"></div></div>
              </div>
              <div class="style-name">B站元气粉</div>
              <div class="style-desc">樱花粉渐变 · 社区轻快</div>
            </button>
            <button type="button" class="style-card" data-style="compact" onclick="selectEmailStyle('compact')">
              <div class="style-thumb" style="background:#ffffff">
                <div class="st-hd" style="background:#0f172a;border-top:3px solid #38bdf8"><div class="st-bar" style="background:#7dd3fc"></div></div>
                <div class="st-bd" style="gap:3px"><div style="height:9px;background:#f0f9ff;border-left:2px solid #0284c7"></div><div class="st-line" style="width:90%"></div><div class="st-line" style="width:75%"></div><div class="st-line" style="width:68%"></div></div>
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
const LS_PREFS = 'bilisum_prefs_v1';
const LS_CHATS = 'bilisum_chats_v1';
const LS_LIBRARY = 'bilisum_library_v1';

const FOLDER_COLORS = ['#2563EB', '#D97706', '#7C3AED', '#059669', '#E11D48', '#0891B2', '#4F46E5', '#64748B'];
const DEFAULT_FOLDERS = [
  { id: 'tech', name: '科技', color: '#2563EB' },
  { id: 'history', name: '历史', color: '#D97706' },
  { id: 'game', name: '游戏', color: '#7C3AED' },
  { id: 'software', name: '软件', color: '#059669' },
];

let currentPage = 'workspace';
let selectedJobId = null;
let selectedUpMid = 'all';
let selectedWsFolder = '';
let selectedMonFolder = '';
let currentFeedVideos = [];
let modalSummaryRaw = '';
let viewMode = 'summary';
let historyFilter = 'all';
let readerFontPx = 14;
let trMatchIndex = -1;
let batchMode = false;
let selectedIds = [];
let pollTimers = {};
let authUser = '';
let toastTimer = null;
let selectedNewFolderColor = FOLDER_COLORS[0];
let librarySyncTimer = null;
let pageScrollPos = { workspace: 0, monitor: 0 };
let monitorPageBooted = false;
let lastRenderedFeedKey = '';
let lastRenderedFeedSig = '';

let libraryState = loadLocalLibrary();

function loadLocalLibrary() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_LIBRARY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        folders: Array.isArray(raw.folders) && raw.folders.length ? raw.folders : DEFAULT_FOLDERS.map(f => ({ ...f })),
        job_tags: raw.job_tags && typeof raw.job_tags === 'object' ? raw.job_tags : {},
        up_tags: raw.up_tags && typeof raw.up_tags === 'object' ? raw.up_tags : {},
        watch_later: Array.isArray(raw.watch_later) ? raw.watch_later : [],
        favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
      };
    }
  } catch {}
  return {
    folders: DEFAULT_FOLDERS.map(f => ({ ...f })),
    job_tags: {},
    up_tags: {},
    watch_later: [],
    favorites: [],
  };
}

function saveLibraryLocalAndCloud() {
  try { localStorage.setItem(LS_LIBRARY, JSON.stringify(libraryState)); } catch {}
  const hint = document.getElementById('librarySyncHint');
  if (!authUser) {
    if (hint) hint.textContent = '已保存在本地浏览器（登录管理员后可云端同步）';
    return;
  }
  if (hint) hint.textContent = '正在同步至云端 R2...';
  clearTimeout(librarySyncTimer);
  librarySyncTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
        body: JSON.stringify({ library: libraryState }),
      });
      if (hint) hint.textContent = r.ok ? '已同步至 Cloudflare R2' : '本地已保存（云端同步稍后重试）';
    } catch {
      if (hint) hint.textContent = '本地已保存（网络离线）';
    }
  }, 450);
}

async function syncLibraryFromR2() {
  try {
    const r = await fetch('/api/library');
    if (!r.ok) return;
    const d = await r.json();
    if (!d || !d.library) return;
    const remote = d.library;
    // Merge remote folders & maps if local hasn't been customized or merge union
    const localHasCustom = Boolean(localStorage.getItem(LS_LIBRARY));
    if (!localHasCustom) {
      libraryState = {
        folders: remote.folders && remote.folders.length ? remote.folders : DEFAULT_FOLDERS.map(f => ({ ...f })),
        job_tags: remote.job_tags || {},
        up_tags: remote.up_tags || {},
        watch_later: remote.watch_later || [],
        favorites: remote.favorites || [],
      };
    } else {
      const fMap = new Map();
      (remote.folders || []).forEach(f => fMap.set(f.id, f));
      (libraryState.folders || []).forEach(f => fMap.set(f.id, f));
      libraryState.folders = Array.from(fMap.values());
      libraryState.job_tags = { ...(remote.job_tags || {}), ...(libraryState.job_tags || {}) };
      libraryState.up_tags = { ...(remote.up_tags || {}), ...(libraryState.up_tags || {}) };
      const mergeVids = (a, b) => {
        const m = new Map();
        (a || []).forEach(v => { if (v && v.bvid) m.set(v.bvid, v); });
        (b || []).forEach(v => { if (v && v.bvid) m.set(v.bvid, v); });
        return Array.from(m.values());
      };
      libraryState.watch_later = mergeVids(remote.watch_later, libraryState.watch_later);
      libraryState.favorites = mergeVids(remote.favorites, libraryState.favorites);
    }
    try { localStorage.setItem(LS_LIBRARY, JSON.stringify(libraryState)); } catch {}
    renderWorkspaceFolderBar();
    renderList();
    if (selectedJobId) {
      const job = getJobs().find(j => j.id === selectedJobId);
      if (job) renderDetailTagBar(job);
    }
    if (currentPage === 'monitor') {
      renderMonitorFolderBar();
      renderUpSidebar();
    }
  } catch {}
}

function getFolderById(id) {
  return (libraryState.folders || []).find(f => f.id === id) || null;
}
function jobTagKey(job) { return String((job && (job.bvid || job.id)) || ''); }
function getJobTagIds(job) {
  const k = jobTagKey(job);
  if (!k) return [];
  const valid = new Set((libraryState.folders || []).map(f => f.id));
  return (libraryState.job_tags[k] || []).filter(id => valid.has(id));
}
function getUpTagIds(mid) {
  const k = String(mid || '');
  if (!k) return [];
  const valid = new Set((libraryState.folders || []).map(f => f.id));
  return (libraryState.up_tags[k] || []).filter(id => valid.has(id));
}
function isWatchLater(bvid) {
  return Boolean(bvid && (libraryState.watch_later || []).some(v => v.bvid === bvid));
}
function isFavBvid(bvid) {
  return Boolean(bvid && (libraryState.favorites || []).some(v => v.bvid === bvid));
}
function isJobFavorited(job) {
  if (!job) return false;
  return Boolean(job.starred || isFavBvid(job.bvid));
}

let monitorConfig = {
  enabled: true, schedule_mode: 'times', times_cst: ['08:00', '20:00'],
  cron_utc: '0 0,12 * * *', up_list: [], email_style: 'editorial',
  merge_emails: true, smtp_to: '', check_window_hours: 72, max_videos_per_run: 5,
};

const DEFAULT_PREFS = {
  send_email_on_single: true,
  default_email_style: 'editorial',
  default_email: '',
  default_tpl: '',
  default_view: 'summary',
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
const SVG_CHEV = '<svg class="ic c-select-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
const SVG_CHK = '<svg class="ic c-select-chk" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_STAR_SM = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const SVG_CLOCK_SM = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>';
const SVG_STAR_LINE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const SVG_TAG_SM = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function normStatus(st) {
  if (st === 'done' || st === 'success' || st === 'completed') return 'completed';
  if (st === 'failed' || st === 'error') return 'failed';
  return 'pending';
}

function toast(msg, isErr) {
  const el = document.getElementById('globalToast');
  el.textContent = msg;
  el.className = 'global-toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3200);
}

function showToast(elId, msg, kind) {
  const el = document.getElementById(elId);
  if (!el) { toast(msg, kind === 'err'); return; }
  el.textContent = msg;
  el.className = 'sb-toast show ' + (kind || 'info');
  if (kind === 'ok' || kind === 'info') setTimeout(() => { el.classList.remove('show'); }, 4000);
}

function parseDurationSec(dur) {
  if (!dur) return 0;
  const parts = String(dur).split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60 + parts[1];
  return parts[0] || 0;
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
function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + p(d.getMonth()+1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── Rock-Solid Spring Sliding Pill Engine (ResizeObserver + getBoundingClientRect) ──
const SLIDER_IDS = ['sideSwitcher', 'historyFilterTabs', 'segTabs', 'monitorTabs'];

function moveSlider(containerId, instant) {
  const box = document.getElementById(containerId);
  if (!box) return;
  const slider = box.querySelector('.seg-slider');
  const active = box.querySelector('.active');
  if (!slider || !active) return;
  const boxRect = box.getBoundingClientRect();
  const actRect = active.getBoundingClientRect();
  if (actRect.width === 0 || boxRect.width === 0) return;

  const borderLeft = parseFloat(getComputedStyle(box).borderLeftWidth) || 0;
  const x = Math.round((actRect.left - boxRect.left - borderLeft) * 10) / 10;
  const w = Math.round(actRect.width * 10) / 10;

  if (instant || !slider.dataset.ready) {
    slider.style.transition = 'none';
    slider.style.width = w + 'px';
    slider.style.transform = 'translateX(' + x + 'px)';
    void slider.offsetWidth;
    slider.style.transition = '';
    slider.dataset.ready = '1';
  } else {
    box._lastAnimAt = Date.now();
    slider.style.width = w + 'px';
    slider.style.transform = 'translateX(' + x + 'px)';
  }
}

function updateAllSliders(instant) {
  SLIDER_IDS.forEach(id => moveSlider(id, instant));
}

function initSliderObservers() {
  if (typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(entries => {
    entries.forEach(e => {
      const box = e.target;
      if (!box || !box.id) return;
      const slider = box.querySelector('.seg-slider');
      const nowW = Math.round(e.contentRect ? e.contentRect.width : box.getBoundingClientRect().width);
      if (slider && slider.dataset.ready && Date.now() - (box._lastAnimAt || 0) < 420) return;
      if (slider && slider.dataset.ready && box._lastBoxW === nowW) return;
      box._lastBoxW = nowW;
      moveSlider(box.id, true);
    });
  });
  SLIDER_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) ro.observe(el);
  });
}

function playAnim(el) {
  if (!el) return;
  el.classList.remove('anim-in');
  void el.offsetWidth;
  el.classList.add('anim-in');
}

// ── Custom Card-Style Select ──
function closeAllCustomSelects(exceptWrap) {
  document.querySelectorAll('.c-select.open').forEach(w => { if (w !== exceptWrap) w.classList.remove('open', 'drop-up'); });
}
function syncCustomSelect(sel) {
  if (typeof sel === 'string') sel = document.getElementById(sel);
  if (!sel || !sel._csWrap) return;
  const wrap = sel._csWrap;
  const opt = sel.options[sel.selectedIndex] || sel.options[0];
  wrap.querySelector('.c-select-label').textContent = opt ? opt.textContent : '';
  wrap.querySelectorAll('.c-select-opt').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === sel.value));
}
function syncAllCustomSelects() { document.querySelectorAll('select.c-select-native').forEach(syncCustomSelect); }
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
        const spaceBelow = window.innerHeight - btn.getBoundingClientRect().bottom;
        wrap.classList.toggle('drop-up', spaceBelow < 210);
        wrap.classList.add('open');
      } else wrap.classList.remove('open', 'drop-up');
    });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    sel._csWrap = wrap;
    syncCustomSelect(sel);
  });
}
document.addEventListener('click', () => closeAllCustomSelects(null));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllCustomSelects(null); });

// ── Theme & Font Size ──
function initTheme() {
  const saved = localStorage.getItem(LS_THEME) || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('themeBtn').innerHTML = saved === 'dark' ? SVG_SUN : SVG_MOON;
}
function toggleTheme() {
  const next = (document.documentElement.getAttribute('data-theme') || 'light') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(LS_THEME, next);
  document.getElementById('themeBtn').innerHTML = next === 'dark' ? SVG_SUN : SVG_MOON;
}
function adjustReaderFont(delta) {
  readerFontPx = Math.max(12, Math.min(18, readerFontPx + delta));
  document.documentElement.style.setProperty('--reader-fs', readerFontPx + 'px');
}

// ── Divider Drag ──
(function initDivider() {
  const div = document.getElementById('divider');
  let dragging = false;
  div.addEventListener('mousedown', () => { dragging = true; div.classList.add('dragging'); document.body.style.userSelect = 'none'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    document.getElementById('appRoot').style.setProperty('--sidebar-w', Math.max(268, Math.min(480, e.clientX)) + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; div.classList.remove('dragging'); document.body.style.userSelect = '';
  });
})();

function toggleAdv() {
  const box = document.getElementById('advBox');
  const hidden = box.classList.toggle('hidden');
  document.getElementById('advToggleBtn').classList.toggle('open', !hidden);
}
function onTplPreset() {
  document.getElementById('customTplWrap').classList.toggle('hidden', document.getElementById('tplPreset').value !== 'custom');
}

// ── Zero-Flicker Page Switcher ──
async function switchPage(page) {
  if (page === 'monitor' && !authUser) {
    openModal('loginModal');
    setTimeout(() => document.getElementById('loginPass').focus(), 60);
    return;
  }
  if (page === currentPage) return;
  closeTagPopover();
  const scrollEl = document.getElementById('contentScroll');
  if (scrollEl) pageScrollPos[currentPage] = scrollEl.scrollTop;

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
  document.getElementById('contentInner').classList.toggle('wide-feed', page === 'monitor');

  if (scrollEl) scrollEl.scrollTop = pageScrollPos[page] || 0;

  if (page === 'workspace') {
    document.getElementById('topbarTitle').textContent = selectedJobId ? '单条视频摘要' : '视频知识库概览';
    document.getElementById('topbarSub').textContent = '';
    requestAnimationFrame(() => { moveSlider('segTabs', true); moveSlider('historyFilterTabs', true); });
  } else {
    document.getElementById('topbarTitle').textContent = 'UP主监控动态';
    await loadMonitorPage();
  }
}

// ── User Preferences ──
function getUserPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(LS_PREFS) || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
}
function applyUserPrefsToUi() {
  const p = getUserPrefs();
  const stEl = document.getElementById('singleEmailStyle');
  const emEl = document.getElementById('customEmail');
  const tplEl = document.getElementById('tplPreset');
  if (stEl) { stEl.value = p.default_email_style || 'editorial'; syncCustomSelect(stEl); }
  if (emEl && !emEl.value) emEl.value = p.default_email || '';
  if (tplEl) { tplEl.value = p.default_tpl || ''; syncCustomSelect(tplEl); onTplPreset(); }
  if (p.default_view && ['summary', 'mindmap', 'transcript', 'split', 'chat'].includes(p.default_view)) {
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
  } catch { badge.textContent = '状态读取失败'; }
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
  moveSlider('segTabs');
  closeModal('settingsModal');
  toast('偏好设置已保存');
}
function resetUserPrefs() {
  localStorage.removeItem(LS_PREFS);
  applyUserPrefsToUi();
  openSettingsModal();
  toast('已恢复默认设置');
}
function clearAllFeedCacheFromSettings() {
  clearFeedCache(null);
  prefetchDone = false;
  toast('已清空 UP 主动态本地缓存');
}

// ── Jobs Storage & Dashboard ──
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
  renderDashboard();
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
        else if (prev && j.starred) prev.starred = true;
      }
    });
    const merged = Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    localStorage.setItem(LS_JOBS, JSON.stringify(merged));
    renderList();
    renderDashboard();
    if (!selectedJobId && merged.length > 0) selectJob(merged[0].id);
  } catch {}
}

function showDashboard() {
  if (currentPage !== 'workspace') switchPage('workspace');
  selectedJobId = null;
  document.getElementById('topbarTitle').textContent = '视频知识库概览';
  document.getElementById('detailView').classList.add('hidden');
  document.getElementById('stepperBar').classList.add('hidden');
  document.getElementById('dashboardView').classList.remove('hidden');
  playAnim(document.getElementById('dashboardView'));
  renderList();
  renderDashboard();
}

function renderDashboard() {
  const jobs = getJobs();
  const completed = jobs.filter(j => normStatus(j.status) === 'completed');
  const starred = jobs.filter(j => j.starred);
  let totalSec = 0;
  completed.forEach(j => { totalSec += parseDurationSec(j.duration) || 480; });
  const savedMin = Math.max(0, Math.round(totalSec / 60 * 0.85));
  const totalChars = completed.reduce((acc, j) => acc + (j.transcript || '').length, 0);

  document.getElementById('kpiGrid').innerHTML =
    '<div class="kpi-card"><div class="kpi-label">已归档摘要</div><div class="kpi-val">' + completed.length + '</div><div class="kpi-sub">全部记录 ' + jobs.length + ' 条</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">累计节省时长</div><div class="kpi-val">' + savedMin + ' 分钟</div><div class="kpi-sub">约 ' + (savedMin / 60).toFixed(1) + ' 小时精读</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">已收藏精华</div><div class="kpi-val">' + starred.length + '</div><div class="kpi-sub">一键回看重点视频</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">累计免费转录</div><div class="kpi-val">' + (totalChars >= 10000 ? (totalChars / 10000).toFixed(1) + ' 万字' : totalChars + ' 字') + '</div><div class="kpi-sub">100% 免费模型驱动</div></div>';

  const recent = completed.slice(0, 4);
  document.getElementById('recentGrid').innerHTML = recent.length
    ? recent.map(j => '<div class="recent-card" onclick="selectJob(\'' + esc(j.id) + '\')"><h4>' + esc(j.title || j.bvid) + '</h4><p>' + esc([j.owner, j.duration, j.bvid].filter(Boolean).join(' · ')) + '</p></div>').join('')
    : '<div class="reader-card" style="grid-column:1/-1;text-align:center;color:var(--muted)">在左侧粘贴任意 B 站视频链接，开启你的第一篇 AI 摘要</div>';
}

// ── Submit Single & Batch ──
async function submitVideo(overrideUrl, meta) {
  const input = document.getElementById('videoUrl');
  const raw = (overrideUrl !== undefined ? String(overrideUrl) : input.value).trim();
  if (!raw) { toast('请输入 B 站视频链接或 BV 号', true); return; }

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
  btn.textContent = '解析中...';

  try {
    const reqBody = { url: raw, summary_template: tpl, email, email_style, send_email };
    if (meta && meta.title) reqBody.title = meta.title;
    if (meta && meta.owner) reqBody.owner = meta.owner;
    if (meta && meta.duration) reqBody.duration = meta.duration;

    const resp = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    const data = await resp.json();
    if (!resp.ok) { toast(data.error || '提交失败', true); return null; }
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
    toast(send_email ? '已加入队列（完成后同步发邮件）' : '已加入队列（已关闭单条邮件通知）');
    if (currentPage !== 'workspace') await switchPage('workspace');
    selectJob(newJob.id);
    startPolling(newJob.id);
    return newJob;
  } catch (e) {
    toast('网络错误: ' + e.message, true);
    return null;
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

async function submitBatchVideos() {
  const lines = (document.getElementById('batchUrlsInput').value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 5);
  if (!lines.length) { toast('请至少输入一条视频链接或 BV 号', true); return; }
  const btn = document.getElementById('batchSubmitBtn');
  btn.disabled = true;
  btn.textContent = '提交中...';
  let okCount = 0;
  for (const line of lines) {
    const res = await submitVideo(line);
    if (res) okCount++;
  }
  btn.disabled = false;
  btn.textContent = '加入处理队列';
  document.getElementById('batchUrlsInput').value = '';
  closeModal('batchModal');
  toast('已成功提交 ' + okCount + ' 条视频至后台队列');
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
        const keepStar = jobs[idx].starred;
        jobs[idx] = { ...jobs[idx], ...data, starred: keepStar };
        const finished = data.status === 'completed' || data.status === 'failed';
        saveJobs(jobs, finished);
        if (selectedJobId === jobId) renderDetail(jobs[idx]);
        if (finished) { clearInterval(pollTimers[jobId]); delete pollTimers[jobId]; }
      }
    } catch {}
  }, 4000);
}

// ── Tag Folders, Watch Later & Favorites Logic ──
function setWsFolder(fid) {
  selectedWsFolder = selectedWsFolder === fid ? '' : fid;
  renderWorkspaceFolderBar();
  renderList();
}

function renderWorkspaceFolderBar() {
  const bar = document.getElementById('wsFolderBar');
  if (!bar) return;
  const jobs = getJobs();
  const folders = libraryState.folders || [];
  let html = '<button class="folder-chip' + (!selectedWsFolder ? ' active' : '') + '" onclick="setWsFolder(\'\')">全部标签</button>';
  folders.forEach(f => {
    const cnt = jobs.filter(j => getJobTagIds(j).includes(f.id)).length;
    const act = selectedWsFolder === f.id ? ' active' : '';
    html += '<button class="folder-chip' + act + '" onclick="setWsFolder(\'' + esc(f.id) + '\')">' +
      '<span class="folder-dot" style="background:' + esc(f.color) + '"></span>' +
      '<span>' + esc(f.name) + '</span>' +
      (cnt ? '<span class="folder-cnt">' + cnt + '</span>' : '') +
    '</button>';
  });
  html += '<button class="folder-add-btn" onclick="openTagManagerModal()" title="管理标签文件夹">+ 标签</button>';
  bar.innerHTML = html;
}

function renderDetailTagBar(job) {
  const row = document.getElementById('dTagRow');
  if (!row || !job) return;
  const key = jobTagKey(job);
  const tagIds = getJobTagIds(job);
  let html = tagIds.map(id => {
    const f = getFolderById(id);
    if (!f) return '';
    return '<span class="tag-pill"><span class="folder-dot" style="background:' + esc(f.color) + '"></span><span>' + esc(f.name) + '</span><button type="button" title="移除标签" onclick="toggleJobTag(\'' + esc(key) + '\',\'' + esc(f.id) + '\')">&times;</button></span>';
  }).join('');
  html += '<button type="button" class="tag-add-btn" onclick="openTagPopover(this,\'job\',\'' + esc(key) + '\')">' + SVG_TAG_SM + '<span>添加标签</span></button>';
  row.innerHTML = html;
}

function updateWatchLaterBtn(job) {
  const btn = document.getElementById('wlBtn');
  const txt = document.getElementById('wlBtnText');
  if (!btn || !txt) return;
  const on = Boolean(job && isWatchLater(job.bvid));
  btn.classList.toggle('active', on);
  txt.textContent = on ? '已加稍后再看' : '稍后再看';
}

function toggleWatchLaterVideo(videoObj) {
  if (!videoObj || !videoObj.bvid) return false;
  const list = libraryState.watch_later || [];
  const idx = list.findIndex(v => v.bvid === videoObj.bvid);
  let added = false;
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.unshift({
      bvid: videoObj.bvid,
      job_id: videoObj.job_id || '',
      mid: Number(videoObj.mid) || 0,
      title: videoObj.title || videoObj.bvid,
      author: videoObj.author || videoObj.owner || '',
      face: videoObj.face || '',
      pic: videoObj.pic || '',
      duration: videoObj.duration || '',
      play: Number(videoObj.play) || 0,
      danmaku: Number(videoObj.danmaku) || 0,
      created: Number(videoObj.created) || 0,
      url: videoObj.url || ('https://www.bilibili.com/video/' + videoObj.bvid),
      added_at: new Date().toISOString(),
    });
    added = true;
  }
  libraryState.watch_later = list;
  saveLibraryLocalAndCloud();
  renderList();
  if (selectedJobId) {
    const cur = getJobs().find(j => j.id === selectedJobId);
    if (cur && cur.bvid === videoObj.bvid) updateWatchLaterBtn(cur);
  }
  if (currentPage === 'monitor') {
    renderMonitorFolderBar();
    if (selectedUpMid === '__watchlater') renderSavedGrid('watchlater');
    else syncFeedCardQuickStates(videoObj.bvid);
  }
  toast(added ? '已加入「稍后再看」' : '已移出「稍后再看」');
  return added;
}

function toggleFavoriteVideo(videoObj) {
  if (!videoObj || !videoObj.bvid) return false;
  const list = libraryState.favorites || [];
  const idx = list.findIndex(v => v.bvid === videoObj.bvid);
  const jobs = getJobs();
  const jobIdx = jobs.findIndex(j => j.bvid === videoObj.bvid || (videoObj.job_id && j.id === videoObj.job_id));
  const wasOn = idx >= 0 || (jobIdx >= 0 && jobs[jobIdx].starred);
  let added = false;

  if (wasOn) {
    if (idx >= 0) list.splice(idx, 1);
    if (jobIdx >= 0) { jobs[jobIdx].starred = false; saveJobs(jobs); }
  } else {
    list.unshift({
      bvid: videoObj.bvid,
      job_id: (jobIdx >= 0 ? jobs[jobIdx].id : '') || videoObj.job_id || '',
      mid: Number(videoObj.mid) || 0,
      title: videoObj.title || videoObj.bvid,
      author: videoObj.author || videoObj.owner || '',
      face: videoObj.face || '',
      pic: videoObj.pic || '',
      duration: videoObj.duration || '',
      play: Number(videoObj.play) || 0,
      danmaku: Number(videoObj.danmaku) || 0,
      created: Number(videoObj.created) || 0,
      url: videoObj.url || ('https://www.bilibili.com/video/' + videoObj.bvid),
      added_at: new Date().toISOString(),
    });
    if (jobIdx >= 0) { jobs[jobIdx].starred = true; saveJobs(jobs); }
    added = true;
  }
  libraryState.favorites = list;
  saveLibraryLocalAndCloud();
  renderList();
  renderDashboard();
  if (selectedJobId) {
    const cur = getJobs().find(j => j.id === selectedJobId);
    if (cur && cur.bvid === videoObj.bvid) updateStarBtn(cur);
  }
  if (currentPage === 'monitor') {
    renderMonitorFolderBar();
    if (selectedUpMid === '__favorites') renderSavedGrid('favorites');
    else syncFeedCardQuickStates(videoObj.bvid);
  }
  toast(added ? '已加入「收藏」' : '已取消收藏');
  return added;
}

function toggleWatchLaterCurrent() {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job) return;
  toggleWatchLaterVideo({ bvid: job.bvid, job_id: job.id, title: job.title, author: job.owner, duration: job.duration, url: job.video_url });
}

function toggleJobTag(jobKey, folderId) {
  if (!jobKey || !folderId) return;
  const cur = new Set(libraryState.job_tags[jobKey] || []);
  if (cur.has(folderId)) cur.delete(folderId); else cur.add(folderId);
  if (cur.size) libraryState.job_tags[jobKey] = Array.from(cur);
  else delete libraryState.job_tags[jobKey];
  saveLibraryLocalAndCloud();
  renderWorkspaceFolderBar();
  renderList();
  const job = getJobs().find(j => j.id === selectedJobId);
  if (job && jobTagKey(job) === jobKey) renderDetailTagBar(job);
  refreshOpenTagPopover();
}

function toggleUpTag(mid, folderId) {
  const k = String(mid || '');
  if (!k || !folderId) return;
  const cur = new Set(libraryState.up_tags[k] || []);
  if (cur.has(folderId)) cur.delete(folderId); else cur.add(folderId);
  if (cur.size) libraryState.up_tags[k] = Array.from(cur);
  else delete libraryState.up_tags[k];
  saveLibraryLocalAndCloud();
  renderMonitorFolderBar();
  renderUpSidebar();
  refreshOpenTagPopover();
}

let activeTagPopoverCtx = null;

function closeTagPopover() {
  const pop = document.getElementById('tagPopover');
  if (pop) pop.classList.add('hidden');
  activeTagPopoverCtx = null;
}

function refreshOpenTagPopover() {
  if (!activeTagPopoverCtx) return;
  const { targetType, targetKey } = activeTagPopoverCtx;
  renderTagPopoverBody(targetType, targetKey);
}

function renderTagPopoverBody(targetType, targetKey) {
  const pop = document.getElementById('tagPopover');
  if (!pop) return;
  const folders = libraryState.folders || [];
  const chosen = new Set(targetType === 'up' ? getUpTagIds(targetKey) : (libraryState.job_tags[targetKey] || []));
  const fnName = targetType === 'up' ? 'toggleUpTag' : 'toggleJobTag';
  let html = '<div class="tag-pop-head"><span>选择标签文件夹</span></div>';
  html += folders.map(f => {
    const sel = chosen.has(f.id);
    return '<button type="button" class="tag-pop-item' + (sel ? ' selected' : '') + '" onclick="' + fnName + '(\'' + esc(targetKey) + '\',\'' + esc(f.id) + '\')">' +
      '<span class="tag-pop-left"><span class="folder-dot" style="background:' + esc(f.color) + '"></span><span>' + esc(f.name) + '</span></span>' +
      (sel ? SVG_CHK : '') +
    '</button>';
  }).join('');
  html += '<div class="tag-pop-sep"></div>' +
    '<button type="button" class="tag-pop-item" onclick="closeTagPopover();openTagManagerModal()">' +
      '<span class="tag-pop-left" style="color:var(--brand-dark);font-weight:600">+ 新建或管理文件夹</span>' +
    '</button>';
  pop.innerHTML = html;
}

function openTagPopover(anchorEl, targetType, targetKey) {
  const pop = document.getElementById('tagPopover');
  if (!pop) return;
  if (activeTagPopoverCtx && activeTagPopoverCtx.anchorEl === anchorEl && !pop.classList.contains('hidden')) {
    closeTagPopover();
    return;
  }
  activeTagPopoverCtx = { anchorEl, targetType, targetKey };
  renderTagPopoverBody(targetType, targetKey);
  pop.classList.remove('hidden');
  const rect = anchorEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top = rect.bottom + 6;
  let left = rect.left;
  if (top + popRect.height > window.innerHeight - 12) top = Math.max(12, rect.top - popRect.height - 6);
  if (left + popRect.width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - popRect.width - 12);
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
}

document.addEventListener('click', (e) => {
  const pop = document.getElementById('tagPopover');
  if (!pop || pop.classList.contains('hidden')) return;
  if (pop.contains(e.target)) return;
  if (activeTagPopoverCtx && activeTagPopoverCtx.anchorEl && activeTagPopoverCtx.anchorEl.contains(e.target)) return;
  closeTagPopover();
});

function openTagManagerModal() {
  closeTagPopover();
  renderFolderColorSwatches();
  renderFolderManagerList();
  openModal('tagManagerModal');
}

function renderFolderColorSwatches() {
  const box = document.getElementById('folderColorSwatches');
  if (!box) return;
  box.innerHTML = FOLDER_COLORS.map(c =>
    '<button type="button" class="color-sw' + (selectedNewFolderColor === c ? ' active' : '') + '" style="background:' + c + '" onclick="pickFolderColor(\'' + c + '\')" aria-label="' + c + '"></button>'
  ).join('');
}

function pickFolderColor(c) {
  selectedNewFolderColor = c;
  renderFolderColorSwatches();
}

function renderFolderManagerList() {
  const box = document.getElementById('folderMgrList');
  if (!box) return;
  const jobs = getJobs();
  const ups = monitorConfig.up_list || [];
  const folders = libraryState.folders || [];
  if (!folders.length) {
    box.innerHTML = '<div style="text-align:center;color:var(--muted);padding:16px;font-size:12.5px">暂无标签文件夹，在上方新建一个吧</div>';
    return;
  }
  box.innerHTML = folders.map(f => {
    const jCnt = jobs.filter(j => getJobTagIds(j).includes(f.id)).length;
    const uCnt = ups.filter(u => getUpTagIds(u.mid).includes(f.id)).length;
    return '<div class="folder-mgr-row">' +
      '<div class="folder-mgr-left">' +
        '<span class="folder-dot" style="width:10px;height:10px;background:' + esc(f.color) + '"></span>' +
        '<div><div class="folder-mgr-name">' + esc(f.name) + '</div><div class="folder-mgr-stat">摘要 ' + jCnt + ' 条 · UP主 ' + uCnt + ' 位</div></div>' +
      '</div>' +
      '<div style="display:flex;gap:6px">' +
        '<button type="button" class="btn btn-sm" onclick="renameFolder(\'' + esc(f.id) + '\')">重命名</button>' +
        '<button type="button" class="btn btn-sm" style="color:var(--err)" onclick="deleteFolder(\'' + esc(f.id) + '\')">删除</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function createNewFolder() {
  const inp = document.getElementById('newFolderNameInput');
  const name = (inp.value || '').trim().slice(0, 16);
  if (!name) { toast('请输入文件夹名称', true); return; }
  if ((libraryState.folders || []).some(f => f.name === name)) { toast('已存在同名标签文件夹', true); return; }
  const id = 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  libraryState.folders.push({ id, name, color: selectedNewFolderColor || FOLDER_COLORS[0] });
  inp.value = '';
  saveLibraryLocalAndCloud();
  renderFolderManagerList();
  renderWorkspaceFolderBar();
  renderMonitorFolderBar();
  toast('已创建标签文件夹：' + name);
}

function renameFolder(id) {
  const f = getFolderById(id);
  if (!f) return;
  const next = prompt('输入新的标签文件夹名称：', f.name);
  if (next === null) return;
  const clean = next.trim().slice(0, 16);
  if (!clean) return;
  f.name = clean;
  saveLibraryLocalAndCloud();
  renderFolderManagerList();
  renderWorkspaceFolderBar();
  renderMonitorFolderBar();
  renderList();
  renderUpSidebar();
  const job = getJobs().find(j => j.id === selectedJobId);
  if (job) renderDetailTagBar(job);
  toast('已重命名为：' + clean);
}

function deleteFolder(id) {
  const f = getFolderById(id);
  if (!f) return;
  if (!confirm('确定删除标签文件夹「' + f.name + '」？（不会删除视频或 UP 主本身）')) return;
  libraryState.folders = (libraryState.folders || []).filter(x => x.id !== id);
  if (selectedWsFolder === id) selectedWsFolder = '';
  if (selectedMonFolder === id) selectedMonFolder = '';
  Object.keys(libraryState.job_tags).forEach(k => {
    libraryState.job_tags[k] = (libraryState.job_tags[k] || []).filter(x => x !== id);
    if (!libraryState.job_tags[k].length) delete libraryState.job_tags[k];
  });
  Object.keys(libraryState.up_tags).forEach(k => {
    libraryState.up_tags[k] = (libraryState.up_tags[k] || []).filter(x => x !== id);
    if (!libraryState.up_tags[k].length) delete libraryState.up_tags[k];
  });
  saveLibraryLocalAndCloud();
  renderFolderManagerList();
  renderWorkspaceFolderBar();
  renderMonitorFolderBar();
  renderList();
  renderUpSidebar();
  const job = getJobs().find(j => j.id === selectedJobId);
  if (job) renderDetailTagBar(job);
  toast('已删除文件夹：' + f.name);
}

// ── History List & Filters ──
function setHistoryFilter(f) {
  historyFilter = f;
  document.querySelectorAll('#historyFilterTabs .h-ftab').forEach(b => b.classList.toggle('active', b.dataset.hf === f));
  moveSlider('historyFilterTabs');
  renderList();
}

function renderList() {
  const kw = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  let jobs = getJobs();
  if (historyFilter === 'starred') jobs = jobs.filter(j => isJobFavorited(j));
  else if (historyFilter === 'watchlater') jobs = jobs.filter(j => isWatchLater(j.bvid));
  else if (historyFilter === 'failed') jobs = jobs.filter(j => normStatus(j.status) === 'failed');

  if (selectedWsFolder) {
    jobs = jobs.filter(j => getJobTagIds(j).includes(selectedWsFolder));
  }

  const filtered = kw ? jobs.filter(j =>
    (j.title || '').toLowerCase().includes(kw) ||
    (j.bvid || '').toLowerCase().includes(kw) ||
    (j.owner || '').toLowerCase().includes(kw)
  ) : jobs;

  // Also include unsummarized saved videos when viewing Watch Later or Favorites (without tag filter)
  let extraSaved = [];
  if (!selectedWsFolder && (historyFilter === 'watchlater' || historyFilter === 'starred')) {
    const existingBvids = new Set(getJobs().map(j => j.bvid));
    const pool = historyFilter === 'watchlater' ? (libraryState.watch_later || []) : (libraryState.favorites || []);
    extraSaved = pool.filter(v => !existingBvids.has(v.bvid) && (!kw || (v.title || '').toLowerCase().includes(kw) || (v.author || '').toLowerCase().includes(kw) || (v.bvid || '').toLowerCase().includes(kw)));
  }

  document.getElementById('countPill').textContent = String(filtered.length + extraSaved.length);
  const container = document.getElementById('historyList');
  if (!filtered.length && !extraSaved.length) {
    const emptyMsg = historyFilter === 'watchlater'
      ? '暂无「稍后再看」视频，可在详情页或 UP 主动态中一键添加'
      : (selectedWsFolder ? '该标签文件夹下暂无摘要' : '暂无匹配的历史记录');
    container.innerHTML = '<div style="text-align:center;padding:28px 12px;color:var(--muted);font-size:12.5px">' + emptyMsg + '</div>';
    return;
  }

  let html = filtered.map(j => {
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
    const tagPills = getJobTagIds(j).map(tid => {
      const f = getFolderById(tid);
      return f ? '<span class="mini-tag"><span class="folder-dot" style="width:5px;height:5px;background:' + esc(f.color) + '"></span>' + esc(f.name) + '</span>' : '';
    }).join('');
    const wlBadge = isWatchLater(j.bvid) ? '<span class="mini-tag wl">稍后再看</span>' : '';
    const tagsRow = (tagPills || wlBadge) ? '<div class="mini-tags">' + wlBadge + tagPills + '</div>' : '';

    return '<div class="h-card' + active + '" onclick="selectJob(\'' + esc(j.id) + '\')">' +
      chk +
      '<div class="h-body">' +
        '<div class="h-title">' + esc(j.title || j.bvid || '处理中...') + '</div>' +
        '<div class="h-meta">' + esc(metaParts.join(' · ')) + '</div>' +
        tagsRow +
      '</div>' +
      '<div class="h-right">' +
        '<div style="display:flex;align-items:center;gap:5px">' +
          (isJobFavorited(j) ? '<span class="h-star-dot">' + SVG_STAR_SM + '</span>' : '') +
          '<span class="dot ' + dotCls + '"></span>' +
        '</div>' +
        (!batchMode ? '<button class="h-del" title="删除" onclick="event.stopPropagation();deleteOneJob(\'' + esc(j.id) + '\')">' + SVG_CLOSE_SM + '</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  if (extraSaved.length) {
    html += extraSaved.map(v =>
      '<div class="h-card" onclick="submitVideo(\'' + esc(v.bvid) + '\',{title:' + JSON.stringify(v.title || '') + ',owner:' + JSON.stringify(v.author || '') + ',duration:' + JSON.stringify(v.duration || '') + '})">' +
        '<div class="h-body">' +
          '<div class="h-title">' + esc(v.title || v.bvid) + '</div>' +
          '<div class="h-meta">' + esc([v.author, v.duration, v.bvid].filter(Boolean).join(' · ')) + '</div>' +
          '<div class="mini-tags"><span class="mini-tag wl">点击立即总结</span></div>' +
        '</div>' +
      '</div>'
    ).join('');
  }
  container.innerHTML = html;
}

function selectJob(id) {
  if (currentPage !== 'workspace') switchPage('workspace');
  selectedJobId = id;
  const job = getJobs().find(j => j.id === id);
  renderList();
  if (!job) return;
  document.getElementById('topbarTitle').textContent = '单条视频摘要';
  document.getElementById('dashboardView').classList.add('hidden');
  document.getElementById('detailView').classList.remove('hidden');
  renderDetail(job);
  if (normStatus(job.status) === 'pending') startPolling(job.id);
}

function toggleStarCurrent() {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job) return;
  toggleFavoriteVideo({ bvid: job.bvid, job_id: job.id, title: job.title, author: job.owner, duration: job.duration, url: job.video_url });
}

function updateStarBtn(job) {
  const btn = document.getElementById('starBtn');
  const txt = document.getElementById('starBtnText');
  const on = isJobFavorited(job);
  btn.classList.toggle('starred', on);
  txt.textContent = on ? '已收藏' : '收藏';
}

function deleteOneJob(id) {
  const jobs = getJobs().filter(j => j.id !== id);
  if (selectedJobId === id) {
    selectedJobId = jobs[0] ? jobs[0].id : null;
  }
  saveJobs(jobs);
  if (selectedJobId) selectJob(selectedJobId);
  else showDashboard();
  fetch('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
}

function toggleBatchMode() {
  batchMode = !batchMode;
  selectedIds = [];
  document.getElementById('batchBar').classList.toggle('hidden', !batchMode);
  document.getElementById('batchToggleBtn').textContent = batchMode ? '完成' : '管理';
  renderList();
}
function toggleSelectId(id) { const i = selectedIds.indexOf(id); if (i >= 0) selectedIds.splice(i, 1); else selectedIds.push(id); }
function selectAllJobs() { selectedIds = getJobs().map(j => j.id); renderList(); }
function invertSelectJobs() { const set = new Set(selectedIds); selectedIds = getJobs().map(j => j.id).filter(id => !set.has(id)); renderList(); }
function deleteSelectedJobs() {
  if (!selectedIds.length) return;
  if (!confirm('确定删除已勾选的 ' + selectedIds.length + ' 条记录？')) return;
  const set = new Set(selectedIds);
  const jobs = getJobs().filter(j => !set.has(j.id));
  selectedIds = [];
  if (set.has(selectedJobId)) selectedJobId = jobs[0] ? jobs[0].id : null;
  saveJobs(jobs);
  if (selectedJobId) selectJob(selectedJobId);
  else showDashboard();
}

// ── Rich Markdown Parser & Mindmap Builder ──
function inlineMd(text) {
  let s = esc(text);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\x60([^\x60]+)\x60/g, '<code class="md-code">$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--brand);text-decoration:none">$1</a>');
  return s;
}

function detectSectionKind(line) {
  const c = line.replace(/^[#\s\-*•]+/, '').replace(/\*\*/g, '').replace(/[:：]+$/, '').trim();
  if (!c || c.startsWith('（') || c.startsWith('(') || c.includes('失败') || c.includes('无法')) return null;
  if (c.length <= 16) {
    if (c.includes('核心主题') || c.includes('核心观点') || c.includes('一句话总结')) return 'theme';
    if (c.includes('要点提炼') || c.includes('核心要点') || c.includes('关键要点')) return 'points';
    if (c === '总结' || c === '结语' || c === '总结洞察' || c.endsWith('总结')) return 'conclusion';
  }
  return null;
}

function parseSummarySections(md) {
  if (!md || !md.trim()) return [];
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
  return sections;
}

function renderRichSummary(md) {
  const sections = parseSummarySections(md);
  if (!sections.length) return '<div class="pending-banner">暂无 AI 总结内容</div>';
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

function renderMindmap(job) {
  const el = document.getElementById('mindmapContent');
  const sections = parseSummarySections(job.summary || '');
  if (!sections.length || (job.summary || '').startsWith('（AI总结失败')) {
    el.innerHTML = '<div class="pending-banner">请先生成有效的 AI 总结，系统将自动构建结构化思维导图。</div>';
    return;
  }
  const kindNames = { theme: '核心主题', points: '核心要点拆解', conclusion: '总结洞察', body: '内容脉络' };
  const branches = sections.map((sec, i) => {
    const label = kindNames[sec.kind] || '要点';
    const leaves = sec.lines.map(l => '<div class="mm-leaf">' + inlineMd(l.replace(/^\d+[.、)]\s*|^[-*•]\s+/, '')) + '</div>').join('');
    return '<div class="mm-node">' +
      '<div class="mm-node-head" onclick="this.nextElementSibling.classList.toggle(\'hidden\')">' +
        '<span class="mm-node-title">' + esc(label) + '</span>' +
        '<span class="mm-node-tag">' + sec.lines.length + ' 项</span>' +
      '</div>' +
      '<div class="mm-children">' + leaves + '</div>' +
    '</div>';
  }).join('');
  el.innerHTML = '<div class="mm-wrap"><div class="mm-root">' + esc(job.title || job.bvid) + '</div><div class="mm-branches">' + branches + '</div></div>';
}

function copyMindmapOutline() {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job) return;
  const sections = parseSummarySections(job.summary || '');
  const kindNames = { theme: '核心主题', points: '要点提炼', conclusion: '总结洞察', body: '内容' };
  let out = '# ' + (job.title || job.bvid) + '\n';
  sections.forEach(s => {
    out += '\n## ' + (kindNames[s.kind] || '节点') + '\n';
    s.lines.forEach(l => { out += '- ' + l.replace(/^\d+[.、)]\s*|^[-*•]\s+/, '') + '\n'; });
  });
  navigator.clipboard.writeText(out).then(() => toast('导图 Markdown 大纲已复制')).catch(() => {});
}

// ── Fast Edge Re-Summarize (4-8s, zero audio re-download!) ──
async function resummarizeCurrent(style) {
  const jobs = getJobs();
  const idx = jobs.findIndex(j => j.id === selectedJobId);
  if (idx < 0) return;
  const job = jobs[idx];
  if (!job.transcript || job.transcript.length < 30) {
    toast('当前任务没有可用的语音转录文本，无法秒速重总结', true);
    return;
  }

  document.querySelectorAll('#styleSwitchBar .style-pill').forEach(b => {
    b.disabled = true;
    b.classList.toggle('active', b.dataset.rs === style);
  });
  document.getElementById('summaryContent').innerHTML = '<div class="pending-banner">正在通过免费 AI 模型秒速重生成（约 4~8 秒，无需重新下载音频）...</div>';

  try {
    const r = await fetch('/api/resummarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: job.id, bvid: job.bvid, title: job.title, transcript: job.transcript, style }),
    });
    const d = await r.json();
    if (!r.ok) {
      toast(d.error || '重生成失败', true);
      renderDetail(job);
      return;
    }
    jobs[idx].summary = d.summary;
    jobs[idx].summary_style = style;
    jobs[idx].error = '';
    jobs[idx].error_stage = '';
    jobs[idx].error_hint = '';
    saveJobs(jobs);
    renderDetail(jobs[idx]);
    toast('重生成完成（' + d.model.split('/').pop() + ' · ' + d.elapsed + 's）');
  } catch (e) {
    toast('重生成异常：' + e.message, true);
    renderDetail(job);
  } finally {
    document.querySelectorAll('#styleSwitchBar .style-pill').forEach(b => { b.disabled = false; });
  }
}

// ── In-Transcript Keyword Search & Highlight ──
function highlightTranscript() {
  const job = getJobs().find(j => j.id === selectedJobId);
  const box = document.getElementById('transcriptContent');
  const countEl = document.getElementById('trMatchCount');
  const raw = (job && job.transcript) || '（该任务无语音转录文本）';
  const kw = (document.getElementById('trSearchInput').value || '').trim();
  trMatchIndex = -1;
  if (!kw) {
    box.textContent = raw;
    countEl.textContent = '';
    return;
  }
  const safeKw = kw.replace(new RegExp('[.*+?^$' + '{}()|[\\]\\\\]', 'g'), '\\$&');
  const re = new RegExp(safeKw, 'gi');
  let n = 0;
  box.innerHTML = esc(raw).replace(re, m => { n++; return '<mark>' + m + '</mark>'; });
  countEl.textContent = n ? ('0 / ' + n) : '0 处匹配';
  if (n > 0) jumpTrMatch(1);
}

function jumpTrMatch(dir) {
  const marks = document.querySelectorAll('#transcriptContent mark');
  if (!marks.length) return;
  marks.forEach(m => m.classList.remove('cur-match'));
  trMatchIndex = (trMatchIndex + dir + marks.length) % marks.length;
  marks[trMatchIndex].classList.add('cur-match');
  marks[trMatchIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('trMatchCount').textContent = (trMatchIndex + 1) + ' / ' + marks.length;
}

// ── AI Video Q&A Chat ──
function getVideoChats(jobId) {
  try { return (JSON.parse(localStorage.getItem(LS_CHATS) || '{}'))[jobId] || []; }
  catch { return []; }
}
function saveVideoChats(jobId, msgs) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_CHATS) || '{}');
    all[jobId] = msgs.slice(-20);
    localStorage.setItem(LS_CHATS, JSON.stringify(all));
  } catch {}
}
function renderVideoChat(jobId) {
  const msgs = getVideoChats(jobId);
  const box = document.getElementById('chatMessages');
  if (!msgs.length) {
    box.innerHTML = '<div style="text-align:center;color:var(--muted);padding:34px 16px;font-size:13px">点击上方快捷问题，或直接输入任何关于本视频的疑问</div>';
    return;
  }
  box.innerHTML = msgs.map(m => '<div class="chat-msg ' + (m.role === 'user' ? 'user' : 'assistant') + '">' + inlineMd(m.content) + '</div>').join('');
  box.scrollTop = box.scrollHeight;
}
function clearVideoChat() {
  if (!selectedJobId) return;
  saveVideoChats(selectedJobId, []);
  renderVideoChat(selectedJobId);
}
async function sendVideoChat(presetText) {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job) return;
  const inp = document.getElementById('chatInput');
  const q = (presetText !== undefined ? presetText : inp.value).trim();
  if (!q) return;
  if (presetText === undefined) inp.value = '';

  const msgs = [...getVideoChats(job.id), { role: 'user', content: q }];
  saveVideoChats(job.id, msgs);
  renderVideoChat(job.id);

  const btn = document.getElementById('chatSendBtn');
  btn.disabled = true;
  btn.textContent = '思考中...';
  const box = document.getElementById('chatMessages');
  const typing = document.createElement('div');
  typing.className = 'chat-msg assistant';
  typing.textContent = '正在结合视频转录内容思考...';
  box.appendChild(typing);
  box.scrollTop = box.scrollHeight;

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: job.title, transcript: job.transcript || '', summary: job.summary || '', messages: msgs }),
    });
    const d = await r.json();
    if (!r.ok) {
      typing.textContent = '追问失败：' + (d.error || '服务异常');
      return;
    }
    const next = [...msgs, { role: 'assistant', content: d.reply }];
    saveVideoChats(job.id, next);
    renderVideoChat(job.id);
  } catch (e) {
    typing.textContent = '网络异常：' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '发送';
  }
}

// ── Export Shareable Editorial Poster PNG (Pure Canvas) ──
function exportPosterPng() {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job || !job.summary || job.summary.startsWith('（AI总结失败')) {
    toast('当前没有可导出的有效 AI 总结', true);
    return;
  }
  const sections = parseSummarySections(job.summary);
  const scale = 2, W = 760, pad = 44;
  const wrapText = (ctx, text, maxW) => {
    const out = [];
    for (const para of String(text || '').split('\n')) {
      let line = '';
      for (const ch of para) {
        if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; }
        else line += ch;
      }
      if (line) out.push(line);
    }
    return out;
  };

  // Measure height first
  const tmp = document.createElement('canvas').getContext('2d');
  let y = 136;
  tmp.font = 'bold 24px -apple-system,PingFang SC,Microsoft YaHei,sans-serif';
  const titleLines = wrapText(tmp, job.title || job.bvid, W - pad * 2);
  y += titleLines.length * 34 + 34;

  const blocks = [];
  sections.forEach(s => {
    const label = s.kind === 'theme' ? '核心主题' : (s.kind === 'points' ? '要点提炼' : (s.kind === 'conclusion' ? '总结洞察' : '内容'));
    tmp.font = '15px -apple-system,PingFang SC,Microsoft YaHei,sans-serif';
    const cleanLines = [];
    s.lines.forEach(l => {
      const plain = l.replace(/\*\*/g, '').replace(/\x60/g, '');
      wrapText(tmp, plain, W - pad * 2 - 28).forEach(wl => cleanLines.push(wl));
    });
    blocks.push({ kind: s.kind, label, lines: cleanLines });
    y += 38 + cleanLines.length * 25 + 24;
  });
  const H = Math.max(460, y + 66);

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = '#F8F9FA';
  ctx.fillRect(0, 0, W, H);
  // Header masthead
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, W, 108);
  ctx.fillStyle = '#FB7299';
  ctx.fillRect(0, 0, W, 5);
  ctx.fillStyle = '#9CA3AF';
  ctx.font = '600 12px -apple-system,sans-serif';
  ctx.fillText('BILIBILI AI SUMMARY · ' + (job.bvid || ''), pad, 42);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 22px -apple-system,PingFang SC,Microsoft YaHei,sans-serif';
  ctx.fillText('B站视频 AI 精华卡片', pad, 76);

  let cy = 142;
  ctx.fillStyle = '#111827';
  ctx.font = 'bold 24px -apple-system,PingFang SC,Microsoft YaHei,sans-serif';
  titleLines.forEach(l => { ctx.fillText(l, pad, cy); cy += 34; });
  ctx.fillStyle = '#6B7280';
  ctx.font = '13px -apple-system,PingFang SC,sans-serif';
  ctx.fillText([job.owner ? ('UP主：' + job.owner) : '', job.duration ? ('时长 ' + job.duration) : ''].filter(Boolean).join('   ·   '), pad, cy + 4);
  cy += 34;

  blocks.forEach(b => {
    const bh = 36 + b.lines.length * 25 + 14;
    ctx.fillStyle = b.kind === 'theme' ? '#FFF1F5' : '#FFFFFF';
    ctx.fillRect(pad, cy, W - pad * 2, bh);
    ctx.strokeStyle = b.kind === 'theme' ? '#FECDD3' : '#E5E7EB';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad, cy, W - pad * 2, bh);
    if (b.kind === 'theme') {
      ctx.fillStyle = '#FB7299';
      ctx.fillRect(pad, cy, 4, bh);
    }
    ctx.fillStyle = b.kind === 'theme' ? '#E11D48' : '#4B5563';
    ctx.font = 'bold 13px -apple-system,PingFang SC,sans-serif';
    ctx.fillText(b.label, pad + 16, cy + 24);
    ctx.fillStyle = '#1F2937';
    ctx.font = '15px -apple-system,PingFang SC,Microsoft YaHei,sans-serif';
    let ly = cy + 48;
    b.lines.forEach(l => { ctx.fillText(l, pad + 16, ly); ly += 25; });
    cy += bh + 16;
  });

  ctx.fillStyle = '#9CA3AF';
  ctx.font = '12px -apple-system,sans-serif';
  ctx.fillText('由 bilisum.cc.cd 自动生成 · 免费语音转录与 AI 总结', pad, H - 24);

  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = (job.bvid || 'summary') + '-card.png';
  a.click();
  toast('分享长图 PNG 已生成并下载');
}

// ── Failure Diagnostics ──
const STAGE_LABELS = {
  id_parse: '视频 ID 解析', video_info: '获取视频信息', playurl: '解析音频流',
  cdn_download: '下载 B 站音频', stt: '免费语音转文字', summarize: 'AI 生成总结',
};

function renderFailureDiagnostics(job) {
  let stage = job.error_stage || '';
  let errText = job.error || '';
  let hint = job.error_hint || '';
  const hasTranscript = Boolean(job.transcript && job.transcript.length > 30);

  if (!stage) {
    const bvid = String(job.bvid || '');
    const totalSec = job.timings && job.timings.total ? Number(job.timings.total) : null;
    if (/^av\d+$/i.test(bvid) && totalSec !== null && totalSec <= 3) {
      stage = 'video_info';
      errText = errText || '旧版后端未兼容 av 号直接查询，或该视频已被删除/不可见（耗时 ' + totalSec + 's）';
      hint = hint || '当前新版已支持 av 号解析；确认视频公开可访问后可直接点击重试。';
    } else if (totalSec !== null && totalSec <= 5) {
      stage = 'playurl';
      errText = errText || '在获取视频信息或音频流阶段快速中断（耗时 ' + totalSec + 's）';
      hint = hint || '可能是当时 B 站节点风控 (-412)、大会员/充电专属或稿件下架。';
    } else {
      stage = 'stt';
      errText = errText || '语音识别阶段未能返回有效文本内容';
      hint = hint || '硅基流动接口临时波动或音频无有效人声，可点击重新处理。';
    }
  }

  const stageLabel = STAGE_LABELS[stage] || stage || '处理链路';
  return '<div class="diag-card">' +
    '<div class="diag-head">' +
      '<div class="diag-title">处理异常 · 故障定位</div>' +
      '<span class="diag-stage">异常环节：' + esc(stageLabel) + '</span>' +
    '</div>' +
    '<div class="diag-rows">' +
      '<div class="diag-row"><span class="diag-key">报错详情</span><span>' + esc(errText || '未能获取视频文字内容') + '</span></div>' +
      '<div class="diag-row"><span class="diag-key">可能原因</span><span>' + esc(hint || '请检查视频是否公开可播放，或稍后重试。') + '</span></div>' +
    '</div>' +
    '<div class="diag-foot">' +
      '<span style="font-size:12px;color:var(--soft)">视频 ID：<code>' + esc(job.bvid || '') + '</code></span>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        (hasTranscript ? '<button class="btn btn-sm btn-brand" onclick="resummarizeCurrent(\'daily\')">秒速重生成总结（~5秒）</button>' : '') +
        '<button class="btn btn-sm btn-primary" onclick="submitVideo(\'' + esc(job.bvid || '') + '\')">全流程重新处理</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

// ── Detail View & Stepper ──
function renderStepper(job) {
  const bar = document.getElementById('stepperBar');
  bar.classList.remove('hidden');
  const st = normStatus(job.status);
  let steps = job.gh_steps ? job.gh_steps.slice(0, 4) : [
    { name: '任务创建', done: true, active: false },
    { name: '下载音频', done: st === 'completed', active: st === 'pending' },
    { name: '语音转录', done: st === 'completed', active: false },
    { name: 'AI 总结', done: st === 'completed', active: false },
  ];
  const badgeHtml = st === 'completed'
    ? '<span class="st-badge ok">已完成</span>'
    : (st === 'failed' ? '<span class="st-badge err">处理失败</span>' : '<span class="st-badge pending">处理中</span>');
  const items = steps.map((s, i) => {
    const cls = s.done ? 'st-item done' : (s.active ? 'st-item active' : 'st-item');
    const dot = s.done ? '<span class="st-dot">&#10003;</span>' : '<span class="st-dot">' + (i + 1) + '</span>';
    return '<span class="' + cls + '">' + dot + '<span>' + esc(s.name) + '</span></span><span class="st-line' + (s.done ? ' done' : '') + '"></span>';
  }).join('');
  bar.innerHTML = items + badgeHtml;
}

function renderDetail(job) {
  renderStepper(job);
  updateStarBtn(job);
  updateWatchLaterBtn(job);
  renderDetailTagBar(job);
  const videoUrl = job.video_url || ('https://www.bilibili.com/video/' + job.bvid);
  const titleLink = document.getElementById('dTitleLink');
  titleLink.textContent = job.title || job.bvid || '处理中...';
  titleLink.href = videoUrl;
  document.getElementById('dWatchLink').href = videoUrl;

  const pills = [];
  if (job.owner) pills.push('<span class="meta-pill">UP主：' + esc(job.owner) + '</span>');
  if (job.duration) pills.push('<span class="meta-pill">时长 ' + esc(job.duration) + '</span>');
  if (job.bvid) pills.push('<span class="meta-pill">' + esc(job.bvid) + '</span>');
  if (job.timings && job.timings.total) pills.push('<span class="meta-pill">耗时 ' + esc(job.timings.total) + 's</span>');
  else if (job.created_at) pills.push('<span class="meta-pill">' + esc(fmtShortDate(job.created_at)) + '</span>');
  const durSec = parseDurationSec(job.duration);
  if (durSec >= 120 && normStatus(job.status) === 'completed') {
    pills.push('<span class="meta-pill saved">帮你节省约 ' + Math.max(1, Math.round(durSec / 60 * 0.85)) + ' 分钟</span>');
  }
  document.getElementById('dPills').innerHTML = pills.join('');

  const st = normStatus(job.status);
  const rawSummary = (job.summary || '').trim();
  const isSummaryFailed = job.error_stage === 'summarize' || rawSummary.startsWith('（AI总结失败') || rawSummary.startsWith('(AI总结失败');
  const hasTranscript = Boolean(job.transcript && job.transcript.length > 30);
  document.getElementById('styleSwitchBar').classList.toggle('hidden', !hasTranscript);
  const activeStyle = job.summary_style || 'daily';
  document.querySelectorAll('#styleSwitchBar .style-pill').forEach(b => b.classList.toggle('active', b.dataset.rs === activeStyle));

  document.getElementById('trSearchInput').value = '';
  document.getElementById('trMatchCount').textContent = '';

  if (st === 'pending') {
    document.getElementById('summaryContent').innerHTML = '<div class="pending-banner">GitHub Actions 正在提取音频、免费语音转文字并生成 AI 摘要，页面会自动刷新...</div>';
    document.getElementById('transcriptContent').textContent = '等待转录完成...';
  } else if (st === 'failed') {
    document.getElementById('summaryContent').innerHTML = renderFailureDiagnostics(job);
    document.getElementById('transcriptContent').textContent = job.transcript || '无转录内容';
  } else if (isSummaryFailed) {
    const tLen = (job.transcript || '').length;
    document.getElementById('summaryContent').innerHTML = renderFailureDiagnostics({
      ...job,
      error_stage: 'summarize',
      error: job.error || 'AI 总结阶段失败（长视频文本量触发硅基流动免费模型 TPM 429 限流）',
      error_hint: job.error_hint || ('完整语音转录（' + tLen + ' 字符）已保存！直接点击下方「秒速重生成总结（~5秒）」即可立即生成摘要，无需重新下载音频。'),
    });
    document.getElementById('transcriptContent').textContent = job.transcript || '（该任务无语音转录文本）';
  } else {
    let notice = job.error_hint ? '<div class="sb-toast show info" style="margin:0 0 14px 0">' + esc(job.error_hint) + '</div>' : '';
    document.getElementById('summaryContent').innerHTML = notice + renderRichSummary(rawSummary);
    document.getElementById('transcriptContent').textContent = job.transcript || '（该任务无语音转录文本）';
  }
  renderMindmap(job);
  renderVideoChat(job.id);
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
  grid.classList.toggle('split', viewMode === 'split');
  document.getElementById('summaryPanel').classList.toggle('hidden', viewMode !== 'summary' && viewMode !== 'split');
  document.getElementById('mindmapPanel').classList.toggle('hidden', viewMode !== 'mindmap');
  document.getElementById('transcriptPanel').classList.toggle('hidden', viewMode !== 'transcript' && viewMode !== 'split');
  document.getElementById('chatPanel').classList.toggle('hidden', viewMode !== 'chat');
  document.getElementById('summaryPanelLabel').classList.toggle('hidden', viewMode !== 'split');
}

function copyCurrent() {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job) return;
  const txt = viewMode === 'transcript' ? (job.transcript || '') : (job.summary || '');
  navigator.clipboard.writeText(txt).then(() => toast('内容已复制到剪贴板')).catch(() => {});
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
  toast('已导出 ' + ext.toUpperCase() + ' 文件');
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
  if (!authUser) { openModal('loginModal'); setTimeout(() => document.getElementById('loginPass').focus(), 60); return; }
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
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const d = await r.json();
    if (!r.ok) { showToast('loginToast', d.error || '登录失败', 'err'); return; }
    localStorage.setItem(LS_AUTH, d.token);
    localStorage.setItem(LS_USER, d.username);
    updateAuthUi(d.username);
    closeModal('loginModal');
    document.getElementById('loginPass').value = '';
    toast('登录成功，欢迎回来 ' + d.username);
    await switchPage('monitor');
  } catch (e) { showToast('loginToast', '网络错误: ' + e.message, 'err'); }
  finally { btn.disabled = false; }
}
function doLogout() {
  localStorage.removeItem(LS_AUTH);
  localStorage.removeItem(LS_USER);
  monitorPageBooted = false;
  lastRenderedFeedKey = '';
  lastRenderedFeedSig = '';
  updateAuthUi('');
  closeModal('monitorModal');
  toast('已退出管理员登录');
}

// ── Multi-Layer UP Feed Cache + Infinite Scroll + UP Tag Folders + Cover Grid ──
const SS_FEED_CACHE = 'bilisum_up_feed_cache_v2';
const FEED_CACHE_TTL_MS = 10 * 60 * 1000;
const feedMemCache = new Map();
let prefetchDone = false;
let feedPagination = { key: 'all', pn: 1, hasMore: false, loading: false, total: 0, mids: '' };
let feedObserver = null;

function readFeedCache(key) {
  const k = String(key || 'all');
  if (feedMemCache.has(k)) return feedMemCache.get(k);
  try {
    const store = JSON.parse(sessionStorage.getItem(SS_FEED_CACHE) || '{}');
    if (store[k] && Array.isArray(store[k].videos)) { feedMemCache.set(k, store[k]); return store[k]; }
  } catch {}
  return null;
}
function writeFeedCache(key, entryData) {
  const k = String(key || 'all');
  const entry = {
    videos: entryData.videos || [],
    pn: entryData.pn || 1,
    hasMore: Boolean(entryData.hasMore),
    total: Number(entryData.total) || 0,
    ts: Date.now(),
  };
  feedMemCache.set(k, entry);
  try {
    const store = JSON.parse(sessionStorage.getItem(SS_FEED_CACHE) || '{}');
    store[k] = entry;
    const keys = Object.keys(store);
    if (keys.length > 25) { keys.sort((a, b) => (store[a].ts || 0) - (store[b].ts || 0)); keys.slice(0, keys.length - 25).forEach(old => delete store[old]); }
    sessionStorage.setItem(SS_FEED_CACHE, JSON.stringify(store));
  } catch {}
}
function clearFeedCache(key) {
  if (key) feedMemCache.delete(String(key)); else feedMemCache.clear();
  try {
    if (key) { const store = JSON.parse(sessionStorage.getItem(SS_FEED_CACHE) || '{}'); delete store[String(key)]; sessionStorage.setItem(SS_FEED_CACHE, JSON.stringify(store)); }
    else sessionStorage.removeItem(SS_FEED_CACHE);
  } catch {}
}

function renderSkeletonGrid() {
  return Array.from({ length: 8 }).map(() =>
    '<div class="v-card"><div class="skel" style="width:100%;aspect-ratio:16/9;border-radius:12px"></div><div style="display:flex;gap:10px;padding-top:10px"><div class="skel" style="width:34px;height:34px;border-radius:50%;flex-shrink:0"></div><div style="flex:1"><div class="skel" style="height:14px;width:90%;margin-bottom:7px"></div><div class="skel" style="height:12px;width:55%;margin-bottom:7px"></div><div class="skel" style="height:18px;width:36%;border-radius:999px"></div></div></div></div>'
  ).join('');
}

function initFeedInfiniteObserver() {
  if (feedObserver || typeof IntersectionObserver === 'undefined') return;
  const sentinel = document.getElementById('feedSentinel');
  const root = document.getElementById('contentScroll');
  if (!sentinel) return;
  feedObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      if (currentPage !== 'monitor') return;
      if (selectedUpMid === '__watchlater' || selectedUpMid === '__favorites') return;
      if (feedPagination.hasMore && !feedPagination.loading) {
        loadMoreUpFeed();
      }
    });
  }, { root: root || null, rootMargin: '420px 0px' });
  feedObserver.observe(sentinel);
}

async function loadMonitorPage() {
  initFeedInfiniteObserver();
  if (monitorPageBooted && (monitorConfig.up_list || []).length > 0) {
    renderMonitorFolderBar();
    updateMonitorHeaderSummary();
    if (selectedUpMid === '__watchlater') renderSavedGrid('watchlater');
    else if (selectedUpMid === '__favorites') renderSavedGrid('favorites');
    else if (!lastRenderedFeedKey) await fetchUpFeed(selectedUpMid || 'all');
    return;
  }
  await loadMonitorConfig();
  monitorPageBooted = true;
  updateMonitorHeaderSummary();
  renderMonitorFolderBar();
  renderUpSidebar();
  await fetchUpFeed(selectedUpMid || 'all');
}

function updateMonitorHeaderSummary() {
  const ups = monitorConfig.up_list || [];
  const styleNames = { editorial: '编辑部日报', minimal: '极简纸刊', bilibili: 'B站元气粉', compact: '极速速览' };
  const statusStr = monitorConfig.enabled !== false ? '定时监控运行中' : '定时监控已暂停';
  const timeStr = monitorConfig.schedule_mode === 'times' ? ('北京时间 ' + (monitorConfig.times_cst || []).join('、')) : ('UTC Cron ' + (monitorConfig.cron_utc || ''));
  document.getElementById('monSummaryLine').textContent = statusStr + ' · ' + timeStr + ' · 共监控 ' + ups.length + ' 位 UP 主 · 样式：' + (styleNames[monitorConfig.email_style] || '编辑部日报');
}

function setMonFolder(fid) {
  selectedMonFolder = selectedMonFolder === fid ? '' : fid;
  renderMonitorFolderBar();
  renderUpSidebar();
  if (selectedMonFolder) {
    selectMonitorUp('folder:' + selectedMonFolder);
  } else if (String(selectedUpMid).startsWith('folder:')) {
    selectMonitorUp('all');
  }
}

function renderMonitorFolderBar() {
  const bar = document.getElementById('monFolderBar');
  if (!bar) return;
  const ups = monitorConfig.up_list || [];
  const folders = libraryState.folders || [];
  const wlCnt = (libraryState.watch_later || []).length;
  const favCnt = (libraryState.favorites || []).length;

  let html = '<button class="folder-chip' + (!selectedMonFolder && selectedUpMid !== '__watchlater' && selectedUpMid !== '__favorites' ? ' active' : '') + '" onclick="selectedMonFolder=\'\';renderMonitorFolderBar();renderUpSidebar();selectMonitorUp(\'all\')">全部</button>';
  html += '<button class="folder-chip' + (selectedUpMid === '__watchlater' ? ' active' : '') + '" onclick="selectMonitorUp(\'__watchlater\')">' +
    '<span class="folder-dot" style="background:#2563EB"></span><span>稍后再看</span>' + (wlCnt ? '<span class="folder-cnt">' + wlCnt + '</span>' : '') + '</button>';
  html += '<button class="folder-chip' + (selectedUpMid === '__favorites' ? ' active' : '') + '" onclick="selectMonitorUp(\'__favorites\')">' +
    '<span class="folder-dot" style="background:#D97706"></span><span>收藏</span>' + (favCnt ? '<span class="folder-cnt">' + favCnt + '</span>' : '') + '</button>';

  folders.forEach(f => {
    const cnt = ups.filter(u => getUpTagIds(u.mid).includes(f.id)).length;
    const act = selectedMonFolder === f.id ? ' active' : '';
    html += '<button class="folder-chip' + act + '" onclick="setMonFolder(\'' + esc(f.id) + '\')">' +
      '<span class="folder-dot" style="background:' + esc(f.color) + '"></span>' +
      '<span>' + esc(f.name) + '</span>' +
      (cnt ? '<span class="folder-cnt">' + cnt + '</span>' : '') +
    '</button>';
  });
  html += '<button class="folder-add-btn" onclick="openTagManagerModal()" title="管理标签文件夹">+ 标签</button>';
  bar.innerHTML = html;
}

function renderUpSidebar() {
  const kw = (document.getElementById('upSearchInput').value || '').trim().toLowerCase();
  const allUps = monitorConfig.up_list || [];
  let ups = selectedMonFolder ? allUps.filter(u => getUpTagIds(u.mid).includes(selectedMonFolder)) : allUps;
  document.getElementById('upSideCount').textContent = String(ups.length);
  const filtered = kw ? ups.filter(u => String(u.name || '').toLowerCase().includes(kw) || String(u.mid || '').includes(kw)) : ups;
  const listEl = document.getElementById('upSideList');
  let html = '';
  if (!kw) {
    if (selectedMonFolder) {
      const f = getFolderById(selectedMonFolder);
      const fKey = 'folder:' + selectedMonFolder;
      html += '<div class="up-side-card' + (selectedUpMid === fKey ? ' active' : '') + '" onclick="selectMonitorUp(\'' + esc(fKey) + '\')">' +
        '<div class="up-ava-fb" style="background:' + esc((f && f.color) || '#2563EB') + ';color:#fff;border-color:transparent">' + esc(((f && f.name) || '类').slice(0, 1)) + '</div>' +
        '<div class="up-side-info"><div class="up-side-name">「' + esc((f && f.name) || '分类') + '」全部动态</div><div class="up-side-uid">聚合该标签下 ' + ups.length + ' 位 UP 主</div></div></div>';
    } else {
      html += '<div class="up-side-card' + (selectedUpMid === 'all' ? ' active' : '') + '" onclick="selectMonitorUp(\'all\')"><div class="up-ava-fb">全</div><div class="up-side-info"><div class="up-side-name">全部监控 UP 主</div><div class="up-side-uid">聚合最新动态 · ' + allUps.length + ' 位</div></div></div>';
    }
  }
  html += filtered.length ? filtered.map(u => {
    const active = String(selectedUpMid) === String(u.mid) ? ' active' : '';
    const faceUrl = u.face ? (u.face.replace(/^http:\/\//, 'https://') + '@96w_96h_1c.webp') : '';
    const ava = faceUrl ? '<img class="up-ava" src="' + esc(faceUrl) + '" referrerpolicy="no-referrer" alt="">' : '<div class="up-ava-fb">' + esc((u.name || String(u.mid)).slice(0, 1)) + '</div>';
    const upTagsHtml = getUpTagIds(u.mid).map(tid => {
      const f = getFolderById(tid);
      return f ? '<span class="mini-tag"><span class="folder-dot" style="width:5px;height:5px;background:' + esc(f.color) + '"></span>' + esc(f.name) + '</span>' : '';
    }).join('');
    return '<div class="up-side-card' + active + '" onclick="selectMonitorUp(' + Number(u.mid) + ')">' +
      ava +
      '<div class="up-side-info">' +
        '<div class="up-side-name">' + esc(u.name || u.mid) + '</div>' +
        '<div class="up-side-uid">UID ' + esc(u.mid) + '</div>' +
        (upTagsHtml ? '<div class="mini-tags">' + upTagsHtml + '</div>' : '') +
      '</div>' +
      '<div class="up-side-acts">' +
        '<button class="up-tag-btn" title="设置标签分类" onclick="event.stopPropagation();openTagPopover(this,\'up\',\'' + Number(u.mid) + '\')">' + SVG_TAG_SM + '</button>' +
        '<button class="h-del" title="取消监控" onclick="event.stopPropagation();quickRemoveMonitorUp(' + Number(u.mid) + ')">' + SVG_CLOSE_SM + '</button>' +
      '</div>' +
    '</div>';
  }).join('') : '<div style="text-align:center;padding:24px 12px;color:var(--muted);font-size:12.5px">' + (selectedMonFolder ? '该标签下暂无 UP 主，点击任意 UP 主右侧标签图标即可加入' : '暂无匹配的 UP 主') + '</div>';
  listEl.innerHTML = html;
}

function renderSavedGrid(kind) {
  const isWl = kind === 'watchlater';
  const vids = isWl ? (libraryState.watch_later || []) : (libraryState.favorites || []);
  document.getElementById('monFeedHeading').textContent = isWl ? '稍后再看视频列表' : '已收藏视频列表';
  document.getElementById('topbarSub').textContent = (isWl ? '稍后再看' : '收藏夹') + ' · ' + vids.length + ' 条';
  const grid = document.getElementById('upFeedGrid');
  const footer = document.getElementById('feedFooter');
  currentFeedVideos = vids.slice();
  lastRenderedFeedKey = isWl ? '__watchlater' : '__favorites';
  lastRenderedFeedSig = vids.map(v => v.bvid).join(',');
  feedPagination = { key: lastRenderedFeedKey, pn: 1, hasMore: false, loading: false, total: vids.length, mids: '' };

  if (!vids.length) {
    grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:38px">' +
      (isWl ? '暂无「稍后再看」视频，悬停任意视频封面右上角即可一键加入' : '暂无「收藏」视频，悬停视频封面或摘要详情页即可一键收藏') + '</div>';
    if (footer) footer.innerHTML = '';
    return;
  }
  grid.innerHTML = vids.map((v, idx) => buildFeedCardHtml(v, idx)).join('');
  if (footer) footer.innerHTML = '<div class="feed-meta-note">共 ' + vids.length + ' 条视频</div>';
}

async function selectMonitorUp(mid) {
  selectedUpMid = mid;
  renderMonitorFolderBar();
  renderUpSidebar();
  const scrollEl = document.getElementById('contentScroll');
  if (scrollEl) { scrollEl.scrollTop = 0; pageScrollPos.monitor = 0; }

  if (mid === '__watchlater') { renderSavedGrid('watchlater'); return; }
  if (mid === '__favorites') { renderSavedGrid('favorites'); return; }

  const ups = monitorConfig.up_list || [];
  if (mid === 'all') {
    document.getElementById('monFeedHeading').textContent = '全部监控 UP 主动态';
    document.getElementById('topbarSub').textContent = '全部 UP 主';
  } else if (String(mid).startsWith('folder:')) {
    const fid = String(mid).slice(7);
    const f = getFolderById(fid);
    const label = (f && f.name) || '标签分类';
    document.getElementById('monFeedHeading').textContent = '「' + label + '」聚合动态';
    document.getElementById('topbarSub').textContent = '标签文件夹 · ' + label;
  } else {
    const found = ups.find(u => Number(u.mid) === Number(mid));
    const label = found ? found.name : ('UID ' + mid);
    document.getElementById('monFeedHeading').textContent = label + ' · 全部投稿';
    document.getElementById('topbarSub').textContent = label + ' (' + mid + ')';
  }
  await fetchUpFeed(mid);
}

async function quickAddMonitorUp() {
  const inp = document.getElementById('sideAddUpInput');
  const q = inp.value.trim();
  if (!q) return;
  const btn = document.getElementById('sideAddUpBtn');
  btn.disabled = true; btn.textContent = '添加中...';
  try {
    const r = await fetch('/api/up-lookup?q=' + encodeURIComponent(q), { headers: { 'Authorization': 'Bearer ' + getAuthToken() } });
    const d = await r.json();
    if (!r.ok) { showToast('sideUpToast', d.error || '解析失败', 'err'); return; }
    if (!monitorConfig.up_list) monitorConfig.up_list = [];
    if (!monitorConfig.up_list.some(x => Number(x.mid) === Number(d.mid))) {
      monitorConfig.up_list.push({ mid: Number(d.mid), name: d.name || String(d.mid), face: d.face || '' });
      const sr = await fetch('/api/monitor-config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() }, body: JSON.stringify(monitorConfig) });
      const sd = await sr.json();
      if (sr.ok && sd.config) monitorConfig = sd.config;
      if (selectedMonFolder) {
        const k = String(d.mid);
        libraryState.up_tags[k] = [...new Set([...(libraryState.up_tags[k] || []), selectedMonFolder])];
        saveLibraryLocalAndCloud();
      }
    }
    inp.value = ''; clearFeedCache('all');
    updateMonitorHeaderSummary(); renderMonitorFolderBar(); renderUpSidebar();
    toast('已添加监控：' + (d.name || d.mid));
    await selectMonitorUp(Number(d.mid));
  } catch (e) { showToast('sideUpToast', '添加异常：' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '添加'; }
}

async function quickRemoveMonitorUp(mid) {
  const found = (monitorConfig.up_list || []).find(u => Number(u.mid) === Number(mid));
  if (!confirm('确定取消监控「' + (found ? found.name : mid) + '」？')) return;
  monitorConfig.up_list = (monitorConfig.up_list || []).filter(u => Number(u.mid) !== Number(mid));
  try {
    const sr = await fetch('/api/monitor-config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() }, body: JSON.stringify(monitorConfig) });
    const sd = await sr.json();
    if (sr.ok && sd.config) monitorConfig = sd.config;
    if (String(selectedUpMid) === String(mid)) selectedUpMid = 'all';
    clearFeedCache('all'); clearFeedCache(mid);
    updateMonitorHeaderSummary(); renderMonitorFolderBar(); renderUpSidebar();
    await selectMonitorUp(selectedUpMid);
    toast('已取消监控');
  } catch (e) { toast('移除失败：' + e.message, true); }
}

function buildFeedCardHtml(v, idx) {
  const coverUrl = v.pic ? (v.pic.replace(/^http:\/\//, 'https://') + '@672w_378h_1c.webp') : '';
  const faceUrl = v.face ? (v.face.replace(/^http:\/\//, 'https://') + '@96w_96h_1c.webp') : '';
  const hasSum = Boolean(v.summary);
  const statsStr = [fmtCount(v.play), fmtDanmaku(v.danmaku)].join(' · ');
  const relTime = fmtRelativeTime(v.created);
  const avaHtml = faceUrl ? '<img class="v-ava" src="' + esc(faceUrl) + '" referrerpolicy="no-referrer" alt="">' : '<div class="v-ava-fb">' + esc((v.author || 'UP').slice(0, 1)) + '</div>';
  const wlOn = isWatchLater(v.bvid);
  const favOn = isFavBvid(v.bvid);
  return '<article class="v-card" data-bvid="' + esc(v.bvid) + '">' +
    '<div class="v-thumb-wrap">' +
      '<a class="v-thumb-link" href="' + esc(v.url) + '" target="_blank" rel="noopener">' +
        (coverUrl ? '<img src="' + esc(coverUrl) + '" referrerpolicy="no-referrer" loading="lazy" alt="">' : '') +
        (hasSum ? '<span class="v-sum-badge">已有摘要</span>' : '') +
        (v.duration ? '<span class="v-dur">' + esc(v.duration) + '</span>' : '') +
      '</a>' +
      '<div class="v-quick-acts' + ((wlOn || favOn) ? ' has-active' : '') + '">' +
        '<button type="button" class="v-qbtn v-qbtn-wl' + (wlOn ? ' wl-on' : '') + '" title="' + (wlOn ? '移出稍后再看' : '加入稍后再看') + '" onclick="event.preventDefault();event.stopPropagation();toggleFeedVideoWl(' + idx + ')">' + SVG_CLOCK_SM + '</button>' +
        '<button type="button" class="v-qbtn v-qbtn-fav' + (favOn ? ' fav-on' : '') + '" title="' + (favOn ? '取消收藏' : '加入收藏') + '" onclick="event.preventDefault();event.stopPropagation();toggleFeedVideoFav(' + idx + ')">' + SVG_STAR_LINE + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="v-body">' + avaHtml +
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
}

function toggleFeedVideoWl(idx) {
  const v = currentFeedVideos[idx];
  if (v) toggleWatchLaterVideo(v);
}
function toggleFeedVideoFav(idx) {
  const v = currentFeedVideos[idx];
  if (v) toggleFavoriteVideo(v);
}
function syncFeedCardQuickStates(bvid) {
  if (!bvid) return;
  const wlOn = isWatchLater(bvid);
  const favOn = isFavBvid(bvid);
  document.querySelectorAll('#upFeedGrid .v-card[data-bvid="' + bvid.replace(/"/g, '') + '"]').forEach(card => {
    const acts = card.querySelector('.v-quick-acts');
    const wlB = card.querySelector('.v-qbtn-wl');
    const favB = card.querySelector('.v-qbtn-fav');
    if (acts) acts.classList.toggle('has-active', wlOn || favOn);
    if (wlB) { wlB.classList.toggle('wl-on', wlOn); wlB.title = wlOn ? '移出稍后再看' : '加入稍后再看'; }
    if (favB) { favB.classList.toggle('fav-on', favOn); favB.title = favOn ? '取消收藏' : '加入收藏'; }
  });
}

function renderFeedFooter() {
  const footer = document.getElementById('feedFooter');
  if (!footer) return;
  const count = currentFeedVideos.length;
  if (!count) { footer.innerHTML = ''; return; }
  const totalStr = feedPagination.total > count ? (' / 共约 ' + feedPagination.total + ' 条') : '';
  if (feedPagination.loading) {
    footer.innerHTML = '<button class="feed-load-btn" disabled>正在加载更早的视频...</button><div class="feed-meta-note">已加载 ' + count + ' 条' + totalStr + '</div>';
  } else if (feedPagination.hasMore) {
    footer.innerHTML = '<button class="feed-load-btn" onclick="loadMoreUpFeed()">加载更多历史视频</button><div class="feed-meta-note">向下滚动自动翻页 · 已加载 ' + count + ' 条' + totalStr + '</div>';
  } else {
    footer.innerHTML = '<div class="feed-meta-note">已加载全部 ' + count + ' 条公开视频</div>';
  }
}

function renderFeedCards(vids, key) {
  const grid = document.getElementById('upFeedGrid');
  const sig = vids.length + ':' + (vids[0] ? vids[0].bvid : '') + ':' + (vids[vids.length - 1] ? vids[vids.length - 1].bvid : '');
  currentFeedVideos = vids.slice();
  if (key && lastRenderedFeedKey === key && lastRenderedFeedSig === sig && grid.children.length > 0) {
    renderFeedFooter();
    return;
  }
  lastRenderedFeedKey = key || '';
  lastRenderedFeedSig = sig;
  if (!vids.length) {
    grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:36px">暂未获取到公开视频</div>';
    renderFeedFooter();
    return;
  }
  grid.innerHTML = vids.map((v, idx) => buildFeedCardHtml(v, idx)).join('');
  renderFeedFooter();
}

function appendFeedCards(newVids) {
  const grid = document.getElementById('upFeedGrid');
  if (!grid || !newVids.length) { renderFeedFooter(); return; }
  const startIdx = currentFeedVideos.length;
  currentFeedVideos.push(...newVids);
  const html = newVids.map((v, i) => buildFeedCardHtml(v, startIdx + i)).join('');
  grid.insertAdjacentHTML('beforeend', html);
  lastRenderedFeedSig = currentFeedVideos.length + ':' + (currentFeedVideos[0] ? currentFeedVideos[0].bvid : '') + ':' + (currentFeedVideos[currentFeedVideos.length - 1] ? currentFeedVideos[currentFeedVideos.length - 1].bvid : '');
  renderFeedFooter();
}

function buildUpFeedApiUrl(key, pn, forceRefresh) {
  const qs = [];
  if (String(key).startsWith('folder:')) {
    const fid = String(key).slice(7);
    const mids = (monitorConfig.up_list || []).filter(u => getUpTagIds(u.mid).includes(fid)).map(u => u.mid).join(',');
    qs.push('mid=group');
    qs.push('mids=' + encodeURIComponent(mids));
  } else {
    qs.push('mid=' + encodeURIComponent(key));
  }
  qs.push('pn=' + pn);
  qs.push('ps=20');
  if (forceRefresh) qs.push('refresh=1');
  return '/api/up-videos?' + qs.join('&');
}

function prefetchTopUpsQuietly() {
  if (prefetchDone || !authUser) return;
  prefetchDone = true;
  (monitorConfig.up_list || []).slice(0, 5).forEach((u, i) => {
    const k = String(u.mid);
    const ex = readFeedCache(k);
    if (ex && (Date.now() - ex.ts) < FEED_CACHE_TTL_MS) return;
    setTimeout(() => {
      if (!authUser) return;
      fetch('/api/up-videos?mid=' + encodeURIComponent(k) + '&pn=1&ps=20', { headers: { 'Authorization': 'Bearer ' + getAuthToken() } })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && Array.isArray(d.videos)) writeFeedCache(k, { videos: d.videos, pn: 1, hasMore: Boolean(d.has_more), total: d.total || 0 }); })
        .catch(() => {});
    }, 800 + i * 450);
  });
}

async function fetchUpFeed(mid, forceRefresh) {
  const key = String(mid || 'all');
  if (key === '__watchlater') { renderSavedGrid('watchlater'); return; }
  if (key === '__favorites') { renderSavedGrid('favorites'); return; }

  const grid = document.getElementById('upFeedGrid');
  const refBtn = document.getElementById('refreshFeedBtn');
  const cached = !forceRefresh ? readFeedCache(key) : null;
  const isFresh = cached && (Date.now() - cached.ts) < FEED_CACHE_TTL_MS;

  if (cached) {
    feedPagination = { key, pn: cached.pn || 1, hasMore: Boolean(cached.hasMore), loading: false, total: cached.total || 0 };
    renderFeedCards(cached.videos, key);
    if (isFresh) { prefetchTopUpsQuietly(); return; }
  } else {
    lastRenderedFeedKey = '';
    lastRenderedFeedSig = '';
    feedPagination = { key, pn: 1, hasMore: false, loading: true, total: 0 };
    grid.innerHTML = renderSkeletonGrid();
    const footer = document.getElementById('feedFooter');
    if (footer) footer.innerHTML = '';
  }

  if (refBtn && forceRefresh) { refBtn.disabled = true; refBtn.textContent = '刷新中...'; }
  try {
    const r = await fetch(buildUpFeedApiUrl(key, 1, forceRefresh), { headers: { 'Authorization': 'Bearer ' + getAuthToken() } });
    const d = await r.json();
    if (!r.ok) {
      feedPagination.loading = false;
      if (!cached) grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;color:var(--err-text)">拉取失败：' + esc(d.error || ('HTTP ' + r.status)) + '</div>';
      return;
    }
    const vids = d.videos || [];
    const entry = { videos: vids, pn: 1, hasMore: Boolean(d.has_more), total: Number(d.total) || 0 };
    writeFeedCache(key, entry);
    if (String(selectedUpMid || 'all') === key) {
      feedPagination = { key, pn: 1, hasMore: entry.hasMore, loading: false, total: entry.total };
      renderFeedCards(vids, key);
    }
    if (forceRefresh) toast('动态已刷新（第 1 页共 ' + vids.length + ' 条）');
    prefetchTopUpsQuietly();
  } catch (e) {
    feedPagination.loading = false;
    if (!cached) grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;color:var(--err-text)">网络异常：' + esc(e.message) + '</div>';
  } finally {
    if (refBtn) { refBtn.disabled = false; refBtn.textContent = '刷新动态'; }
  }
}

async function loadMoreUpFeed() {
  const key = String(selectedUpMid || 'all');
  if (key === '__watchlater' || key === '__favorites') return;
  if (feedPagination.loading || !feedPagination.hasMore || feedPagination.key !== key) return;

  const nextPn = (feedPagination.pn || 1) + 1;
  feedPagination.loading = true;
  renderFeedFooter();

  try {
    const r = await fetch(buildUpFeedApiUrl(key, nextPn, false), { headers: { 'Authorization': 'Bearer ' + getAuthToken() } });
    const d = await r.json();
    if (String(selectedUpMid || 'all') !== key) return;
    if (!r.ok) {
      feedPagination.loading = false;
      renderFeedFooter();
      toast('翻页加载失败：' + (d.error || ('HTTP ' + r.status)), true);
      return;
    }
    const seen = new Set(currentFeedVideos.map(v => v.bvid));
    const incoming = (d.videos || []).filter(v => v && v.bvid && !seen.has(v.bvid));
    feedPagination.pn = nextPn;
    feedPagination.hasMore = Boolean(d.has_more) && (incoming.length > 0 || (d.videos || []).length > 0);
    feedPagination.loading = false;
    if (d.total) feedPagination.total = Number(d.total);
    appendFeedCards(incoming);
    writeFeedCache(key, {
      videos: currentFeedVideos.slice(),
      pn: feedPagination.pn,
      hasMore: feedPagination.hasMore,
      total: feedPagination.total,
    });
  } catch (e) {
    feedPagination.loading = false;
    renderFeedFooter();
    toast('加载更多失败：' + e.message, true);
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
  navigator.clipboard.writeText(modalSummaryRaw || '').then(() => toast('摘要已复制')).catch(() => {});
}

// ── Monitor Settings Modal ──
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
  } catch (e) { showToast('monitorToast', '加载配置失败: ' + e.message, 'err'); }
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
    syncEl.innerHTML = s.ok ? ('已同步至 Shy Cron（任务 ID: <code>' + esc(s.task_id) + '</code> · 下次运行: ' + esc(s.next_run_at || '已调度') + '）') : ('上次同步提示：' + esc(s.error || s.reason || '未同步'));
  } else syncEl.textContent = '保存后将自动同步至 Shy Cron（cron.shyapi.de5.net）';
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
  times.forEach(t => { const h = (parseInt(t.split(':')[0], 10) - 8 + 24) % 24; if (!hrs.includes(h)) hrs.push(h); });
  hrs.sort((a, b) => a - b);
  return min + ' ' + hrs.join(',') + ' * * *';
}
function updateCronPreview() { document.getElementById('cronUtcPreview').textContent = 'UTC Cron: ' + computeClientUtcCron(); }
function renderTimeChips() {
  document.getElementById('timeChips').innerHTML = (monitorConfig.times_cst || []).map((t, i) => '<span class="chip"><b>北京时间 ' + esc(t) + '</b><button type="button" onclick="removeTimeSlot(' + i + ')">×</button></span>').join('');
  updateCronPreview();
}
function addTimeSlot() {
  const val = document.getElementById('newTimeInput').value;
  if (!val) return;
  if (!monitorConfig.times_cst) monitorConfig.times_cst = [];
  if (!monitorConfig.times_cst.includes(val)) { monitorConfig.times_cst.push(val); monitorConfig.times_cst.sort(); }
  renderTimeChips();
}
function removeTimeSlot(idx) {
  monitorConfig.times_cst.splice(idx, 1);
  if (!monitorConfig.times_cst.length) monitorConfig.times_cst = ['08:00'];
  renderTimeChips();
}
function renderUpChips() {
  const ups = monitorConfig.up_list || [];
  document.getElementById('upCountLabel').textContent = String(ups.length);
  document.getElementById('upChips').innerHTML = ups.map((u, i) => '<span class="chip"><b>' + esc(u.name || u.mid) + '</b><small>' + esc(u.mid) + '</small><button type="button" onclick="removeUp(' + i + ')">×</button></span>').join('');
}
async function addUpCreator() {
  const inp = document.getElementById('newUpInput');
  const q = inp.value.trim();
  if (!q) return;
  const btn = document.getElementById('addUpBtn');
  btn.disabled = true; btn.textContent = '解析中...';
  try {
    const r = await fetch('/api/up-lookup?q=' + encodeURIComponent(q), { headers: { 'Authorization': 'Bearer ' + getAuthToken() } });
    const d = await r.json();
    if (!r.ok) { showToast('monitorToast', d.error || '解析失败', 'err'); return; }
    if (!monitorConfig.up_list) monitorConfig.up_list = [];
    if (!monitorConfig.up_list.some(x => Number(x.mid) === Number(d.mid))) monitorConfig.up_list.push({ mid: Number(d.mid), name: d.name || String(d.mid), face: d.face || '' });
    inp.value = ''; renderUpChips();
    showToast('monitorToast', '已添加 UP 主：' + (d.name || d.mid), 'ok');
  } catch (e) { showToast('monitorToast', '解析异常: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '解析并添加'; }
}
function removeUp(idx) { monitorConfig.up_list.splice(idx, 1); renderUpChips(); }

const PREVIEW_THEMES = {
  editorial: { name:'编辑部日报', pageBg:'#f3f4f6', bodyBg:'#f8fafc', hdBg:'#111827', hdTop:'4px solid #fb7299', hdTitle:'#ffffff', hdMeta:'#9ca3af', p1Bg:'rgba(251,114,153,.16)', p1C:'#fda4af', p1B:'rgba(251,114,153,.35)', p2Bg:'rgba(255,255,255,.08)', p2C:'#e5e7eb', p2B:'rgba(255,255,255,.14)', accent:'#fb7299', accentDark:'#e11d48', thBg:'#fff5f7', thB:'#fb7299', bgBadge:'#fff1f5', cBadge:'#e11d48', bBadge:'#fecdd3', btnBg:'#111827', compact:false },
  minimal: { name:'极简纸刊', pageBg:'#ffffff', bodyBg:'#ffffff', hdBg:'#ffffff', hdTop:'3px solid #111827', hdTitle:'#111827', hdMeta:'#6b7280', p1Bg:'#f3f4f6', p1C:'#111827', p1B:'#e5e7eb', p2Bg:'#f9fafb', p2C:'#4b5563', p2B:'#e5e7eb', accent:'#111827', accentDark:'#111827', thBg:'#f9fafb', thB:'#111827', bgBadge:'#f3f4f6', cBadge:'#374151', bBadge:'#e5e7eb', btnBg:'#111827', compact:false },
  bilibili: { name:'B站元气粉', pageBg:'#fff7f9', bodyBg:'#fffbfc', hdBg:'linear-gradient(135deg,#fb7299,#ff8fab)', hdTop:'none', hdTitle:'#ffffff', hdMeta:'rgba(255,255,255,.9)', p1Bg:'rgba(255,255,255,.22)', p1C:'#ffffff', p1B:'rgba(255,255,255,.35)', p2Bg:'rgba(255,255,255,.16)', p2C:'#ffffff', p2B:'rgba(255,255,255,.28)', accent:'#fb7299', accentDark:'#ec4899', thBg:'#fff1f5', thB:'#fb7299', bgBadge:'#ffe4ec', cBadge:'#db2777', bBadge:'#fbcfe8', btnBg:'#fb7299', compact:false },
  compact: { name:'极速速览', pageBg:'#f1f5f9', bodyBg:'#ffffff', hdBg:'#0f172a', hdTop:'3px solid #38bdf8', hdTitle:'#f8fafc', hdMeta:'#94a3b8', p1Bg:'rgba(56,189,248,.16)', p1C:'#7dd3fc', p1B:'rgba(56,189,248,.3)', p2Bg:'rgba(255,255,255,.08)', p2C:'#cbd5e1', p2B:'rgba(255,255,255,.14)', accent:'#0284c7', accentDark:'#0369a1', thBg:'#f0f9ff', thB:'#0284c7', bgBadge:'#e0f2fe', cBadge:'#0369a1', bBadge:'#bae6fd', btnBg:'#0f172a', compact:true },
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
  const url1 = 'https://www.bilibili.com/video/BV149ypz6Ehs', url2 = 'https://www.bilibili.com/video/BV19Vsq6xEW9';
  document.getElementById('emailPreviewFrame').srcdoc = '<!doctype html><html><body style="margin:0;padding:14px;background:' + th.pageBg + ';font-family:-apple-system,PingFang SC,sans-serif;color:#111827"><div style="max-width:600px;margin:0 auto"><div style="background:' + th.hdBg + ';border-top:' + th.hdTop + ';border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;' + hb + 'border-radius:12px 12px 0 0;padding:18px 20px"><div style="font-size:10px;letter-spacing:1.2px;color:' + th.hdMeta + ';margin-bottom:5px">BILIBILI AI DAILY BRIEFING · 2026年11月21日</div><div style="font-size:19px;font-weight:800;color:' + th.hdTitle + ';margin-bottom:9px">B站视频 AI 日报</div><span style="display:inline-block;background:' + th.p1Bg + ';color:' + th.p1C + ';border:1px solid ' + th.p1B + ';border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;margin-right:6px">' + (merge ? '覆盖 2 位 UP 主' : '按 UP 主分封推送') + '</span><span style="display:inline-block;background:' + th.p2Bg + ';color:' + th.p2C + ';border:1px solid ' + th.p2B + ';border-radius:999px;padding:2px 9px;font-size:11px">共 ' + (merge ? '2' : '1') + ' 支新视频</span></div><div style="background:' + th.bodyBg + ';border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:16px">' + (merge ? '<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;line-height:1.8"><div style="font-size:10px;font-weight:700;color:#6b7280;margin-bottom:4px">本期速览 · TABLE OF CONTENTS</div><div><b style="color:' + th.accent + ';margin-right:5px">01</b><a href="' + url1 + '" target="_blank" style="color:#1f2937;text-decoration:none;border-bottom:1px solid #e5e7eb"><b style="color:' + th.accentDark + '">[波士顿圆脸]</b> 前所未见：巴西亚马逊原始部落拖家带口现身求救</a></div><div><b style="color:' + th.accent + ';margin-right:5px">02</b><a href="' + url2 + '" target="_blank" style="color:#1f2937;text-decoration:none;border-bottom:1px solid #e5e7eb"><b style="color:' + th.accentDark + '">[刺客边风]</b> 开源本地光猫配置解析工具实测</a></div></div>' : '') + '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:' + pad + '"><div style="margin-bottom:7px"><span style="font-family:Consolas,monospace;font-size:11px;color:#9ca3af;margin-right:6px">#01</span><span style="display:inline-block;background:' + th.bgBadge + ';color:' + th.cBadge + ';border:1px solid ' + th.bBadge + ';border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;margin-right:6px">波士顿圆脸</span><span style="font-size:11px;color:#9ca3af">时长 11:16 · 11-20 10:49</span></div><div style="font-size:15px;font-weight:700;margin-bottom:10px"><a href="' + url1 + '" target="_blank" style="color:#111827;text-decoration:none">前所未见：巴西亚马逊原始部落拖家带口现身求救</a></div><div style="background:' + th.thBg + ';border-left:3px solid ' + th.thB + ';border-radius:0 6px 6px 0;padding:9px 12px;margin-bottom:10px"><div style="font-size:10px;font-weight:700;color:' + th.accentDark + ';margin-bottom:3px">核心主题</div><div style="font-size:' + fs + ';line-height:1.6">记录巴西亚马逊与世隔绝原始部落携家带口现身求救事件，剖析雨林生态与现代疾病风险。</div></div><div style="font-size:' + fs + ';line-height:1.65;color:#374151;margin-bottom:10px"><div><b style="color:' + th.accent + '">1.</b> <b>罕见接触</b>：二三十名阿瓦人主动接触原住民哨所索要食物。</div><div><b style="color:' + th.accent + '">2.</b> <b>生存威胁</b>：非法淘金与盗伐加剧，挤压原住民生存空间。</div></div><div style="display:flex;justify-content:space-between;align-items:center;border-top:1px dashed #e5e7eb;padding-top:9px"><a href="' + url1 + '" target="_blank" style="background:' + th.btnBg + ';color:#fff;padding:5px 11px;border-radius:6px;font-size:11.5px;font-weight:600;text-decoration:none">前往 B 站观看 ↗</a><span style="font-size:11px;color:#9ca3af;font-family:Consolas,monospace">BV149ypz6Ehs</span></div></div></div></div></body></html>';
}
async function saveMonitorConfig() {
  const btn = document.getElementById('saveMonitorBtn');
  btn.disabled = true; btn.textContent = '保存并同步中...';
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
    const r = await fetch('/api/monitor-config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!r.ok) { showToast('monitorToast', d.error || '保存失败', 'err'); return; }
    monitorConfig = d.config; hydrateMonitorForm();
    if (currentPage === 'monitor') { updateMonitorHeaderSummary(); renderUpSidebar(); }
    if (d.cron_sync && d.cron_sync.ok) showToast('monitorToast', '配置已保存并同步至 Shy Cron（' + d.cron_sync.cron_utc + '）', 'ok');
    else showToast('monitorToast', '已保存到 R2，Cron 同步提示：' + (d.cron_sync?.error || d.cron_sync?.reason || '未知'), 'err');
  } catch (e) { showToast('monitorToast', '保存异常: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '保存并同步定时任务'; }
}
async function triggerMonitorNow(toastId) {
  try {
    const r = await fetch('/api/monitor-run', { method: 'POST', headers: { 'Authorization': 'Bearer ' + getAuthToken() } });
    const d = await r.json();
    if (!r.ok) showToast(toastId || 'monitorToast', d.error || '触发失败', 'err');
    else toast(d.message || '已触发后台监控任务');
  } catch (e) { toast('触发异常: ' + e.message, true); }
}

// ── Init ──
initTheme();
initCustomSelects();
applyUserPrefsToUi();
initSliderObservers();
initFeedInfiniteObserver();
checkAuth();
renderWorkspaceFolderBar();
renderList();
renderDashboard();
const initJobs = getJobs();
if (initJobs.length > 0) selectJob(initJobs[0].id);
initJobs.forEach(j => { if (normStatus(j.status) === 'pending') startPolling(j.id); });
syncFromR2();
syncLibraryFromR2();
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
      if (path === '/api/library' && request.method === 'GET') return await handleGetLibrary(request, env);
      if (path === '/api/library' && request.method === 'POST') return await handleSaveLibrary(request, env);
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
      if (path === '/api/resummarize' && request.method === 'POST') return await handleResummarize(request, env);
      if (path === '/api/chat' && request.method === 'POST') return await handleVideoChat(request, env);
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
