"""
AI视频总结模块
=============

使用硅基流动 API 完成视频字幕的 AI 总结。
Key 与语音识别共用 SILICONFLOW_API_KEY。
"""

from typing import Optional

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None


def _build_summary_prompt(subtitle_text: str, video_title: str = "", custom_template: str = "") -> tuple:
    if custom_template:
        # 使用自定义模板，{content} 替换为字幕文本
        user_prompt = custom_template.replace("{content}", subtitle_text)
        system_prompt = "你是一个专业的视频内容分析师。请严格按照用户指定的模板处理转录文本。"
        if len(user_prompt) > 15000:
            user_prompt = user_prompt[:15000] + "\n\n[注意: 内容过长已被截断]"
        return system_prompt, user_prompt

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


def _call_siliconflow(
    api_key: str,
    model: str,
    subtitle_text: str,
    video_title: str = "",
    custom_template: str = "",
) -> Optional[str]:
    if not api_key:
        print("    [AI总结] ❌ 未设置 SILICONFLOW_API_KEY")
        return None
    if not subtitle_text or len(subtitle_text.strip()) < 20:
        print("    [AI总结] 字幕内容太少，跳过")
        return None
    if OpenAI is None:
        print("    [AI总结] 请先安装 openai 库: pip install openai")
        return None

    system_prompt, user_prompt = _build_summary_prompt(subtitle_text, video_title, custom_template)
    try:
        client = OpenAI(api_key=api_key, base_url="https://api.siliconflow.cn/v1")
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            temperature=0.3,
            max_tokens=2048,
        )
        summary = response.choices[0].message.content.strip()
        print(f"    [AI总结] ✅ 硅基流动 生成 {len(summary)} 字符")
        return summary
    except Exception as e:
        print(f"    [AI总结] ❌ 硅基流动 调用失败: {e}")
        return None


def summarize_subtitle(
    subtitle_text: str,
    video_title: str = "",
    api_key: str = "",
    model: str = "Qwen/Qwen3-8B",
    custom_template: str = "",
) -> Optional[str]:
    """
    使用硅基流动对视频字幕进行 AI 总结。

    参数:
        subtitle_text: 字幕文本
        video_title: 视频标题 (可选，用于提示)
        api_key: 硅基流动 API Key
        model: 模型名 (默认 Qwen/Qwen3-8B)
        custom_template: 自定义总结模板（含 {content} 占位符）

    返回: 总结文本或 None
    """
    return _call_siliconflow(api_key, model, subtitle_text, video_title, custom_template)
