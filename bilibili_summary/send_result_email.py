#!/usr/bin/env python3
"""发送单条视频处理结果的精美简报邮件通知"""
import os
import sys
import json
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emailer import send_email, build_single_video_email

result_file = sys.argv[1] if len(sys.argv) > 1 else "result.json"

with open(result_file, encoding="utf-8") as f:
    data = json.load(f)

summary = data.get("summary", "")
if not summary:
    print("[邮件] 跳过：无总结")
    sys.exit(0)

bvid = data.get("bvid", "")
title = data.get("title") or bvid
owner = data.get("owner") or ""
pubdate = data.get("pubdate")
pub_time = time.strftime("%Y-%m-%d %H:%M", time.localtime(pubdate)) if pubdate else ""

video_payload = {
    "bvid": bvid,
    "title": title,
    "up_name": owner,
    "pic": (data.get("pic") or "").replace("http://", "https://"),
    "summary": summary,
    "url": data.get("video_url") or f"https://www.bilibili.com/video/{bvid}",
    "pub_time": pub_time,
    "duration": data.get("duration") or "",
    "timings": data.get("timings") or {},
}

html_body = build_single_video_email(video_payload, style=os.environ.get("EMAIL_STYLE", "editorial"))
subject_title = title if len(title) <= 36 else title[:35] + "…"
subject = f"🎬 B站AI简报 · {subject_title}"

ok = send_email(
    subject=subject,
    html_body=html_body,
    smtp_server="smtp.qq.com",
    smtp_port=465,
    smtp_user=os.environ.get("SMTP_USER", ""),
    smtp_pass=os.environ.get("SMTP_PASS", ""),
    to_addr=os.environ.get("SMTP_TO", ""),
)
print("[邮件]", "OK" if ok else "FAIL")
sys.exit(0 if ok else 1)
