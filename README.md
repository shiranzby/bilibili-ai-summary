# 🎬 B站UP主视频监控 - AI总结 - 邮件推送

> **一分钱不花**的 B站 UP 主视频监控方案。自动检测新视频 → 获取 AI 字幕 → 智能总结 → 邮件通知。

[![B站视频监控](https://github.com/shiranzby/bilibili-video-monitor/actions/workflows/bilibili_monitor.yml/badge.svg)](https://github.com/shiranzby/bilibili-video-monitor/actions/workflows/bilibili_monitor.yml)

---

## 🌟 功能特性

| 功能 | 说明 |
|------|------|
| 🎯 **视频监控** | 定时检测指定 UP 主的最新投稿，发现新视频自动处理 |
| 📝 **AI字幕获取** | 通过 B站 API + Cookie 获取 AI 生成的自动语音识别字幕 |
| 🤖 **AI智能总结** | 使用智谱AI GLM-4-Flash 对字幕内容进行结构化总结 |
| 📧 **邮件推送** | 通过 QQ邮箱 SMTP 将总结报告推送到你的邮箱 |
| 💰 **完全免费** | 所有服务均使用免费额度，无需任何付费 |

---

## 🏗️ 架构总览

```
┌─────────────────────────────────────────────────────┐
│ GitHub Actions (定时任务 08:00 / 20:00)              │
│                                                     │
│  1. B站 API (移动端UA) → 获取UP主最新视频列表         │
│                                                     │
│  2. B站字幕API + Cookie → 获取视频AI字幕文本          │
│        ↑                                            │
│    (无需下载音频，无需ffmpeg，无需Whisper)              │
│                                                     │
│  3. 智谱AI GLM-4-Flash → 生成结构化总结               │
│        ↑                                            │
│    (每月100万免费tokens，国内直连)                    │
│                                                     │
│  4. QQ邮箱 SMTP → 发送总结邮件到你的邮箱              │
└─────────────────────────────────────────────────────┘
```

---

## 📂 项目结构

```
bilibili-video-monitor/
├── .github/workflows/
│   └── bilibili_monitor.yml    # GitHub Actions 工作流配置
│
├── bilibili_monitor/
│   ├── config.py               # 配置文件 (占位符，Secrets注入)
│   ├── inject_config.py        # 配置注入工具 (环境变量→config.py)
│   ├── monitor.py              # 主流程脚本 (入口)
│   ├── bili_api.py             # B站开放API封装 (视频列表/详情)
│   ├── subtitle.py             # 字幕获取模块 (AI字幕 + 上传字幕)
│   ├── summarizer.py           # AI总结模块 (智谱AI + Gemini备选)
│   ├── emailer.py              # 邮件发送模块 (HTML模板)
│   ├── audio_transcriber.py    # 音频转录模块 (备选方案)
│   └── state.json              # 增量状态文件 (已处理视频记录)
│
└── README.md
```

---

## 🚀 一键部署

### 前提条件

| 项目 | 说明 | 获取方式 |
|------|------|----------|
| GitHub 账号 | 用于 Fork 和 Actions | https://github.com |
| 智谱AI Key | AI总结 (每月100万免费tokens) | https://open.bigmodel.cn/ |
| QQ邮箱 | 发件邮箱 (需开启SMTP) | QQ邮箱 → 设置 → 账户 → 开启SMTP |
| B站Cookie | 获取AI字幕 (需登录) | 浏览器F12 → Application → Cookies |

### 步骤1: Clone 仓库

```bash
git clone https://github.com/shiranzby/bilibili-video-monitor.git
cd bilibili-video-monitor
```

### 步骤2: 配置 GitHub Secrets

在仓库 **Settings → Secrets and variables → Actions → New repository secret** 中添加以下 Secrets：

| Secret 名称 | 必填 | 说明 |
|-------------|------|------|
| `ZHIPU_API_KEY` | ✅ | 智谱AI API Key (格式: `xxx.xxx`) |
| `SMTP_USER` | ✅ | QQ邮箱地址 (如 `123456@qq.com`) |
| `SMTP_PASS` | ✅ | QQ邮箱SMTP授权码 (16位字母) |
| `SMTP_TO` | ✅ | 收件邮箱地址 |
| `BILI_COOKIE` | ✅ | **完整B站Cookie** (推荐，一键粘贴) |
| `HF_TOKEN` | ❌ | HuggingFace Token (音频转录备选，一般不需要) |

> **BILI_COOKIE 兼容旧版**：如果你之前使用的是 `BILI_SESSDATA` / `BILI_BILI_JCT` / `BILI_BUVID3` 三个独立的 Secrets，它们仍然有效。如果同时设置了 `BILI_COOKIE` 和独立的三个字段，独立字段优先。

#### 如何获取 B站 Cookie？

<details>
<summary>点击展开详细步骤（30秒搞定）</summary>

1. 打开 Chrome 浏览器，登录 [bilibili.com](https://www.bilibili.com)
2. 按 `F12` 打开开发者工具
3. 点击顶部 **Application** (或「应用」) 标签
4. 左侧展开 **Cookies** → 选择 `https://www.bilibili.com`
5. **用鼠标点中任意一个 Cookie**，按 `Ctrl+A` 全选，再按 `Ctrl+C` 复制
6. 回到 GitHub，在 **New secret** 页面：
   - **Name**: `BILI_COOKIE`
   - **Secret**: 粘贴复制的完整 Cookie 内容

> **注意**：不要手动修改，直接全选复制一整段即可。代码会自动从完整 Cookie 中提取 `SESSDATA`、`bili_jct`、`buvid3` 三个关键字段。

**Cookie 有效期：** 约 6 个月（登录时勾选「记住我」）。到期后按上述步骤重新获取并更新 Secrets。
</details>

> **你也可以用旧方案**：如果不方便复制完整 Cookie，也可以分别创建 `BILI_SESSDATA`、`BILI_BILI_JCT`、`BILI_BUVID3` 三个 Secrets。代码对两种方式都支持，同时设置时独立字段优先。

### 步骤3: 配置监控目标

打开 `bilibili_monitor/config.py`，修改 `UP_MIDS` 列表来添加要监控的 UP 主：

```python
UP_MIDS = [
    12345678,      # 监控单个UP主
    23456789,      # 添加多个UID即可监控多个UP主
]
```

如何获取 UP 主 UID？
1. 打开 UP 主的主页（例如在B站搜索UP主名称进入）
2. 查看浏览器地址栏中的 URL，格式为 `https://space.bilibili.com/数字`
3. 其中的数字部分就是 UID。例如 `https://space.bilibili.com/12345678` 中的 `12345678`
4. 将此数字填入上方列表即可。要监控多个 UP 主，用逗号分隔添加多个 UID

### 步骤4: 完成

将代码推送至你的 GitHub 仓库，工作流会自动触发。也可手动触发：

1. 打开仓库 **Actions** 页面
2. 点击 **B站视频监控** → **Run workflow** → ✅

---

## ⚙️ 工作原理

### 执行流程

```
定时触发 (每天08:00/20:00 北京时间)
    │
    ├─ 1. 读取 state.json (已处理视频记录)
    │
    ├─ 2. 调用 B站 API → 获取UP主最新视频列表
    │     (使用移动端User-Agent避免风控)
    │
    ├─ 3. 对比状态 → 筛选出新视频
    │
    ├─ 4. 对每个新视频:
    │     ├─ a. 调用 x/player/wbi/v2 + Cookie → 获取AI字幕
    │     │     (B站自动语音识别, 无需下载音频)
    │     │
    │     └─ b. 调用智谱AI API → 生成结构化总结
    │            (核心主题 + 要点提炼 + 总结)
    │
    ├─ 5. 组装HTML邮件 → 通过SMTP发送
    │
    └─ 6. 更新 state.json → 下次不重复处理
```

### 关于 Cookie 的处理

`BILI_COOKIE` 是推荐方式，在 `inject_config.py` 中会自动解析：

```
BILI_COOKIE = "buvid3=xxx; SESSDATA=xxx; bili_jct=xxx"
                           ↓ 自动提取三个关键字段
                    BILI_SESSDATA  → 写入 config.py
                    BILI_BILI_JCT  → 写入 config.py
                    BILI_BUVID3    → 写入 config.py
                           ↓
                    subtitle.py 使用 → 字幕 API 调用
```

如果同时设置了 `BILI_COOKIE` 和独立字段（`BILI_SESSDATA` 等），独立字段的值为准。

### 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| **监控器** | `monitor.py` | 主流程编排，状态管理 |
| **B站API** | `bili_api.py` | 视频列表、详情、UP主信息获取 |
| **字幕** | `subtitle.py` | 通过B站字幕API获取AI字幕文本 |
| **AI总结** | `summarizer.py` | 调用智谱AI/Gemini生成结构化总结 |
| **邮件** | `emailer.py` | 构建HTML模板并发送邮件 |
| **配置注入** | `inject_config.py` | 从环境变量注入 Secrets 到 config.py |

---

## 🔧 工作流详解

### `.github/workflows/bilibili_monitor.yml`

工作流包含 5 个步骤：

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | actions/checkout@v4 | 检出仓库代码 |
| 2 | actions/setup-python@v5 | 安装 Python 3.10，缓存 pip 依赖 |
| 3 | 安装依赖 | `pip install -r requirements.txt` + `apt-get install ffmpeg` |
| 4 | 注入配置 | `python inject_config.py` 从 Secrets 写入 config.py |
| 5 | 运行监控 | `python monitor.py` 执行完整监控流程 |
| 6 | 保存状态 | 将 state.json 的变化提交并推送回仓库 |

### 环境变量对照

工作流中的 env 变量与 GitHub Secrets 的对应关系：

```yaml
# 工作流 (bilibili_monitor.yml)          GitHub Secrets 名称
ZHIPU_API_KEY: ${{ secrets.ZHIPU_API_KEY }}
SMTP_USER: ${{ secrets.SMTP_USER }}
SMTP_PASS: ${{ secrets.SMTP_PASS }}
SMTP_TO: ${{ secrets.SMTP_TO }}
HF_TOKEN: ${{ secrets.HF_TOKEN }}
BILI_COOKIE: ${{ secrets.BILI_COOKIE }}       # 推荐：完整Cookie
BILI_SESSDATA: ${{ secrets.BILI_SESSDATA }}   # 旧版：单独字段
BILI_BILI_JCT: ${{ secrets.BILI_BILI_JCT }}   # 旧版
BILI_BUVID3: ${{ secrets.BILI_BUVID3 }}        # 旧版
```

---

## 💰 免费额度说明

| 服务 | 免费额度 | 备注 |
|------|----------|------|
| **GitHub Actions** | 2000分钟/月 | Linux runner，完全足够每日2次运行 |
| **智谱AI GLM-4-Flash** | 100万 tokens/月 | 每月自动刷新，国内直连 |
| **B站 API** | 无限制（有频率限制） | 每天2次完全不会触发限制 |
| **QQ邮箱 SMTP** | 免费 | 每天可发送大量邮件 |

---

## 🐛 常见问题

### Q: 没有收到邮件？
A: 检查是否：
1. GitHub Secrets 中的 SMTP 配置正确
2. UP 主在最近 24 小时内发布了新视频
3. 邮件可能被放入垃圾箱

### Q: B站 Cookie 过期了怎么办？
A: 重新登录 B站，按上述步骤复制新的完整 Cookie，更新 `BILI_COOKIE` Secret 即可。

### Q: 能监控多个 UP 主吗？
A: 可以！修改 `config.py` 中的 `UP_MIDS` 列表，添加多个 UID。

### Q: 能调整检查频率吗？
A: 修改 `.github/workflows/bilibili_monitor.yml` 中的 `cron` 表达式。
当前：`0 0,12 * * *` (UTC) = 北京时间 08:00, 20:00

### Q: 遇到 B站 API 风控怎么办？
A: 移动端 User-Agent + Cookie 已能有效规避风控。如果仍有问题，请检查 Cookie 是否过期。

### Q: 完整 Cookie 和三个独立字段有冲突吗？
A: 没有。代码优先使用独立字段的值（`BILI_SESSDATA`、`BILI_BILI_JCT`、`BILI_BUVID3`），如果它们为空则从 `BILI_COOKIE` 自动解析。两种方式可以同时配置，互不干扰。

---

## 📜 技术栈

| 技术 | 用途 |
|------|------|
| Python 3.10+ | 核心开发语言 |
| GitHub Actions | CI/CD 定时运行 |
| 智谱AI GLM-4-Flash | AI 文本总结 |
| Bilibili Open API | 视频/字幕数据获取 |
| QQ邮箱 SMTP | 邮件推送 |
| Hugging Face Inference API | 音频转录 (备选) |

---

## 📄 License

MIT License

---

> **提示：** 如果你觉得这个项目有用，请给个 ⭐ Star 支持！
