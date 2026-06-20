/**
 * Bilibili AI Summary — Cloudflare Worker
 * ==========================================
 * API endpoints for manual video URL submission.
 *
 * 降级模式: 无 R2 时仍可提交任务（结果通过邮件发送）。
 * 完整模式: 有 R2 时存储任务数据并支持在线查询。
 */

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

const MAX_RESULTS = 10;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════


const GH_OWNER_DEF = 'shiranzby';
const GH_REPO_DEF = 'bilibili-ai-summary';

async function fetchGHRunId(env, bvid, jobId) {
  // After dispatch, query GitHub for the latest run matching this job
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
        'User-Agent': 'bilibili-ai-summary-worker/1.0',
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const runs = data.workflow_runs || [];
    if (runs.length > 0) {
      return runs[0].id;
    }
  } catch(e) {
    console.error('fetchGHRunId error:', e.message);
  }
  return null;
}

async function captureRunId(env, jobId, bvid) {
  if (!env.BILIBILI_BUCKET || !env.GH_TOKEN) return;
  const runId = await fetchGHRunId(env, bvid, jobId);
  if (runId) {
    try {
      const existing = await env.BILIBILI_BUCKET.get(`pending/${jobId}.json`);
      if (existing) {
        const jobData = await existing.json();
        jobData.run_id = runId;
        await env.BILIBILI_BUCKET.put(`pending/${jobId}.json`, JSON.stringify(jobData),
          { httpMetadata: { contentType: 'application/json' } }
        );
        console.log(`run_id ${runId} captured for job ${jobId}`);
      }
    } catch(e) {
      console.error('captureRunId write error:', e.message);
    }
  }
}

async function fetchGHRunStatus(env, runId) {
  const owner = env.GH_OWNER || GH_OWNER_DEF;
  const repo = env.GH_REPO || GH_REPO_DEF;
  const token = env.GH_TOKEN || '';
  if (!token || !runId) return null;
  
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`;
  try {
    const resp = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'bilibili-ai-summary-worker/1.0',
      },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch(e) {
    return null;
  }
}

function ghStatusToSteps(ghStatus, ghConclusion, startedAt) {
  // Map GitHub Actions status to our progress steps
  // status: queued, in_progress, completed, waiting
  // conclusion: null (in progress), success, failure, cancelled
  const steps = [
    {name:'任务创建', done:true, active:false, msg:'已提交至处理队列'},
    {name:'下载视频音频', done:false, active:false, msg:''},
    {name:'语音转录', done:false, active:false, msg:''},
    {name:'LLM 整理总结', done:false, active:false, msg:''},
    {name:'后处理及文件导出', done:false, active:false, msg:''},
    {name:'处理完成', done:false, active:false, msg:''},
  ];
  
  if (ghStatus === 'queued') {
    steps[0].active = true;
    steps[0].msg = '排队等待中…';
  } else if (ghStatus === 'in_progress') {
    // Estimate progress based on elapsed time since job start
    // Typical CI: checkout+setup ~20s, download ~30s, STT ~60s, LLM ~60s, email+callback ~10s
    const elapsed = startedAt ? (Date.now() - new Date(startedAt).getTime()) / 1000 : 0;
    const doneCount = elapsed < 20 ? 0 : elapsed < 50 ? 1 : elapsed < 120 ? 2 : elapsed < 200 ? 3 : 4;
    for (let i = 1; i <= doneCount && i < 6; i++) {
      steps[i].done = true;
      steps[i].msg = '✅ 完成';
    }
    const next = Math.min(doneCount + 1, 5);
    if (next < 6) {
      steps[next].active = true;
      steps[next].msg = '处理中…';
    }
  } else if (ghStatus === 'completed') {
    if (ghConclusion === 'success') {
      for (let i = 1; i < 5; i++) { steps[i].done = true; steps[i].msg = '✅ 完成'; }
      steps[5].done = true;
      steps[5].msg = '✅ 完成';
    } else {
      steps[0].msg = '❌ 失败';
      steps[5].done = true;
      steps[5].msg = '❌ 失败';
    }
  }
  return steps;
}
function uuid() { return crypto.randomUUID(); }
function nowISO() { return new Date().toISOString(); }

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
// R2 Storage (only used when configured)
// ═══════════════════════════════════════════════════════

async function cleanupExcessResults(R2) {
  const objects = [];
  let cursor;
  do {
    const listed = await R2.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      if (obj.key.startsWith('results/')) {
        objects.push({ key: obj.key, uploaded: obj.uploaded });
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  objects.sort((a, b) => new Date(a.uploaded) - new Date(b.uploaded));
  const toDelete = objects.slice(0, Math.max(0, objects.length - MAX_RESULTS));
  let deleted = 0;
  for (const obj of toDelete) {
    await R2.delete(obj.key);
    deleted++;
  }
  return deleted;
}

// ═══════════════════════════════════════════════════════
// R2 History Sync (cross-device shared history)
// ═══════════════════════════════════════════════════════

const HISTORY_KEY = 'history/shared.json';

async function handleGetHistory(request, env) {
  if (!env.BILIBILI_BUCKET) return jsonResponse({ error: 'R2 not configured' }, 503);
  try {
    const obj = await env.BILIBILI_BUCKET.get(HISTORY_KEY);
    if (!obj) return jsonResponse([]);
    const data = await obj.json();
    return jsonResponse(data.jobs || []);
  } catch (e) {
    console.error('handleGetHistory error:', e.message);
    return jsonResponse([]);
  }
}

async function handlePostHistory(request, env) {
  if (!env.BILIBILI_BUCKET) return jsonResponse({ error: 'R2 not configured' }, 503);
  try {
    const body = await request.json();
    const jobs = body.jobs || [];
    // Keep max 100 items to stay within R2 free tier (~100kb)
    const trimmed = jobs.slice(0, 100);
    await env.BILIBILI_BUCKET.put(HISTORY_KEY, JSON.stringify({ jobs: trimmed, updated_at: nowISO() }),
      { httpMetadata: { contentType: 'application/json' } }
    );
    console.log('R2 history saved:', trimmed.length, 'jobs');
    return jsonResponse({ ok: true, count: trimmed.length });
  } catch (e) {
    console.error('handlePostHistory error:', e.message);
    return jsonResponse({ error: e.message }, 500);
  }
}

async function handleDeleteHistory(request, env) {
  if (!env.BILIBILI_BUCKET) return jsonResponse({ error: 'R2 not configured' }, 503);
  try {
    await env.BILIBILI_BUCKET.delete(HISTORY_KEY);
    console.log('R2 history deleted');
    return jsonResponse({ ok: true });
  } catch (e) {
    console.error('handleDeleteHistory error:', e.message);
    return jsonResponse({ error: e.message }, 500);
  }
}

// ═══════════════════════════════════════════════════════
// API Handlers
// ═══════════════════════════════════════════════════════

async function handleSubmit(request, env, ctx) {
  const body = await request.json();
  const url = body.url;
  const summary_template = body.summary_template || '';
  const custom_email = body.email || '';
  if (!url || typeof url !== 'string') {
    return errorResponse('请提供 B站视频 URL 或 BV 号');
  }

  let bvid = url.trim();
  // Extract BV/AV from full URL with Chinese text
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
    summary: null, title: '', error: '',
  };

  // 有 R2 则持久化 (可选，静默失败)
  if (env.BILIBILI_BUCKET) {
    env.BILIBILI_BUCKET.put(`pending/${jobId}.json`, JSON.stringify(job),
      { httpMetadata: { contentType: 'application/json' } }
    ).catch(() => {});
  }

  // 触发 GitHub Actions (使用 summary.yml，支持 workflow_dispatch)
  const GH_OWNER = env.GH_OWNER || 'shiranzby';
  const GH_REPO = env.GH_REPO || 'bilibili-ai-summary';
  const dispatchUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/summary.yml/dispatches`;
  
  // 只在 summary_template 非空时传，避免旧版 workflow 不认识的 input 导致 422
  const inputs = { bvid, job_id: jobId };
  if (summary_template) inputs.summary_template = summary_template;
  if (custom_email) inputs.email = custom_email;

  try {
    const ghResp = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${env.GH_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'bilibili-ai-summary-worker/1.0',
      },
      body: JSON.stringify({ ref: env.GH_REF || 'main', inputs }),
    });
    
    if (ghResp.status !== 204 && ghResp.status !== 201 && ghResp.status !== 200) {
      const errText = await ghResp.text().catch(() => 'unknown');
      console.error('GitHub dispatch failed:', ghResp.status, errText.slice(0, 200));
      
      // 有 R2 时清理过期结果
      if (env.BILIBILI_BUCKET) {
        cleanupExcessResults(env.BILIBILI_BUCKET).catch(() => {});
      }
      
      return jsonResponse({ 
        job_id: jobId, bvid, status: 'pending',
        warning: 'GitHub Actions 触发可能失败: HTTP ' + ghResp.status,
      }, 201);
    }
    
    console.log('GitHub dispatch OK:', ghResp.status);
    
    // Capture run_id asynchronously (won't block response)
    ctx.waitUntil(captureRunId(env, jobId, bvid));
  } catch (err) {
    console.error('GitHub dispatch network error:', err.message);
  }

  // 有 R2 时清理过期结果
  if (env.BILIBILI_BUCKET) {
    cleanupExcessResults(env.BILIBILI_BUCKET).catch(() => {});
  }

  return jsonResponse({ job_id: jobId, bvid, status: 'pending' }, 201);
}

