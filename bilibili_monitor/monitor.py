#!/usr/bin/env python3
"""
B站UP主视频监控 → AI总结 → 邮件推送
=====================================

完整流程:
    1. 读取配置和上次处理的状态
    2. 遍历监控的UP主列表
    3. 调用B站API获取最新视频
    4. 对比状态，找出新视频
    5. 获取视频字幕
    6. 调用 AI API 生成总结
    7. 发送邮件通知
    8. 更新状态文件

部署方式:
    - GitHub Actions + 智谱AI (国内直连，完全免费)
    - GitHub Actions + Gemini (永久免费)
    - 本地 Task Scheduler + Ollama (离线免费)
"""

import os
import sys
import json
import time
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import (
    UP_MIDS,
    AI_BACKEND,
    ZHIPU_API_KEY,
    GEMINI_API_KEY,
    DASHSCOPE_API_KEY, DASHSCOPE_MODEL,
    OLLAMA_BASE_URL, OLLAMA_MODEL,
    SMTP_SERVER, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_TO,
    CHECK_WINDOW_SECONDS, MAX_VIDEOS_PER_RUN,
    EMAIL_SUBJECT_PREFIX, STATE_FILE,
    BILI_SESSDATA, BILI_BILI_JCT, BILI_BUVID3,
    HF_TOKEN, WHISPER_MODEL,
)
from bili_api import (
    get_up_video_list, get_video_info, get_up_info,
    format_duration, format_timestamp,
)
from subtitle import get_subtitle_text
from summarizer import summarize_subtitle
from emailer import send_email, build_digest_email
from audio_transcriber import get_text_from_audio


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
        print(f"  [状态] ✓ 已保存")
    except Exception as e:
        print(f"  [状态] ✗ 保存失败: {e}")


def get_new_videos(mid: int, processed_set: set, window: int) -> list:
    """获取UP主的新视频 (按时间窗口过滤)"""
    print(f"  [监控] 正在获取UP主 {mid} 的视频列表...")
    vlist = get_up_video_list(mid)
    if not vlist:
        print(f"  [监控] 获取失败 (可能UP主不存在或无公开视频)")
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
            "created": created,
            "play": v.get("play", 0),
            "duration": v.get("length", ""),
            "mid": mid,
        })

    new_videos.sort(key=lambda x: x["created"], reverse=True)
    print(f"  [监控] 发现 {len(new_videos)} 个新视频")
    return new_videos


def process_video(video: dict, up_name: str, bili_cookies: Optional[dict] = None) -> dict:
    """处理单个视频: 获取字幕 → AI总结 (字幕失败时回退到音频转录)"""
    bvid = video["bvid"]
    title = video["title"]
    print(f"\n  [处理] ▶ {title}")
    print(f"         https://www.bilibili.com/video/{bvid}")

    # 获取视频详情
    info = get_video_info(bvid)
    duration_display = video.get("duration", "")
    pub_time_display = format_timestamp(video["created"]) if video.get("created") else ""

    # Step 1: 尝试获取字幕 (传Cookie以获取AI字幕)
    print(f"  [处理] 正在获取字幕...")
    subtitle_text = get_subtitle_text(bvid, cookies=bili_cookies)

    # Step 2: 字幕失败时，回退到音频转录
    if not subtitle_text and HF_TOKEN:
        print(f"  [处理] 无字幕，尝试音频转文字 (Whisper)...")
        subtitle_text = get_text_from_audio(bvid, hf_token=HF_TOKEN, model=WHISPER_MODEL)
    elif not subtitle_text:
        print(f"  [处理] 无字幕且未配置音频转录 (设置 HF_TOKEN 可启用)")

    # AI总结
    summary = None
    if subtitle_text:
        print(f"  [处理] 正在生成AI总结 (后端: {AI_BACKEND})...")
        summary = summarize_subtitle(
            subtitle_text,
            video_title=title,
            backend=AI_BACKEND,
            zhipu_api_key=ZHIPU_API_KEY,
            gemini_api_key=GEMINI_API_KEY,
            dashscope_api_key=DASHSCOPE_API_KEY,
            dashscope_model=DASHSCOPE_MODEL,
            ollama_base_url=OLLAMA_BASE_URL,
            ollama_model=OLLAMA_MODEL,
        )
    else:
        print(f"  [处理] ⚠ 该视频没有AI字幕，跳过总结")

    return {
        "bvid": bvid,
        "title": title,
        "summary": summary or "（该视频无可用AI字幕，无法生成总结）",
        "url": f"https://www.bilibili.com/video/{bvid}",
        "pub_time": pub_time_display,
        "duration": duration_display,
    }


