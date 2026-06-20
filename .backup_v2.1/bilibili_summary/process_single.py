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
from summarizer import summarize_subtitle


def get_video_title(bvid: str) -> str:
    """从B站API获取视频标题"""
    import requests
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/web-interface/view",
            params={"bvid": bvid},
            headers={"User-Agent": "Mozilla/5.0", "Referer": "https://m.bilibili.com/"},
            timeout=10,
        )
        data = resp.json()
        if data.get("code") == 0:
            return data.get("data", {}).get("title", bvid)
    except Exception as e:
        print(f"[标题] 获取失败: {e}", file=sys.stderr)
    return bvid


def clean_transcript(text: str) -> str:
    """清洗转录文本：去掉音乐符号 🎼🎵🎶 等"""
    return re.sub(r"[\U0001F3BC\U0001F3B5\U0001F3B6\U0001F3A4\U0001F3A7]", "", text)


def process(bvid: str, job_id: str = "", summary_template: str = "") -> dict:
    """处理单条视频，返回结果字典"""
    # 获取标题
    print(f"[处理] 获取视频信息: {bvid}", file=sys.stderr)
    t0 = time.time()
    title = get_video_title(bvid)
    t_title = round(time.time() - t0, 1)
    print(f"[处理] 标题: {title} ({t_title}s)", file=sys.stderr)

    result = {
        "bvid": bvid,
        "job_id": job_id,
        "title": title,
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

    if not audio_text:
        result["status"] = "failed"
        result["error"] = "语音识别失败"
        result["timings"]["total"] = round(time.time() - t0, 1)
        return result

    # 清洗转录文本（去掉🎼等音乐符号）
    result["transcript"] = clean_transcript(audio_text)
    print(f"[处理] 转录完成 ({len(result['transcript'])} 字符, {t_stt}s)", file=sys.stderr)

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


def upload_to_r2(result: dict, job_id: str, r2_config: dict):
    """上传结果到 Cloudflare R2"""
    import boto3
    from botocore.config import Config

    result["id"] = job_id
    result["updated_at"] = __import__("datetime").datetime.now().isoformat()

    s3 = boto3.client(
        "s3",
        endpoint_url=r2_config["endpoint"],
        aws_access_key_id=r2_config["access_key_id"],
        aws_secret_access_key=r2_config["secret_access_key"],
        config=Config(signature_version="s3v4"),
    )

    bucket = r2_config["bucket_name"]

    # 删除 pending 标记
    try:
        s3.delete_object(Bucket=bucket, Key=f"pending/{job_id}.json")
    except Exception:
        pass

    # 写入结果
    s3.put_object(
        Bucket=bucket,
        Key=f"results/{job_id}.json",
        Body=json.dumps(result, ensure_ascii=False),
        ContentType="application/json",
    )
    print(f"[R2] ✅ 结果已上传: results/{job_id}.json", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="处理单条B站视频")
    parser.add_argument("bvid", help="B站视频 BV 号")
    parser.add_argument("--job-id", help="Worker 任务 ID", default="")
    parser.add_argument("--callback-url", help="Worker 回调 URL", default="")
    parser.add_argument("--upload-r2", help="上传结果到 R2 (job_id)", default="")
    parser.add_argument("--r2-endpoint", help="R2 S3 兼容端点", default="")
    parser.add_argument("--r2-key", help="R2 Access Key ID", default="")
    parser.add_argument("--r2-secret", help="R2 Secret Access Key", default="")
    parser.add_argument("--r2-bucket", help="R2 Bucket 名称", default="")
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
