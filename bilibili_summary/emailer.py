"""
邮件发送与日报排版模块
=====================

支持 QQ邮箱 / 163邮箱 / Gmail 的 SMTP 发送。
提供日报合并排版 (多 UP 主单封汇总) 与单条视频精美简报，内置 Markdown → 邮件安全 HTML 渲染。
"""

import html as html_lib
import re
import smtplib
import time
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.header import Header
from typing import List, Dict, Optional


def send_email(
    subject: str,
    html_body: str,
    smtp_server: str,
    smtp_port: int,
    smtp_user: str,
    smtp_pass: str,
    to_addr: str,
) -> bool:
    """发送 HTML 格式邮件"""
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = Header(subject, "utf-8")
        msg["From"] = smtp_user
        msg["To"] = to_addr

        html_part = MIMEText(html_body, "html", "utf-8")
        msg.attach(html_part)

        if smtp_port == 465:
            with smtplib.SMTP_SSL(smtp_server, smtp_port, timeout=30) as server:
                server.login(smtp_user, smtp_pass)
                server.sendmail(smtp_user, [to_addr], msg.as_string())
        else:
            with smtplib.SMTP(smtp_server, smtp_port, timeout=30) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.sendmail(smtp_user, [to_addr], msg.as_string())

        print(f"  [邮件] ✓ 发送成功 → {to_addr}")
        return True

    except smtplib.SMTPAuthenticationError:
        print("  [邮件] ✗ 认证失败! 请检查邮箱/授权码是否正确")
        return False
    except smtplib.SMTPException as e:
        print(f"  [邮件] ✗ SMTP错误: {e}")
        return False
    except Exception as e:
        print(f"  [邮件] ✗ 发送失败: {e}")
        return False


# ==================== Markdown → 邮件安全 HTML ====================

def _inline_md_to_html(text: str) -> str:
    """转换行内 Markdown (**粗体**, *斜体*, `代码`, [链接](url)) 为安全 HTML"""
    s = html_lib.escape(text)
    # 粗体 **text**
    s = re.sub(
        r"\*\*(.+?)\*\*",
        r'<strong style="color:#111827;font-weight:600;">\1</strong>',
        s,
    )
    # 行内代码 `code`
    s = re.sub(
        r"`([^`]+)`",
        r'<code style="background:#f3f4f6;color:#be185d;padding:1px 5px;border-radius:4px;font-size:12px;font-family:Consolas,monospace;">\1</code>',
        s,
    )
    # 链接 [label](url)
    s = re.sub(
        r"\[([^\]]+)\]\((https?://[^\s)]+)\)",
        r'<a href="\2" style="color:#fb7299;text-decoration:none;border-bottom:1px solid #fbcfe8;" target="_blank">\1</a>',
        s,
    )
    return s


def _strip_section_heading(line: str) -> Optional[str]:
    """识别标准小节标题 (核心主题 / 要点提炼 / 总结)，返回标准 key 或 None"""
    cleaned = re.sub(r"^[#\s\-*•]+", "", line).strip()
    cleaned = re.sub(r"\*\*", "", cleaned).strip()
    cleaned = re.sub(r"[:：]+$", "", cleaned).strip()
    for key, keywords in [
        ("theme", ["核心主题", "核心观点", "一句话总结"]),
        ("points", ["要点提炼", "核心要点", "关键要点", "主要内容"]),
        ("conclusion", ["总结", "结语", "总结洞察", "价值总结"]),
    ]:
        for kw in keywords:
            if kw in cleaned and len(cleaned) <= 18:
                return key
    return None


