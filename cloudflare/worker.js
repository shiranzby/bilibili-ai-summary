/**
 * Bilibili AI Summary — Cloudflare Worker
 * ==========================================
 * API endpoints for manual video URL submission.
 * Stores jobs in R2, triggers GitHub Actions for processing.
 *
 * R2 Bucket structure:
 *   pending/<jobId>.json   → 待处理任务
 *   results/<jobId>.json   → 已完成任务结果
 *
 * Auto-cleanup: keeps at most MAX_RESULTS completed jobs.
 * Oldest results are deleted when new ones complete.
 */

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

const MAX_RESULTS = 10;   // 保留最近 N 条已完成结果，超出自动删最旧
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function uuid() {
  return crypto.randomUUID();
}

function nowISO() {
  return new Date().toISOString();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
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

// ═══════════════════════════════════════════════════════
// R2 Storage — 按数量清理
// ═══════════════════════════════════════════════════════

async function cleanupExcessResults(R2) {
  // 收集所有已完成结果的上传时间和 key
  const objects = [];
  for await (const obj of R2.list()) {
    if (obj.key.startsWith('results/')) {
      objects.push({ key: obj.key, uploaded: obj.uploaded });
    }
  }
  // 按上传时间升序排列（最旧的在前）
  objects.sort((a, b) => new Date(a.uploaded) - new Date(b.uploaded));

  // 只保留最新的 MAX_RESULTS 条，删除多余的
  const toDelete = objects.slice(0, Math.max(0, objects.length - MAX_RESULTS));
  let deleted = 0;
  for (const obj of toDelete) {
    await R2.delete(obj.key);
    deleted++;
  }
  return deleted;
}

function requireBucket(env) {
  if (!env.BILIBILI_BUCKET) {
    return errorResponse('R2 存储未配置。请在 Cloudflare Dashboard → Workers & Pages → 本 Worker → Settings → Variables → R2 Bucket Bindings 添加 BILIBILI_BUCKET 绑定到 bilibili-summary 存储桶。', 503);
  }
  return null;
}

// ═══════════════════════════════════════════════════════
// API Handlers
// ═══════════════════════════════════════════════════════

async function handleSubmit(request, env) {
  const missing = requireBucket(env);
  if (missing) return missing;
  const { url } = await request.json();
  if (!url || typeof url !== 'string') {
    return errorResponse('请提供 B站视频 URL 或 BV 号');
  }

  // Extract BVID from URL or use raw input
  let bvid = url.trim();
  const bvMatch = bvid.match(/BV[a-zA-Z0-9]{10}/);
  if (bvMatch) bvid = bvMatch[0];
  if (!/^BV[a-zA-Z0-9]{10}$/.test(bvid)) {
    return errorResponse('无法解析视频 ID，请输入 B站视频链接或 BV 号');
  }

  const jobId = uuid();
  const job = {
    id: jobId,
    bvid,
    url: bvid,
    status: 'pending',
    created_at: nowISO(),
    updated_at: nowISO(),
    summary: null,
    title: '',
    error: '',
  };

  // Write to R2
  await env.BILIBILI_BUCKET.put(
    `pending/${jobId}.json`,
    JSON.stringify(job),
    { httpMetadata: { contentType: 'application/json' } }
  );

  // Trigger GitHub Actions (fire-and-forget)
  const ghResp = fetch(
    `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/manual.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${env.GH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: env.GH_REF || 'main',
        inputs: { bvid, job_id: jobId },
      }),
    }
  ).catch(err => console.error('GitHub dispatch failed:', err));

  // Cleanup excess results (fire-and-forget)
  const cleanup = cleanupExcessResults(env.BILIBILI_BUCKET);

  await Promise.allSettled([ghResp, cleanup]);

  return jsonResponse({ job_id: jobId, bvid, status: 'pending' }, 201);
}

async function handleListJobs(request, env) {
  const missing = requireBucket(env);
  if (missing) return missing;
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  // List both pending and results
  const jobs = [];
  const pendingPrefix = 'pending/';
  const resultsPrefix = 'results/';

  for await (const obj of env.BILIBILI_BUCKET.list()) {
    if (jobs.length >= limit) break;
    const isPending = obj.key.startsWith(pendingPrefix);
    const isResult = obj.key.startsWith(resultsPrefix);
    if (!isPending && !isResult) continue;

    const raw = await env.BILIBILI_BUCKET.get(obj.key);
    if (!raw) continue;
    const job = await raw.json();

    // Filter by status
    if (status && job.status !== status) continue;
    jobs.push(job);
  }

  // Sort by created_at descending (newest first)
  jobs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return jsonResponse({ jobs, total: jobs.length });
}

async function handleGetJob(request, env, jobId) {
  const missing = requireBucket(env);
  if (missing) return missing;
  // Check pending
  let raw = await env.BILIBILI_BUCKET.get(`pending/${jobId}.json`);
  if (!raw) {
    // Check results
    raw = await env.BILIBILI_BUCKET.get(`results/${jobId}.json`);
  }
  if (!raw) {
    return errorResponse('任务不存在', 404);
  }
  const job = await raw.json();
  return jsonResponse(job);
}

async function handleDeleteJob(request, env, jobId) {
  const missing = requireBucket(env);
  if (missing) return missing;
  let deleted = false;
  const pendingKey = `pending/${jobId}.json`;
  const resultKey = `results/${jobId}.json`;

  if (await env.BILIBILI_BUCKET.get(pendingKey)) {
    await env.BILIBILI_BUCKET.delete(pendingKey);
    deleted = true;
  }
  if (await env.BILIBILI_BUCKET.get(resultKey)) {
    await env.BILIBILI_BUCKET.delete(resultKey);
    deleted = true;
  }

  if (!deleted) {
    return errorResponse('任务不存在', 404);
  }
  return jsonResponse({ deleted: true, job_id: jobId });
}

async function handleStats(request, env) {
  const missing = requireBucket(env);
  if (missing) return missing;
  let pending = 0;
  let completed = 0;

  for await (const obj of env.BILIBILI_BUCKET.list()) {
    if (obj.key.startsWith('pending/')) pending++;
    if (obj.key.startsWith('results/')) completed++;
  }

  return jsonResponse({
    pending_jobs: pending,
    completed_jobs: completed,
    max_results: MAX_RESULTS,
  });
}

// Cron handler: cleanup excess results
async function handleCron(event, env) {
  if (!env.BILIBILI_BUCKET) {
    console.log('[Cron] ⏭ R2 bucket not configured, skipping cleanup');
    return;
  }
  const deleted = await cleanupExcessResults(env.BILIBILI_BUCKET);
  console.log(`[Cron] Cleanup: deleted ${deleted} old results, keeping ${MAX_RESULTS}`);
}

// ═══════════════════════════════════════════════════════
// Status Page (HTML)
// ═══════════════════════════════════════════════════════

function generateStatusPage(env) {
  const r2Status = env.BILIBILI_BUCKET ? '✅ 已连接' : '⏳ 未配置';
  const r2Link = env.BILIBILI_BUCKET
    ? ''
    : '<p>在 <a href="https://dash.cloudflare.com/?to=/:account/r2" target="_blank">Cloudflare Dashboard → R2</a> 启用后，<br>再到 <b>Workers & Pages → bilibili-ai-summary-api → Settings → Variables → R2 Bucket Bindings</b><br>添加变量名 <code>BILIBILI_BUCKET</code>，存储桶 <code>bilibili-summary</code></p>';
  const ghStatus = env.GH_TOKEN ? '✅ 已配置' : '⏳ 未配置';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>B站AI摘要 API</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    background: #0f172a; color: #e2e8f0;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    background: #1e293b; border: 1px solid #334155; border-radius: 16px;
    padding: 32px; max-width: 680px; width: 100%;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  }
  h1 {
    font-size: 1.5rem; font-weight: 800;
    background: linear-gradient(135deg, #14b8a6, #0ea5e9);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text; margin-bottom: 8px;
  }
  .subtitle { color: #94a3b8; font-size: 0.9rem; margin-bottom: 24px; }
  .status-grid { display: grid; gap: 12px; margin-bottom: 24px; }
  .status-item {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; background: #0f172a; border-radius: 10px;
    font-size: 0.88rem;
  }
  .status-item .label { color: #94a3b8; min-width: 80px; }
  .status-item .value { font-weight: 600; }
  .hint {
    border-top: 1px solid #334155; padding-top: 16px; margin-top: 8px;
    font-size: 0.85rem; color: #94a3b8; line-height: 1.7;
  }
  .hint a { color: #38bdf8; }
  .hint code { background: #0f172a; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
  .btn {
    display: inline-block; margin-top: 16px;
    padding: 10px 20px; background: #14b8a6; color: #fff;
    border: none; border-radius: 10px; font-size: 0.9rem; font-weight: 700;
    text-decoration: none; cursor: pointer; transition: background 0.2s;
  }
  .btn:hover { background: #0d9488; }
</style>
</head>
<body>
<div class="card">
  <h1>🎬 Bilibili AI Summary</h1>
  <p class="subtitle">Cloudflare Worker API — 状态监控</p>
  <div class="status-grid">
    <div class="status-item">
      <span class="label">Worker</span>
      <span class="value" style="color:#22c55e">✅ 运行正常</span>
    </div>
    <div class="status-item">
      <span class="label">R2 存储</span>
      <span class="value">${r2Status}</span>
    </div>
    <div class="status-item">
      <span class="label">GitHub</span>
      <span class="value">${ghStatus}</span>
    </div>
    <div class="status-item">
      <span class="label">版本</span>
      <span class="value">v1.0</span>
    </div>
  </div>
  ${env.BILIBILI_BUCKET ? `
  <div style="text-align:center;margin-bottom:16px">
    <a class="btn" href="/frontend/">🚀 打开 Web UI</a>
  </div>` : `
  <div class="hint">
    <strong>🚧 R2 存储未配置</strong><br>
    当前 API 功能不可用，因为缺少 R2 存储。完成后即可：
    <ul style="margin:8px 0 0 20px">
      <li>提交 B站视频 URL 进行处理</li>
      <li>查看历史记录和 AI 总结</li>
      <li>自动清理过期结果</li>
    </ul>
    ${r2Link}
  </div>`}
  <div class="hint" style="margin-top:8px">
    <strong>📡 API 端点</strong><br>
    <code>POST /api/submit</code> — 提交视频 URL；<br>
    <code>GET /api/jobs</code> — 查看所有任务；<br>
    <code>GET /api/jobs/:id</code> — 查看单个任务；<br>
    <code>DELETE /api/jobs/:id</code> — 删除任务；<br>
    <code>GET /api/stats</code> — 存储统计
  </div>
</div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // API routes
      if (path === '/api/submit' && request.method === 'POST') {
        return await handleSubmit(request, env);
      }
      if (path === '/api/jobs' && request.method === 'GET') {
        return await handleListJobs(request, env);
      }
      if (path.startsWith('/api/jobs/') && request.method === 'GET') {
        const jobId = path.replace('/api/jobs/', '');
        return await handleGetJob(request, env, jobId);
      }
      if (path.startsWith('/api/jobs/') && request.method === 'DELETE') {
        const jobId = path.replace('/api/jobs/', '');
        return await handleDeleteJob(request, env, jobId);
      }
      if (path === '/api/stats' && request.method === 'GET') {
        return await handleStats(request, env);
      }

      // Root path: serve a functional status page
      if (path === '/' || path === '/index.html') {
        return htmlResponse(generateStatusPage(env));
      }

      return errorResponse('Not Found', 404);
    } catch (err) {
      console.error('Worker error:', err);
      return errorResponse('Internal Server Error', 500);
    }
  },

  async scheduled(event, env, ctx) {
    await handleCron(event, env);
  },
};
