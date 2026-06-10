"""
B站视频字幕获取
==============

通过B站API获取视频字幕文本。
支持两种字幕:
  - AI字幕 (ai-zh): B站自动语音识别生成，需要登录Cookie
  - 上传字幕 (zh-CN): UP主手动上传，Cookie可选

流程: view API → 获取cid → player/wbi/v2 API → subtitle_url → 下载字幕JSON

关键:
  - AI字幕需要Cookie认证 (x/player/wbi/v2 接口)
  - 不传Cookie也能获取上传字幕，但无法获取AI字幕
"""

import requests
from typing import Optional

# 通用请求头
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
}


def _fix_url(url: str) -> str:
    """补全字幕URL (//开头 → https:)"""
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("/"):
        return "https:" + url
    return url


def get_cid(bvid: str) -> Optional[int]:
    """
    获取视频的第一P的cid
    API: https://api.bilibili.com/x/web-interface/view?bvid={bvid}
    """
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/web-interface/view",
            params={"bvid": bvid},
            headers=_HEADERS,
            timeout=15,
        )
        data = resp.json()
        if data.get("code") != 0:
            return None
        pages = data.get("data", {}).get("pages", [])
        return pages[0].get("cid") if pages else None
    except Exception:
        return None


def get_subtitle_url(
    bvid: str,
    cid: int,
    cookies: Optional[dict] = None,
) -> Optional[str]:
    """
    获取字幕文件的下载URL

    API: https://api.bilibili.com/x/player/wbi/v2?bvid={bvid}&cid={cid}
    这个接口需要Cookie才能返回AI字幕数据。
    Cookie格式: {"SESSDATA": "xxx", "bili_jct": "xxx", "buvid3": "xxx"}

    返回:
        字幕JSON文件的完整URL
        如果没有字幕则返回 None
    """
    url = "https://api.bilibili.com/x/player/wbi/v2"
    params = {"bvid": bvid, "cid": cid}

    try:
        resp = requests.get(
            url,
            params=params,
            headers=_HEADERS,
            cookies=cookies,
            timeout=15,
        )
        data = resp.json()
        if data.get("code") != 0:
            return None

        subtitles = data.get("data", {}).get("subtitle", {}).get("subtitles", [])
        if not subtitles:
            # 如果wbi接口没找到，回退到旧版v2接口（不需要cookie的上传字幕）
            return _fallback_subtitle_url(bvid, cid)

        # 优先选择: AI中文字幕 > 中文字幕 > 第一个字幕
        for sub in subtitles:
            if sub.get("lan") in ("ai-zh", "zh-CN", "zh"):
                url = _fix_url(sub.get("subtitle_url", ""))
                if url:
                    return url

        # 没有中文，取第一个
        first_url = _fix_url(subtitles[0].get("subtitle_url", ""))
        return first_url if first_url else None

    except Exception:
        return None


def _fallback_subtitle_url(bvid: str, cid: int) -> Optional[str]:
    """
    回退方案: 用旧版 x/player/v2 接口
    这个接口不需要Cookie，但只能获取上传字幕(非AI字幕)
    """
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/player/v2",
            params={"bvid": bvid, "cid": cid},
            headers=_HEADERS,
            timeout=15,
        )
        data = resp.json()
        if data.get("code") != 0:
            return None
        subtitles = data.get("data", {}).get("subtitle", {}).get("list", [])
        if not subtitles:
            return None
        for sub in subtitles:
            if sub.get("lan") in ("ai-zh", "zh-CN", "zh"):
                url = _fix_url(sub.get("subtitle_url", ""))
                if url:
                    return url
        first_url = _fix_url(subtitles[0].get("subtitle_url", ""))
        return first_url if first_url else None
    except Exception:
        return None


def download_subtitle(subtitle_url: str) -> Optional[str]:
    """
    下载字幕JSON并提取纯文本内容
    """
    try:
        resp = requests.get(subtitle_url, headers=_HEADERS, timeout=15)
        data = resp.json()
        body = data.get("body", [])
        if not body:
            return None
        lines = [item.get("content", "").strip() for item in body if item.get("content")]
        return "\n".join(lines) if lines else None
    except Exception:
        return None


def get_subtitle_text(
    bvid: str,
    cookies: Optional[dict] = None,
) -> Optional[str]:
    """
    一站式获取B站视频字幕文本

    流程:
        bvid → cid → subtitle_url (优先wbi/v2, 回退v2) → 字幕文本

    参数:
        bvid: 视频BV号
        cookies: B站登录Cookie (可选，不传也能获取上传字幕)

    返回:
        字幕纯文本 (按时间顺序拼接)
        如果没有字幕则返回 None
    """
    cookies_str = "已提供" if cookies else "未提供"

    # Step 1: 获取cid
    cid = get_cid(bvid)
    if not cid:
        print(f"    [字幕] 无法获取视频 {bvid} 的 cid")
        return None

    # Step 2: 获取字幕URL (先wbi/v2有Cookie的AI字幕，回退v2)
    subtitle_url = get_subtitle_url(bvid, cid, cookies)
    if not subtitle_url:
        print(f"    [字幕] 视频 {bvid} 没有任何字幕 (Cookie: {cookies_str})")
        return None

    # Step 3: 下载字幕
    text = download_subtitle(subtitle_url)
    if not text:
        print(f"    [字幕] 下载字幕内容失败")
        return None

    print(f"    [字幕] 成功获取字幕 ({len(text)} 字符)")
    return text
