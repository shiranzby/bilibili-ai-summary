"""
B站UP主视频监控 - 配置文件
==========================
使用前请修改以下配置项

💡 一分钱不花方案:
   - AI总结: 智谱AI GLM-4-Flash (国内直连，每月100万免费tokens，每月刷新)
   - 定时运行: GitHub Actions (免费，2000分钟/月)
   - 邮件: QQ邮箱 SMTP (免费)

🔐 GitHub Actions 部署:
   所有密钥通过 GitHub Secrets 传入 (不写入此文件)。
   GHA workflow 运行时会自动调用 inject_config.py 注入环境变量。
   本地测试前也请手动运行: python inject_config.py
"""

# ============================================================
# 🔴 必填配置
# ============================================================

# 要监控的UP主UID列表
# 获取: 打开UP主主页 → URL末尾的数字
UP_MIDS = [
    21131684,  # 刺客边风
]

# ============================================================
# 🤖 AI总结配置
# ============================================================

# AI后端选择: "zhipu" (默认) | "gemini"
AI_BACKEND = "zhipu"

# ---- 主要: 智谱AI GLM-4-Flash ----
# 免费: 每月100万 tokens，每月刷新
# Key: https://open.bigmodel.cn/ → API Keys
# 🔐 通过 GHA Secret ZHIPU_API_KEY 注入
ZHIPU_API_KEY = ""

# ---- 备选: Google Gemini ----
# 永久免费，适合GHA海外runner
# 🔐 通过 GHA Secret GEMINI_API_KEY 注入 (可选)
GEMINI_API_KEY = ""

# ============================================================
# 🔑 硅基流动 (SiliconFlow) 语音识别 (免费)
# ============================================================
# 用于将B站视频音频转录为文字
# FunAudioLLM/SenseVoiceSmall 模型，完全免费
# Key: https://cloud.siliconflow.cn/
# 🔐 通过 GHA Secret SILICONFLOW_API_KEY 注入
SILICONFLOW_API_KEY = ""

# ============================================================
# 📧 邮箱配置 (QQ邮箱 SMTP)
# ============================================================
SMTP_SERVER = "smtp.qq.com"
SMTP_PORT = 465

# 🔐 通过 GHA Secrets 注入
SMTP_USER = "2128176778@qq.com"
SMTP_PASS = "svnoegqpprytdgei"
SMTP_TO = "2958779577@qq.com"

# ============================================================
# 🟡 可选配置
# ============================================================

# 检查最近多少秒内的视频 (86400 = 24小时)
CHECK_WINDOW_SECONDS = 86400

# 每次最多处理多少个新视频
MAX_VIDEOS_PER_RUN = 5

# 邮件主题前缀
EMAIL_SUBJECT_PREFIX = "🎬 B站视频监控"

# 状态文件路径
STATE_FILE = "state.json"
