#!/usr/bin/env python3
"""
B站UP主视频监控 → AI总结 → 邮件推送
=====================================

完整流程:
    1. 优先从 Cloudflare Worker 拉取前端在线配置的监控参数 (UP主列表 / 邮件样式 / 合并开关 / 窗口)
       若未配置远程 Worker 则平滑回退本地 config.py
    2. 遍历监控的UP主列表，对比 state.json 找出新视频
    3. 音频下载 + 免费语音识别 (硅基流动 SenseVoiceSmall / 可选免费 Groq)
    4. 调用 AI API 生成总结 (硅基流动免费 Qwen/Qwen3-8B)
    5. 按选定样式渲染合并日报或分 UP 主邮件并发送
    6. 更新状态文件
"""

import os
import sys
import json
import time
import requests
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import (
    UP_MIDS,
    SILICONFLOW_API_KEY,
    SILICONFLOW_STT_MODEL,
    SILICONFLOW_SUMMARY_MODEL,
    SMTP_SERVER, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_TO,
    CHECK_WINDOW_SECONDS, MAX_VIDEOS_PER_RUN,
    EMAIL_SUBJECT_PREFIX, STATE_FILE,
)
from bili_api import (
    get_up_video_list, get_video_info, get_up_info,
    format_timestamp,
)
from summarizer import summarize_subtitle
from emailer import send_email, build_daily_briefing_email
from audio_transcriber import get_text_from_audio, get_last_diagnostics


def push_monitor_archive(videos: list):
    """将本次监控生成的视频摘要推送至 Worker R2 归档，供 Web 端「UP主监控」二级页面直接查看"""
    worker_url = os.environ.get("WORKER_URL", "").strip().rstrip("/")
    monitor_token = os.environ.get("CRON_TRIGGER_SECRET", "").strip()
    if not worker_url or not monitor_token or not videos:
        return
    try:
        resp = requests.post(
            f"{worker_url}/api/monitor-archive",
            headers={"X-Monitor-Token": monitor_token, "Content-Type": "application/json"},
            json={"videos": videos},
            timeout=20,
        )
        if resp.ok:
            print(f"  [归档] ✅ 已同步 {len(videos)} 条监控摘要至在线后台")
        else:
            print(f"  [归档] ⚠ 同步返回 HTTP {resp.status_code}")
    except Exception as e:
        print(f"  [归档] ⚠ 同步异常 (非致命): {e}")


