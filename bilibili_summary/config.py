"""
Bilibili AI Summary - 配置文件
================================
使用前请修改以下配置项

💡 完全免费方案:
   - 语音识别: 硅基流动 SenseVoiceSmall (完全免费)
   - AI总结: 智谱AI / DeepSeek / 硅基流动 (免费层)
   - 定时运行: GitHub Actions (免费，2000分钟/月)
   - 邮件: QQ邮箱 SMTP (免费)

🔐 GitHub Actions 部署:
   所有密钥通过 GitHub Secrets 传入 (不写入此文件)。
   GHA workflow 运行时会自动调用 inject_config.py 注入环境变量。
"""

# ============================================================
# 🔴 必填配置
# ============================================================

# 要监控的UP主UID列表
# 获取: 打开UP主主页 → URL末尾的数字
UP_MIDS = [
    21131684,
    448165099,
    346563107,
    72275943,
]

# ============================================================
# 🎙️ 语音识别 (硅基流动 SenseVoiceSmall | 完全免费)
# ============================================================
# 注册: https://cloud.siliconflow.cn/
# 🔐 通过 GHA Secret SILICONFLOW_API_KEY 注入
SILICONFLOW_API_KEY = ""

# ============================================================
# 🤖 AI总结配置 (选一个后端填写即可)
# ============================================================

# AI后端选择: "zhipu" (默认) | "deepseek" | "siliconflow" | "gemini"
AI_BACKEND = "zhipu"

# ---- 智谱AI GLM-4-Flash (国内直连，每月100万免费tokens) ----
# Key: https://open.bigmodel.cn/
# 🔐 通过 GHA Secret ZHIPU_API_KEY 注入
ZHIPU_API_KEY = ""

# ---- DeepSeek V3 (注册送500万tokens) ----
# Key: https://platform.deepseek.com/
# 🔐 通过 GHA Secret DEEPSEEK_API_KEY 注入 (可选)
DEEPSEEK_API_KEY = ""

# ---- 硅基流动 AI总结 (可选，与语音识别共用同一KEY) ----
# 总结模型: 可在 https://cloud.siliconflow.cn/ 查看可用模型
SILICONFLOW_MODEL = "deepseek-ai/DeepSeek-V3"

# ---- Google Gemini (永久免费) ----
# Key: https://aistudio.google.com/apikey
# 🔐 通过 GHA Secret GEMINI_API_KEY 注入 (可选)
GEMINI_API_KEY = ""

# ============================================================
# 📧 邮箱配置 (QQ邮箱 SMTP)
# ============================================================
SMTP_SERVER = "smtp.qq.com"
SMTP_PORT = 465

# 🔐 通过 GHA Secrets 注入
SMTP_USER = ""
SMTP_PASS = ""
SMTP_TO = ""

# ============================================================
# 🟡 可选配置
# ============================================================

# 检查最近多少秒内的视频 (259200 = 3天)
CHECK_WINDOW_SECONDS = 259200

# 每次最多处理多少个新视频
MAX_VIDEOS_PER_RUN = 5

# 邮件主题前缀
EMAIL_SUBJECT_PREFIX = "🎬 B站AI摘要"

# 状态文件路径
STATE_FILE = "state.json"
