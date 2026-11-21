"""
B站开放API封装
==============
所有接口无需Cookie即可调用 (获取公开数据)

包含:
  - 真实 WBI 签名机制 (MIXIN_KEY_ENC_TAB)
  - 自动获取 buvid3/buvid4 指纹 Cookie (/x/frontend/finger/spi)
  - 可选 BILI_COOKIE / BILI_SESSDATA 环境变量注入
  - Vercel 中继兜底 (BILI_PROXY_URL)，自动绕过 GitHub Actions/Azure IP -412/-352 封禁
"""

import os
import time
import requests
import hashlib
import urllib.parse
from typing import Optional

TIMEOUT = 15

# 默认 Vercel 中继地址 (可通过环境变量 BILI_PROXY_URL 覆盖，设为 "off" 可禁用)
DEFAULT_BILI_PROXY_URL = "https://bilisum-bili-proxy.vercel.app"

# B站 WBI 签名官方重排表
MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]

# 缓存
_wbi_keys = {"img_key": "", "sub_key": "", "timestamp": 0}
_buvid_cache = {"cookie": "", "timestamp": 0}
_proxy_info_cache = {}  # bvid -> full /api/bili-info payload


def get_bili_proxy_url() -> str:
    """获取 B站中继代理地址"""
    val = os.environ.get("BILI_PROXY_URL", DEFAULT_BILI_PROXY_URL).strip()
    if val.lower() in ("off", "none", "false", "0"):
        return ""
    return val.rstrip("/")


def _get_cookie_header() -> str:
    """组装 Cookie 头: 可选 BILI_COOKIE / BILI_SESSDATA + 自动获取的 buvid3/buvid4"""
    parts = []
    raw_cookie = os.environ.get("BILI_COOKIE", "").strip()
    sessdata = os.environ.get("BILI_SESSDATA", "").strip()
    if raw_cookie:
        parts.append(raw_cookie)
    elif sessdata:
        parts.append(f"SESSDATA={sessdata}")

    now = int(time.time())
    if _buvid_cache["timestamp"] + 3600 < now:
        try:
            resp = requests.get(
                "https://api.bilibili.com/x/frontend/finger/spi",
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/126.0.0.0 Safari/537.36"
                    ),
                    "Referer": "https://www.bilibili.com/",
                },
                timeout=8,
            )
            if resp.status_code == 200:
                d = resp.json().get("data") or {}
                b3 = d.get("b_3", "")
                b4 = d.get("b_4", "")
                segs = []
                if b3:
                    segs.append(f"buvid3={b3}")
                if b4:
                    segs.append(f"buvid4={b4}")
                _buvid_cache["cookie"] = "; ".join(segs)
        except Exception:
            pass
        _buvid_cache["timestamp"] = now

    if _buvid_cache["cookie"]:
        parts.append(_buvid_cache["cookie"])
    return "; ".join(parts)