def render_summary_html(summary: str) -> str:
    """
    将 AI 生成的 Markdown 总结渲染为精美、邮件客户端兼容的 HTML 卡片内容。
    - 彻底消除原始 `**`、`##`、`---` 等 Markdown 裸字符
    - 对「核心主题」「要点提炼」「总结」应用差异化编辑排版
    """
    if not summary or not summary.strip():
        return '<p style="margin:0;color:#9ca3af;font-size:13px;">（暂无摘要内容）</p>'

    # 失败占位文案直接柔化展示
    stripped = summary.strip()
    if stripped.startswith("（") and "无法" in stripped and "\n" not in stripped:
        return (
            f'<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;'
            f'padding:10px 14px;color:#b91c1c;font-size:13px;">{html_lib.escape(stripped)}</div>'
        )

    lines = summary.replace("\r\n", "\n").split("\n")
    sections = []  # list of (kind, title_text, content_lines)
    current_kind = "body"
    current_title = ""
    current_lines: List[str] = []

    def flush():
        if current_lines or current_title:
            sections.append((current_kind, current_title, list(current_lines)))

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if re.match(r"^[-*_]{3,}$", line):
            continue
        # 跳过重复的大标题 (# 视频内容分析...)
        if re.match(r"^#\s+", line) and not line.startswith("##"):
            continue

        sec_key = _strip_section_heading(line)
        if sec_key:
            flush()
            current_kind = sec_key
            current_title = re.sub(r"^[#\s\-*•]+", "", line).replace("**", "").strip().rstrip(":：")
            current_lines = []
            continue

        # 处理同行内嵌小节，如 "- 📌 **核心主题**: xxxxx"
        inline_match = re.match(
            r"^(?:[-*•]\s*)?(?:[📌📋💡🎯✨]\s*)?\*\*(核心主题|要点提炼|总结|核心观点)\*\*\s*[:：]\s*(.+)$",
            line,
        )
        if inline_match:
            flush()
            label, rest = inline_match.group(1), inline_match.group(2).strip()
            current_kind = _strip_section_heading(label) or "body"
            current_title = label
            current_lines = [rest] if rest else []
            continue

        current_lines.append(line)

    flush()

    blocks = []
    for kind, title_text, sec_lines in sections:
        if not sec_lines:
            continue

        if kind == "theme":
            body = "<br>".join(_inline_md_to_html(l) for l in sec_lines)
            blocks.append(
                f'<div style="background:#fff5f7;border-left:3px solid #fb7299;'
                f'border-radius:0 8px 8px 0;padding:12px 15px;margin:0 0 16px 0;">'
                f'<div style="font-size:11px;font-weight:700;letter-spacing:0.6px;color:#e11d48;'
                f'text-transform:uppercase;margin-bottom:5px;">核心主题</div>'
                f'<div style="font-size:14px;line-height:1.7;color:#1f2937;font-weight:500;">{body}</div>'
                f'</div>'
            )
        elif kind == "points":
            items_html = []
            idx_counter = 0
            for l in sec_lines:
                # 兼容 "1. xxx" / "- xxx" / "• xxx"
                m_num = re.match(r"^(\d+)[.、)]\s*(.+)$", l)
                m_bul = re.match(r"^[-*•]\s+(.+)$", l)
                if m_num:
                    idx_counter += 1
                    num_label = m_num.group(1)
                    item_text = _inline_md_to_html(m_num.group(2))
                    items_html.append(
                        f'<tr>'
                        f'<td valign="top" style="width:24px;padding:0 8px 9px 0;">'
                        f'<span style="display:inline-block;min-width:19px;height:19px;line-height:19px;'
                        f'text-align:center;background:#f3f4f6;color:#fb7299;border-radius:50%;'
                        f'font-size:11px;font-weight:700;">{num_label}</span>'
                        f'</td>'
                        f'<td valign="top" style="padding:0 0 9px 0;font-size:13.5px;line-height:1.7;color:#374151;">'
                        f'{item_text}'
                        f'</td>'
                        f'</tr>'
                    )
                elif m_bul:
                    item_text = _inline_md_to_html(m_bul.group(1))
                    items_html.append(
                        f'<tr>'
                        f'<td valign="top" style="width:16px;padding:0 6px 8px 4px;color:#fb7299;font-weight:bold;">·</td>'
                        f'<td valign="top" style="padding:0 0 8px 0;font-size:13.5px;line-height:1.7;color:#374151;">'
                        f'{item_text}'
                        f'</td>'
                        f'</tr>'
                    )
                else:
                    items_html.append(
                        f'<tr><td colspan="2" style="padding:0 0 8px 0;font-size:13.5px;line-height:1.7;color:#374151;">'
                        f'{_inline_md_to_html(l)}</td></tr>'
                    )
            blocks.append(
                f'<div style="margin:0 0 16px 0;">'
                f'<div style="font-size:12px;font-weight:700;letter-spacing:0.5px;color:#6b7280;'
                f'margin-bottom:10px;">要点提炼</div>'
                f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
                f'{"".join(items_html)}'
                f'</table>'
                f'</div>'
            )
        elif kind == "conclusion":
            body_parts = []
            note_parts = []
            for l in sec_lines:
                if "字幕可能不完整" in l or re.match(r"^(?:\*\*)?注[:：]", l):
                    note_parts.append(_inline_md_to_html(l))
                else:
                    body_parts.append(_inline_md_to_html(l))
            body = "<br>".join(body_parts)
            note_html = (
                f'<div style="margin-top:8px;font-size:11.5px;color:#9ca3af;">{" ".join(note_parts)}</div>'
                if note_parts
                else ""
            )
            blocks.append(
                f'<div style="background:#f9fafb;border:1px solid #eef0f3;border-radius:8px;padding:12px 15px;margin:0;">'
                f'<div style="font-size:11px;font-weight:700;letter-spacing:0.6px;color:#4b5563;'
                f'margin-bottom:5px;">总结洞察</div>'
                f'<div style="font-size:13.5px;line-height:1.7;color:#4b5563;">{body}</div>'
                f'{note_html}'
                f'</div>'
            )
        else:
            # 通用 Markdown 块 (自定义模板或自由格式)
            para_html = []
            for l in sec_lines:
                if re.match(r"^#{2,4}\s+", l):
                    h_txt = re.sub(r"^#{2,4}\s+", "", l)
                    para_html.append(
                        f'<div style="font-size:14px;font-weight:700;color:#111827;margin:12px 0 6px 0;">'
                        f'{_inline_md_to_html(h_txt)}</div>'
                    )
                elif re.match(r"^[-*•]\s+", l):
                    item = re.sub(r"^[-*•]\s+", "", l)
                    para_html.append(
                        f'<div style="font-size:13.5px;line-height:1.7;color:#374151;padding-left:12px;margin-bottom:6px;">'
                        f'<span style="color:#fb7299;margin-right:6px;">•</span>{_inline_md_to_html(item)}</div>'
                    )
                else:
                    para_html.append(
                        f'<p style="margin:0 0 8px 0;font-size:13.5px;line-height:1.75;color:#374151;">'
                        f'{_inline_md_to_html(l)}</p>'
                    )
            blocks.append(f'<div style="margin:0 0 12px 0;">{"".join(para_html)}</div>')

    return "".join(blocks)


