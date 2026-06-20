#!/usr/bin/env python3
"""发送单条视频处理结果的邮件通知"""
import os, sys, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emailer import send_email

result_file = sys.argv[1] if len(sys.argv) > 1 else "result.json"

with open(result_file, encoding="utf-8") as f:
    data = json.load(f)

s = data.get("summary", "")
if not s:
    print("[邮件] 跳过：无总结")
    sys.exit(0)

bvid = data["bvid"]

html = f"""<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;padding:20px;max-width:600px;margin:0 auto">
<div style="background:linear-gradient(135deg,#14b8a6,#0ea5e9);color:white;padding:24px;border-radius:12px;margin-bottom:20px">
<h2 style="margin:0">🎬 B站视频摘要</h2>
<p style="margin:8px 0 0;opacity:.9">{bvid}</p>
</div>
<div style="border-left:4px solid #14b8a6;padding-left:16px;line-height:1.7">
{s.replace(chr(10), "<br>")}
</div>
<p><a href="https://www.bilibili.com/video/{bvid}" style="color:#14b8a6;font-weight:bold">🔗 观看</a></p>
<p style="color:#94a3b8;font-size:12px;margin-top:16px">Bilibili AI Summary</p>
</body>
</html>"""

ok = send_email(
    subject=f"🎬 B站AI摘要 - {bvid}",
    html_body=html,
    smtp_server="smtp.qq.com",
    smtp_port=465,
    smtp_user=os.environ.get("SMTP_USER", ""),
    smtp_pass=os.environ.get("SMTP_PASS", ""),
    to_addr=os.environ.get("SMTP_TO", ""),
)
print("[邮件]", "OK" if ok else "FAIL")
sys.exit(0 if ok else 1)