def _build_bili_cookies() -> Optional[dict]:
    """构建B站登录Cookie字典"""
    if BILI_SESSDATA and BILI_BILI_JCT and BILI_BUVID3:
        cookies = {
            "SESSDATA": BILI_SESSDATA,
            "bili_jct": BILI_BILI_JCT,
            "buvid3": BILI_BUVID3,
        }
        print("  [Cookie] 已配置B站登录Cookie，可获取AI字幕")
        return cookies
    print("  [Cookie] 未配置B站Cookie，仅能获取上传字幕")
    return None


def main():
    """主流程"""
    print("=" * 55)
    print("  🎬 B站UP主视频监控 - AI总结 - 邮件推送")
    print("=" * 55)

    # ---------- 检查配置 ----------
    if not UP_MIDS:
        print("\n❌ 错误: 未配置任何UP主 (请修改 config.py 中的 UP_MIDS)")
        sys.exit(1)

    if AI_BACKEND == "zhipu" and (not ZHIPU_API_KEY or ZHIPU_API_KEY == "xxxxxxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxx"):
        print(f"\n⚠ 警告: ZHIPU_API_KEY 未配置，AI 总结将不可用")
        print(f"   AI后端: 智谱AI (国内直连，免费)")
        print(f"   获取 Key: https://open.bigmodel.cn/ → API Keys\n")
    elif AI_BACKEND == "gemini" and (not GEMINI_API_KEY or GEMINI_API_KEY == "AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"):
        print(f"\n⚠ 警告: GEMINI_API_KEY 未配置，AI 总结将不可用")
        print(f"   AI后端: Google Gemini (永久免费)")
        print(f"   获取 Key: https://aistudio.google.com/apikey\n")
    elif AI_BACKEND == "dashscope" and (not DASHSCOPE_API_KEY or DASHSCOPE_API_KEY.startswith("sk-")):
        print(f"\n⚠ 警告: DASHSCOPE_API_KEY 未配置，AI 总结将不可用\n")

    if not SMTP_USER or SMTP_USER.startswith("your_email"):
        print("\n❌ 错误: 邮箱未配置 (请修改 config.py 中的邮箱配置)")
        sys.exit(1)

    # ---------- 构建B站Cookie ----------
    bili_cookies = _build_bili_cookies()

    # ---------- 加载状态 ----------
    state = load_state(STATE_FILE)
    processed = state.get("processed", {})

    all_new_videos = []

    # ---------- 遍历UP主 ----------
    for mid in UP_MIDS:
        print(f"\n{'─' * 50}")
        print(f"  📺 处理UP主: {mid}")

        up_info = get_up_info(mid)
        up_name = up_info["name"] if up_info else str(mid)

        processed_set = set(processed.get(str(mid), []))
        new_videos = get_new_videos(mid, processed_set, CHECK_WINDOW_SECONDS)

        if not new_videos:
            print(f"  ✓ UP主 {up_name} 暂无新视频")
            continue

        to_process = new_videos[:MAX_VIDEOS_PER_RUN]

        for v in to_process:
            result = process_video(v, up_name, bili_cookies=bili_cookies)
            result["up_name"] = up_name
            result["mid"] = mid
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

    print(f"\n{'─' * 50}")
    print(f"  📧 准备发送邮件 (共 {len(all_new_videos)} 个视频)")

    from collections import defaultdict
    by_up = defaultdict(list)
    for v in all_new_videos:
        by_up[v["up_name"]].append(v)

    email_sent = False
    for up_name, videos in by_up.items():
        videos_data = [
            (v["title"], v["bvid"], v["summary"], v["url"], v["pub_time"], v["duration"])
            for v in videos
        ]

        subject = f"{EMAIL_SUBJECT_PREFIX} {up_name} - {len(videos)} 个新视频"
        html_body = build_digest_email(up_name, videos_data)

        print(f"\n  [邮件] 发送给 {SMTP_TO}...")
        ok = send_email(
            subject=subject,
            html_body=html_body,
            smtp_server=SMTP_SERVER,
            smtp_port=SMTP_PORT,
            smtp_user=SMTP_USER,
            smtp_pass=SMTP_PASS,
            to_addr=SMTP_TO,
        )
        if ok:
            email_sent = True

    # ---------- 保存状态 ----------
    save_state(state, STATE_FILE)

    print(f"\n{'=' * 55}")
    if email_sent:
        print(f"  ✅ 完成! 已处理 {len(all_new_videos)} 个视频并发送邮件")
    else:
        print(f"  ⚠ 完成! 已处理 {len(all_new_videos)} 个视频，但邮件发送可能失败")
    print(f"{'=' * 55}")


if __name__ == "__main__":
    main()