# ==================== 日报 HTML 模板 ====================

def _render_video_card(index: int, video: Dict) -> str:
    """渲染单支视频的日报文章卡片"""
    title = html_lib.escape(video.get("title") or video.get("bvid", ""))
    bvid = html_lib.escape(video.get("bvid", ""))
    up_name = html_lib.escape(video.get("up_name") or video.get("owner") or "")
    video_url = html_lib.escape(video.get("url") or f"https://www.bilibili.com/video/{bvid}")
    duration = html_lib.escape(str(video.get("duration") or ""))
    pub_time = html_lib.escape(str(video.get("pub_time") or ""))
    summary_html = render_summary_html(video.get("summary") or "")

    meta_parts = []
    if duration:
        meta_parts.append(f"时长 {duration}")
    if pub_time:
        meta_parts.append(pub_time)
    meta_str = " · ".join(meta_parts)

    up_badge = (
        f'<span style="display:inline-block;background:#fff1f5;color:#e11d48;border:1px solid #fecdd3;'
        f'border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:600;margin-right:8px;">'
        f'{up_name}</span>'
        if up_name
        else ""
    )

    idx_str = f"{index:02d}"
    return f"""
    <div id="video-{index}" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:22px 24px;margin-bottom:18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;">
        <tr>
          <td style="vertical-align:middle;">
            <span style="display:inline-block;font-family:Consolas,monospace;font-size:11px;font-weight:700;color:#9ca3af;margin-right:8px;">#{idx_str}</span>
            {up_badge}
            <span style="font-size:12px;color:#9ca3af;">{meta_str}</span>
          </td>
        </tr>
      </table>
      <div style="margin:0 0 16px 0;">
        <a href="{video_url}" target="_blank" style="font-size:17px;font-weight:700;line-height:1.45;color:#111827;text-decoration:none;">
          {title}
        </a>
      </div>
      <div style="border-top:1px solid #f3f4f6;padding-top:16px;">
        {summary_html}
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;padding-top:12px;border-top:1px dashed #e5e7eb;">
        <tr>
          <td style="vertical-align:middle;">
            <a href="{video_url}" target="_blank" style="display:inline-block;background:#111827;color:#ffffff;font-size:12.5px;font-weight:600;text-decoration:none;padding:7px 14px;border-radius:7px;">
              ▶ 前往 B 站观看
            </a>
          </td>
          <td align="right" style="vertical-align:middle;font-family:Consolas,monospace;font-size:11.5px;color:#9ca3af;">
            {bvid}
          </td>
        </tr>
      </table>
    </div>
    """


