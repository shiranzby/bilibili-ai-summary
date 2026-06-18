#!/usr/bin/env python3
"""
单条视频处理脚本
=================
处理一条 B站视频：下载音频 → 语音识别 → AI总结。
结果以 JSON 格式输出到 stdout。

用法:
    python process_single.py BV1xx
    python process_single.py BV1xx --upload-r2
"""
import os
import sys
import json
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import (
    SILICONFLOW_API_KEY,
    SILICONFLOW_STT_MODEL,
    SILICONFLOW_SUMMARY_MODEL,
)
from audio_transcriber import get_text_from_audio
from summarizer import summarize_subtitle


def process(bvid: str, job_id: str = "") -> dict:
    """处理单条视频，返回结果字典"""
    result = {
        "bvid": bvid,
        "job_id": job_id,
        "title": "",
        "status": "completed",
        "summary": None,
        "error": "",
        "video_url": f"https://www.bilibili.com/video/{bvid}",
    }

    # Step 1: 音频 + 语音识别
    print(f"[处理] 开始处理: {bvid}", file=sys.stderr)
    audio_text = get_text_from_audio(
        bvid,
        siliconflow_api_key=SILICONFLOW_API_KEY,
        siliconflow_stt_model=SILICONFLOW_STT_MODEL,
    )

    if not audio_text:
        result["status"] = "failed"
        result["error"] = "语音识别失败"
        return result

    # Step 2: AI 总结
    summary = summarize_subtitle(
        audio_text,
        video_title=bvid,
        api_key=SILICONFLOW_API_KEY,
        model=SILICONFLOW_SUMMARY_MODEL,
    )
    result["summary"] = summary or "（AI总结失败，仅完成语音识别）"

    print(f"[处理] ✅ 完成", file=sys.stderr)
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

    args = parser.parse_args()
    result = process(args.bvid, job_id=args.job_id)

    # 仅在 R2 真正配置时上传 (忽略占位值)
    if args.upload_r2 and args.r2_endpoint and args.r2_key and "placeholder" not in args.r2_key:
        try:
            upload_to_r2(result, args.upload_r2, {
                "endpoint": args.r2_endpoint,
                "access_key_id": args.r2_key,
                "secret_access_key": args.r2_secret,
                "bucket_name": args.r2_bucket,
            })
        except Exception as e:
            print(f"[R2] ⚠ 上传失败 (非致命): {e}", file=sys.stderr)
    elif args.upload_r2:
        print(f"[R2] ⏭ R2 未配置，跳过上传", file=sys.stderr)

    # 输出 JSON 到文件 (供后续步骤使用)
    with open("result.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    # 同时在 stdout 打印摘要
    s = result.get("summary", "")
    if s:
        print(f"[处理] ✅ AI总结完成 ({"s[:60]"}...)", file=sys.stderr)


if __name__ == "__main__":
    main()
