"""
邮件发送与多风格日报排版模块
===========================

支持 QQ邮箱 / 163邮箱 / Gmail 的 SMTP 发送。
内置 4 套开源可选日报样式 (editorial / minimal / bilibili / compact)，
支持多 UP 主合并日报与单条视频简报，内置 Markdown → 邮件安全 HTML 渲染。
"""

import html as html_lib
import re
import smtplib
import time
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.header import Header
from typing import List, Dict, Optional

# 4 套邮件主题配色与排版规范
EMAIL_THEMES = {
    "editorial": {
        "name": "编辑部日报",
        "page_bg": "#f3f4f6",
        "body_bg": "#f8fafc",
        "header_bg": "#111827",
        "header_top_border": "4px solid #fb7299",
        "header_title_color": "#ffffff",
        "header_meta_color": "#9ca3af",
        "pill1_bg": "rgba(251,114,153,0.16)",
        "pill1_color": "#fda4af",
        "pill1_border": "rgba(251,114,153,0.35)",
        "pill2_bg": "rgba(255,255,255,0.08)",
        "pill2_color": "#e5e7eb",
        "pill2_border": "rgba(255,255,255,0.14)",
        "accent": "#fb7299",
        "accent_dark": "#e11d48",
        "theme_box_bg": "#fff5f7",
        "theme_box_border": "#fb7299",
        "badge_bg": "#fff1f5",
        "badge_color": "#e11d48",
        "badge_border": "#fecdd3",
        "btn_bg": "#111827",
        "btn_color": "#ffffff",
        "card_pad": "22px 24px",
        "compact": False,
    },
    "minimal": {
        "name": "极简纸刊",
        "page_bg": "#ffffff",
        "body_bg": "#ffffff",
        "header_bg": "#ffffff",
        "header_top_border": "3px solid #111827",
        "header_title_color": "#111827",
        "header_meta_color": "#6b7280",
        "pill1_bg": "#f3f4f6",
        "pill1_color": "#111827",
        "pill1_border": "#e5e7eb",
        "pill2_bg": "#f9fafb",
        "pill2_color": "#4b5563",
        "pill2_border": "#e5e7eb",
        "accent": "#111827",
        "accent_dark": "#111827",
        "theme_box_bg": "#f9fafb",
        "theme_box_border": "#111827",
        "badge_bg": "#f3f4f6",
        "badge_color": "#374151",
        "badge_border": "#e5e7eb",
        "btn_bg": "#111827",
        "btn_color": "#ffffff",
        "card_pad": "20px 22px",
        "compact": False,
    },
    "bilibili": {
        "name": "B站元气粉",
        "page_bg": "#fff7f9",
        "body_bg": "#fffbfc",
        "header_bg": "linear-gradient(135deg,#fb7299 0%,#ff8fab 100%)",
        "header_top_border": "none",
        "header_title_color": "#ffffff",
        "header_meta_color": "rgba(255,255,255,0.88)",
        "pill1_bg": "rgba(255,255,255,0.22)",
        "pill1_color": "#ffffff",
        "pill1_border": "rgba(255,255,255,0.35)",
        "pill2_bg": "rgba(255,255,255,0.16)",
        "pill2_color": "#ffffff",
        "pill2_border": "rgba(255,255,255,0.28)",
        "accent": "#fb7299",
        "accent_dark": "#ec4899",
        "theme_box_bg": "#fff1f5",
        "theme_box_border": "#fb7299",
        "badge_bg": "#ffe4ec",
        "badge_color": "#db2777",
        "badge_border": "#fbcfe8",
        "btn_bg": "#fb7299",
        "btn_color": "#ffffff",
        "card_pad": "22px 24px",
        "compact": False,
    },
    "compact": {
        "name": "极速速览",
        "page_bg": "#f1f5f9",
        "body_bg": "#ffffff",
        "header_bg": "#0f172a",
        "header_top_border": "3px solid #38bdf8",
        "header_title_color": "#f8fafc",
        "header_meta_color": "#94a3b8",
        "pill1_bg": "rgba(56,189,248,0.16)",
        "pill1_color": "#7dd3fc",
        "pill1_border": "rgba(56,189,248,0.3)",
        "pill2_bg": "rgba(255,255,255,0.08)",
        "pill2_color": "#cbd5e1",
        "pill2_border": "rgba(255,255,255,0.14)",
        "accent": "#0284c7",
        "accent_dark": "#0369a1",
        "theme_box_bg": "#f0f9ff",
        "theme_box_border": "#0284c7",
        "badge_bg": "#e0f2fe",
        "badge_color": "#0369a1",
        "badge_border": "#bae6fd",
        "btn_bg": "#0f172a",
        "btn_color": "#ffffff",
        "card_pad": "14px 16px",
        "compact": True,
    },
}


