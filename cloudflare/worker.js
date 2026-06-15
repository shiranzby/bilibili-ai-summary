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
  for await (const obj of R2.list()) {
    if (obj.key.startsWith('results/')) {
      objects.push({ key: obj.key, uploaded: obj.uploaded });
    }
  }
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

  // 触发 GitHub Actions
  fetch(`https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/manual.yml/dispatches`, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${env.GH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GH_REF || 'main', inputs: { bvid, job_id: jobId } }),
  }).catch(err => console.error('GitHub dispatch failed:', err));

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
  for await (const obj of env.BILIBILI_BUCKET.list()) {
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

async function handleStats(request, env) {
  if (!env.BILIBILI_BUCKET) {
    return jsonResponse({ mode: 'localstorage', note: 'R2 未配置 — 使用浏览器 LocalStorage', max_results: MAX_RESULTS });
  }
  let pending = 0, completed = 0;
  for await (const obj of env.BILIBILI_BUCKET.list()) {
    if (obj.key.startsWith('pending/')) pending++;
    if (obj.key.startsWith('results/')) completed++;
  }
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
:root{--bg:#f8fafc;--surface:rgba(255,255,255,0.85);--surface-border:rgba(203,213,225,0.7);--text:#0f172a;--text-soft:#475569;--text-muted:#94a3b8;--brand:#14b8a6;--accent:#0ea5e9;--danger:#ef4444;--success:#22c55e;--radius:14px;--shadow:0 4px 16px rgba(15,23,42,0.06)}
[data-theme="dark"]{--bg:#0f172a;--surface:rgba(30,41,59,0.85);--surface-border:rgba(51,65,85,0.7);--text:#f1f5f9;--text-soft:#cbd5e1;--text-muted:#64748b;--shadow:0 4px 16px rgba(0,0,0,0.2)}
body{font-family:-apple-system,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;transition:background .3s,color .3s}
.container{max-width:880px;margin:0 auto;padding:32px 20px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;flex-wrap:wrap;gap:12px}
h1{font-size:1.6rem;font-weight:800;background:linear-gradient(135deg,var(--brand),var(--accent));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.ht{background:var(--surface);border:1px solid var(--surface-border);border-radius:10px;padding:8px 14px;cursor:pointer;font-size:.85rem;color:var(--text-soft);transition:all .2s}
.ht:hover{border-color:var(--brand)}
.card{background:var(--surface);border:1px solid var(--surface-border);border-radius:var(--radius);padding:24px;margin-bottom:20px;backdrop-filter:blur(12px);box-shadow:var(--shadow)}
.ct{font-size:.85rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:12px}
.ir{display:flex;gap:10px;flex-wrap:wrap}
.ir input{flex:1;min-width:200px;padding:12px 16px;border:1px solid var(--surface-border);border-radius:12px;background:rgba(255,255,255,0.7);color:var(--text);font-size:.95rem;outline:0;transition:border-color .2s}
.ir input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(14,165,233,0.12)}
.btn{padding:12px 24px;border:none;border-radius:12px;font-size:.9rem;font-weight:700;cursor:pointer;transition:all .2s;white-space:nowrap}
.btn-p{background:linear-gradient(135deg,var(--brand),var(--accent));color:#fff}
.btn-p:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(20,184,166,0.3)}
.btn-p:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
.btn-d{background:transparent;border:1px solid var(--danger);color:var(--danger);padding:6px 12px;font-size:.8rem}
.btn-d:hover{background:var(--danger);color:#fff}
.hint{font-size:.82rem;color:var(--text-muted);margin-top:8px}
.ji{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--surface-border)}
.ji:last-child{border-bottom:0}
.js{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:800;flex-shrink:0}
.js.sub{background:#fef3c7;color:#92400e}
.js.pending{background:#dbeafe;color:#1e40af}
.js.done{background:#dcfce7;color:#166534}
.js.failed{background:#fee2e2;color:#991b1b}
.ji{flex:1;min-width:0}
.jb{font-weight:700;font-size:.9rem}
.jt{font-size:.8rem;color:var(--text-muted)}
.je{text-align:center;padding:32px 0;color:var(--text-muted);font-size:.9rem}
.notice{padding:12px 16px;background:#fef3c7;border:1px solid #f59e0b;border-radius:10px;font-size:.85rem;color:#92400e;margin-bottom:16px;line-height:1.6}
.badge{font-size:.8rem;color:var(--text-muted)}
@keyframes spin{to{transform:rotate(360deg)}}
.sp{width:18px;height:18px;border:2px solid var(--surface-border);border-top-color:var(--brand);border-radius:50%;animation:spin .6s linear infinite;display:inline-block;vertical-align:middle;margin-right:6px}
@media(max-width:640px){.container{padding:20px 14px}.card{padding:16px}.ir{flex-direction:column}.ir input{min-width:0}}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🎬 B站AI摘要</h1>
    <div style="display:flex;gap:8px;align-items:center">
      <span class="badge" id="countBadge"></span>
      <button class="ht" onclick="toggleTheme()">🌓 主题</button>
    </div>
  </header>

  <div id="noR2Notice" class="notice" style="display:none">
    💡 <strong>存储提示：</strong>由于未配置 R2，任务结果将通过 <strong>邮件发送</strong>。
    历史记录保存在浏览器本地，关闭后不会丢失（下次打开仍在）。
  </div>

  <!-- Submit -->
  <div class="card">
    <div class="ct">新建转录</div>
    <div class="ir">
      <input id="urlInput" type="text" placeholder="B站视频链接或 BV 号…" onkeydown="if(event.key==='Enter')submitJob()" />
      <button class="btn btn-p" id="submitBtn" onclick="submitJob()">开始处理</button>
    </div>
    <p class="hint">支持: bilibili.com/video/BVxxx / b23.tv/xxx / 直接输入BV号</p>
    <div id="submitStatus" style="margin-top:12px;display:none"></div>
  </div>

  <!-- History -->
  <div class="card">
    <div class="ct" style="display:flex;justify-content:space-between;align-items:center">
      <span>历史记录</span>
      <div style="display:flex;gap:6px">
        <button class="btn" style="padding:6px 12px;font-size:.8rem;background:transparent;border:1px solid var(--surface-border);color:var(--text-soft);border-radius:8px;cursor:pointer" onclick="renderList()">🔄</button>
        <button class="btn" style="padding:6px 12px;font-size:.8rem;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:8px;cursor:pointer" onclick="clearAll()">🗑 全部清除</button>
      </div>
    </div>
    <div id="jobList"><div class="je">暂无任务</div></div>
  </div>
</div>
<script>
// ═══════════════════════════════════════════════════════
// LocalStorage 持久化 (无需 R2)
// ═══════════════════════════════════════════════════════
const LS_KEY = 'bilibili_summary_jobs';
const API = '';

function loadJobs() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function saveJobs(jobs) {
  localStorage.setItem(LS_KEY, JSON.stringify(jobs));
  renderList(); updateBadge();
}

// ═══════════════════════════════════════════════════════
// Theme
// ═══════════════════════════════════════════════════════
function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
}
(function() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
})();

// ═══════════════════════════════════════════════════════
// Submit
// ═══════════════════════════════════════════════════════
async function submitJob() {
  const input = document.getElementById('urlInput');
  const url = input.value.trim();
  if (!url) { alert('请先输入视频链接'); return; }

  const btn = document.getElementById('submitBtn');
  const status = document.getElementById('submitStatus');
  btn.disabled = true; btn.innerHTML = '<span class="sp"></span> 提交中…';
  status.style.display = 'block'; status.innerHTML = '<span class="sp"></span> 正在提交…';

  try {
    const data = await (await fetch(API + '/api/submit', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({url}),
    })).json();

    if (data.error) throw new Error(data.error);

    // 保存到 LocalStorage
    const jobs = loadJobs();
    jobs.unshift({
      id: data.job_id, bvid: data.bvid, status: 'submitted',
      created_at: new Date().toISOString(),
      title: '', summary: '',
    });
    saveJobs(jobs);

    status.innerHTML = \`<div style="display:flex;align-items:center;gap:8px;font-size:.9rem">
      <span class="js pending">⏳</span> <b>\${data.bvid}</b> — 已提交，结果将通过邮件发送</div>\`;
    input.value = '';
  } catch (err) {
    status.innerHTML = \`<span style="color:var(--danger)">❌ \${err.message}</span>\`;
  } finally {
    btn.disabled = false; btn.textContent = '开始处理';
    setTimeout(() => { status.style.display = 'none'; }, 5000);
  }
}

// ═══════════════════════════════════════════════════════
// Render history from LocalStorage
// ═══════════════════════════════════════════════════════
function renderList() {
  const jobs = loadJobs();
  const el = document.getElementById('jobList');
  updateBadge();

  if (jobs.length === 0) {
    el.innerHTML = '<div class="je">暂无任务，在上面输入链接提交吧 🚀</div>';
    return;
  }

  el.innerHTML = jobs.map(j => {
    const icon = j.status === 'submitted' ? '⏳' :
                 j.status === 'done' ? '✅' : '❌';
    const cls = j.status === 'submitted' ? 'sub' : j.status === 'done' ? 'done' : 'failed';
    const ago = timeAgo(j.created_at);
    return \`<div class="ji">
      <div class="js \${cls}">\${icon}</div>
      <div style="flex:1;min-width:0">
        <div class="jb">\${j.bvid}</div>
        <div class="jt">\${j.title || (j.status === 'submitted' ? '等待处理…' : '')} · \${ago}</div>
      </div>
      <button class="btn btn-d" onclick="deleteJob('\${j.id}')">🗑</button>
    </div>\`;
  }).join('');
}

function deleteJob(id) {
  if (!confirm('确定删除这个任务？')) return;
  // 也尝试通知 Worker 删除 (No-op if no R2)
  fetch(API + '/api/jobs/' + id, { method: 'DELETE' }).catch(() => {});
  const jobs = loadJobs().filter(j => j.id !== id);
  saveJobs(jobs);
}

function clearAll() {
  if (!confirm('确定清除所有历史记录？')) return;
  saveJobs([]);
}

function updateBadge() {
  const jobs = loadJobs();
  const pending = jobs.filter(j => j.status === 'submitted').length;
  document.getElementById('countBadge').textContent =
    \`📋 \${jobs.length} 条\${pending ? ' · ' + pending + ' 处理中' : ''}\`;
}

// ═══════════════════════════════════════════════════════
// Detect R2 status
// ═══════════════════════════════════════════════════════
async function checkR2() {
  try {
    const data = await (await fetch(API + '/api/stats')).json();
    if (data.mode === 'localstorage') {
      document.getElementById('noR2Notice').style.display = 'block';
    } else {
      document.getElementById('noR2Notice').style.display = 'none';
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════════════════
function timeAgo(iso) {
  if (!iso) return '';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff/60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff/3600) + ' 小时前';
  return new Date(iso).toLocaleDateString('zh-CN', {month:'short',day:'numeric'});
}

// Init
renderList();
checkR2();
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
