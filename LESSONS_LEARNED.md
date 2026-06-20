# Lessons Learned — 经验教训

## 格式
每条记录：日期 | 问题 | 根因 | 解决 | 经验

---

### 2026-06-13 → v2.0

**问题**: 封面 API 返回数据格式不同，导致封面获取失败
**根因**: NetEase API v1 不返回 `album.picUrl`（仅有 picId），需额外调用 song/detail
**解决**: 新增 `/api/cover/album` 端点 + 封面 CDN 代理
**经验**: 第三方 API 返回格式可能不完整，需要设计 fallback 链路

---

### 2026-06-14 → v2.1

**问题**: SHA-256 去重失效，同一文件被重复上传
**根因**: `file.arrayBuffer()` 被调用了两次（算 hash + 解析标签），第二次调用返回空
**解决**: 缓存 `arrayBuffer()` 结果，只调用一次
**经验**: ArrayBuffer 是"一次性消费"，调用后不能再次读取

---

### 2026-06-19 → v2.3

**问题**: 部署后的 JS 报 `SyntaxError: Invalid regular expression flags`
**根因**: 前端代码在 `generateFrontendPage()` 的模板字符串中，`\/` 中的 `\` 被模板字符串消费掉，输出变为 `/`
**解决**: 前端模板字符串内的正则 `\` 需写成 `\\`
**经验**: 模板字符串 `` ` `` 中的 `\` 需要双重转义

---

### 2026-06-20 → v2.7

**问题**: 历史记录中 BV 号显示为 `BVBV1Fnju6BEvC`
**根因**: 代码写 `'BV' + escHtml(j.bvid)`，但 `j.bvid` 已经是 `BV1Fnju6BEvC`
**解决**: 去掉 `'BV' +` 前缀，直接显示 `j.bvid`
**经验**: 永远先检查数据本身的格式，再决定要不要加前缀/后缀

---

### 2026-06-20 → v2.7

**问题**: 删除 HTML 下载按钮后，`downloadSummaryHTML()` 和 `buildEmailHTML()` 成为死代码
**根因**: 只删了按钮 HTML，没有清理对应的 JS 函数
**解决**: 用 `grep` 检查函数是否还有调用者，无则删除
**经验**: 删除 UI 元件后必须 grep 对应的处理函数，清理孤儿代码

---

### 2026-06-20 → v2.8

**问题**: 移动端 `back-to-top` 按钮不显示
**根因**: 在 `@media(max-width:900px)` 中写了 `.back-to-top{display:none!important}`
**解决**: 移除该行 CSS
**经验**: 不要在 media query 中用 `!important` 隐藏 UI 元件——除非确定永远不需要

---

### 2026-06-20 → v3.0

**问题**: 仓库提交了大量无关文件（.backup_*, v*.md, tmp_*）
**根因**: `git add -A` 不加检查，且没有 `.gitignore`
**解决**: 添加 `.gitignore` 排除规则，提交前 `git status` 检查
**经验**: 每次 `git add` 前先 `git status` 检查变更。`.gitignore` 在项目初始化时就应配置好。

---

### 2026-06-20 → v3.0

**问题**: 流程图 PNG 重采样后文件体积从 165KB → 671KB
**根因**: PIL 的 LANCZOS 重采样后再存为 PNG 会大幅膨胀
**解决**: 用 HTML `width="300"` 控制显示尺寸，比改源文件更有效
**经验**: 图片在 README 中用 `width` 属性控制显示大小，不要用 PIL 盲目重采样保存
