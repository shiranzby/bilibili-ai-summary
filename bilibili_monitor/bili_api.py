"""
B站开放API封装
==============
所有接口无需Cookie即可调用 (获取公开数据)
"""

import time
import requests
from typing import Optional

# 请求超时设置
TIMEOUT = 15


def get_up_video_list(mid: int, page: int = 1, page_size: int = 30) -> Optional[list]:
    """
    获取UP主视频列表
    API: https://api.bilibili.com/x/space/arc/search

    参数:
        mid: UP主UID
        page: 页码
        page_size: 每页数量 (最大50)

    返回:
        video_list: 视频列表, 每个元素包含 title, bvid, created, length, play 等
        失败返回 None
    """
    url = "https://api.bilibili.com/x/space/arc/search"
    params = {
        "mid": mid,
        "pn": page,
        "ps": min(page_size, 50),
        "order": "pubdate",  # 按发布时间排序
    }
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": "https://www.bilibili.com/",
    }

    try:
        resp = requests.get(url, params=params, headers=headers, timeout=TIMEOUT)
        data = resp.json()
        if data.get("code") != 0:
            print(f"  [B站API] 获取UP主{mid}视频列表失败: {data.get('message')}")
            return None
        vlist = data.get("data", {}).get("list", {}).get("vlist", [])
        return vlist
    except Exception as e:
        print(f"  [B站API] 请求异常: {e}")
        return None


def get_video_info(bvid: str) -> Optional[dict]:
    """
    获取视频详细信息
    API: https://api.bilibili.com/x/web-interface/view

    参数:
        bvid: 视频BV号

    返回:
        info: 包含 title, desc, owner, stat, cid 等信息
        失败返回 None
    """
    url = "https://api.bilibili.com/x/web-interface/view"
    params = {"bvid": bvid}
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": "https://www.bilibili.com/",
    }

    try:
        resp = requests.get(url, params=params, headers=headers, timeout=TIMEOUT)
        data = resp.json()
        if data.get("code") != 0:
            print(f"  [B站API] 获取视频{bvid}信息失败: {data.get('message')}")
            return None
        return data.get("data")
    except Exception as e:
        print(f"  [B站API] 请求异常: {e}")
        return None


def get_up_info(mid: int) -> Optional[dict]:
    """
    获取UP主基本信息
    API: https://api.bilibili.com/x/web-interface/card
    (也可以直接通过 space.bilibili.com/{mid} 获取)

    参数:
        mid: UP主UID

    返回:
        info: 包含 name, face 等信息
    """
    url = "https://api.bilibili.com/x/web-interface/card"
    params = {"mid": mid}
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": "https://www.bilibili.com/",
    }

    try:
        resp = requests.get(url, params=params, headers=headers, timeout=TIMEOUT)
        data = resp.json()
        if data.get("code") != 0:
            return None
        card = data.get("data", {}).get("card", {})
        return {
            "name": card.get("name", str(mid)),
            "face": card.get("face", ""),
        }
    except Exception:
        return None


def format_duration(seconds: int) -> str:
    """将秒数格式化为 MM:SS 或 HH:MM:SS"""
    h, remainder = divmod(seconds, 3600)
    m, s = divmod(remainder, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def format_timestamp(ts: int) -> str:
    """将时间戳格式化为日期字符串"""
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))
