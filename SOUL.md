# AI 工作经验 (SOUL.md)

## 用户硬性要求（绝对遵守，不可省略）

### 每项任务结束时必须输出：
1. **根因分析** — 问题为什么发生，而非表面现象
2. **修改内容** — 具体改了哪些代码/配置
3. **影响范围** — 改动波及的模块和功能
4. **验证结果** — 语法检查、部署、API 测试的结果
5. **已解决的问题** — 本次修复了哪些
6. **待解决的问题** — 已知但本次未处理的
7. **值得优化的部分** — 未来可改进的方向

> 忘记输出 = 任务未完成，需补交报告。

---

## 常见失误记录

### 失误1: 忘记输出最终报告
**触发场景**: 修改完代码 → 部署成功 → 直接结束
**纠正**: 无论任务大小，结束时必须输出完整报告。工具调用完成后 + 最终文字回复 = 完整交付。

### 失误2: 提交了无关文件到仓库
**触发场景**: `git add -A` 后包含了 `.backup_*`, `v*.md`, `tmp_*` 等
**纠正**: 提交前必须运行 `git status` 查看即将推送的文件列表。确保 `.gitignore` 中已排除构建产物和备份。

### 失误3: 没有先创建任务清单就开始改代码
**触发场景**: 用户描述了多个需求，直接开始改代码
**纠正**: 必须先创建 TaskCreate 列出所有子任务 → 标记顺序 → 逐一完成后标记完成。

### 失误4: 只修表面问题不追踪根因
**触发场景**: 报错信息消失就认为修好了
**纠正**: 必须问"根因是什么？" → "为什么这个 bug 会出现？" → 修根因而非修症状。

### 失误5: 验证顺序错误（先改 README 再测试）
**触发场景**: README 已更新但代码还没部署/测试
**纠正**: 始终：代码修改 → 语法检查 → 部署 → API 测试 → 触发完整流程 → 验证通过 → 更新 README → git push

### 失误6: 删除功能后未清理死代码
**触发场景**: 删除了按钮但保留了对应的 JS 函数
**纠正**: 删除任何功能后，grep 检查对应函数是否还有调用者，无引用则删除。

---

## 技术模式记忆

### Cloudflare Worker 部署
```bash
cd cloudflare
CLOUDFLARE_EMAIL="xxx" CLOUDFLARE_API_KEY="xxx" npx wrangler deploy
```
部署后必须：`node --check` 验证源文件 → 提取部署页面 JS 再 check → 测试 API → 触发监控

### 前端 JS 在模板字符串中的转义
- 后端代码（函数体外部）：`/regex\/pattern/i` ✓
- 前端代码（`generateFrontendPage()` 内的 `` ` `` 中）：`/regex\\/pattern/i` ✓（`\` 要写 `\\`）

### DOM 元素 ID 命名
所有可操作元素必须带 `id` 属性，`getElementById()` 查找，不用 `querySelector`

### 布局层级
```
.app(height:100vh, grid 1fr 2fr)
├── .sidebar(flex col, overflow:hidden)
│   ├── .sidebar-top(flex-shrink:0)
│   └── .sidebar-history(flex:1, overflow:hidden)
│       └── .history-inner(flex:1, overflow-y:auto, min-height:0)
├── .divider(cursor:col-resize)
└── .main(overflow-y:auto)
```
