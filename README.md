# 🎬 Bilibili AI Summary - B站UP主视频 AI 摘要 & 邮件推送

📋 **概述**

自动监控指定B站UP主的新视频 → 下载音频 → 语音转录 → AI总结 → 发送邮件通知。

💰 **全程免费** | 🔄 **全自动** | ☁️ **零服务器** | 🔌 **一键部署**

---

## 💸 费用清单

| 项目 | 方案 | 费用 |
|------|------|------|
| 📡 B站 API | 公开接口 | 免费 |
| 🎙️ 语音识别 | 硅基流动 SenseVoiceSmall | 完全免费 |
| 🤖 AI 总结 | 智谱AI / DeepSeek / 硅基流动 / Gemini | 免费额度充足 |
| 🕐 定时运行 | GitHub Actions (2000分钟/月) | 免费 |
| 📧 邮件发送 | QQ邮箱 SMTP | 免费 |
| **总计** | **永久免费运行** | **完全免费 🏆** |

---

## 🔄 工作流程

```
B站 API → 获取UP主最新视频
    ↓
playurl API → 下载音频 → ffmpeg 转 WAV
    ↓
硅基流动 SenseVoiceSmall → 语音转文字 (完全免费)
    ↓
智谱AI / DeepSeek / Gemini → AI 结构化总结
    ↓
QQ邮箱 SMTP → 摘要邮件通知
    ↓
state.json → 记录已处理视频 (下次不再重复)
```

> **注**：无需B站Cookie，无需AI字幕，纯音频转录+AI总结，任何视频都能处理。

---

## 🚀 一键部署 (GitHub Actions)

### 第1步: 推送代码到 GitHub

```bash
git clone https://github.com/shiranzby/bilibili-ai-summary.git
cd bilibili-ai-summary
# 修改配置后推送
git add .
git commit -m "init"
git push
```

### 第2步: 获取免费 API Key

**① 语音识别: 硅基流动 SenseVoiceSmall (必选，完全免费)**

所有视频的音频都通过此服务转为文字，完全免费。

1. 打开 https://cloud.siliconflow.cn/ 注册
2. 创建 API Key 并复制

**② AI 总结 (三选一，选一个填对应 Key 即可)**

**方案A: 智谱AI GLM-4-Flash 👑 (推荐，国内直连)**

每月100万免费tokens，每月刷新，永不过期。

1. 打开 https://open.bigmodel.cn/ 用手机号注册
2. 进入 API Keys → 创建 API Key
3. 复制 API Key（格式：`xxx.xxx`）

**方案B: DeepSeek V4-Flash (可选)**

注册送500万tokens，性价比极高。

1. 打开 https://platform.deepseek.com/ 注册
2. 创建 API Key

**方案C: 硅基流动 (可选)**

如果在①中已注册硅基流动，同一个 Key 也可用于 AI 总结。
需在 `config.py` 中配置 `AI_BACKEND = "siliconflow"` 和 `SILICONFLOW_MODEL` 选择模型。

### 第3步: 配置 GitHub Secrets

在仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret 名称 | 说明 | 必填 |
|-------------|------|------|
| `SILICONFLOW_API_KEY` | 硅基流动 Key (语音识别) | ✅ |
| `ZHIPU_API_KEY` | 智谱AI Key (AI总结) | 选一 |
| `DEEPSEEK_API_KEY` | DeepSeek Key (AI总结) | 或 |
| `SMTP_USER` | 发件邮箱 (如 `123456@qq.com`) | ✅ |
| `SMTP_PASS` | QQ邮箱SMTP授权码 (16位字母) | ✅ |
| `SMTP_TO` | 收件邮箱 | ✅ |

### 第4步: 修改配置

编辑 `bilibili_summary/config.py`：

```python
# 改UP主UID
UP_MIDS = [
    12345678,      # 可填单个
    23456789,      # 也可填多个
]

# 改AI后端 (根据你申请的 Key 选择)
AI_BACKEND = "zhipu"        # 智谱AI (推荐)
# AI_BACKEND = "deepseek"   # DeepSeek
# AI_BACKEND = "siliconflow" # 硅基流动 (与语音识别共用Key)

# 如果用硅基流动做AI总结，还可以选择模型
# SILICONFLOW_MODEL = "deepseek-ai/DeepSeek-V3"
# SILICONFLOW_MODEL = "Qwen/Qwen2.5-72B-Instruct"
```

UP主UID获取：打开UP主主页，URL末尾的数字。如 `space.bilibili.com/12345678` → `12345678`。

### 第5步: 完成！

手动触发测试：GitHub仓库 → **Actions** → **B站AI摘要** → **Run workflow**

以后每天 **08:00** 和 **20:00** 自动运行，邮件通知自动送达。📧

---

## 📧 邮件效果

精美 HTML 排版，包含：

- 🎬 **标题栏** — UP主 + 视频数量
- 📺 **视频卡片** — 标题、时长、发布时间
- 🤖 **AI 总结** — 核心主题 + 要点提炼 + 总结
- 🔗 **观看链接** — 一键直达B站视频

---

## ❓ 常见问题

**Q: 100万tokens一个月够用吗？**
A: 完全够。每次总结消耗约500-1500 tokens。每天跑2次，每次5个视频，一个月才约45万tokens，不到额度的一半。

**Q: 视频没有字幕怎么办？**
A: 我们的方案不依赖B站字幕。**自动下载音频 → 硅基流动语音识别 → 转文字**，任何视频都能处理。

**Q: 需要B站Cookie吗？**
A: 不需要。完全通过B站公开API + 音频CDN下载，无需登录。

**Q: 可以只监控一个UP主吗？**
A: 可以。`UP_MIDS = [12345678]` 只填一个就行。也可以监控多个，用逗号分隔。

---

## 📁 项目结构

```
bilibili_summary/
├── config.py              # 🔑 配置文件 (改UP主、AI后端在这里)
├── bili_api.py            # B站API封装
├── audio_transcriber.py   # 音频下载 + 语音识别 (硅基流动)
├── summarizer.py          # AI总结 (支持智谱AI/DeepSeek/Gemini)
├── emailer.py             # 邮件发送 (HTML模板)
├── monitor.py             # 主流程脚本
├── inject_config.py       # Secrets注入工具
├── requirements.txt       # Python依赖
├── state.json             # 已处理视频记录
└── .github/workflows/
    └── summary.yml        # GitHub Actions 工作流
```
