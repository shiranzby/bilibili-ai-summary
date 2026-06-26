#!/usr/bin/env python3
"""
单条视频处理脚本
=================
处理一条 B站视频：下载音频 → 语音识别 → AI总结。
结果以 JSON 格式输出到 stdout。

用法:
    python process_single.py BV1xx
    python process_single.py BV1xx --job-id xxx
"""
import os
import sys
import json
import argparse
import time
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import (
    SILICONFLOW_API_KEY,
    SILICONFLOW_STT_MODEL,
    SILICONFLOW_SUMMARY_MODEL,
)
from audio_transcriber import get_text_from_audio
from bili_api import get_video_info
from summarizer import summarize_subtitle


def clean_transcript(text: str) -> str:
    """清洗转录文本：去掉音乐符号 🎼🎵🎶 等"""
    return re.sub(r"[\U0001F3BC\U0001F3B5\U0001F3B6\U0001F3A4\U0001F3A7]", "", text)


def process(bvid: str, job_id: str = "", summary_template: str = "") -> dict:
    """处理单条视频，返回结果字典"""
    # 获取标题
    print(f"[处理] 获取视频信息: {bvid}", file=sys.stderr)
    t0 = time.time()
    info = get_video_info(bvid)
    title = (info.get("title") if info else None) or bvid
    owner = (info.get("owner", {}).get("name") if info else None) or ""
    pubdate = (info.get("pubdate") if info else None)
    t_title = round(time.time() - t0, 1)
    print(f"[处理] 标题: {title} ({t_title}s)", file=sys.stderr)

    result = {
        "bvid": bvid,
        "job_id": job_id,
        "title": title,
        "owner": owner,
        "pubdate": pubdate,
        "status": "completed",
        "summary": None,
        "transcript": "",
        "error": "",
        "timings": {},
        "video_url": f"https://www.bilibili.com/video/{bvid}",
    }

    # Step 1: 音频 + 语音识别
    print(f"[处理] 开始语音识别...", file=sys.stderr)
    t1 = time.time()
    audio_text = get_text_from_audio(
        bvid,
        siliconflow_api_key=SILICONFLOW_API_KEY,
        siliconflow_stt_model=SILICONFLOW_STT_MODEL,
    )
    t_stt = round(time.time() - t1, 1)
    result["timings"]["stt"] = t_stt

    # 语音识别失败时回退到视频描述（与 monitor.py 逻辑一致）
    subtitle_text = audio_text
    transcript_source = "stt"
    if not subtitle_text:
        desc = (info or {}).get("desc", "").strip()
        if desc and len(desc) > 20:
            print(f"[处理] ✅ 使用视频描述 ({len(desc)} 字符)", file=sys.stderr)
            subtitle_text = f"[视频描述] {desc[:3000]}"
            transcript_source = "desc"
        else:
            print(f"[处理] ⚠ 语音识别失败且无视频描述", file=sys.stderr)
            result["status"] = "failed"
            result["error"] = "语音识别失败，无视频描述可回退"
            result["timings"]["total"] = round(time.time() - t0, 1)
            return result

    # 清洗转录文本（去掉🎼等音乐符号）
    if transcript_source == "stt":
        result["transcript"] = clean_transcript(subtitle_text)
    else:
        result["transcript"] = subtitle_text
    print(f"[处理] 转录完成{'（视频描述）' if transcript_source == 'desc' else ''} ({len(result['transcript'])} 字符, {t_stt}s)", file=sys.stderr)

    # Step 2: AI 总结（带自定义模板）
    template = summary_template or ""
    t2 = time.time()
    if template:
        print(f"[处理] 使用自定义总结模板", file=sys.stderr)
    summary = summarize_subtitle(
        result["transcript"],
        video_title=title,
        api_key=SILICONFLOW_API_KEY,
        model=SILICONFLOW_SUMMARY_MODEL,
        custom_template=template,
    )
    t_summary = round(time.time() - t2, 1)
    result["timings"]["summary"] = t_summary
    result["summary"] = summary or "（AI总结失败，仅完成语音识别）"
    result["timings"]["total"] = round(time.time() - t0, 1)

    print(f"[处理] ✅ 完成 (总计 {result['timings']['total']}s)", file=sys.stderr)
    return result


def main():
    parser = argparse.ArgumentParser(description="处理单条B站视频")
    parser.add_argument("bvid", help="B站视频 BV 号")
    parser.add_argument("--job-id", help="Worker 任务 ID", default="")
    parser.add_argument("--callback-url", help="Worker 回调 URL", default="")
    parser.add_argument("--summary-template", help="自定义总结模板（含 {content} 占位符）", default="")

    args = parser.parse_args()
    # 优先使用 --summary-template 参数，否则回退到环境变量
    summary_template = args.summary_template or os.environ.get("SUMMARY_TEMPLATE", "")
    result = process(args.bvid, job_id=args.job_id, summary_template=summary_template)

    # 输出 JSON 到文件 (供后续步骤使用)
    with open("result.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    # 在 stderr 打印简短确认
    summary = result.get("summary", "")
    if summary:
        print(f"[处理] ✅ AI总结完成 ({summary[:60]}...)", file=sys.stderr)


if __name__ == "__main__":
    main()
