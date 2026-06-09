"""
AI视频总结模块
=============
支持四种完全免费的 AI 后端:

    zhipu  (推荐👑) — 智谱AI GLM-4-Flash
        国内直连，每月100万免费tokens，每月刷新，永不过期
        Key: https://open.bigmodel.cn/

    gemini — Google Gemini 2.0 Flash
        永久免费，适合 GitHub Actions (runner在海外)
        Key: https://aistudio.google.com/apikey

    dashscope — 通义千问 qwen-turbo
        新人免费额度(90天)，到期后需付费

    ollama — 本地运行，完全免费离线
        不能放 GitHub Actions
"""

import os
import json
import requests
from typing import Optional

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None


def _build_summary_prompt(subtitle_text: str, video_title: str = "") -> tuple:
    """
    构建统一的总结提示词
    返回: (system_prompt, user_prompt)
    """
    title_info = f"（视频标题: {video_title}）" if video_title else ""

    system_prompt = f"""你是一个专业的视频内容分析师。你的任务是根据视频字幕文本，提取视频的核心内容和关键信息。

要求:
1. 用中文输出 (无论字幕是什么语言)
2. 结构清晰，使用 Markdown 格式
3. 包含以下部分:
   - 📌 **核心主题**: 一句话概括视频讲什么
   - 📋 **要点提炼**: 用要点列出3-8个关键信息点
   - 💡 **总结**: 一段话总结视频价值

注意:
- 不要评价视频质量 (如「讲的很好」「很有价值」)
- 只基于字幕内容客观提取，不要脑补
- 如果字幕不完整或被截断，在最后注明「字幕可能不完整」"""

    user_prompt = f"请分析以下视频字幕{title_info}:\n\n---\n{subtitle_text}\n---"

    # 字幕太长时截断
    if len(user_prompt) > 15000:
        user_prompt = user_prompt[:15000] + "\n\n[注意: 字幕过长已被截断，仅基于前半部分总结]"

    return system_prompt, user_prompt


def _call_openai_compatible(
    api_key: str,
    base_url: str,
    model: str,
    subtitle_text: str,
    video_title: str = "",
    label: str = "AI",
) -> Optional[str]:
    """
    通用的 OpenAI 兼容 API 调用

    参数:
        api_key: API Key
        base_url: API 地址
        model: 模型名
        subtitle_text: 字幕文本
        video_title: 视频标题
        label: 日志中显示的平台名称
    """
    if not api_key:
        print(f"    [AI总结] ❌ 未设置 {label} API Key")
        return None

    if not subtitle_text or len(subtitle_text.strip()) < 20:
        print(f"    [AI总结] 字幕内容太少，跳过")
        return None

    system_prompt, user_prompt = _build_summary_prompt(subtitle_text, video_title)

    if OpenAI is None:
        print("    [AI总结] 请先安装 openai 库: pip install openai")
        return None

    try:
        client = OpenAI(api_key=api_key, base_url=base_url)

        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.3,
            max_tokens=2048,
        )

        summary = response.choices[0].message.content.strip()
        print(f"    [AI总结] ✅ {label} 生成 {len(summary)} 字符")
        return summary

    except Exception as e:
        print(f"    [AI总结] ❌ {label} API 调用失败: {e}")
        return None


# ════════════════════════════════════════════════════════════════
# 方案A: 智谱AI GLM-4-Flash (推荐👑)
# 国内直连，每月100万免费tokens，每月刷新
# ════════════════════════════════════════════════════════════════

def summarize_with_zhipu(
    subtitle_text: str,
    video_title: str = "",
    api_key: str = "",
) -> Optional[str]:
    """
    使用智谱AI GLM-4-Flash 总结视频字幕

    免费额度: 每月 100万 tokens，每月刷新，永不过期
    获取 Key: https://open.bigmodel.cn/ → API Keys → 创建
    国内直连，无需翻墙，手机号注册即可
    """
    return _call_openai_compatible(
        api_key=api_key,
        base_url="https://open.bigmodel.cn/api/paas/v4/",
        model="glm-4-flash",
        subtitle_text=subtitle_text,
        video_title=video_title,
        label="智谱AI",
    )


# ════════════════════════════════════════════════════════════════
# 方案B: Google Gemini API (永久免费)
# 适合 GitHub Actions (runner在海外，无网络问题)
# ════════════════════════════════════════════════════════════════

