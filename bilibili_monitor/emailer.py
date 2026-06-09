"""
邮件发送模块
===========

支持QQ邮箱 / 163邮箱 / Gmail 的 SMTP 发送
"""

import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.header import Header
from typing import Optional


def send_email(
    subject: str,
    html_body: str,
    smtp_server: str,
    smtp_port: int,
    smtp_user: str,
    smtp_pass: str,
    to_addr: str,
) -> bool:
    """
    发送HTML格式邮件

    参数:
        subject: 邮件主题
        html_body: HTML格式正文
        smtp_server: SMTP服务器地址
        smtp_port: SMTP端口
        smtp_user: 发件邮箱
        smtp_pass: 邮箱授权码 (不是密码!)
        to_addr: 收件邮箱

    返回:
        True=发送成功, False=失败
    """
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = Header(subject, "utf-8")
        msg["From"] = smtp_user
        msg["To"] = to_addr

        # 添加HTML正文
        html_part = MIMEText(html_body, "html", "utf-8")
        msg.attach(html_part)

        # 连接SMTP并发送
        if smtp_port == 465:
            # SSL连接
            with smtplib.SMTP_SSL(smtp_server, smtp_port, timeout=30) as server:
                server.login(smtp_user, smtp_pass)
                server.sendmail(smtp_user, [to_addr], msg.as_string())
        else:
            # TLS连接
            with smtplib.SMTP(smtp_server, smtp_port, timeout=30) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.sendmail(smtp_user, [to_addr], msg.as_string())

        print(f"  [邮件] ✓ 发送成功 → {to_addr}")
        return True

    except smtplib.SMTPAuthenticationError:
        print(f"  [邮件] ✗ 认证失败! 请检查邮箱/授权码是否正确")
        return False
    except smtplib.SMTPException as e:
        print(f"  [邮件] ✗ SMTP错误: {e}")
        return False
    except Exception as e:
        print(f"  [邮件] ✗ 发送失败: {e}")
        return False


def build_video_summary_email(
    up_name: str,
    video_title: str,
    bvid: str,
    summary: str,
    video_url: str = "",
    publish_time: str = "",
    duration: str = "",
) -> str:
    """
    构建单个视频摘要邮件的HTML正文
    """
    if not video_url:
        video_url = f"https://www.bilibili.com/video/{bvid}"

    # 将summary的Markdown转换为简单HTML
    summary_html = summary.replace("\n", "<br>") if summary else "（无法获取字幕或无字幕内容）"

    info_parts = [f"<strong>标题:</strong> {video_title}"]
    if duration:
        info_parts.append(f"<strong>时长:</strong> {duration}")
    if publish_time:
        info_parts.append(f"<strong>发布时间:</strong> {publish_time}")

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #333;">
    <div style="background: linear-gradient(135deg, #fb7299, #fc8bab); color: white; padding: 24px; border-radius: 12px; margin-bottom: 20px;">
        <h2 style="margin: 0 0 8px 0;">🎬 B站视频监控</h2>
        <p style="margin: 0; opacity: 0.9;">UP主: {up_name} 发布了新视频</p>
    </div>
    <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin-bottom: 20px;">
        {'<br>'.join(info_parts)}
        <br><a href="{video_url}" style="color: #fb7299; text-decoration: none; font-weight: bold;" target="_blank">🔗 在B站观看</a>
    </div>
    <div style="border-left: 4px solid #fb7299; padding-left: 16px; margin-bottom: 20px;">
        <h3 style="color: #333; margin: 0 0 12px 0;">🤖 AI 总结</h3>
        <div style="line-height: 1.7; color: #444;">
            {summary_html}
        </div>
    </div>
    <div style="border-top: 1px solid #eee; padding-top: 16px; margin-top: 20px; color: #999; font-size: 12px;">
        <p>本邮件由 Bilibili Monitor 自动生成 · Powered by 通义千问</p>
    </div>
</body></html>
"""
    return html


def build_digest_email(
    up_name: str,
    videos_data: list,
) -> str:
    """
    构建多视频摘要邮件的HTML正文 (多个视频一次发送)

    videos_data: [(title, bvid, summary, url, pub_time, duration), ...]
    """
    cards = []
    for i, (title, bvid, summary, video_url, pub_time, duration) in enumerate(videos_data, 1):
        if not video_url:
            video_url = f"https://www.bilibili.com/video/{bvid}"
        
        summary_html = summary.replace("\n", "<br>") if summary else "（无字幕内容）"
        
        card = f"""
        <div style="background: #fafafa; border: 1px solid #eee; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
            <div style="font-size: 14px; color: #999; margin-bottom: 4px;">#{i}</div>
            <div style="font-size: 16px; font-weight: bold; margin-bottom: 8px;">{title}</div>
            <div style="font-size: 13px; color: #666; margin-bottom: 8px;">
                {'时长: ' + duration if duration else ''}
                {' | ' if duration and pub_time else ''}
                {pub_time if pub_time else ''}
            </div>
            <a href="{video_url}" style="color: #fb7299; font-size: 13px; text-decoration: none;" target="_blank">🔗 在B站观看</a>
            <div style="border-top: 1px dashed #eee; margin: 10px 0; padding-top: 10px; line-height: 1.6; font-size: 14px;">
                {summary_html}
            </div>
        </div>
        """
        cards.append(card)

    html = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: -apple-system, 'Segoe UI', sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #333;">
        <div style="background: linear-gradient(135deg, #fb7299, #fc8bab); color: white; padding: 24px; border-radius: 12px; margin-bottom: 20px;">
            <h2 style="margin: 0 0 8px 0;">🎬 B站视频日报</h2>
            <p style="margin: 0; opacity: 0.9;">UP主: {up_name} · 共 {len(videos_data)} 个新视频</p>
        </div>
        {''.join(cards)}
        <div style="border-top: 1px solid #eee; padding-top: 16px; margin-top: 20px; color: #999; font-size: 12px;">
            <p>本邮件由 Bilibili Monitor 自动生成</p>
        </div>
    </body></html>
    """
    return html
