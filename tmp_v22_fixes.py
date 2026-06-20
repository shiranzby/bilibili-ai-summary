#!/usr/bin/env python3
"""v2.2 综合修复: 布局+进度+回到顶部+宽度+MD格式"""
import sys

path = 'F:/WorkSpace/Workbuddy/Github项目分析部署/bilibili-video-monitor-push/cloudflare/worker.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

errors = []

# ═══ 1. 布局: sidebar flex column, historyList flex:1 hidden scrollbar ═══
# 根因: 固定 max-height 不自适应，改用 flex 撑满

old_layout_css = '''.app{display:grid;grid-template-columns:380px 1fr;min-height:100vh;max-width:1200px;margin:0 auto}
@media(max-width:800px){.app{grid-template-columns:1fr}}
/* Sidebar */
.sidebar{background:var(--surface);border-right:1px solid var(--border);padding:24px;overflow-y:auto}'''

new_layout_css = '''.app{display:grid;grid-template-columns:400px 1fr;min-height:100vh}
@media(max-width:800px){.app{grid-template-columns:1fr}}
/* Sidebar — flex column fills viewport */
.sidebar{background:var(--surface);border-right:1px solid var(--border);padding:24px 20px;overflow:hidden;display:flex;flex-direction:column}
.sidebar-top{flex-shrink:0}
.sidebar-history{flex:1;display:flex;flex-direction:column;min-height:0;margin-top:16px;padding-top:12px;border-top:1px solid var(--border)}
.sidebar-history .history-inner{flex:1;overflow-y:auto;min-height:0}
.sidebar-history .history-inner::-webkit-scrollbar{display:none}'''

if old_layout_css in content:
    content = content.replace(old_layout_css, new_layout_css, 1)
    print("OK: layout CSS replaced")
else:
    errors.append("layout CSS")

# ═══ 2. mainContent hidden scrollbar ═══
old_main_css = '.main{padding:24px;overflow-y:auto;max-height:100vh}'
new_main_css = '.main{padding:24px;overflow-y:auto;max-height:100vh;scrollbar-width:none;-ms-overflow-style:none}\n.main::-webkit-scrollbar{display:none}'
if old_main_css in content:
    content = content.replace(old_main_css, new_main_css, 1)
    print("OK: main scrollbar hidden")
else:
    errors.append("main CSS")

# ═══ 3. HTML: wrap sidebar content in flex structure ═══
# Find the sidebar open div and wrap the top portion
old_sidebar_div = '''<div class="sidebar">
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
      </div>
    </details>

    <button class="btn btn-primary" id="submitBtn" onclick="submitJob()">
      🚀 开始处理
    </button>
    <div id="submitStatus" style="margin-top:10px;font-size:.82rem"></div>

    <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">'''

new_sidebar_div = '''<div class="sidebar">
  <div class="sidebar-top">
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
      </div>
    </details>

    <button class="btn btn-primary" id="submitBtn" onclick="submitJob()">
      🚀 开始处理
    </button>
    <div id="submitStatus" style="margin-top:10px;font-size:.82rem"></div>
  </div>

  <div class="sidebar-history">'''

if old_sidebar_div in content:
    content = content.replace(old_sidebar_div, new_sidebar_div, 1)
    print("OK: sidebar HTML restructured")
else:
    errors.append("sidebar HTML")

# ═══ 4. Close sidebar-history div and wrap historyList in history-inner ═══
# Find history closing and sidebar closing
old_hist_close = '''      <div id="historyList" style="max-height:490px;overflow-y:auto"></div>
    </div>
  </div>'''

new_hist_close = '''      <div class="history-inner" id="historyList"></div>
    </div>
  </div>
  </div>'''

if old_hist_close in content and old_hist_close.count('</div>') == 2:
    # Unique - should appear exactly once
    content = content.replace(old_hist_close, new_hist_close, 1)
    print("OK: historyList wrapped in history-inner")