def _make_headers(mobile: bool = True, include_cookie: bool = True) -> dict:
    """生成通用请求头"""
    if mobile:
        ua = (
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Mobile Safari/537.36"
        )
        referer = "https://m.bilibili.com/"
    else:
        ua = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        )
        referer = "https://www.bilibili.com/"

    h = {
        "User-Agent": ua,
        "Referer": referer,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if include_cookie:
        cookie = _get_cookie_header()
        if cookie:
            h["Cookie"] = cookie
    return h


def _get_wbi_keys() -> tuple:
    """获取 WBI 签名所需的 key (img_key + sub_key)，缓存 24 小时"""
    now = int(time.time())
    if _wbi_keys["timestamp"] + 86400 > now and _wbi_keys["img_key"]:
        return _wbi_keys["img_key"], _wbi_keys["sub_key"]

    url = "https://api.bilibili.com/x/web-interface/nav"
    try:
        resp = requests.get(url, headers=_make_headers(mobile=False), timeout=10)
        data = resp.json()
        wbi_img = (data.get("data") or {}).get("wbi_img") or {}
        img_url = wbi_img.get("img_url", "")
        sub_url = wbi_img.get("sub_url", "")
        if img_url and sub_url:
            _wbi_keys["img_key"] = img_url.rsplit("/", 1)[-1].split(".")[0]
            _wbi_keys["sub_key"] = sub_url.rsplit("/", 1)[-1].split(".")[0]
            _wbi_keys["timestamp"] = now
    except Exception:
        pass

    return _wbi_keys["img_key"], _wbi_keys["sub_key"]


def _get_mixin_key(orig: str) -> str:
    return "".join(orig[i] for i in MIXIN_KEY_ENC_TAB if i < len(orig))[:32]


def _sign_wbi(params: dict) -> dict:
    """使用官方 MIXIN_KEY_ENC_TAB 算法对请求参数进行 WBI 签名"""
    img_key, sub_key = _get_wbi_keys()
    if not img_key or not sub_key:
        return dict(params)

    mixin_key = _get_mixin_key(img_key + sub_key)
    signed = {k: v for k, v in params.items()}
    signed["wts"] = int(time.time())
    sorted_items = sorted(signed.items(), key=lambda x: x[0])
    filtered = {
        k: "".join(c for c in str(v) if c not in "!'()*")
        for k, v in sorted_items
    }
    query = urllib.parse.urlencode(filtered)
    filtered["w_rid"] = hashlib.md5((query + mixin_key).encode("utf-8")).hexdigest()
    return filtered


def fetch_video_bundle_from_proxy(bvid: str, force_refresh: bool = False) -> Optional[dict]:
    """
    通过 Vercel 中继一次性获取视频信息 + cid + 音频直链。
    成功结果按 bvid 缓存在进程内存中，避免 monitor/process_single 和 audio_transcriber 重复请求。
    """
    if not force_refresh and bvid in _proxy_info_cache:
        return _proxy_info_cache[bvid]

    proxy = get_bili_proxy_url()
    if not proxy:
        return None

    try:
        resp = requests.get(
            f"{proxy}/api/bili-info",
            params={"bvid": bvid},
            headers={"User-Agent": "bilisum/2.0"},
            timeout=25,
        )
        if resp.status_code != 200:
            print(f"  [B站中继] HTTP {resp.status_code}")
            return None
        data = resp.json()
        if data.get("ok"):
            _proxy_info_cache[bvid] = data
            return data
        print(f"  [B站中继] 返回失败: {data.get('debug')}")
        return None
    except Exception as e:
        print(f"  [B站中继] 异常: {e}")
        return None


def get_up_video_list(mid: int, page: int = 1, page_size: int = 30) -> Optional[list]:
    """
    获取UP主视频列表 (直连 → WBI签名 → Vercel中继兜底)
    API: https://api.bilibili.com/x/space/arc/search
    """
    params = {
        "mid": mid,
        "pn": page,
        "ps": min(page_size, 50),
        "order": "pubdate",
    }

    # 1. 直连尝试 (移动端UA)
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/space/arc/search",
            params=params,
            headers=_make_headers(mobile=True),
            timeout=TIMEOUT,
        )
        data = resp.json()
        if data.get("code") == 0:
            return data.get("data", {}).get("list", {}).get("vlist", [])
        print(f"  [B站API] 无签名请求失败 ({data.get('message')}), 尝试 WBI 签名...")
    except Exception as e:
        print(f"  [B站API] 请求异常: {e}, 尝试 WBI 签名...")

    # 2. 真实 WBI 签名重试
    try:
        signed_params = _sign_wbi(params)
        resp2 = requests.get(
            "https://api.bilibili.com/x/space/wbi/arc/search",
            params=signed_params,
            headers=_make_headers(mobile=False),
            timeout=TIMEOUT,
        )
        data2 = resp2.json()
        if data2.get("code") == 0:
            return data2.get("data", {}).get("list", {}).get("vlist", [])
        print(f"  [B站API] WBI签名请求也失败: {data2.get('message')} (code={data2.get('code')})")
    except Exception as e2:
        print(f"  [B站API] WBI签名异常: {e2}")

    # 3. Vercel 中继兜底
    proxy = get_bili_proxy_url()
    if proxy:
        try:
            print("  [B站API] 切换中继获取UP主视频列表...")
            resp3 = requests.get(
                f"{proxy}/api/bili-up",
                params={"mid": mid, "pn": page, "ps": min(page_size, 50)},
                timeout=20,
            )
            data3 = resp3.json()
            if data3.get("code") == 0:
                return data3.get("data", {}).get("list", {}).get("vlist", [])
            print(f"  [B站中继] 获取UP列表失败: {data3.get('message')} (code={data3.get('code')})")
        except Exception as e3:
            print(f"  [B站中继] 获取UP列表异常: {e3}")

    return None


