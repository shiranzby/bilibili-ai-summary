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

const SESSION_COOKIE_NAME = 'bilisum_session';
const PERSIST_TTL_MS = 90 * 24 * 3600 * 1000; // 90 days persistent single-device login
const SHORT_TTL_MS = 24 * 3600 * 1000;        // 24 hours non-persistent session

function getCookieValue(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const parts = raw.split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    if (p.slice(0, idx).trim() === name) return decodeURIComponent(p.slice(idx + 1).trim());
  }
  return '';
}

function buildSessionCookie(request, token, remember) {
  const isHttps = (request.url || '').startsWith('https://');
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isHttps) attrs.push('Secure');
  if (remember) attrs.push(`Max-Age=${Math.floor(PERSIST_TTL_MS / 1000)}`);
  return attrs.join('; ');
}

function buildClearSessionCookie(request) {
  const isHttps = (request.url || '').startsWith('https://');
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isHttps) attrs.push('Secure');
  return attrs.join('; ');
}

async function createSessionToken(env, username, remember = true) {
  const ttl = remember ? PERSIST_TTL_MS : SHORT_TTL_MS;
  const exp = Date.now() + ttl;
  const payload = JSON.stringify({ u: username, exp, rem: remember ? 1 : 0 });
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await getSigningKey(env);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64 = base64UrlEncode(new Uint8Array(sigBuf));
  return { token: `${payloadB64}.${sigB64}`, expires_at: new Date(exp).toISOString(), remember };
}

async function verifyRawToken(tokenStr, env) {
  if (!tokenStr) return null;
  const parts = String(tokenStr).trim().split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await getSigningKey(env);
    const sigBytes = base64UrlDecode(sigB64);
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payloadB64));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return { username: payload.u || 'admin', exp: payload.exp, remember: Boolean(payload.rem), token: tokenStr };
  } catch {
    return null;
  }
}

async function verifySessionToken(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const res = await verifyRawToken(m[1], env);
    if (res) return res;
  }
  const cookieTok = getCookieValue(request, SESSION_COOKIE_NAME);
  if (cookieTok) {
    const res = await verifyRawToken(cookieTok, env);
    if (res) return res;
  }
  return null;
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const remember = body.remember !== false;
  const expectedUser = (env.ADMIN_USERNAME || 'shiran').trim();
  const expectedPass = env.ADMIN_PASSWORD || '';

  if (!expectedPass) {
    return errorResponse('服务端尚未配置 ADMIN_PASSWORD Secret，请先通过 wrangler secret put ADMIN_PASSWORD 配置', 503);
  }
  if (!safeEqual(username, expectedUser) || !safeEqual(password, expectedPass)) {
    return errorResponse('账号或密码错误', 401);
  }
  const sess = await createSessionToken(env, expectedUser, remember);
  return new Response(JSON.stringify({
    ok: true,
    username: expectedUser,
    token: sess.token,
    expires_at: sess.expires_at,
    remember,
  }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': buildSessionCookie(request, sess.token, remember),
    },
  });
}

async function handleAuthMe(request, env) {
  const sess = await verifySessionToken(request, env);
  if (!sess) return jsonResponse({ authenticated: false, username: '' });

  // Sliding auto-renewal for persistent single-device logins (< 60 days remaining -> refresh to 90 days)
  const remaining = sess.exp - Date.now();
  const shouldRenew = sess.remember && remaining < 60 * 24 * 3600 * 1000;
  let freshToken = sess.token;
  let expiresAt = new Date(sess.exp).toISOString();
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' };

  if (shouldRenew) {
    const renewed = await createSessionToken(env, sess.username, true);
    freshToken = renewed.token;
    expiresAt = renewed.expires_at;
    headers['Set-Cookie'] = buildSessionCookie(request, freshToken, true);
  }

  return new Response(JSON.stringify({
    authenticated: true,
    username: sess.username,
    token: freshToken,
    expires_at: expiresAt,
    remember: sess.remember,
  }), { status: 200, headers });
}

async function handleLogout(request) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': buildClearSessionCookie(request),
    },
  });
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
  summary_folders: [
    { id: 'tech', name: '科技', color: '#2563EB' },
    { id: 'history', name: '历史', color: '#D97706' },
    { id: 'game', name: '游戏', color: '#7C3AED' },
    { id: 'software', name: '软件', color: '#059669' },
  ],
  up_folders: [
    { id: 'up_news', name: '国际时政', color: '#E11D48' },
    { id: 'up_tech', name: '数码科技', color: '#2563EB' },
    { id: 'up_know', name: '知识科普', color: '#059669' },
    { id: 'up_fun', name: '趣味娱乐', color: '#D97706' },
  ],
  fav_folders: [
    { id: 'fav_default', name: '默认收藏夹', color: '#FB7299' },
    { id: 'fav_deep', name: '深度干货', color: '#2563EB' },
  ],
  job_tags: {},
  up_tags: {},
  fav_folder_map: {},
  watch_later: [],
  favorites: [],
};

function sanitizeFolderList(arr, fallback) {
  if (!Array.isArray(arr) || !arr.length) return fallback.map(f => ({ ...f }));
  const seen = new Set();
  const out = [];
  for (const f of arr.slice(0, 40)) {
    const id = String(f?.id || '').trim().slice(0, 32) || ('f_' + Date.now() + '_' + out.length);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(f?.name || '').trim().slice(0, 20) || '未命名',
      color: /^#[0-9a-fA-F]{3,8}$/.test(String(f?.color || '')) ? String(f.color) : '#2563EB',
    });
  }
  return out.length ? out : fallback.map(f => ({ ...f }));
}

function sanitizeLibrary(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const legacyFolders = Array.isArray(src.folders) && src.folders.length ? src.folders : null;
  const summary_folders = sanitizeFolderList(src.summary_folders || legacyFolders, DEFAULT_LIBRARY.summary_folders);
  const up_folders = sanitizeFolderList(src.up_folders, DEFAULT_LIBRARY.up_folders);
  const fav_folders = sanitizeFolderList(src.fav_folders, DEFAULT_LIBRARY.fav_folders);

  const cleanTagMap = (m, validSet) => {
    const out = {};
    if (m && typeof m === 'object') {
      Object.keys(m).slice(0, 500).forEach(k => {
        const arr = Array.isArray(m[k]) ? [...new Set(m[k].map(String).filter(id => validSet.has(id)))] : [];
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

  const sumSet = new Set(summary_folders.map(f => f.id));
  const upSet = new Set(up_folders.map(f => f.id));
  const favSet = new Set(fav_folders.map(f => f.id));

  return {
    folders: summary_folders,
    summary_folders,
    up_folders,
    fav_folders,
    job_tags: cleanTagMap(src.job_tags, sumSet),
    up_tags: cleanTagMap(src.up_tags, upSet),
    fav_folder_map: cleanTagMap(src.fav_folder_map, favSet),
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
  let pic = String(body.pic || '').trim().replace(/^http:\/\//, 'https://');
  if ((!title || !pic) && /^BV/i.test(bvid)) {
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
          if (!title) title = info.title || '';
          if (!owner) owner = info.owner?.name || '';
          if (!duration) duration = formatSecDuration(info.duration);
          if (!pic && info.pic) pic = String(info.pic).replace(/^http:\/\//, 'https://');
        }
      }
    } catch {}
  }

  const jobId = uuid();
  const job = {
    id: jobId, bvid, url: bvid, status: 'pending',
    created_at: nowISO(), updated_at: nowISO(),
    summary: null, title: title || bvid, owner, duration, pic,
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
        job_id: jobId, bvid, title: job.title, owner, duration, pic, status: 'pending',
        warning: 'GitHub Actions 触发可能失败: HTTP ' + ghResp.status,
      }, 201);
    }
    ctx.waitUntil(captureRunId(env, jobId));
  } catch (err) {
    console.error('GitHub dispatch error:', err.message);
  }

  if (env.BILIBILI_BUCKET) cleanupExcessResults(env.BILIBILI_BUCKET).catch(() => {});
  return jsonResponse({ job_id: jobId, bvid, title: job.title, owner, duration, pic, status: 'pending' }, 201);
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
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>B站AI摘要 · Bilibili AI Summary</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#F6F7F9;--surface:#FFFFFF;--surface-2:#ECEEF2;--surface-3:#F3F4F6;--surface-hover:#F9FAFB;
  --border:#E5E7EB;--border-strong:#D1D5DB;
  --text:#111827;--soft:#4B5563;--muted:#9CA3AF;
  --brand:#FB7299;--brand-dark:#E0527B;--brand-soft:#FFF1F5;--brand-border:#FECDD3;
  --cta:#18181B;--cta-text:#FFFFFF;--cta-hover:#27272A;
  --ok:#10B981;--ok-soft:#ECFDF5;--ok-text:#047857;
  --err:#EF4444;--err-soft:#FEF2F2;--err-text:#B91C1C;--err-border:#FECACA;
  --warn:#F59E0B;--warn-soft:#FFFBEB;--warn-text:#B45309;
  --blue:#2563EB;--blue-soft:rgba(37,99,235,.10);--blue-border:#93C5FD;
  --shadow-sm:0 1px 2px rgba(15,23,42,.04);
  --shadow-md:0 6px 20px rgba(15,23,42,.07);
  --shadow-lg:0 20px 50px rgba(15,23,42,.16);
  --shadow-pill:0 2px 8px rgba(15,23,42,.11),0 0 0 1px rgba(15,23,42,.05);
  --rail-w:228px;
}
[data-theme="dark"]{
  --bg:#0B0D12;--surface:#131722;--surface-2:#0F121A;--surface-3:#1B2030;--surface-hover:#181D2B;
  --border:#23293A;--border-strong:#333C52;
  --text:#F3F4F6;--soft:#9CA3AF;--muted:#6B7280;
  --brand:#FB7299;--brand-dark:#FF85A7;--brand-soft:rgba(251,114,153,.13);--brand-border:rgba(251,114,153,.32);
  --cta:#F3F4F6;--cta-text:#0B0D12;--cta-hover:#FFFFFF;
  --ok:#34D399;--ok-soft:rgba(16,185,129,.12);--ok-text:#6EE7B7;
  --err:#F87171;--err-soft:rgba(239,68,68,.12);--err-text:#FCA5A5;--err-border:rgba(239,68,68,.35);
  --warn:#FBBF24;--warn-soft:rgba(245,158,11,.13);--warn-text:#FDE68A;
  --blue:#60A5FA;--blue-soft:rgba(59,130,246,.16);--blue-border:rgba(96,165,250,.45);
  --shadow-sm:0 1px 2px rgba(0,0,0,.35);
  --shadow-md:0 8px 24px rgba(0,0,0,.45);
  --shadow-lg:0 24px 60px rgba(0,0,0,.65);
  --shadow-pill:0 2px 10px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.12);
}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased;overflow:hidden}
button,input,select,textarea{font-family:inherit;color:inherit}
button{cursor:pointer}
.hidden{display:none!important}
.ic{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.ic-lg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:3px}

/* Animations */
@keyframes modalPop{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
.seg-slider{
  position:absolute;top:3px;bottom:3px;left:0;border-radius:7px;
  background:var(--surface);box-shadow:var(--shadow-pill);z-index:0;pointer-events:none;
  transition:transform .34s cubic-bezier(.34,1.38,.64,1),width .34s cubic-bezier(.34,1.38,.64,1);
  will-change:transform,width;
}
[data-theme="dark"] .seg-slider{background:var(--surface-3)}

/* Full-Screen Auth Gate */
.auth-gate{
  position:fixed;inset:0;z-index:500;background:var(--bg);
  display:flex;align-items:center;justify-content:center;padding:20px;
}
.auth-gate-theme{position:fixed;top:18px;right:20px;z-index:510}
.auth-card{
  width:100%;max-width:410px;background:var(--surface);border:1px solid var(--border);
  border-radius:20px;padding:32px 30px 26px;box-shadow:var(--shadow-lg);
  animation:modalPop .24s cubic-bezier(.22,1,.36,1);
}
.auth-brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.auth-brand h1{font-size:19px;font-weight:800;letter-spacing:-.2px}
.auth-brand p{font-size:12.5px;color:var(--muted);margin-top:1px}
.auth-note{font-size:12px;color:var(--muted);margin-top:14px;line-height:1.6;text-align:center}

/* App Shell: Plan A (Expanded 228px) / Plan B (Collapsed 64px) / Mobile Drawer */
.app-shell{display:flex;height:100vh;width:100vw;overflow:hidden;position:relative}
.nav-rail{
  width:var(--rail-w);min-width:var(--rail-w);height:100vh;background:var(--surface);
  border-right:1px solid var(--border);display:flex;flex-direction:column;
  padding:14px 12px 12px;transition:width .24s cubic-bezier(.22,1,.36,1),min-width .24s cubic-bezier(.22,1,.36,1);
  position:relative;z-index:40;flex-shrink:0;
}
.app-shell.rail-collapsed .nav-rail{width:64px;min-width:64px;padding:14px 9px 12px}

.rail-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:14px;min-height:36px;padding:0 2px}
.brand-link{display:flex;align-items:center;gap:10px;min-width:0;cursor:pointer;border:none;background:none;padding:0;text-align:left}
.brand-icon{width:34px;height:34px;border-radius:10px;background:var(--brand);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 3px 10px rgba(251,114,153,.28)}
.brand-text{min-width:0;transition:opacity .15s}
.brand-title{font-size:15.5px;font-weight:800;letter-spacing:-.2px;color:var(--text);white-space:nowrap}
.brand-sub{font-size:11px;color:var(--muted);white-space:nowrap}
.rail-collapse-btn{
  width:28px;height:28px;border:1px solid transparent;border-radius:7px;background:transparent;
  color:var(--muted);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;
  transition:background .15s,color .15s,border-color .15s;
}
.rail-collapse-btn:hover{background:var(--surface-3);color:var(--text);border-color:var(--border)}

.app-shell.rail-collapsed .brand-text,
.app-shell.rail-collapsed .rail-label,
.app-shell.rail-collapsed .rail-badge,
.app-shell.rail-collapsed .rail-sec-title,
.app-shell.rail-collapsed .rail-collapse-btn,
.app-shell.rail-collapsed .rail-user-meta{display:none!important}
.app-shell.rail-collapsed .rail-head{justify-content:center;padding:0}

/* Primary New Summary CTA */
.rail-cta{
  width:100%;height:38px;border-radius:10px;border:none;background:var(--cta);color:var(--cta-text);
  display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px;font-weight:700;
  margin-bottom:14px;transition:background .15s,transform .1s;position:relative;flex-shrink:0;
}
.rail-cta:hover{background:var(--cta-hover)}
.rail-cta:active{transform:scale(.98)}
.rail-cta-kbd{font-size:10.5px;font-weight:600;opacity:.65;padding:1px 5px;border-radius:4px;border:1px solid currentColor;margin-left:auto}
.app-shell.rail-collapsed .rail-cta{width:44px;margin:0 auto 14px;padding:0}
.app-shell.rail-collapsed .rail-cta-kbd{display:none}

/* Primary 5-Page Nav with Vertical Spring Slider */
.rail-scroll{flex:1;overflow-y:auto;overflow-x:hidden;margin:0 -4px;padding:0 4px}
.app-shell.rail-collapsed .rail-scroll{overflow:visible}
.rail-nav{position:relative;display:flex;flex-direction:column;gap:2px}
.nav-slider{
  position:absolute;left:0;right:0;top:0;height:36px;border-radius:9px;
  background:var(--brand-soft);border:1px solid var(--brand-border);z-index:0;pointer-events:none;
  transition:transform .34s cubic-bezier(.34,1.38,.64,1),height .24s ease,opacity .2s ease;
  will-change:transform;
}
.nav-slider.off{opacity:0}
.rail-item{
  position:relative;z-index:1;width:100%;height:36px;padding:0 10px;border-radius:9px;
  border:none;background:transparent;color:var(--soft);display:flex;align-items:center;gap:10px;
  font-size:13.5px;font-weight:600;text-align:left;white-space:nowrap;
  transition:color .18s ease,background .15s ease;
}
.rail-item:hover{color:var(--text);background:var(--surface-hover)}
.rail-item.active{color:var(--brand-dark);background:transparent}
.rail-item.active:hover{background:transparent}
.rail-badge{margin-left:auto;font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--surface-3);color:var(--soft);font-variant-numeric:tabular-nums}
.rail-item.active .rail-badge{background:rgba(251,114,153,.18);color:var(--brand-dark)}
.app-shell.rail-collapsed .rail-item{justify-content:center;padding:0;width:44px;margin:0 auto}

/* Folder Section in Sidebar */
.rail-sep{height:1px;background:var(--border);margin:12px 4px}
.rail-sec-head{display:flex;align-items:center;justify-content:space-between;padding:0 8px 6px}
.rail-sec-title{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.3px;text-transform:uppercase}
.rail-sec-add{
  width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:var(--muted);
  display:inline-flex;align-items:center;justify-content:center;transition:all .15s;
}
.rail-sec-add:hover{background:var(--surface-3);color:var(--brand-dark)}
.app-shell.rail-collapsed .rail-sec-head{justify-content:center;padding:0 0 6px}
.rail-folders{display:flex;flex-direction:column;gap:2px}
.folder-nav-item{
  position:relative;width:100%;height:34px;padding:0 10px;border-radius:9px;border:1px solid transparent;
  background:transparent;color:var(--soft);display:flex;align-items:center;gap:10px;
  font-size:13px;font-weight:600;text-align:left;white-space:nowrap;transition:all .15s;
}
.folder-nav-item:hover{background:var(--surface-hover);color:var(--text)}
.folder-nav-item.active{background:var(--brand-soft);border-color:var(--brand-border);color:var(--brand-dark)}
.folder-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.app-shell.rail-collapsed .folder-nav-item{justify-content:center;padding:0;width:44px;margin:0 auto}
.app-shell.rail-collapsed .folder-dot{width:10px;height:10px}

/* Plan B Hover Tooltips */
.app-shell.rail-collapsed [data-tip]{position:relative}
.app-shell.rail-collapsed [data-tip]:hover::after{
  content:attr(data-tip);position:absolute;left:calc(100% + 10px);top:50%;transform:translateY(-50%);
  background:#111827;color:#fff;font-size:12px;font-weight:600;padding:5px 10px;border-radius:7px;
  white-space:nowrap;box-shadow:var(--shadow-md);z-index:200;pointer-events:none;
}
[data-theme="dark"] .app-shell.rail-collapsed [data-tip]:hover::after{background:#F3F4F6;color:#0B0D12}

/* Sidebar Footer */
.rail-foot{margin-top:auto;padding-top:10px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:6px;flex-shrink:0}
.rail-user-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:9px;background:var(--bg);border:1px solid var(--border)}
.rail-user-ava{width:28px;height:28px;border-radius:50%;background:var(--brand-soft);border:1px solid var(--brand-border);color:var(--brand-dark);font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.rail-user-meta{flex:1;min-width:0}
.rail-user-name{font-size:12.5px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rail-user-sub{font-size:10.5px;color:var(--muted);white-space:nowrap}
.rail-foot-acts{display:flex;align-items:center;gap:5px}
.rail-foot-btn{
  flex:1;height:32px;border-radius:8px;border:1px solid var(--border);background:var(--surface);
  color:var(--soft);display:inline-flex;align-items:center;justify-content:center;gap:6px;
  font-size:12px;font-weight:600;transition:all .15s;
}
.rail-foot-btn:hover{border-color:var(--border-strong);color:var(--text);background:var(--surface-hover)}
.app-shell.rail-collapsed .rail-user-row{justify-content:center;padding:5px;width:44px;margin:0 auto;cursor:pointer}
.app-shell.rail-collapsed .rail-foot-acts{flex-direction:column;gap:5px}
.app-shell.rail-collapsed .rail-foot-btn{width:44px;flex:none;padding:0;margin:0 auto}

/* Mobile Drawer Backdrop */
.mobile-backdrop{display:none;position:fixed;inset:0;background:rgba(10,12,18,.48);backdrop-filter:blur(3px);z-index:35}
.mobile-backdrop.show{display:block}

/* Main Area & Topbar */
.main-col{flex:1;min-width:0;display:flex;flex-direction:column;height:100vh;overflow:hidden;background:var(--bg)}
.topbar{
  height:56px;padding:0 24px;border-bottom:1px solid var(--border);background:var(--surface);
  display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0;
}
.tb-left{display:flex;align-items:center;gap:10px;min-width:0}
.mobile-logo-btn{
  display:none;width:36px;height:36px;border-radius:10px;background:var(--brand);border:none;
  align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 3px 10px rgba(251,114,153,.28);
}
.tb-expand-btn{
  display:none;width:32px;height:32px;border-radius:8px;border:1px solid var(--border);
  background:var(--surface);color:var(--soft);align-items:center;justify-content:center;flex-shrink:0;
}
.tb-expand-btn:hover{color:var(--text);border-color:var(--border-strong);background:var(--surface-hover)}
.app-shell.rail-collapsed .tb-expand-btn{display:inline-flex}
.topbar-title{font-size:15px;font-weight:800;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-sub{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.pill-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);font-size:12.5px;font-weight:600;white-space:nowrap;transition:border-color .15s,background .15s}
.pill-btn:hover{border-color:var(--border-strong);background:var(--surface-hover)}
.pill-btn.brand{border-color:var(--brand-border);background:var(--brand-soft);color:var(--brand-dark)}
.icon-btn{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--soft);flex-shrink:0;transition:border-color .15s,color .15s,background .15s}
.icon-btn:hover{border-color:var(--border-strong);color:var(--text);background:var(--surface-hover)}

/* Keep-Alive Route Host */
.route-host{flex:1;min-height:0;position:relative;display:flex;flex-direction:column;overflow:hidden}
.route-view{flex:1;min-height:0;overflow-y:auto;scrollbar-gutter:stable;padding:22px 26px 48px}
.route-view.no-pad{padding:0;overflow:hidden;display:flex}
.page-inner{max-width:1060px;margin:0 auto;width:100%}
.page-inner.full{max-width:100%}

/* Form Controls & Custom Select */
.field{display:flex;flex-direction:column;gap:6px}
.field+.field{margin-top:12px}
.field label{font-size:12px;font-weight:600;color:var(--soft)}
.ctrl{width:100%;border:1px solid var(--border);border-radius:9px;padding:8px 11px;font-size:13px;background:var(--surface);color:var(--text);outline:none;transition:border-color .15s,box-shadow .15s}
.ctrl:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(251,114,153,.13)}
textarea.ctrl{min-height:76px;resize:vertical;line-height:1.55}
.search-box{position:relative}
.search-box input{padding-left:32px}
.search-box .s-ic{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none;display:flex}

select.c-select-native{position:absolute!important;opacity:0!important;pointer-events:none!important;width:0!important;height:0!important}
.c-select{position:relative;width:100%}
.c-select-btn{width:100%;min-height:38px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);font-size:13px;font-weight:500;text-align:left;transition:border-color .15s,box-shadow .15s,background .15s}
.c-select-btn:hover{border-color:var(--border-strong);background:var(--surface-hover)}
.c-select.open .c-select-btn{border-color:var(--brand);box-shadow:0 0 0 3px rgba(251,114,153,.13)}
.c-select-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c-select-chev{color:var(--muted);transition:transform .2s ease;flex-shrink:0}
.c-select.open .c-select-chev{transform:rotate(180deg);color:var(--brand)}
.c-select-menu{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:260;background:var(--surface);border:1px solid var(--border-strong);border-radius:11px;box-shadow:var(--shadow-lg);padding:5px;max-height:240px;overflow-y:auto;opacity:0;transform:translateY(-4px) scale(.98);pointer-events:none;transition:opacity .16s ease,transform .16s cubic-bezier(.22,1,.36,1)}
.c-select.drop-up .c-select-menu{top:auto;bottom:calc(100% + 6px);transform:translateY(4px) scale(.98)}
.c-select.open .c-select-menu{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.c-select-opt{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:none;background:transparent;border-radius:7px;font-size:13px;color:var(--text);text-align:left;transition:background .12s,color .12s}
.c-select-opt:hover{background:var(--surface-hover)}
.c-select-opt.selected{background:var(--brand-soft);color:var(--brand-dark);font-weight:600}
.c-select-chk{opacity:0;color:var(--brand);flex-shrink:0}
.c-select-opt.selected .c-select-chk{opacity:1}

.tog-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;flex-shrink:0}
.tog-switch input{position:absolute;opacity:0;width:0;height:0}
.tog-track{width:40px;height:22px;border-radius:999px;background:var(--border-strong);transition:background .22s ease;position:relative;display:block}
.tog-track::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.22);transition:transform .24s cubic-bezier(.34,1.38,.64,1)}
.tog-switch input:checked+.tog-track{background:var(--brand)}
.tog-switch input:checked+.tog-track::after{transform:translateX(18px)}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border-radius:9px;font-size:13px;font-weight:600;border:1px solid var(--border);background:var(--surface);color:var(--text);white-space:nowrap;text-decoration:none;transition:background .15s,border-color .15s}
.btn:hover{background:var(--surface-hover);border-color:var(--border-strong)}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn-sm{height:30px;padding:0 11px;font-size:12px;border-radius:7px}
.btn-primary{background:var(--cta);color:var(--cta-text);border-color:transparent}
.btn-primary:hover{background:var(--cta-hover);border-color:transparent}
.btn-brand{background:var(--brand);color:#fff;border-color:transparent}
.btn-brand:hover{opacity:.92;border-color:transparent}

/* Segmented Tabs (Horizontal Spring Pill) */
.seg-tabs{position:relative;display:inline-flex;background:var(--surface-2);padding:3px;border-radius:10px;border:1px solid var(--border)}
.seg-tab{position:relative;z-index:1;border:none;background:transparent;padding:6px 14px;border-radius:7px;font-size:13px;font-weight:600;color:var(--soft);white-space:nowrap;transition:color .22s ease}
.seg-tab:hover{color:var(--text)}
.seg-tab.active{color:var(--text)}

/* Tag Pills & Popover */
.folder-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.folder-chip{display:inline-flex;align-items:center;gap:5px;height:27px;padding:0 10px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--soft);font-size:12px;font-weight:600;white-space:nowrap;transition:all .15s}
.folder-chip:hover{border-color:var(--border-strong);color:var(--text);background:var(--surface-hover)}
.folder-chip.active{border-color:var(--brand-border);background:var(--brand-soft);color:var(--brand-dark)}
.folder-cnt{font-size:10.5px;opacity:.75;font-weight:500}
.mini-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.mini-tag{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:5px;font-size:11px;font-weight:600;background:var(--surface-3);color:var(--soft);line-height:1.45}
.mini-tag.wl{background:var(--blue-soft);color:var(--blue)}
.mini-tag.fav{background:var(--warn-soft);color:var(--warn-text)}

.vh-tag-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px}
.tag-pill{display:inline-flex;align-items:center;gap:5px;height:25px;padding:0 9px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11.5px;font-weight:600}
.tag-pill button{border:none;background:none;color:var(--muted);font-size:13px;line-height:1;padding:0 1px;cursor:pointer}
.tag-pill button:hover{color:var(--err)}
.tag-add-btn{display:inline-flex;align-items:center;gap:4px;height:25px;padding:0 10px;border-radius:999px;border:1px dashed var(--border-strong);background:transparent;color:var(--soft);font-size:11.5px;font-weight:600;transition:all .15s}
.tag-add-btn:hover{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-soft)}

.tag-popover{position:fixed;z-index:290;min-width:205px;max-width:255px;background:var(--surface);border:1px solid var(--border-strong);border-radius:12px;box-shadow:var(--shadow-lg);padding:6px;animation:modalPop .14s cubic-bezier(.22,1,.36,1)}
.tag-pop-head{font-size:11px;font-weight:700;color:var(--muted);padding:5px 8px 6px}
.tag-pop-item{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 9px;border:none;background:transparent;border-radius:8px;font-size:12.5px;font-weight:500;color:var(--text);text-align:left;cursor:pointer}
.tag-pop-item:hover{background:var(--surface-hover)}
.tag-pop-item.selected{background:var(--brand-soft);color:var(--brand-dark);font-weight:600}
.tag-pop-left{display:inline-flex;align-items:center;gap:7px;min-width:0}
.tag-pop-sep{height:1px;background:var(--border);margin:5px 2px}

/* PAGE 1: SUMMARY WORKSPACE */
.recent-strip{display:flex;align-items:center;gap:8px;overflow-x:auto;padding-bottom:6px;margin-bottom:14px}
.recent-strip-label{font-size:11.5px;font-weight:700;color:var(--muted);white-space:nowrap;flex-shrink:0}
.rec-pill{
  display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:999px;
  border:1px solid var(--border);background:var(--surface);color:var(--soft);font-size:12px;font-weight:600;
  white-space:nowrap;max-width:220px;flex-shrink:0;transition:all .15s;
}
.rec-pill span{overflow:hidden;text-overflow:ellipsis}
.rec-pill:hover{border-color:var(--border-strong);color:var(--text)}
.rec-pill.active{border-color:var(--brand);background:var(--brand-soft);color:var(--brand-dark)}
.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.dot.ok{background:var(--ok)}
.dot.pending{background:var(--warn)}
.dot.err{background:var(--err)}

.empty-ws-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:34px 28px;text-align:center;box-shadow:var(--shadow-sm)}
.empty-ws-card h2{font-size:19px;font-weight:800;margin-bottom:8px}
.empty-ws-card p{font-size:13.5px;color:var(--soft);max-width:520px;margin:0 auto 20px;line-height:1.65}
.quick-inline-bar{display:flex;gap:8px;max-width:540px;margin:0 auto}

.stepper{display:flex;align-items:center;justify-content:space-between;gap:6px;background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:9px 16px;margin-bottom:14px;font-size:12.5px;overflow-x:auto}
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

.video-head{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 22px;margin-bottom:14px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;box-shadow:var(--shadow-sm);flex-wrap:wrap}
.vh-left{min-width:260px;flex:1}
.vh-title{font-size:18.5px;font-weight:800;line-height:1.4;color:var(--text);margin-bottom:10px;word-break:break-word}
.vh-title a{color:inherit;text-decoration:none}
.vh-title a:hover{color:var(--brand-dark)}
.vh-pills{display:flex;flex-wrap:wrap;gap:7px}
.meta-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;background:var(--surface-3);color:var(--soft);font-size:12px;font-weight:500;white-space:nowrap}
.meta-pill.saved{background:var(--ok-soft);color:var(--ok-text);font-weight:600}
.vh-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap}
.star-btn,.wl-btn{height:34px;padding:0 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--soft);font-size:12.5px;font-weight:600;display:inline-flex;align-items:center;gap:5px;transition:all .15s;white-space:nowrap}
.star-btn:hover,.wl-btn:hover{border-color:var(--border-strong);color:var(--text)}
.star-btn.starred{border-color:#FCD34D;background:var(--warn-soft);color:var(--warn-text)}
.wl-btn.active{border-color:var(--blue-border);background:var(--blue-soft);color:var(--blue)}
.watch-btn{display:inline-flex;align-items:center;gap:5px;height:34px;padding:0 13px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);font-size:12.5px;font-weight:600;text-decoration:none;white-space:nowrap;flex-shrink:0;transition:border-color .15s,color .15s}
.watch-btn:hover{border-color:var(--brand);color:var(--brand)}

.view-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.action-group{display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap}
.act-btn{display:inline-flex;align-items:center;gap:5px;height:33px;padding:0 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--soft);font-size:12.5px;font-weight:600;white-space:nowrap;transition:border-color .15s,color .15s,background .15s}
.act-btn:hover{border-color:var(--border-strong);color:var(--text);background:var(--surface-hover)}