else:
    old_hist_close2 = '      <div id="historyList" style="max-height:490px;overflow-y:auto"></div>'
    if old_hist_close2 in content:
        # The whole closing block... Let me try replacing just the historyList div
        pass
    errors.append("history close")

# ═══ 5. 进度 7→6步: 去掉"生成 Markdown" (index 3) ═══
# ghStatusToSteps (backend)
old_steps7 = '''    {name:'任务创建', done:true, active:false, msg:'已提交至处理队列'},
    {name:'下载视频音频', done:false, active:false, msg:''},
    {name:'语音转录', done:false, active:false, msg:''},
    {name:'生成 Markdown', done:false, active:false, msg:''},
    {name:'LLM 整理总结', done:false, active:false, msg:''},
    {name:'后处理及文件导出', done:false, active:false, msg:''},
    {name:'处理完成', done:false, active:false, msg:''},'''
new_steps6 = '''    {name:'任务创建', done:true, active:false, msg:'已提交至处理队列'},
    {name:'下载视频音频', done:false, active:false, msg:''},
    {name:'语音转录', done:false, active:false, msg:''},
    {name:'LLM 整理总结', done:false, active:false, msg:''},
    {name:'后处理及文件导出', done:false, active:false, msg:''},
    {name:'处理完成', done:false, active:false, msg:''},'''
if old_steps7 in content:
    content = content.replace(old_steps7, new_steps6)
    print("OK: ghStatusToSteps 6 steps")
else:
    errors.append("steps ghStatusToSteps")

# Fix ghStatusToSteps: change all i<7→i<6, next<6→next<5, step 6→step 5, etc.
# The time estimates also change: 5 steps instead of 6 intermediates
old_gh_status_logic = '''    const doneCount = elapsed < 20 ? 0 : elapsed < 50 ? 1 : elapsed < 120 ? 2 : elapsed < 130 ? 3 : elapsed < 200 ? 4 : 5;
    for (let i = 1; i <= doneCount && i < 7; i++) {
      steps[i].done = true;
      steps[i].msg = '✅ 完成';
    }
    const next = Math.min(doneCount + 1, 6);
    if (next < 7) {
      steps[next].active = true;
      steps[next].msg = '处理中…';
    }
  } else if (ghStatus === 'completed') {
    if (ghConclusion === 'success') {
      for (let i = 1; i < 6; i++) { steps[i].done = true; steps[i].msg = '✅ 完成'; }
      steps[6].done = true;
      steps[6].msg = '✅ 完成';
    } else {
      steps[0].msg = '❌ 失败';
      steps[6].done = true;
      steps[6].msg = '❌ 失败';'''

new_gh_status_logic = '''    const doneCount = elapsed < 20 ? 0 : elapsed < 50 ? 1 : elapsed < 120 ? 2 : elapsed < 180 ? 3 : 4;
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
      steps[5].msg = '❌ 失败';'''

if old_gh_status_logic in content:
    content = content.replace(old_gh_status_logic, new_gh_status_logic)
    print("OK: ghStatusToSteps logic updated for 6 steps")
else:
    # Try relaxed match
    pass

# Fix submitJob initial steps (frontend)
old_sub_steps7 = '''      steps:[
        {name:'任务创建', done:true, active:false, msg:'已提交至处理队列'},
        {name:'下载视频音频', done:false, active:false, msg:'等待处理…'},
        {name:'语音转录', done:false, active:false, msg:''},
        {name:'生成 Markdown', done:false, active:false, msg:''},
        {name:'LLM 整理总结', done:false, active:false, msg:''},
        {name:'后处理及文件导出', done:false, active:false, msg:''},
        {name:'处理完成', done:false, active:false, msg:''},
      ],'''