async function handleListJobs(request, env) {
  if (!env.BILIBILI_BUCKET) {
    return jsonResponse({ jobs: [], total: 0, note: 'R2 未配置 — 使用浏览器 LocalStorage 代替' });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  const jobs = [];
  let cursor;
  do {
    const listed = await env.BILIBILI_BUCKET.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      if (jobs.length >= limit) break;
      const isPending = obj.key.startsWith('pending/');
      const isResult = obj.key.startsWith('results/');
      if (!isPending && !isResult) continue;
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
  if (!env.BILIBILI_BUCKET) {
    return errorResponse('R2 未配置 — 结果通过邮件发送，不支持在线查询', 503);
  }
  let raw = await env.BILIBILI_BUCKET.get(`pending/${jobId}.json`);
  if (!raw) raw = await env.BILIBILI_BUCKET.get(`results/${jobId}.json`);
  if (!raw) return errorResponse('任务不存在', 404);
  
  const job = await raw.json();
  
  // If pending job has run_id, enrich with GitHub Actions status
  if (job.status !== 'completed' && job.run_id) {
    const ghRun = await fetchGHRunStatus(env, job.run_id);
    if (ghRun) {
      job.gh_status = ghRun.status;
      job.gh_conclusion = ghRun.conclusion;
      job.gh_html_url = ghRun.html_url;
      // Map to our steps
      job.gh_steps = ghStatusToSteps(ghRun.status, ghRun.conclusion, job.created_at);
    }
  }
  
  return jsonResponse(job);
}

async function handleDeleteJob(request, env, jobId) {
  if (!env.BILIBILI_BUCKET) {
    return jsonResponse({ deleted: true, job_id: jobId, note: '无 R2 — 浏览器 LocalStorage 中删除' });
  }
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
  // GHA 跑完后回调: POST { job_id, bvid, status, summary, transcript, title }
  // 删除 pending 标记 → 写入 results/{job_id}.json
  if (!env.BILIBILI_BUCKET) {
    return errorResponse('R2 未配置', 503);
  }
  
  const body = await request.json();
  const { job_id, bvid, status, summary, transcript, title, timings, owner, pubdate } = body;
  
  if (!job_id || !bvid) {
    return errorResponse('缺少 job_id 或 bvid', 400);
  }
  
  // 验证 pending 任务存在
  const pending = await env.BILIBILI_BUCKET.get(`pending/${job_id}.json`);
  if (!pending) {
    return errorResponse('任务不存在或已处理', 404);
  }
  
  // 写入结果
  const now = new Date().toISOString();
  const result = {
    id: job_id, bvid, status: status || 'completed',
    summary: summary || null,
    transcript: transcript || '',
    title: title || '',
    timings: timings || {},
    owner: owner || '',
    pubdate: pubdate || null,
    completed_at: now,
    video_url: `https://www.bilibili.com/video/${bvid}`,
  };
  
  await env.BILIBILI_BUCKET.put(`results/${job_id}.json`, JSON.stringify(result), {
    httpMetadata: { contentType: 'application/json' },
  });
  
  // 删除 pending
  await env.BILIBILI_BUCKET.delete(`pending/${job_id}.json`);
  
  return jsonResponse({ status: 'ok', job_id });
}

async function handleStats(request, env) {
  if (!env.BILIBILI_BUCKET) {
    return jsonResponse({ mode: 'localstorage', note: 'R2 未配置 — 使用浏览器 LocalStorage', max_results: MAX_RESULTS });
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

// ═══════════════════════════════════════════════════════
// Cron
// ═══════════════════════════════════════════════════════

async function handleCron(event, env) {
  if (!env.BILIBILI_BUCKET) return;
  const deleted = await cleanupExcessResults(env.BILIBILI_BUCKET);
  console.log(`[Cron] Cleanup: deleted ${deleted} old results`);
}

// ═══════════════════════════════════════════════════════
// Status Page
// ═══════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════
// Frontend HTML (embedded)
// ═══════════════════════════════════════════════════════





function generateFrontendPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>B站AI摘要</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f8fafc;--surface:#fff;--border:#e2e8f0;--text:#0f172a;--soft:#475569;--muted:#94a3b8;--brand:#14b8a6;--accent:#0ea5e9;--danger:#ef4444;--success:#22c55e;--radius:12px;--shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);--shadow-lg:0 4px 12px rgba(0,0,0,.08),0 2px 4px rgba(0,0,0,.04);--glass:rgba(255,255,255,.7)}
[data-theme="dark"]{--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#f1f5f9;--soft:#cbd5e1;--muted:#64748b;--shadow:0 1px 3px rgba(0,0,0,.2),0 1px 2px rgba(0,0,0,.15);--shadow-lg:0 4px 12px rgba(0,0,0,.3),0 2px 4px rgba(0,0,0,.15);--glass:rgba(30,41,59,.85)}
body{font-family:-apple-system,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);height:100%;overflow:hidden}
html{height:100%;overflow:hidden}
.app{display:grid;grid-template-columns:var(--sidebar-w,33%) 4px 1fr;height:100vh;user-select:none}
@media(max-width:900px){
.app{grid-template-columns:1fr;height:auto;min-height:100vh}
html,body{overflow:auto!important;height:auto!important}
.sidebar{height:auto;overflow:visible}
.sidebar-history .history-inner{max-height:260px;min-height:0}
.main{max-height:none;overflow-y:visible}
.divider{display:none}
.detail-body.layout-h .detail-pair{display:block}
.detail-body.layout-h .detail-pair .detail-panel{width:100%}
.detail-body.layout-h .pair-divider{display:none}
.layout-bar{display:none}
}
/* Divider — draggable handle */
.divider{cursor:col-resize;background:var(--border);position:relative;transition:background .15s;flex-shrink:0}
.divider:hover,.divider:active{background:var(--brand)}
.divider::after{content:'';position:absolute;left:-3px;right:-3px;top:0;bottom:0}
/* Sidebar — flex fills viewport, history list auto-expands */
.sidebar{background:var(--surface);border-right:1px solid var(--border);padding:24px 20px;overflow:hidden;display:flex;flex-direction:column}
.sidebar-top{flex-shrink:0}
.sidebar-history{flex:1;display:flex;flex-direction:column;min-height:0;margin-top:16px;padding-top:12px;border-top:1px solid var(--border);overflow:hidden}
.sidebar-history .history-inner{flex:1;overflow-y:auto;min-height:0}
.sidebar-history .history-inner::-webkit-scrollbar{display:none}
.sidebar h1{font-size:1.3rem;font-weight:800;background:linear-gradient(135deg,var(--brand),var(--accent));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:20px}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:.8rem;font-weight:700;color:var(--soft);margin-bottom:4px;text-transform:uppercase;letter-spacing:.03em}
.form-group input,.form-group select{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:.9rem;outline:0}
.form-group input:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(14,165,233,.15)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border:none;border-radius:8px;font-size:.85rem;font-weight:700;cursor:pointer;transition:all .2s;justify-content:center}
.btn-primary{background:linear-gradient(135deg,var(--brand),var(--accent));color:#fff;width:100%}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(20,184,166,.3)}
.btn-primary:disabled{opacity:.5;cursor:not-allowed;transform:none}
.btn-sm{padding:6px 12px;font-size:.8rem}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--soft)}
.btn-outline:hover{border-color:var(--brand);color:var(--brand)}
.btn-danger{background:transparent;border:1px solid var(--danger);color:var(--danger)}
.btn-danger:hover{background:var(--danger);color:#fff}
.ht{position:fixed;top:16px;right:16px;z-index:10;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 12px;cursor:pointer;font-size:.8rem;color:var(--soft);z-index:100}
/* Main */
.main{padding:24px;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none}.main::-webkit-scrollbar{display:none}
.main h2{font-size:1rem;font-weight:700;margin-bottom:12px;color:var(--soft);text-transform:uppercase;letter-spacing:.03em}
/* Notice */
.notice{padding:12px 16px;background:#fef3c7;border:1px solid #f59e0b;border-radius:10px;font-size:.82rem;color:#92400e;margin-bottom:16px;line-height:1.6}
/* Progress — 2-row flex with arrow flow */
.progress{margin-bottom:16px}
.progress-row{display:flex;align-items:stretch;margin-bottom:8px;width:100%}
.progress-row.r1{width:100%}
.progress-row.r2{width:100%}
.progress-step{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:12px 6px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:.78rem;min-height:56px;flex:1 1 0;width:0}
.progress-step .step-label{font-weight:600;line-height:1.3;white-space:nowrap}
.progress-step .step-msg{font-size:.68rem;color:var(--muted);margin-top:3px}
.progress-step.done{border-color:var(--success);background:#f0fdf4;opacity:.85}
.progress-step.active{border-color:var(--accent);background:#eff6ff;animation:pulse 2s ease-in-out infinite}
.progress-step.pending{opacity:.55}
.arrow-sep{display:flex;align-items:center;justify-content:center;padding:0 2px;color:var(--muted);font-size:1.5rem;flex-shrink:0;user-select:none;width:20px}
.arrow-sep.done{color:var(--success)}
.arrow-sep.active{color:var(--accent)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(14,165,233,.4)}50%{box-shadow:0 0 0 3px rgba(14,165,233,.1)}}
[data-theme="dark"] .progress-step.done{background:#052e16}
[data-theme="dark"] .progress-step.active{background:#172554}
/* Job items */
.job-item{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;cursor:pointer;transition:all .15s;background:var(--surface)}
.job-item:hover{border-color:var(--accent)}
.job-item.selected{border-color:var(--brand);box-shadow:0 0 0 2px rgba(20,184,166,.15)}
.job-item .status{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.7rem;flex-shrink:0}
.job-item .status.sub{background:#fef3c7;color:#92400e}
.job-item .status.done{background:#dcfce7;color:#166534}
.job-item .status.fail{background:#fee2e2;color:#991b1b}
.job-info{flex:1;min-width:0}
.job-bvid{font-size:.78rem;color:var(--muted);margin-top:2px}
.job-time{font-size:.78rem;color:var(--soft)}
.job-title{font-size:.88rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.job-title a{color:var(--text);text-decoration:none}
.job-title a:hover{color:var(--accent);text-decoration:underline}
.job-title .link-icon{font-size:.75rem;margin-left:4px;opacity:.6}
.job-actions{display:flex;gap:4px;flex-shrink:0}
.job-check{width:16px;height:16px;cursor:pointer;accent-color:var(--brand);flex-shrink:0}
.job-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:3px;font-size:.74rem}
.job-meta .meta-tag{display:inline-flex;align-items:center;gap:3px;padding:1px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--soft);white-space:nowrap}
.job-meta .meta-link{color:var(--accent);text-decoration:none;font-size:.74rem}
.job-meta .meta-link:hover{text-decoration:underline}
/* Detail panel */
.detail-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.detail-card h3{font-size:.85rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px}
.detail-card .content{font-size:.88rem;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.detail-card textarea{width:100%;min-height:120px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:.85rem;line-height:1.6;resize:vertical;outline:0;font-family:inherit}
.detail-card textarea:focus{border-color:var(--accent)}
.empty{text-align:center;padding:48px 20px;color:var(--muted);font-size:.9rem}
.empty .big{font-size:3rem;margin-bottom:12px}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:.78rem;color:var(--muted)}
.badge.pending{color:#92400e}
.badge.done{color:#166534}
.sp{width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--brand);border-radius:50%;animation:spin .6s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.hidden{display:none!important}
.flex{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.mb{margin-bottom:16px}
.mt{margin-top:12px}
.gap-sm{gap:6px}

/* Back-to-top */
.back-to-top{position:fixed;bottom:24px;right:24px;width:40px;height:40px;border-radius:50%;background:var(--surface);border:1px solid var(--border);color:var(--soft);font-size:1.1rem;cursor:pointer;display:none;align-items:center;justify-content:center;z-index:50;box-shadow:var(--shadow-lg);transition:all .25s;opacity:0}
.back-to-top.show{display:flex;opacity:1}
.back-to-top:hover{background:var(--brand);color:#fff;border-color:var(--brand);transform:translateY(-2px)}

/* Premium additions */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px;box-shadow:var(--shadow);transition:box-shadow .2s,transform .2s}
.card:hover{box-shadow:var(--shadow-lg);transform:translateY(-1px)}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.card-header h3{font-size:.85rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.card-body{font-size:.88rem;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.glass{background:var(--glass);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--border)}
.pill{display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:20px;font-size:.75rem;font-weight:600}
.pill-success{background:#dcfce7;color:#166534}
.pill-warn{background:#fef3c7;color:#92400e}
.pill-error{background:#fee2e2;color:#991b1b}
[data-theme="dark"] .pill-success{background:#052e16;color:#86efac}
[data-theme="dark"] .pill-warn{background:#422006;color:#fbbf24}
[data-theme="dark"] .pill-error{background:#450a0a;color:#fca5a5}
.search-box{width:100%;padding:8px 12px 8px 36px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:.82rem;outline:0;transition:border-color .2s}
.search-box:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(14,165,233,.15)}
.search-wrap{position:relative;margin-bottom:10px}
.search-wrap .icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:.85rem;opacity:.5;pointer-events:none}
/* Accordion */
.accordion{border:1px solid var(--border);border-radius:var(--radius);margin-bottom:16px;overflow:hidden}
.accordion-header{display:flex;align-items:center;gap:10px;padding:14px 16px;cursor:pointer;background:var(--surface);transition:background .15s;user-select:none}
.accordion-header:hover{background:color-mix(in srgb,var(--border) 15%,var(--surface))}
.accordion-header .arrow{font-size:.7rem;transition:transform .2s;opacity:.5}
.accordion-header.open .arrow{transform:rotate(90deg)}
.accordion-header .label{font-size:.85rem;font-weight:600}
.accordion-header .status-icon{font-size:.9rem}
.accordion-body{padding:16px;border-top:1px solid var(--border);background:var(--bg)}
.accordion-body.hidden{display:none}
/* Layout toolbar */
.layout-bar{display:flex;gap:6px;margin-bottom:12px;align-items:center}
.layout-bar .lbl{font-size:.78rem;color:var(--muted);margin-right:4px}
.layout-btn{padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--soft);font-size:.78rem;cursor:pointer;transition:all .15s;line-height:1.4}
.layout-btn:hover{border-color:var(--accent);color:var(--accent)}
.layout-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
/* Layout: detail-pair (transcript + summary) */
.detail-body{width:100%}
.detail-pair{width:100%}
.detail-pair .detail-panel{width:100%}
.pair-divider{display:none}
/* Layout: h = horizontal side-by-side with draggable divider */
.detail-body.layout-h .detail-pair{display:flex;gap:0}
.detail-body.layout-h .detail-pair .detail-panel{flex:1 1 0;width:0;min-width:150px;overflow:hidden}
.detail-body.layout-h .pair-divider{display:block;width:4px;cursor:col-resize;background:var(--border);border-radius:2px;flex-shrink:0;position:relative;margin:0 6px}
.detail-body.layout-h .pair-divider:hover,.detail-body.layout-h .pair-divider:active{background:var(--brand)}
.detail-body.layout-h .pair-divider::after{content:'';position:absolute;left:-4px;right:-4px;top:0;bottom:0}
.detail-body.layout-h .accordion{margin-bottom:0}
</style>
</head>
<body>
<button class="ht" onclick="toggleTheme()">🌓</button>
<div class="app" id="app">
  <!-- Sidebar -->
  <div class="sidebar">
    <div class="sidebar-top">
      <h1>🎬 B站AI摘要</h1>

      <div class="notice" id="noR2Notice" style="display:none">
        💡 结果通过<strong>邮件发送</strong>，收到后可在详情页手动添加总结内容。
      </div>

      <div class="form-group">
        <label>B站视频链接或 BV/AV 号</label>
        <div style="display:flex;gap:6px">
        <input id="urlInput" type="text" placeholder="可直接粘贴链接（含标题），系统自动提取…"
          onkeydown="if(event.key==='Enter')submitJob()" style="flex:1" />
        <button class="btn btn-sm btn-outline" onclick="pasteUrl()" title="从剪贴板粘贴" style="padding:4px 10px;font-size:.9rem">📋</button>
        </div>
      </div>

      <details style="margin-bottom:16px">
        <summary style="font-size:.82rem;color:var(--muted);cursor:pointer">⚙️ 高级配置</summary>
        <div style="margin-top:10px">
          <div class="form-group">
            <label>API Key (硅基流动)</label>
            <input id="apiKeyInput" type="password" placeholder="留空使用服务端配置" />
          </div>
          <div class="form-group">
            <label>语音转文字模型</label>
            <input id="sttModelSelect" type="text" list="sttModelList" placeholder="FunAudioLLM/SenseVoiceSmall (默认)" />
            <datalist id="sttModelList">
              <option value="FunAudioLLM/SenseVoiceSmall">SenseVoiceSmall (默认)</option>
              <option value="FunAudioLLM/SenseVoiceLarge">SenseVoiceLarge</option>
            </datalist>
          </div>
          <div class="form-group">
            <label>AI 总结模型</label>
            <input id="summaryModelSelect" type="text" list="summaryModelList" placeholder="Qwen/Qwen3-8B (默认)" />
            <datalist id="summaryModelList">
              <option value="Qwen/Qwen3-8B">Qwen3-8B (默认)</option>
              <option value="Qwen/Qwen3-14B">Qwen3-14B</option>
              <option value="deepseek-ai/DeepSeek-V3">DeepSeek V3</option>
              <option value="Pro/Qwen/Qwen3-8B">Qwen3-8B (Pro)</option>
            </datalist>
          </div>
          <div class="form-group">
            <label>自定义总结模板（可选）</label>
            <textarea id="summaryTemplateInput" rows="4" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:.82rem;line-height:1.5;resize:vertical;outline:0;font-family:inherit" placeholder="留空使用默认模板&#10;填入模板后，{content} 会被替换为字幕文本"></textarea>
          </div>
          <div class="form-group">
            <label>接收邮箱（可选）</label>
            <input id="emailInput" type="email" placeholder="留空使用服务端配置的邮箱" />
          </div>
        </div>
      </details>

      <button class="btn btn-primary" id="submitBtn" onclick="submitJob()">
        🚀 开始处理
      </button>
      <div id="submitStatus" style="margin-top:10px;font-size:.82rem"></div>
    </div>

    <div class="sidebar-history">
      <div style="flex-shrink:0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:.82rem;font-weight:700;color:var(--soft)">📋 历史记录</span>
          <div class="flex" style="gap:4px">
            <button class="btn btn-sm btn-outline" onclick="toggleSelectAll()" style="font-size:.75rem;padding:4px 10px" title="全选">☑️ 全选</button>
            <button class="btn btn-sm btn-outline" onclick="invertSelection()" style="font-size:.75rem;padding:4px 10px" title="反选">🔄 反选</button>
            <button class="btn btn-sm btn-danger" onclick="deleteSelectedJobs()" style="font-size:.75rem;padding:4px 10px" title="删除选中/全选时删除全部">🗑 删除</button>
            <span id="countBadge" class="badge"></span>
          </div>
        </div>
        <div class="search-wrap">
          <span class="icon">🔍</span>
          <input class="search-box" id="searchInput" type="text" placeholder="搜索标题、BV号、UP主或日期…" oninput="renderList()" />
        </div>
      </div>
      <div class="history-inner" id="historyList"></div>
    </div>
  </div>
  <div class="divider" id="divider"></div>
  <!-- Main Content -->
  <div class="main" id="mainContent">
    <div class="empty" id="emptyState">
      <div class="big">🎬</div>
      <p>在左侧输入 B站视频链接，点击「开始处理」</p>
      <p style="margin-top:4px;font-size:.82rem">处理完成后会收到邮件，可在详情中添加总结内容</p>
    </div>

    <!-- Job Detail (hidden initially) -->
    <div id="detailView" class="hidden" style="width:100%">
      <!-- Progress (always visible) -->
      <div class="progress" id="progressSteps"></div>

      <!-- Layout toolbar -->
      <div class="layout-bar">
        <span class="lbl">排版:</span>
        <button class="layout-btn active" data-layout="v" onclick="setLayout('v')" title="垂直排版">↕ 垂直</button>
        <button class="layout-btn" data-layout="h" onclick="setLayout('h')" title="水平分列（可拖拽）">↔水平</button>
      </div>

      <div class="detail-body" id="detailBody">
      <div class="detail-pair" id="detailPair">
        <div class="detail-panel" id="transcriptPanel">
        <!-- Accordion: Transcript -->
        <div class="accordion">
          <div class="accordion-header open" onclick="toggleAccordion(this)">
            <span class="arrow">▶</span>
            <span class="status-icon">📝</span>
            <span class="label">转录文本</span>
            <span style="flex:1"></span>
            <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();downloadTranscript()" title="TXT">⬇ TXT</button>
            <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();downloadTranscriptMD()" title="Markdown">📄 MD</button>
            <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();copyTranscript()">📋 复制</button>
          </div>
          <div class="accordion-body">
            <div class="card-body" id="transcriptContent">加载中…</div>
          </div>
        </div>
        </div>
        <div class="pair-divider" id="pairDivider"></div>
        <div class="detail-panel" id="summaryPanel">
        <!-- Accordion: AI Summary -->
        <div class="accordion">
          <div class="accordion-header open" onclick="toggleAccordion(this)">
            <span class="arrow">▶</span>
            <span class="status-icon">🤖</span>
            <span class="label">AI 总结</span>
            <span style="flex:1"></span>
            <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();downloadSummaryTXT()" title="TXT">⬇ TXT</button>
            <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();downloadSummary()" title="Markdown">📄 MD</button>
            <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();copySummary()">📋 复制</button>
          </div>
          <div class="accordion-body">
            <div class="card-body" id="summaryContent" style="min-height:120px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg)">暂无总结内容</div>
          </div>
        </div>
        </div>
      </div>

    </div>  </div>
</div>

<button class="back-to-top" id="backToTop" onclick="scrollToTop()" title="回到顶部">↑</button>

<script>
// ═══════════════════════════════════════════════════════
// Data
// ═══════════════════════════════════════════════════════
const LS_JOBS = 'b2t_jobs';
const LS_KEYS = 'b2t_keys';

// Local storage — fast access
function getJobs() { try { return JSON.parse(localStorage.getItem(LS_JOBS)||'[]'); } catch { return []; } }
function saveJobs(j) { 
  localStorage.setItem(LS_JOBS, JSON.stringify(j)); 
  renderList(); 
  updateBadge();
  // Async R2 sync (fire-and-forget)
  r2SaveJobs(j);
}

// R2 sync — cross-device shared history
let r2Loaded = false;
async function r2LoadJobs() {
  try {
    const resp = await fetch('/api/history');
    if (!resp.ok) return;
    const jobs = await resp.json();
    if (Array.isArray(jobs) && jobs.length > 0) {
      localStorage.setItem(LS_JOBS, JSON.stringify(jobs));
      console.log('[b2t] R2 history loaded:', jobs.length, 'jobs');
    }
  } catch(e) {
    console.warn('[b2t] R2 load failed:', e.message);
  }
  r2Loaded = true;
}
async function r2SaveJobs(j) {
  if (!r2Loaded) return; // Don't write until initial load completed
  try {
    await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobs: j }),
    });
  } catch(e) {
    // Silent fail — localStorage is the primary store
  }
}
function getKeys() { try { return JSON.parse(localStorage.getItem(LS_KEYS)||'{}'); } catch { return {}; } }
function saveKeys(k) { localStorage.setItem(LS_KEYS, JSON.stringify(k)); }

let selectedJobId = null;
let selectedIds = [];

// ═══════════════════════════════════════════════════════
// Theme
// ═══════════════════════════════════════════════════════
function toggleTheme() {
  const h=document.documentElement;
  const n=h.getAttribute('data-theme')==='dark'?'light':'dark';
  h.setAttribute('data-theme',n); localStorage.setItem('theme',n);
}
(function(){const s=localStorage.getItem('theme');if(s)document.documentElement.setAttribute('data-theme',s);})();

// ═══════════════════════════════════════════════════════
// Draggable Sidebar Divider
// ═══════════════════════════════════════════════════════
(function(){
  const app=document.getElementById('app');
  const divider=document.getElementById('divider');
  if(!app||!divider) return;
  // Restore saved width
  const saved=localStorage.getItem('b2t_sidebar_w');
  if(saved) app.style.setProperty('--sidebar-w',saved);
  let isDragging=false;
  divider.addEventListener('mousedown',function(e){isDragging=true;e.preventDefault();document.body.style.cursor='col-resize';});
  document.addEventListener('mousemove',function(e){
    if(!isDragging) return;
    const rect=app.getBoundingClientRect();
    const pct=((e.clientX-rect.left)/rect.width*100).toFixed(1);
    const sw=Math.max(18,Math.min(55,pct));
    app.style.setProperty('--sidebar-w',sw+'%');
  });
  document.addEventListener('mouseup',function(){
    if(!isDragging)return;
    isDragging=false;
    document.body.style.cursor='';
    const sw=app.style.getPropertyValue('--sidebar-w');
    if(sw) localStorage.setItem('b2t_sidebar_w',sw);
  });
})();

// ═══════════════════════════════════════════════════════
// Layout Switch (v/h/s)
// ═══════════════════════════════════════════════════════
function setLayout(mode) {
  console.log('[b2t] setLayout:', mode);
  const body=document.getElementById('detailBody');
  if(!body) return;
  body.className='detail-body layout-'+mode;
  document.querySelectorAll('.layout-btn').forEach(b=>b.classList.toggle('active',b.dataset.layout===mode));
  localStorage.setItem('b2t_layout',mode);
}
// Restore saved layout
(function(){
  const saved=localStorage.getItem('b2t_layout');
  if(saved) setLayout(saved);
})();
// Draggable pair-divider (split mode)
(function(){
  const divider=document.getElementById('pairDivider');
  if(!divider) return;
  let isDragging=false,startX=0,startLeft=0;
  const leftPanel=document.getElementById('transcriptPanel');
  const rightPanel=document.getElementById('summaryPanel');
  if(!leftPanel||!rightPanel) return;
  divider.addEventListener('mousedown',function(e){
    isDragging=true;startX=e.clientX;
    const pair=document.getElementById('detailPair');
    if(pair) startLeft=leftPanel.getBoundingClientRect().width;
    document.body.style.cursor='col-resize';e.preventDefault();
  });
  document.addEventListener('mousemove',function(e){
    if(!isDragging||!leftPanel||!rightPanel) return;
    const pair=document.getElementById('detailPair');
    if(!pair) return;
    const pairW=pair.getBoundingClientRect().width;
    const dx=e.clientX-startX;
    let leftPct=((startLeft+dx)/pairW*100);
    leftPct=Math.max(20,Math.min(80,leftPct));
    leftPanel.style.flex='0 0 '+leftPct+'%';
    rightPanel.style.flex='1 1 0';
  });
  document.addEventListener('mouseup',function(){
    if(!isDragging)return;
    isDragging=false;document.body.style.cursor='';
  });
})();

// ═══════════════════════════════════════════════════════
// URL extraction — supports av/BV + full URLs with Chinese
// ═══════════════════════════════════════════════════════
function extractBvid(raw) {
  if(!raw) return '';
  let s=raw.trim();
  // Try BV number first
  const bv=s.match(/BV[a-zA-Z0-9]{8,12}/);
  if(bv) return bv[0];
  // Try av number — convert to bvid via API
  const av=s.match(/[Aa][Vv](\d+)/);
  if(av) return 'av'+av[1];
  // Try full URL pattern (supports Chinese chars in title)
  const urlMatch=s.match(/bilibili\\.com\\/video\\/([A-Za-z0-9]+)/i);
  if(urlMatch) return urlMatch[1];
  // Finally check if it looks like a plain BV
  if(/^BV[a-zA-Z0-9]{8,12}$/.test(s)) return s;
  return s;
}
// Paste from clipboard
async function pasteUrl() {
  try {
    const text=await navigator.clipboard.readText();
    if(text){
      document.getElementById('urlInput').value=text;
      console.log('[b2t] pasted:', text.slice(0,60));
    }
  } catch(e) {
    console.warn('[b2t] paste failed:', e.message);
  }
}
// AV → BV conversion
let avBvCache={};
async function convertAvToBv(avId) {
  if(avBvCache[avId]) return avBvCache[avId];
  try {
    const resp=await fetch('https://api.bilibili.com/x/web-interface/view?aid='+avId.replace('av',''));
    if(!resp.ok) return avId;
    const data=await resp.json();
    if(data.code===0&&data.data&&data.data.bvid){
      avBvCache[avId]=data.data.bvid;
      return data.data.bvid;
    }
  } catch(e) {}
  return avId;
}

// ═══════════════════════════════════════════════════════
// Submit
// ═══════════════════════════════════════════════════════
async function submitJob() {
  const input=document.getElementById('urlInput');
  let url=input.value.trim();
  console.log('[b2t] submitJob:', url);
  if(!url){showStatus('请先输入视频链接','error');return;}

  // Extract and convert
  url=extractBvid(url);
  if(!url){showStatus('无法识别视频链接','error');return;}
  
  // If av number, try to convert (async)
  if(url.startsWith('av')){
    const converted=await convertAvToBv(url);
    if(converted!==url) console.log('[b2t] av→bv:', url, '→', converted);
    url=converted;
  }
  
  if(!/^BV[a-zA-Z0-9]{8,12}$/.test(url) && !url.startsWith('av')){
    showStatus('无法解析视频 ID','error');return;
  }

  const btn=document.getElementById('submitBtn');
  btn.disabled=true; btn.innerHTML='<span class="sp"></span> 提交中…';

  try {
    const keys=getKeys();
    const payload={url};
    // 如果前端有自定义 API Key，传给 Worker
    if(keys.apiKey) payload.api_key=keys.apiKey;
    if(keys.sttModel && keys.sttModel!=='FunAudioLLM/SenseVoiceSmall') payload.stt_model=keys.sttModel;
    if(keys.summaryModel && keys.summaryModel!=='Qwen/Qwen3-8B') payload.summary_model=keys.summaryModel;
    if(keys.summaryTemplate) payload.summary_template=keys.summaryTemplate;
    if(keys.email) payload.email=keys.email;

    const resp=await fetch('/api/submit',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    });
    const data=await resp.json();
    if(data.error) throw new Error(data.error);

    const jobs=getJobs();
    const job={
      id:data.job_id, bvid:data.bvid, status:'submitted',
      created_at:new Date().toISOString(), updated_at:new Date().toISOString(),
      title:'', transcript:'', summary:'', error:'',
      steps:[
        {name:'任务创建', done:true, active:false, msg:'已提交至处理队列'},
        {name:'下载视频音频', done:false, active:false, msg:'等待处理…'},
        {name:'语音转录', done:false, active:false, msg:''},
        {name:'LLM 整理总结', done:false, active:false, msg:''},
        {name:'后处理及文件导出', done:false, active:false, msg:''},
        {name:'处理完成', done:false, active:false, msg:''},
      ],
    };
    jobs.unshift(job);
    saveJobs(jobs);
    selectJob(job.id);
    startPolling(data.job_id);
    showStatus(\`✅ 已提交: \${data.bvid}，正在处理…\`, 'success');
    input.value='';
    console.log('[b2t] submitJob OK:', data.bvid, data.job_id);
  } catch(err) {
    console.error('[b2t] submitJob error:', err.message);
    showStatus('❌ '+err.message, 'error');
  } finally {
    btn.disabled=false; btn.textContent='🚀 开始处理';
  }
}

function showStatus(msg, type='') {
  const el=document.getElementById('submitStatus');
  el.textContent=msg;
  el.style.color=type==='error'?'var(--danger)':type==='success'?'var(--success)':'var(--soft)';
  if(type==='success') setTimeout(()=>el.textContent='',8000);
}

// ═══════════════════════════════════════════════════════
// Render History List
// ═══════════════════════════════════════════════════════

function escHtml(s) {
  if(!s) return '';
  return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderList() {
  const jobs=getJobs();
  console.log('[b2t] renderList:', jobs.length, 'jobs');
  const el=document.getElementById('historyList');
  const q=(document.getElementById('searchInput')||{}).value||'';
  const filtered=q ? jobs.filter(j=>{
    const t=(j.title||'').toLowerCase();
    const b=(j.bvid||'').toLowerCase();
    const o=(j.owner||'').toLowerCase();
    const ta=timeAgo(j.created_at).toLowerCase();
    const sq=q.toLowerCase();
    return t.includes(sq)||b.includes(sq)||o.includes(sq)||ta.includes(sq);
  }) : jobs;
  if(jobs.length===0){
    el.innerHTML='<div style="text-align:center;padding:16px;color:var(--muted);font-size:.82rem">暂无记录</div>';
    return;
  }
  if(filtered.length===0){
    el.innerHTML='<div style="text-align:center;padding:16px;color:var(--muted);font-size:.82rem">无匹配结果</div>';
    return;
  }
  const Q="'";
  const selSet=new Set(selectedIds||[]);
  el.innerHTML=filtered.map(j=>{
    const icon=j.status==='submitted'?'⏳':j.status==='done'?'✅':'❌';
    const cls=j.status==='submitted'?'sub':j.status==='done'?'done':'fail';
    const sel=j.id===selectedJobId?'selected':'';
    const checked=selSet.has(j.id)?'checked':'';
    const ago=timeAgo(j.created_at);
    const meta=[];
    if(j.bvid) meta.push('<span class="meta-tag"><a href="https://www.bilibili.com/video/'+j.bvid+'" target="_blank" onclick="event.stopPropagation()" class="meta-link">'+escHtml(j.bvid)+' ↗</a></span>');
    if(j.owner) meta.push('<span class="meta-tag">👤 '+escHtml(j.owner)+'</span>');
    if(j.timings&&j.timings.total) meta.push('<span class="meta-tag">⏱️ '+formatTime(j.timings.total)+'</span>');
    return '<div class="job-item '+sel+'" onclick="selectJob('+Q+j.id+Q+')">'+
      '<input type="checkbox" class="job-check" '+checked+' onclick="event.stopPropagation();toggleJobCheck('+Q+j.id+Q+',this.checked)" />'+
      '<div class="status '+cls+'">'+icon+'</div>'+
      '<div class="job-info">'+
        '<div class="job-title" title="'+escHtml(j.title||j.bvid)+'">'+escHtml(j.title||j.bvid)+'</div>'+
        '<div class="job-meta">'+meta.join('')+'</div>'+
        '<div class="job-time">'+ago+'</div>'+
      '</div>'+
      '<div class="job-actions">'+
        '<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteJob('+Q+j.id+Q+')">🗑</button>'+
      '</div>'+
    '</div>';
  }).join('');
}
function selectJob(id) {
  console.log('[b2t] selectJob:', id);
  selectedJobId=id;
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('detailView').classList.remove('hidden');
  renderList();
  renderDetail(id);
}

function getSelectedJob() {
  return getJobs().find(j=>j.id===selectedJobId);
}

function renderDetail(id) {
  const job=getJobs().find(j=>j.id===id);
  if(!job) { console.warn('[b2t] renderDetail job not found:', id); return; }
  console.log('[b2t] renderDetail:', id, job.bvid);

  // Progress steps — 2-row flex layout with arrow flow: row1[0,1,2] row2[3,4,5]
  const pe=document.getElementById('progressSteps');
  if(pe){
    const row1=job.steps.slice(0,3);
    const row2=job.steps.slice(3,6);
    const renderRow=arr=>arr.map((s,i,all)=>{
      const cls=s.done?'done':s.active?'active':'pending';
      const msg=s.msg?'<div class="step-msg">'+escHtml(s.msg)+'</div>':'';
      const card='<div class="progress-step '+cls+'"><span class="step-label">'+s.name+'</span>'+msg+'</div>';
      // Add arrow separator between steps (not after the last one)
      const arrow=i<all.length-1?'<span class="arrow-sep '+cls+'">→</span>':'';
      return card+arrow;
    }).join('');
    pe.innerHTML='<div class="progress-row r1">'+renderRow(row1)+'</div><div class="progress-row r2">'+renderRow(row2)+'</div>';
  }

  // Transcript
  const tc=document.getElementById('transcriptContent');
  if(tc) tc.textContent=job.transcript||'（暂无转录内容，收到邮件后可手动添加）';

  // Summary — content view only
  const sumContent=document.getElementById('summaryContent');
  if(sumContent){sumContent.textContent=job.summary||'（暂无总结内容，收到邮件后可手动添加）';}
}

// ═══════════════════════════════════════════════════════
// Accordion Toggle
// ═══════════════════════════════════════════════════════
function toggleAccordion(header) {
  const body=header.nextElementSibling;
  if(!body) return;
  header.classList.toggle('open');
  body.classList.toggle('hidden');
}

// ═══════════════════════════════════════════════════════
// Polling: Refresh job status from R2
// ═══════════════════════════════════════════════════════
const pollingTimers = {};
const POLL_INTERVAL = 10000; // 10 seconds

function startPolling(jobId) {
  console.log('[b2t] startPolling:', jobId);
  if(pollingTimers[jobId]) clearInterval(pollingTimers[jobId]);
  pollingTimers[jobId] = setInterval(() => pollJobStatus(jobId), POLL_INTERVAL);
  // Immediate first poll
  pollJobStatus(jobId);
}

async function pollJobStatus(jobId) {
  console.log('[b2t] pollJobStatus:', jobId);
  try {
    const resp = await fetch('/api/jobs/' + jobId);
    if(!resp.ok) { console.warn('[b2t] pollJobStatus resp not ok:', resp.status); return; }
    const r2job = await resp.json();
    
    const jobs = getJobs();
    const idx = jobs.findIndex(j => j.id === jobId);
    if(idx === -1) return;
    
    const job = jobs[idx];
    
    // If still pending but has gh_status, update steps in real-time
    if(r2job.status !== 'completed' && r2job.status !== 'failed') {
      console.log('[b2t] pollJobStatus in_progress, steps:', r2job.gh_steps?.length);
      if(r2job.gh_steps) {
        job.steps = r2job.gh_steps;
      }
      if(r2job.gh_html_url) {
        job.gh_html_url = r2job.gh_html_url;
      }
      saveJobs(jobs);
      if(selectedJobId === jobId) renderDetail(jobId);
      return;
    }
    
    // R2 has a completed/failed result — update local storage
    console.log('[b2t] pollJobStatus done/fail:', r2job.status, r2job.bvid);
    job.status = r2job.status === 'completed' ? 'done' : 'failed';
    job.title = r2job.title || job.title;
    job.owner = r2job.owner || job.owner || '';
    job.pubdate = r2job.pubdate || job.pubdate || null;
    job.summary = r2job.summary || job.summary;
    job.transcript = r2job.transcript || job.transcript;
    job.timings = r2job.timings || {};
    job.updated_at = new Date().toISOString();
    
    // Mark all steps as done with timing info
    const timings = r2job.timings || {};
    job.steps = job.steps.map((s, i) => {
      let msg = '';
      if (i === 1 && timings.stt) msg = formatTime(timings.stt);
      else if (i === 3 && timings.summary) msg = formatTime(timings.summary);
      else if (i === 5 && timings.total) msg = formatTime(timings.total);
      return {...s, done: true, active: false, msg: msg || '✅ 完成'};
    });
    
    saveJobs(jobs);
    
    // If this job is currently selected, refresh the detail view
    if(selectedJobId === jobId) {
      renderDetail(jobId);
    }
    
    // Stop polling for this job
    if(pollingTimers[jobId]) {
      clearInterval(pollingTimers[jobId]);
      delete pollingTimers[jobId];
      console.log('[b2t] pollJobStatus done, polling stopped for:', jobId);
    }
  } catch(e) {
    // Silently fail
  }
}

// ═══════════════════════════════════════════════════════
// Copy & Download
// ═══════════════════════════════════════════════════════
function copyTranscript() {
  const job=getSelectedJob();
  if(!job||!job.transcript) return;
  navigator.clipboard.writeText(job.transcript).then(()=>showStatus('✅ 已复制')).catch(()=>{});
}
function copySummary() {
  const job=getSelectedJob();
  if(!job||!job.summary) return;
  navigator.clipboard.writeText(job.summary).then(()=>showStatus('✅ 已复制')).catch(()=>{});
}
function downloadTranscript() {
  const job=getSelectedJob();
  if(!job||!job.transcript) return;
  const blob=new Blob([job.transcript],{type:'text/plain;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=\`\${job.bvid}_transcript.txt\`;a.click();
}
function downloadSummary() {
  const job=getSelectedJob();
  if(!job||!job.summary) return;
  const blob=new Blob([job.summary],{type:'text/markdown;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=\`\${job.bvid}_summary.md\`;a.click();
}
function downloadSummaryTXT() {
  const job=getSelectedJob();
  if(!job||!job.summary) return;
  const blob=new Blob([job.summary],{type:'text/plain;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=\`\${job.bvid}_summary.txt\`;a.click();
}

function downloadTranscriptMD() {
  const job=getSelectedJob();
  if(!job||!job.transcript) return;
  const NL=String.fromCharCode(10);
  const md='# 转录文本'+NL+NL+'**视频**: '+job.bvid+NL+NL+job.transcript.split(NL).map(l=>'> '+l).join(NL);
  const blob=new Blob([md],{type:'text/markdown;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=job.bvid+'_transcript.md';a.click();
}

// ═══════════════════════════════════════════════════════
// Delete
// ═══════════════════════════════════════════════════════
function deleteJob(id) {
  console.log('[b2t] deleteJob:', id);
  if(!confirm('确定删除？')) return;
  const jobs=getJobs().filter(j=>j.id!==id);
  saveJobs(jobs);
  if(selectedJobId===id){
    selectedJobId=null;
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('detailView').classList.add('hidden');
  }
  selectedIds=selectedIds.filter(i=>i!==id);
}

function clearAllJobs() {
  if(!confirm('确定清除所有历史记录？此操作不可撤销！')) return;
  localStorage.removeItem(LS_JOBS);
  selectedJobId=null;
  selectedIds=[];
  document.getElementById('emptyState').classList.remove('hidden');
  document.getElementById('detailView').classList.add('hidden');
  renderList();
  updateBadge();
  // Also clear from R2
  fetch('/api/history', { method: 'DELETE' }).catch(()=>{});
}

// ═══════════════════════════════════════════════════════
// Save frontend keys
// ═══════════════════════════════════════════════════════
document.getElementById('apiKeyInput').addEventListener('change', function(){
  const keys=getKeys();
  keys.apiKey=this.value;
  saveKeys(keys);
});
document.getElementById('sttModelSelect').addEventListener('change', function(){
  const keys=getKeys();
  keys.sttModel=this.value;
  saveKeys(keys);
});
document.getElementById('summaryModelSelect').addEventListener('change', function(){
  const keys=getKeys();
  keys.summaryModel=this.value;
  saveKeys(keys);
});
document.getElementById('summaryTemplateInput').addEventListener('input', function(){
  const keys=getKeys();
  keys.summaryTemplate=this.value;
  saveKeys(keys);
});
document.getElementById('emailInput').addEventListener('change', function(){
  const keys=getKeys();
  keys.email=this.value;
  saveKeys(keys);
});
// Restore saved keys
(function(){
  const keys=getKeys();
  if(keys.apiKey) document.getElementById('apiKeyInput').value=keys.apiKey;
  if(keys.sttModel) document.getElementById('sttModelSelect').value=keys.sttModel;
  if(keys.summaryModel) document.getElementById('summaryModelSelect').value=keys.summaryModel;
  if(keys.summaryTemplate) document.getElementById('summaryTemplateInput').value=keys.summaryTemplate;
  if(keys.email) document.getElementById('emailInput').value=keys.email;
})();

// ═══════════════════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════════════════
function formatTime(seconds) {
  if(!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? m + 'min' + s + 's' : s + 's';
}

function timeAgo(iso) {
  if(!iso) return '';
  const now=Date.now();
  const dt=new Date(iso).getTime();
  const diff=Math.floor((now-dt)/1000);
  if(diff<60) return '刚刚';
  if(diff<3600) return Math.floor(diff/60)+' 分钟前';
  if(diff<86400) return Math.floor(diff/3600)+' 小时前';
  // Past 24h → show exact date+time
  const d=new Date(iso);
  const pad=n=>n<10?'0'+n:''+n;
  return d.getFullYear()+'/'+pad(d.getMonth()+1)+'/'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());
}

function updateBadge() {
  const jobs=getJobs();
  document.getElementById('countBadge').textContent=\`\${jobs.length} 条\`;
}

// Back to top
function scrollToTop() {
  const main=document.getElementById('mainContent');
  main.scrollTo({top:0,behavior:'smooth'});
}
(function(){
  const main=document.getElementById('mainContent');
  const btn=document.getElementById('backToTop');
  if(main&&btn){
    main.addEventListener('scroll',function(){
      btn.classList.toggle('show',main.scrollTop>300);
    });
  }
})();

function formatPubDate(ts) {
  if(!ts) return '';
  return new Date(ts*1000).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});
}

// ═══════════════════════════════════════════════════════
// Selection
// ═══════════════════════════════════════════════════════
function toggleJobCheck(id, checked) {
  if(checked) selectedIds.push(id);
  else selectedIds=selectedIds.filter(i=>i!==id);
}
function toggleSelectAll() {
  const jobs=getJobs();
  const q=document.getElementById('searchInput').value||'';
  const filtered=q?jobs.filter(j=>{
    const t=(j.title||'').toLowerCase();
    const b=(j.bvid||'').toLowerCase();
    const o=(j.owner||'').toLowerCase();
    const ta=timeAgo(j.created_at).toLowerCase();
    const sq=q.toLowerCase();
    return t.includes(sq)||b.includes(sq)||o.includes(sq)||ta.includes(sq);
  }):jobs;
  if(selectedIds.length===filtered.length) { selectedIds=[]; }
  else { selectedIds=filtered.map(j=>j.id); }
  renderList();
}
function invertSelection() {
  const jobs=getJobs();
  const q=document.getElementById('searchInput').value||'';
  const filtered=q?jobs.filter(j=>{
    const t=(j.title||'').toLowerCase();
    const b=(j.bvid||'').toLowerCase();
    const o=(j.owner||'').toLowerCase();
    const ta=timeAgo(j.created_at).toLowerCase();
    const sq=q.toLowerCase();
    return t.includes(sq)||b.includes(sq)||o.includes(sq)||ta.includes(sq);
  }):jobs;
  const selSet=new Set(selectedIds);
  selectedIds=filtered.map(j=>j.id).filter(id=>!selSet.has(id));
  renderList();
}
function deleteSelectedJobs() {
  console.log('[b2t] deleteSelectedJobs:', selectedIds?.length, 'selected');
  if(!selectedIds||selectedIds.length===0) { showStatus('请先勾选记录','error'); return; }
  const total=getJobs().length;
  const isAll=selectedIds.length>=total;
  const msg=isAll?'确定清除所有 '+total+' 条历史记录？此操作不可撤销！':'确定删除已勾选的 '+selectedIds.length+' 条记录？';
  if(!confirm(msg)) return;
  if(isAll){
    localStorage.removeItem(LS_JOBS);
    selectedJobId=null;
    selectedIds=[];
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('detailView').classList.add('hidden');
    renderList();
    updateBadge();
    fetch('/api/history',{method:'DELETE'}).catch(()=>{});
    return;
  }
  const ids=new Set(selectedIds);
  const jobs=getJobs().filter(j=>!ids.has(j.id));
  if(ids.has(selectedJobId)){
    selectedJobId=null;
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('detailView').classList.add('hidden');
  }
  saveJobs(jobs);
  selectedIds=[];
}

// Init
renderList();
updateBadge();

// Load from R2 after initial render, then re-render if needed
r2LoadJobs().then(() => { renderList(); updateBadge(); });

// Resume polling for any submitted jobs
const existingJobs = getJobs();
existingJobs.forEach(j => {
  if(j.status === 'submitted' || (j.status === 'pending')) {
    startPolling(j.id);
  }
});

// Check R2
fetch('/api/stats').then(r=>r.json()).then(d=>{
  if(d.mode==='localstorage') document.getElementById('noR2Notice').style.display='block';
}).catch(()=>{});
</script>
</body>
</html>
`;
}
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const path = url.pathname;

    try {
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
      return errorResponse('Internal Server Error', 500);
    }
  },

  async scheduled(event, env, ctx) {
    await handleCron(event, env);
  },
};