.style-switch-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:14px;margin-bottom:18px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.style-pills{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.style-pill{border:1px solid var(--border);background:var(--bg);color:var(--soft);height:28px;padding:0 11px;border-radius:999px;font-size:12px;font-weight:600;transition:all .15s}
.style-pill:hover{border-color:var(--brand);color:var(--brand-dark)}
.style-pill.active{border-color:var(--brand-border);background:var(--brand-soft);color:var(--brand-dark)}
.style-pill:disabled{opacity:.5;cursor:not-allowed}
.fs-group{display:inline-flex;align-items:center;gap:4px}
.fs-btn{width:28px;height:28px;border:1px solid var(--border);background:var(--surface);color:var(--soft);border-radius:7px;font-size:12px;font-weight:700}
.fs-btn:hover{color:var(--text);border-color:var(--border-strong)}

.reader-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px 28px;box-shadow:var(--shadow-sm)}
.split-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
.split-col-head{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;padding-bottom:12px;margin-bottom:14px;border-bottom:1px solid var(--border)}

.md-theme-box{background:var(--brand-soft);border-left:3.5px solid var(--brand);border-radius:0 10px 10px 0;padding:13px 16px;margin-bottom:20px}
.md-theme-label{font-size:11.5px;font-weight:700;color:var(--brand-dark);letter-spacing:.4px;margin-bottom:5px}
.md-theme-body{font-size:var(--reader-fs,14.5px);line-height:1.75;color:var(--text);font-weight:500}
.md-sec-title{font-size:14px;font-weight:800;color:var(--text);margin:20px 0 11px;display:flex;align-items:center;gap:7px}
.md-list{list-style:none;display:flex;flex-direction:column;gap:9px;margin-bottom:18px}
.md-list li{display:flex;align-items:flex-start;gap:10px;font-size:var(--reader-fs,14px);line-height:1.72;color:var(--text)}
.md-num{flex-shrink:0;width:21px;height:21px;border-radius:50%;background:var(--surface-3);color:var(--brand-dark);font-size:11.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;margin-top:2px}
.md-conclusion{background:var(--bg);border:1px solid var(--border);border-radius:11px;padding:15px 18px;margin-top:18px}
.md-conclusion-label{font-size:11.5px;font-weight:700;color:var(--soft);margin-bottom:6px;letter-spacing:.3px}
.md-conclusion-body{font-size:var(--reader-fs,14px);line-height:1.78;color:var(--text)}
.md-p{font-size:var(--reader-fs,14px);line-height:1.78;margin-bottom:10px;color:var(--text)}
.md-note{font-size:12px;color:var(--muted);margin-top:10px;padding-top:10px;border-top:1px dashed var(--border)}
.md-code{background:var(--surface-3);padding:1px 5px;border-radius:4px;font-family:Consolas,monospace;font-size:12.5px}

.tr-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.tr-toolbar .search-box{flex:1;min-width:200px}
.tr-count{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.transcript-box{white-space:pre-wrap;word-break:break-word;font-size:var(--reader-fs,13.5px);line-height:1.85;color:var(--soft);max-height:68vh;overflow-y:auto}
.transcript-box mark{background:#FEF08A;color:#111827;border-radius:3px;padding:0 2px}
.transcript-box mark.cur-match{background:var(--brand);color:#fff}

.mm-wrap{display:flex;flex-direction:column;gap:14px}
.mm-root{display:inline-flex;align-items:center;align-self:flex-start;background:var(--cta);color:var(--cta-text);padding:10px 16px;border-radius:11px;font-size:14.5px;font-weight:700;line-height:1.45;box-shadow:var(--shadow-sm)}
.mm-branches{display:flex;flex-direction:column;gap:10px;padding-left:20px;border-left:2px solid var(--brand-border)}
.mm-node{position:relative;background:var(--bg);border:1px solid var(--border);border-radius:11px;padding:12px 15px}
.mm-node::before{content:'';position:absolute;left:-21px;top:20px;width:19px;height:2px;background:var(--brand-border)}
.mm-node-head{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer}
.mm-node-title{font-size:13.5px;font-weight:700;color:var(--text)}
.mm-node-tag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--brand-soft);color:var(--brand-dark);white-space:nowrap}
.mm-children{margin-top:10px;padding-left:16px;border-left:1.5px dashed var(--border-strong);display:flex;flex-direction:column;gap:7px}
.mm-leaf{font-size:13px;line-height:1.65;color:var(--soft);padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px}
.mm-leaf strong{color:var(--text)}

.chat-panel{display:flex;flex-direction:column;min-height:420px;max-height:66vh}
.chat-quick-row{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}
.chat-chip{border:1px solid var(--border);background:var(--bg);color:var(--soft);padding:5px 11px;border-radius:999px;font-size:12px;font-weight:500;transition:all .15s}
.chat-chip:hover{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-soft)}
.chat-messages{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:4px 2px 14px}
.chat-msg{max-width:86%;padding:11px 14px;border-radius:12px;font-size:13.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.chat-msg.user{align-self:flex-end;background:var(--cta);color:var(--cta-text);border-bottom-right-radius:4px}
.chat-msg.assistant{align-self:flex-start;background:var(--bg);border:1px solid var(--border);color:var(--text);border-bottom-left-radius:4px}
.chat-input-bar{display:flex;gap:8px;padding-top:12px;border-top:1px solid var(--border)}
.chat-input-bar .ctrl{flex:1}

.pending-banner{padding:28px 20px;text-align:center;color:var(--soft);font-size:14px}
.diag-card{background:var(--err-soft);border:1px solid var(--err-border);border-radius:12px;padding:18px 20px}
.diag-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.diag-title{font-size:14.5px;font-weight:700;color:var(--err-text)}
.diag-stage{font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--surface);border:1px solid var(--err-border);color:var(--err-text)}
.diag-rows{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.65;color:var(--text)}
.diag-row{display:grid;grid-template-columns:76px 1fr;gap:8px}
.diag-key{color:var(--soft);font-weight:600}
.diag-foot{margin-top:14px;padding-top:12px;border-top:1px dashed var(--err-border);display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}

/* PAGE 2: MONITOR UP CREATORS (2-Pane Split inside Route View) */
.monitor-split{display:flex;flex:1;min-height:0;width:100%;overflow:hidden}
.mon-aside{
  width:258px;min-width:258px;border-right:1px solid var(--border);background:var(--surface);
  display:flex;flex-direction:column;padding:14px 12px;overflow:hidden;flex-shrink:0;
}
.mon-aside-scroll{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-top:10px;padding-right:2px}
.mon-main{flex:1;min-width:0;overflow-y:auto;scrollbar-gutter:stable;padding:20px 24px 48px}
.quick-add-box{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:9px;margin-top:10px;margin-bottom:10px}
.quick-add-row{display:flex;gap:6px}
.quick-add-row .ctrl{height:32px;padding:4px 9px;font-size:12.5px}
.quick-add-row .btn{height:32px;padding:0 11px;font-size:12px}

.up-side-card{padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);cursor:pointer;transition:border-color .15s,background .15s;display:flex;align-items:center;gap:9px}
.up-side-card:hover{background:var(--surface-hover);border-color:var(--border-strong)}
.up-side-card.active{border-color:var(--brand);background:var(--brand-soft)}
.up-ava{width:32px;height:32px;border-radius:50%;object-fit:cover;background:var(--surface-3);flex-shrink:0;border:1px solid var(--border)}
.up-ava-fb{width:32px;height:32px;border-radius:50%;background:var(--surface-3);color:var(--soft);font-size:12.5px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:1px solid var(--border)}
.up-side-info{flex:1;min-width:0}
.up-side-name{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.up-side-uid{font-size:11px;color:var(--muted);font-family:Consolas,monospace}
.up-side-acts{display:flex;align-items:center;gap:2px;flex-shrink:0}
.up-act-ic{border:none;background:none;color:var(--muted);width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;opacity:0;transition:all .15s}
.up-side-card:hover .up-act-ic,.up-side-card.active .up-act-ic{opacity:1}
.up-act-ic:hover{color:var(--brand-dark);background:var(--brand-soft)}
.up-act-ic.del:hover{color:var(--err);background:var(--err-soft)}

/* Shared Page Toolbar & Video Cover Grid */
.page-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:18px;padding:15px 18px;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow-sm)}
.pt-left h2{font-size:16.5px;font-weight:800;margin-bottom:2px;display:flex;align-items:center;gap:8px}
.pt-left p{font-size:12.5px;color:var(--soft)}
.pt-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

.video-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(256px,1fr));gap:22px 16px}
.v-card{display:flex;flex-direction:column;min-width:0}
.v-thumb-wrap{position:relative;width:100%}
.v-thumb-link{position:relative;display:block;width:100%;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:var(--surface-3);border:1px solid var(--border);text-decoration:none}
.v-thumb-link img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .28s ease}
.v-card:hover .v-thumb-link img{transform:scale(1.035)}
.v-thumb-fallback{width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;font-size:13px;font-weight:700;color:var(--soft);background:linear-gradient(135deg,var(--surface-3),var(--surface-2))}
.v-dur{position:absolute;right:8px;bottom:8px;background:rgba(15,17,22,.82);color:#fff;font-size:11.5px;font-weight:600;padding:2px 6px;border-radius:5px;line-height:1.3;font-variant-numeric:tabular-nums}
.v-sum-badge{position:absolute;left:8px;top:8px;background:rgba(16,185,129,.92);color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px}
.v-chk-wrap{position:absolute;left:8px;bottom:8px;z-index:4;background:rgba(15,17,22,.72);backdrop-filter:blur(4px);border-radius:6px;padding:3px 6px;display:flex;align-items:center;gap:5px;color:#fff;font-size:11px;font-weight:600}
.v-chk-wrap input{accent-color:var(--brand);width:14px;height:14px;cursor:pointer}
.v-quick-acts{position:absolute;top:8px;right:8px;display:flex;gap:5px;z-index:3;opacity:0;transition:opacity .16s ease}
.v-card:hover .v-quick-acts,.v-quick-acts.has-active{opacity:1}
.v-qbtn{width:28px;height:28px;border-radius:8px;border:1px solid rgba(255,255,255,.22);background:rgba(15,17,22,.72);backdrop-filter:blur(6px);color:#fff;display:inline-flex;align-items:center;justify-content:center;transition:transform .12s,background .15s}
.v-qbtn:hover{background:rgba(15,17,22,.92);transform:scale(1.06)}
.v-qbtn.wl-on{background:#2563EB;border-color:#60A5FA;color:#fff}
.v-qbtn.fav-on{background:#D97706;border-color:#FCD34D;color:#fff}

.v-body{display:flex;align-items:flex-start;gap:10px;padding-top:10px}
.v-ava{width:34px;height:34px;border-radius:50%;object-fit:cover;background:var(--surface-3);border:1px solid var(--border);flex-shrink:0;margin-top:2px}
.v-ava-fb{width:34px;height:34px;border-radius:50%;background:var(--surface-3);color:var(--soft);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);flex-shrink:0;margin-top:2px}
.v-meta-col{flex:1;min-width:0}
.v-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;font-weight:700;line-height:1.42;color:var(--text);text-decoration:none;margin-bottom:4px;word-break:break-word}
.v-title:hover{color:var(--brand-dark)}
.v-author{font-size:12.5px;color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.v-stats{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:7px}
.v-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.v-time-pill{display:inline-block;background:var(--surface-3);color:var(--soft);font-size:11px;font-weight:500;padding:2px 8px;border-radius:999px;white-space:nowrap}
.v-act-row{display:inline-flex;align-items:center;gap:6px}
.v-act-btn{border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:7px;white-space:nowrap;transition:all .15s}
.v-act-btn:hover{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-soft)}
.v-act-btn.primary{background:var(--cta);color:var(--cta-text);border-color:transparent}
.v-act-btn.primary:hover{background:var(--cta-hover);color:var(--cta-text)}

.feed-footer{margin-top:26px;display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px 0 8px}
.feed-load-btn{height:38px;padding:0 22px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:8px;box-shadow:var(--shadow-sm);transition:all .15s}
.feed-load-btn:hover{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-soft)}
.feed-load-btn:disabled{opacity:.65;cursor:default}
.feed-meta-note{font-size:12px;color:var(--muted)}
.skel{background:linear-gradient(90deg,var(--surface-3) 25%,var(--surface-2) 50%,var(--surface-3) 75%);background-size:200% 100%;animation:shimmer 1.3s infinite linear;border-radius:8px}

/* KPI Grid + Summary Archive Cards (History / Favorites / Folder Summaries) */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
.kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:15px 18px;box-shadow:var(--shadow-sm)}
.kpi-label{font-size:12px;color:var(--muted);font-weight:600;margin-bottom:5px}
.kpi-val{font-size:23px;font-weight:800;color:var(--text);font-variant-numeric:tabular-nums}
.kpi-sub{font-size:11.5px;color:var(--soft);margin-top:3px}

.filter-strip{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.archive-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
.arch-card{
  background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;
  cursor:pointer;display:flex;flex-direction:column;gap:9px;box-shadow:var(--shadow-sm);
  transition:border-color .15s,box-shadow .15s,transform .15s;
}
.arch-card:hover{border-color:var(--brand);box-shadow:var(--shadow-md);transform:translateY(-1px)}
.arch-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.arch-title{font-size:14.5px;font-weight:700;line-height:1.42;color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.arch-meta{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.arch-excerpt{font-size:12.5px;line-height:1.62;color:var(--soft);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.arch-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:8px;border-top:1px solid var(--border);margin-top:auto}
.arch-acts{display:inline-flex;align-items:center;gap:5px}
.arch-ic-btn{width:28px;height:28px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--soft);display:inline-flex;align-items:center;justify-content:center;transition:all .15s}
.arch-ic-btn:hover{border-color:var(--border-strong);color:var(--text);background:var(--surface-hover)}
.arch-ic-btn.wl-on{border-color:var(--blue-border);background:var(--blue-soft);color:var(--blue)}
.arch-ic-btn.fav-on{border-color:#FCD34D;background:var(--warn-soft);color:var(--warn-text)}
.arch-ic-btn.del:hover{border-color:var(--err-border);background:var(--err-soft);color:var(--err)}

/* Modals & Email Preview */
.modal-backdrop{position:fixed;inset:0;background:rgba(10,12,18,.52);backdrop-filter:blur(4px);z-index:240;display:flex;align-items:center;justify-content:center;padding:20px}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-lg);width:100%;max-width:480px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;animation:modalPop .2s cubic-bezier(.22,1,.36,1)}
.modal.wide{max-width:860px}
.modal.reader{max-width:740px}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border);gap:12px}
.modal-head h2{font-size:16px;font-weight:800;line-height:1.4}
.modal-body{padding:20px 22px;overflow-y:auto;flex:1}
.modal-foot{padding:14px 22px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--bg);flex-wrap:wrap}
.m-section{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px}
.m-sec-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.m-sec-title{font-size:13.5px;font-weight:700;color:var(--text)}
.m-sec-sub{font-size:12px;color:var(--muted);margin-top:2px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:end}
.inline-add-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}
.chip-list{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;background:var(--surface);border:1px solid var(--border);font-size:12.5px;color:var(--text)}
.chip .chip-sub{font-size:11px;color:var(--muted);font-family:Consolas,monospace}
.chip button{border:none;background:none;color:var(--muted);font-size:15px;line-height:1;padding:0 2px}
.chip button:hover{color:var(--err)}
.cron-badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:7px;background:var(--brand-soft);color:var(--brand-dark);font-family:Consolas,monospace;font-size:11.5px;font-weight:600;white-space:nowrap}

.style-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.style-card{border:1.5px solid var(--border);border-radius:11px;padding:11px;cursor:pointer;background:var(--surface);transition:all .15s}
.style-card:hover{border-color:var(--border-strong)}
.style-card.selected{border-color:var(--brand);background:var(--brand-soft)}
.sc-thumb{height:44px;border-radius:6px;margin-bottom:8px;overflow:hidden;border:1px solid var(--border);display:flex;flex-direction:column}
.sc-name{font-size:12.5px;font-weight:700;margin-bottom:2px}
.sc-desc{font-size:11px;color:var(--muted);line-height:1.4}
.preview-box{border:1px solid var(--border);border-radius:12px;overflow:hidden;background:#F3F4F6}
.preview-bar{background:var(--surface);padding:9px 14px;border-bottom:1px solid var(--border);font-size:12px;color:var(--soft);display:flex;justify-content:space-between;align-items:center;gap:8px}
.preview-stage{padding:16px;max-height:360px;overflow-y:auto}

.color-swatches{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}
.color-sw{width:24px;height:24px;border-radius:50%;border:2px solid transparent;cursor:pointer;transition:transform .12s,box-shadow .12s}
.color-sw:hover{transform:scale(1.1)}
.color-sw.active{box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--text)}
.folder-mgr-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.folder-mgr-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg)}
.folder-mgr-left{display:flex;align-items:center;gap:9px;min-width:0}
.folder-mgr-name{font-size:13.5px;font-weight:700;color:var(--text)}
.folder-mgr-stat{font-size:11.5px;color:var(--muted)}

.sb-toast{padding:8px 12px;border-radius:8px;font-size:12.5px;display:none;line-height:1.5;margin-top:8px}
.sb-toast.show{display:block}
.sb-toast.ok{background:var(--ok-soft);color:var(--ok-text);border:1px solid rgba(16,185,129,.25)}
.sb-toast.err{background:var(--err-soft);color:var(--err-text);border:1px solid var(--err-border)}
.global-toast{position:fixed;right:24px;bottom:24px;z-index:420;background:var(--cta);color:var(--cta-text);padding:10px 16px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:var(--shadow-lg);opacity:0;transform:translateY(10px);pointer-events:none;transition:opacity .2s,transform .2s}
.global-toast.show{opacity:1;transform:translateY(0)}
.global-toast.err{background:var(--err);color:#fff}

/* Responsive: Tablet & Mobile (<=768px leaves ONLY clickable Brand Logo top-left!) */
@media(max-width:1024px){
  .kpi-grid{grid-template-columns:repeat(2,1fr)}
  .split-grid{grid-template-columns:1fr}
  .mon-aside{width:224px;min-width:224px}
}
@media(max-width:768px){
  .nav-rail{
    position:fixed;left:0;top:0;bottom:0;width:262px!important;min-width:262px!important;
    transform:translateX(-104%);transition:transform .26s cubic-bezier(.22,1,.36,1);
    box-shadow:var(--shadow-lg);padding:16px 14px 14px!important;
  }
  .app-shell.mobile-nav-open .nav-rail{transform:translateX(0)}
  .app-shell.rail-collapsed .brand-text,
  .app-shell.rail-collapsed .rail-label,
  .app-shell.rail-collapsed .rail-badge,
  .app-shell.rail-collapsed .rail-sec-title,
  .app-shell.rail-collapsed .rail-user-meta{display:block!important}
  .app-shell.rail-collapsed .rail-item{justify-content:flex-start;padding:0 10px;width:100%}
  .app-shell.rail-collapsed .folder-nav-item{justify-content:flex-start;padding:0 10px;width:100%}
  .app-shell.rail-collapsed .rail-cta{width:100%}
  .app-shell.rail-collapsed .rail-head{justify-content:space-between}
  .app-shell.rail-collapsed .rail-user-row{justify-content:flex-start;padding:6px 8px;width:100%}
  .app-shell.rail-collapsed .rail-foot-acts{flex-direction:row}
  .app-shell.rail-collapsed .rail-foot-btn{width:auto;flex:1}
  .app-shell.rail-collapsed .tb-expand-btn{display:none!important}
  .mobile-logo-btn{display:inline-flex!important}
  .topbar{padding:0 14px}
  .topbar-sub{display:none}
  .route-view{padding:14px 14px 36px}
  .monitor-split{flex-direction:column}
  .mon-aside{width:100%;min-width:0;max-height:230px;border-right:none;border-bottom:1px solid var(--border);padding:10px 12px}
  .mon-main{padding:14px 14px 36px}
  .reader-card{padding:16px}
  .form-grid,.style-grid{grid-template-columns:1fr 1fr}
  .archive-grid{grid-template-columns:1fr}
}

/* Day-Night Toggle View-Transition Reveal (from shiranzby/Day-night-toggle-button) */
:root[data-shiran-vt]::view-transition-old(root),
:root[data-shiran-vt]::view-transition-new(root){animation:none;mix-blend-mode:normal}
:root[data-shiran-vt]::view-transition-group(root){animation-duration:0s}
:root[data-shiran-vt]::view-transition-old(root){z-index:1}
:root[data-shiran-vt]::view-transition-new(root){z-index:2}
theme-button{flex-shrink:0}

/* Narrow-Screen Video Header Layout (Left: Title + Meta + Tags | Right: Stacked Controls) */
.vh-tag-mobile-btn{display:none}
@media(max-width:680px){
  .video-head{
    display:grid!important;grid-template-columns:minmax(0,1fr) 104px;
    gap:12px;align-items:start;padding:14px 14px;
  }
  .vh-left{min-width:0;width:100%}
  .vh-title{font-size:15.5px;line-height:1.42;margin-bottom:8px;word-break:break-word}
  .vh-pills{gap:5px}
  .meta-pill{font-size:11px;padding:2px 8px}
  .vh-actions{
    flex-direction:column;width:104px;gap:6px;align-items:stretch;
  }
  .vh-actions .wl-btn,.vh-actions .star-btn,.vh-actions .watch-btn,.vh-actions .vh-tag-mobile-btn{
    width:100%;height:30px;padding:0 8px;font-size:11.5px;justify-content:center;border-radius:8px;
  }
  .vh-tag-mobile-btn{
    display:inline-flex!important;align-items:center;gap:4px;
    border:1px dashed var(--border-strong);background:var(--bg);color:var(--soft);font-weight:600;
  }
  .vh-tag-mobile-btn:hover{border-color:var(--brand);color:var(--brand-dark);background:var(--brand-soft)}
  .vh-tag-row .tag-add-btn{display:none}
  .view-bar{gap:8px}
  .seg-tabs{max-width:100%;overflow-x:auto}
  .seg-tab{padding:5px 10px;font-size:12px}
  .act-btn{height:30px;padding:0 9px;font-size:11.5px}
  .topbar{padding:0 12px;gap:8px}
  .topbar-actions{gap:5px}
  .topbar-actions .pill-btn{height:30px;padding:0 8px;font-size:11.5px;gap:4px}
  .topbar-actions .tb-hide-sm{display:none}
  .topbar-title{font-size:14px}
}

/* Stacked Fan-Deck Favorite Folder Rows & Accordion Expand */
.fav-deck-list{display:flex;flex-direction:column;gap:14px}
.fav-deck-card{
  background:var(--surface);border:1px solid var(--border);border-radius:16px;
  box-shadow:var(--shadow-sm);overflow:hidden;
  transition:border-color .2s,box-shadow .2s;
}
.fav-deck-card:hover{border-color:var(--border-strong);box-shadow:var(--shadow-md)}
.fav-deck-card.expanded{border-color:var(--brand-border);box-shadow:var(--shadow-md)}
.fav-deck-head{
  display:flex;align-items:center;gap:22px;padding:18px 22px;cursor:pointer;
  transition:background .15s;
}
.fav-deck-head:hover{background:var(--surface-hover)}

.fan-deck-wrap{position:relative;width:206px;height:118px;flex-shrink:0;user-select:none}
.fan-deck{position:relative;width:180px;height:101px;perspective:700px}
.fan-card{
  position:absolute;inset:0;border-radius:11px;overflow:hidden;
  border:1.5px solid var(--surface);background:var(--surface-3);
  transform-origin:15% 88%;
  transition:transform .42s cubic-bezier(.34,1.32,.64,1),opacity .32s ease,box-shadow .32s ease;
  will-change:transform,opacity;
}
.fan-card img{width:100%;height:100%;object-fit:cover;display:block}
.fan-card-fb{
  width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:10px;
  text-align:center;font-size:11.5px;font-weight:700;color:var(--soft);
  background:linear-gradient(135deg,var(--surface-3),var(--surface-2));
}
.fan-card.pos-0{z-index:3;transform:translate(0,0) rotate(0deg) scale(1);box-shadow:0 8px 20px rgba(15,23,42,.20);opacity:1}
.fan-card.pos-1{z-index:2;transform:translate(13px,7px) rotate(3.6deg) scale(.94);box-shadow:0 5px 14px rgba(15,23,42,.13);opacity:.92}
.fan-card.pos-2{z-index:1;transform:translate(24px,14px) rotate(7.2deg) scale(.88);box-shadow:0 3px 10px rgba(15,23,42,.08);opacity:.76}
.fav-deck-head:hover .fan-card.pos-0{transform:translate(-3px,-2px) rotate(-1.2deg) scale(1.02)}
.fav-deck-head:hover .fan-card.pos-1{transform:translate(17px,9px) rotate(5.2deg) scale(.94)}
.fav-deck-head:hover .fan-card.pos-2{transform:translate(30px,17px) rotate(9.8deg) scale(.88)}

.fan-nav{
  position:absolute;left:6px;bottom:10px;z-index:5;display:inline-flex;align-items:center;gap:4px;
  background:rgba(15,17,22,.72);backdrop-filter:blur(6px);border-radius:999px;padding:2px 5px;color:#fff;
}
.fan-nav-btn{
  width:20px;height:20px;border:none;border-radius:50%;background:transparent;color:#fff;
  display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;
}
.fan-nav-btn:hover{background:rgba(255,255,255,.22)}
.fan-nav-idx{font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums;padding:0 3px}

.fav-deck-info{flex:1;min-width:0}
.fav-deck-title-row{display:flex;align-items:center;gap:9px;margin-bottom:7px;flex-wrap:wrap}
.fav-deck-name{font-size:16px;font-weight:800;color:var(--text)}
.fav-deck-cnt{font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:999px;background:var(--surface-3);color:var(--soft)}
.fav-deck-previews{display:flex;flex-direction:column;gap:4px}
.fav-deck-pv{font-size:12.5px;color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:7px}
.fav-deck-pv-num{font-size:11px;font-weight:700;color:var(--brand);font-family:Consolas,monospace;flex-shrink:0}

.fav-deck-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.fav-deck-chev{width:30px;height:30px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--soft);display:inline-flex;align-items:center;justify-content:center;transition:transform .28s cubic-bezier(.22,1,.36,1),background .15s}
.fav-deck-card.expanded .fav-deck-chev{transform:rotate(180deg);background:var(--brand-soft);border-color:var(--brand-border);color:var(--brand-dark)}

/* Smooth Top-to-Bottom Accordion Expand */
.fav-deck-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .34s cubic-bezier(.22,1,.36,1)}
.fav-deck-card.expanded .fav-deck-collapse{grid-template-rows:1fr}
.fav-deck-collapse-inner{overflow:hidden}
.fav-deck-items{border-top:1px solid var(--border);background:var(--bg);padding:12px 18px;display:flex;flex-direction:column;gap:10px}