def _get_theme(style: str) -> Dict:
    return EMAIL_THEMES.get((style or "editorial").strip().lower(), EMAIL_THEMES["editorial"])


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

def _inline_md_to_html(text: str, accent: str = "#fb7299") -> str:
    """转换行内 Markdown (**粗体**, `代码`, [链接](url)) 为邮件安全 HTML"""
    s = html_lib.escape(text)
    s = re.sub(
        r"\*\*(.+?)\*\*",
        r'<strong style="color:#111827;font-weight:600;">\1</strong>',
        s,
    )
    s = re.sub(
        r"`([^`]+)`",
        r'<code style="background:#f3f4f6;color:#be185d;padding:1px 5px;border-radius:4px;font-size:12px;font-family:Consolas,monospace;">\1</code>',
        s,
    )
    s = re.sub(
        r"\[([^\]]+)\]\((https?://[^\s)]+)\)",
        rf'<a href="\2" style="color:{accent};text-decoration:none;border-bottom:1px solid #e5e7eb;" target="_blank">\1</a>',
        s,
    )
    return s


def _strip_section_heading(line: str) -> Optional[str]:
    """识别标准小节标题 (核心主题 / 要点提炼 / 总结)"""
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


def render_summary_html(summary: str, theme: Optional[Dict] = None) -> str:
    """将 AI 生成的 Markdown 总结渲染为精美、邮件客户端兼容的 HTML"""
    th = theme or EMAIL_THEMES["editorial"]
    accent = th["accent"]
    is_compact = th["compact"]
    font_size = "13px" if is_compact else "13.5px"
    line_h = "1.55" if is_compact else "1.7"

    if not summary or not summary.strip():
        return '<p style="margin:0;color:#9ca3af;font-size:13px;">（暂无摘要内容）</p>'

    stripped = summary.strip()
    if stripped.startswith("（") and "无法" in stripped and "\n" not in stripped:
        return (
            f'<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;'
            f'padding:10px 14px;color:#b91c1c;font-size:13px;">{html_lib.escape(stripped)}</div>'
        )

    lines = summary.replace("\r\n", "\n").split("\n")
    sections = []
    current_kind = "body"
    current_title = ""
    current_lines: List[str] = []

    def flush():
        if current_lines or current_title:
            sections.append((current_kind, current_title, list(current_lines)))

    for raw_line in lines:
        line = raw_line.strip()
        if not line or re.match(r"^[-*_]{3,}$", line):
            continue
        if re.match(r"^#\s+", line) and not line.startswith("##"):
            continue

        sec_key = _strip_section_heading(line)
        if sec_key:
            flush()
            current_kind = sec_key
            current_title = re.sub(r"^[#\s\-*•]+", "", line).replace("**", "").strip().rstrip(":：")
            current_lines = []
            continue

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
            body = "<br>".join(_inline_md_to_html(l, accent) for l in sec_lines)
            pad = "9px 12px" if is_compact else "12px 15px"
            mb = "11px" if is_compact else "16px"
            blocks.append(
                f'<div style="background:{th["theme_box_bg"]};border-left:3px solid {th["theme_box_border"]};'
                f'border-radius:0 8px 8px 0;padding:{pad};margin:0 0 {mb} 0;">'
                f'<div style="font-size:11px;font-weight:700;letter-spacing:0.6px;color:{th["accent_dark"]};'
                f'text-transform:uppercase;margin-bottom:4px;">核心主题</div>'
                f'<div style="font-size:{font_size};line-height:{line_h};color:#1f2937;font-weight:500;">{body}</div>'
                f'</div>'
            )
        elif kind == "points":
            items_html = []
            pb = "5px" if is_compact else "9px"
            for l in sec_lines:
                m_num = re.match(r"^(\d+)[.、)]\s*(.+)$", l)
                m_bul = re.match(r"^[-*•]\s+(.+)$", l)
                if m_num:
                    num_label = m_num.group(1)
                    item_text = _inline_md_to_html(m_num.group(2), accent)
                    items_html.append(
                        f'<tr>'
                        f'<td valign="top" style="width:24px;padding:0 8px {pb} 0;">'
                        f'<span style="display:inline-block;min-width:18px;height:18px;line-height:18px;'
                        f'text-align:center;background:#f3f4f6;color:{accent};border-radius:50%;'
                        f'font-size:11px;font-weight:700;">{num_label}</span>'
                        f'</td>'
                        f'<td valign="top" style="padding:0 0 {pb} 0;font-size:{font_size};line-height:{line_h};color:#374151;">'
                        f'{item_text}'
                        f'</td>'
                        f'</tr>'
                    )
                elif m_bul:
                    item_text = _inline_md_to_html(m_bul.group(1), accent)
                    items_html.append(
                        f'<tr>'
                        f'<td valign="top" style="width:16px;padding:0 6px {pb} 4px;color:{accent};font-weight:bold;">·</td>'
                        f'<td valign="top" style="padding:0 0 {pb} 0;font-size:{font_size};line-height:{line_h};color:#374151;">'
                        f'{item_text}'
                        f'</td>'
                        f'</tr>'
                    )
                else:
                    items_html.append(
                        f'<tr><td colspan="2" style="padding:0 0 {pb} 0;font-size:{font_size};line-height:{line_h};color:#374151;">'
                        f'{_inline_md_to_html(l, accent)}</td></tr>'
                    )
            mb = "10px" if is_compact else "16px"
            blocks.append(
                f'<div style="margin:0 0 {mb} 0;">'
                f'<div style="font-size:11.5px;font-weight:700;letter-spacing:0.5px;color:#6b7280;'
                f'margin-bottom:8px;">要点提炼</div>'
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
                    note_parts.append(_inline_md_to_html(l, accent))
                else:
                    body_parts.append(_inline_md_to_html(l, accent))
            body = "<br>".join(body_parts)
            note_html = (
                f'<div style="margin-top:6px;font-size:11.5px;color:#9ca3af;">{" ".join(note_parts)}</div>'
                if note_parts
                else ""
            )
            pad = "9px 12px" if is_compact else "12px 15px"
            blocks.append(
                f'<div style="background:#f9fafb;border:1px solid #eef0f3;border-radius:8px;padding:{pad};margin:0;">'
                f'<div style="font-size:11px;font-weight:700;letter-spacing:0.6px;color:#4b5563;'
                f'margin-bottom:4px;">总结洞察</div>'
                f'<div style="font-size:{font_size};line-height:{line_h};color:#4b5563;">{body}</div>'
                f'{note_html}'
                f'</div>'
            )
        else:
            para_html = []
            for l in sec_lines:
                if re.match(r"^#{2,4}\s+", l):
                    h_txt = re.sub(r"^#{2,4}\s+", "", l)
                    para_html.append(
                        f'<div style="font-size:14px;font-weight:700;color:#111827;margin:10px 0 5px 0;">'
                        f'{_inline_md_to_html(h_txt, accent)}</div>'
                    )
                elif re.match(r"^[-*•]\s+", l):
                    item = re.sub(r"^[-*•]\s+", "", l)
                    para_html.append(
                        f'<div style="font-size:{font_size};line-height:{line_h};color:#374151;padding-left:12px;margin-bottom:5px;">'
                        f'<span style="color:{accent};margin-right:6px;">•</span>{_inline_md_to_html(item, accent)}</div>'
                    )
                else:
                    para_html.append(
                        f'<p style="margin:0 0 7px 0;font-size:{font_size};line-height:{line_h};color:#374151;">'
                        f'{_inline_md_to_html(l, accent)}</p>'
                    )
            blocks.append(f'<div style="margin:0 0 10px 0;">{"".join(para_html)}</div>')

    return "".join(blocks)


# ==================== 日报 HTML 模板 ====================

def _render_video_card(index: int, video: Dict, theme: Dict) -> str:
    """渲染单支视频的日报卡片"""
    title = html_lib.escape(video.get("title") or video.get("bvid", ""))
    bvid = html_lib.escape(video.get("bvid", ""))
    up_name = html_lib.escape(video.get("up_name") or video.get("owner") or "")
    video_url = html_lib.escape(video.get("url") or f"https://www.bilibili.com/video/{bvid}")
    duration = html_lib.escape(str(video.get("duration") or ""))
    pub_time = html_lib.escape(str(video.get("pub_time") or ""))
    summary_html = render_summary_html(video.get("summary") or "", theme)
    is_compact = theme["compact"]

    meta_parts = []
    if duration:
        meta_parts.append(f"时长 {duration}")
    if pub_time:
        meta_parts.append(pub_time)
    meta_str = " · ".join(meta_parts)

    up_badge = (
        f'<span style="display:inline-block;background:{theme["badge_bg"]};color:{theme["badge_color"]};'
        f'border:1px solid {theme["badge_border"]};border-radius:999px;padding:2px 9px;'
        f'font-size:11.5px;font-weight:600;margin-right:8px;">{up_name}</span>'
        if up_name
        else ""
    )

    title_size = "15.5px" if is_compact else "17px"
    card_mb = "12px" if is_compact else "18px"
    idx_str = f"{index:02d}"

    return f"""
    <div id="video-{index}" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:{theme['card_pad']};margin-bottom:{card_mb};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;">
        <tr>
          <td style="vertical-align:middle;">
            <span style="display:inline-block;font-family:Consolas,monospace;font-size:11px;font-weight:700;color:#9ca3af;margin-right:8px;">#{idx_str}</span>
            {up_badge}
            <span style="font-size:12px;color:#9ca3af;">{meta_str}</span>
          </td>
        </tr>
      </table>
      <div style="margin:0 0 12px 0;">
        <a href="{video_url}" target="_blank" style="font-size:{title_size};font-weight:700;line-height:1.45;color:#111827;text-decoration:none;">
          {title}
        </a>
      </div>
      <div style="border-top:1px solid #f3f4f6;padding-top:12px;">
        {summary_html}
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;padding-top:10px;border-top:1px dashed #e5e7eb;">
        <tr>
          <td style="vertical-align:middle;">
            <a href="{video_url}" target="_blank" style="display:inline-block;background:{theme['btn_bg']};color:{theme['btn_color']};font-size:12px;font-weight:600;text-decoration:none;padding:6px 13px;border-radius:7px;">
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


def build_daily_briefing_email(videos: List[Dict], date_str: str = "", style: str = "editorial") -> str:
    """
    构建合并后的「B站视频 AI 日报」单封汇总邮件，支持 4 种可选样式。
    """
    th = _get_theme(style)
    if not date_str:
        date_str = time.strftime("%Y年%m月%d日", time.localtime())

    unique_ups = []
    for v in videos:
        up = v.get("up_name") or v.get("owner") or ""
        if up and up not in unique_ups:
            unique_ups.append(up)

    toc_rows = []
    for i, v in enumerate(videos, 1):
        t = html_lib.escape(v.get("title") or v.get("bvid", ""))
        bvid_i = html_lib.escape(v.get("bvid", ""))
        v_url = html_lib.escape(v.get("url") or f"https://www.bilibili.com/video/{bvid_i}")
        up = html_lib.escape(v.get("up_name") or "")
        dur = html_lib.escape(str(v.get("duration") or ""))
        dur_html = f'<span style="color:#9ca3af;font-size:11.5px;margin-left:6px;">({dur})</span>' if dur else ""
        up_html = f'<span style="color:{th["accent_dark"]};font-weight:600;margin-right:6px;">[{up}]</span>' if up else ""
        toc_rows.append(
            f'<tr>'
            f'<td valign="top" style="width:26px;padding:3px 6px 3px 0;font-family:Consolas,monospace;font-size:12px;color:{th["accent"]};font-weight:700;">{i:02d}</td>'
            f'<td valign="top" style="padding:3px 0;font-size:13px;line-height:1.5;color:#374151;">'
            f'<a href="{v_url}" target="_blank" style="color:#1f2937;text-decoration:none;border-bottom:1px solid #e5e7eb;">{up_html}{t}</a>{dur_html}'
            f'</td>'
            f'</tr>'
        )

    toc_html = f"""
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin-bottom:18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.8px;color:#6b7280;margin-bottom:7px;">
        本期速览 · TABLE OF CONTENTS
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        {"".join(toc_rows)}
      </table>
    </div>
    """

    cards_html = "".join(_render_video_card(i, v, th) for i, v in enumerate(videos, 1))
    up_count_text = f"覆盖 {len(unique_ups)} 位 UP 主" if unique_ups else "精选订阅"
    header_border_bottom = "border-bottom:1px solid #e5e7eb;" if style == "minimal" else ""

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:{th['page_bg']};font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;color:#111827;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:{th['page_bg']};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;">
          <tr>
            <td style="background:{th['header_bg']};border-top:{th['header_top_border']};border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;{header_border_bottom}border-radius:14px 14px 0 0;padding:24px 26px 20px 26px;">
              <div style="font-size:11px;font-weight:600;letter-spacing:1.4px;color:{th['header_meta_color']};text-transform:uppercase;margin-bottom:8px;">
                BILIBILI AI DAILY BRIEFING &nbsp;·&nbsp; {html_lib.escape(date_str)}
              </div>
              <div style="font-size:22px;font-weight:800;color:{th['header_title_color']};letter-spacing:0.3px;margin-bottom:12px;">
                B站视频 AI 日报
              </div>
              <div>
                <span style="display:inline-block;background:{th['pill1_bg']};color:{th['pill1_color']};border:1px solid {th['pill1_border']};border-radius:999px;padding:3px 11px;font-size:12px;font-weight:600;margin-right:8px;">
                  {up_count_text}
                </span>
                <span style="display:inline-block;background:{th['pill2_bg']};color:{th['pill2_color']};border:1px solid {th['pill2_border']};border-radius:999px;padding:3px 11px;font-size:12px;">
                  共 {len(videos)} 支新视频
                </span>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background:{th['body_bg']};border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;padding:20px 18px 8px 18px;">
              {toc_html}
              {cards_html}
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 14px 14px;padding:15px 24px;text-align:center;">
              <div style="font-size:12px;color:#9ca3af;line-height:1.6;">
                本邮件由 <a href="https://bilisum.cc.cd" target="_blank" style="color:{th['accent']};text-decoration:none;font-weight:600;">B站AI摘要 (bilisum.cc.cd)</a> 自动生成 · 样式：{th['name']}
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def build_single_video_email(video: Dict, style: str = "editorial") -> str:
    """构建单条视频处理完成的精美简报邮件，支持 4 种可选样式"""
    th = _get_theme(style)
    date_str = time.strftime("%Y年%m月%d日 %H:%M", time.localtime())
    card_html = _render_video_card(1, video, th)
    elapsed = ""
    timings = video.get("timings") or {}
    if timings.get("total"):
        elapsed = f" · 耗时 {timings['total']}s"
    header_border_bottom = "border-bottom:1px solid #e5e7eb;" if style == "minimal" else ""

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:{th['page_bg']};font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:{th['page_bg']};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;">
          <tr>
            <td style="background:{th['header_bg']};border-top:{th['header_top_border']};border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;{header_border_bottom}border-radius:14px 14px 0 0;padding:20px 24px;">
              <div style="font-size:11px;font-weight:600;letter-spacing:1.3px;color:{th['header_meta_color']};text-transform:uppercase;margin-bottom:6px;">
                BILIBILI AI SUMMARY &nbsp;·&nbsp; {html_lib.escape(date_str)}{html_lib.escape(elapsed)}
              </div>
              <div style="font-size:20px;font-weight:800;color:{th['header_title_color']};">
                B站视频 AI 简报
              </div>
            </td>
          </tr>
          <tr>
            <td style="background:{th['body_bg']};border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;padding:18px 18px 6px 18px;">
              {card_html}
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 14px 14px;padding:14px 24px;text-align:center;">
              <div style="font-size:12px;color:#9ca3af;">
                由 <a href="https://bilisum.cc.cd" target="_blank" style="color:{th['accent']};text-decoration:none;font-weight:600;">B站AI摘要 (bilisum.cc.cd)</a> 生成 · 样式：{th['name']}
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def build_digest_email(up_name: str, videos_data: list, style: str = "editorial") -> str:
    """兼容旧调用签名"""
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
    return build_daily_briefing_email(videos, style=style)
