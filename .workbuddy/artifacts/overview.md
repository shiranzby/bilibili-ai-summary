# bilibili-ai-summary v2.1 三轮修复报告

**部署**: Version `4f217a28` @ https://bilibili-ai-summary-api.shy2958779577.workers.dev
**Git**: `da9e0f7` → main

---

## 修复 1: updateBadge + 历史列表规则

| # | 问题 | 修复 |
|---|------|------|
| 1 | `updateBadge is not defined` 导致 WebUI 提交后报错 | 函数在历史重设计时被误删，已恢复 |
| 2 | 历史记录无限滚动 | `max-height:490px;overflow-y:auto`（约7条可见） |
| 3 | 标题可点击跳转 | 标题改为纯文本，BV 号移到 meta-tag 内点击跳转 |
| 4 | "删除全部"独立按钮 | 已移除，全选时点"删除"自动变为清除全部 |

## 修复 2: 进度两行 + 格式下载

### 进度步骤 — 两行网格
```
Row 1 (3等分): 任务创建 | 下载视频音频 | 语音转录
Row 2 (4等分): 生成 Markdown | LLM 整理总结 | 后处理及文件导出 | 处理完成
```
每个控件等宽居中，active 态带 pulse 动画。

### 转录文本 — 4种格式
- ⬇ TXT（纯文本）
- 📄 MD（Markdown 引用格式）
- 👁 预览（新窗口 HTML 预览）
- 📋 复制

### AI 总结 — 5种格式
- 📄 MD（Markdown）
- 🌐 HTML（Fancy HTML 邮件模板格式）
- 👁 预览（新窗口预览）
- 🖨 PDF（新窗口调用浏览器打印）
- 📋 复制

### 新增 JS 函数
`downloadTranscriptMD()`, `downloadSummaryHTML()`, `previewTranscript()`, `previewSummary()`, `printSummary()`

---

## 质量验证

| 检查项 | 结果 |
|--------|------|
| `updateBadge` | ✅ FOUND（已恢复） |
| `progress-row r1/r2` | ✅ FOUND |
| `toggleSummaryEdit` | ✅ absent（已删除） |
| 多格式下载函数 | ✅ 5个全部 FOUND |
| 部署后 JS node --check | ✅ EXIT=0 |