.fav-item-row{
  display:flex;align-items:center;gap:15px;padding:11px 14px;border-radius:12px;
  background:var(--surface);border:1px solid var(--border);transition:border-color .15s,box-shadow .15s;
}
.fav-item-row:hover{border-color:var(--brand-border);box-shadow:var(--shadow-sm)}
.fav-item-thumb{
  position:relative;width:154px;aspect-ratio:16/9;border-radius:9px;overflow:hidden;
  background:var(--surface-3);border:1px solid var(--border);flex-shrink:0;text-decoration:none;display:block;
}
.fav-item-thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .24s ease}
.fav-item-row:hover .fav-item-thumb img{transform:scale(1.04)}
.fav-item-mid{flex:1;min-width:0}
.fav-item-title{font-size:14px;font-weight:700;color:var(--text);text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.42;margin-bottom:5px}
.fav-item-title:hover{color:var(--brand-dark)}
.fav-item-meta{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.fav-item-excerpt{font-size:12px;color:var(--soft);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fav-item-acts{display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap}

@media(max-width:768px){
  .fav-deck-head{flex-direction:column;align-items:flex-start;gap:14px;padding:14px}
  .fav-deck-right{width:100%;justify-content:flex-end}
  .fav-item-row{flex-direction:column;align-items:stretch;gap:10px}
  .fav-item-thumb{width:100%}
  .fav-item-acts{justify-content:flex-end}
}

.pick-chip-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.pick-chip{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--soft);font-size:12px;font-weight:600;transition:all .15s}
.pick-chip:hover{border-color:var(--border-strong);color:var(--text)}
.pick-chip.selected{border-color:var(--brand);background:var(--brand-soft);color:var(--brand-dark)}

</style>
</head>
<body>

<!-- FULL-SCREEN AUTH GATE (Enforces Login + 90-Day Single-Device Persistence) -->
<div class="auth-gate hidden" id="authGate">
  <div class="auth-gate-theme"><theme-button id="gateThemeBtn" size="1.15" aria-label="切换日夜主题"></theme-button></div>
  <div class="auth-card">
    <div class="auth-brand">
      <div class="brand-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M8 3l3 3M16 3l-3 3"/><path d="M9 12v2M15 12v2"/></svg>
      </div>
      <div>
        <h1>B站AI摘要</h1>
        <p>个人视频知识库与 UP 主监控工作台</p>
      </div>
    </div>
    <div class="field">
      <label>账号</label>
      <input class="ctrl" id="gateUser" type="text" value="shiran" autocomplete="username" onkeydown="if(event.key==='Enter')document.getElementById('gatePass').focus()">
    </div>
    <div class="field">
      <label>密码</label>
      <input class="ctrl" id="gatePass" type="password" placeholder="请输入管理员密码" autocomplete="current-password" onkeydown="if(event.key==='Enter')doGateLogin()">
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin:14px 0 18px;gap:10px">
      <div>
        <div style="font-size:13px;font-weight:600;color:var(--text)">本机持久化登录</div>
        <div style="font-size:11.5px;color:var(--muted)">90 天免重登，活跃期间自动续期</div>
      </div>
      <label class="tog-switch"><input type="checkbox" id="gateRemember" checked><span class="tog-track"></span></label>
    </div>
    <button class="btn btn-primary" style="width:100%;height:40px;font-size:14px" id="gateLoginBtn" onclick="doGateLogin()">登录进入工作台</button>
    <div class="sb-toast" id="gateToast"></div>
    <div class="auth-note">已启用 HttpOnly 安全会话与单机持久登录保护</div>
  </div>
</div>

<!-- MAIN APP SHELL (Plan A Expanded + Plan B Collapsed Rail + Mobile Drawer) -->
<div class="app-shell hidden" id="appShell">
  <div class="mobile-backdrop" id="mobileBackdrop" onclick="toggleMobileNav(false)"></div>

  <aside class="nav-rail" id="navRail">
    <div class="rail-head">
      <button class="brand-link" onclick="onBrandClick()" data-tip="展开 / 收起侧边栏" title="点击品牌图标展开或收起侧边栏">
        <div class="brand-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M8 3l3 3M16 3l-3 3"/><path d="M9 12v2M15 12v2"/></svg>
        </div>
        <div class="brand-text">
          <div class="brand-title">B站AI摘要</div>
          <div class="brand-sub">视频知识工作台</div>
        </div>
      </button>
    </div>

    <div class="rail-scroll">
      <nav class="rail-nav" id="railNav">
        <span class="nav-slider" id="railNavSlider"></span>
        <button class="rail-item active" data-route="summary" data-tip="摘要工作台" onclick="navigate('summary')">
          <svg class="ic-lg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span class="rail-label">摘要工作台</span>
        </button>
        <button class="rail-item" data-route="monitor" data-tip="监控 UP 主" onclick="navigate('monitor')">
          <svg class="ic-lg" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>
          <span class="rail-label">监控 UP 主</span>
          <span class="rail-badge" id="navCntMonitor">0</span>
        </button>
        <button class="rail-item" data-route="watch-later" data-tip="稍后再看" onclick="navigate('watch-later')">
          <svg class="ic-lg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>
          <span class="rail-label">稍后再看</span>
          <span class="rail-badge" id="navCntWl">0</span>
        </button>
        <button class="rail-item" data-route="favorites" data-tip="我的收藏" onclick="navigate('favorites')">
          <svg class="ic-lg" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          <span class="rail-label">我的收藏</span>
          <span class="rail-badge" id="navCntFav">0</span>
        </button>
        <button class="rail-item" data-route="history" data-tip="历史记录" onclick="navigate('history')">
          <svg class="ic-lg" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          <span class="rail-label">历史记录</span>
          <span class="rail-badge" id="navCntHist">0</span>
        </button>
      </nav>

      <div class="rail-sep"></div>
      <div class="rail-sec-head">
        <span class="rail-sec-title">摘要分类</span>
        <button class="rail-sec-add" onclick="openTagManagerModal('summary')" data-tip="管理摘要分类" title="管理摘要分类">
          <svg class="ic" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
      <div class="rail-folders" id="railSummaryFolderList"></div>

      <div class="rail-sep"></div>
      <div class="rail-sec-head">
        <span class="rail-sec-title">UP 主分类</span>
        <button class="rail-sec-add" onclick="openTagManagerModal('up')" data-tip="管理 UP 主分类" title="管理 UP 主分类">
          <svg class="ic" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
      <div class="rail-folders" id="railUpFolderList"></div>
    </div>

    <div class="rail-foot">
      <div class="rail-user-row" onclick="openMonitorModal()" data-tip="监控与日报配置" title="点击打开定时监控与日报样式配置">
        <div class="rail-user-ava" id="railUserAva">S</div>
        <div class="rail-user-meta">
          <div class="rail-user-name" id="railUserName">shiran</div>
          <div class="rail-user-sub">本机持久已登录</div>
        </div>
      </div>
      <div class="rail-foot-acts">
        <button class="rail-foot-btn" onclick="openSettingsModal()" data-tip="偏好设置">
          <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span class="rail-label">设置</span>
        </button>
        <button class="rail-foot-btn" onclick="doLogout()" data-tip="退出登录" title="退出当前设备登录">
          <svg class="ic" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          <span class="rail-label">退出</span>
        </button>
      </div>
    </div>
  </aside>

  <main class="main-col">
    <header class="topbar">
      <div class="tb-left">
        <button class="mobile-logo-btn" onclick="toggleMobileNav()" aria-label="展开或收起菜单">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M8 3l3 3M16 3l-3 3"/><path d="M9 12v2M15 12v2"/></svg>
        </button>
        <span class="topbar-title" id="topbarTitle">摘要工作台</span>
        <span class="topbar-sub" id="topbarSub"></span>
      </div>
      <div class="topbar-actions">
        <theme-button id="topThemeBtn" size="1.05" aria-label="切换日夜主题"></theme-button>
        <button class="pill-btn tb-hide-sm" onclick="openMonitorModal()">
          <svg class="ic" viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
          <span>定时与样式</span>
        </button>
        <button class="pill-btn brand" onclick="openAddMonitorModal()">
          <svg class="ic" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
          <span>新增监控</span>
        </button>
        <button class="pill-btn" onclick="openSubmitModal('single')" title="快捷键 Ctrl+K">
          <svg class="ic" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span>新建摘要</span>
        </button>
      </div>
    </header>

    <div class="route-host">
      <!-- ROUTE 1: SUMMARY WORKSPACE -->
      <section class="route-view" id="view-summary">
        <div class="page-inner">
          <div class="recent-strip" id="recentStrip"></div>

          <div class="empty-ws-card" id="summaryEmptyState">
            <h2>开始你的视频 AI 精读</h2>
            <p>粘贴 B 站视频链接或 BV 号，自动完成免费语音转录与结构化摘要；支持秒速切换风格、可视化思维导图、全文检索与围绕视频多轮 AI 追问。</p>
            <div class="quick-inline-bar">
              <input class="ctrl" id="inlineVideoUrl" type="text" placeholder="粘贴 B 站视频链接或 BV 号，按 Enter 开始总结..." onkeydown="if(event.key==='Enter')submitInlineVideo()">
              <button class="btn btn-primary" onclick="submitInlineVideo()">开始总结</button>
            </div>
          </div>

          <div id="detailView" class="hidden">
            <div class="stepper hidden" id="stepperBar"></div>

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
                <button class="vh-tag-mobile-btn" id="vhTagMobileBtn" type="button" onclick="openCurrentJobTagPopover(this)">
                  <svg class="ic" viewBox="0 0 24 24"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                  <span>添加标签</span>
                </button>
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
                <button class="act-btn" onclick="exportPosterPng()">
                  <svg class="ic" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  <span>分享长图</span>
                </button>
              </div>
            </div>

            <article class="reader-card" id="summaryCard">
              <div class="style-switch-bar" id="styleSwitchBar">
                <div class="style-pills">
                  <span style="font-size:12px;color:var(--muted);font-weight:600;margin-right:2px">秒速重总结：</span>
                  <button class="style-pill active" data-rs="daily" onclick="resummarizeCurrent('daily')">精炼日报</button>
                  <button class="style-pill" data-rs="notes" onclick="resummarizeCurrent('notes')">深度笔记</button>
                  <button class="style-pill" data-rs="quotes" onclick="resummarizeCurrent('quotes')">金句观点</button>
                  <button class="style-pill" data-rs="flashcards" onclick="resummarizeCurrent('flashcards')">学习闪卡</button>
                </div>
                <div class="fs-group">
                  <button class="fs-btn" onclick="adjustFontSize(-1)" title="减小字号">A-</button>
                  <button class="fs-btn" onclick="adjustFontSize(1)" title="增大字号">A+</button>
                </div>
              </div>
              <div id="summaryContent"></div>
            </article>

            <article class="reader-card hidden" id="mindmapCard">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)">
                <div style="font-size:13px;color:var(--soft)">点击任意节点可折叠或展开细节</div>
                <button class="btn btn-sm" onclick="copyMindmapOutline()">复制导图大纲</button>
              </div>
              <div id="mindmapContent"></div>
            </article>

            <article class="reader-card hidden" id="transcriptCard">
              <div class="tr-toolbar">
                <div class="search-box">
                  <span class="s-ic"><svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span>
                  <input class="ctrl" id="trSearchInput" type="text" placeholder="在转录文本中搜索关键词..." oninput="highlightTranscript()">
                </div>
                <span class="tr-count" id="trMatchCount"></span>
                <button class="btn btn-sm" onclick="jumpTrMatch(-1)">上一处</button>
                <button class="btn btn-sm" onclick="jumpTrMatch(1)">下一处</button>
              </div>
              <div class="transcript-box" id="transcriptContent"></div>
            </article>

            <div class="split-grid hidden" id="splitView">
              <article class="reader-card">
                <div class="split-col-head">AI 总结</div>
                <div id="splitSummary"></div>
              </article>
              <article class="reader-card">
                <div class="split-col-head">完整语音转录</div>
                <div class="transcript-box" id="splitTranscript"></div>
              </article>
            </div>

            <article class="reader-card hidden" id="chatCard">
              <div class="chat-panel">
                <div class="chat-quick-row">
                  <button class="chat-chip" onclick="sendVideoChat('请提炼视频中提到的所有工具、模型、方法或专有名词清单')">提取工具与概念清单</button>
                  <button class="chat-chip" onclick="sendVideoChat('用通俗易懂的大白话，向完全不懂的新手重新解释一遍这个视频的核心内容')">用大白话给新手讲一遍</button>
                  <button class="chat-chip" onclick="sendVideoChat('视频中有哪些核心论点、前提假设或值得商榷的地方？')">梳理核心论点与争议</button>
                  <button class="chat-chip" onclick="sendVideoChat('请把这个视频改写成一段适合发朋友圈/小红书的精华分享文案（200字以内）')">改写为社媒精华笔记</button>
                  <button class="btn btn-sm" style="margin-left:auto" onclick="clearVideoChat()">清空对话</button>
                </div>
                <div class="chat-messages" id="chatMessages"></div>
                <div class="chat-input-bar">
                  <input class="ctrl" id="chatInput" type="text" placeholder="围绕这个视频继续提问，按 Enter 发送..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendVideoChat();}">
                  <button class="btn btn-primary" id="chatSendBtn" onclick="sendVideoChat()">发送</button>
                </div>
              </div>
            </article>
          </div>
        </div>
      </section>

      <!-- ROUTE 2: MONITOR UP CREATORS (2-Pane Keep-Alive) -->
      <section class="route-view no-pad hidden" id="view-monitor">
        <div class="monitor-split">
          <div class="mon-aside">
            <div class="search-box">
              <span class="s-ic"><svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span>
              <input class="ctrl" id="upSearchInput" type="text" placeholder="搜索已监控 UP 主..." oninput="renderUpSidebar()">
            </div>
            <div class="quick-add-box">
              <div class="quick-add-row">
                <input class="ctrl" id="sideAddUpInput" type="text" placeholder="添加 UP 主 UID 或主页链接..." onkeydown="if(event.key==='Enter')quickAddMonitorUp()">
                <button class="btn btn-primary" type="button" id="sideAddUpBtn" onclick="quickAddMonitorUp()">添加</button>
              </div>
              <div class="sb-toast" id="sideUpToast"></div>
            </div>
            <div class="folder-bar" id="monFolderBar" style="margin-bottom:4px"></div>
            <div class="mon-aside-scroll" id="upSideList"></div>
          </div>

          <div class="mon-main" id="monScrollArea">
            <div class="page-toolbar">
              <div class="pt-left">
                <h2 id="monFeedHeading">全部监控 UP 主动态</h2>
                <p id="monSummaryLine">正在加载监控配置...</p>
              </div>
              <div class="pt-actions">
                <button class="btn" id="refreshFeedBtn" onclick="fetchUpFeed(selectedUpMid, true)">刷新动态</button>
                <button class="btn" onclick="openMonitorModal()">定时与样式</button>
                <button class="btn btn-primary" onclick="triggerMonitorNow('feedToast')">立即巡检</button>
              </div>
            </div>
            <div class="sb-toast" id="feedToast" style="margin-bottom:14px"></div>
            <div class="video-grid" id="upFeedGrid"></div>
            <div class="feed-footer" id="feedFooter"></div>
            <div id="feedSentinel" style="height:2px"></div>
          </div>
        </div>
      </section>

      <!-- ROUTE 3: WATCH LATER QUEUE -->
      <section class="route-view hidden" id="view-watch-later">
        <div class="page-inner full">
          <div class="page-toolbar">
            <div class="pt-left">
              <h2>稍后再看队列</h2>
              <p id="wlPageSub">收藏待看视频，支持勾选一键批量 AI 总结</p>
            </div>
            <div class="pt-actions">
              <div class="seg-tabs" id="wlFilterTabs">
                <span class="seg-slider"></span>
                <button class="seg-tab active" data-wlf="all" onclick="setWlFilter('all')">全部</button>
                <button class="seg-tab" data-wlf="todo" onclick="setWlFilter('todo')">待总结</button>
                <button class="seg-tab" data-wlf="done" onclick="setWlFilter('done')">已有摘要</button>
              </div>
              <button class="btn" id="wlSelectAllBtn" onclick="toggleWlSelectAll()">全选待总结</button>
              <button class="btn btn-primary" id="wlBatchSumBtn" onclick="batchSummarizeWatchLater()">批量 AI 总结</button>
              <button class="btn" onclick="clearDoneWatchLater()">清理已总结</button>
            </div>
          </div>
          <div class="video-grid" id="wlGrid"></div>
        </div>
      </section>

      <!-- ROUTE 4: FAVORITES STACKED FAN-DECK FOLDERS -->
      <section class="route-view hidden" id="view-favorites">
        <div class="page-inner full">
          <div class="page-toolbar">
            <div class="pt-left">
              <h2>我的收藏</h2>
              <p id="favPageSub">按收藏文件夹归类，支持封面叠层切换与下滑展开查看</p>
            </div>
            <div class="pt-actions">
              <div class="search-box" style="width:220px">
                <span class="s-ic"><svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span>
                <input class="ctrl" id="favSearchInput" type="text" placeholder="搜索收藏视频或摘要..." oninput="renderFavoritesPage()">
              </div>
              <button class="btn btn-brand" onclick="openTagManagerModal('fav')">+ 新建收藏夹</button>
            </div>
          </div>
          <div class="fav-deck-list" id="favDeckList"></div>
        </div>
      </section>

      <!-- ROUTE 5: HISTORY ARCHIVE + KPI STATS -->
      <section class="route-view hidden" id="view-history">
        <div class="page-inner full">
          <div class="kpi-grid" id="kpiGrid"></div>

          <div class="page-toolbar">
            <div class="pt-left">
              <h2>历史归档记录</h2>
              <p id="histPageSub">检索、打标、重算与批量管理全部视频摘要任务</p>
            </div>
            <div class="pt-actions">
              <div class="search-box" style="width:230px">
                <span class="s-ic"><svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span>
                <input class="ctrl" id="histSearchInput" type="text" placeholder="搜索标题、UP主或 BV 号..." oninput="renderHistoryPage()">
              </div>
              <div class="seg-tabs" id="histStatusTabs">
                <span class="seg-slider"></span>
                <button class="seg-tab active" data-hf="all" onclick="setHistStatus('all')">全部</button>
                <button class="seg-tab" data-hf="completed" onclick="setHistStatus('completed')">已完成</button>
                <button class="seg-tab" data-hf="pending" onclick="setHistStatus('pending')">处理中</button>
                <button class="seg-tab" data-hf="failed" onclick="setHistStatus('failed')">失败</button>
              </div>
              <button class="btn" id="histBatchBtn" onclick="toggleHistBatchMode()">批量管理</button>
            </div>
          </div>

          <div class="filter-strip">
            <div class="folder-bar" id="histFolderBar"></div>
            <div class="hidden" id="histBatchActions" style="display:flex;gap:8px;align-items:center">
              <button class="btn btn-sm" onclick="histSelectAll()">全选</button>
              <button class="btn btn-sm" onclick="histInvertSelect()">反选</button>
              <button class="btn btn-sm" style="color:var(--err);border-color:var(--err-border)" onclick="histDeleteSelected()">删除已选</button>
            </div>
          </div>

          <div class="archive-grid" id="histArchiveGrid"></div>
        </div>
      </section>

      <!-- ROUTE 6: GLOBAL TAG FOLDER AGGREGATION PAGE -->
      <section class="route-view hidden" id="view-folder">
        <div class="page-inner full">
          <div class="page-toolbar">
            <div class="pt-left">
              <h2 id="folderPageTitle"><span class="folder-dot" id="folderPageDot" style="width:11px;height:11px"></span><span id="folderPageName">标签文件夹</span></h2>
              <p id="folderPageSub">聚合该分类下的 AI 摘要与 UP 主最新动态</p>
            </div>
            <div class="pt-actions">
              <div class="seg-tabs" id="folderViewTabs">
                <span class="seg-slider"></span>
                <button class="seg-tab active" data-fvt="summaries" onclick="setFolderViewTab('summaries')">相关摘要</button>
                <button class="seg-tab" data-fvt="ups" onclick="setFolderViewTab('ups')">该分类 UP 主动态</button>
              </div>
              <button class="btn" onclick="openTagManagerModal()">管理文件夹</button>
            </div>
          </div>

          <div id="folderSummariesPane">
            <div class="archive-grid" id="folderSummariesGrid"></div>
          </div>

          <div id="folderUpsPane" class="hidden">
            <div class="video-grid" id="folderUpsGrid"></div>
            <div class="feed-footer" id="folderFeedFooter"></div>
            <div id="folderFeedSentinel" style="height:2px"></div>
          </div>
        </div>
      </section>
    </div>
  </main>
</div>

<!-- GLOBAL FLOATING TOAST & TAG POPOVER -->
<div class="global-toast" id="globalToast"></div>
<div class="tag-popover hidden" id="tagPopover"></div>

<!-- NEW SUMMARY / BATCH SUBMIT MODAL (Ctrl+K) -->
<div class="modal-backdrop hidden" id="submitModal" onclick="if(event.target===this)closeModal('submitModal')">
  <div class="modal">
    <div class="modal-head">
      <h2>新建视频 AI 摘要</h2>
      <button class="icon-btn" onclick="closeModal('submitModal')" aria-label="关闭">
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="seg-tabs" id="submitModeTabs" style="margin-bottom:16px">
        <span class="seg-slider"></span>
        <button class="seg-tab active" data-sm="single" onclick="switchSubmitTab('single')">单条视频总结</button>
        <button class="seg-tab" data-sm="batch" onclick="switchSubmitTab('batch')">批量提交（最多 5 条）</button>
      </div>

      <div id="submitSinglePane">
        <div class="field">
          <label>B 站视频链接或 BV / AV 号</label>
          <input class="ctrl" id="modalVideoUrl" type="text" placeholder="https://www.bilibili.com/video/BV..." onkeydown="if(event.key==='Enter')submitModalSingle()">
        </div>
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
        <div class="field" style="margin-top:12px">
          <label>摘要分类标签（可选，可多选）</label>
          <div class="pick-chip-row" id="submitFolderPicker"></div>
        </div>
        <div class="form-grid" style="margin-top:12px">
          <div class="field">
            <label>单条结果接收邮箱（可选）</label>
            <input class="ctrl" id="customEmail" type="email" placeholder="留空发至默认邮箱">
          </div>
          <div class="field">
            <label>单条邮件样式</label>
            <select class="ctrl" id="singleEmailStyle">
              <option value="editorial">编辑部日报（深色报头）</option>
              <option value="minimal">极简纸刊（纯白 Notion）</option>
              <option value="bilibili">B站元气粉（渐变）</option>
              <option value="compact">极速速览（紧凑）</option>
            </select>
          </div>
        </div>
      </div>

      <div id="submitBatchPane" class="hidden">
        <div class="field">
          <label>每行粘贴一个 B 站视频链接或 BV 号（单次最多 5 条）</label>
          <textarea class="ctrl" id="batchUrlsInput" style="min-height:140px" placeholder="https://www.bilibili.com/video/BV149ypz6Ehs&#10;BV1ZssS6iEB9"></textarea>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal('submitModal')">取消</button>
      <button class="btn btn-primary" id="modalSubmitBtn" onclick="handleModalSubmit()">开始总结</button>
    </div>
  </div>
</div>

<!-- ADD MONITOR UP MODAL (Topbar "+ 新增监控") -->
<div class="modal-backdrop hidden" id="addMonitorModal" onclick="if(event.target===this)closeModal('addMonitorModal')">
  <div class="modal">
    <div class="modal-head">
      <div>
        <h2>新增监控 UP 主</h2>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">输入 B 站 UP 主 UID 或主页链接，可选直接归入 UP 主分类</div>
      </div>
      <button class="icon-btn" onclick="closeModal('addMonitorModal')" aria-label="关闭">
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>UP 主 UID 或空间链接</label>
        <input class="ctrl" id="modalAddUpInput" type="text" placeholder="例如：346563107 或 https://space.bilibili.com/346563107" onkeydown="if(event.key==='Enter')submitModalAddUp()">
      </div>
      <div class="field">
        <label>归入 UP 主分类（可选，可多选）</label>
        <div class="pick-chip-row" id="addUpFolderPicker"></div>
      </div>
      <div class="sb-toast" id="modalAddUpToast"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal('addMonitorModal')">取消</button>
      <button class="btn btn-primary" id="modalAddUpBtn" onclick="submitModalAddUp()">解析并添加监控</button>
    </div>
  </div>
</div>

<!-- 3-SCOPE FOLDER MANAGER MODAL (摘要分类 / UP主分类 / 收藏文件夹) -->
<div class="modal-backdrop hidden" id="tagManagerModal" onclick="if(event.target===this)closeModal('tagManagerModal')">
  <div class="modal">
    <div class="modal-head">
      <div>
        <h2>分类与收藏文件夹管理</h2>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">独立管理摘要分类、UP 主分组与收藏夹，自动同步至 Cloudflare R2</div>
      </div>
      <button class="icon-btn" onclick="closeModal('tagManagerModal')" aria-label="关闭">
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="seg-tabs" id="folderMgrTabs" style="margin-bottom:16px">
        <span class="seg-slider"></span>
        <button class="seg-tab active" data-fscope="summary" onclick="switchFolderMgrScope('summary')">摘要分类</button>
        <button class="seg-tab" data-fscope="up" onclick="switchFolderMgrScope('up')">UP 主分类</button>
        <button class="seg-tab" data-fscope="fav" onclick="switchFolderMgrScope('fav')">收藏文件夹</button>
      </div>
      <div class="field">
        <label id="newFolderLabel">新建摘要分类</label>
        <div style="display:flex;gap:8px">
          <input class="ctrl" id="newFolderNameInput" type="text" maxlength="16" placeholder="输入文件夹名称..." onkeydown="if(event.key==='Enter')createNewFolder()">
          <button class="btn btn-primary" type="button" onclick="createNewFolder()">创建</button>
        </div>
        <div class="color-swatches" id="folderColorSwatches"></div>
      </div>
      <div style="font-size:12px;font-weight:700;color:var(--soft);margin-top:16px" id="existingFolderTitle">已有分类</div>
      <div class="folder-mgr-list" id="folderMgrList"></div>
    </div>
    <div class="modal-foot">
      <span style="font-size:12px;color:var(--muted)" id="librarySyncHint">已同步至云端 R2</span>
      <button class="btn btn-primary" onclick="closeModal('tagManagerModal')">完成</button>
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
        <button class="btn" onclick="copyModalSummary()">复制摘要</button>
        <button class="btn btn-primary" onclick="closeModal('summaryModal')">关闭</button>
      </div>
    </div>
  </div>
</div>

<!-- USER PREFERENCES & SETTINGS MODAL -->
<div class="modal-backdrop hidden" id="settingsModal" onclick="if(event.target===this)closeModal('settingsModal')">
  <div class="modal">
    <div class="modal-head">
      <div>
        <h2>偏好与系统设置</h2>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">单条摘要默认邮件策略与工作台偏好</div>
      </div>
      <button class="icon-btn" onclick="closeModal('settingsModal')" aria-label="关闭">
        <svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="m-section">
        <div class="m-sec-head" style="margin-bottom:0">
          <div>
            <div class="m-sec-title">单条摘要完成后发送邮件</div>
            <div class="m-sec-sub">关闭后仅保存网页端与 R2，不发送单条邮件（不影响定时日报）</div>
          </div>
          <label class="tog-switch"><input type="checkbox" id="prefSendEmail" checked><span class="tog-track"></span></label>
        </div>
      </div>

      <div class="m-section">
        <div class="m-sec-title" style="margin-bottom:12px">单条摘要默认配置</div>
        <div class="field">
          <label>默认接收邮箱（留空发至系统默认邮箱）</label>
          <input class="ctrl" id="prefDefaultEmail" type="email" placeholder="example@qq.com">
        </div>
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
          <label>默认总结模板</label>
          <select class="ctrl" id="prefDefaultTpl">
            <option value="">默认精炼日报模板</option>
            <option value="notes">深度结构化笔记</option>
            <option value="quotes">金句与核心观点提取</option>
          </select>
        </div>
      </div>

      <div class="m-section" style="margin-bottom:0">
        <div class="m-sec-title" style="margin-bottom:12px">阅读工作台偏好</div>
        <div class="field">
          <label>打开摘要默认显示视图</label>
          <select class="ctrl" id="prefDefaultView">
            <option value="summary">AI 总结</option>
            <option value="mindmap">思维导图</option>
            <option value="transcript">完整转录</option>
            <option value="split">分栏对照</option>
            <option value="chat">AI 追问</option>
          </select>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);gap:10px;flex-wrap:wrap">
          <div style="font-size:12px;color:var(--soft)" id="sysStatsBadge">读取系统状态中...</div>
          <button class="btn btn-sm" type="button" onclick="clearLocalCaches()">清空动态封面缓存</button>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal('settingsModal')">取消</button>
      <button class="btn btn-brand" onclick="saveUserPrefs()">保存设置</button>
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
      <div class="seg-tabs" id="monitorTabs" style="margin-bottom:18px">
        <span class="seg-slider"></span>
        <button class="seg-tab active" data-mtab="schedule" onclick="switchMonitorTab('schedule')">定时与 UP 主监控</button>
        <button class="seg-tab" data-mtab="email" onclick="switchMonitorTab('email')">邮件样式与实时预览</button>
      </div>

      <div id="mTabSchedule">
        <div class="m-section">
          <div class="m-sec-head" style="margin-bottom:0">
            <div>
              <div class="m-sec-title">启用自动定时监控</div>
              <div class="m-sec-sub">开启后将通过 Shy Cron 按设定时间自动触发 GitHub Actions 抓取新视频</div>
            </div>
            <label class="tog-switch"><input type="checkbox" id="cfgEnabled" checked><span class="tog-track"></span></label>
          </div>
        </div>

        <div class="m-section">
          <div class="m-sec-head">
            <div class="m-sec-title">定时运行计划（北京时间 UTC+8）</div>
            <span class="cron-badge" id="cronPreviewBadge">UTC Cron: 0 0,12 * * *</span>
          </div>
          <div class="form-grid">
            <div class="field">
              <label>调度模式</label>
              <select class="ctrl" id="cfgScheduleMode" onchange="onScheduleModeChange()">
                <option value="times">指定每天运行时间（北京时间）</option>
                <option value="every_12h">每 12 小时（08:00 / 20:00）</option>
                <option value="every_6h">每 6 小时运行一次</option>
                <option value="custom">自定义 5 位 UTC Cron 表达式</option>
              </select>
            </div>
            <div class="field" id="timesInputWrap">
              <label>添加每日运行时间点</label>
              <div class="inline-add-row">
                <input class="ctrl" id="newTimeInput" type="time" value="08:00">
                <button class="btn" type="button" onclick="addTimeSlot()">+ 添加</button>
              </div>
            </div>
            <div class="field hidden" id="customCronWrap">
              <label>UTC Cron（分 时 日 月 周）</label>
              <input class="ctrl" id="cfgCustomCron" type="text" placeholder="0 0,12 * * *" oninput="updateCronBadge()">
            </div>
          </div>
          <div class="chip-list" id="timeChipList"></div>
          <div id="cronSyncNote" style="font-size:12px;color:var(--muted);margin-top:10px"></div>
        </div>

        <div class="m-section">
          <div class="m-sec-head">
            <div class="m-sec-title">监控 UP 主列表（<span id="upCountSpan">0</span> 位）</div>
          </div>
          <div class="inline-add-row">
            <input class="ctrl" id="upAddInput" type="text" placeholder="输入 UP 主 UID 或主页链接（如 346563107 或 https://space.bilibili.com/346563107）" onkeydown="if(event.key==='Enter')addUpCreator()">
            <button class="btn btn-primary" type="button" id="upAddBtn" onclick="addUpCreator()">解析并添加</button>
          </div>
          <div class="chip-list" id="upChipList"></div>
        </div>

        <div class="m-section" style="margin-bottom:0">
          <div class="m-sec-head">
            <div class="m-sec-title">扫描策略</div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label>扫描时间窗口</label>
              <select class="ctrl" id="cfgWindowHours">
                <option value="24">最近 24 小时（1天）</option>
                <option value="48">最近 48 小时（2天）</option>
                <option value="72">最近 72 小时（3天）</option>
                <option value="168">最近 7 天</option>
              </select>
            </div>
            <div class="field">
              <label>单次每位 UP 主最多处理条数</label>
              <select class="ctrl" id="cfgMaxVideos">
                <option value="2">最多 2 支</option>
                <option value="3">最多 3 支</option>
                <option value="5">最多 5 支</option>
                <option value="10">最多 10 支</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div id="mTabEmail" class="hidden">
        <div class="m-section">
          <div class="m-sec-head" style="margin-bottom:10px">
            <div>
              <div class="m-sec-title">选择日报邮件视觉样式（开源 4 套主题）</div>
              <div class="m-sec-sub">所有目录条目与卡片标题均直接超链接跳转至 B 站原视频页</div>
            </div>
          </div>
          <div class="style-grid" id="emailStyleGrid">
            <div class="style-card" data-style="editorial" onclick="selectEmailStyle('editorial')">
              <div class="sc-thumb"><div style="height:20px;background:linear-gradient(135deg,#0f172a,#1e293b)"></div><div style="flex:1;background:#f8fafc;padding:4px 6px"><div style="height:4px;width:65%;background:#fb7299;border-radius:2px;margin-bottom:3px"></div><div style="height:3px;width:90%;background:#cbd5e1;border-radius:2px"></div></div></div>
              <div class="sc-name">编辑部日报</div>
              <div class="sc-desc">深色报头 · 卡片式目录与重点高亮</div>
            </div>
            <div class="style-card" data-style="minimal" onclick="selectEmailStyle('minimal')">
              <div class="sc-thumb"><div style="height:16px;background:#fff;border-bottom:2px solid #18181b"></div><div style="flex:1;background:#fff;padding:4px 6px"><div style="height:4px;width:55%;background:#18181b;border-radius:2px;margin-bottom:3px"></div><div style="height:3px;width:85%;background:#d4d4d8;border-radius:2px"></div></div></div>
              <div class="sc-name">极简纸刊</div>
              <div class="sc-desc">Notion 纯白排版 · 克制黑白高级感</div>
            </div>
            <div class="style-card" data-style="bilibili" onclick="selectEmailStyle('bilibili')">
              <div class="sc-thumb"><div style="height:20px;background:linear-gradient(135deg,#fb7299,#ff85a7)"></div><div style="flex:1;background:#fff5f7;padding:4px 6px"><div style="height:4px;width:70%;background:#fb7299;border-radius:2px;margin-bottom:3px"></div><div style="height:3px;width:85%;background:#fecdd3;border-radius:2px"></div></div></div>
              <div class="sc-name">B站元气粉</div>
              <div class="sc-desc">樱花粉渐变报头 · 轻快明朗</div>
            </div>
            <div class="style-card" data-style="compact" onclick="selectEmailStyle('compact')">
              <div class="sc-thumb"><div style="height:16px;background:#2563eb"></div><div style="flex:1;background:#f8fafc;padding:4px 6px"><div style="height:3px;width:95%;background:#94a3b8;margin-bottom:3px"></div><div style="height:3px;width:85%;background:#94a3b8;margin-bottom:3px"></div><div style="height:3px;width:70%;background:#94a3b8"></div></div></div>
              <div class="sc-name">极速速览</div>
              <div class="sc-desc">高密度列表 · 30 秒扫完所有更新</div>
            </div>
          </div>

          <div class="preview-box">
            <div class="preview-bar">
              <span>实时邮件效果预览（点击目录或标题可测试原视频超链接）</span>
              <span id="previewStyleName" style="font-weight:700;color:var(--brand-dark)">编辑部日报</span>
            </div>
            <div class="preview-stage" id="emailPreviewStage"></div>
          </div>
        </div>

        <div class="m-section" style="margin-bottom:0">
          <div class="form-grid">
            <div class="field">
              <label>合并发送策略</label>
              <div style="display:flex;align-items:center;justify-content:space-between;height:38px;padding:0 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface)">
                <span style="font-size:13px">多位 UP 主合并为一封日报</span>
                <label class="tog-switch"><input type="checkbox" id="cfgMergeEmails" checked><span class="tog-track"></span></label>
              </div>
            </div>
            <div class="field">
              <label>自定义日报接收邮箱（可选）</label>
              <input class="ctrl" id="cfgSmtpTo" type="email" placeholder="留空则发往系统默认邮箱">
            </div>
          </div>
        </div>
      </div>

      <div class="sb-toast" id="monitorToast"></div>
    </div>
    <div class="modal-foot">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" type="button" onclick="triggerMonitorNow()">立即巡检</button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" type="button" onclick="closeModal('monitorModal')">关闭</button>
        <button class="btn btn-brand" type="button" id="saveMonitorBtn" onclick="saveMonitorConfig()">保存并同步定时任务</button>
      </div>
    </div>
  </div>
