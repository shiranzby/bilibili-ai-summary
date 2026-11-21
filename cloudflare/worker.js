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
    { mid: 21131684, name: '刺客边风' },
    { mid: 448165099, name: '军情D7处' },
    { mid: 346563107, name: '波士顿圆脸' },
    { mid: 72275943, name: '古必的精读书柜' },
    { mid: 413486376, name: '十万个挑战' },
    { mid: 406636263, name: 'HOLA小测佬' },
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
  if (!env.BILIBILI_BUCKET) return { ...DEFAULT_MONITOR_CONFIG };
  try {
    const obj = await env.BILIBILI_BUCKET.get(MONITOR_CONFIG_KEY);
    if (!obj) return { ...DEFAULT_MONITOR_CONFIG };
    const saved = await obj.json();
    return { ...DEFAULT_MONITOR_CONFIG, ...saved };
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
        upList.push({
          mid,
          name: typeof item === 'object' && item.name ? String(item.name).slice(0, 60) : String(mid),
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
      return jsonResponse({ ok: true, mid: Number(mid), name: d.name || mid, fans: d.fans || 0 });
    }
    return jsonResponse({ ok: true, mid: Number(mid), name: mid, note: '未查到昵称，已按 UID 添加' });
  } catch {
    return jsonResponse({ ok: true, mid: Number(mid), name: mid, note: '昵称解析超时，已按 UID 添加' });
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

async function handleSubmit(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const url = body.url;
  const summary_template = body.summary_template || '';
  const custom_email = body.email || '';
  const email_style = body.email_style || 'editorial';
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

  const jobId = uuid();
  const job = {
    id: jobId, bvid, url: bvid, status: 'pending',
    created_at: nowISO(), updated_at: nowISO(),
    summary: null, title: '', error: '', email_style,
  };

  if (env.BILIBILI_BUCKET) {
    env.BILIBILI_BUCKET.put(`pending/${jobId}.json`, JSON.stringify(job), {
      httpMetadata: { contentType: 'application/json' },
    }).catch(() => {});
  }

  const inputs = { bvid, job_id: jobId };
  if (summary_template) inputs.summary_template = summary_template;
  if (custom_email) inputs.email = custom_email;
  if (email_style) inputs.email_style = email_style;

  try {
    const ghResp = await dispatchWorkflow(env, inputs);
    if (ghResp.status !== 204 && ghResp.status !== 201 && ghResp.status !== 200) {
      if (env.BILIBILI_BUCKET) cleanupExcessResults(env.BILIBILI_BUCKET).catch(() => {});
      return jsonResponse({
        job_id: jobId, bvid, status: 'pending',
        warning: 'GitHub Actions 触发可能失败: HTTP ' + ghResp.status,
      }, 201);
    }
    ctx.waitUntil(captureRunId(env, jobId));
  } catch (err) {
    console.error('GitHub dispatch error:', err.message);
  }

  if (env.BILIBILI_BUCKET) cleanupExcessResults(env.BILIBILI_BUCKET).catch(() => {});
  return jsonResponse({ job_id: jobId, bvid, status: 'pending' }, 201);
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
  const { job_id, bvid, status, summary, transcript, title, timings, owner, pubdate, duration } = body;
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
  --err:#EF4444;--err-soft:#FEF2F2;--err-text:#B91C1C;
  --warn:#F59E0B;--warn-soft:#FFFBEB;
  --shadow-sm:0 1px 2px rgba(16,24,40,.04);
  --shadow-md:0 4px 16px rgba(16,24,40,.06);
  --shadow-lg:0 20px 48px rgba(16,24,40,.14);
  --radius:12px;
}
[data-theme="dark"]{
  --bg:#0B0D12;--surface:#13161F;--surface-2:#1B202C;--surface-hover:#181C27;
  --border:rgba(255,255,255,.08);--border-strong:rgba(255,255,255,.15);
  --text:#F3F4F6;--soft:#CBD5E1;--muted:#6B7280;
  --brand:#FB7299;--brand-dark:#FDA4AF;--brand-soft:rgba(251,114,153,.13);--brand-border:rgba(251,114,153,.32);
  --cta:#FB7299;--cta-hover:#F43F7A;--cta-text:#FFFFFF;
  --ok:#10B981;--ok-soft:rgba(16,185,129,.14);--ok-text:#6EE7B7;
  --err:#F87171;--err-soft:rgba(239,68,68,.14);--err-text:#FCA5A5;
  --warn:#FBBF24;--warn-soft:rgba(245,158,11,.14);
  --shadow-sm:0 1px 2px rgba(0,0,0,.3);
  --shadow-md:0 4px 18px rgba(0,0,0,.35);
  --shadow-lg:0 24px 56px rgba(0,0,0,.6);
}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI','Microsoft YaHei',sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;overflow:hidden}
button,input,select,textarea{font-family:inherit;color:inherit}
button{cursor:pointer}
.hidden{display:none!important}

/* Layout */
.app{display:grid;grid-template-columns:var(--sidebar-w,340px) 1px 1fr;height:100vh}
.divider{background:var(--border);cursor:col-resize;position:relative;transition:background .15s}
.divider:hover,.divider.dragging{background:var(--brand)}
.divider::after{content:'';position:absolute;left:-4px;right:-4px;top:0;bottom:0}

/* Sidebar */
.sidebar{background:var(--surface);display:flex;flex-direction:column;height:100vh;overflow:hidden;padding:20px 18px 16px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.brand-icon{width:34px;height:34px;border-radius:10px;background:var(--brand);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 3px 10px rgba(251,114,153,.28)}
.brand-title{font-size:18px;font-weight:800;letter-spacing:-.2px;color:var(--text)}
.brand-sub{font-size:11px;color:var(--muted);margin-top:1px}

/* Submit box */
.input-shell{display:flex;align-items:center;gap:6px;background:var(--bg);border:1px solid var(--border);border-radius:11px;padding:4px 4px 4px 12px;transition:border-color .15s,box-shadow .15s}
.input-shell:focus-within{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.input-shell input{flex:1;min-width:0;border:none;background:transparent;font-size:13.5px;outline:none;padding:7px 0;color:var(--text)}
.input-shell input::placeholder{color:var(--muted)}
.btn-submit{border:none;background:var(--cta);color:var(--cta-text);padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;white-space:nowrap;transition:background .15s,transform .1s}
.btn-submit:hover{background:var(--cta-hover)}
.btn-submit:disabled{opacity:.5;cursor:not-allowed}

/* Advanced collapsible */
.adv-toggle{display:inline-flex;align-items:center;gap:5px;margin-top:10px;background:none;border:none;color:var(--soft);font-size:12.5px;font-weight:500;padding:4px 2px}
.adv-toggle:hover{color:var(--text)}
.adv-box{margin-top:8px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;gap:10px}
.field label{display:block;font-size:11.5px;font-weight:600;color:var(--soft);margin-bottom:4px}
.field input,.field select,.field textarea{width:100%;padding:7px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);outline:none}
.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--brand)}
.field textarea{min-height:70px;resize:vertical;line-height:1.5}

/* Status Toast inside sidebar */
.sb-toast{margin-top:10px;padding:8px 11px;border-radius:8px;font-size:12px;line-height:1.45;display:none}
.sb-toast.show{display:block}
.sb-toast.ok{background:var(--ok-soft);color:var(--ok-text)}
.sb-toast.err{background:var(--err-soft);color:var(--err-text)}
.sb-toast.info{background:var(--surface-2);color:var(--soft)}

/* History section */
.history-wrap{flex:1;min-height:0;display:flex;flex-direction:column;margin-top:16px;padding-top:14px;border-top:1px solid var(--border)}
.search-box{position:relative;margin-bottom:12px}
.search-box input{width:100%;padding:8px 12px 8px 32px;border:1px solid var(--border);border-radius:9px;background:var(--bg);font-size:13px;outline:none;color:var(--text)}
.search-box input:focus{border-color:var(--brand)}
.search-box .s-ic{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:13px;pointer-events:none}
.history-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 2px}
.history-head h3{font-size:12.5px;font-weight:700;color:var(--soft);display:flex;align-items:center;gap:6px}
.count-pill{font-size:11px;font-weight:600;color:var(--muted);background:var(--surface-2);padding:1px 7px;border-radius:999px}
.text-btn{background:none;border:none;font-size:12px;color:var(--muted);padding:2px 6px;border-radius:5px}
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
.h-title{font-size:13px;font-weight:600;line-height:1.4;color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:5px}
.h-meta{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;padding-top:3px}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot.ok{background:var(--ok)}
.dot.pending{background:var(--warn);animation:pulse 1.4s infinite}
.dot.err{background:var(--err)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.h-del{opacity:0;background:none;border:none;color:var(--muted);font-size:13px;padding:2px 5px;border-radius:5px;transition:opacity .12s,color .12s}
.h-card:hover .h-del{opacity:1}
.h-del:hover{color:var(--err);background:var(--err-soft)}
.h-chk{margin-top:3px;accent-color:var(--brand)}

/* Main Workspace */
.main{display:flex;flex-direction:column;height:100vh;overflow:hidden;background:var(--bg)}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 28px;border-bottom:1px solid var(--border);background:var(--bg);flex-shrink:0}
.stepper{display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:7px 14px;font-size:12.5px;overflow-x:auto;max-width:100%}
.st-item{display:inline-flex;align-items:center;gap:5px;color:var(--muted);white-space:nowrap;font-weight:500}
.st-item.done{color:var(--text)}
.st-item.done .st-ic{color:var(--ok)}
.st-item.active{color:var(--brand-dark);font-weight:600}
.st-item.final-done{background:var(--ok-soft);color:var(--ok-text);padding:2px 10px;border-radius:999px;font-weight:600}
.st-item.final-err{background:var(--err-soft);color:var(--err-text);padding:2px 10px;border-radius:999px;font-weight:600}
.st-arrow{color:var(--muted);font-size:12px;opacity:.6}

