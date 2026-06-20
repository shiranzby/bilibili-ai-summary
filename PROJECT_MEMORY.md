# 项目长期记忆 (PROJECT_MEMORY.md)

## 项目架构

### 前端
- **单文件 SPA**: 所有前端代码（HTML + CSS + JS 内联）在 `cloudflare/worker.js` 的 `generateFrontendPage()` 模板字符串中
- **零框架**: 纯 Vanilla JS，无 React/Vue 等
- **CSS**: 全局变量 + Flexbox/Grid 布局 + @media 响应式

### 后端
- **Cloudflare Workers**: 单一 `worker.js` 文件，ES modules 格式
- **API 路由**: 在 `export default { fetch() }` 中用 `path ===` 手动路由
- **R2 Bucket**: 用于存储任务数据和跨设备历史记录同步

### 部署
- **Wrangler CLI**: `npx wrangler deploy`
- **GitHub Actions**: `summary.yml` 工作流（手动提交 + 定时监控）
- **环境变量**: `GH_TOKEN`, `GH_OWNER`, `GH_REPO` 用于 dispatch Actions

---

## 已确定的 UI/UX 设计

### 布局规范
- **Sidebar + MainContent 双栏布局**: 桌面端拖拽分隔条可调比例（18%~55%）
- **移动端**: 单列布局，`@media(max-width:900px)` 切 `grid-template-columns:1fr`
- **排版切换**: 垂直 / 水平分列（带可拖拽分隔条）双模式

### 组件规范
- **进度步骤**: flex 布局，每步间 `→` 箭头（颜色随状态变化）
- **手风琴（Accordion）**: 点击 header 展开/折叠，按钮通过 `event.stopPropagation()` 防止触发折叠
- **按钮顺序**: 统一为 `TXT → MD → 复制`（所有内容面板保持一致）

### 主题
- `data-theme="light/dark"` 切换，localStorage 持久化
- CSS 变量 `:root` / `[data-theme="dark"]` 控制所有颜色

---

## 代码规范

### URL 提取（前端）
```js
function extractBvid(raw) {
  // 1. 匹配 BV 号
  // 2. 匹配 av 号
  // 3. 匹配完整 URL
  // 4. 纯 BV 校验
}
```

### 时间显示
- `<1h`: "X 分钟前"
- `<24h`: "X 小时前"
- `≥1天`: "2026/05/29 12:50"

### 数据存储
- **localStorage**: 快速访问（主存储）
- **R2**: 跨设备同步（异步写入，fire-and-forget）
- **限制**: 最多 100 条

---

## 已踩过的坑

### 坑1: 正则表达式在模板字符串中需双重转义
- **场景**: 前端 `extractBvid()` 中的正则 `bilibili\.com\/video\/(...)`
- **根因**: 前端代码在 `generateFrontendPage()` 的 JS 模板字符串 `` ` `` 中，`\` 需写成 `\\`
- **解决**: 后端代码（不在模板字符串中）用单 `\`，前端代码（在模板字符串中）用 `\\`

### 坑2: BVBV 重复前缀
- **场景**: 数据显示为 `BVBV1Fnju6BEvC`
- **根因**: `'BV' + escHtml(j.bvid)`，但 `j.bvid` 本身已是 `BV1Fnju6BEvC`
- **解决**: 直接使用 `escHtml(j.bvid)`，不要拼接已有前缀

### 坑3: 死代码未清理
- **场景**: 删除了预览/PDF/HTML 按钮，但对应的函数 `downloadSummaryHTML()` / `buildEmailHTML()` 仍留在代码中
- **解决**: 删除功能时必须检查并清理所有相关函数和 CSS

### 坑4: 仓库上传了不必要的文件
- **场景**: `.backup_*/`, `v*.md`, `tmp_*` 等被 git add 并 push
- **解决**: 提交前运行 `git status` 检查，`.gitignore` 中排除 `backup_*`, `v*.md`, `tmp_*`

### 坑5: 动画后 PNG 文件体积膨胀
- **场景**: 使用 PIL LANCZOS 重采样后 PNG 从 165KB → 671KB
- **解决**: 用 `width` 属性控制显示尺寸远比修改源文件有效