def build_daily_briefing_email(videos: List[Dict], date_str: str = "") -> str:
    """
    构建合并后的「B站视频 AI 日报」单封汇总邮件。

    videos: [{"title", "bvid", "summary", "url", "pub_time", "duration", "up_name"}, ...]
    """
    if not date_str:
        date_str = time.strftime("%Y年%m月%d日", time.localtime())

    unique_ups = []
    for v in videos:
        up = v.get("up_name") or v.get("owner") or ""
        if up and up not in unique_ups:
            unique_ups.append(up)

    # 本期速览 TOC (视频 >= 1 均展示简洁导读)
    toc_rows = []
    for i, v in enumerate(videos, 1):
        t = html_lib.escape(v.get("title") or v.get("bvid", ""))
        up = html_lib.escape(v.get("up_name") or "")
        dur = html_lib.escape(str(v.get("duration") or ""))
        dur_html = f'<span style="color:#9ca3af;font-size:11.5px;margin-left:6px;">({dur})</span>' if dur else ""
        up_html = f'<span style="color:#e11d48;font-weight:600;margin-right:6px;">[{up}]</span>' if up else ""
        toc_rows.append(
            f'<tr>'
            f'<td valign="top" style="width:26px;padding:4px 6px 4px 0;font-family:Consolas,monospace;font-size:12px;color:#fb7299;font-weight:700;">{i:02d}</td>'
            f'<td valign="top" style="padding:4px 0;font-size:13px;line-height:1.5;color:#374151;">'
            f'<a href="#video-{i}" style="color:#1f2937;text-decoration:none;">{up_html}{t}</a>{dur_html}'
            f'</td>'
            f'</tr>'
        )

    toc_html = f"""
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
      <div style="font-size:11.5px;font-weight:700;letter-spacing:0.8px;color:#6b7280;margin-bottom:8px;">
        本期速览 · TABLE OF CONTENTS
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        {"".join(toc_rows)}
      </table>
    </div>
    """

    cards_html = "".join(_render_video_card(i, v) for i, v in enumerate(videos, 1))
    up_count_text = f"覆盖 {len(unique_ups)} 位 UP 主" if unique_ups else "精选订阅"

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;color:#111827;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;">
          <!-- 报头 Masthead -->
          <tr>
            <td style="background:#111827;border-top:4px solid #fb7299;border-radius:14px 14px 0 0;padding:26px 28px 22px 28px;">
              <div style="font-size:11px;font-weight:600;letter-spacing:1.4px;color:#9ca3af;text-transform:uppercase;margin-bottom:8px;">
                BILIBILI AI DAILY BRIEFING &nbsp;·&nbsp; {html_lib.escape(date_str)}
              </div>
              <div style="font-size:23px;font-weight:800;color:#ffffff;letter-spacing:0.3px;margin-bottom:14px;">
                B站视频 AI 日报
              </div>
              <div>
                <span style="display:inline-block;background:rgba(251,114,153,0.16);color:#fda4af;border:1px solid rgba(251,114,153,0.35);border-radius:999px;padding:3px 11px;font-size:12px;font-weight:600;margin-right:8px;">
                  {up_count_text}
                </span>
                <span style="display:inline-block;background:rgba(255,255,255,0.08);color:#e5e7eb;border:1px solid rgba(255,255,255,0.14);border-radius:999px;padding:3px 11px;font-size:12px;">
                  共 {len(videos)} 支新视频
                </span>
              </div>
            </td>
          </tr>
          <!-- 主内容区 -->
          <tr>
            <td style="background:#f8fafc;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;padding:22px 20px 8px 20px;">
              {toc_html}
              {cards_html}
            </td>
          </tr>
          <!-- 页脚 -->
          <tr>
            <td style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 14px 14px;padding:16px 24px;text-align:center;">
              <div style="font-size:12px;color:#9ca3af;line-height:1.6;">
                本邮件由 <a href="https://bilisum.cc.cd" target="_blank" style="color:#fb7299;text-decoration:none;font-weight:600;">B站AI摘要 (bilisum.cc.cd)</a> 自动生成
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def build_single_video_email(video: Dict) -> str:
    """构建单条视频处理完成的精美简报邮件"""
    date_str = time.strftime("%Y年%m月%d日 %H:%M", time.localtime())
    card_html = _render_video_card(1, video)
    elapsed = ""
    timings = video.get("timings") or {}
    if timings.get("total"):
        elapsed = f" · 耗时 {timings['total']}s"

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;">
          <tr>
            <td style="background:#111827;border-top:4px solid #fb7299;border-radius:14px 14px 0 0;padding:22px 26px;">
              <div style="font-size:11px;font-weight:600;letter-spacing:1.3px;color:#9ca3af;text-transform:uppercase;margin-bottom:6px;">
                BILIBILI AI SUMMARY &nbsp;·&nbsp; {html_lib.escape(date_str)}{html_lib.escape(elapsed)}
              </div>
              <div style="font-size:21px;font-weight:800;color:#ffffff;">
                B站视频 AI 简报
              </div>
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;padding:20px 20px 6px 20px;">
              {card_html}
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 14px 14px;padding:15px 24px;text-align:center;">
              <div style="font-size:12px;color:#9ca3af;">
                由 <a href="https://bilisum.cc.cd" target="_blank" style="color:#fb7299;text-decoration:none;font-weight:600;">B站AI摘要 (bilisum.cc.cd)</a> 生成
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def build_digest_email(up_name: str, videos_data: list) -> str:
    """兼容旧调用签名: 转为新版统一日报排版"""
    videos = []
    for title, bvid, summary, video_url, pub_time, duration in videos_data:
        videos.append({
            "title": title,
            "bvid": bvid,
            "summary": summary,
            "url": video_url or f"https://www.bilibili.com/video/{bvid}",
            "pub_time": pub_time,
            "duration": duration,
            "up_name": up_name,
        })
    return build_daily_briefing_email(videos)