</div>

<script>

// ── Authentic Day-Night Toggle Button Web Component (shiranzby/Day-night-toggle-button v5.0) ──
(function registerShiranThemeButton() {
  if (customElements.get('theme-button')) return;
  const cloudPositions = [[-20,10,50],[-10,-25,60],[20,-40,60],[50,-35,60],[75,-60,75],[110,-50,60]];
  const starPositions = [[11,39,15],[39,91,15],[26,19,10],[37,66,10],[21,75,6],[51,38,6]];
  const cloudsHtml = cloudPositions.map(p => '<div class="cs" style="--right:' + p[0] + 'em;--bottom:' + p[1] + 'em;width:' + p[2] + 'em;height:' + p[2] + 'em"></div>').join('');
  const starsHtml = starPositions.map(p => '<div class="sr" style="top:' + p[0] + 'em;left:' + p[1] + 'em;width:' + p[2] + 'em;height:' + p[2] + 'em;--half:' + (p[2]/2) + 'em"><div class="ss"></div><div class="ss"></div><div class="ss"></div><div class="ss"></div></div>').join('');

  const tpl = document.createElement('template');
  tpl.innerHTML =
    '<style>' +
      ':host{display:inline-grid;place-items:center;min-width:44px;min-height:34px;vertical-align:middle;line-height:0;border-radius:100px;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
      ':host(:focus-visible){outline:2px solid currentColor;outline-offset:4px}' +
      '*,*::before,*::after{box-sizing:border-box}' +
      '.wrap{position:relative;display:inline-block}' +
      '.ct{width:180em;height:70em;position:relative;overflow:hidden;border-radius:100em;background:rgba(70,133,192,1);box-shadow:inset 0 0 5em 3em rgba(0,0,0,.45);transition:background .7s cubic-bezier(0,.5,1,1)}' +
      '.mb{margin:7.5em 0 0 7.5em;width:55em;height:55em;position:relative;z-index:3;border-radius:50%;background:rgba(255,195,35,1);box-shadow:3em 3em 5em rgba(0,0,0,.5),inset -3em -5em 3em -3em rgba(0,0,0,.5),inset 4em 5em 2em -2em rgba(255,230,80,1);transition:transform 1s cubic-bezier(.56,1.35,.52,1),background 1s,box-shadow 1s}' +
      '.mo{position:absolute;background:rgba(150,160,180,1);box-shadow:inset 0 0 1em 1em rgba(0,0,0,.3);border-radius:50%;transition:opacity .5s;opacity:0}' +
      '.mo:nth-child(1){top:7.5em;left:25em;width:12.5em;height:12.5em}' +
      '.mo:nth-child(2){top:20em;left:7.5em;width:20em;height:20em}' +
      '.mo:nth-child(3){top:32.5em;left:32.5em;width:12.5em;height:12.5em}' +
      '.db{position:absolute;border-radius:50%;transition:transform 1s cubic-bezier(.56,1.35,.52,1)}' +
      '.db:nth-of-type(2){top:-20em;left:-20em;width:110em;height:110em;background:rgba(255,255,255,.2);z-index:-2}' +
      '.db:nth-of-type(3){top:-32.5em;left:-17.5em;width:135em;height:135em;background:rgba(255,255,255,.1);z-index:-3}' +
      '.db:nth-of-type(4){top:-45em;left:-15em;width:160em;height:160em;background:rgba(255,255,255,.05);z-index:-4}' +
      '.cl{transform:translateY(10em);z-index:-2}' +
      '.cll{position:absolute;right:0;bottom:25em;opacity:.5;z-index:-3}' +
      '.settled .cll{transform:translateY(10em)}' +
      '.cl,.cll{transition:transform 1s cubic-bezier(.56,1.35,.52,1)}' +
      '.cs{position:absolute;right:var(--right);bottom:var(--bottom);background:#fff;border-radius:50%;z-index:-1;transition:right 1s,bottom 1s}' +
      '.st{transform:translateY(-125em);opacity:0;z-index:-2;transition:transform 1s cubic-bezier(.56,1.35,.52,1),opacity 1s}' +
      '.sr{position:absolute;transition:top 1s,left 1s}' +
      '.ss{float:left;width:var(--half);height:var(--half);background-image:radial-gradient(circle var(--half) at left top,transparent var(--half),#fff)}' +
      '.ss:nth-child(2){background-image:radial-gradient(circle var(--half) at right top,transparent var(--half),#fff)}' +
      '.ss:nth-child(3){background-image:radial-gradient(circle var(--half) at left bottom,transparent var(--half),#fff)}' +
      '.ss:nth-child(4){background-image:radial-gradient(circle var(--half) at right bottom,transparent var(--half),#fff)}' +
      '.dark{background:rgba(25,30,50,1)}' +
      '.dark .mb{transform:translateX(110em);background:rgba(195,200,210,1);box-shadow:3em 3em 5em rgba(0,0,0,.5),inset -3em -5em 3em -3em rgba(0,0,0,.5),inset 4em 5em 2em -2em rgba(255,255,210,1)}' +
      '.dark .db:nth-of-type(2){transform:translateX(110em)}' +
      '.dark .db:nth-of-type(3){transform:translateX(80em)}' +
      '.dark .db:nth-of-type(4){transform:translateX(50em)}' +
      '.dark .cl,.dark .cll{transform:translateY(80em)}' +
      '.dark .mo{opacity:1}' +
      '.dark .st{transform:translateY(-62.5em);opacity:1}' +
      '@media(hover:hover) and (pointer:fine){' +
        '.hover:not(.dark) .mb,.hover:not(.dark) .db:nth-of-type(2){transform:translateX(10em)}' +
        '.hover:not(.dark) .db:nth-of-type(3){transform:translateX(7em)}' +
        '.hover:not(.dark) .db:nth-of-type(4){transform:translateX(4em)}' +
        '.hover:not(.dark) .cl .cs:nth-child(1){right:-24em;bottom:10em}' +
        '.hover:not(.dark) .cl .cs:nth-child(2){right:-12em;bottom:-27em}' +
        '.hover:not(.dark) .cl .cs:nth-child(3){right:17em;bottom:-43em}' +
        '.hover:not(.dark) .cl .cs:nth-child(4){right:46em;bottom:-39em}' +
        '.hover:not(.dark) .cl .cs:nth-child(5){right:70em;bottom:-65em}' +
        '.hover:not(.dark) .cl .cs:nth-child(6){right:109em;bottom:-54em}' +
        '.hover:not(.dark) .cll .cs:nth-child(1){right:-23em;bottom:10em}' +
        '.hover:not(.dark) .cll .cs:nth-child(2){right:-11em;bottom:-26em}' +
        '.hover:not(.dark) .cll .cs:nth-child(3){right:18em;bottom:-42em}' +
        '.hover:not(.dark) .cll .cs:nth-child(4){right:47em;bottom:-38em}' +
        '.hover:not(.dark) .cll .cs:nth-child(5){right:74em;bottom:-64em}' +
        '.hover:not(.dark) .cll .cs:nth-child(6){right:110em;bottom:-55em}' +
        '.hover.dark .mb,.hover.dark .db:nth-of-type(2){transform:translateX(100em)}' +
        '.hover.dark .db:nth-of-type(3){transform:translateX(73em)}' +
        '.hover.dark .db:nth-of-type(4){transform:translateX(46em)}' +
        '.hover.dark .sr:nth-child(1){top:10em!important;left:36em!important}' +
        '.hover.dark .sr:nth-child(2){top:40em!important;left:87em!important}' +
        '.hover.dark .sr:nth-child(3){top:26em!important;left:16em!important}' +
        '.hover.dark .sr:nth-child(4){top:38em!important;left:63em!important}' +
        '.hover.dark .sr:nth-child(5){top:20.5em!important;left:72em!important}' +
        '.hover.dark .sr:nth-child(6){top:51.5em!important;left:35em!important}' +
      '}' +
      '@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}' +
    '</style>' +
    '<div class="wrap" aria-hidden="true"><div class="ct"><div class="mb"><div class="mo"></div><div class="mo"></div><div class="mo"></div></div><div class="db"></div><div class="db"></div><div class="db"></div><div class="cl">' + cloudsHtml + '</div><div class="cll">' + cloudsHtml + '</div><div class="st">' + starsHtml + '</div></div></div>';

  class ThemeButton extends HTMLElement {
    static get observedAttributes() { return ['value', 'size', 'disabled']; }
    constructor() {
      super();
      const shadow = this.attachShadow({ mode: 'closed' });
      shadow.append(tpl.content.cloneNode(true));
      this._wrapper = shadow.querySelector('.wrap');
      this._scene = shadow.querySelector('.ct');
      this._hoverMedia = matchMedia('(hover:hover) and (pointer:fine)');
      this._lastToggle = -Infinity;
      this.addEventListener('click', ev => { if (!this.disabled) this._activate(ev); }, true);
      this.addEventListener('keydown', ev => {
        if (!['Enter', ' ', 'Spacebar'].includes(ev.key)) return;
        ev.preventDefault();
        if (!this.disabled && !ev.repeat) this._activate(ev);
      });
      shadow.querySelector('.mb').addEventListener('mousemove', () => {
        if (!this.disabled && this._hoverMedia.matches && performance.now() - this._lastToggle >= 500) this._scene.classList.add('hover');
      });
      shadow.querySelector('.mb').addEventListener('mouseleave', () => this._scene.classList.remove('hover'));
    }
    connectedCallback() {
      if (!this.hasAttribute('value')) this.value = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      this.setAttribute('role', 'switch');
      if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
      this._render();
    }
    attributeChangedCallback() { this._render(); }
    get value() { return this.getAttribute('value') === 'dark' ? 'dark' : 'light'; }
    set value(v) { this.setAttribute('value', v === 'dark' ? 'dark' : 'light'); }
    get size() { const n = Number(this.getAttribute('size')); return Number.isFinite(n) && n > 0 ? n : 1.1; }
    set size(v) { this.setAttribute('size', v); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { this.toggleAttribute('disabled', Boolean(v)); }
    _render() {
      this._wrapper.style.fontSize = (this.size / 3) + 'px';
      if (this._renderedTheme !== undefined && this._renderedTheme !== this.value) this._scene.classList.add('settled');
      this._renderedTheme = this.value;
      this._scene.classList.toggle('dark', this.value === 'dark');
      this._scene.classList.remove('hover');
      this.setAttribute('aria-checked', String(this.value === 'dark'));
    }
    _activate(source) {
      this._lastToggle = performance.now();
      this.value = this.value === 'dark' ? 'light' : 'dark';
      const rect = this.getBoundingClientRect();
      const pt = (source && source.type === 'click' && source.detail > 0 && Number.isFinite(source.clientX))
        ? { x: source.clientX, y: source.clientY }
        : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const ev = new CustomEvent('change', { detail: this.value, bubbles: true, composed: true });
      Object.defineProperty(ev, 'point', { value: pt, enumerable: true });
      this.dispatchEvent(ev);
    }
  }
  customElements.define('theme-button', ThemeButton);
})();

// ── Storage Keys & Constants ──
const LS_JOBS = 'bilisum_jobs_v3';
const LS_THEME = 'bilisum_theme_v3';
const LS_AUTH = 'bilisum_auth_token';
const LS_USER = 'bilisum_auth_user';
const LS_PREFS = 'bilisum_prefs_v1';
const LS_CHATS = 'bilisum_chats_v1';
const LS_LIBRARY = 'bilisum_library_v1';
const LS_RAIL_COLLAPSED = 'bilisum_rail_collapsed_v1';
const SS_FEED_CACHE = 'bilisum_up_feed_cache_v2';
const FEED_CACHE_TTL_MS = 10 * 60 * 1000;

const FOLDER_COLORS = ['#2563EB', '#D97706', '#7C3AED', '#059669', '#E11D48', '#0891B2', '#4F46E5', '#64748B'];
const DEFAULT_SUMMARY_FOLDERS = [
  { id: 'tech', name: '科技', color: '#2563EB' },
  { id: 'history', name: '历史', color: '#D97706' },
  { id: 'game', name: '游戏', color: '#7C3AED' },
  { id: 'software', name: '软件', color: '#059669' },
];
const DEFAULT_UP_FOLDERS = [
  { id: 'up_news', name: '国际时政', color: '#E11D48' },
  { id: 'up_tech', name: '数码科技', color: '#2563EB' },
  { id: 'up_know', name: '知识科普', color: '#059669' },
  { id: 'up_fun', name: '趣味娱乐', color: '#D97706' },
];
const DEFAULT_FAV_FOLDERS = [
  { id: 'fav_default', name: '默认收藏夹', color: '#FB7299' },
  { id: 'fav_deep', name: '深度干货', color: '#2563EB' },
];
let activeFolderScope = 'summary';
let folderMgrScope = 'summary';
let expandedFavFolders = new Set();
let favDeckOffsets = {};
let submitSelectedFolders = new Set();
let addUpSelectedFolders = new Set();
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

const SVG_SUN = '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const SVG_MOON = '<svg class="ic" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const SVG_CLOSE_SM = '<svg class="ic" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
const SVG_CHEV = '<svg class="ic c-select-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
const SVG_CHK = '<svg class="ic c-select-chk" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_CLOCK_SM = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>';
const SVG_STAR_LINE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const SVG_TAG_SM = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
const SVG_TRASH_SM = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

// ── Global App State ──
let authUser = '';
let currentRoute = 'summary'; // summary | monitor | watch-later | favorites | history | folder
let activeFolderId = '';
let folderViewTab = 'summaries';
let selectedJobId = null;
let selectedUpMid = 'all';
let selectedMonFolder = '';
let wlFilter = 'all';
let wlSelectedBvids = new Set();
let favType = 'all';
let favFolderFilter = '';
let histStatus = 'all';
let histFolderFilter = '';
let histBatchMode = false;
let histSelectedIds = new Set();
let submitModalTab = 'single';
let viewMode = 'summary';
let readerFontPx = 14;
let trMatchIndex = -1;
let modalSummaryRaw = '';
let pollTimers = {};
let toastTimer = null;
let selectedNewFolderColor = FOLDER_COLORS[0];
let librarySyncTimer = null;
let routeScrollPos = {};
let monitorPageBooted = false;
let lastRenderedFeedKey = '';
let lastRenderedFeedSig = '';
let currentFeedVideos = [];
let folderFeedVideos = [];
let feedPagination = { key: 'all', pn: 1, hasMore: false, loading: false, total: 0 };
let folderPagination = { key: '', pn: 1, hasMore: false, loading: false, total: 0 };
let feedObserver = null;
let folderObserver = null;
let prefetchDone = false;
const feedMemCache = new Map();

let monitorConfig = {
  enabled: true, schedule_mode: 'times', times_cst: ['08:00', '20:00'],
  cron_utc: '0 0,12 * * *', up_list: [], email_style: 'editorial',
  merge_emails: true, smtp_to: '', check_window_hours: 72, max_videos_per_run: 5,
};

let libraryState = loadLocalLibrary();

// ── Utility Functions ──
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
  if (days < 30) return Math.floor(days / 7) + '周前';
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

// ── Unified Authenticated Fetch (Cookie + Bearer Dual Persistence) ──
function getAuthToken() { return localStorage.getItem(LS_AUTH) || ''; }

async function apiFetch(url, options) {
  const opts = { credentials: 'same-origin', ...(options || {}) };
  const headers = { ...(opts.headers || {}) };
  const tok = getAuthToken();
  if (tok && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + tok;
  opts.headers = headers;
  const resp = await fetch(url, opts);
  if (resp.status === 401 && !url.startsWith('/api/auth/')) {
    handleAuthExpired();
  }
  return resp;
}

function handleAuthExpired() {
  localStorage.removeItem(LS_AUTH);
  localStorage.removeItem(LS_USER);
  authUser = '';
  monitorPageBooted = false;
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('authGate').classList.remove('hidden');
}

async function doGateLogin() {
  const username = document.getElementById('gateUser').value.trim();
  const password = document.getElementById('gatePass').value;
  const remember = document.getElementById('gateRemember').checked;
  const btn = document.getElementById('gateLoginBtn');
  if (!username || !password) { showToast('gateToast', '请输入账号与密码', 'err'); return; }
  btn.disabled = true; btn.textContent = '登录验证中...';
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, remember }),
    });
    const d = await r.json();
    if (!r.ok) { showToast('gateToast', d.error || '账号或密码错误', 'err'); return; }
    if (d.token) localStorage.setItem(LS_AUTH, d.token);
    localStorage.setItem(LS_USER, d.username || username);
    document.getElementById('gatePass').value = '';
    enterAuthenticatedApp(d.username || username);
    toast(remember ? '登录成功（本机已开启 90 天持久免重登）' : '登录成功');
  } catch (e) {
    showToast('gateToast', '网络错误：' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = '登录进入工作台';
  }
}

async function doLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
  localStorage.removeItem(LS_AUTH);
  localStorage.removeItem(LS_USER);
  authUser = '';
  monitorPageBooted = false;
  lastRenderedFeedKey = '';
  lastRenderedFeedSig = '';
  feedMemCache.clear();
  try { sessionStorage.removeItem(SS_FEED_CACHE); } catch {}
  toggleMobileNav(false);
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('authGate').classList.remove('hidden');
  toast('已安全退出当前设备');
}

function enterAuthenticatedApp(username) {
  authUser = username || 'shiran';
  document.getElementById('railUserName').textContent = authUser;
  document.getElementById('railUserAva').textContent = authUser.slice(0, 1).toUpperCase();
  document.getElementById('authGate').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');

  applyRailCollapsedState();
  renderRailFolders();
  updateNavBadges();
  syncFromR2();
  syncLibraryFromR2();
  loadMonitorConfigQuietly();
  handleHashRoute(true);
  requestAnimationFrame(() => {
    updateAllSliders(true);
    moveRailNavSlider(true);
  });
}

async function bootstrapAuth() {
  const cachedUser = localStorage.getItem(LS_USER) || '';
  const cachedTok = getAuthToken();
  if (cachedUser && cachedTok) {
    // Optimistic zero-flicker enter on trusted device, verified/renewed silently right away
    enterAuthenticatedApp(cachedUser);
  }
  try {
    const r = await apiFetch('/api/auth/me');
    const d = await r.json();
    if (d && d.authenticated) {
      if (d.token) localStorage.setItem(LS_AUTH, d.token);
      localStorage.setItem(LS_USER, d.username || 'shiran');
      if (!authUser) enterAuthenticatedApp(d.username || 'shiran');
    } else {
      handleAuthExpired();
      setTimeout(() => { const p = document.getElementById('gatePass'); if (p) p.focus(); }, 60);
    }
  } catch {
    if (!authUser) document.getElementById('authGate').classList.remove('hidden');
  }
}

// ── Day-Night Theme Controller (View-Transition Radial Wave) + Brand Toggle ──
let activeThemeVt = null;
function applyThemeDom(val) {
  document.documentElement.setAttribute('data-theme', val);
  document.documentElement.style.colorScheme = val;
  document.querySelectorAll('theme-button').forEach(b => b.setAttribute('value', val));
}
function setSiteTheme(next, point) {
  const val = next === 'dark' ? 'dark' : 'light';
  localStorage.setItem(LS_THEME, val);
  document.querySelectorAll('theme-button').forEach(b => b.setAttribute('value', val));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !document.startViewTransition) { applyThemeDom(val); return; }
  if (activeThemeVt) { try { activeThemeVt.skipTransition(); } catch {} activeThemeVt = null; }
  const root = document.documentElement;
  const W = root.clientWidth || window.innerWidth, H = root.clientHeight || window.innerHeight;
  const ox = point && Number.isFinite(point.x) ? point.x : W - 90;
  const oy = point && Number.isFinite(point.y) ? point.y : 28;
  const rad = Math.hypot(Math.max(ox, W - ox), Math.max(oy, H - oy)) || 1;
  root.setAttribute('data-shiran-vt', '');
  try {
    const vt = document.startViewTransition(() => { applyThemeDom(val); });
    activeThemeVt = vt;
    vt.ready.then(() => {
      if (activeThemeVt !== vt) return;
      root.animate(
        { clipPath: ['circle(0px at ' + ox + 'px ' + oy + 'px)', 'circle(' + rad + 'px at ' + ox + 'px ' + oy + 'px)'] },
        { duration: 1100, easing: 'cubic-bezier(0.4,0,0.5,1)', fill: 'forwards', pseudoElement: '::view-transition-new(root)' }
      );
    }).catch(() => { applyThemeDom(val); root.removeAttribute('data-shiran-vt'); });
    vt.finished.finally(() => { if (activeThemeVt === vt) { activeThemeVt = null; root.removeAttribute('data-shiran-vt'); } });
  } catch {
    applyThemeDom(val); root.removeAttribute('data-shiran-vt');
  }
}
function initTheme() {
  const saved = localStorage.getItem(LS_THEME) || 'light';
  applyThemeDom(saved);
  document.querySelectorAll('theme-button').forEach(btn => {
    btn.addEventListener('change', ev => {
      if (ev.detail === 'dark' || ev.detail === 'light') setSiteTheme(ev.detail, ev.point || null);
    });
  });
}

function applyRailCollapsedState() {
  const collapsed = localStorage.getItem(LS_RAIL_COLLAPSED) === '1';
  document.getElementById('appShell').classList.toggle('rail-collapsed', collapsed);
}
function toggleRailCollapsed() {
  const shell = document.getElementById('appShell');
  const next = !shell.classList.contains('rail-collapsed');
  shell.classList.toggle('rail-collapsed', next);
  localStorage.setItem(LS_RAIL_COLLAPSED, next ? '1' : '0');
  setTimeout(() => { updateAllSliders(true); moveRailNavSlider(true); }, 260);
}
function onBrandClick() {
  if (window.innerWidth <= 768) { toggleMobileNav(false); return; }
  toggleRailCollapsed();
}
function toggleMobileNav(forceState) {
  const shell = document.getElementById('appShell');
  const bd = document.getElementById('mobileBackdrop');
  const next = typeof forceState === 'boolean' ? forceState : !shell.classList.contains('mobile-nav-open');
  shell.classList.toggle('mobile-nav-open', next);
  bd.classList.toggle('show', next);
}

// ── Spring Sliding Pill Engine (Horizontal + Vertical Rail) ──
const SLIDER_IDS = ['segTabs', 'wlFilterTabs', 'histStatusTabs', 'folderViewTabs', 'submitModeTabs', 'monitorTabs', 'folderMgrTabs'];

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

function moveRailNavSlider(instant) {
  const nav = document.getElementById('railNav');
  const slider = document.getElementById('railNavSlider');
  if (!nav || !slider) return;
  const active = nav.querySelector('.rail-item.active');
  if (!active) { slider.classList.add('off'); return; }
  slider.classList.remove('off');
  const navRect = nav.getBoundingClientRect();
  const actRect = active.getBoundingClientRect();
  if (actRect.height === 0) return;
  const y = Math.round((actRect.top - navRect.top) * 10) / 10;
  const h = Math.round(actRect.height * 10) / 10;
  if (instant || !slider.dataset.ready) {
    slider.style.transition = 'none';
    slider.style.height = h + 'px';
    slider.style.transform = 'translateY(' + y + 'px)';
    void slider.offsetWidth;
    slider.style.transition = '';
    slider.dataset.ready = '1';
  } else {
    slider.style.height = h + 'px';
    slider.style.transform = 'translateY(' + y + 'px)';
  }
}

function updateAllSliders(instant) { SLIDER_IDS.forEach(id => moveSlider(id, instant)); }

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
  SLIDER_IDS.forEach(id => { const el = document.getElementById(id); if (el) ro.observe(el); });
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
    btn.type = 'button'; btn.className = 'c-select-btn';
    btn.innerHTML = '<span class="c-select-label"></span>' + SVG_CHEV;
    const menu = document.createElement('div');
    menu.className = 'c-select-menu';
    Array.from(sel.options).forEach(opt => {
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'c-select-opt'; item.dataset.val = opt.value;
      item.innerHTML = '<span>' + esc(opt.textContent) + '</span>' + SVG_CHK;
      item.addEventListener('click', (e) => {
        e.stopPropagation(); sel.value = opt.value; syncCustomSelect(sel);
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
        wrap.classList.toggle('drop-up', (window.innerHeight - rect.bottom) < 220 && rect.top > 220);
        wrap.classList.add('open');
      } else wrap.classList.remove('open', 'drop-up');
    });
    wrap.appendChild(btn); wrap.appendChild(menu);
    sel._csWrap = wrap;
    syncCustomSelect(sel);
  });
}
document.addEventListener('click', () => closeAllCustomSelects());

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// Global Ctrl+K / Cmd+K & Escape shortcut
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && authUser) {
    e.preventDefault(); openSubmitModal('single');
  } else if (e.key === 'Escape') {
    closeTagPopover();
    ['submitModal', 'addMonitorModal', 'tagManagerModal', 'summaryModal', 'settingsModal', 'monitorModal'].forEach(closeModal);
    toggleMobileNav(false);
  }
});

// ── 3-Scope Library State (摘要分类 / UP主分类 / 收藏文件夹 + Watch Later + Favorites) ──
function normLocalLib(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const sf = Array.isArray(src.summary_folders) && src.summary_folders.length ? src.summary_folders : (Array.isArray(src.folders) && src.folders.length ? src.folders : DEFAULT_SUMMARY_FOLDERS.map(f => ({ ...f })));
  const uf = Array.isArray(src.up_folders) && src.up_folders.length ? src.up_folders : DEFAULT_UP_FOLDERS.map(f => ({ ...f }));
  const ff = Array.isArray(src.fav_folders) && src.fav_folders.length ? src.fav_folders : DEFAULT_FAV_FOLDERS.map(f => ({ ...f }));
  return {
    folders: sf,
    summary_folders: sf,
    up_folders: uf,
    fav_folders: ff,
    job_tags: src.job_tags && typeof src.job_tags === 'object' ? src.job_tags : {},
    up_tags: src.up_tags && typeof src.up_tags === 'object' ? src.up_tags : {},
    fav_folder_map: src.fav_folder_map && typeof src.fav_folder_map === 'object' ? src.fav_folder_map : {},
    watch_later: Array.isArray(src.watch_later) ? src.watch_later : [],
    favorites: Array.isArray(src.favorites) ? src.favorites : [],
  };
}
function loadLocalLibrary() {
  try { return normLocalLib(JSON.parse(localStorage.getItem(LS_LIBRARY) || 'null')); }
  catch { return normLocalLib(null); }
}
function getScopeFolders(scope) {
  if (scope === 'up') return libraryState.up_folders || [];
  if (scope === 'fav') return libraryState.fav_folders || [];
  return libraryState.summary_folders || [];
}
function setScopeFolders(scope, arr) {
  if (scope === 'up') libraryState.up_folders = arr;
  else if (scope === 'fav') libraryState.fav_folders = arr;
  else { libraryState.summary_folders = arr; libraryState.folders = arr; }
}
function getFolderById(id, scope) {
  if (scope) return getScopeFolders(scope).find(f => f.id === id) || null;
  return (libraryState.summary_folders || []).find(f => f.id === id)
    || (libraryState.up_folders || []).find(f => f.id === id)
    || (libraryState.fav_folders || []).find(f => f.id === id) || null;
}

function saveLibraryLocalAndCloud() {
  libraryState.folders = libraryState.summary_folders;
  try { localStorage.setItem(LS_LIBRARY, JSON.stringify(libraryState)); } catch {}
  updateNavBadges();
  renderRailFolders();
  const hint = document.getElementById('librarySyncHint');
  if (hint) hint.textContent = '正在同步至云端 R2...';
  clearTimeout(librarySyncTimer);
  librarySyncTimer = setTimeout(async () => {
    try {
      const r = await apiFetch('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ library: libraryState }),
      });
      if (hint) hint.textContent = r.ok ? '已同步至 Cloudflare R2' : '本地已保存（云端稍后重试）';
    } catch { if (hint) hint.textContent = '本地已保存'; }
  }, 450);
}

async function syncLibraryFromR2() {
  try {
    const r = await apiFetch('/api/library');
    if (!r.ok) return;
    const d = await r.json();
    if (!d || !d.library) return;
    const remote = normLocalLib(d.library);
    const localHas = Boolean(localStorage.getItem(LS_LIBRARY));
    if (!localHas) {
      libraryState = remote;
    } else {
      const mergeF = (a, b) => { const m = new Map(); (a || []).forEach(f => m.set(f.id, f)); (b || []).forEach(f => m.set(f.id, f)); return Array.from(m.values()); };
      libraryState.summary_folders = mergeF(remote.summary_folders, libraryState.summary_folders);
      libraryState.folders = libraryState.summary_folders;
      libraryState.up_folders = mergeF(remote.up_folders, libraryState.up_folders);
      libraryState.fav_folders = mergeF(remote.fav_folders, libraryState.fav_folders);
      libraryState.job_tags = { ...remote.job_tags, ...libraryState.job_tags };
      libraryState.up_tags = { ...remote.up_tags, ...libraryState.up_tags };
      libraryState.fav_folder_map = { ...remote.fav_folder_map, ...libraryState.fav_folder_map };
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
    refreshAllLibraryViews();
  } catch {}
}

function jobTagKey(job) { return String((job && (job.bvid || job.id)) || ''); }
function getJobTagIds(job) {
  const k = jobTagKey(job);
  if (!k) return [];
  const valid = new Set((libraryState.summary_folders || []).map(f => f.id));
  return (libraryState.job_tags[k] || []).filter(id => valid.has(id));
}
function getUpTagIds(mid) {
  const k = String(mid || '');
  if (!k) return [];
  const valid = new Set((libraryState.up_folders || []).map(f => f.id));
  return (libraryState.up_tags[k] || []).filter(id => valid.has(id));
}
function getFavFolderIds(bvid) {
  const folders = libraryState.fav_folders || [];
  if (!folders.length) return [];
  const valid = new Set(folders.map(f => f.id));
  const assigned = (libraryState.fav_folder_map[bvid] || []).filter(id => valid.has(id));
  return assigned.length ? assigned : [folders[0].id];
}
function isWatchLater(bvid) { return Boolean(bvid && (libraryState.watch_later || []).some(v => v.bvid === bvid)); }
function isFavBvid(bvid) { return Boolean(bvid && (libraryState.favorites || []).some(v => v.bvid === bvid)); }
function isJobFavorited(job) { return Boolean(job && (job.starred || isFavBvid(job.bvid))); }

function refreshAllLibraryViews() {
  updateNavBadges();
  renderRailFolders();
  if (selectedJobId) {
    const cur = getJobs().find(j => j.id === selectedJobId);
    if (cur) { updateStarBtn(cur); updateWatchLaterBtn(cur); renderDetailTagBar(cur); }
  }
  if (currentRoute === 'monitor') { renderMonitorFolderBar(); renderUpSidebar(); }
  if (currentRoute === 'watch-later') renderWatchLaterPage();
  if (currentRoute === 'favorites') renderFavoritesPage();
  if (currentRoute === 'history') renderHistoryPage();
  if (currentRoute === 'folder' && activeFolderId) renderFolderPage(activeFolderId, false);
}

// ── Jobs Storage & R2 Sync ──
function getJobs() {
  try { return JSON.parse(localStorage.getItem(LS_JOBS) || '[]').map(j => ({ ...j, status: normStatus(j.status) })); }
  catch { return []; }
}
function saveJobs(jobs, skipSync) {
  localStorage.setItem(LS_JOBS, JSON.stringify(jobs));
  updateNavBadges();
  renderRailFolders();
  renderRecentStrip();
  if (currentRoute === 'history') renderHistoryPage();
  if (currentRoute === 'favorites') renderFavoritesPage();
  if (currentRoute === 'watch-later') renderWatchLaterPage();
  if (currentRoute === 'folder' && activeFolderId) renderFolderSummaries(activeFolderId);
  if (!skipSync && authUser) {
    apiFetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobs: jobs.slice(0, 100) }) }).catch(() => {});
  }
}