def load_remote_monitor_config() -> dict:
    """从 Cloudflare Worker 拉取前端配置的在线监控参数 (失败则返回空 dict，回退本地 config.py)"""
    worker_url = os.environ.get("WORKER_URL", "").strip().rstrip("/")
    monitor_token = os.environ.get("CRON_TRIGGER_SECRET", "").strip()
    if not worker_url or not monitor_token:
        return {}
    try:
        resp = requests.get(
            f"{worker_url}/api/monitor-config",
            headers={"X-Monitor-Token": monitor_token, "User-Agent": "bilisum-monitor/2.0"},
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            cfg = data.get("config") if isinstance(data, dict) and "config" in data else data
            if isinstance(cfg, dict):
                print(f"  [配置] ✅ 已从在线后台加载监控配置 (样式={cfg.get('email_style', 'editorial')}, UP数={len(cfg.get('up_list', []))})")
                return cfg
        else:
            print(f"  [配置] ⚠ 在线配置返回 HTTP {resp.status_code}，回退本地 config.py")
    except Exception as e:
        print(f"  [配置] ⚠ 拉取在线配置异常 ({e})，回退本地 config.py")
    return {}


def load_state(state_path: str) -> dict:
    """加载状态文件"""
    if os.path.exists(state_path):
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                state = json.load(f)
                count = sum(len(v) for v in state.get("processed", {}).values())
                print(f"  [状态] 已加载 (已处理 {count} 个视频)")
                return state
        except Exception as e:
            print(f"  [状态] 读取失败: {e}")
    print("  [状态] 初始化空状态")
    return {"processed": {}}


def save_state(state: dict, state_path: str):
    """保存状态文件"""
    try:
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        print("  [状态] ✓ 已保存")
    except Exception as e:
        print(f"  [状态] ✗ 保存失败: {e}")


def get_new_videos(mid: int, processed_set: set, window: int) -> list:
    """获取UP主的新视频 (按时间窗口过滤)"""
    print(f"  [监控] 正在获取UP主 {mid} 的视频列表...")
    vlist = get_up_video_list(mid)
    if not vlist:
        print("  [监控] 获取失败 (可能UP主不存在或无公开视频)")
        return []

    now = int(time.time())
    new_videos = []

    for v in vlist:
        bvid = v.get("bvid", "")
        if not bvid or bvid in processed_set:
            continue

        created = v.get("created", 0)
        if now - created > window:
            break

        new_videos.append({
            "bvid": bvid,
            "title": v.get("title", "").strip(),
            "pic": (v.get("pic") or "").replace("http://", "https://"),
            "created": created,
            "play": v.get("play", 0),
            "duration": v.get("length", ""),
            "mid": mid,
        })

    new_videos.sort(key=lambda x: x["created"], reverse=True)
    print(f"  [监控] 发现 {len(new_videos)} 个新视频")
    return new_videos


def process_video(video: dict, up_name: str) -> dict:
    """处理单个视频: 音频下载+语音识别 → AI总结"""
    bvid = video["bvid"]
    title = video["title"]
    print(f"\n  [处理] ▶ {title}")
    print(f"         https://www.bilibili.com/video/{bvid}")

    info = get_video_info(bvid)
    duration_display = video.get("duration", "")
    pub_time_display = format_timestamp(video["created"]) if video.get("created") else ""

    audio_text = None
    if SILICONFLOW_API_KEY or os.environ.get("GROQ_API_KEY"):
        print("  [处理] 下载音频并进行语音识别...")
        audio_text = get_text_from_audio(
            bvid,
            siliconflow_api_key=SILICONFLOW_API_KEY,
            siliconflow_stt_model=SILICONFLOW_STT_MODEL,
        )

    subtitle_text = audio_text
    diag_msg = ""
    if not subtitle_text:
        diag = get_last_diagnostics()
        diag_msg = f"（失败环节: {diag.get('stage') or '未知'}；原因: {diag.get('error') or '未能获取文字内容'}）"
        desc = (info or {}).get("desc", "").strip()
        if desc and len(desc) > 20:
            print(f"  [处理] ✅ 使用视频描述 ({len(desc)} 字符)")
            subtitle_text = f"[视频描述] {desc[:3000]}"
        else:
            print(f"  [处理] ⚠ 语音识别失败且无视频描述 {diag_msg}")

    summary = None
    if subtitle_text:
        print("  [处理] 正在生成AI总结 (硅基流动)...")
        summary = summarize_subtitle(
            subtitle_text,
            video_title=title,
            api_key=SILICONFLOW_API_KEY,
            model=SILICONFLOW_SUMMARY_MODEL,
        )
    else:
        print("  [处理] ⚠ 无法获取视频文字内容，跳过总结")

    pic_url = (video.get("pic") or (info or {}).get("pic") or "").replace("http://", "https://")
    return {
        "bvid": bvid,
        "title": title,
        "pic": pic_url,
        "summary": summary or f"（该视频无法获取文字内容，无法生成总结{diag_msg}）",
        "url": f"https://www.bilibili.com/video/{bvid}",
        "pub_time": pub_time_display,
        "duration": duration_display,
    }


def main():
    """主流程"""
    print("=" * 55)
    print("  🎬 B站UP主视频监控 - AI总结 - 邮件推送")
    print("=" * 55)

    # ---------- 合并在线配置与本地配置 ----------
    remote_cfg = load_remote_monitor_config()

    # UP 主列表
    active_mids = list(UP_MIDS)
    up_name_hints = {}
    if isinstance(remote_cfg.get("up_list"), list) and len(remote_cfg["up_list"]) > 0:
        parsed_mids = []
        for item in remote_cfg["up_list"]:
            if isinstance(item, dict) and item.get("mid"):
                try:
                    m = int(item["mid"])
                    parsed_mids.append(m)
                    if item.get("name"):
                        up_name_hints[m] = str(item["name"])
                except ValueError:
                    pass
            elif isinstance(item, (int, str)) and str(item).isdigit():
                parsed_mids.append(int(item))
        if parsed_mids:
            active_mids = parsed_mids

    email_style = (
        os.environ.get("EMAIL_STYLE", "").strip()
        or str(remote_cfg.get("email_style") or "editorial").strip()
    )
    merge_emails = remote_cfg.get("merge_emails", True)
    target_email = str(remote_cfg.get("smtp_to") or "").strip() or SMTP_TO
    window_seconds = (
        int(remote_cfg["check_window_hours"]) * 3600
        if remote_cfg.get("check_window_hours")
        else CHECK_WINDOW_SECONDS
    )
    max_per_run = int(remote_cfg.get("max_videos_per_run") or MAX_VIDEOS_PER_RUN)

    print(f"  [配置] 监控UP数: {len(active_mids)} | 样式: {email_style} | 合并日报: {merge_emails} | 窗口: {window_seconds//3600}h")

    if not active_mids:
        print("\n❌ 错误: 未配置任何UP主")
        sys.exit(1)

    if not SILICONFLOW_API_KEY:
        print("\n⚠ 警告: SILICONFLOW_API_KEY 未配置，语音识别和AI总结将不可用")

    if not SMTP_USER or SMTP_USER.startswith("your_email"):
        print("\n❌ 错误: 邮箱未配置")
        sys.exit(1)

    # ---------- 加载状态 ----------
    state = load_state(STATE_FILE)
    processed = state.get("processed", {})
    all_new_videos = []

    # ---------- 遍历UP主 ----------
    for mid in active_mids:
        print(f"\n{'─' * 50}")
        print(f"  📺 处理UP主: {mid}")

        up_info = get_up_info(mid)
        up_name = (up_info["name"] if up_info else None) or up_name_hints.get(mid) or str(mid)

        processed_set = set(processed.get(str(mid), []))
        new_videos = get_new_videos(mid, processed_set, window_seconds)

        if not new_videos:
            print(f"  ✓ UP主 {up_name} 暂无新视频")
            continue

        to_process = new_videos[:max_per_run]

        for v in to_process:
            result = process_video(v, up_name)
            result["up_name"] = up_name
            result["mid"] = mid
            result["created"] = v.get("created", 0)
            all_new_videos.append(result)

            processed_set.add(v["bvid"])
            time.sleep(1)

        processed[str(mid)] = list(processed_set)

    # ---------- 发送邮件 ----------
    if not all_new_videos:
        print(f"\n{'=' * 55}")
        print("  📭 没有新视频，无需发送邮件")
        print(f"{'=' * 55}")
        save_state(state, STATE_FILE)
        return

    all_new_videos.sort(key=lambda x: x.get("created", 0), reverse=True)
    date_tag = time.strftime("%m/%d", time.localtime())
    email_sent = False

    if merge_emails:
        print(f"\n{'─' * 50}")
        print(f"  📧 准备发送合并日报邮件 (共 {len(all_new_videos)} 个视频, 样式={email_style})")
        up_names = []
        for v in all_new_videos:
            if v["up_name"] not in up_names:
                up_names.append(v["up_name"])
        up_preview = "、".join(up_names[:3]) + (f" 等{len(up_names)}位UP" if len(up_names) > 3 else "")
        subject = f"{EMAIL_SUBJECT_PREFIX} ({date_tag}) · {len(all_new_videos)} 支新视频（{up_preview}）"
        html_body = build_daily_briefing_email(all_new_videos, style=email_style)

        print(f"\n  [邮件] 发送合并日报给 {target_email}...")
        email_sent = send_email(
            subject=subject,
            html_body=html_body,
            smtp_server=SMTP_SERVER,
            smtp_port=SMTP_PORT,
            smtp_user=SMTP_USER,
            smtp_pass=SMTP_PASS,
            to_addr=target_email,
        )
    else:
        print(f"\n{'─' * 50}")
        print(f"  📧 准备按 UP 主分封发送邮件 (共 {len(all_new_videos)} 个视频, 样式={email_style})")
        by_up = defaultdict(list)
        for v in all_new_videos:
            by_up[v["up_name"]].append(v)
        for up_name, videos in by_up.items():
            subject = f"{EMAIL_SUBJECT_PREFIX} ({date_tag}) · {up_name}（{len(videos)} 支新视频）"
            html_body = build_daily_briefing_email(videos, style=email_style)
            ok = send_email(
                subject=subject,
                html_body=html_body,
                smtp_server=SMTP_SERVER,
                smtp_port=SMTP_PORT,
                smtp_user=SMTP_USER,
                smtp_pass=SMTP_PASS,
                to_addr=target_email,
            )
            if ok:
                email_sent = True

    # ---------- 归档至 Worker R2 + 保存状态 ----------
    push_monitor_archive(all_new_videos)
    save_state(state, STATE_FILE)

    print(f"\n{'=' * 55}")
    if email_sent:
        print(f"  ✅ 完成! 已处理 {len(all_new_videos)} 个视频并发送邮件")
    else:
        print(f"  ⚠ 完成! 已处理 {len(all_new_videos)} 个视频，但邮件发送可能失败")
    print(f"{'=' * 55}")


if __name__ == "__main__":
    main()