def _video_id_params(vid: str) -> dict:
    """兼容 BV 号与 av 号 (如 av117258412104418 → {'aid': '117258412104418'})"""
    s = (vid or "").strip()
    if s.lower().startswith("av") and s[2:].isdigit():
        return {"aid": s[2:]}
    return {"bvid": s}


def explain_bili_code(code, message: str = "") -> str:
    """将常见 B 站错误码转换为人类可读的排查提示"""
    mapping = {
        -400: "请求参数无效（请检查 BV/av 号格式是否正确）",
        -404: "视频不存在、已被 UP 主删除或下架",
        -412: "出口 IP 触发 B 站风控拦截 (-412)，需要通过中继或更换 IP 重试",
        -352: "触发 B 站安全校验 (-352)，需补充 WBI/buvid3 或 Cookie",
        62002: "稿件不可见（可能为私密/审核中/仅粉丝可见）",
        62004: "稿件审核中，暂无法访问",
        -10403: "视频存在地区/版权限制，当前节点无法访问",
    }
    if code in mapping:
        return mapping[code]
    return f"B站接口返回 code={code} ({message or '未知错误'})"


def get_video_info(bvid: str) -> Optional[dict]:
    """
    获取视频详细信息 (兼容 BV 号与 av 号; 直连 wbi/view → 直连 view → Vercel中继兜底)
    """
    id_params = _video_id_params(bvid)

    # 1. 直连 x/web-interface/wbi/view (带真实 WBI + buvid3)
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/web-interface/wbi/view",
            params=_sign_wbi(dict(id_params)),
            headers=_make_headers(mobile=False),
            timeout=TIMEOUT,
        )
        data = resp.json()
        if data.get("code") == 0 and data.get("data"):
            return data.get("data")
        err_msg = explain_bili_code(data.get("code"), data.get("message", ""))
    except Exception as e:
        err_msg = str(e)

    # 2. 直连 x/web-interface/view (移动端UA)
    try:
        resp2 = requests.get(
            "https://api.bilibili.com/x/web-interface/view",
            params=dict(id_params),
            headers=_make_headers(mobile=True),
            timeout=TIMEOUT,
        )
        data2 = resp2.json()
        if data2.get("code") == 0 and data2.get("data"):
            return data2.get("data")
        err_msg = explain_bili_code(data2.get("code"), data2.get("message", ""))
    except Exception as e2:
        err_msg = str(e2)

    print(f"  [B站API] 直连获取视频{bvid}信息失败: {err_msg}，尝试中继...")

    # 3. Vercel 中继兜底 (仅 BV 号走中继，av 号若直连失败通常为视频不存在)
    if "bvid" in id_params:
        bundle = fetch_video_bundle_from_proxy(bvid)
        if bundle and bundle.get("info"):
            print(f"  [B站中继] ✅ 获取视频{bvid}信息成功")
            return bundle["info"]

    print(f"  [B站API] ❌ 获取视频{bvid}信息彻底失败: {err_msg}")
    return None


def get_up_info(mid: int) -> Optional[dict]:
    """
    获取UP主基本信息
    API: https://api.bilibili.com/x/web-interface/card
    """
    params = {"mid": mid}
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/web-interface/card",
            params=params,
            headers=_make_headers(mobile=True),
            timeout=TIMEOUT,
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