async function syncFromR2() {
  try {
    const r = await apiFetch('/api/history');
    if (!r.ok) return;
    const remote = await r.json();
    if (!Array.isArray(remote)) return;
    const local = getJobs();
    const map = new Map();
    for (const j of remote) if (j && j.id) map.set(j.id, { ...j, status: normStatus(j.status) });
    for (const j of local) {
      if (!j || !j.id) continue;
      const ex = map.get(j.id);
      if (!ex) map.set(j.id, j);
      else map.set(j.id, { ...ex, ...j, summary: ex.summary || j.summary, transcript: ex.transcript || j.transcript, starred: Boolean(j.starred || ex.starred) });
    }
    const merged = Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    saveJobs(merged, true);
    if (!selectedJobId && merged.length > 0) selectJob(merged[0].id, false);
    else if (selectedJobId) {
      const cur = merged.find(j => j.id === selectedJobId);
      if (cur) renderDetail(cur);
    }
    merged.forEach(j => { if (normStatus(j.status) === 'pending') startPolling(j.id); });
  } catch {}
}

// ── Navigation & Keep-Alive Hash Router (Zero Flicker) ──
const ROUTE_TITLES = {
  'summary': '摘要工作台',
  'monitor': '监控 UP 主',
  'watch-later': '稍后再看',
  'favorites': '我的收藏',
  'history': '历史记录',
  'folder': '标签文件夹',
};

function navigate(route, param) {
  closeTagPopover();
  toggleMobileNav(false);
  const newHash = param ? ('#/' + route + '/' + encodeURIComponent(param)) : ('#/' + route);
  if (window.location.hash !== newHash) {
    window.location.hash = newHash;
  } else {
    activateRoute(route, param);
  }
}

function handleHashRoute(isInit) {
  const raw = (window.location.hash || '').replace(/^#\/?/, '');
  if (!raw) { activateRoute('summary', selectedJobId || '', isInit); return; }
  const parts = raw.split('/');
  const r = parts[0];
  if (r === 'folder') {
    const scope = (parts[1] === 'up' || parts[1] === 'summary') ? parts[1] : 'summary';
    const fid = parts[2] ? decodeURIComponent(parts[2]) : (parts[1] && parts[1] !== 'up' && parts[1] !== 'summary' ? decodeURIComponent(parts[1]) : '');
    activeFolderScope = scope;
    activateRoute('folder', fid, isInit);
    return;
  }
  const param = parts[1] ? decodeURIComponent(parts[1]) : '';
  if (['summary', 'monitor', 'watch-later', 'favorites', 'history'].includes(r)) {
    activateRoute(r, param, isInit);
  } else {
    activateRoute('summary', '', isInit);
  }
}
function navigateFolder(scope, fid) {
  closeTagPopover();
  toggleMobileNav(false);
  activeFolderScope = scope === 'up' ? 'up' : 'summary';
  const h = '#/folder/' + activeFolderScope + '/' + encodeURIComponent(fid);
  if (window.location.hash !== h) window.location.hash = h;
  else activateRoute('folder', fid, false);
}
window.addEventListener('hashchange', () => { if (authUser) handleHashRoute(false); });

function getRouteScrollEl(route) {
  if (route === 'monitor') return document.getElementById('monScrollArea');
  return document.getElementById('view-' + route);
}

async function activateRoute(route, param, isInit) {
  const prevEl = getRouteScrollEl(currentRoute);
  if (prevEl) routeScrollPos[currentRoute] = prevEl.scrollTop;

  currentRoute = route;
  if (route === 'folder') activeFolderId = param || ((libraryState.folders[0] && libraryState.folders[0].id) || '');

  // Keep-Alive DOM visibility toggle (ZERO DOM rebuild, ZERO opacity flash!)
  ['summary', 'monitor', 'watch-later', 'favorites', 'history', 'folder'].forEach(r => {
    const el = document.getElementById('view-' + r);
    if (el) el.classList.toggle('hidden', r !== route);
  });

  // Update Rail active states + vertical spring slider
  document.querySelectorAll('#railNav .rail-item').forEach(b => b.classList.toggle('active', b.dataset.route === route));
  document.querySelectorAll('#railSummaryFolderList .folder-nav-item').forEach(b => b.classList.toggle('active', route === 'folder' && activeFolderScope === 'summary' && b.dataset.fid === activeFolderId));
  document.querySelectorAll('#railUpFolderList .folder-nav-item').forEach(b => b.classList.toggle('active', route === 'folder' && activeFolderScope === 'up' && b.dataset.fid === activeFolderId));
  moveRailNavSlider(Boolean(isInit));

  document.getElementById('topbarTitle').textContent = ROUTE_TITLES[route] || '摘要工作台';
  document.getElementById('topbarSub').textContent = '';

  const nextEl = getRouteScrollEl(route);
  if (nextEl && routeScrollPos[route] !== undefined) nextEl.scrollTop = routeScrollPos[route];

  if (route === 'summary') {
    if (param) {
      const found = getJobs().find(j => j.id === param || j.bvid === param);
      if (found) selectedJobId = found.id;
    } else if (!selectedJobId) {
      const jobs = getJobs();
      if (jobs.length) selectedJobId = jobs[0].id;
    }
    renderRecentStrip();
    const curJob = getJobs().find(j => j.id === selectedJobId);
    if (curJob) {
      document.getElementById('summaryEmptyState').classList.add('hidden');
      document.getElementById('detailView').classList.remove('hidden');
      renderDetail(curJob);
    } else {
      document.getElementById('summaryEmptyState').classList.remove('hidden');
      document.getElementById('detailView').classList.add('hidden');
    }
    requestAnimationFrame(() => moveSlider('segTabs', true));
  } else if (route === 'monitor') {
    await loadMonitorPage();
  } else if (route === 'watch-later') {
    renderWatchLaterPage();
    requestAnimationFrame(() => moveSlider('wlFilterTabs', true));
  } else if (route === 'favorites') {
    renderFavoritesPage();
  } else if (route === 'history') {
    renderHistoryPage();
    requestAnimationFrame(() => moveSlider('histStatusTabs', true));
  } else if (route === 'folder') {
    renderFolderPage(activeFolderId, true);
    requestAnimationFrame(() => moveSlider('folderViewTabs', true));
  }
}

function updateNavBadges() {
  const jobs = getJobs();
  const ups = monitorConfig.up_list || [];
  const wlCnt = (libraryState.watch_later || []).length;
  const favBvids = new Set((libraryState.favorites || []).map(v => v.bvid));
  jobs.forEach(j => { if (j.starred && j.bvid) favBvids.add(j.bvid); });

  const setText = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = String(n); };
  setText('navCntMonitor', ups.length);
  setText('navCntWl', wlCnt);
  setText('navCntFav', favBvids.size);
  setText('navCntHist', jobs.length);
}

function renderRailFolders() {
  const sumBox = document.getElementById('railSummaryFolderList');
  const upBox = document.getElementById('railUpFolderList');
  const jobs = getJobs();
  const ups = monitorConfig.up_list || [];
  if (sumBox) {
    sumBox.innerHTML = (libraryState.summary_folders || []).map(f => {
      const cnt = jobs.filter(j => getJobTagIds(j).includes(f.id)).length;
      const active = currentRoute === 'folder' && activeFolderScope === 'summary' && activeFolderId === f.id ? ' active' : '';
      return '<button class="folder-nav-item' + active + '" data-fid="' + esc(f.id) + '" data-tip="摘要 · ' + esc(f.name) + (cnt ? (' (' + cnt + ')') : '') + '" onclick="navigateFolder(\'summary\',\'' + esc(f.id) + '\')">' +
        '<span class="folder-dot" style="background:' + esc(f.color) + '"></span>' +
        '<span class="rail-label">' + esc(f.name) + '</span>' +
        (cnt ? '<span class="rail-badge">' + cnt + '</span>' : '') +
      '</button>';
    }).join('');
  }
  if (upBox) {
    upBox.innerHTML = (libraryState.up_folders || []).map(f => {
      const cnt = ups.filter(u => getUpTagIds(u.mid).includes(f.id)).length;
      const active = currentRoute === 'folder' && activeFolderScope === 'up' && activeFolderId === f.id ? ' active' : '';
      return '<button class="folder-nav-item' + active + '" data-fid="' + esc(f.id) + '" data-tip="UP · ' + esc(f.name) + (cnt ? (' (' + cnt + ')') : '') + '" onclick="navigateFolder(\'up\',\'' + esc(f.id) + '\')">' +
        '<span class="folder-dot" style="background:' + esc(f.color) + '"></span>' +
        '<span class="rail-label">' + esc(f.name) + '</span>' +
        (cnt ? '<span class="rail-badge">' + cnt + '</span>' : '') +
      '</button>';
    }).join('');
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
  closeModal('settingsModal');
  toast('偏好设置已保存');
}
function clearLocalCaches() { clearFeedCache(); toast('已清空 UP 主动态封面缓存'); }

// ── Submit Modal (Single & Batch, Ctrl+K) ──
function renderSubmitFolderPicker() {
  const box = document.getElementById('submitFolderPicker');
  if (!box) return;
  box.innerHTML = (libraryState.summary_folders || []).map(f => {
    const sel = submitSelectedFolders.has(f.id) ? ' selected' : '';
    return '<button type="button" class="pick-chip' + sel + '" onclick="toggleSubmitFolderPick(\'' + esc(f.id) + '\')"><span class="folder-dot" style="width:7px;height:7px;background:' + esc(f.color) + '"></span><span>' + esc(f.name) + '</span></button>';
  }).join('');
}
function toggleSubmitFolderPick(fid) {
  if (submitSelectedFolders.has(fid)) submitSelectedFolders.delete(fid); else submitSelectedFolders.add(fid);
  renderSubmitFolderPicker();
}
function openSubmitModal(tab) {
  submitSelectedFolders.clear();
  renderSubmitFolderPicker();
  openModal('submitModal');
  switchSubmitTab(tab || 'single', true);
  setTimeout(() => {
    const el = document.getElementById(submitModalTab === 'batch' ? 'batchUrlsInput' : 'modalVideoUrl');
    if (el) el.focus();
  }, 60);
}
function renderAddUpFolderPicker() {
  const box = document.getElementById('addUpFolderPicker');
  if (!box) return;
  box.innerHTML = (libraryState.up_folders || []).map(f => {
    const sel = addUpSelectedFolders.has(f.id) ? ' selected' : '';
    return '<button type="button" class="pick-chip' + sel + '" onclick="toggleAddUpFolderPick(\'' + esc(f.id) + '\')"><span class="folder-dot" style="width:7px;height:7px;background:' + esc(f.color) + '"></span><span>' + esc(f.name) + '</span></button>';
  }).join('');
}
function toggleAddUpFolderPick(fid) {
  if (addUpSelectedFolders.has(fid)) addUpSelectedFolders.delete(fid); else addUpSelectedFolders.add(fid);
  renderAddUpFolderPicker();
}
function openAddMonitorModal() {
  addUpSelectedFolders.clear();
  renderAddUpFolderPicker();
  document.getElementById('modalAddUpInput').value = '';
  document.getElementById('modalAddUpToast').className = 'sb-toast';
  openModal('addMonitorModal');
  setTimeout(() => document.getElementById('modalAddUpInput').focus(), 60);
}
async function submitModalAddUp() {
  const inp = document.getElementById('modalAddUpInput'), q = inp.value.trim();
  if (!q) { showToast('modalAddUpToast', '请输入 UP 主 UID 或主页链接', 'err'); return; }
  const btn = document.getElementById('modalAddUpBtn'); btn.disabled = true; btn.textContent = '解析中...';
  try {
    const r = await apiFetch('/api/up-lookup?q=' + encodeURIComponent(q));
    const d = await r.json();
    if (!r.ok) { showToast('modalAddUpToast', d.error || '解析失败', 'err'); return; }
    if (!monitorConfig.up_list) monitorConfig.up_list = [];
    if (!monitorConfig.up_list.some(x => Number(x.mid) === Number(d.mid))) {
      monitorConfig.up_list.push({ mid: Number(d.mid), name: d.name || String(d.mid), face: d.face || '' });
      const sr = await apiFetch('/api/monitor-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(monitorConfig) });
      const sd = await sr.json();
      if (sr.ok && sd.config) monitorConfig = sd.config;
    }
    if (addUpSelectedFolders.size) {
      const k = String(d.mid);
      libraryState.up_tags[k] = [...new Set([...(libraryState.up_tags[k] || []), ...Array.from(addUpSelectedFolders)])];
      saveLibraryLocalAndCloud();
    }
    clearFeedCache('all');
    updateNavBadges(); renderRailFolders();
    if (currentRoute === 'monitor') { updateMonitorHeaderSummary(); renderMonitorFolderBar(); renderUpSidebar(); }
    closeModal('addMonitorModal');
    toast('已新增监控 UP 主：' + (d.name || d.mid));
  } catch (e) { showToast('modalAddUpToast', '添加异常：' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '解析并添加监控'; }
}
function switchSubmitTab(tab, instant) {
  submitModalTab = tab;
  document.querySelectorAll('#submitModeTabs .seg-tab').forEach(b => b.classList.toggle('active', b.dataset.sm === tab));
  requestAnimationFrame(() => moveSlider('submitModeTabs', Boolean(instant)));
  document.getElementById('submitSinglePane').classList.toggle('hidden', tab !== 'single');
  document.getElementById('submitBatchPane').classList.toggle('hidden', tab !== 'batch');
  document.getElementById('modalSubmitBtn').textContent = tab === 'batch' ? '加入处理队列' : '开始总结';
}
function onTplPreset() {
  document.getElementById('customTplWrap').classList.toggle('hidden', document.getElementById('tplPreset').value !== 'custom');
}
function handleModalSubmit() {
  if (submitModalTab === 'batch') submitBatchVideos();
  else submitModalSingle();
}
async function submitModalSingle() {
  const inp = document.getElementById('modalVideoUrl');
  const raw = inp.value.trim();
  if (!raw) { toast('请输入 B 站视频链接或 BV 号', true); return; }
  const res = await submitVideo(raw);
  if (res) { inp.value = ''; closeModal('submitModal'); }
}
async function submitInlineVideo() {
  const inp = document.getElementById('inlineVideoUrl');
  const raw = inp.value.trim();
  if (!raw) { toast('请输入 B 站视频链接或 BV 号', true); return; }
  const res = await submitVideo(raw);
  if (res) inp.value = '';
}

async function submitVideo(overrideUrl, meta, stayOnPage) {
  const raw = String(overrideUrl || '').trim();
  if (!raw) { toast('请输入 B 站视频链接或 BV 号', true); return null; }
  const prefs = getUserPrefs();
  const preset = document.getElementById('tplPreset').value;
  let tpl = '';
  if (preset === 'custom') tpl = document.getElementById('customTpl').value.trim();
  else if (TPL_PRESETS[preset]) tpl = TPL_PRESETS[preset];

  const email = document.getElementById('customEmail').value.trim() || prefs.default_email || '';
  const email_style = document.getElementById('singleEmailStyle').value || prefs.default_email_style || 'editorial';
  const send_email = prefs.send_email_on_single !== false;

  const btn = document.getElementById('modalSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = '解析中...'; }

  try {
    const reqBody = { url: raw, summary_template: tpl, email, email_style, send_email };
    if (meta && meta.title) reqBody.title = meta.title;
    if (meta && meta.owner) reqBody.owner = meta.owner;
    if (meta && meta.duration) reqBody.duration = meta.duration;

    const resp = await apiFetch('/api/submit', {
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
      pic: data.pic || (meta && meta.pic) || '',
      status: 'pending',
      created_at: new Date().toISOString(),
      video_url: 'https://www.bilibili.com/video/' + data.bvid,
    };
    if (submitSelectedFolders.size && newJob.bvid) {
      libraryState.job_tags[newJob.bvid] = [...new Set([...(libraryState.job_tags[newJob.bvid] || []), ...Array.from(submitSelectedFolders)])];
      saveLibraryLocalAndCloud();
    }
    const jobs = [newJob, ...getJobs().filter(j => j.id !== newJob.id)];
    saveJobs(jobs);
    if (!stayOnPage) {
      toast(send_email ? '已加入队列（完成后同步发邮件）' : '已加入队列（已关闭单条邮件通知）');
      selectJob(newJob.id, true);
    }
    startPolling(newJob.id);
    return newJob;
  } catch (e) {
    toast('网络错误: ' + e.message, true);
    return null;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = submitModalTab === 'batch' ? '加入处理队列' : '开始总结'; }
  }
}

async function submitBatchVideos() {
  const lines = (document.getElementById('batchUrlsInput').value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 5);
  if (!lines.length) { toast('请至少输入一条视频链接或 BV 号', true); return; }
  let okCount = 0;
  let lastJob = null;
  for (const line of lines) {
    const res = await submitVideo(line, null, true);
    if (res) { okCount++; lastJob = res; }
  }
  document.getElementById('batchUrlsInput').value = '';
  closeModal('submitModal');
  toast('已成功提交 ' + okCount + ' 条视频至后台队列');
  if (lastJob) selectJob(lastJob.id, true);
}

function startPolling(jobId) {
  if (pollTimers[jobId]) clearInterval(pollTimers[jobId]);
  let ticks = 0;
  pollTimers[jobId] = setInterval(async () => {
    ticks++;
    if (ticks > 90) { clearInterval(pollTimers[jobId]); delete pollTimers[jobId]; return; }
    try {
      const r = await apiFetch('/api/jobs/' + encodeURIComponent(jobId));
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
        if (selectedJobId === jobId && currentRoute === 'summary') renderDetail(jobs[idx]);
        if (finished) { clearInterval(pollTimers[jobId]); delete pollTimers[jobId]; }
      }
    } catch {}
  }, 4000);
}

// ── Tag Folders, Watch Later & Favorites Mutations ──
function toggleWatchLaterVideo(videoObj) {
  if (!videoObj || !videoObj.bvid) return false;
  const list = libraryState.watch_later || [];
  const idx = list.findIndex(v => v.bvid === videoObj.bvid);
  let added = false;
  if (idx >= 0) list.splice(idx, 1);
  else {
    list.unshift({
      bvid: videoObj.bvid, job_id: videoObj.job_id || '', mid: Number(videoObj.mid) || 0,
      title: videoObj.title || videoObj.bvid, author: videoObj.author || videoObj.owner || '',
      face: videoObj.face || '', pic: videoObj.pic || '', duration: videoObj.duration || '',
      play: Number(videoObj.play) || 0, danmaku: Number(videoObj.danmaku) || 0,
      created: Number(videoObj.created) || 0,
      url: videoObj.url || ('https://www.bilibili.com/video/' + videoObj.bvid),
      added_at: new Date().toISOString(),
    });
    added = true;
  }
  libraryState.watch_later = list;
  saveLibraryLocalAndCloud();
  syncFeedCardQuickStates(videoObj.bvid);
  refreshAllLibraryViews();
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
      bvid: videoObj.bvid, job_id: (jobIdx >= 0 ? jobs[jobIdx].id : '') || videoObj.job_id || '',
      mid: Number(videoObj.mid) || 0, title: videoObj.title || videoObj.bvid,
      author: videoObj.author || videoObj.owner || '', face: videoObj.face || '',
      pic: videoObj.pic || '', duration: videoObj.duration || '',
      play: Number(videoObj.play) || 0, danmaku: Number(videoObj.danmaku) || 0,
      created: Number(videoObj.created) || 0,
      url: videoObj.url || ('https://www.bilibili.com/video/' + videoObj.bvid),
      added_at: new Date().toISOString(),
    });
    if (jobIdx >= 0) { jobs[jobIdx].starred = true; saveJobs(jobs); }
    added = true;
  }
  libraryState.favorites = list;
  saveLibraryLocalAndCloud();
  syncFeedCardQuickStates(videoObj.bvid);
  refreshAllLibraryViews();
  toast(added ? '已加入「我的收藏」' : '已取消收藏');
  return added;
}

function toggleWatchLaterCurrent() {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (job) toggleWatchLaterVideo({ bvid: job.bvid, job_id: job.id, title: job.title, author: job.owner, duration: job.duration, pic: job.pic || '', url: job.video_url });
}
function toggleStarCurrent() {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (job) toggleFavoriteVideo({ bvid: job.bvid, job_id: job.id, title: job.title, author: job.owner, duration: job.duration, pic: job.pic || '', url: job.video_url });
}
function updateStarBtn(job) {
  const btn = document.getElementById('starBtn'), txt = document.getElementById('starBtnText');
  const on = isJobFavorited(job);
  if (btn) btn.classList.toggle('starred', on);
  if (txt) txt.textContent = on ? '已收藏' : '收藏';
}
function updateWatchLaterBtn(job) {
  const btn = document.getElementById('wlBtn'), txt = document.getElementById('wlBtnText');
  const on = Boolean(job && isWatchLater(job.bvid));
  if (btn) btn.classList.toggle('active', on);
  if (txt) txt.textContent = on ? '已加稍后再看' : '稍后再看';
}

function toggleJobTag(jobKey, folderId) {
  if (!jobKey || !folderId) return;
  const cur = new Set(libraryState.job_tags[jobKey] || []);
  if (cur.has(folderId)) cur.delete(folderId); else cur.add(folderId);
  if (cur.size) libraryState.job_tags[jobKey] = Array.from(cur);
  else delete libraryState.job_tags[jobKey];
  saveLibraryLocalAndCloud();
  refreshAllLibraryViews();
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
  refreshAllLibraryViews();
  refreshOpenTagPopover();
}

let activeTagPopoverCtx = null;
function closeTagPopover() {
  const pop = document.getElementById('tagPopover');
  if (pop) pop.classList.add('hidden');
  activeTagPopoverCtx = null;
}
function refreshOpenTagPopover() {
  if (activeTagPopoverCtx) renderTagPopoverBody(activeTagPopoverCtx.targetType, activeTagPopoverCtx.targetKey);
}
function toggleFavFolderAssign(bvid, folderId) {
  if (!bvid || !folderId) return;
  const cur = new Set(getFavFolderIds(bvid));
  if (cur.has(folderId)) {
    if (cur.size > 1) cur.delete(folderId);
    else { toast('每条收藏至少需保留在 1 个收藏文件夹中', true); return; }
  } else {
    cur.add(folderId);
  }
  libraryState.fav_folder_map[bvid] = Array.from(cur);
  saveLibraryLocalAndCloud();
  refreshAllLibraryViews();
  refreshOpenTagPopover();
}
function openCurrentJobTagPopover(btn) {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (job) openTagPopover(btn, 'job', jobTagKey(job));
}
function renderTagPopoverBody(targetType, targetKey) {
  const pop = document.getElementById('tagPopover');
  if (!pop) return;
  const scope = targetType === 'up' ? 'up' : (targetType === 'fav' ? 'fav' : 'summary');
  const folders = getScopeFolders(scope);
  const chosen = new Set(
    targetType === 'up' ? getUpTagIds(targetKey)
    : (targetType === 'fav' ? getFavFolderIds(targetKey) : (libraryState.job_tags[targetKey] || []))
  );
  const fnName = targetType === 'up' ? 'toggleUpTag' : (targetType === 'fav' ? 'toggleFavFolderAssign' : 'toggleJobTag');
  const headText = targetType === 'up' ? '归入 UP 主分类' : (targetType === 'fav' ? '选择收藏文件夹' : '选择摘要分类');
  let html = '<div class="tag-pop-head">' + headText + '</div>';
  html += folders.map(f => {
    const sel = chosen.has(f.id);
    return '<button type="button" class="tag-pop-item' + (sel ? ' selected' : '') + '" onclick="' + fnName + '(\'' + esc(targetKey) + '\',\'' + esc(f.id) + '\')">' +
      '<span class="tag-pop-left"><span class="folder-dot" style="background:' + esc(f.color) + '"></span><span>' + esc(f.name) + '</span></span>' +
      (sel ? SVG_CHK : '') + '</button>';
  }).join('');
  html += '<div class="tag-pop-sep"></div><button type="button" class="tag-pop-item" onclick="closeTagPopover();openTagManagerModal(\'' + scope + '\')"><span class="tag-pop-left" style="color:var(--brand-dark);font-weight:600">+ 管理' + (scope === 'up' ? ' UP 分类' : (scope === 'fav' ? '收藏文件夹' : '摘要分类')) + '</span></button>';
  pop.innerHTML = html;
}
function openTagPopover(anchorEl, targetType, targetKey) {
  const pop = document.getElementById('tagPopover');
  if (!pop) return;
  if (activeTagPopoverCtx && activeTagPopoverCtx.anchorEl === anchorEl && !pop.classList.contains('hidden')) { closeTagPopover(); return; }
  activeTagPopoverCtx = { anchorEl, targetType, targetKey };
  renderTagPopoverBody(targetType, targetKey);
  pop.classList.remove('hidden');
  const rect = anchorEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top = rect.bottom + 6, left = rect.left;
  if (top + popRect.height > window.innerHeight - 12) top = Math.max(12, rect.top - popRect.height - 6);
  if (left + popRect.width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - popRect.width - 12);
  pop.style.top = top + 'px'; pop.style.left = left + 'px';
}
document.addEventListener('click', (e) => {
  const pop = document.getElementById('tagPopover');
  if (!pop || pop.classList.contains('hidden')) return;
  if (pop.contains(e.target)) return;
  if (activeTagPopoverCtx && activeTagPopoverCtx.anchorEl && activeTagPopoverCtx.anchorEl.contains(e.target)) return;
  closeTagPopover();
});

function openTagManagerModal(scope) {
  closeTagPopover();
  folderMgrScope = (scope === 'up' || scope === 'fav') ? scope : 'summary';
  renderFolderColorSwatches();
  openModal('tagManagerModal');
  switchFolderMgrScope(folderMgrScope, true);
}
function switchFolderMgrScope(scope, instant) {
  folderMgrScope = scope;
  document.querySelectorAll('#folderMgrTabs .seg-tab').forEach(b => b.classList.toggle('active', b.dataset.fscope === scope));
  requestAnimationFrame(() => moveSlider('folderMgrTabs', Boolean(instant)));
  const labels = { summary: '新建摘要分类', up: '新建 UP 主分类', fav: '新建收藏文件夹' };
  const titles = { summary: '已有摘要分类', up: '已有 UP 主分类', fav: '已有收藏文件夹' };
  const phs = { summary: '例如：科技、历史、游戏、AI工具...', up: '例如：国际时政、数码测评、学习干货...', fav: '例如：深度干货、稍后精读、灵感素材...' };
  document.getElementById('newFolderLabel').textContent = labels[scope] || '新建分类';
  document.getElementById('existingFolderTitle').textContent = titles[scope] || '已有分类';
  document.getElementById('newFolderNameInput').placeholder = phs[scope] || '输入名称...';
  renderFolderManagerList();
}
function renderFolderColorSwatches() {
  const box = document.getElementById('folderColorSwatches');
  if (!box) return;
  box.innerHTML = FOLDER_COLORS.map(c => '<button type="button" class="color-sw' + (selectedNewFolderColor === c ? ' active' : '') + '" style="background:' + c + '" onclick="selectedNewFolderColor=\'' + c + '\';renderFolderColorSwatches()"></button>').join('');
}
function getAllFavoritesMerged() {
  const jobs = getJobs();
  const map = new Map();
  (libraryState.favorites || []).forEach(v => { if (v && v.bvid) map.set(v.bvid, { ...v }); });
  jobs.forEach(j => {
    if (j.starred && j.bvid) {
      const ex = map.get(j.bvid);
      if (!ex) map.set(j.bvid, { bvid: j.bvid, job_id: j.id, title: j.title, author: j.owner, duration: j.duration, pic: j.pic || '', url: j.video_url, added_at: j.created_at });
      else if (!ex.pic && j.pic) ex.pic = j.pic;
    }
  });
  return Array.from(map.values()).sort((a, b) => new Date(b.added_at || 0) - new Date(a.added_at || 0));
}
function renderFolderManagerList() {
  const box = document.getElementById('folderMgrList');
  if (!box) return;
  const jobs = getJobs(), ups = monitorConfig.up_list || [], favs = getAllFavoritesMerged();
  const folders = getScopeFolders(folderMgrScope);
  if (!folders.length) { box.innerHTML = '<div style="text-align:center;color:var(--muted);padding:16px;font-size:12.5px">暂无文件夹</div>'; return; }
  box.innerHTML = folders.map((f, idx) => {
    let stat = '';
    if (folderMgrScope === 'summary') stat = '摘要 ' + jobs.filter(j => getJobTagIds(j).includes(f.id)).length + ' 篇';
    else if (folderMgrScope === 'up') stat = 'UP主 ' + ups.filter(u => getUpTagIds(u.mid).includes(f.id)).length + ' 位';
    else stat = '收藏 ' + favs.filter(v => getFavFolderIds(v.bvid).includes(f.id)).length + ' 条';
    const canDel = !(folderMgrScope === 'fav' && folders.length <= 1);
    return '<div class="folder-mgr-row"><div class="folder-mgr-left"><span class="folder-dot" style="width:10px;height:10px;background:' + esc(f.color) + '"></span><div><div class="folder-mgr-name">' + esc(f.name) + '</div><div class="folder-mgr-stat">' + stat + '</div></div></div><div style="display:flex;gap:6px"><button type="button" class="btn btn-sm" onclick="renameFolder(\'' + esc(f.id) + '\',\'' + folderMgrScope + '\')">重命名</button>' + (canDel ? '<button type="button" class="btn btn-sm" style="color:var(--err)" onclick="deleteFolder(\'' + esc(f.id) + '\',\'' + folderMgrScope + '\')">删除</button>' : '') + '</div></div>';
  }).join('');
}
function createNewFolder() {
  const inp = document.getElementById('newFolderNameInput');
  const name = (inp.value || '').trim().slice(0, 16);
  if (!name) { toast('请输入文件夹名称', true); return; }
  const arr = getScopeFolders(folderMgrScope);
  if (arr.some(f => f.name === name)) { toast('已存在同名文件夹', true); return; }
  const id = folderMgrScope.slice(0, 2) + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  arr.push({ id, name, color: selectedNewFolderColor || FOLDER_COLORS[0] });
  setScopeFolders(folderMgrScope, arr);
  inp.value = '';
  saveLibraryLocalAndCloud();
  renderFolderManagerList();
  refreshAllLibraryViews();
  toast('已创建：' + name);
}
function renameFolder(id, scope) {
  const sc = scope || folderMgrScope;
  const f = getFolderById(id, sc);
  if (!f) return;
  const next = prompt('输入新的名称：', f.name);
  if (next === null) return;
  const clean = next.trim().slice(0, 16);
  if (!clean) return;
  f.name = clean;
  saveLibraryLocalAndCloud();
  renderFolderManagerList();
  refreshAllLibraryViews();
  toast('已重命名为：' + clean);
}
function deleteFolder(id, scope) {
  const sc = scope || folderMgrScope;
  const arr = getScopeFolders(sc);
  if (sc === 'fav' && arr.length <= 1) { toast('至少需保留一个收藏文件夹', true); return; }
  const f = getFolderById(id, sc);
  if (!f) return;
  if (!confirm('确定删除「' + f.name + '」？（不会删除视频或 UP 主本身）')) return;
  setScopeFolders(sc, arr.filter(x => x.id !== id));
  if (sc === 'up') {
    if (selectedMonFolder === id) selectedMonFolder = '';
    Object.keys(libraryState.up_tags).forEach(k => {
      libraryState.up_tags[k] = (libraryState.up_tags[k] || []).filter(x => x !== id);
      if (!libraryState.up_tags[k].length) delete libraryState.up_tags[k];
    });
  } else if (sc === 'fav') {
    Object.keys(libraryState.fav_folder_map).forEach(k => {
      libraryState.fav_folder_map[k] = (libraryState.fav_folder_map[k] || []).filter(x => x !== id);
      if (!libraryState.fav_folder_map[k].length) delete libraryState.fav_folder_map[k];
    });
  } else {
    if (histFolderFilter === id) histFolderFilter = '';
    Object.keys(libraryState.job_tags).forEach(k => {
      libraryState.job_tags[k] = (libraryState.job_tags[k] || []).filter(x => x !== id);
      if (!libraryState.job_tags[k].length) delete libraryState.job_tags[k];
    });
  }
  saveLibraryLocalAndCloud();
  renderFolderManagerList();
  if (currentRoute === 'folder' && activeFolderId === id) navigate(sc === 'up' ? 'monitor' : 'history');
  else refreshAllLibraryViews();
  toast('已删除：' + f.name);
}

