# 🎬 Bilibili Monitor - B站UP主视频监控 & AI总结 & 邮件推送

## 📋 概述

自动监控指定B站UP主的新视频 → 提取字幕 → AI总结 → 发送邮件通知。

**💰 全程免费 | 🔄 全自动 | ☁️ 零服务器**

## 💸 费用清单

| 项目 | 方案 | 费用 |
|------|------|------|
| 📡 B站 API | 公开接口 | **0元** |
| 🤖 AI 总结 | **智谱AI** / **Gemini** (免费层) | **0元** ✅ |
| 🕐 定时运行 | GitHub Actions (2000分钟/月免费) | **0元** ✅ |
| 📧 邮件发送 | QQ邮箱 SMTP | **0元** |
| **总计** | **永久免费运行** | **0元** 🏆 |

## 🔄 工作流程

```
B站API → 获取UP主最新视频 → 字幕API → 提取字幕文本
    ↓
智谱AI (国内免费) 或 Gemini (全球免费) → AI总结
    ↓
QQ邮箱 SMTP → 邮件通知
    ↓
state.json → 记录已处理视频
```

---

## 🚀 两种部署方案

### 方案A: GitHub Actions (推荐) —— 云端自动运行

**完全云端，电脑不用开机。**

#### 第1步: 推送代码到 GitHub

```bash
git add .
git commit -m "添加B站视频监控"
git push
```

#### 第2步: 选择AI方案 & 获取免费API Key

**方案A1: 智谱AI GLM-4-Flash 👑 (推荐，国内直连)**

国内直接访问，每月100万免费tokens，**每月刷新**，永不过期。

1. 打开 https://open.bigmodel.cn/ 用手机号注册
2. 进入 **API Keys** → **创建 API Key**
3. 复制 API Key（格式：`xxx.xxx`）

**方案A2: Google Gemini API (永久免费)**

GitHub Actions 服务器在美国，访问 Google 无网络问题。

1. 打开 https://aistudio.google.com/apikey 用 Google 账号登录
2. 点 **Create API Key** → 复制 `AIzaSy...`

#### 第3步: 配置 GitHub Secrets

在仓库 **Settings → Secrets and variables → Actions** 添加:

| Secret 名称 | 说明 | 如果选智谱AI | 如果选Gemini |
|------------|------|-------------|-------------|
| `ZHIPU_API_KEY` | 智谱AI Key | ✅ 必填 | 不填 |
| `GEMINI_API_KEY` | Gemini Key | 不填 | ✅ 必填 |
| `SMTP_USER` | 发件邮箱 | ✅ 必填 | ✅ 必填 |
| `SMTP_PASS` | 邮箱授权码 | ✅ 必填 | ✅ 必填 |
| `SMTP_TO` | 收件邮箱 | ✅ 必填 | ✅ 必填 |

#### 第4步: 修改 config.py

```python
# 改UP主UID
UP_MIDS = [12345678]

# 改AI后端 (默认就是 zhipu，不用动直接能用)
AI_BACKEND = "zhipu"
# 如果用 Gemini，改成 AI_BACKEND = "gemini"
```

> UP主UID获取: UP主主页 URL末尾的数字，如 `space.bilibili.com/546195` → `546195`

#### 第5步: 完成！

手动触发测试: GitHub仓库 → **Actions** → **B站视频监控** → **Run workflow**

以后 **每天 08:00 和 20:00 自动运行**，收到邮件通知。📧

---

### 方案B: 本地 Ollama (离线免费)

不想用任何外部 API？在自己电脑上跑 Ollama：

```bash
# 1. 安装 Ollama
#    下载: https://ollama.com/download/windows

# 2. 拉取模型 (qwen2.5:3b 中文好，资源消耗低)
ollama pull qwen2.5:3b

# 3. 改配置
#    config.py → AI_BACKEND = "ollama"

# 4. 设置 Windows Task Scheduler 定时运行
python bilibili_monitor/monitor.py
```

---

## 📧 邮件效果

精美 HTML 排版，包含:
- 🎬 **标题栏** — UP主 + 视频数量
- 📺 **视频卡片** — 标题、时长、发布时间
- 🤖 **AI 总结** — 核心主题 + 要点提炼 + 总结
- 🔗 **观看链接** — 一键直达B站视频

## ❓ 常见问题

### Q: 智谱AI的免费额度真的每月刷新吗？
A: 是的。GLM-4-Flash 每月赠送 100 万免费 tokens，**每月自动刷新**，不像通义千问那样90天一次性的。每个月用不完也不会浪费，下个月又有新的。

### Q: 100万tokens一个月够用吗？
A: 完全够。每次总结消耗约500-1500 tokens。每天跑2次，每次监控5个视频，一个月才消耗约45万tokens，**不到额度的一半**。

### Q: Gemini 需要翻墙吗？
A: **申请 Key 时需要**（需要 Google 账号）。但跑脚本不需要 —— GitHub Actions runner 在美国，访问 Google API 没任何问题。所以只在你申请 Key 那一刻需要，之后完全不用管。

### Q: 视频没有字幕怎么办？
A: 脚本会自动检测，没有字幕的视频会跳过总结，在邮件中标注"无法生成总结"。

### Q: 可以只监控一个UP主吗？
A: 可以。`UP_MIDS = [12345678]` 只填一个就行。也可以监控多个，用逗号分隔。

## 📁 项目结构

```
bilibili_monitor/
├── config.py          # 🔑 配置文件 (改这里!)
├── bili_api.py        # B站API封装
├── subtitle.py        # 字幕获取
├── summarizer.py      # AI总结 (支持智谱AI/Gemini/通义千问/Ollama)
├── emailer.py         # 邮件发送
├── monitor.py         # 主脚本
├── requirements.txt   # 依赖
└── README.md          # 本文件
```
