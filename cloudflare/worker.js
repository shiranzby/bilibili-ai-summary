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
// API Handlers
// ═══════════════════════════════════════════════════════

async function handleSubmit(request, env) {
  const { url } = await request.json();
  if (!url || typeof url !== 'string') {
    return errorResponse('请提供 B站视频 URL 或 BV 号');
  }

  let bvid = url.trim();
  const bvMatch = bvid.match(/BV[a-zA-Z0-9]{10}/);
  if (bvMatch) bvid = bvMatch[0];
  if (!/^BV[a-zA-Z0-9]{10}$/.test(bvid)) {
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
  
  try {
    const ghResp = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${env.GH_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'bilibili-ai-summary-worker/1.0',
      },
      body: JSON.stringify({ ref: env.GH_REF || 'main', inputs: { bvid, job_id: jobId } }),
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
  return jsonResponse(await raw.json());
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
  // GHA 跑完后回调: POST { job_id, bvid, status, summary, title }
  // 删除 pending 标记 → 写入 results/{job_id}.json
  if (!env.BILIBILI_BUCKET) {
    return errorResponse('R2 未配置', 503);
  }
  
  const body = await request.json();
  const { job_id, bvid, status, summary, title } = body;
  
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
    title: title || '',
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
:root{--bg:#f8fafc;--surface:#fff;--border:#e2e8f0;--text:#0f172a;--soft:#475569;--muted:#94a3b8;--brand:#14b8a6;--accent:#0ea5e9;--danger:#ef4444;--success:#22c55e;--radius:12px}
[data-theme="dark"]{--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#f1f5f9;--soft:#cbd5e1;--muted:#64748b}
body{font-family:-apple-system,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.app{display:grid;grid-template-columns:380px 1fr;min-height:100vh;max-width:1200px;margin:0 auto}
@media(max-width:800px){.app{grid-template-columns:1fr}}
/* Sidebar */
.sidebar{background:var(--surface);border-right:1px solid var(--border);padding:24px;overflow-y:auto}
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
.main{padding:24px;overflow-y:auto;max-height:100vh}
.main h2{font-size:1rem;font-weight:700;margin-bottom:12px;color:var(--soft);text-transform:uppercase;letter-spacing:.03em}
/* Notice */
.notice{padding:12px 16px;background:#fef3c7;border:1px solid #f59e0b;border-radius:10px;font-size:.82rem;color:#92400e;margin-bottom:16px;line-height:1.6}
/* Progress */
.progress{display:grid;gap:8px;margin-bottom:20px}
.progress-step{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:.85rem}
.progress-step .icon{width:24px;text-align:center;font-size:1rem}
.progress-step .step-label{flex:1}
.progress-step.done{border-color:var(--success);background:#f0fdf4}
.progress-step.active{border-color:var(--accent);background:#eff6ff}
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
.job-bvid{font-weight:700;font-size:.88rem}
.job-time{font-size:.78rem;color:var(--muted)}
.job-title{font-size:.82rem;color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.job-actions{display:flex;gap:4px;flex-shrink:0}
/* Detail panel */
.detail-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.detail-card h3{font-size:.85rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px}
.detail-card .content{font-size:.88rem;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto}
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
.tab-bar{display:flex;gap:4px;padding:4px;background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:16px}
.tab-btn{flex:1;padding:8px 12px;border:none;border-radius:7px;background:transparent;color:var(--soft);font-size:.8rem;font-weight:600;cursor:pointer;transition:all .2s}
.tab-btn.active{background:var(--brand);color:#fff;box-shadow:0 2px 6px rgba(20,184,166,.2)}
</style>
</head>
<body>
<button class="ht" onclick="toggleTheme()">🌓</button>
<div class="app" id="app">
  <!-- Sidebar -->
  <div class="sidebar">
    <h1>🎬 B站AI摘要</h1>

    <div class="notice" id="noR2Notice" style="display:none">
      💡 结果通过<strong>邮件发送</strong>，收到后可在详情页手动添加总结内容。
    </div>

    <div class="form-group">
      <label>B站视频链接或 BV 号</label>
      <input id="urlInput" type="text" placeholder="bilibili.com/video/BVxxx 或直接输入BV号…"
        onkeydown="if(event.key==='Enter')submitJob()" />
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
          <select id="sttModelSelect">
            <option value="FunAudioLLM/SenseVoiceSmall">SenseVoiceSmall (默认)</option>
            <option value="FunAudioLLM/SenseVoiceLarge">SenseVoiceLarge</option>
          </select>
        </div>
        <div class="form-group">
          <label>AI 总结模型</label>
          <select id="summaryModelSelect">
            <option value="Qwen/Qwen3-8B">Qwen3-8B (默认)</option>
            <option value="Qwen/Qwen3-14B">Qwen3-14B</option>
            <option value="deepseek-ai/DeepSeek-V3">DeepSeek V3</option>
            <option value="Pro/Qwen/Qwen3-8B">Qwen3-8B (Pro)</option>
          </select>
        </div>
      </div>
    </details>

    <button class="btn btn-primary" id="submitBtn" onclick="submitJob()">
      🚀 开始处理
    </button>
    <div id="submitStatus" style="margin-top:10px;font-size:.82rem"></div>

    <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:.82rem;font-weight:700;color:var(--soft)">📋 历史记录</span>
        <span id="countBadge" class="badge"></span>
      </div>
      <div id="historyList" style="max-height:400px;overflow-y:auto"></div>
    </div>
  </div>

  <!-- Main Content -->
  <div class="main" id="mainContent">
    <div class="empty" id="emptyState">
      <div class="big">🎬</div>
      <p>在左侧输入 B站视频链接，点击「开始处理」</p>
      <p style="margin-top:4px;font-size:.82rem">处理完成后会收到邮件，可在详情中添加总结内容</p>
    </div>

    <!-- Job Detail (hidden initially) -->
    <div id="detailView" class="hidden" style="width:100%">
      <div class="tab-bar">
        <button class="tab-btn active" data-tab="progress" onclick="switchDetailTab('progress')">📊 进度</button>
        <button class="tab-btn" data-tab="transcript" onclick="switchDetailTab('transcript')">📝 转录文本</button>
        <button class="tab-btn" data-tab="summary" onclick="switchDetailTab('summary')">🤖 AI 总结</button>
        <button class="tab-btn" data-tab="email" onclick="switchDetailTab('email')">📧 邮件预览</button>
      </div>

      <!-- Progress Tab -->
      <div id="dt-progress" class="tab-content">
        <div class="progress" id="progressSteps"></div>
      </div>

      <!-- Transcript Tab -->
      <div id="dt-transcript" class="tab-content hidden">
        <div class="detail-card">
          <div class="flex" style="justify-content:space-between">
            <h3>转录文本</h3>
            <div class="flex gap-sm">
              <button class="btn btn-sm btn-outline" onclick="downloadTranscript()">⬇ 下载</button>
              <button class="btn btn-sm btn-outline" onclick="copyTranscript()">📋 复制</button>
            </div>
          </div>
          <div class="content" id="transcriptContent">加载中…</div>
        </div>
      </div>

      <!-- Summary Tab -->
      <div id="dt-summary" class="tab-content hidden">
        <div class="detail-card">
          <div class="flex" style="justify-content:space-between">
            <h3>AI 总结</h3>
            <div class="flex gap-sm">
              <button class="btn btn-sm btn-outline" onclick="downloadSummary()">⬇ 下载</button>
              <button class="btn btn-sm btn-outline" onclick="copySummary()">📋 复制</button>
            </div>
          </div>
          <textarea id="summaryEditor" oninput="saveSummary()" placeholder="总结内容将在这里显示…&#10;&#10;收到邮件后，可以粘贴到这里保存。"></textarea>
          <div class="flex mt">
            <button class="btn btn-sm btn-primary" onclick="saveSummary()">💾 保存</button>
            <span style="font-size:.78rem;color:var(--muted);margin-left:8px" id="summarySavedHint"></span>
          </div>
        </div>
      </div>

      <!-- Email Preview Tab -->
      <div id="dt-email" class="tab-content hidden">
        <div class="detail-card">
          <h3>HTML 邮件预览</h3>
          <div class="content" id="emailPreview"></div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
// ═══════════════════════════════════════════════════════
// Data
// ═══════════════════════════════════════════════════════
const LS_JOBS = 'b2t_jobs';
const LS_KEYS = 'b2t_keys';

function getJobs() { try { return JSON.parse(localStorage.getItem(LS_JOBS)||'[]'); } catch { return []; } }
function saveJobs(j) { localStorage.setItem(LS_JOBS, JSON.stringify(j)); renderList(); updateBadge(); }
function getKeys() { try { return JSON.parse(localStorage.getItem(LS_KEYS)||'{}'); } catch { return {}; } }
function saveKeys(k) { localStorage.setItem(LS_KEYS, JSON.stringify(k)); }

let selectedJobId = null;

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
// Submit
// ═══════════════════════════════════════════════════════
async function submitJob() {
  const input=document.getElementById('urlInput');
  const url=input.value.trim();
  if(!url){showStatus('请先输入视频链接','error');return;}

  const btn=document.getElementById('submitBtn');
  btn.disabled=true; btn.innerHTML='<span class="sp"></span> 提交中…';

  try {
    const keys=getKeys();
    const payload={url};
    // 如果前端有自定义 API Key，传给 Worker
    if(keys.apiKey) payload.api_key=keys.apiKey;
    if(keys.sttModel && keys.sttModel!=='FunAudioLLM/SenseVoiceSmall') payload.stt_model=keys.sttModel;
    if(keys.summaryModel && keys.summaryModel!=='Qwen/Qwen3-8B') payload.summary_model=keys.summaryModel;

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
        {name:'提交任务', done:true, active:false, msg:'已提交至处理队列'},
        {name:'下载音频', done:false, active:false, msg:'等待处理…'},
        {name:'语音转文字', done:false, active:false, msg:''},
        {name:'AI 总结', done:false, active:false, msg:''},
        {name:'邮件通知', done:false, active:false, msg:''},
      ],
    };
    jobs.unshift(job);
    saveJobs(jobs);
    selectJob(job.id);
    showStatus(\`✅ 已提交: \${data.bvid}，结果将通过邮件发送\`, 'success');
    input.value='';
  } catch(err) {
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
function renderList() {
  const jobs=getJobs();
  const el=document.getElementById('historyList');
  if(jobs.length===0){
    el.innerHTML='<div style="text-align:center;padding:16px;color:var(--muted);font-size:.82rem">暂无记录</div>';
    return;
  }
  el.innerHTML=jobs.map(j=>{
    const icon=j.status==='submitted'?'⏳':j.status==='done'?'✅':'❌';
    const cls=j.status==='submitted'?'sub':j.status==='done'?'done':'fail';
    const sel=j.id===selectedJobId?'selected':'';
    const ago=timeAgo(j.created_at);
    return \`<div class="job-item \${sel}" onclick="selectJob('\${j.id}')">
      <div class="status \${cls}">\${icon}</div>
      <div class="job-info">
        <div class="job-bvid">\${j.bvid}</div>
        <div class="job-time">\${ago}</div>
      </div>
      <div class="job-actions">
        <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteJob('\${j.id}')">🗑</button>
      </div>
    </div>\`;
  }).join('');
}

function updateBadge() {
  const jobs=getJobs();
  document.getElementById('countBadge').textContent=\`\${jobs.length} 条\`;
}

// ═══════════════════════════════════════════════════════
// Select & Display Job
// ═══════════════════════════════════════════════════════
function selectJob(id) {
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
  if(!job) return;

  // Progress steps
  const pe=document.getElementById('progressSteps');
  pe.innerHTML=job.steps.map(s=>
    \`<div class="progress-step \${s.done?'done':''} \${s.active?'active':''}">
      <div class="icon">\${s.done?'✅':s.active?'🔄':'⏳'}</div>
      <div class="step-label">\${s.name}</div>
      <div style="font-size:.78rem;color:var(--muted)">\${s.msg||''}</div>
    </div>\`
  ).join('');

  // Transcript
  document.getElementById('transcriptContent').textContent=job.transcript||'（暂无转录内容，收到邮件后可手动添加）';

  // Summary
  document.getElementById('summaryEditor').value=job.summary||'';

  // Email Preview
  const ep=document.getElementById('emailPreview');
  if(job.summary){
    ep.innerHTML=buildEmailHTML(job.bvid, job.summary);
  } else {
    ep.innerHTML='<div style="color:var(--muted)">暂无总结内容</div>';
  }

  switchDetailTab('progress');
}

// ═══════════════════════════════════════════════════════
// Tab Switching
// ═══════════════════════════════════════════════════════
function switchDetailTab(tab) {
  document.querySelectorAll('#detailView .tab-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.tab===tab);
  });
  document.querySelectorAll('#detailView .tab-content').forEach(el=>{
    el.classList.toggle('hidden', el.id!=='dt-'+tab);
  });
}

// ═══════════════════════════════════════════════════════
// Summary Save
// ═══════════════════════════════════════════════════════
function saveSummary() {
  const jobs=getJobs();
  const idx=jobs.findIndex(j=>j.id===selectedJobId);
  if(idx===-1) return;
  const text=document.getElementById('summaryEditor').value;
  jobs[idx].summary=text;
  jobs[idx].updated_at=new Date().toISOString();
  if(text) jobs[idx].status='done';
  saveJobs(jobs);
  const hint=document.getElementById('summarySavedHint');
  hint.textContent='✅ 已保存';
  setTimeout(()=>hint.textContent='',2000);
  renderDetail(selectedJobId);
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
  const text=document.getElementById('summaryEditor').value;
  if(!text) return;
  navigator.clipboard.writeText(text).then(()=>showStatus('✅ 已复制')).catch(()=>{});
}
function downloadTranscript() {
  const job=getSelectedJob();
  if(!job||!job.transcript) return;
  const blob=new Blob([job.transcript],{type:'text/plain;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=\`\${job.bvid}_transcript.txt\`;a.click();
}
function downloadSummary() {
  const text=document.getElementById('summaryEditor').value;
  if(!text) return;
  const blob=new Blob([text],{type:'text/plain;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=\`\${(getSelectedJob()||{}).bvid||'summary'}_summary.txt\`;a.click();
}

// ═══════════════════════════════════════════════════════
// Delete
// ═══════════════════════════════════════════════════════
function deleteJob(id) {
  if(!confirm('确定删除？')) return;
  const jobs=getJobs().filter(j=>j.id!==id);
  saveJobs(jobs);
  if(selectedJobId===id){
    selectedJobId=null;
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('detailView').classList.add('hidden');
  }
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
// Restore saved keys
(function(){
  const keys=getKeys();
  if(keys.apiKey) document.getElementById('apiKeyInput').value=keys.apiKey;
  if(keys.sttModel) document.getElementById('sttModelSelect').value=keys.sttModel;
  if(keys.summaryModel) document.getElementById('summaryModelSelect').value=keys.summaryModel;
})();

// ═══════════════════════════════════════════════════════
// HTML Email Builder
// ═══════════════════════════════════════════════════════
function buildEmailHTML(bvid, summary) {
  const html=summary.replace(/\\n/g, '<br>');
  return \`<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
<div style="background:linear-gradient(135deg,#14b8a6,#0ea5e9);color:white;padding:24px;border-radius:12px;margin-bottom:20px">
<h2 style="margin:0">🎬 B站视频摘要</h2>
<p style="margin:8px 0 0;opacity:.9">\${bvid}</p>
</div>
<div style="border-left:4px solid #14b8a6;padding-left:16px;line-height:1.7">\${html}</div>
<p style="margin-top:20px"><a href="https://www.bilibili.com/video/\${bvid}" style="color:#14b8a6;font-weight:bold">🔗 在B站观看</a></p>
</div>\`;
}

// ═══════════════════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════════════════
function timeAgo(iso) {
  if(!iso) return '';
  const diff=Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if(diff<60) return '刚刚';
  if(diff<3600) return Math.floor(diff/60)+' 分钟前';
  if(diff<86400) return Math.floor(diff/3600)+' 小时前';
  return new Date(iso).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});
}

// Init
renderList();
updateBadge();

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
      if (path === '/api/submit' && request.method === 'POST') return await handleSubmit(request, env);
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
