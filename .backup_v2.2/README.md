# 🎬 Bilibili AI Summary - B站视频 AI 摘要 & 邮件推送

📋 **概述**

自动监控指定B站UP主的新视频 → 下载音频 → 语音转录 → AI总结 → 发送邮件通知。
支持 **Web UI 手动提交**（实时轮询进度）和 **定时自动监控** 两种模式。

💰 **全程免费** | 🔄 **全自动** | ☁️ **零服务器** | 🔌 **一键部署**

---

## 💸 费用清单

| 项目 | 方案 | 费用 |
|------|------|------|
| 📡 B站 API | 公开接口 | 免费 |
| 🎙️ 语音识别 | 硅基流动 SenseVoiceSmall | 完全免费 |
| 🤖 AI 总结 | 硅基流动 Qwen/Qwen3-8B | 完全免费 |
| 🕐 定时运行 | GitHub Actions (2000分钟/月) | 免费 |
| 📧 邮件发送 | QQ邮箱 SMTP | 免费 |
| **总计** | **一个 API Key 搞定全部** | **完全免费 🏆** |

---

## 🔄 工作流程

### 手动提交模式（Web UI）

```
浏览器 Web UI → Worker (/api/submit) → dispatch GitHub Actions
                                         ↓
     浏览器轮询 ← Worker 返回 (实时状态) ← GitHub Actions 运行中
                                         ↓
                               CI: 下载.m4s(改名.m4a) → 硅基流动语音识别
                                         ↓
                               AI 总结 → 回调 Worker → 写回 R2
                                         ↓
     浏览器自动刷新 ← 轮询获取结果 ← 已完成！
```

### 定时监控模式

```
GitHub Actions (每天 08:00 / 20:00) → 检查UP主新视频
  → 下载音频 (无需ffmpeg) → SenseVoice 语音转文字
  → AI 总结 (Qwen3-8B) → 发送邮件
```

> **关键优化**: .m4s 本身是 AAC 音频容器，直接改名 .m4a 上传，**无需 ffmpeg 转码**。
> 依赖仅 2 个 pip 包 (requests + openai)，安装只需 12 秒。

---

## 🚀 一键部署 (GitHub Actions)

### 第1步: 获取 API Key

**只需一个 Key：硅基流动 (SiliconFlow)**

一个 Key 同时搞定语音识别和 AI 总结，完全免费，无需额外注册。

1. 打开 https://cloud.siliconflow.cn/ 注册
2. 创建 API Key 并复制

### 第2步: 配置 GitHub Secrets

| Secret 名称 | 说明 | 必填 |
|-------------|------|------|
| `SILICONFLOW_API_KEY` | 硅基流动 Key (语音识别 + AI总结) | ✅ |
| `SMTP_USER` | 发件邮箱 (如 `123456@qq.com`) | ✅ |
| `SMTP_PASS` | QQ邮箱SMTP授权码 (16位字母) | ✅ |
| `SMTP_TO` | 收件邮箱 | ✅ |
| `SILICONFLOW_STT_MODEL` | 语音转文字模型 (默认 FunAudioLLM/SenseVoiceSmall) | 可选 |
| `SILICONFLOW_SUMMARY_MODEL` | AI总结模型 (默认 Qwen/Qwen3-8B) | 可选 |

### 第3步: 部署 Cloudflare Worker

需要 Cloudflare 账号 + R2 Bucket（用于存储任务数据）。

```bash
cd cloudflare
# 配置 wrangler.toml 中的 account_id 和 R2 bucket 名
npx wrangler deploy
```

Worker 环境变量需设置:
- `GH_TOKEN`: GitHub Personal Access Token（用于 dispatch Actions）
- `GH_OWNER`: GitHub 用户名（默认 shiranzby）
- `GH_REPO`: GitHub 仓库名（默认 bilibili-ai-summary）

### 第4步: 修改配置

编辑 `bilibili_summary/config.py`：

```python
UP_MIDS = [12345678, 23456789]  # UP主UID列表
```

UP主UID获取：打开UP主主页，URL末尾的数字。

### 第5步: 完成！

- **手动测试**: 打开 Worker URL → 输入BV号 → 点击「开始处理」
- **自动监控**: GitHub Actions 每天 **08:00** 和 **20:00** 自动运行

---

## 🌐 Web UI 功能

部署 Worker 后访问其 URL 即可打开 Web UI：

- 🚀 输入BV号手动触发处理
- 📊 **实时进度** — 轮询 GitHub Actions 运行状态，显示中间步骤
- 📝 **转录文本** — 手风琴展开查看
- 🤖 **AI 总结** — 内联查看 + 编辑切换
- 📧 **邮件预览** — HTML 邮件样式预览
- 🔍 **历史搜索** — 按标题/BV号搜索历史记录
- 🗑 **清除全部** — 一键清空历史
- 🌓 **深色模式** — 切换深色/浅色主题

---

## 📁 项目结构

```
bilibili_summary/
├── config.py              # 🔑 配置文件
├── bili_api.py            # B站API封装
├── audio_transcriber.py   # 音频下载 (playurl CDN) + 语音识别
├── summarizer.py          # AI总结 (硅基流动)
├── emailer.py             # 邮件发送
├── monitor.py             # 每日监控主流程
├── process_single.py      # 单条视频处理 (Web UI 触发)
├── callback_worker.py     # CI 回调 Worker (写回 R2)
├── send_result_email.py   # 单条结果邮件发送
├── inject_config.py       # Secrets 注入
├── requirements.txt       # 仅 requests + openai
├── state.json             # 已处理视频记录
└── .github/workflows/
    └── summary.yml        # GitHub Actions 工作流

cloudflare/
└── worker.js              # Worker (API + 前端UI内嵌)
```

---

## ❓ 常见问题

**Q: 需要多个 API Key 吗？**
A: 不需要。一个 **硅基流动 API Key** 同时覆盖语音识别和 AI 总结。

**Q: 需要 ffmpeg 吗？**
A: **不需要。** .m4s 本身就是 AAC 音频容器，直接改名 .m4a 上传即可。（历史教训：之前多次尝试 apt-get install ffmpeg 浪费了大量 CI 时间）

**Q: 视频没有字幕怎么办？**
A: 我们的方案不依赖B站字幕。自动下载音频 → 硅基流动语音识别 → 转文字。

**Q: 需要B站Cookie吗？**
A: 不需要。全部通过B站公开API + 音频CDN下载。

**Q: 整个链路跑完要多久？**
A: 约 **3-6 分钟**：下载音频 (~30秒) → 语音识别 (~2-4分钟) → AI 总结 (~30秒) → 回调汇总 (~5秒)