// ── PAGE 1: SUMMARY WORKSPACE ──
function renderRecentStrip() {
  const strip = document.getElementById('recentStrip');
  if (!strip) return;
  const jobs = getJobs().slice(0, 10);
  if (!jobs.length) { strip.innerHTML = ''; return; }
  strip.innerHTML = '<span class="recent-strip-label">最近任务</span>' + jobs.map(j => {
    const st = normStatus(j.status);
    const dotCls = st === 'completed' ? 'ok' : (st === 'failed' ? 'err' : 'pending');
    const active = j.id === selectedJobId ? ' active' : '';
    return '<button class="rec-pill' + active + '" title="' + esc(j.title || j.bvid) + '" onclick="selectJob(\'' + esc(j.id) + '\',false)"><span class="dot ' + dotCls + '"></span><span>' + esc(j.title || j.bvid) + '</span></button>';
  }).join('');
}

function selectJob(id, goToSummaryRoute) {
  selectedJobId = id;
  if (goToSummaryRoute && currentRoute !== 'summary') {
    navigate('summary', id);
    return;
  }
  const job = getJobs().find(j => j.id === id);
  renderRecentStrip();
  if (!job) return;
  document.getElementById('summaryEmptyState').classList.add('hidden');
  document.getElementById('detailView').classList.remove('hidden');
  renderDetail(job);
  if (normStatus(job.status) === 'pending') startPolling(job.id);
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

// ── Rich Markdown, Mindmap, Re-summarize, Transcript Search, AI Chat, Poster PNG ──
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
  if (c.length <= 16 && (c.includes('核心主题') || c.includes('核心概念') || c.includes('主题概括') || c === '主题')) return 'theme';
  if (c.length <= 16 && (c.includes('要点提炼') || c.includes('核心要点') || c.includes('重点') || c.includes('问答'))) return 'points';
  if (c.length <= 16 && (c === '总结' || c.includes('总结洞察') || c.includes('结论') || c.includes('实践建议') || c.includes('推荐语') || c.includes('复习'))) return 'conclusion';
  return null;
}
function parseSummarySections(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let cur = { kind: 'body', lines: [] };
  const pushCur = () => { if (cur.lines.length) sections.push(cur); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^[-_*]{3,}$/.test(line)) continue;
    if (/^#\s+/.test(line) && i < 3) continue;
    const secKind = detectSectionKind(line);
    if (secKind) { pushCur(); cur = { kind: secKind, lines: [] }; continue; }
    const inlineSec = line.match(/^(?:\*\*)?(核心主题|核心概念|要点提炼|核心要点|总结|结论)(?:\*\*)?[:：]\s*(.+)$/);
    if (inlineSec) { pushCur(); cur = { kind: detectSectionKind(inlineSec[1]) || 'body', lines: [inlineSec[2].trim()] }; continue; }
    cur.lines.push(line);
  }
  pushCur();
  return sections;
}
function renderRichSummary(md) {
  const sections = parseSummarySections(md);
  if (!sections.length) return '<div class="pending-banner">暂无 AI 总结内容</div>';
  return sections.map(sec => {
    if (sec.kind === 'theme') return '<div class="md-theme-box"><div class="md-theme-label">核心主题</div><div class="md-theme-body">' + sec.lines.map(inlineMd).join('<br>') + '</div></div>';
    if (sec.kind === 'points') {
      const items = sec.lines.map((l, idx) => {
        const mNum = l.match(/^(\d+)[.、)]\s*(.+)$/), mBul = l.match(/^[-*•]\s+(.+)$/);
        if (mNum) return '<li><span class="md-num">' + esc(mNum[1]) + '</span><div>' + inlineMd(mNum[2]) + '</div></li>';
        if (mBul) return '<li><span class="md-num">·</span><div>' + inlineMd(mBul[1]) + '</div></li>';
        return '<li><span class="md-num">' + (idx + 1) + '</span><div>' + inlineMd(l) + '</div></li>';
      }).join('');
      return '<div class="md-sec-title">要点提炼</div><ul class="md-list">' + items + '</ul>';
    }
    if (sec.kind === 'conclusion') {
      const notes = [], body = [];
      sec.lines.forEach(l => { if (l.includes('字幕可能不完整') || /^(?:\*\*)?注[:：]/.test(l)) notes.push(inlineMd(l)); else body.push(inlineMd(l)); });
      return '<div class="md-conclusion"><div class="md-conclusion-label">总结洞察</div><div class="md-conclusion-body">' + body.join('<br>') + '</div>' + (notes.length ? '<div class="md-note">' + notes.join(' ') + '</div>' : '') + '</div>';
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
    el.innerHTML = '<div class="pending-banner">请先生成有效的 AI 总结，系统将自动构建结构化思维导图。</div>'; return;
  }
  const kindNames = { theme: '核心主题', points: '核心要点拆解', conclusion: '总结洞察', body: '内容脉络' };
  const branches = sections.map(sec => {
    const leaves = sec.lines.map(l => '<div class="mm-leaf">' + inlineMd(l.replace(/^\d+[.、)]\s*|^[-*•]\s+/, '')) + '</div>').join('');
    return '<div class="mm-node"><div class="mm-node-head" onclick="this.nextElementSibling.classList.toggle(\'hidden\')"><span class="mm-node-title">' + esc(kindNames[sec.kind] || '要点') + '</span><span class="mm-node-tag">' + sec.lines.length + ' 项</span></div><div class="mm-children">' + leaves + '</div></div>';
  }).join('');
  el.innerHTML = '<div class="mm-wrap"><div class="mm-root">' + esc(job.title || job.bvid) + '</div><div class="mm-branches">' + branches + '</div></div>';
}
function copyMindmapOutline() {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job) return;
  const sections = parseSummarySections(job.summary || '');
  const kindNames = { theme: '核心主题', points: '要点提炼', conclusion: '总结洞察', body: '内容' };
  let out = '# ' + (job.title || job.bvid) + '\n';
  sections.forEach(s => { out += '\n## ' + (kindNames[s.kind] || '节点') + '\n'; s.lines.forEach(l => { out += '- ' + l.replace(/^\d+[.、)]\s*|^[-*•]\s+/, '') + '\n'; }); });
  navigator.clipboard.writeText(out).then(() => toast('导图 Markdown 大纲已复制')).catch(() => {});
}

async function resummarizeCurrent(style) {
  const jobs = getJobs(), idx = jobs.findIndex(j => j.id === selectedJobId);
  if (idx < 0) return;
  const job = jobs[idx];
  if (!job.transcript || job.transcript.length < 30) { toast('当前任务没有可用转录文本，无法秒速重总结', true); return; }
  document.querySelectorAll('#styleSwitchBar .style-pill').forEach(b => { b.disabled = true; b.classList.toggle('active', b.dataset.rs === style); });
  document.getElementById('summaryContent').innerHTML = '<div class="pending-banner">正在通过免费 AI 模型秒速重生成（约 4~8 秒，无需重下音频）...</div>';
  try {
    const r = await apiFetch('/api/resummarize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: job.id, bvid: job.bvid, title: job.title, transcript: job.transcript, style }),
    });
    const d = await r.json();
    if (!r.ok) { toast(d.error || '重生成失败', true); renderDetail(job); return; }
    jobs[idx].summary = d.summary; jobs[idx].summary_style = style;
    jobs[idx].error = ''; jobs[idx].error_stage = ''; jobs[idx].error_hint = '';
    saveJobs(jobs); renderDetail(jobs[idx]);
    toast('已秒速重生成（' + (d.elapsed || 5) + 's · 免费模型 ' + (d.model || '') + '）');
  } catch (e) { toast('重生成异常：' + e.message, true); renderDetail(job); }
  finally { document.querySelectorAll('#styleSwitchBar .style-pill').forEach(b => { b.disabled = false; }); }
}

function adjustFontSize(delta) {
  readerFontPx = Math.max(12, Math.min(19, readerFontPx + delta));
  document.documentElement.style.setProperty('--reader-fs', readerFontPx + 'px');
}
function highlightTranscript() {
  const job = getJobs().find(j => j.id === selectedJobId);
  const box = document.getElementById('transcriptContent'), countEl = document.getElementById('trMatchCount');
  const raw = (job && job.transcript) || '（该任务无语音转录文本）';
  const kw = (document.getElementById('trSearchInput').value || '').trim();
  trMatchIndex = -1;
  if (!kw) { box.textContent = raw; countEl.textContent = ''; return; }
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

function getVideoChats(jobId) { try { return (JSON.parse(localStorage.getItem(LS_CHATS) || '{}'))[jobId] || []; } catch { return []; } }
function saveVideoChats(jobId, msgs) {
  try { const all = JSON.parse(localStorage.getItem(LS_CHATS) || '{}'); all[jobId] = msgs.slice(-20); localStorage.setItem(LS_CHATS, JSON.stringify(all)); } catch {}
}
function renderVideoChat(jobId) {
  const msgs = getVideoChats(jobId), box = document.getElementById('chatMessages');
  if (!msgs.length) { box.innerHTML = '<div style="text-align:center;color:var(--muted);padding:34px 16px;font-size:13px">点击上方快捷问题，或直接输入任何关于本视频的疑问</div>'; return; }
  box.innerHTML = msgs.map(m => '<div class="chat-msg ' + (m.role === 'user' ? 'user' : 'assistant') + '">' + inlineMd(m.content) + '</div>').join('');
  box.scrollTop = box.scrollHeight;
}
function clearVideoChat() { if (!selectedJobId) return; saveVideoChats(selectedJobId, []); renderVideoChat(selectedJobId); }
async function sendVideoChat(presetText) {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job) return;
  const inp = document.getElementById('chatInput');
  const q = (presetText !== undefined ? presetText : inp.value).trim();
  if (!q) return;
  if (presetText === undefined) inp.value = '';
  const msgs = [...getVideoChats(job.id), { role: 'user', content: q }];
  saveVideoChats(job.id, msgs); renderVideoChat(job.id);
  const btn = document.getElementById('chatSendBtn'); btn.disabled = true; btn.textContent = '思考中...';
  const box = document.getElementById('chatMessages');
  const typing = document.createElement('div'); typing.className = 'chat-msg assistant'; typing.textContent = '正在结合视频转录内容思考...';
  box.appendChild(typing); box.scrollTop = box.scrollHeight;
  try {
    const r = await apiFetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: job.title, transcript: job.transcript || '', summary: job.summary || '', messages: msgs }),
    });
    const d = await r.json();
    if (!r.ok) { typing.textContent = '追问失败：' + (d.error || '服务异常'); return; }
    saveVideoChats(job.id, [...msgs, { role: 'assistant', content: d.reply }]);
    renderVideoChat(job.id);
  } catch (e) { typing.textContent = '网络异常：' + e.message; }
  finally { btn.disabled = false; btn.textContent = '发送'; }
}

function exportPosterPng() {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job || !job.summary || job.summary.startsWith('（AI总结失败')) { toast('当前没有可导出的有效 AI 总结', true); return; }
  const sections = parseSummarySections(job.summary);
  const scale = 2, W = 760, pad = 44;
  const wrapText = (ctx, text, maxW) => {
    const out = [];
    for (const para of String(text || '').split('\n')) {
      let line = '';
      for (const ch of para) { if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; } else line += ch; }
      if (line) out.push(line);
    }
    return out;
  };
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
  const H = Math.max(460, y + 64);
  const canvas = document.createElement('canvas');
  canvas.width = W * scale; canvas.height = H * scale;
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
  ctx.fillStyle = '#F6F7F9'; ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, 110); grad.addColorStop(0, '#0F172A'); grad.addColorStop(1, '#1E293B');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, 108);
  ctx.fillStyle = '#FB7299'; ctx.fillRect(0, 105, W, 3);
  ctx.fillStyle = '#FB7299'; ctx.font = 'bold 12px -apple-system,sans-serif'; ctx.fillText('BILIBILI AI SUMMARY · 视频精华卡片', pad, 38);
  ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 20px -apple-system,PingFang SC,sans-serif'; ctx.fillText('B站AI摘要', pad, 72);
  ctx.fillStyle = '#94A3B8'; ctx.font = '13px -apple-system,sans-serif';
  ctx.fillText([job.owner, job.duration, job.bvid].filter(Boolean).join('  ·  '), pad, 92);
  let cy = 148;
  ctx.fillStyle = '#111827'; ctx.font = 'bold 24px -apple-system,PingFang SC,Microsoft YaHei,sans-serif';
  titleLines.forEach(tl => { ctx.fillText(tl, pad, cy); cy += 34; });
  cy += 12;
  blocks.forEach(b => {
    const bh = 36 + b.lines.length * 25 + 14;
    ctx.fillStyle = b.kind === 'theme' ? '#FFF1F5' : '#FFFFFF'; ctx.fillRect(pad, cy, W - pad * 2, bh);
    ctx.strokeStyle = b.kind === 'theme' ? '#FECDD3' : '#E5E7EB'; ctx.lineWidth = 1; ctx.strokeRect(pad, cy, W - pad * 2, bh);
    if (b.kind === 'theme') { ctx.fillStyle = '#FB7299'; ctx.fillRect(pad, cy, 4, bh); }
    ctx.fillStyle = b.kind === 'theme' ? '#E11D48' : '#4B5563'; ctx.font = 'bold 13px -apple-system,PingFang SC,sans-serif'; ctx.fillText(b.label, pad + 16, cy + 24);
    ctx.fillStyle = '#1F2937'; ctx.font = '15px -apple-system,PingFang SC,Microsoft YaHei,sans-serif';
    let ly = cy + 48; b.lines.forEach(l => { ctx.fillText(l, pad + 16, ly); ly += 25; });
    cy += bh + 16;
  });
  ctx.fillStyle = '#9CA3AF'; ctx.font = '12px -apple-system,sans-serif';
  ctx.fillText('由 bilisum.cc.cd 自动生成 · 免费语音转录与 AI 总结', pad, H - 24);
  const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = (job.bvid || 'summary') + '-card.png'; a.click();
  toast('分享长图 PNG 已生成并下载');
}

const STAGE_LABELS = { id_parse: '视频 ID 解析', video_info: '获取视频信息', playurl: '解析音频流', cdn_download: '下载 B 站音频', stt: '免费语音转文字', summarize: 'AI 生成总结' };
function renderFailureDiagnostics(job) {
  let stage = job.error_stage || '', errText = job.error || '', hint = job.error_hint || '';
  const hasTranscript = Boolean(job.transcript && job.transcript.length > 30);
  if (!stage) {
    const totalSec = job.timings && job.timings.total ? Number(job.timings.total) : null;
    if (totalSec !== null && totalSec <= 5) { stage = 'playurl'; errText = errText || '获取视频信息或音频流快速中断'; hint = hint || '可能是风控 (-412)、大会员/充电专属或稿件下架。'; }
    else { stage = 'stt'; errText = errText || '语音识别阶段未能返回有效文本'; hint = hint || '硅基流动免费接口临时波动或无有效人声，可重试。'; }
  }
  return '<div class="diag-card"><div class="diag-head"><div class="diag-title">处理异常 · 故障定位</div><span class="diag-stage">异常环节：' + esc(STAGE_LABELS[stage] || stage) + '</span></div><div class="diag-rows"><div class="diag-row"><span class="diag-key">报错详情</span><span>' + esc(errText) + '</span></div><div class="diag-row"><span class="diag-key">可能原因</span><span>' + esc(hint) + '</span></div></div><div class="diag-foot"><span style="font-size:12px;color:var(--soft)">视频 ID：<code>' + esc(job.bvid || '') + '</code></span><div style="display:flex;gap:8px;flex-wrap:wrap">' + (hasTranscript ? '<button class="btn btn-sm btn-brand" onclick="resummarizeCurrent(\'daily\')">秒速重生成总结（~5秒）</button>' : '') + '<button class="btn btn-sm btn-primary" onclick="submitVideo(\'' + esc(job.bvid || '') + '\')">全流程重新处理</button></div></div></div>';
}

function renderStepper(job) {
  const bar = document.getElementById('stepperBar');
  bar.classList.remove('hidden');
  const st = normStatus(job.status);
  const steps = job.gh_steps ? job.gh_steps.slice(0, 4) : [
    { name: '任务创建', done: true, active: false },
    { name: '下载音频', done: st === 'completed', active: st === 'pending' },
    { name: '语音转录', done: st === 'completed', active: false },
    { name: 'AI 总结', done: st === 'completed', active: false },
  ];
  const badgeHtml = st === 'completed' ? '<span class="st-badge ok">已完成</span>' : (st === 'failed' ? '<span class="st-badge err">处理失败</span>' : '<span class="st-badge pending">处理中</span>');
  bar.innerHTML = steps.map((s, i) => '<span class="' + (s.done ? 'st-item done' : (s.active ? 'st-item active' : 'st-item')) + '"><span class="st-dot">' + (s.done ? '&#10003;' : (i + 1)) + '</span><span>' + esc(s.name) + '</span></span><span class="st-line' + (s.done ? ' done' : '') + '"></span>').join('') + badgeHtml;
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
  if (durSec >= 120 && normStatus(job.status) === 'completed') pills.push('<span class="meta-pill saved">帮你节省约 ' + Math.max(1, Math.round(durSec / 60 * 0.85)) + ' 分钟</span>');
  document.getElementById('dPills').innerHTML = pills.join('');

  const st = normStatus(job.status), rawSummary = (job.summary || '').trim(), rawTranscript = (job.transcript || '').trim();
  const isAiFailed = rawSummary.startsWith('（AI总结失败') || rawSummary.startsWith('(AI总结失败');
  document.getElementById('styleSwitchBar').classList.toggle('hidden', st !== 'completed' || !rawTranscript);
  document.querySelectorAll('#styleSwitchBar .style-pill').forEach(b => b.classList.toggle('active', b.dataset.rs === (job.summary_style || 'daily')));

  let sumHtml = '';
  if (st === 'pending') sumHtml = '<div class="pending-banner">GitHub Actions 正在提取音频、免费语音转文字并生成 AI 摘要，页面会自动刷新...</div>';
  else if (st === 'failed') sumHtml = renderFailureDiagnostics(job);
  else if (isAiFailed || !rawSummary) sumHtml = renderFailureDiagnostics({ ...job, error_stage: 'summarize', error: rawSummary || 'AI 总结返回为空', error_hint: '可能触发免费模型限流，点击下方即可 5 秒内免费重生成总结（无需重下音频）。' });
  else sumHtml = renderRichSummary(rawSummary);

  document.getElementById('summaryContent').innerHTML = sumHtml;
  document.getElementById('splitSummary').innerHTML = sumHtml;
  document.getElementById('trSearchInput').value = '';
  document.getElementById('trMatchCount').textContent = '';
  document.getElementById('transcriptContent').textContent = rawTranscript || (st === 'pending' ? '等待语音转录完成...' : '（该任务无语音转录文本）');
  document.getElementById('splitTranscript').textContent = rawTranscript || '（无转录文本）';
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
}
function applyViewMode() {
  document.getElementById('summaryCard').classList.toggle('hidden', viewMode !== 'summary');
  document.getElementById('mindmapCard').classList.toggle('hidden', viewMode !== 'mindmap');
  document.getElementById('transcriptCard').classList.toggle('hidden', viewMode !== 'transcript');
  document.getElementById('splitView').classList.toggle('hidden', viewMode !== 'split');
  document.getElementById('chatCard').classList.toggle('hidden', viewMode !== 'chat');
}
function getExportText() {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job) return '';
  if (viewMode === 'transcript') return job.transcript || '';
  if (viewMode === 'split') return '# ' + (job.title || job.bvid) + '\n\n## AI 总结\n\n' + (job.summary || '') + '\n\n## 完整转录\n\n' + (job.transcript || '');
  return job.summary || '';
}
function copyCurrent() {
  const text = getExportText();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => toast('内容已复制到剪贴板')).catch(() => {});
}
function exportFile(ext) {
  const job = getJobs().find(j => j.id === selectedJobId);
  if (!job) return;
  const text = getExportText();
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (job.bvid || 'bilibili-summary') + '.' + ext;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── PAGE 2: MONITOR UP CREATORS (Infinite Scroll + Multi-Page Cache) ──
function readFeedCache(key) {
  const k = String(key || 'all');
  if (feedMemCache.has(k)) return feedMemCache.get(k);
  try {
    const store = JSON.parse(sessionStorage.getItem(SS_FEED_CACHE) || '{}');
    if (store[k] && Array.isArray(store[k].videos)) { feedMemCache.set(k, store[k]); return store[k]; }
  } catch {}
  return null;
}
function writeFeedCache(key, data) {
  const k = String(key || 'all');
  const entry = { videos: data.videos || [], pn: data.pn || 1, hasMore: Boolean(data.hasMore), total: Number(data.total) || 0, ts: Date.now() };
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
  return Array.from({ length: 8 }).map(() => '<div class="v-card"><div class="skel" style="width:100%;aspect-ratio:16/9;border-radius:12px"></div><div style="display:flex;gap:10px;padding-top:10px"><div class="skel" style="width:34px;height:34px;border-radius:50%;flex-shrink:0"></div><div style="flex:1"><div class="skel" style="height:14px;width:90%;margin-bottom:7px"></div><div class="skel" style="height:12px;width:55%;margin-bottom:7px"></div><div class="skel" style="height:18px;width:36%;border-radius:999px"></div></div></div></div>').join('');
}

function initFeedObservers() {
  if (typeof IntersectionObserver === 'undefined') return;
  if (!feedObserver) {
    const sentinel = document.getElementById('feedSentinel'), root = document.getElementById('monScrollArea');
    if (sentinel) {
      feedObserver = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting && currentRoute === 'monitor' && feedPagination.hasMore && !feedPagination.loading) loadMoreUpFeed();
        });
      }, { root: root || null, rootMargin: '420px 0px' });
      feedObserver.observe(sentinel);
    }
  }
  if (!folderObserver) {
    const fSent = document.getElementById('folderFeedSentinel'), fRoot = document.getElementById('view-folder');
    if (fSent) {
      folderObserver = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting && currentRoute === 'folder' && folderViewTab === 'ups' && folderPagination.hasMore && !folderPagination.loading) loadMoreFolderUpsFeed();
        });
      }, { root: fRoot || null, rootMargin: '420px 0px' });
      folderObserver.observe(fSent);
    }
  }
}

async function loadMonitorConfigQuietly() {
  try {
    const r = await apiFetch('/api/monitor-config');
    if (!r.ok) return;
    const d = await r.json();
    if (d.config) { monitorConfig = d.config; hydrateMonitorForm(); updateNavBadges(); renderRailFolders(); }
  } catch {}
}

