"""
AI视频总结模块
=============

使用硅基流动 100% 免费模型完成视频字幕的 AI 总结。
包含:
  - 长文本智能首尾+中段采样，避免超出免费档 TPM (Tokens Per Minute) 限流
  - 遇 429 TPM 限流时自动切换其他 100% 免费模型 (独立 TPM 额度桶) 并退避重试
  - 记录结构化失败原因，供前端精准展示排查提示
"""

import time
from typing import Optional

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None

# 100% 免费模型兜底池 (各自独立 TPM 额度桶)
FREE_SUMMARY_FALLBACK_MODELS = [
    "Qwen/Qwen3-8B",
    "THUDM/GLM-4-9B-0414",
    "Qwen/Qwen2.5-7B-Instruct",
]

_last_summary_error = {"error": "", "hint": ""}


def get_last_summary_error() -> dict:
    return dict(_last_summary_error)


def _smart_trim_transcript(text: str, max_chars: int = 9000) -> tuple:
    """
    超过 max_chars 时做「开头 + 中段 + 结尾」三段采样，既保留全片脉络又避免触发免费模型 TPM 429 限流。
    返回 (trimmed_text, was_trimmed)
    """
    if len(text) <= max_chars:
        return text, False
    head_len = int(max_chars * 0.40)
    mid_len = int(max_chars * 0.28)
    tail_len = max_chars - head_len - mid_len
    mid_start = max(head_len, (len(text) - mid_len) // 2)
    sampled = (
        text[:head_len]
        + "\n\n[...中段部分内容已省略...]\n\n"
        + text[mid_start:mid_start + mid_len]
        + "\n\n[...后段部分内容已省略...]\n\n"
        + text[-tail_len:]
    )
    return sampled, True


def _build_summary_prompt(
    subtitle_text: str,
    video_title: str = "",
    custom_template: str = "",
    max_chars: int = 9000,
) -> tuple:
    trimmed_text, was_trimmed = _smart_trim_transcript(subtitle_text, max_chars=max_chars)
    trim_note = "\n\n[注意: 原视频较长，已按开篇/中段/结尾采样精简]" if was_trimmed else ""

    if custom_template:
        user_prompt = custom_template.replace("{content}", trimmed_text) + trim_note
        system_prompt = "你是一个专业的视频内容分析师。请严格按照用户指定的模板处理转录文本。"
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

    user_prompt = f"请分析以下视频字幕{title_info}:\n\n---\n{trimmed_text}\n---{trim_note}"
    return system_prompt, user_prompt


def _call_siliconflow(
    api_key: str,
    model: str,
    subtitle_text: str,
    video_title: str = "",
    custom_template: str = "",
) -> Optional[str]:
    _last_summary_error["error"] = ""
    _last_summary_error["hint"] = ""

    if not api_key:
        _last_summary_error["error"] = "未设置 SILICONFLOW_API_KEY"
        _last_summary_error["hint"] = "请在 GitHub Secrets 中配置 SILICONFLOW_API_KEY"
        print("    [AI总结] ❌ 未设置 SILICONFLOW_API_KEY")
        return None
    if not subtitle_text or len(subtitle_text.strip()) < 20:
        _last_summary_error["error"] = "字幕文本过短，无法生成总结"
        _last_summary_error["hint"] = "视频可能几乎没有有效人声，可查看「完整转录」确认"
        print("    [AI总结] 字幕内容太少，跳过")
        return None
    if OpenAI is None:
        _last_summary_error["error"] = "缺少 openai Python 依赖"
        return None

    client = OpenAI(api_key=api_key, base_url="https://api.siliconflow.cn/v1")
    primary = (model or "Qwen/Qwen3-8B").strip()
    models_to_try = [primary] + [m for m in FREE_SUMMARY_FALLBACK_MODELS if m != primary]

    # 长文本首次用 9000 字 (~5.5k tokens)；若触发 TPM 限流则缩减到 6000 字并切免费备选模型
    char_budget = 9000

    for idx, cur_model in enumerate(models_to_try):
        use_no_think = "qwen3" in cur_model.lower()
        max_attempts = 2 if idx == 0 else 1

        for attempt in range(1, max_attempts + 1):
            system_prompt, user_prompt = _build_summary_prompt(
                subtitle_text, video_title, custom_template, max_chars=char_budget
            )
            try:
                kwargs = {
                    "model": cur_model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "temperature": 0.3,
                    "max_tokens": 1800,
                }
                if use_no_think:
                    kwargs["extra_body"] = {"enable_thinking": False}

                response = client.chat.completions.create(**kwargs)
                summary = (response.choices[0].message.content or "").strip()
                if summary:
                    print(f"    [AI总结] ✅ 硅基流动 ({cur_model}) 生成 {len(summary)} 字符")
                    return summary
                print(f"    [AI总结] ⚠ ({cur_model}) 返回内容为空")
            except Exception as e:
                err_str = str(e)
                if use_no_think and "enable_thinking" in err_str:
                    use_no_think = False
                    continue

                print(f"    [AI总结] ❌ ({cur_model}) 调用失败 (attempt {attempt}): {err_str[:220]}")
                if "429" in err_str or "TPM" in err_str or "rate" in err_str.lower():
                    _last_summary_error["error"] = f"硅基流动免费模型触发 TPM 限流 (429): {cur_model}"
                    _last_summary_error["hint"] = "长视频文本量较大或短时间连续提交触发了免费模型每分钟 Token 限额，建议间隔 30 秒后重试"
                    char_budget = 6000
                    time.sleep(5)
                    break  # 立即切换下一个拥有独立 TPM 桶的免费模型
                elif "401" in err_str or "403" in err_str:
                    _last_summary_error["error"] = f"硅基流动 API Key 鉴权失败: {err_str[:120]}"
                    _last_summary_error["hint"] = "请检查 GitHub Secrets 中的 SILICONFLOW_API_KEY 是否有效"
                    return None
                else:
                    _last_summary_error["error"] = f"AI 总结接口异常 ({cur_model}): {err_str[:160]}"
                    _last_summary_error["hint"] = "硅基流动总结接口临时波动，可点击重新处理重试"
                    if attempt < max_attempts:
                        time.sleep(3)

    return None


def summarize_subtitle(
    subtitle_text: str,
    video_title: str = "",
    api_key: str = "",
    model: str = "Qwen/Qwen3-8B",
    custom_template: str = "",
) -> Optional[str]:
    """使用硅基流动免费模型对视频字幕进行 AI 总结。"""
    return _call_siliconflow(api_key, model, subtitle_text, video_title, custom_template)
