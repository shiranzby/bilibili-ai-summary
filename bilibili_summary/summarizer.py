"""
AI视频总结模块
=============
支持多种 AI 后端:

    zhipu (默认) — 智谱AI GLM-4-Flash
        国内直连，每月100万免费tokens，每月刷新
        Key: https://open.bigmodel.cn/

    deepseek — DeepSeek V3
        注册送500万tokens
        Key: https://platform.deepseek.com/

    siliconflow — 硅基流动 (语音转录和AI总结两用)
        共用同一 Key，总结模型通过 SILICONFLOW_MODEL 配置
        Key: https://cloud.siliconflow.cn/

    gemini — Google Gemini 2.0 Flash
        永久免费
        Key: https://aistudio.google.com/apikey
"""

import requests
from typing import Optional

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None


def _build_summary_prompt(subtitle_text: str, video_title: str = "") -> tuple:
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
    if not api_key:
        print(f"    [AI总结] ❌ 未设置 {label} API Key")
        return None
    if not subtitle_text or len(subtitle_text.strip()) < 20:
        print("    [AI总结] 字幕内容太少，跳过")
        return None
    if OpenAI is None:
        print("    [AI总结] 请先安装 openai 库: pip install openai")
        return None

    system_prompt, user_prompt = _build_summary_prompt(subtitle_text, video_title)
    try:
        client = OpenAI(api_key=api_key, base_url=base_url)
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            temperature=0.3,
            max_tokens=2048,
        )
        summary = response.choices[0].message.content.strip()
        print(f"    [AI总结] ✅ {label} 生成 {len(summary)} 字符")
        return summary
    except Exception as e:
        print(f"    [AI总结] ❌ {label} 调用失败: {e}")
        return None


# ---- 智谱AI GLM-4-Flash (推荐) ----
def summarize_with_zhipu(subtitle_text: str, video_title: str = "", api_key: str = "") -> Optional[str]:
    return _call_openai_compatible(
        api_key=api_key,
        base_url="https://open.bigmodel.cn/api/paas/v4/",
        model="glm-4-flash",
        subtitle_text=subtitle_text,
        video_title=video_title,
        label="智谱AI",
    )


# ---- DeepSeek V3 ----
def summarize_with_deepseek(subtitle_text: str, video_title: str = "", api_key: str = "") -> Optional[str]:
    return _call_openai_compatible(
        api_key=api_key,
        base_url="https://api.deepseek.com/v1",
        model="deepseek-chat",
        subtitle_text=subtitle_text,
        video_title=video_title,
        label="DeepSeek",
    )


# ---- 硅基流动 (转录和总结两用) ----
def summarize_with_siliconflow(subtitle_text: str, video_title: str = "", api_key: str = "", model: str = "") -> Optional[str]:
    return _call_openai_compatible(
        api_key=api_key,
        base_url="https://api.siliconflow.cn/v1",
        model=model or "deepseek-ai/DeepSeek-V3",
        subtitle_text=subtitle_text,
        video_title=video_title,
        label="硅基流动",
    )


# ---- Google Gemini ----
def summarize_with_gemini(subtitle_text: str, video_title: str = "", api_key: str = "") -> Optional[str]:
    return _call_openai_compatible(
        api_key=api_key,
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        model="gemini-2.0-flash",
        subtitle_text=subtitle_text,
        video_title=video_title,
        label="Gemini",
    )


# ---- 统一入口 ----
def summarize_subtitle(
    subtitle_text: str,
    video_title: str = "",
    backend: str = "zhipu",
    zhipu_api_key: str = "",
    deepseek_api_key: str = "",
    siliconflow_api_key: str = "",
    siliconflow_model: str = "",
    gemini_api_key: str = "",
) -> Optional[str]:
    if backend == "zhipu":
        return summarize_with_zhipu(subtitle_text, video_title, zhipu_api_key)
    elif backend == "deepseek":
        return summarize_with_deepseek(subtitle_text, video_title, deepseek_api_key)
    elif backend == "siliconflow":
        return summarize_with_siliconflow(subtitle_text, video_title, siliconflow_api_key, siliconflow_model)
    elif backend == "gemini":
        return summarize_with_gemini(subtitle_text, video_title, gemini_api_key)
    else:
        print(f"    [AI总结] ❌ 未知后端: {backend}，支持: zhipu / deepseek / siliconflow / gemini")
        return None
