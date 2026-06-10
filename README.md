# bilibili-ai-summary

自动监控 B站 UP 主最新视频，AI 语音识别 + 大模型总结，每日推送摘要邮件到你的邮箱。

**一键部署到 GitHub Actions，完全免费。**

## 工作流程

```
定时触发 (每天 08:00 / 20:00 北京时间)
  │
  ├─ B站 API → 获取 UP 主最新视频
  ├─ playurl → 下载音频 → ffmpeg 转 WAV
  ├─ 硅基流动 SenseVoiceSmall → 语音转文字 (完全免费)
  ├─ AI 大模型 → 生成结构化总结
  └─ QQ邮箱 SMTP → 推送摘要邮件
```

## 部署步骤

### 1. Fork 仓库
```bash
git clone https://github.com/shiranzby/bilibili-ai-summary.git
cd bilibili-ai-summary
```

### 2. 添加 GitHub Secrets

仓库 `Settings → Secrets and variables → Actions → New repository secret`：

| Secret | 必填 | 说明 | 获取地址 |
|--------|------|------|----------|
| `ZHIPU_API_KEY` | ✅ | 智谱AI (默认) | https://open.bigmodel.cn/ |
| `DEEPSEEK_API_KEY` | ❌ | DeepSeek 备选 | https://platform.deepseek.com/ |
| `SMTP_USER` | ✅ | QQ邮箱地址 | QQ邮箱 → 设置 → 账户 |
| `SMTP_PASS` | ✅ | SMTP授权码 | 同上 |
| `SMTP_TO` | ✅ | 收件邮箱 | - |
| `SILICONFLOW_API_KEY` | ✅ | 语音识别 (免费) | https://cloud.siliconflow.cn/ |

> **AI 后端选择**：默认使用智谱AI（`AI_BACKEND = "zhipu"`），可改为 `"deepseek"` 或 `"gemini"`。只需填写对应 Key 即可。

### 3. 配置监控目标

编辑 `bilibili_monitor/config.py`，修改 `UP_MIDS`：

```python
UP_MIDS = [
    12345678,      # UP主 UID
    23456789,      # 可添加多个
]
```

UP 主 UID：打开 UP 主主页，URL 末尾的数字。如 `https://space.bilibili.com/12345678`。

### 4. 完成

推送代码后自动触发。也可在 Actions 页面手动运行。

## 免费额度

| 服务 | 额度 | 说明 |
|------|------|------|
| GitHub Actions | 2000分钟/月 | 每天2次绰绰有余 |
| 智谱AI GLM-4-Flash | 100万 tokens/月 | 国内直连 |
| 硅基流动 SenseVoiceSmall | 完全免费 | 语音识别 |
| QQ邮箱 SMTP | 免费 | 邮件推送 |