.topbar-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:auto}
.pill-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);font-size:12.5px;font-weight:600;transition:border-color .15s,background .15s}
.pill-btn:hover{border-color:var(--border-strong);background:var(--surface-hover)}
.pill-btn.authed{border-color:var(--brand-border);background:var(--brand-soft);color:var(--brand-dark)}
.icon-btn{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--soft);font-size:15px}
.icon-btn:hover{border-color:var(--border-strong);color:var(--text)}

.content-scroll{flex:1;overflow-y:auto;padding:22px 28px 40px}
.content-inner{max-width:960px;margin:0 auto}

/* Empty State */
.empty-state{margin:60px auto;max-width:480px;text-align:center;padding:40px 28px;background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-sm)}
.empty-ic{width:54px;height:54px;margin:0 auto 14px;border-radius:14px;background:var(--brand-soft);color:var(--brand);display:flex;align-items:center;justify-content:center;font-size:26px}
.empty-state h2{font-size:18px;font-weight:700;margin-bottom:8px}
.empty-state p{font-size:13.5px;color:var(--soft);line-height:1.65}

/* Video Header Card */
.video-head{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px 22px;margin-bottom:16px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;box-shadow:var(--shadow-sm)}
.vh-left{min-width:0;flex:1}
.vh-title{font-size:19px;font-weight:800;line-height:1.4;color:var(--text);margin-bottom:11px;word-break:break-word}
.vh-pills{display:flex;flex-wrap:wrap;gap:7px}
.meta-pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;background:var(--surface-2);color:var(--soft);font-size:12px;font-weight:500}
.watch-btn{display:inline-flex;align-items:center;gap:5px;padding:8px 14px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);font-size:12.5px;font-weight:600;text-decoration:none;white-space:nowrap;transition:border-color .15s,background .15s}
.watch-btn:hover{border-color:var(--brand);color:var(--brand)}