new_sub_steps6 = '''      steps:[
        {name:'任务创建', done:true, active:false, msg:'已提交至处理队列'},
        {name:'下载视频音频', done:false, active:false, msg:'等待处理…'},
        {name:'语音转录', done:false, active:false, msg:''},
        {name:'LLM 整理总结', done:false, active:false, msg:''},
        {name:'后处理及文件导出', done:false, active:false, msg:''},
        {name:'处理完成', done:false, active:false, msg:''},
      ],'''
if old_sub_steps7 in content:
    content = content.replace(old_sub_steps7, new_sub_steps6)
    print("OK: submitJob steps 6")
else:
    errors.append("submitJob steps")

# Fix pollJobStatus timing indices: i===1=download(旧stt), i===4=LLM(旧summary), i===6=done(旧total) → i===1=download(stt), i===3=LLM(summary), i===5=done(total)
old_poll_timings = '''    job.steps = job.steps.map((s, i) => {
      let msg = '';
      if (i === 1 && timings.stt) msg = formatTime(timings.stt);
      else if (i === 4 && timings.summary) msg = formatTime(timings.summary);
      else if (i === 6 && timings.total) msg = formatTime(timings.total);
      return {...s, done: true, active: false, msg: msg || '✅ 完成'};
    });'''
new_poll_timings = '''    job.steps = job.steps.map((s, i) => {
      let msg = '';
      if (i === 1 && timings.stt) msg = formatTime(timings.stt);
      else if (i === 3 && timings.summary) msg = formatTime(timings.summary);
      else if (i === 5 && timings.total) msg = formatTime(timings.total);
      return {...s, done: true, active: false, msg: msg || '✅ 完成'};
    });'''
if old_poll_timings in content:
    content = content.replace(old_poll_timings, new_poll_timings)
    print("OK: pollJobStatus timings updated")
else:
    errors.append("poll timings")

# Fix renderDetail: row2 now has 3 steps (indices 3,4,5 → slice(3,6))
old_render_prog = '''  // Progress steps — 2-row layout: row1[0,1,2] row2[3,4,5,6]
  const pe=document.getElementById('progressSteps');
  if(pe){
    const row1=job.steps.slice(0,3);
    const row2=job.steps.slice(3,7);
    const renderRow=arr=>arr.map(s=>{
      const cls=s.done?'done':s.active?'active':'pending';
      const msg=s.msg?'<div class="step-msg">'+escHtml(s.msg)+'</div>':'';
      return '<div class="progress-step '+cls+'"><span class="step-label">'+s.name+'</span>'+msg+'</div>';
    }).join('');
    pe.innerHTML='<div class="progress-row r1">'+renderRow(row1)+'</div><div class="progress-row r2">'+renderRow(row2)+'</div>';
  }'''
new_render_prog = '''  // Progress steps — 2-row layout: row1[0,1,2] row2[3,4,5]
  const pe=document.getElementById('progressSteps');
  if(pe){
    const row1=job.steps.slice(0,3);
    const row2=job.steps.slice(3,6);
    const renderRow=arr=>arr.map(s=>{
      const cls=s.done?'done':s.active?'active':'pending';
      const msg=s.msg?'<div class="step-msg">'+escHtml(s.msg)+'</div>':'';
      return '<div class="progress-step '+cls+'"><span class="step-label">'+s.name+'</span>'+msg+'</div>';
    }).join('');
    pe.innerHTML='<div class="progress-row r1">'+renderRow(row1)+'</div><div class="progress-row r2">'+renderRow(row2)+'</div>';
  }'''
if old_render_prog in content:
    content = content.replace(old_render_prog, new_render_prog)
    print("OK: renderDetail progress updated")
else:
    errors.append("renderDetail progress")

# Fix progress CSS: r2 now 3 columns
old_prog_css = '''.progress-row.r2{grid-template-columns:1fr 1fr 1fr 1fr}'''
new_prog_css = '''.progress-row.r2{grid-template-columns:1fr 1fr 1fr}'''
if old_prog_css in content:
    content = content.replace(old_prog_css, new_prog_css)
    print("OK: progress-row.r2 3 cols")