def summarize_with_gemini(
    subtitle_text: str,
    video_title: str = "",
    api_key: str = "",
) -> Optional[str]:
    """
    使用 Google Gemini 2.0 Flash API

    免费额度: 每分钟60次请求，每天1500次，永久免费
    获取 Key: https://aistudio.google.com/apikey
    GitHub Actions 上完全可用 (runner在海外)
    """
    return _call_openai_compatible(
        api_key=api_key,
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        model="gemini-2.0-flash",
        subtitle_text=subtitle_text,
        video_title=video_title,
        label="Gemini",
    )


# ════════════════════════════════════════════════════════════════
# 方案C: 通义千问 DashScope (新人免费额度90天)
# ════════════════════════════════════════════════════════════════

def summarize_with_dashscope(
    subtitle_text: str,
    video_title: str = "",
    api_key: str = "",
    model: str = "qwen-turbo",
) -> Optional[str]:
    """
    使用通义千问 DashScope API

    免费额度: 新人 100万 tokens (90天有效)
    到期后: qwen-turbo ~0.3元/百万tokens
    """
    return _call_openai_compatible(
        api_key=api_key,
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model=model,
        subtitle_text=subtitle_text,
        video_title=video_title,
        label="通义千问",
    )


# ════════════════════════════════════════════════════════════════
# 方案D: 本地 Ollama (完全免费，离线可用)
# ════════════════════════════════════════════════════════════════

def summarize_with_ollama(
    subtitle_text: str,
    video_title: str = "",
    base_url: str = "http://127.0.0.1:11434",
    model: str = "qwen2.5:3b",
) -> Optional[str]:
    """
    使用本地 Ollama 服务，完全免费离线
    需先安装: https://ollama.com/ 并 pull 模型
    """
    if not subtitle_text or len(subtitle_text.strip()) < 20:
        print("    [AI总结] 字幕内容太少，跳过")
        return None

    system_prompt, user_prompt = _build_summary_prompt(subtitle_text, video_title)

    try:
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "options": {"temperature": 0.3, "num_predict": 2048},
            "stream": False,
        }

        resp = requests.post(
            f"{base_url.rstrip('/')}/api/chat",
            json=payload,
            timeout=120,
        )
        resp.raise_for_status()
        result = resp.json()
        summary = result.get("message", {}).get("content", "").strip()

        if summary:
            print(f"    [AI总结] ✅ Ollama ({model}) 生成 {len(summary)} 字符")
            return summary
        print("    [AI总结] ⚠ Ollama 返回空结果")
        return None

    except requests.exceptions.ConnectionError:
        print(f"    [AI总结] ❌ 无法连接 Ollama ({base_url})")
        print("    [AI总结] 请确保 Ollama 已安装并运行")
        return None
    except Exception as e:
        print(f"    [AI总结] ❌ Ollama 调用失败: {e}")
        return None


# ════════════════════════════════════════════════════════════════
# 统一入口
# ════════════════════════════════════════════════════════════════

def summarize_subtitle(
    subtitle_text: str,
    video_title: str = "",
    backend: str = "zhipu",
    zhipu_api_key: str = "",
    gemini_api_key: str = "",
    dashscope_api_key: str = "",
    dashscope_model: str = "qwen-turbo",
    ollama_base_url: str = "http://127.0.0.1:11434",
    ollama_model: str = "qwen2.5:3b",
) -> Optional[str]:
    """
    统一入口: 根据 backend 参数选择合适的 AI 后端

    参数:
        backend: "zhipu" | "gemini" | "dashscope" | "ollama"
    """
    if backend == "zhipu":
        return summarize_with_zhipu(subtitle_text, video_title, zhipu_api_key)
    elif backend == "gemini":
        return summarize_with_gemini(subtitle_text, video_title, gemini_api_key)
    elif backend == "dashscope":
        return summarize_with_dashscope(subtitle_text, video_title, dashscope_api_key, dashscope_model)
    elif backend == "ollama":
        return summarize_with_ollama(subtitle_text, video_title, ollama_base_url, ollama_model)
    else:
        print(f"    [AI总结] ❌ 未知后端: {backend}")
        print(f"    [AI总结] 支持: zhipu / gemini / dashscope / ollama")
        return None