/* Segmented Tabs + Export Toolbar */
.view-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.seg-tabs{display:inline-flex;background:var(--surface-2);padding:3px;border-radius:10px;border:1px solid var(--border)}
.seg-tab{border:none;background:transparent;padding:6px 13px;border-radius:7px;font-size:13px;font-weight:600;color:var(--soft);display:inline-flex;align-items:center;gap:5px;transition:all .15s}
.seg-tab.active{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm)}
.export-group{display:inline-flex;background:var(--surface);border:1px solid var(--border);border-radius:9px;overflow:hidden}
.exp-btn{border:none;background:transparent;padding:6px 12px;font-size:12.5px;font-weight:500;color:var(--soft);border-right:1px solid var(--border);display:inline-flex;align-items:center;gap:4px}
.exp-btn:last-child{border-right:none}
.exp-btn:hover{background:var(--surface-2);color:var(--text)}

/* Reading Panels */
.reader-grid{display:grid;grid-template-columns:1fr;gap:16px}
.reader-grid.split{grid-template-columns:1.15fr 1fr;align-items:start}
.reader-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px 26px;box-shadow:var(--shadow-sm)}
.panel-label{font-size:11.5px;font-weight:700;letter-spacing:.7px;color:var(--muted);text-transform:uppercase;margin-bottom:14px}

/* Rendered Rich Summary */
.md-theme-box{background:var(--brand-soft);border-left:3.5px solid var(--brand);border-radius:0 10px 10px 0;padding:15px 18px;margin-bottom:22px}
.md-theme-label{font-size:12px;font-weight:700;color:var(--brand-dark);letter-spacing:.4px;margin-bottom:6px}
.md-theme-body{font-size:14.5px;line-height:1.75;color:var(--text);font-weight:500}
.md-sec-title{font-size:16px;font-weight:800;color:var(--text);margin:20px 0 12px;letter-spacing:-.1px}
.md-list{list-style:none;display:flex;flex-direction:column;gap:11px;margin-bottom:20px}
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

/* Modals */
.modal-backdrop{position:fixed;inset:0;background:rgba(10,12,18,.55);backdrop-filter:blur(4px);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-lg);width:100%;max-width:420px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden}
.modal.wide{max-width:860px}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border)}
.modal-head h2{font-size:16.5px;font-weight:800}
.modal-body{padding:20px 22px;overflow-y:auto;flex:1}
.modal-foot{padding:14px 22px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--bg)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 15px;border-radius:9px;font-size:13px;font-weight:600;border:1px solid var(--border);background:var(--surface);color:var(--text)}
.btn:hover{background:var(--surface-hover)}
.btn-primary{background:var(--cta);color:var(--cta-text);border-color:transparent}
.btn-primary:hover{background:var(--cta-hover)}
.btn-brand{background:var(--brand);color:#fff;border-color:transparent}
.btn-brand:hover{opacity:.92}

/* Monitor Modal specifics */
.m-tabs{display:flex;gap:6px;margin-bottom:18px;border-bottom:1px solid var(--border);padding-bottom:10px}
.m-tab{border:none;background:transparent;padding:7px 14px;border-radius:8px;font-size:13px;font-weight:600;color:var(--soft)}
.m-tab.active{background:var(--brand-soft);color:var(--brand-dark)}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.form-section{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:15px 16px;margin-bottom:14px}
.form-section h4{font-size:13px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
.chip-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:12.5px}
.chip b{font-weight:600;color:var(--text)}
.chip small{color:var(--muted);font-family:Consolas,monospace;font-size:11px}
.chip button{border:none;background:none;color:var(--muted);font-size:14px;line-height:1;padding:0 2px}
.chip button:hover{color:var(--err)}
.inline-add{display:flex;gap:8px;align-items:center}
.inline-add input{flex:1}
.switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.switch-row input[type=checkbox]{width:18px;height:18px;accent-color:var(--brand);cursor:pointer}
.cron-badge{font-family:Consolas,monospace;font-size:12px;padding:3px 9px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--brand-dark)}