else:
    errors.append("progress r2 CSS")

# ═══ 6. 回到顶部按钮 CSS ═══
# Add before </style>
old_style_end = '</style>'
new_top_btn_css = '''.back-to-top{position:fixed;bottom:24px;right:28px;width:40px;height:40px;border-radius:50%;background:var(--brand);color:#fff;border:none;font-size:1.2rem;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15);transition:all .2s;z-index:50;display:none;align-items:center;justify-content:center}
.back-to-top:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(0,0,0,.2)}
.back-to-top.visible{display:flex}
</style>'''

if old_style_end == content.split(old_style_end)[-2][-len(old_style_end):]:
    # Last </style> before </head>
    pass
# Find the style closing right before </head>
old_style_close = '''.accordion-body.hidden{display:none}
</style>'''
new_style_close = '''.accordion-body.hidden{display:none}
/* Back to Top */
.back-to-top{position:fixed;bottom:24px;right:28px;width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,var(--brand),var(--accent));color:#fff;border:none;font-size:1.2rem;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15);transition:all .2s;z-index:50;display:none;align-items:center;justify-content:center}
.back-to-top:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(0,0,0,.2)}
.back-to-top.visible{display:flex}
</style>'''
if old_style_close in content:
    content = content.replace(old_style_close, new_style_close)
    print("OK: back-to-top CSS added")
else:
    errors.append("back-to-top CSS")

# ═══ 7. 回到顶部按钮 HTML + JS ═══
# Add button inside mainContent div, before the </div> closing for main
old_main_close = '''    </div>  </div>
</div>'''
new_main_close = '''    </div>
    <button class="back-to-top" id="backToTopBtn" onclick="scrollToTop()" title="回到顶部">↑</button>
  </div>
</div>'''
if old_main_close in content:
    content = content.replace(old_main_close, new_main_close)
    print("OK: back-to-top button added")
else:
    errors.append("back-to-top button")

# Add JS for scroll detection + scrollToTop
old_init = '''// Init
renderList();'''
new_init = '''// ── Back to Top ──
function scrollToTop() {
  document.getElementById('mainContent').scrollTo({top:0,behavior:'smooth'});
}
document.getElementById('mainContent').addEventListener('scroll',function(){
  const btn=document.getElementById('backToTopBtn');
  if(this.scrollTop>200) btn.classList.add('visible');
  else btn.classList.remove('visible');
});

// Init
renderList();'''
if old_init in content:
    content = content.replace(old_init, new_init)
    print("OK: back-to-top JS added")
else:
    errors.append("init section")

# ═══ 8. MD 下载格式修复: downloadSummary → outputs .md markdown ═══
old_summary_dl = '''function downloadSummary() {
  const job=getSelectedJob();
  if(!job||!job.summary) return;
  const blob=new Blob([job.summary],{type:'text/plain;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=\\`\\${job.bvid}_summary.txt\\`;a.click();
}'''

new_summary_dl = '''function downloadSummary() {
  const job=getSelectedJob();
  if(!job||!job.summary) return;
  const NL=String.fromCharCode(10);
  const md='# AI总结'+NL+NL+'**视频**: '+job.bvid+NL+NL+job.summary.split(NL).map(l=>l).join(NL);
  const blob=new Blob([md],{type:'text/markdown;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=job.bvid+'_summary.md';a.click();
}'''

if old_summary_dl in content:
    content = content.replace(old_summary_dl, new_summary_dl)
    print("OK: downloadSummary MD format")
else:
    errors.append("downloadSummary")

# ═══ 9. Remove unused CSS classes (dead code) ═══
# .detail-card is unused, .pill-* may be unused
# Keep for safety, just note.

# ═══ Write back ═══
with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

if errors:
    print("ERRORS:", errors)
    sys.exit(1)
else:
    print("ALL DONE — v2.2 fixes applied")