async function loadMonitorPage() {
  initFeedObservers();
  if (monitorPageBooted && (monitorConfig.up_list || []).length > 0) {
    renderMonitorFolderBar();
    updateMonitorHeaderSummary();
    if (!lastRenderedFeedKey) await fetchUpFeed(selectedUpMid || 'all');
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
  if (selectedMonFolder) selectMonitorUp('folder:' + selectedMonFolder);
  else if (String(selectedUpMid).startsWith('folder:')) selectMonitorUp('all');
}

function renderMonitorFolderBar() {
  const bar = document.getElementById('monFolderBar');
  if (!bar) return;
  const ups = monitorConfig.up_list || [], folders = libraryState.up_folders || [];
  let html = '<button class="folder-chip' + (!selectedMonFolder ? ' active' : '') + '" onclick="selectedMonFolder=\'\';renderMonitorFolderBar();renderUpSidebar();selectMonitorUp(\'all\')">全部</button>';
  folders.forEach(f => {
    const cnt = ups.filter(u => getUpTagIds(u.mid).includes(f.id)).length;
    html += '<button class="folder-chip' + (selectedMonFolder === f.id ? ' active' : '') + '" onclick="setMonFolder(\'' + esc(f.id) + '\')"><span class="folder-dot" style="background:' + esc(f.color) + '"></span><span>' + esc(f.name) + '</span>' + (cnt ? '<span class="folder-cnt">' + cnt + '</span>' : '') + '</button>';
  });
  bar.innerHTML = html;
}

function renderUpSidebar() {
  const kw = (document.getElementById('upSearchInput').value || '').trim().toLowerCase();
  const allUps = monitorConfig.up_list || [];
  const ups = selectedMonFolder ? allUps.filter(u => getUpTagIds(u.mid).includes(selectedMonFolder)) : allUps;
  const filtered = kw ? ups.filter(u => String(u.name || '').toLowerCase().includes(kw) || String(u.mid || '').includes(kw)) : ups;
  const listEl = document.getElementById('upSideList');
  let html = '';
  if (!kw) {
    if (selectedMonFolder) {
      const f = getFolderById(selectedMonFolder), fKey = 'folder:' + selectedMonFolder;
      html += '<div class="up-side-card' + (selectedUpMid === fKey ? ' active' : '') + '" onclick="selectMonitorUp(\'' + esc(fKey) + '\')"><div class="up-ava-fb" style="background:' + esc((f && f.color) || '#2563EB') + ';color:#fff;border-color:transparent">' + esc(((f && f.name) || '类').slice(0, 1)) + '</div><div class="up-side-info"><div class="up-side-name">「' + esc((f && f.name) || '分类') + '」全部动态</div><div class="up-side-uid">聚合 ' + ups.length + ' 位 UP 主</div></div></div>';
    } else {
      html += '<div class="up-side-card' + (selectedUpMid === 'all' ? ' active' : '') + '" onclick="selectMonitorUp(\'all\')"><div class="up-ava-fb">全</div><div class="up-side-info"><div class="up-side-name">全部监控 UP 主</div><div class="up-side-uid">聚合最新动态 · ' + allUps.length + ' 位</div></div></div>';
    }
  }
  html += filtered.length ? filtered.map(u => {
    const active = String(selectedUpMid) === String(u.mid) ? ' active' : '';
    const faceUrl = u.face ? (u.face.replace(/^http:\/\//, 'https://') + '@96w_96h_1c.webp') : '';
    const ava = faceUrl ? '<img class="up-ava" src="' + esc(faceUrl) + '" referrerpolicy="no-referrer" alt="">' : '<div class="up-ava-fb">' + esc((u.name || String(u.mid)).slice(0, 1)) + '</div>';
    const tagsHtml = getUpTagIds(u.mid).map(tid => { const f = getFolderById(tid); return f ? '<span class="mini-tag"><span class="folder-dot" style="width:5px;height:5px;background:' + esc(f.color) + '"></span>' + esc(f.name) + '</span>' : ''; }).join('');
    return '<div class="up-side-card' + active + '" onclick="selectMonitorUp(' + Number(u.mid) + ')">' + ava + '<div class="up-side-info"><div class="up-side-name">' + esc(u.name || u.mid) + '</div><div class="up-side-uid">UID ' + esc(u.mid) + '</div>' + (tagsHtml ? '<div class="mini-tags">' + tagsHtml + '</div>' : '') + '</div><div class="up-side-acts"><button class="up-act-ic" title="设置标签分类" onclick="event.stopPropagation();openTagPopover(this,\'up\',\'' + Number(u.mid) + '\')">' + SVG_TAG_SM + '</button><button class="up-act-ic del" title="取消监控" onclick="event.stopPropagation();quickRemoveMonitorUp(' + Number(u.mid) + ')">' + SVG_CLOSE_SM + '</button></div></div>';
  }).join('') : '<div style="text-align:center;padding:24px 10px;color:var(--muted);font-size:12px">' + (selectedMonFolder ? '该标签下暂无 UP 主' : '暂无匹配的 UP 主') + '</div>';
  listEl.innerHTML = html;
}

async function selectMonitorUp(mid) {
  selectedUpMid = mid;
  renderMonitorFolderBar();
  renderUpSidebar();
  const sc = document.getElementById('monScrollArea');
  if (sc) { sc.scrollTop = 0; routeScrollPos.monitor = 0; }
  const ups = monitorConfig.up_list || [];
  if (mid === 'all') {
    document.getElementById('monFeedHeading').textContent = '全部监控 UP 主动态';
    document.getElementById('topbarSub').textContent = '全部 UP 主';
  } else if (String(mid).startsWith('folder:')) {
    const f = getFolderById(String(mid).slice(7));
    document.getElementById('monFeedHeading').textContent = '「' + ((f && f.name) || '分类') + '」聚合动态';
    document.getElementById('topbarSub').textContent = '标签文件夹';
  } else {
    const found = ups.find(u => Number(u.mid) === Number(mid));
    const label = found ? found.name : ('UID ' + mid);
    document.getElementById('monFeedHeading').textContent = label + ' · 全部投稿';
    document.getElementById('topbarSub').textContent = label + ' (' + mid + ')';
  }
  await fetchUpFeed(mid);
}

async function quickAddMonitorUp() {
  const inp = document.getElementById('sideAddUpInput'), q = inp.value.trim();
  if (!q) return;
  const btn = document.getElementById('sideAddUpBtn'); btn.disabled = true; btn.textContent = '添加中';
  try {
    const r = await apiFetch('/api/up-lookup?q=' + encodeURIComponent(q));
    const d = await r.json();
    if (!r.ok) { showToast('sideUpToast', d.error || '解析失败', 'err'); return; }
    if (!monitorConfig.up_list) monitorConfig.up_list = [];
    if (!monitorConfig.up_list.some(x => Number(x.mid) === Number(d.mid))) {
      monitorConfig.up_list.push({ mid: Number(d.mid), name: d.name || String(d.mid), face: d.face || '' });
      const sr = await apiFetch('/api/monitor-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(monitorConfig) });
      const sd = await sr.json();
      if (sr.ok && sd.config) monitorConfig = sd.config;
      if (selectedMonFolder) {
        const k = String(d.mid);
        libraryState.up_tags[k] = [...new Set([...(libraryState.up_tags[k] || []), selectedMonFolder])];
        saveLibraryLocalAndCloud();
      }
    }
    inp.value = ''; clearFeedCache('all');
    updateNavBadges(); renderRailFolders(); updateMonitorHeaderSummary(); renderMonitorFolderBar(); renderUpSidebar();
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
    const sr = await apiFetch('/api/monitor-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(monitorConfig) });
    const sd = await sr.json();
    if (sr.ok && sd.config) monitorConfig = sd.config;
    if (String(selectedUpMid) === String(mid)) selectedUpMid = 'all';
    clearFeedCache('all'); clearFeedCache(mid);
    updateNavBadges(); renderRailFolders(); updateMonitorHeaderSummary(); renderMonitorFolderBar(); renderUpSidebar();
    await selectMonitorUp(selectedUpMid);
    toast('已取消监控');
  } catch (e) { toast('移除失败：' + e.message, true); }
}

function buildVideoCardHtml(v, idx, opts) {
  const o = opts || {};
  const poolName = o.pool || 'feed';
  const jobs = getJobs();
  const matchedJob = jobs.find(j => j.bvid === v.bvid && normStatus(j.status) === 'completed');
  const hasSum = Boolean(v.summary || (matchedJob && matchedJob.summary));
  const coverUrl = v.pic ? (v.pic.replace(/^http:\/\//, 'https://') + '@672w_378h_1c.webp') : '';
  const faceUrl = v.face ? (v.face.replace(/^http:\/\//, 'https://') + '@96w_96h_1c.webp') : '';
  const statsStr = (v.play || v.danmaku) ? [fmtCount(v.play), fmtDanmaku(v.danmaku)].join(' · ') : (v.bvid || '');
  const relTime = v.created ? fmtRelativeTime(v.created) : (v.added_at ? fmtShortDate(v.added_at) : '');
  const avaHtml = faceUrl ? '<img class="v-ava" src="' + esc(faceUrl) + '" referrerpolicy="no-referrer" alt="">' : '<div class="v-ava-fb">' + esc((v.author || 'UP').slice(0, 1)) + '</div>';
  const wlOn = isWatchLater(v.bvid), favOn = isFavBvid(v.bvid) || Boolean(matchedJob && matchedJob.starred);

  const chkHtml = o.showCheck
    ? '<label class="v-chk-wrap" onclick="event.stopPropagation()"><input type="checkbox" ' + (wlSelectedBvids.has(v.bvid) ? 'checked' : '') + ' onchange="toggleWlCheck(\'' + esc(v.bvid) + '\',this.checked)"><span>选择</span></label>'
    : '';
  const sumAction = matchedJob
    ? '<button class="v-act-btn" onclick="selectJob(\'' + esc(matchedJob.id) + '\',true)">打开摘要</button>'
    : (v.summary ? '<button class="v-act-btn" onclick="openFeedSummaryModal(\'' + poolName + '\',' + idx + ')">查看摘要</button>' : '');

  return '<article class="v-card" data-bvid="' + esc(v.bvid) + '">' +
    '<div class="v-thumb-wrap">' +
      '<a class="v-thumb-link" href="' + esc(v.url || ('https://www.bilibili.com/video/' + v.bvid)) + '" target="_blank" rel="noopener">' +
        (coverUrl ? '<img src="' + esc(coverUrl) + '" referrerpolicy="no-referrer" loading="lazy" alt="">' : '<div class="v-thumb-fallback">' + esc(v.title || v.bvid) + '</div>') +
        (hasSum ? '<span class="v-sum-badge">已有摘要</span>' : '') +
        (v.duration ? '<span class="v-dur">' + esc(v.duration) + '</span>' : '') +
      '</a>' +
      chkHtml +
      '<div class="v-quick-acts' + ((wlOn || favOn) ? ' has-active' : '') + '">' +
        '<button type="button" class="v-qbtn v-qbtn-wl' + (wlOn ? ' wl-on' : '') + '" title="' + (wlOn ? '移出稍后再看' : '加入稍后再看') + '" onclick="event.preventDefault();event.stopPropagation();togglePoolVideoWl(\'' + poolName + '\',' + idx + ')">' + SVG_CLOCK_SM + '</button>' +
        '<button type="button" class="v-qbtn v-qbtn-fav' + (favOn ? ' fav-on' : '') + '" title="' + (favOn ? '取消收藏' : '加入收藏') + '" onclick="event.preventDefault();event.stopPropagation();togglePoolVideoFav(\'' + poolName + '\',' + idx + ')">' + SVG_STAR_LINE + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="v-body">' + avaHtml +
      '<div class="v-meta-col">' +
        '<a class="v-title" href="' + esc(v.url || ('https://www.bilibili.com/video/' + v.bvid)) + '" target="_blank" rel="noopener" title="' + esc(v.title) + '">' + esc(v.title) + '</a>' +
        '<div class="v-author">' + esc(v.author || '') + '</div>' +
        '<div class="v-stats">' + esc(statsStr) + '</div>' +
        '<div class="v-foot">' +
          (relTime ? '<span class="v-time-pill">' + esc(relTime) + '</span>' : '<span></span>') +
          '<div class="v-act-row">' +
            sumAction +
            '<button class="v-act-btn primary" onclick="submitPoolVideo(\'' + poolName + '\',' + idx + ')">' + (hasSum ? '重算' : '一键总结') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</article>';
}

let wlRenderPool = [];
let favRenderPool = [];
function getPoolByName(name) {
  if (name === 'folder') return folderFeedVideos;
  if (name === 'wl') return wlRenderPool;
  if (name === 'fav') return favRenderPool;
  return currentFeedVideos;
}
function togglePoolVideoWl(poolName, idx) { const v = getPoolByName(poolName)[idx]; if (v) toggleWatchLaterVideo(v); }
function togglePoolVideoFav(poolName, idx) { const v = getPoolByName(poolName)[idx]; if (v) toggleFavoriteVideo(v); }
function submitPoolVideo(poolName, idx) {
  const v = getPoolByName(poolName)[idx];
  if (v) submitVideo(v.bvid, { title: v.title || '', owner: v.author || '', duration: v.duration || '' });
}
function openFeedSummaryModal(poolName, idx) {
  const v = getPoolByName(poolName)[idx];
  if (!v) return;
  modalSummaryRaw = v.summary || '';
  document.getElementById('smTitle').textContent = v.title || v.bvid;
  document.getElementById('smWatchLink').href = v.url || ('https://www.bilibili.com/video/' + v.bvid);
  document.getElementById('smBody').innerHTML = renderRichSummary(modalSummaryRaw);
  openModal('summaryModal');
}
function copyModalSummary() { navigator.clipboard.writeText(modalSummaryRaw || '').then(() => toast('摘要已复制')).catch(() => {}); }

function syncFeedCardQuickStates(bvid) {
  if (!bvid) return;
  const wlOn = isWatchLater(bvid), favOn = isFavBvid(bvid);
  document.querySelectorAll('.v-card[data-bvid="' + bvid.replace(/"/g, '') + '"]').forEach(card => {
    const acts = card.querySelector('.v-quick-acts'), wlB = card.querySelector('.v-qbtn-wl'), favB = card.querySelector('.v-qbtn-fav');
    if (acts) acts.classList.toggle('has-active', wlOn || favOn);
    if (wlB) { wlB.classList.toggle('wl-on', wlOn); wlB.title = wlOn ? '移出稍后再看' : '加入稍后再看'; }
    if (favB) { favB.classList.toggle('fav-on', favOn); favB.title = favOn ? '取消收藏' : '加入收藏'; }
  });
}

function buildUpFeedApiUrl(key, pn, forceRefresh) {
  const qs = [];
  if (String(key).startsWith('folder:')) {
    const fid = String(key).slice(7);
    const mids = (monitorConfig.up_list || []).filter(u => getUpTagIds(u.mid).includes(fid)).map(u => u.mid).join(',');
    qs.push('mid=group'); qs.push('mids=' + encodeURIComponent(mids));
  } else qs.push('mid=' + encodeURIComponent(key));
  qs.push('pn=' + pn); qs.push('ps=20');
  if (forceRefresh) qs.push('refresh=1');
  return '/api/up-videos?' + qs.join('&');
}

function renderFeedFooter() {
  const footer = document.getElementById('feedFooter');
  if (!footer) return;
  const count = currentFeedVideos.length;
  if (!count) { footer.innerHTML = ''; return; }
  const totalStr = feedPagination.total > count ? (' / 共约 ' + feedPagination.total + ' 条') : '';
  if (feedPagination.loading) footer.innerHTML = '<button class="feed-load-btn" disabled>正在加载更早的视频...</button><div class="feed-meta-note">已加载 ' + count + ' 条' + totalStr + '</div>';
  else if (feedPagination.hasMore) footer.innerHTML = '<button class="feed-load-btn" onclick="loadMoreUpFeed()">加载更多历史视频</button><div class="feed-meta-note">向下滚动自动翻页 · 已加载 ' + count + ' 条' + totalStr + '</div>';
  else footer.innerHTML = '<div class="feed-meta-note">已加载全部 ' + count + ' 条公开视频</div>';
}

function renderFeedCards(vids, key) {
  const grid = document.getElementById('upFeedGrid');
  const sig = vids.length + ':' + (vids[0] ? vids[0].bvid : '') + ':' + (vids[vids.length - 1] ? vids[vids.length - 1].bvid : '');
  currentFeedVideos = vids.slice();
  if (key && lastRenderedFeedKey === key && lastRenderedFeedSig === sig && grid.children.length > 0) { renderFeedFooter(); return; }
  lastRenderedFeedKey = key || ''; lastRenderedFeedSig = sig;
  if (!vids.length) { grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:36px">暂未获取到公开视频</div>'; renderFeedFooter(); return; }
  grid.innerHTML = vids.map((v, idx) => buildVideoCardHtml(v, idx, { pool: 'feed' })).join('');
  renderFeedFooter();
}
function appendFeedCards(newVids) {
  const grid = document.getElementById('upFeedGrid');
  if (!grid || !newVids.length) { renderFeedFooter(); return; }
  const startIdx = currentFeedVideos.length;
  currentFeedVideos.push(...newVids);
  grid.insertAdjacentHTML('beforeend', newVids.map((v, i) => buildVideoCardHtml(v, startIdx + i, { pool: 'feed' })).join(''));
  lastRenderedFeedSig = currentFeedVideos.length + ':' + (currentFeedVideos[0] ? currentFeedVideos[0].bvid : '') + ':' + (currentFeedVideos[currentFeedVideos.length - 1] ? currentFeedVideos[currentFeedVideos.length - 1].bvid : '');
  renderFeedFooter();
}

function prefetchTopUpsQuietly() {
  if (prefetchDone || !authUser) return;
  prefetchDone = true;
  (monitorConfig.up_list || []).slice(0, 5).forEach((u, i) => {
    const k = String(u.mid), ex = readFeedCache(k);
    if (ex && (Date.now() - ex.ts) < FEED_CACHE_TTL_MS) return;
    setTimeout(() => {
      if (!authUser) return;
      apiFetch('/api/up-videos?mid=' + encodeURIComponent(k) + '&pn=1&ps=20')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && Array.isArray(d.videos)) writeFeedCache(k, { videos: d.videos, pn: 1, hasMore: Boolean(d.has_more), total: d.total || 0 }); })
        .catch(() => {});
    }, 800 + i * 450);
  });
}

async function fetchUpFeed(mid, forceRefresh) {
  const key = String(mid || 'all');
  const grid = document.getElementById('upFeedGrid'), refBtn = document.getElementById('refreshFeedBtn');
  const cached = !forceRefresh ? readFeedCache(key) : null;
  const isFresh = cached && (Date.now() - cached.ts) < FEED_CACHE_TTL_MS;
  if (cached) {
    feedPagination = { key, pn: cached.pn || 1, hasMore: Boolean(cached.hasMore), loading: false, total: cached.total || 0 };
    renderFeedCards(cached.videos, key);
    if (isFresh) { prefetchTopUpsQuietly(); return; }
  } else {
    lastRenderedFeedKey = ''; lastRenderedFeedSig = '';
    feedPagination = { key, pn: 1, hasMore: false, loading: true, total: 0 };
    grid.innerHTML = renderSkeletonGrid();
    const f = document.getElementById('feedFooter'); if (f) f.innerHTML = '';
  }
  if (refBtn && forceRefresh) { refBtn.disabled = true; refBtn.textContent = '刷新中...'; }
  try {
    const r = await apiFetch(buildUpFeedApiUrl(key, 1, forceRefresh));
    const d = await r.json();
    if (!r.ok) { feedPagination.loading = false; if (!cached) grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;color:var(--err-text)">拉取失败：' + esc(d.error || ('HTTP ' + r.status)) + '</div>'; return; }
    const vids = d.videos || [], entry = { videos: vids, pn: 1, hasMore: Boolean(d.has_more), total: Number(d.total) || 0 };
    writeFeedCache(key, entry);
    if (String(selectedUpMid || 'all') === key) { feedPagination = { key, pn: 1, hasMore: entry.hasMore, loading: false, total: entry.total }; renderFeedCards(vids, key); }
    if (forceRefresh) toast('动态已刷新（第 1 页共 ' + vids.length + ' 条）');
    prefetchTopUpsQuietly();
  } catch (e) { feedPagination.loading = false; if (!cached) grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;color:var(--err-text)">网络异常：' + esc(e.message) + '</div>'; }
  finally { if (refBtn) { refBtn.disabled = false; refBtn.textContent = '刷新动态'; } }
}

async function loadMoreUpFeed() {
  const key = String(selectedUpMid || 'all');
  if (feedPagination.loading || !feedPagination.hasMore || feedPagination.key !== key) return;
  const nextPn = (feedPagination.pn || 1) + 1;
  feedPagination.loading = true; renderFeedFooter();
  try {
    const r = await apiFetch(buildUpFeedApiUrl(key, nextPn, false));
    const d = await r.json();
    if (String(selectedUpMid || 'all') !== key) return;
    if (!r.ok) { feedPagination.loading = false; renderFeedFooter(); toast('翻页加载失败', true); return; }
    const seen = new Set(currentFeedVideos.map(v => v.bvid));
    const incoming = (d.videos || []).filter(v => v && v.bvid && !seen.has(v.bvid));
    feedPagination.pn = nextPn;
    feedPagination.hasMore = Boolean(d.has_more) && (incoming.length > 0 || (d.videos || []).length > 0);
    feedPagination.loading = false;
    if (d.total) feedPagination.total = Number(d.total);
    appendFeedCards(incoming);
    writeFeedCache(key, { videos: currentFeedVideos.slice(), pn: feedPagination.pn, hasMore: feedPagination.hasMore, total: feedPagination.total });
  } catch (e) { feedPagination.loading = false; renderFeedFooter(); toast('加载更多失败：' + e.message, true); }
}

// ── PAGE 3: WATCH LATER QUEUE ──
function setWlFilter(f) {
  wlFilter = f;
  document.querySelectorAll('#wlFilterTabs .seg-tab').forEach(b => b.classList.toggle('active', b.dataset.wlf === f));
  moveSlider('wlFilterTabs');
  renderWatchLaterPage();
}
function toggleWlCheck(bvid, checked) {
  if (checked) wlSelectedBvids.add(bvid); else wlSelectedBvids.delete(bvid);
  updateWlBatchBtn();
}
function updateWlBatchBtn() {
  const btn = document.getElementById('wlBatchSumBtn');
  if (!btn) return;
  const n = wlSelectedBvids.size;
  btn.textContent = n > 0 ? ('批量 AI 总结 (' + n + ')') : '批量 AI 总结';
}
function toggleWlSelectAll() {
  const jobs = getJobs(), doneSet = new Set(jobs.filter(j => normStatus(j.status) === 'completed').map(j => j.bvid));
  const todos = (libraryState.watch_later || []).filter(v => !doneSet.has(v.bvid));
  if (wlSelectedBvids.size >= todos.length && todos.length > 0) wlSelectedBvids.clear();
  else { wlSelectedBvids.clear(); todos.slice(0, 5).forEach(v => wlSelectedBvids.add(v.bvid)); }
  renderWatchLaterPage();
}
async function batchSummarizeWatchLater() {
  const bvids = Array.from(wlSelectedBvids).slice(0, 5);
  if (!bvids.length) { toast('请先勾选需要总结的稍后再看视频（单次最多 5 条）', true); return; }
  const btn = document.getElementById('wlBatchSumBtn'); btn.disabled = true; btn.textContent = '提交中...';
  let ok = 0;
  for (const bvid of bvids) {
    const v = (libraryState.watch_later || []).find(x => x.bvid === bvid);
    const res = await submitVideo(bvid, v ? { title: v.title, owner: v.author, duration: v.duration } : null, true);
    if (res) { ok++; wlSelectedBvids.delete(bvid); }
  }
  btn.disabled = false;
  renderWatchLaterPage();
  toast('已批量提交 ' + ok + ' 条稍后再看视频至后台总结队列');
}
function clearDoneWatchLater() {
  const doneSet = new Set(getJobs().filter(j => normStatus(j.status) === 'completed').map(j => j.bvid));
  const before = (libraryState.watch_later || []).length;
  libraryState.watch_later = (libraryState.watch_later || []).filter(v => !doneSet.has(v.bvid));
  const removed = before - libraryState.watch_later.length;
  if (!removed) { toast('没有可清理的已总结视频'); return; }
  saveLibraryLocalAndCloud();
  renderWatchLaterPage();
  toast('已清理 ' + removed + ' 条已总结视频');
}
function renderWatchLaterPage() {
  const all = libraryState.watch_later || [];
  const doneSet = new Set(getJobs().filter(j => normStatus(j.status) === 'completed').map(j => j.bvid));
  const vids = all.filter(v => wlFilter === 'all' ? true : (wlFilter === 'done' ? doneSet.has(v.bvid) : !doneSet.has(v.bvid)));
  wlRenderPool = vids;
  document.getElementById('wlPageSub').textContent = '共 ' + all.length + ' 条待看视频（其中 ' + all.filter(v => !doneSet.has(v.bvid)).length + ' 条待总结）· 勾选可批量一键 AI 总结';
  updateWlBatchBtn();
  const grid = document.getElementById('wlGrid');
  if (!vids.length) {
    grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:44px">当前队列为空。在「监控 UP 主」封面右上角或「摘要工作台」标题栏点击时钟图标即可加入稍后再看。</div>';
    return;
  }
  grid.innerHTML = vids.map((v, idx) => buildVideoCardHtml(v, idx, { pool: 'wl', showCheck: true })).join('');
}

// ── PAGE 4: FAVORITES STACKED FAN-DECK FOLDERS & ACCORDION EXPAND ──
function toggleFavDeckExpand(fid) {
  if (expandedFavFolders.has(fid)) expandedFavFolders.delete(fid);
  else expandedFavFolders.add(fid);
  const card = document.getElementById('favDeck_' + fid);
  if (card) card.classList.toggle('expanded', expandedFavFolders.has(fid));
}
function cycleFavDeck(fid, delta, count) {
  if (count <= 1) return;
  const cur = favDeckOffsets[fid] || 0;
  favDeckOffsets[fid] = (cur + delta + count) % count;
  renderFavoritesPage();
}
function renderFavoritesPage() {
  const kw = (document.getElementById('favSearchInput').value || '').trim().toLowerCase();
  const jobs = getJobs();
  const jobByBvid = new Map(jobs.map(j => [j.bvid, j]));
  const allFavs = getAllFavoritesMerged();
  const folders = libraryState.fav_folders || [];

  document.getElementById('favPageSub').textContent = folders.length + ' 个收藏文件夹 · 共收藏 ' + allFavs.length + ' 条内容 · 点击文件夹卡片下滑展开';
  const listEl = document.getElementById('favDeckList');
  if (!folders.length) {
    listEl.innerHTML = '<div class="reader-card" style="text-align:center;color:var(--muted);padding:44px">暂无收藏文件夹，点击右上角「+ 新建收藏夹」开始分类收藏。</div>';
    return;
  }

  favRenderPool = allFavs;
  const favIdxByBvid = new Map(allFavs.map((v, i) => [v.bvid, i]));

  const htmlParts = folders.map(f => {
    let items = allFavs.filter(v => getFavFolderIds(v.bvid).includes(f.id));
    if (kw) items = items.filter(v => (v.title || '').toLowerCase().includes(kw) || (v.author || '').toLowerCase().includes(kw) || (v.bvid || '').toLowerCase().includes(kw));
    if (kw && !items.length) return '';

    const isExp = expandedFavFolders.has(f.id) || Boolean(kw);
    const total = items.length;
    const offset = total ? ((favDeckOffsets[f.id] || 0) % total) : 0;

    // Build 3-layer stacked fan deck (newest, 2nd newest, 3rd newest rotated by offset)
    let deckHtml = '';
    if (total === 0) {
      deckHtml = '<div class="fan-card pos-0"><div class="fan-card-fb" style="border-top:3px solid ' + esc(f.color) + '">' + esc(f.name) + '</div></div>';
    } else {
      const showN = Math.min(3, total);
      for (let layer = showN - 1; layer >= 0; layer--) {
        const v = items[(offset + layer) % total];
        const pic = v.pic ? (v.pic.replace(/^http:\/\//, 'https://') + '@672w_378h_1c.webp') : '';
        deckHtml += '<div class="fan-card pos-' + layer + '">' +
          (pic ? '<img src="' + esc(pic) + '" referrerpolicy="no-referrer" loading="lazy" alt="">' : '<div class="fan-card-fb">' + esc(v.title || v.bvid) + '</div>') +
        '</div>';
      }
    }

    const navHtml = total > 1
      ? '<div class="fan-nav" onclick="event.stopPropagation()">' +
          '<button type="button" class="fan-nav-btn" title="上一张封面" onclick="cycleFavDeck(\'' + esc(f.id) + '\',-1,' + total + ')">&lsaquo;</button>' +
          '<span class="fan-nav-idx">' + (offset + 1) + '/' + total + '</span>' +
          '<button type="button" class="fan-nav-btn" title="下一张封面" onclick="cycleFavDeck(\'' + esc(f.id) + '\',1,' + total + ')">&rsaquo;</button>' +
        '</div>'
      : '';

    const previewsHtml = total
      ? items.slice(0, 3).map((v, i) => '<div class="fav-deck-pv"><span class="fav-deck-pv-num">0' + (i + 1) + '</span><span>' + esc(v.title || v.bvid) + '</span></div>').join('')
      : '<div class="fav-deck-pv" style="color:var(--muted)">暂无收藏内容，在视频封面或摘要页点星标即可收入</div>';

    const rowsHtml = total
      ? items.map(v => {
          const gIdx = favIdxByBvid.get(v.bvid) || 0;
          const matchedJob = jobByBvid.get(v.bvid);
          const hasSum = Boolean(matchedJob && normStatus(matchedJob.status) === 'completed' && matchedJob.summary);
          const coverUrl = v.pic ? (v.pic.replace(/^http:\/\//, 'https://') + '@672w_378h_1c.webp') : '';
          const excerpt = hasSum ? String(matchedJob.summary || '').replace(/[#*\x60>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 95) : '';
          const vUrl = v.url || ('https://www.bilibili.com/video/' + v.bvid);
          return '<div class="fav-item-row">' +
            '<a class="fav-item-thumb" href="' + esc(vUrl) + '" target="_blank" rel="noopener">' +
              (coverUrl ? '<img src="' + esc(coverUrl) + '" referrerpolicy="no-referrer" loading="lazy" alt="">' : '<div class="v-thumb-fallback" style="font-size:11.5px">' + esc(v.title || v.bvid) + '</div>') +
              (hasSum ? '<span class="v-sum-badge">已有摘要</span>' : '') +
              (v.duration ? '<span class="v-dur">' + esc(v.duration) + '</span>' : '') +
            '</a>' +
            '<div class="fav-item-mid">' +
              '<a class="fav-item-title" href="' + esc(vUrl) + '" target="_blank" rel="noopener">' + esc(v.title || v.bvid) + '</a>' +
              '<div class="fav-item-meta">' +
                (v.author ? '<span>UP主：' + esc(v.author) + '</span>' : '') +
                (v.duration ? '<span>· ' + esc(v.duration) + '</span>' : '') +
                '<span>· ' + esc(v.bvid) + '</span>' +
                (v.added_at ? '<span>· 收藏于 ' + esc(fmtShortDate(v.added_at)) + '</span>' : '') +
              '</div>' +
              (excerpt ? '<div class="fav-item-excerpt">' + esc(excerpt) + '</div>' : '') +
            '</div>' +
            '<div class="fav-item-acts">' +
              (hasSum ? '<button class="btn btn-sm btn-primary" onclick="selectJob(\'' + esc(matchedJob.id) + '\',true)">打开摘要</button>' : '<button class="btn btn-sm btn-primary" onclick="submitPoolVideo(\'fav\',' + gIdx + ')">一键总结</button>') +
              '<button class="btn btn-sm" onclick="openTagPopover(this,\'fav\',\'' + esc(v.bvid) + '\')">移动收藏夹</button>' +
              '<a class="btn btn-sm" href="' + esc(vUrl) + '" target="_blank" rel="noopener">原视频 ↗</a>' +
              '<button class="arch-ic-btn del" title="取消收藏" onclick="togglePoolVideoFav(\'fav\',' + gIdx + ')">' + SVG_TRASH_SM + '</button>' +
            '</div>' +
          '</div>';
        }).join('')
      : '<div style="text-align:center;color:var(--muted);padding:18px;font-size:12.5px">该收藏夹为空</div>';

    return '<div class="fav-deck-card' + (isExp ? ' expanded' : '') + '" id="favDeck_' + esc(f.id) + '">' +
      '<div class="fav-deck-head" onclick="toggleFavDeckExpand(\'' + esc(f.id) + '\')">' +
        '<div class="fan-deck-wrap" onclick="if(' + total + '>1){event.stopPropagation();cycleFavDeck(\'' + esc(f.id) + '\',1,' + total + ');}">' +
          '<div class="fan-deck">' + deckHtml + '</div>' +
          navHtml +
        '</div>' +
        '<div class="fav-deck-info">' +
          '<div class="fav-deck-title-row">' +
            '<span class="folder-dot" style="width:10px;height:10px;background:' + esc(f.color) + '"></span>' +
            '<span class="fav-deck-name">' + esc(f.name) + '</span>' +
            '<span class="fav-deck-cnt">' + total + ' 条收藏</span>' +
          '</div>' +
          '<div class="fav-deck-previews">' + previewsHtml + '</div>' +
        '</div>' +
        '<div class="fav-deck-right" onclick="event.stopPropagation()">' +
          '<button type="button" class="btn btn-sm" onclick="renameFolder(\'' + esc(f.id) + '\',\'fav\')">重命名</button>' +
          (folders.length > 1 ? '<button type="button" class="btn btn-sm" style="color:var(--err)" onclick="deleteFolder(\'' + esc(f.id) + '\',\'fav\')">删除</button>' : '') +
          '<button type="button" class="fav-deck-chev" onclick="toggleFavDeckExpand(\'' + esc(f.id) + '\')" title="展开 / 收起">' + SVG_CHEV + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="fav-deck-collapse"><div class="fav-deck-collapse-inner"><div class="fav-deck-items">' + rowsHtml + '</div></div></div>' +
    '</div>';
  }).filter(Boolean).join('');

  listEl.innerHTML = htmlParts || '<div class="reader-card" style="text-align:center;color:var(--muted);padding:44px">没有找到匹配的收藏内容</div>';
}

// ── PAGE 5: HISTORY ARCHIVE + KPI STATS ──
function setHistStatus(s) {
  histStatus = s;
  document.querySelectorAll('#histStatusTabs .seg-tab').forEach(b => b.classList.toggle('active', b.dataset.hf === s));
  moveSlider('histStatusTabs');
  renderHistoryPage();
}
function setHistFolder(fid) {
  histFolderFilter = histFolderFilter === fid ? '' : fid;
  renderHistoryPage();
}
function toggleHistBatchMode() {
  histBatchMode = !histBatchMode;
  histSelectedIds.clear();
  document.getElementById('histBatchBtn').textContent = histBatchMode ? '退出管理' : '批量管理';
  document.getElementById('histBatchActions').classList.toggle('hidden', !histBatchMode);
  renderHistoryPage();
}
function toggleHistSelect(id, checked) { if (checked) histSelectedIds.add(id); else histSelectedIds.delete(id); }
function histSelectAll() { getJobs().forEach(j => histSelectedIds.add(j.id)); renderHistoryPage(); }
function histInvertSelect() {
  const next = new Set();
  getJobs().forEach(j => { if (!histSelectedIds.has(j.id)) next.add(j.id); });
  histSelectedIds = next;
  renderHistoryPage();
}
function histDeleteSelected() {
  if (!histSelectedIds.size) return;
  if (!confirm('确定删除已选中的 ' + histSelectedIds.size + ' 条历史记录？')) return;
  const delSet = new Set(histSelectedIds);
  const jobs = getJobs().filter(j => !delSet.has(j.id));
  delSet.forEach(id => apiFetch('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {}));
  histSelectedIds.clear();
  if (delSet.has(selectedJobId)) selectedJobId = jobs[0] ? jobs[0].id : null;
  saveJobs(jobs);
  renderHistoryPage();
  toast('已批量删除');
}
function deleteOneJob(id) {
  if (!confirm('确定删除这条摘要记录？')) return;
  const jobs = getJobs().filter(j => j.id !== id);
  if (selectedJobId === id) selectedJobId = jobs[0] ? jobs[0].id : null;
  saveJobs(jobs);
  apiFetch('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
  renderHistoryPage();
  toast('已删除记录');
}

function buildArchiveCardHtml(j, showBatchChk) {
  const st = normStatus(j.status);
  const dotCls = st === 'completed' ? 'ok' : (st === 'failed' ? 'err' : 'pending');
  const stLabel = st === 'completed' ? '已完成' : (st === 'failed' ? '失败' : '处理中');
  const durSec = parseDurationSec(j.duration);
  const savedMin = (durSec >= 120 && st === 'completed') ? Math.max(1, Math.round(durSec / 60 * 0.85)) : 0;
  const excerpt = String(j.summary || '').replace(/[#*\x60>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 110);
  const tagPills = getJobTagIds(j).map(tid => {
    const f = getFolderById(tid);
    return f ? '<span class="mini-tag"><span class="folder-dot" style="width:5px;height:5px;background:' + esc(f.color) + '"></span>' + esc(f.name) + '</span>' : '';
  }).join('');
  const wlOn = isWatchLater(j.bvid), favOn = isJobFavorited(j);

  return '<div class="arch-card" onclick="selectJob(\'' + esc(j.id) + '\',true)">' +
    '<div class="arch-top">' +
      '<div style="display:flex;align-items:flex-start;gap:8px;min-width:0;flex:1">' +
        (showBatchChk ? '<input type="checkbox" style="margin-top:4px;accent-color:var(--brand)" ' + (histSelectedIds.has(j.id) ? 'checked' : '') + ' onclick="event.stopPropagation()" onchange="toggleHistSelect(\'' + esc(j.id) + '\',this.checked)">' : '') +
        '<div class="arch-title">' + esc(j.title || j.bvid) + '</div>' +
      '</div>' +
      '<span class="st-badge ' + dotCls + '" style="flex-shrink:0">' + stLabel + '</span>' +
    '</div>' +
    '<div class="arch-meta">' +
      (j.owner ? '<span>' + esc(j.owner) + '</span>' : '') +
      (j.duration ? '<span>· ' + esc(j.duration) + '</span>' : '') +
      (savedMin ? '<span style="color:var(--ok-text);font-weight:600">· 省约 ' + savedMin + ' 分钟</span>' : '') +
      '<span>· ' + esc(j.bvid || '') + '</span>' +
    '</div>' +
    (excerpt ? '<div class="arch-excerpt">' + esc(excerpt) + '</div>' : '') +
    (tagPills ? '<div class="mini-tags" style="margin-top:0">' + tagPills + '</div>' : '') +
    '<div class="arch-foot" onclick="event.stopPropagation()">' +
      '<span style="font-size:11.5px;color:var(--muted)">' + esc(fmtShortDate(j.created_at)) + '</span>' +
      '<div class="arch-acts">' +
        '<button type="button" class="arch-ic-btn" title="添加标签" onclick="openTagPopover(this,\'job\',\'' + esc(jobTagKey(j)) + '\')">' + SVG_TAG_SM + '</button>' +
        '<button type="button" class="arch-ic-btn' + (wlOn ? ' wl-on' : '') + '" title="稍后再看" onclick="toggleWatchLaterVideo({bvid:\'' + esc(j.bvid) + '\',job_id:\'' + esc(j.id) + '\',title:' + JSON.stringify(j.title || '') + ',author:' + JSON.stringify(j.owner || '') + ',duration:' + JSON.stringify(j.duration || '') + '})">' + SVG_CLOCK_SM + '</button>' +
        '<button type="button" class="arch-ic-btn' + (favOn ? ' fav-on' : '') + '" title="收藏" onclick="toggleFavoriteVideo({bvid:\'' + esc(j.bvid) + '\',job_id:\'' + esc(j.id) + '\',title:' + JSON.stringify(j.title || '') + ',author:' + JSON.stringify(j.owner || '') + ',duration:' + JSON.stringify(j.duration || '') + '})">' + SVG_STAR_LINE + '</button>' +
        '<button type="button" class="arch-ic-btn del" title="删除" onclick="deleteOneJob(\'' + esc(j.id) + '\')">' + SVG_TRASH_SM + '</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderHistoryPage() {
  const jobs = getJobs();
  const completed = jobs.filter(j => normStatus(j.status) === 'completed');
  const totalSec = completed.reduce((acc, j) => acc + parseDurationSec(j.duration), 0);
  const savedMin = Math.max(0, Math.round(totalSec / 60 * 0.85));
  const totalChars = completed.reduce((acc, j) => acc + (j.transcript || '').length, 0);
  const favCnt = (libraryState.favorites || []).length + jobs.filter(j => j.starred && !isFavBvid(j.bvid)).length;
  const wlCnt = (libraryState.watch_later || []).length;

  document.getElementById('kpiGrid').innerHTML =
    '<div class="kpi-card"><div class="kpi-label">已归档摘要</div><div class="kpi-val">' + completed.length + '</div><div class="kpi-sub">全部历史任务 ' + jobs.length + ' 条</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">累计节省时长</div><div class="kpi-val">' + savedMin + ' 分钟</div><div class="kpi-sub">约 ' + (savedMin / 60).toFixed(1) + ' 小时高效精读</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">收藏与稍后再看</div><div class="kpi-val">' + favCnt + ' / ' + wlCnt + '</div><div class="kpi-sub">云端 R2 实时同步</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">累计免费转录</div><div class="kpi-val">' + (totalChars >= 10000 ? (totalChars / 10000).toFixed(1) + ' 万字' : totalChars + ' 字') + '</div><div class="kpi-sub">100% 免费模型驱动</div></div>';

  // Folder filter bar
  const folders = libraryState.summary_folders || [];
  let fHtml = '<button class="folder-chip' + (!histFolderFilter ? ' active' : '') + '" onclick="setHistFolder(\'\')">全部标签</button>';
  folders.forEach(f => {
    const cnt = jobs.filter(j => getJobTagIds(j).includes(f.id)).length;
    fHtml += '<button class="folder-chip' + (histFolderFilter === f.id ? ' active' : '') + '" onclick="setHistFolder(\'' + esc(f.id) + '\')"><span class="folder-dot" style="background:' + esc(f.color) + '"></span><span>' + esc(f.name) + '</span>' + (cnt ? '<span class="folder-cnt">' + cnt + '</span>' : '') + '</button>';
  });
  document.getElementById('histFolderBar').innerHTML = fHtml;

  const kw = (document.getElementById('histSearchInput').value || '').trim().toLowerCase();
  let filtered = jobs;
  if (histStatus !== 'all') filtered = filtered.filter(j => normStatus(j.status) === histStatus);
  if (histFolderFilter) filtered = filtered.filter(j => getJobTagIds(j).includes(histFolderFilter));
  if (kw) filtered = filtered.filter(j => (j.title || '').toLowerCase().includes(kw) || (j.owner || '').toLowerCase().includes(kw) || (j.bvid || '').toLowerCase().includes(kw));

  document.getElementById('histPageSub').textContent = '共 ' + filtered.length + ' 条匹配记录 · 点击卡片直接进入摘要工作台精读';
  const grid = document.getElementById('histArchiveGrid');
  if (!filtered.length) {
    grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:42px">暂无匹配的历史归档记录</div>';
    return;
  }
  grid.innerHTML = filtered.map(j => buildArchiveCardHtml(j, histBatchMode)).join('');
}

// ── PAGE 6: GLOBAL TAG FOLDER AGGREGATION PAGE ──
function setFolderViewTab(tab) {
  folderViewTab = tab;
  document.querySelectorAll('#folderViewTabs .seg-tab').forEach(b => b.classList.toggle('active', b.dataset.fvt === tab));
  moveSlider('folderViewTabs');
  document.getElementById('folderSummariesPane').classList.toggle('hidden', tab !== 'summaries');
  document.getElementById('folderUpsPane').classList.toggle('hidden', tab !== 'ups');
  if (tab === 'ups' && activeFolderId) loadFolderUpsFeed(activeFolderId, false);
}

function renderFolderSummaries(fid) {
  const jobs = getJobs().filter(j => getJobTagIds(j).includes(fid));
  const grid = document.getElementById('folderSummariesGrid');
  if (!jobs.length) {
    grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:40px">该标签文件夹下暂无摘要。在任意摘要详情页或历史记录中点击标签图标即可归入本文件夹。</div>';
    return;
  }
  grid.innerHTML = jobs.map(j => buildArchiveCardHtml(j, false)).join('');
}

function renderFolderPage(fid, resetTab) {
  initFeedObservers();
  const scope = activeFolderScope === 'up' ? 'up' : 'summary';
  const f = getFolderById(fid, scope) || getFolderById(fid);
  if (!f) { navigate(scope === 'up' ? 'monitor' : 'history'); return; }
  const sumCnt = getJobs().filter(j => getJobTagIds(j).includes(fid)).length;
  const upCnt = (monitorConfig.up_list || []).filter(u => getUpTagIds(u.mid).includes(fid)).length;

  document.getElementById('topbarTitle').textContent = (scope === 'up' ? 'UP 分类 · ' : '摘要分类 · ') + f.name;
  document.getElementById('folderPageDot').style.background = f.color;
  document.getElementById('folderPageName').textContent = f.name;
  document.getElementById('folderPageSub').textContent = scope === 'up'
    ? ('UP 主分类 · 关联 ' + upCnt + ' 位监控 UP 主（支持向下滚动无限翻页）')
    : ('摘要工作台分类 · 已归档 ' + sumCnt + ' 篇 AI 摘要');

  const tabsEl = document.getElementById('folderViewTabs');
  if (tabsEl) tabsEl.classList.add('hidden');

  if (scope === 'up') {
    folderViewTab = 'ups';
    document.getElementById('folderSummariesPane').classList.add('hidden');
    document.getElementById('folderUpsPane').classList.remove('hidden');
    loadFolderUpsFeed(fid, false);
  } else {
    folderViewTab = 'summaries';
    document.getElementById('folderSummariesPane').classList.remove('hidden');
    document.getElementById('folderUpsPane').classList.add('hidden');
    renderFolderSummaries(fid);
  }
}

function renderFolderFeedFooter() {
  const footer = document.getElementById('folderFeedFooter');
  if (!footer) return;
  const count = folderFeedVideos.length;
  if (!count) { footer.innerHTML = ''; return; }
  if (folderPagination.loading) footer.innerHTML = '<button class="feed-load-btn" disabled>正在加载更早的视频...</button>';
  else if (folderPagination.hasMore) footer.innerHTML = '<button class="feed-load-btn" onclick="loadMoreFolderUpsFeed()">加载更多分类视频</button><div class="feed-meta-note">已加载 ' + count + ' 条</div>';
  else footer.innerHTML = '<div class="feed-meta-note">已加载全部 ' + count + ' 条分类视频</div>';
}

async function loadFolderUpsFeed(fid, forceRefresh) {
  const key = 'folder:' + fid;
  const grid = document.getElementById('folderUpsGrid');
  const ups = (monitorConfig.up_list || []).filter(u => getUpTagIds(u.mid).includes(fid));
  if (!ups.length) {
    folderFeedVideos = [];
    folderPagination = { key, pn: 1, hasMore: false, loading: false, total: 0 };
    grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:40px">该标签下暂无监控 UP 主。前往「监控 UP 主」点击 UP 主右侧标签图标即可归入本文件夹。</div>';
    renderFolderFeedFooter();
    return;
  }
  const cached = !forceRefresh ? readFeedCache(key) : null;
  if (cached && (Date.now() - cached.ts) < FEED_CACHE_TTL_MS) {
    folderFeedVideos = cached.videos.slice();
    folderPagination = { key, pn: cached.pn || 1, hasMore: Boolean(cached.hasMore), loading: false, total: cached.total || 0 };
    grid.innerHTML = folderFeedVideos.map((v, idx) => buildVideoCardHtml(v, idx, { pool: 'folder' })).join('');
    renderFolderFeedFooter();
    return;
  }
  folderPagination = { key, pn: 1, hasMore: false, loading: true, total: 0 };
  grid.innerHTML = renderSkeletonGrid();
  try {
    const r = await apiFetch(buildUpFeedApiUrl(key, 1, forceRefresh));
    const d = await r.json();
    const vids = (r.ok && d.videos) ? d.videos : [];
    folderFeedVideos = vids.slice();
    folderPagination = { key, pn: 1, hasMore: Boolean(d.has_more), loading: false, total: Number(d.total) || 0 };
    writeFeedCache(key, { videos: vids, pn: 1, hasMore: folderPagination.hasMore, total: folderPagination.total });
    grid.innerHTML = vids.length ? vids.map((v, idx) => buildVideoCardHtml(v, idx, { pool: 'folder' })).join('') : '<div class="reader-card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:36px">暂无公开视频</div>';
    renderFolderFeedFooter();
  } catch { folderPagination.loading = false; grid.innerHTML = '<div class="reader-card" style="grid-column:1/-1;color:var(--err-text)">动态拉取失败</div>'; }
}

async function loadMoreFolderUpsFeed() {
  const key = 'folder:' + activeFolderId;
  if (folderPagination.loading || !folderPagination.hasMore || folderPagination.key !== key) return;
  const nextPn = (folderPagination.pn || 1) + 1;
  folderPagination.loading = true; renderFolderFeedFooter();
  try {
    const r = await apiFetch(buildUpFeedApiUrl(key, nextPn, false));
    const d = await r.json();
    if (!r.ok || activeFolderId !== key.slice(7)) { folderPagination.loading = false; renderFolderFeedFooter(); return; }
    const seen = new Set(folderFeedVideos.map(v => v.bvid));
    const incoming = (d.videos || []).filter(v => v && v.bvid && !seen.has(v.bvid));
    const startIdx = folderFeedVideos.length;
    folderFeedVideos.push(...incoming);
    folderPagination.pn = nextPn;
    folderPagination.hasMore = Boolean(d.has_more) && incoming.length > 0;
    folderPagination.loading = false;
    if (incoming.length) document.getElementById('folderUpsGrid').insertAdjacentHTML('beforeend', incoming.map((v, i) => buildVideoCardHtml(v, startIdx + i, { pool: 'folder' })).join(''));
    writeFeedCache(key, { videos: folderFeedVideos.slice(), pn: folderPagination.pn, hasMore: folderPagination.hasMore, total: folderPagination.total });
    renderFolderFeedFooter();
  } catch { folderPagination.loading = false; renderFolderFeedFooter(); }
}

// ── Monitor Settings Modal (Schedule + Email Styles + Shy Cron) ──
async function openMonitorModal() {
  openModal('monitorModal');
  requestAnimationFrame(() => moveSlider('monitorTabs', true));
  await loadMonitorConfig();
}
function switchMonitorTab(tab) {
  document.querySelectorAll('#monitorTabs .seg-tab').forEach(b => b.classList.toggle('active', b.dataset.mtab === tab));
  moveSlider('monitorTabs');
  document.getElementById('mTabSchedule').classList.toggle('hidden', tab !== 'schedule');
  document.getElementById('mTabEmail').classList.toggle('hidden', tab !== 'email');
  if (tab === 'email') renderEmailPreview();
}
async function loadMonitorConfig() {
  try {
    const r = await apiFetch('/api/monitor-config');
    if (!r.ok) return;
    const d = await r.json();
    if (d.config) monitorConfig = d.config;
    hydrateMonitorForm();
    updateNavBadges();
    renderRailFolders();
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
  onScheduleModeChange(); renderTimeChips(); renderUpChips();
  selectEmailStyle(monitorConfig.email_style || 'editorial', true);
  const note = document.getElementById('cronSyncNote');
  if (monitorConfig.last_cron_sync) {
    const s = monitorConfig.last_cron_sync;
    note.textContent = s.ok ? ('已同步至 Shy Cron（任务 ID: ' + (s.task_id || 'bilisum-daily-monitor') + (s.next_run_at ? (' · 下次运行: ' + s.next_run_at) : '') + '）') : ('Shy Cron 同步提示：' + (s.error || s.reason || '未同步'));
  } else note.textContent = '保存后将自动同步至 Shy Cron (cron.shyapi.de5.net)';
}
function onScheduleModeChange() {
  const mode = document.getElementById('cfgScheduleMode').value;
  document.getElementById('timesInputWrap').classList.toggle('hidden', mode !== 'times');
  document.getElementById('timeChipList').classList.toggle('hidden', mode !== 'times');
  document.getElementById('customCronWrap').classList.toggle('hidden', mode !== 'custom');
  updateCronBadge();
}
function computeClientCron() {
  const mode = document.getElementById('cfgScheduleMode').value;
  if (mode === 'every_6h') return '0 */6 * * *';
  if (mode === 'every_12h') return '0 0,12 * * *';
  if (mode === 'custom') return (document.getElementById('cfgCustomCron').value || '').trim() || '0 0,12 * * *';
  const times = monitorConfig.times_cst || ['08:00', '20:00'];
  const parsed = times.map(t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? { h: (parseInt(m[1], 10) - 8 + 24) % 24, min: parseInt(m[2], 10) } : null; }).filter(Boolean);
  if (!parsed.length) return '0 0,12 * * *';
  const mins = parsed[0].min, hrs = [...new Set(parsed.map(p => p.h))].sort((a, b) => a - b);
  return mins + ' ' + hrs.join(',') + ' * * *';
}
function updateCronBadge() { document.getElementById('cronPreviewBadge').textContent = 'UTC Cron: ' + computeClientCron(); }
function renderTimeChips() {
  const times = monitorConfig.times_cst || [];
  document.getElementById('timeChipList').innerHTML = times.map((t, i) => '<span class="chip"><span>北京时间 ' + esc(t) + '</span><button type="button" onclick="removeTimeSlot(' + i + ')">&times;</button></span>').join('');
  updateCronBadge();
}
function addTimeSlot() {
  const val = (document.getElementById('newTimeInput').value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(val)) return;
  if (!monitorConfig.times_cst) monitorConfig.times_cst = [];
  if (!monitorConfig.times_cst.includes(val)) { monitorConfig.times_cst.push(val); monitorConfig.times_cst.sort(); }
  renderTimeChips();
}
function removeTimeSlot(idx) {
  monitorConfig.times_cst = (monitorConfig.times_cst || []).filter((_, i) => i !== idx);
  if (!monitorConfig.times_cst.length) monitorConfig.times_cst = ['08:00'];
  renderTimeChips();
}
function renderUpChips() {
  const ups = monitorConfig.up_list || [];
  document.getElementById('upCountSpan').textContent = String(ups.length);
  document.getElementById('upChipList').innerHTML = ups.map((u, i) => '<span class="chip"><span>' + esc(u.name || u.mid) + '</span><span class="chip-sub">' + esc(u.mid) + '</span><button type="button" onclick="removeUpCreator(' + i + ')">&times;</button></span>').join('');
}
function removeUpCreator(idx) { monitorConfig.up_list = (monitorConfig.up_list || []).filter((_, i) => i !== idx); renderUpChips(); }
async function addUpCreator() {
  const inp = document.getElementById('upAddInput'), q = inp.value.trim();
  if (!q) return;
  const btn = document.getElementById('upAddBtn'); btn.disabled = true; btn.textContent = '解析中...';
  try {
    const r = await apiFetch('/api/up-lookup?q=' + encodeURIComponent(q));
    const d = await r.json();
    if (!r.ok) { showToast('monitorToast', d.error || '解析失败', 'err'); return; }
    if (!monitorConfig.up_list) monitorConfig.up_list = [];
    if (!monitorConfig.up_list.some(x => Number(x.mid) === Number(d.mid))) monitorConfig.up_list.push({ mid: Number(d.mid), name: d.name || String(d.mid), face: d.face || '' });
    inp.value = ''; renderUpChips();
    showToast('monitorToast', '已添加 UP 主：' + (d.name || d.mid) + '（保存后生效）', 'ok');
  } catch (e) { showToast('monitorToast', '解析异常: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '解析并添加'; }
}
function selectEmailStyle(style, skipAnim) {
  monitorConfig.email_style = style || 'editorial';
  document.querySelectorAll('#emailStyleGrid .style-card').forEach(el => el.classList.toggle('selected', el.dataset.style === monitorConfig.email_style));
  const names = { editorial: '编辑部日报', minimal: '极简纸刊', bilibili: 'B站元气粉', compact: '极速速览' };
  document.getElementById('previewStyleName').textContent = names[monitorConfig.email_style] || '编辑部日报';
  renderEmailPreview();
}
function renderEmailPreview() {
  const st = monitorConfig.email_style || 'editorial', stage = document.getElementById('emailPreviewStage');
  const v1 = 'https://www.bilibili.com/video/BV149ypz6Ehs', v2 = 'https://www.bilibili.com/video/BV1ZssS6iEB9';
  const coverSample = 'https://i0.hdslb.com/bfs/archive/f994c1951c20cdf1c7f9a4ba2ae06d69253176b8.jpg@640w_360h_1c.jpg';
  const coverBox = '<a href="' + v1 + '" target="_blank" style="display:block;width:186px;flex-shrink:0;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;background:#f3f4f6"><img src="' + coverSample + '" referrerpolicy="no-referrer" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block" alt=""></a>';
  if (st === 'minimal') {
    stage.innerHTML = '<div style="width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px;color:#111827"><div style="border-bottom:2px solid #18181b;padding-bottom:10px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-end"><div><div style="font-size:10.5px;color:#6b7280">BILIBILI DAILY · 2026-11-21</div><div style="font-size:17px;font-weight:800;margin-top:2px">B站视频 AI 日报</div></div><span style="font-size:11px;color:#4b5563">桌面宽屏 · 共 2 支新视频</span></div><div style="margin-bottom:14px;padding:10px 12px;background:#f9fafb;border-radius:8px;font-size:12px"><div style="font-weight:700;margin-bottom:5px;color:#6b7280">本期速览</div><div>01 <a href="' + v1 + '" target="_blank" style="color:#111827;text-decoration:none"><strong>[波士顿圆脸]</strong> 前所未见：巴西亚马逊原始部落拖家带口现身求救</a></div><div>02 <a href="' + v2 + '" target="_blank" style="color:#111827;text-decoration:none"><strong>[刺客边风]</strong> 开源本地光猫配置解析工具实测</a></div></div><div style="border-top:1px solid #e5e7eb;padding-top:14px;display:flex;gap:16px;align-items:flex-start">' + coverBox + '<div style="flex:1;min-width:0"><div style="font-size:11.5px;color:#6b7280;margin-bottom:4px">#01 · 波士顿圆脸 · 11:16</div><div style="font-size:14.5px;font-weight:800;margin-bottom:8px"><a href="' + v1 + '" target="_blank" style="color:#111827;text-decoration:none">前所未见：巴西亚马逊原始部落拖家带口现身求救</a></div><div style="background:#f9fafb;border-left:3px solid #111827;padding:8px 11px;font-size:12px;color:#374151;line-height:1.6"><strong>核心主题：</strong>巴西亚马逊阿瓦原始部落罕见主动接触现代社会，折射雨林治理与文化保护难题。</div></div></div></div>';
  } else if (st === 'bilibili') {
    stage.innerHTML = '<div style="width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #fecdd3;color:#1f2937"><div style="background:linear-gradient(135deg,#fb7299,#ff85a7);padding:16px 20px;color:#fff;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:10.5px;opacity:.9">BILIBILI MONITOR · 2026-11-21</div><div style="font-size:18px;font-weight:800;margin-top:2px">B站视频 AI 日报</div></div><span style="background:rgba(255,255,255,.22);padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600">宽屏带封面 · 2 支新视频</span></div><div style="padding:16px 18px;background:#fff5f7"><div style="background:#fff;border-radius:10px;padding:14px;border:1px solid #ffe4e6;display:flex;gap:16px;align-items:flex-start">' + coverBox + '<div style="flex:1;min-width:0"><div style="font-size:11.5px;color:#db2777;font-weight:600;margin-bottom:4px">#01 · 波士顿圆脸 · 11:16</div><div style="font-size:14.5px;font-weight:800;margin-bottom:8px"><a href="' + v1 + '" target="_blank" style="color:#111827;text-decoration:none">前所未见：巴西亚马逊原始部落拖家带口现身求救</a></div><div style="background:#fff1f5;border-left:3px solid #fb7299;padding:8px 11px;font-size:12px;line-height:1.6"><strong>核心主题：</strong>阿瓦部落因生态恶化与外部侵扰现身求救，引发疾病免疫与保护区治理讨论。</div></div></div></div></div>';
  } else if (st === 'compact') {
    stage.innerHTML = '<div style="width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;color:#0f172a"><div style="background:#0f172a;border-top:3px solid #38bdf8;color:#fff;padding:13px 18px;display:flex;justify-content:space-between;align-items:center"><strong style="font-size:15px">B站视频速览 · 2026-11-21</strong><span style="font-size:11px;color:#7dd3fc">桌面宽屏 · 2 支更新</span></div><div style="padding:14px 16px;font-size:12.5px"><div style="display:flex;gap:14px;align-items:flex-start;padding-bottom:10px;border-bottom:1px solid #f1f5f9"><a href="' + v1 + '" target="_blank" style="display:block;width:146px;flex-shrink:0;border-radius:7px;overflow:hidden;border:1px solid #e2e8f0"><img src="' + coverSample + '" referrerpolicy="no-referrer" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block" alt=""></a><div style="flex:1;min-width:0"><div><span style="background:#e0f2fe;color:#0369a1;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700">波士顿圆脸</span> <a href="' + v1 + '" target="_blank" style="color:#0f172a;font-weight:700;text-decoration:none">前所未见：巴西亚马逊原始部落拖家带口现身求救</a></div><div style="color:#475569;margin-top:6px;font-size:12px;background:#f0f9ff;border-left:3px solid #0284c7;padding:6px 10px">阿瓦原始部落罕见接触现代社会，折射传染病与治理困境。</div></div></div></div></div>';
  } else {
    stage.innerHTML = '<div style="width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;color:#1e293b"><div style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:18px 22px;border-top:4px solid #fb7299;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:10px;color:#fb7299;font-weight:700;letter-spacing:1.2px">BILIBILI DAILY BRIEFING · 2026-11-21</div><div style="font-size:18px;font-weight:800;color:#fff;margin-top:3px">B站视频 AI 日报</div></div><span style="background:rgba(251,114,153,.18);color:#fda4af;border:1px solid rgba(251,114,153,.35);padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600">桌面宽屏 · 2 支新视频</span></div><div style="padding:16px 18px;background:#f8fafc"><div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:11px 14px;margin-bottom:12px;font-size:12px"><div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:6px">本期速览 · TABLE OF CONTENTS</div><div style="margin-bottom:4px"><strong style="color:#fb7299">01</strong> <a href="' + v1 + '" target="_blank" style="color:#0f172a;text-decoration:none">[波士顿圆脸] 前所未见：巴西亚马逊原始部落拖家带口现身求救</a></div><div><strong style="color:#fb7299">02</strong> <a href="' + v2 + '" target="_blank" style="color:#0f172a;text-decoration:none">[刺客边风] 开源本地光猫配置解析工具实测</a></div></div><div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:15px;display:flex;gap:16px;align-items:flex-start">' + coverBox + '<div style="flex:1;min-width:0"><div style="font-size:11.5px;color:#9ca3af;margin-bottom:4px">#01 · <span style="background:#fff1f5;color:#e11d48;padding:1px 7px;border-radius:999px;font-weight:600">波士顿圆脸</span> · 时长 11:16</div><div style="font-size:14.5px;font-weight:800;color:#0f172a;margin-bottom:8px"><a href="' + v1 + '" target="_blank" style="color:#0f172a;text-decoration:none">前所未见：巴西亚马逊原始部落拖家带口现身求救</a></div><div style="background:#fff5f7;border-left:3px solid #fb7299;padding:8px 11px;font-size:12px;line-height:1.6"><strong>核心主题：</strong>讲述亚马逊阿瓦原始部落主动接触现代文明的罕见事件及其引发的治理挑战。</div></div></div></div></div>';
  }
}
async function saveMonitorConfig() {
  const btn = document.getElementById('saveMonitorBtn'); btn.disabled = true; btn.textContent = '保存并同步中...';
  const payload = {
    enabled: document.getElementById('cfgEnabled').checked,
    schedule_mode: document.getElementById('cfgScheduleMode').value,
    times_cst: monitorConfig.times_cst || ['08:00', '20:00'],
    cron_utc: computeClientCron(),
    up_list: monitorConfig.up_list || [],
    email_style: monitorConfig.email_style || 'editorial',
    merge_emails: document.getElementById('cfgMergeEmails').checked,
    smtp_to: document.getElementById('cfgSmtpTo').value.trim(),
    check_window_hours: parseInt(document.getElementById('cfgWindowHours').value, 10) || 72,
    max_videos_per_run: parseInt(document.getElementById('cfgMaxVideos').value, 10) || 5,
  };
  try {
    const r = await apiFetch('/api/monitor-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!r.ok) { showToast('monitorToast', d.error || '保存失败', 'err'); return; }
    monitorConfig = d.config; hydrateMonitorForm();
    updateNavBadges(); renderRailFolders();
    if (currentRoute === 'monitor') { updateMonitorHeaderSummary(); renderUpSidebar(); }
    if (d.cron_sync && d.cron_sync.ok) showToast('monitorToast', '配置已保存并同步至 Shy Cron（' + d.cron_sync.cron_utc + '）', 'ok');
    else showToast('monitorToast', '已保存到 R2，Cron 同步提示：' + (d.cron_sync?.error || d.cron_sync?.reason || '未知'), 'err');
  } catch (e) { showToast('monitorToast', '保存异常: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '保存并同步定时任务'; }
}
async function triggerMonitorNow(toastId) {
  try {
    const r = await apiFetch('/api/monitor-run', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) showToast(toastId || 'monitorToast', d.error || '触发失败', 'err');
    else toast(d.message || '已触发后台监控任务');
  } catch (e) { toast('触发异常: ' + e.message, true); }
}

// ── Boot ──
initTheme();
initCustomSelects();
applyUserPrefsToUi();
initSliderObservers();
bootstrapAuth();
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
      if (path === '/api/auth/logout' && request.method === 'POST') return await handleLogout(request);
      if (path === '/api/monitor-config' && request.method === 'GET') return await handleGetMonitorConfig(request, env);
      if (path === '/api/monitor-config' && request.method === 'POST') return await handleSaveMonitorConfig(request, env);
      if (path === '/api/up-lookup' && request.method === 'GET') return await handleUpLookup(request, env);
      if (path === '/api/up-videos' && request.method === 'GET') return await handleGetUpVideos(request, env, ctx);
      if (path === '/api/monitor-archive' && request.method === 'GET') return await handleGetMonitorArchive(request, env);
      if (path === '/api/monitor-archive' && request.method === 'POST') return await handlePostMonitorArchive(request, env);
      if (path === '/api/cron-trigger' && (request.method === 'POST' || request.method === 'GET')) return await handleCronTrigger(request, env);
      if (path === '/api/monitor-run' && request.method === 'POST') return await handleManualMonitorRun(request, env);
      if (path === '/api/stats' && request.method === 'GET') return await handleStats(request, env);
      if (path === '/api/callback' && request.method === 'POST') return await handleCallback(request, env);
      if (path === '/' || path === '/index.html') return htmlResponse(generateFrontendPage());

      // Protected personal workspace APIs (require single-device persistent cookie or Bearer token)
      const authedPaths = ['/api/library', '/api/submit', '/api/history', '/api/jobs', '/api/resummarize', '/api/chat'];
      if (authedPaths.some(p => path === p || path.startsWith('/api/jobs/'))) {
        const sess = await verifySessionToken(request, env);
        if (!sess) return errorResponse('请先登录账号', 401);
      }

      if (path === '/api/library' && request.method === 'GET') return await handleGetLibrary(request, env);
      if (path === '/api/library' && request.method === 'POST') return await handleSaveLibrary(request, env);
      if (path === '/api/submit' && request.method === 'POST') return await handleSubmit(request, env, ctx);
      if (path === '/api/history' && request.method === 'GET') return await handleGetHistory(request, env);
      if (path === '/api/history' && request.method === 'POST') return await handlePostHistory(request, env);
      if (path === '/api/history' && request.method === 'DELETE') return await handleDeleteHistory(request, env);
      if (path === '/api/jobs' && request.method === 'GET') return await handleListJobs(request, env);
      if (path.startsWith('/api/jobs/') && request.method === 'GET') return await handleGetJob(request, env, path.replace('/api/jobs/', ''));
      if (path.startsWith('/api/jobs/') && request.method === 'DELETE') return await handleDeleteJob(request, env, path.replace('/api/jobs/', ''));
      if (path === '/api/resummarize' && request.method === 'POST') return await handleResummarize(request, env);
      if (path === '/api/chat' && request.method === 'POST') return await handleVideoChat(request, env);

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