/* Email Style Selector + Visual Thumbnails */
.style-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
.style-card{border:2px solid var(--border);border-radius:11px;padding:8px;background:var(--surface);cursor:pointer;transition:all .15s;text-align:left}
.style-card:hover{border-color:var(--border-strong)}
.style-card.selected{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.style-thumb{height:68px;border-radius:7px;overflow:hidden;border:1px solid var(--border);margin-bottom:7px;display:flex;flex-direction:column}
.st-hd{height:20px;padding:4px 6px;display:flex;align-items:center;gap:4px}
.st-bar{height:4px;border-radius:2px;width:45%}
.st-bd{flex:1;padding:5px 6px;display:flex;flex-direction:column;gap:4px}
.st-line{height:4px;border-radius:2px;background:#e5e7eb}
.style-name{font-size:12.5px;font-weight:700;color:var(--text)}
.style-desc{font-size:11px;color:var(--muted);margin-top:2px}
.email-preview-frame{width:100%;height:360px;border:1px solid var(--border);border-radius:10px;background:#fff}

/* Responsive */
@media(max-width:960px){
  html,body{overflow:auto;height:auto}
  .app{grid-template-columns:1fr;height:auto;min-height:100vh}
  .sidebar{height:auto;overflow:visible;border-bottom:1px solid var(--border)}
  .history-list{max-height:260px}
  .divider{display:none}
  .main{height:auto;overflow:visible}
  .topbar{padding:12px 16px;flex-wrap:wrap}
  .content-scroll{padding:16px}
  .video-head{flex-direction:column}
  .reader-grid.split{grid-template-columns:1fr}
  .style-grid{grid-template-columns:repeat(2,1fr)}
  .form-row{grid-template-columns:1fr}
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

    <div class="input-shell">
      <input id="videoUrl" type="text" placeholder="输入B站视频链接或 BV 号..." autocomplete="off">
      <button class="btn-submit" id="submitBtn" onclick="submitVideo()">开始总结</button>
    </div>

    <button class="adv-toggle" type="button" onclick="toggleAdv()">
      <span id="advArrow">▸</span> 高级配置（模板 / 邮箱 / 样式）
    </button>

    <div class="adv-box hidden" id="advBox">
      <div class="field">
        <label>总结模板</label>
        <select id="tplPreset" onchange="onTplPreset()">
          <option value="">默认精炼日报模板</option>
          <option value="notes">深度结构化笔记</option>
          <option value="quotes">金句与核心观点提取</option>
          <option value="custom">自定义提示词模板</option>
        </select>
      </div>
      <div class="field hidden" id="customTplWrap">
        <label>自定义模板（含 {content} 占位符）</label>
        <textarea id="customTpl" placeholder="请根据以下视频内容提取核心干货：\n{content}"></textarea>
      </div>
      <div class="field">
        <label>单条结果接收邮箱（可选）</label>
        <input id="customEmail" type="email" placeholder="留空则发至默认邮箱">
      </div>
      <div class="field">
        <label>单条邮件样式</label>
        <select id="singleEmailStyle">
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
        <span class="s-ic">🔍</span>
        <input id="searchInput" type="text" placeholder="搜索历史记录..." oninput="renderList()">
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
  </aside>

  <div class="divider" id="divider"></div>

  <!-- RIGHT MAIN PANEL -->
  <main class="main">
    <header class="topbar">
      <div class="stepper hidden" id="stepperBar"></div>
      <div class="topbar-actions">
        <button class="pill-btn" id="monitorBtn" onclick="openMonitorEntry()">
          <span id="monitorBtnIcon">🔐</span>
          <span id="monitorBtnText">登录 · 监控与日报设置</span>
        </button>
        <button class="icon-btn" id="themeBtn" onclick="toggleTheme()" title="切换浅色 / 暗色主题">🌙</button>
      </div>
    </header>

    <div class="content-scroll">
      <div class="content-inner">
        <div class="empty-state" id="emptyState">
          <div class="empty-ic">🎬</div>
          <h2>粘贴 B 站链接，一键提炼视频精华</h2>
          <p>支持直接粘贴 B 站完整链接、分享文案或 BV 号。系统将自动提取音频、免费语音转文字并生成结构化日报摘要；登录后还可配置 UP 主定时监控与多套精美邮件样式。</p>
        </div>

        <div id="detailView" class="hidden">
          <section class="video-head">
            <div class="vh-left">
              <h1 class="vh-title" id="dTitle">—</h1>
              <div class="vh-pills" id="dPills"></div>
            </div>
            <a class="watch-btn" id="dWatchLink" href="#" target="_blank" rel="noopener">在B站观看 ↗</a>
          </section>

          <div class="view-bar">
            <div class="seg-tabs" id="segTabs">
              <button class="seg-tab active" data-mode="summary" onclick="setViewMode('summary')">✨ AI 总结</button>
              <button class="seg-tab" data-mode="transcript" onclick="setViewMode('transcript')">📝 完整转录</button>
              <button class="seg-tab" data-mode="split" onclick="setViewMode('split')">⚡ 分栏对照</button>
            </div>
            <div class="export-group">
              <button class="exp-btn" onclick="copyCurrent()">📋 复制</button>
              <button class="exp-btn" onclick="exportFile('md')">导出 MD</button>
              <button class="exp-btn" onclick="exportFile('txt')">TXT</button>
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
    </div>
  </main>
</div>

<!-- LOGIN MODAL -->
<div class="modal-backdrop hidden" id="loginModal" onclick="if(event.target===this)closeModal('loginModal')">
  <div class="modal">
    <div class="modal-head">
      <h2>🔐 管理员登录</h2>
      <button class="icon-btn" onclick="closeModal('loginModal')">✕</button>
    </div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--soft);margin-bottom:14px;line-height:1.6">
        登录后可在页面直接配置 UP 主监控名单、定时任务时间（自动同步至 Shy Cron）以及自定义日报邮件样式。
      </p>
      <div class="field" style="margin-bottom:12px">
        <label>账号</label>
        <input id="loginUser" type="text" placeholder="请输入管理员账号" value="shiran">
      </div>
      <div class="field">
        <label>密码</label>
        <input id="loginPass" type="password" placeholder="请输入管理员密码" onkeydown="if(event.key==='Enter')doLogin()">
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
        <h2>⚙️ 监控与日报样式配置</h2>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">配置保存在 Cloudflare R2，定时策略自动同步至 Shy Cron</div>
      </div>
      <button class="icon-btn" onclick="closeModal('monitorModal')">✕</button>
    </div>
    <div class="modal-body">
      <div class="m-tabs">
        <button class="m-tab active" data-mtab="schedule" onclick="switchMonitorTab('schedule')">🕒 定时与 UP 主监控</button>
        <button class="m-tab" data-mtab="email" onclick="switchMonitorTab('email')">🎨 邮件样式与实时预览</button>
      </div>

      <!-- TAB 1: SCHEDULE & UPs -->
      <div id="mTabSchedule">
        <div class="form-section">
          <div class="switch-row">
            <div>
              <div style="font-size:14px;font-weight:700">启用自动定时监控</div>
              <div style="font-size:12px;color:var(--muted);margin-top:2px">开启后将通过 Shy Cron 按设定时间自动触发 GitHub Actions 抓取新视频</div>
            </div>
            <input type="checkbox" id="cfgEnabled" checked>
          </div>
        </div>

        <div class="form-section">
          <h4>
            <span>定时运行计划（北京时间 UTC+8）</span>
            <span class="cron-badge" id="cronUtcPreview">UTC: 0 0,12 * * *</span>
          </h4>
          <div class="form-row">
            <div class="field">
              <label>调度模式</label>
              <select id="cfgScheduleMode" onchange="onScheduleModeChange()">
                <option value="times">指定每天运行时间（北京时间）</option>
                <option value="every_12h">每 12 小时（08:00 / 20:00）</option>
                <option value="every_6h">每 6 小时运行一次</option>
                <option value="custom">自定义 5 位 UTC Cron 表达式</option>
              </select>
            </div>
            <div class="field" id="customCronWrap" style="display:none">
              <label>UTC Cron 表达式（5位）</label>
              <input id="cfgCustomCron" type="text" placeholder="0 0,12 * * *" oninput="updateCronPreview()">
            </div>
            <div class="field" id="timeAddWrap">
              <label>添加每日运行时间点（同分钟）</label>
              <div class="inline-add">
                <input id="newTimeInput" type="time" value="08:00">
                <button class="btn" type="button" onclick="addTimeSlot()">+ 添加</button>
              </div>
            </div>
          </div>
          <div class="chip-list" id="timeChips"></div>
          <div id="cronSyncStatus" style="margin-top:10px;font-size:12px;color:var(--muted)"></div>
        </div>

        <div class="form-section">
          <h4>监控 UP 主列表（<span id="upCountLabel">0</span> 位）</h4>
          <div class="inline-add" style="margin-bottom:8px">
            <input id="newUpInput" type="text" placeholder="输入 UP 主 UID 或主页链接（如 346563107 或 https://space.bilibili.com/346563107）" onkeydown="if(event.key==='Enter')addUpCreator()">
            <button class="btn btn-primary" type="button" id="addUpBtn" onclick="addUpCreator()">解析并添加</button>
          </div>
          <div class="chip-list" id="upChips"></div>
        </div>

        <div class="form-row">
          <div class="field">
            <label>扫描时间窗口</label>
            <select id="cfgWindowHours">
              <option value="24">最近 24 小时</option>
              <option value="48">最近 48 小时</option>
              <option value="72">最近 72 小时（3天）</option>
              <option value="168">最近 7 天</option>
            </select>
          </div>
          <div class="field">
            <label>单次每位 UP 主最多处理条数</label>
            <select id="cfgMaxVideos">
              <option value="3">最多 3 支</option>
              <option value="5">最多 5 支</option>
              <option value="10">最多 10 支</option>
            </select>
          </div>
        </div>
      </div>

      <!-- TAB 2: EMAIL STYLES & LIVE PREVIEW -->
      <div id="mTabEmail" class="hidden">
        <div class="form-section">
          <h4>选择日报邮件样式（开源多风格 · 点击卡片实时预览）</h4>
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

          <div class="form-row" style="margin-bottom:0">
            <div class="switch-row" style="padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:9px">
              <span style="font-size:12.5px;font-weight:600">多 UP 主合并为同一封日报</span>
              <input type="checkbox" id="cfgMergeEmails" checked onchange="renderEmailPreview()">
            </div>
            <div class="field">
              <input id="cfgSmtpTo" type="email" placeholder="自定义收件邮箱（留空用默认 Secret）">
            </div>
          </div>
        </div>

        <div style="font-size:12px;font-weight:700;color:var(--soft);margin-bottom:8px">实时仿真日报预览（所见即所得）</div>
        <iframe id="emailPreviewFrame" class="email-preview-frame" title="邮件样式预览"></iframe>
      </div>

      <div class="sb-toast" id="monitorToast"></div>
    </div>
    <div class="modal-foot">
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" type="button" onclick="doLogout()">退出登录</button>
        <button class="btn" type="button" id="runNowBtn" onclick="triggerMonitorNow()">⚡ 立即运行一次监控</button>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" type="button" onclick="closeModal('monitorModal')">关闭</button>
        <button class="btn btn-brand" type="button" id="saveMonitorBtn" onclick="saveMonitorConfig()">💾 保存并同步定时任务</button>
      </div>
    </div>
  </div>
</div>

<script>
const LS_JOBS = 'bilisum_jobs_v3';
const LS_THEME = 'bilisum_theme_v3';
const LS_AUTH = 'bilisum_auth_token';
const LS_USER = 'bilisum_auth_user';

let selectedJobId = null;
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

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(elId, msg, kind) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = 'sb-toast show ' + (kind || 'info');
  if (kind === 'ok') setTimeout(() => { el.classList.remove('show'); }, 4500);
}

// ── Theme ──
function initTheme() {
  const saved = localStorage.getItem(LS_THEME) || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('themeBtn').textContent = saved === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(LS_THEME, next);
  document.getElementById('themeBtn').textContent = next === 'dark' ? '☀️' : '🌙';
}

// ── Sidebar Divider Drag ──
(function initDivider() {
  const div = document.getElementById('divider');
  let dragging = false;
  div.addEventListener('mousedown', () => { dragging = true; div.classList.add('dragging'); document.body.style.userSelect = 'none'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.max(260, Math.min(520, e.clientX));
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
  const open = box.classList.toggle('hidden');
  document.getElementById('advArrow').textContent = open ? '▸' : '▾';
}
function onTplPreset() {
  const v = document.getElementById('tplPreset').value;
  document.getElementById('customTplWrap').classList.toggle('hidden', v !== 'custom');
}

// ── Jobs Storage (LocalStorage + R2 sync) ──
function getJobs() {
  try { return JSON.parse(localStorage.getItem(LS_JOBS) || localStorage.getItem('b2t_jobs_v2') || '[]'); }
  catch { return []; }
}
function saveJobs(jobs, syncR2 = true) {
  localStorage.setItem(LS_JOBS, JSON.stringify(jobs));
  renderList();
  if (syncR2) {
    fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobs: jobs.slice(0, 100) }),
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
    remote.forEach(j => { if (j && j.id) map.set(j.id, j); });
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

// ── Submit Video ──
async function submitVideo() {
  const input = document.getElementById('videoUrl');
  const raw = input.value.trim();
  if (!raw) { showToast('sbToast', '请输入 B 站视频链接或 BV 号', 'err'); return; }

  const preset = document.getElementById('tplPreset').value;
  let tpl = '';
  if (preset === 'custom') tpl = document.getElementById('customTpl').value.trim();
  else if (TPL_PRESETS[preset]) tpl = TPL_PRESETS[preset];

  const email = document.getElementById('customEmail').value.trim();
  const email_style = document.getElementById('singleEmailStyle').value || 'editorial';

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = '提交中…';

  try {
    const resp = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: raw, summary_template: tpl, email, email_style }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      showToast('sbToast', data.error || '提交失败', 'err');
      return;
    }
    const newJob = {
      id: data.job_id,
      bvid: data.bvid,
      title: data.bvid,
      status: 'pending',
      created_at: new Date().toISOString(),
      video_url: 'https://www.bilibili.com/video/' + data.bvid,
    };
    const jobs = [newJob, ...getJobs().filter(j => j.id !== newJob.id)];
    saveJobs(jobs);
    input.value = '';
    showToast('sbToast', '已提交处理队列，约 30~60 秒完成', 'ok');
    selectJob(newJob.id);
    startPolling(newJob.id);
  } catch (e) {
    showToast('sbToast', '网络错误: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '开始总结';
  }
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
    const active = j.id === selectedJobId ? ' active' : '';
    const dotCls = j.status === 'completed' ? 'ok' : (j.status === 'failed' ? 'err' : 'pending');
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
        (!batchMode ? '<button class="h-del" title="删除" onclick="event.stopPropagation();deleteOneJob(\'' + esc(j.id) + '\')">✕</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

function selectJob(id) {
  selectedJobId = id;
  const job = getJobs().find(j => j.id === id);
  renderList();
  if (!job) return;
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('detailView').classList.remove('hidden');
  renderDetail(job);
  if (job.status === 'pending' || job.status === 'submitted') startPolling(job.id);
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
  if (c.length <= 18) {
    if (c.includes('核心主题') || c.includes('核心观点') || c.includes('一句话总结')) return 'theme';
    if (c.includes('要点提炼') || c.includes('核心要点') || c.includes('关键要点')) return 'points';
    if (c.includes('总结') || c.includes('结语')) return 'conclusion';
  }
  return null;
}

function renderRichSummary(md) {
  if (!md || !md.trim()) {
    return '<div class="pending-banner">暂无 AI 总结内容</div>';
  }
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let cur = { kind: 'body', lines: [] };

  function pushCur() {
    if (cur.lines.length) sections.push(cur);
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^[-*_]{3,}$/.test(line)) continue;
    if (/^#\s+/.test(line) && !line.startsWith('##')) continue;

    const kind = detectSectionKind(line);
    if (kind) {
      pushCur();
      cur = { kind, lines: [] };
      continue;
    }
    const inlineSec = line.match(/^(?:[-*•]\s*)?(?:[📌📋💡🎯✨]\s*)?\*\*(核心主题|要点提炼|总结|核心观点)\*\*\s*[:：]\s*(.+)$/);
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

// ── Detail View & Stepper ──
function renderStepper(job) {
  const bar = document.getElementById('stepperBar');
  bar.classList.remove('hidden');
  let steps = job.gh_steps;
  if (!steps) {
    const doneAll = job.status === 'completed';
    const fail = job.status === 'failed';
    steps = [
      { name: '任务创建', done: true, active: false },
      { name: '下载音频', done: doneAll, active: !doneAll && !fail },
      { name: '语音转录', done: doneAll, active: false },
      { name: 'AI总结', done: doneAll, active: false },
      { name: '完成', done: doneAll, failed: fail },
    ];
  }
  bar.innerHTML = steps.map((s, i) => {
    const isLast = i === steps.length - 1;
    let cls = 'st-item';
    let icon = '○';
    if (isLast && s.done) { cls += ' final-done'; icon = '✓'; }
    else if (isLast && s.failed) { cls += ' final-err'; icon = '✕'; }
    else if (s.done) { cls += ' done'; icon = '✓'; }
    else if (s.active) { cls += ' active'; icon = '●'; }
    return '<span class="' + cls + '"><span class="st-ic">' + icon + '</span> ' + esc(s.name) + '</span>' +
      (isLast ? '' : '<span class="st-arrow">→</span>');
  }).join('');
}

function renderDetail(job) {
  renderStepper(job);
  document.getElementById('dTitle').textContent = job.title || job.bvid || '处理中…';
  document.getElementById('dWatchLink').href = job.video_url || ('https://www.bilibili.com/video/' + job.bvid);

  const pills = [];
  if (job.owner) pills.push('UP主: ' + job.owner);
  if (job.duration) pills.push('⏱ ' + job.duration);
  if (job.bvid) pills.push(job.bvid);
  if (job.timings && job.timings.total) pills.push('⚡ 耗时 ' + job.timings.total + 's');
  else if (job.created_at) pills.push(fmtShortDate(job.created_at));
  document.getElementById('dPills').innerHTML = pills.map(p => '<span class="meta-pill">' + esc(p) + '</span>').join('');

  if (job.status === 'pending' || job.status === 'submitted') {
    document.getElementById('summaryContent').innerHTML = '<div class="pending-banner">⏳ GitHub Actions 正在提取音频、免费语音转文字并生成 AI 摘要，页面会自动刷新…</div>';
    document.getElementById('transcriptContent').textContent = '等待转录完成…';
  } else if (job.status === 'failed') {
    document.getElementById('summaryContent').innerHTML = '<div class="pending-banner" style="color:var(--err-text)">❌ 处理失败：' + esc(job.error || '未能获取视频文字内容') + '</div>';
    document.getElementById('transcriptContent').textContent = job.transcript || '无转录内容';
  } else {
    document.getElementById('summaryContent').innerHTML = renderRichSummary(job.summary || '');
    document.getElementById('transcriptContent').textContent = job.transcript || '（该任务无语音转录文本）';
  }
  applyViewMode();
}

function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('#segTabs .seg-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  applyViewMode();
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
  navigator.clipboard.writeText(txt).then(() => showToast('sbToast', '已复制到剪贴板', 'ok')).catch(() => {});
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

// ── Auth & Modals ──
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function getAuthToken() { return localStorage.getItem(LS_AUTH) || ''; }

async function checkAuth() {
  const tok = getAuthToken();
  if (!tok) { updateAuthUi(''); return; }
  try {
    const r = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + tok } });
    const d = await r.json();
    if (d.authenticated) { updateAuthUi(d.username); }
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
    ic.textContent = '⚙️';
    tx.textContent = authUser + ' · 监控与日报设置';
  } else {
    btn.classList.remove('authed');
    ic.textContent = '🔐';
    tx.textContent = '登录 · 监控与日报设置';
  }
}

async function openMonitorEntry() {
  if (!authUser) {
    openModal('loginModal');
    setTimeout(() => document.getElementById('loginPass').focus(), 60);
    return;
  }
  openModal('monitorModal');
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
    if (!r.ok) {
      showToast('loginToast', d.error || '登录失败', 'err');
      return;
    }
    localStorage.setItem(LS_AUTH, d.token);
    localStorage.setItem(LS_USER, d.username);
    updateAuthUi(d.username);
    closeModal('loginModal');
    document.getElementById('loginPass').value = '';
    openModal('monitorModal');
    await loadMonitorConfig();
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

// ── Monitor Settings Logic ──
function switchMonitorTab(tab) {
  document.querySelectorAll('.m-tab').forEach(b => b.classList.toggle('active', b.dataset.mtab === tab));
  document.getElementById('mTabSchedule').classList.toggle('hidden', tab !== 'schedule');
  document.getElementById('mTabEmail').classList.toggle('hidden', tab !== 'email');
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
  onScheduleModeChange();
  renderTimeChips();
  renderUpChips();
  selectEmailStyle(monitorConfig.email_style || 'editorial');

  const syncEl = document.getElementById('cronSyncStatus');
  if (monitorConfig.last_cron_sync) {
    const s = monitorConfig.last_cron_sync;
    syncEl.innerHTML = s.ok
      ? ('✅ 已同步至 Shy Cron（任务 ID: <code>' + esc(s.task_id) + '</code> · 下次运行: ' + esc(s.next_run_at || '已调度') + '）')
      : ('⚠️ 上次 Shy Cron 同步提示：' + esc(s.error || s.reason || '未同步'));
  } else {
    syncEl.textContent = '💡 保存后将自动同步至 Shy Cron（cron.shyapi.de5.net）';
  }
}

function onScheduleModeChange() {
  const mode = document.getElementById('cfgScheduleMode').value;
  document.getElementById('customCronWrap').style.display = mode === 'custom' ? 'block' : 'none';
  document.getElementById('timeAddWrap').style.display = mode === 'times' ? 'block' : 'none';
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
  btn.textContent = '解析中…';
  try {
    const r = await fetch('/api/up-lookup?q=' + encodeURIComponent(q), {
      headers: { 'Authorization': 'Bearer ' + getAuthToken() },
    });
    const d = await r.json();
    if (!r.ok) { showToast('monitorToast', d.error || '解析失败', 'err'); return; }
    if (!monitorConfig.up_list) monitorConfig.up_list = [];
    if (!monitorConfig.up_list.some(x => Number(x.mid) === Number(d.mid))) {
      monitorConfig.up_list.push({ mid: Number(d.mid), name: d.name || String(d.mid) });
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

// ── Email Style Preview Engine (Matches Python emailer.py 4 styles 1:1) ──
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

  const html = '<!doctype html><html><body style="margin:0;padding:14px;background:' + th.pageBg + ';font-family:-apple-system,PingFang SC,sans-serif;color:#111827">' +
    '<div style="max-width:600px;margin:0 auto">' +
      '<div style="background:' + th.hdBg + ';border-top:' + th.hdTop + ';border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;' + hb + 'border-radius:12px 12px 0 0;padding:18px 20px">' +
        '<div style="font-size:10px;letter-spacing:1.2px;color:' + th.hdMeta + ';margin-bottom:5px">BILIBILI AI DAILY BRIEFING · 2026年11月21日</div>' +
        '<div style="font-size:19px;font-weight:800;color:' + th.hdTitle + ';margin-bottom:9px">B站视频 AI 日报</div>' +
        '<span style="display:inline-block;background:' + th.p1Bg + ';color:' + th.p1C + ';border:1px solid ' + th.p1B + ';border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;margin-right:6px">' + (merge ? '覆盖 2 位 UP 主' : '按 UP 主分封推送') + '</span>' +
        '<span style="display:inline-block;background:' + th.p2Bg + ';color:' + th.p2C + ';border:1px solid ' + th.p2B + ';border-radius:999px;padding:2px 9px;font-size:11px">共 ' + (merge ? '2' : '1') + ' 支新视频</span>' +
      '</div>' +
      '<div style="background:' + th.bodyBg + ';border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:16px">' +
        (merge ? '<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;line-height:1.7"><div style="font-size:10px;font-weight:700;color:#6b7280;margin-bottom:4px">本期速览 · TABLE OF CONTENTS</div><div><b style="color:' + th.accent + '">01</b> <b style="color:' + th.accentDark + '">[波士顿圆脸]</b> 前所未见：巴西亚马逊原始部落拖家带口现身求救</div><div><b style="color:' + th.accent + '">02</b> <b style="color:' + th.accentDark + '">[刺客边风]</b> 开源本地光猫配置解析工具实测</div></div>' : '') +
        '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:' + pad + '">' +
          '<div style="margin-bottom:7px"><span style="font-family:Consolas,monospace;font-size:11px;color:#9ca3af;margin-right:6px">#01</span><span style="display:inline-block;background:' + th.bgBadge + ';color:' + th.cBadge + ';border:1px solid ' + th.bBadge + ';border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;margin-right:6px">波士顿圆脸</span><span style="font-size:11px;color:#9ca3af">时长 11:16 · 11-20 10:49</span></div>' +
          '<div style="font-size:15px;font-weight:700;margin-bottom:10px">前所未见：巴西亚马逊原始部落拖家带口现身求救</div>' +
          '<div style="background:' + th.thBg + ';border-left:3px solid ' + th.thB + ';border-radius:0 6px 6px 0;padding:9px 12px;margin-bottom:10px"><div style="font-size:10px;font-weight:700;color:' + th.accentDark + ';margin-bottom:3px">核心主题</div><div style="font-size:' + fs + ';line-height:1.6">记录巴西亚马逊与世隔绝原始部落携家带口现身求救事件，剖析雨林生态与现代疾病风险。</div></div>' +
          '<div style="font-size:' + fs + ';line-height:1.65;color:#374151;margin-bottom:10px"><div><b style="color:' + th.accent + '">1.</b> <b>罕见接触</b>：二三十名阿瓦人主动接触原住民哨所索要食物。</div><div><b style="color:' + th.accent + '">2.</b> <b>生存威胁</b>：非法淘金与盗伐加剧，挤压原住民生存空间。</div></div>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;border-top:1px dashed #e5e7eb;padding-top:9px"><span style="background:' + th.btnBg + ';color:#fff;padding:5px 11px;border-radius:6px;font-size:11.5px;font-weight:600">▶ 前往 B 站观看</span><span style="font-size:11px;color:#9ca3af;font-family:Consolas,monospace">BV149ypz6Ehs</span></div>' +
        '</div>' +
      '</div>' +
    '</div></body></html>';
  document.getElementById('emailPreviewFrame').srcdoc = html;
}

async function saveMonitorConfig() {
  const btn = document.getElementById('saveMonitorBtn');
  btn.disabled = true;
  btn.textContent = '保存并同步中…';
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
    if (d.cron_sync && d.cron_sync.ok) {
      showToast('monitorToast', '✅ 配置已保存并成功同步至 Shy Cron（' + d.cron_sync.cron_utc + '）', 'ok');
    } else {
      showToast('monitorToast', '已保存到 R2，但 Cron 同步提示：' + (d.cron_sync?.error || d.cron_sync?.reason || '未知'), 'err');
    }
  } catch (e) {
    showToast('monitorToast', '保存异常: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 保存并同步定时任务';
  }
}

async function triggerMonitorNow() {
  const btn = document.getElementById('runNowBtn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/monitor-run', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + getAuthToken() },
    });
    const d = await r.json();
    if (!r.ok) showToast('monitorToast', d.error || '触发失败', 'err');
    else showToast('monitorToast', '✅ ' + d.message, 'ok');
  } catch (e) {
    showToast('monitorToast', '触发异常: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── Init ──
initTheme();
checkAuth();
renderList();
const initJobs = getJobs();
if (initJobs.length > 0) selectJob(initJobs[0].id);
initJobs.forEach(j => { if (j.status === 'pending' || j.status === 'submitted') startPolling(j.id); });
syncFromR2();
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
