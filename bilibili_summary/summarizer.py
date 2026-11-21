"""
AI视频总结模块
=============

使用硅基流动 API 完成视频字幕的 AI 总结。
Key 与语音识别共用 SILICONFLOW_API_KEY。
"""

import time
from typing import Optional

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None


def _build_summary_prompt(subtitle_text: str, video_title: str = "", custom_template: str = "") -> tuple:
    if custom_template:
        user_prompt = custom_template.replace("{content}", subtitle_text)
        system_prompt = "你是一个专业的视频内容分析师。请严格按照用户指定的模板处理转录文本。"
        if len(user_prompt) > 15000:
            user_prompt = user_prompt[:15000] + "\n\n[注意: 内容过长已被截断]"
        return system_prompt, user_prompt

    title_info = f"（视频标题: {video_title}）" if video_title else ""

    system_prompt = """你是一个专业的视频内容分析师。你的任务是根据视频字幕文本，提取视频的核心内容和关键信息，用于生成高可读性的日报简报。

要求:
1. 用中文输出 (无论字幕是什么语言)
2. 语言精炼、信息密度高、不啰嗦，严格使用以下 Markdown 结构:

📌 **核心主题**
用 1-2 句话直接点明视频的核心议题与结论。

📋 **要点提炼**
用编号列表列出 4-6 个最关键的信息点，每条采用「**关键词/小标题**：精炼阐述（1-2句话）」的格式。

💡 **总结**
用 2-3 句话凝练视频背后的核心视角或背景脉络。

注意:
- 不要评价视频质量 (如「讲的很好」「很有价值」)
- 只基于字幕内容客观提取，不要脑补
- 如果字幕不完整或被截断，在最后另起一行注明「注：字幕可能不完整」"""

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
    client = OpenAI(api_key=api_key, base_url="https://api.siliconflow.cn/v1")

    # Qwen3 系列默认开启思考模式，关闭 thinking 避免耗尽 max_tokens 且速度更快
    use_no_think = "qwen3" in (model or "").lower()

    for attempt in range(1, 3):
        try:
            kwargs = {
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.3,
                "max_tokens": 2048,
            }
            if use_no_think:
                kwargs["extra_body"] = {"enable_thinking": False}

            response = client.chat.completions.create(**kwargs)
            summary = (response.choices[0].message.content or "").strip()
            if summary:
                print(f"    [AI总结] ✅ 硅基流动 生成 {len(summary)} 字符")
                return summary
            print(f"    [AI总结] ⚠ 返回内容为空 (attempt {attempt})")
        except Exception as e:
            err_str = str(e)
            if use_no_think and "enable_thinking" in err_str:
                use_no_think = False
                continue
            print(f"    [AI总结] ❌ 硅基流动 调用失败 (attempt {attempt}): {e}")
            if attempt < 2:
                time.sleep(2)
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
    """
    return _call_siliconflow(api_key, model, subtitle_text, video_title, custom_template)
