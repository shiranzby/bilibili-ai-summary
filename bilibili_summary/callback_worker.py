#!/usr/bin/env python3
"""
回调 Worker: 将 process_single 的结果写回 Cloudflare R2

用法:
    python callback_worker.py result.json <job_id> <worker_url>
"""
import os
import sys
import json


def callback(result_file: str, job_id: str, worker_url: str):
    # 读取结果
    with open(result_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    body = json.dumps({
        "job_id": job_id,
        "bvid": data.get("bvid", ""),
        "status": data.get("status", "completed"),
        "summary": data.get("summary", ""),
        "title": data.get("title", ""),
    })

    import urllib.request
    req = urllib.request.Request(
        worker_url.rstrip("/") + "/api/callback",
        data=body.encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        print(f"[回调] OK: {resp.read().decode()[:200]}")
        return True
    except Exception as e:
        print(f"[回调] 失败: {e}")
        return False


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("用法: python callback_worker.py <result.json> <job_id> <worker_url>", file=sys.stderr)
        sys.exit(1)
    callback(sys.argv[1], sys.argv[2], sys.argv[3])
