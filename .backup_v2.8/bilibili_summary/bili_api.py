"""
B站开放API封装
==============
所有接口无需Cookie即可调用 (获取公开数据)

包含 WBI 签名机制，以绕过 GHA 环境的反爬限制。
"""

import time
import requests
import hashlib
import urllib.parse
from typing import Optional

TIMEOUT = 15

# WBI 签名缓存
_wbi_keys = {"img_key": "", "sub_key": "", "timestamp": 0}


def _get_wbi_keys() -> tuple:
    """
    获取 WBI 签名所需的 key (img_key + sub_key)
    缓存 24 小时
    """
    now = int(time.time())
    if _wbi_keys["timestamp"] + 86400 > now and _wbi_keys["img_key"]:
        return _wbi_keys["img_key"], _wbi_keys["sub_key"]

    url = "https://api.bilibili.com/x/web-interface/nav"
    headers = _make_headers()
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        data = resp.json()
        if data.get("code") == 0:
            wbi_img = data.get("data", {}).get("wbi_img", {})
            _wbi_keys["img_key"] = wbi_img.get("img_url", "").rsplit("/", 1)[-1].split(".")[0]
            _wbi_keys["sub_key"] = wbi_img.get("sub_url", "").rsplit("/", 1)[-1].split(".")[0]
            _wbi_keys["timestamp"] = now
    except Exception:
        pass

    return _wbi_keys["img_key"], _wbi_keys["sub_key"]


def _sign_wbi(params: dict) -> dict:
    """
    对请求参数进行 WBI 签名
    返回添加了 w_rid 和 wts 的新参数字典
    """
    img_key, sub_key = _get_wbi_keys()
    mix_key = hashlib.md5((img_key + sub_key).encode()).hexdigest()

    params["wts"] = int(time.time())
    sorted_params = sorted(params.items(), key=lambda x: x[0])
    query = urllib.parse.urlencode(sorted_params)
    sign_str = query + mix_key
    params["w_rid"] = hashlib.md5(sign_str.encode()).hexdigest()
    return params


def _make_headers() -> dict:
    """生成通用请求头 (使用移动端UA避免风控)"""
    return {
        "User-Agent": (
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Mobile Safari/537.36"
        ),
        "Referer": "https://m.bilibili.com/",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }


def get_up_video_list(mid: int, page: int = 1, page_size: int = 30) -> Optional[list]:
    """
    获取UP主视频列表 (带WBI签名)
    API: https://api.bilibili.com/x/space/arc/search
    """
    params = {
        "mid": mid,
        "pn": page,
        "ps": min(page_size, 50),
        "order": "pubdate",
    }

    try:
        # 先尝试不带签名的请求
        resp = requests.get(
            "https://api.bilibili.com/x/space/arc/search",
            params=params,
            headers=_make_headers(),
            timeout=TIMEOUT,
        )
        data = resp.json()
        if data.get("code") == 0:
            return data.get("data", {}).get("list", {}).get("vlist", [])

        # 失败则带 WBI 签名重试
        print(f"  [B站API] 无签名请求失败 ({data.get('message')}), 尝试 WBI 签名...")
        signed_params = _sign_wbi(params)
        resp2 = requests.get(
            "https://api.bilibili.com/x/space/arc/search",
            params=signed_params,
            headers=_make_headers(),
            timeout=TIMEOUT,
        )
        data2 = resp2.json()
        if data2.get("code") != 0:
            print(f"  [B站API] WBI签名请求也失败: {data2.get('message')} (code={data2.get('code')})")
            return None
        return data2.get("data", {}).get("list", {}).get("vlist", [])

    except Exception as e:
        # 如果非JSON响应 (空响应/HTML)，尝试WBI签名
        print(f"  [B站API] 请求异常: {e}, 尝试 WBI 签名...")
        try:
            signed_params = _sign_wbi(params)
            resp2 = requests.get(
                "https://api.bilibili.com/x/space/arc/search",
                params=signed_params,
                headers=_make_headers(),
                timeout=TIMEOUT,
            )
            data2 = resp2.json()
            if data2.get("code") == 0:
                return data2.get("data", {}).get("list", {}).get("vlist", [])
            print(f"  [B站API] WBI签名仍然失败: {data2.get('message')}")
            return None
        except Exception as e2:
            print(f"  [B站API] WBI签名也异常: {e2}")
            return None


def get_video_info(bvid: str) -> Optional[dict]:
    """
    获取视频详细信息
    API: https://api.bilibili.com/x/web-interface/view
    """
    params = {"bvid": bvid}
    headers = _make_headers()

    try:
        resp = requests.get(
            "https://api.bilibili.com/x/web-interface/view",
            params=params, headers=headers, timeout=TIMEOUT
        )
        data = resp.json()
        if data.get("code") != 0:
            print(f"  [B站API] 获取视频{bvid}信息失败: {data.get('message')}")
            return None
        return data.get("data")
    except Exception:
        return None


def get_up_info(mid: int) -> Optional[dict]:
    """
    获取UP主基本信息
    API: https://api.bilibili.com/x/web-interface/card
    """
    params = {"mid": mid}
    headers = _make_headers()

    try:
        resp = requests.get(
            "https://api.bilibili.com/x/web-interface/card",
            params=params, headers=headers, timeout=TIMEOUT
        )
        data = resp.json()
        if data.get("code") != 0:
            return None
        card = data.get("data", {}).get("card", {})
        return {"name": card.get("name", str(mid)), "face": card.get("face", "")}
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
