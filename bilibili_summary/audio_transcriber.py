"""
音频转文字模块
=============
当B站视频需要转录时，下载音频并转为文字。

方案:
  1. 获取 cid + 音频直链 (直连 WBI playurl → 直连 playurl → Vercel 中继兜底)
  2. 优先选取低码率清晰 AAC 音轨 (如 64kbps，体积小 2.5 倍、下载/上传更快更稳)
  3. CDN 直链下载 .m4s，直接改名 .m4a (AAC容器，无需ffmpeg)
  4. 硅基流动语音识别 (SenseVoiceSmall 重试3次 → 兜底 Qwen/Qwen3-ASR-1.7B)
"""

import os
import re
import time
import requests
import tempfile
from typing import Optional

from bili_api import (
    _make_headers,
    _sign_wbi,
    fetch_video_bundle_from_proxy,
    get_bili_proxy_url,
)

# 仅保留 100% 免费模型，杜绝意外扣费
FREE_SILICONFLOW_STT_MODEL = "FunAudioLLM/SenseVoiceSmall"
GROQ_FREE_STT_MODEL = "whisper-large-v3-turbo"
GROQ_MAX_BYTES = 24 * 1024 * 1024  # Groq 免费层单文件上限 25MB，留 1MB 安全余量


def _extract_sorted_audio_urls(dash: dict) -> list:
    """从 DASH 信息提取音频直链，按码率升序排列 (优先最小清晰音轨，适合 STT)"""
    audios = (dash or {}).get("audio") or []
    if not audios:
        return []
    sorted_tracks = sorted(audios, key=lambda x: x.get("bandwidth") or 0)
    urls = []
    for tr in sorted_tracks:
        if tr.get("baseUrl"):
            urls.append(tr["baseUrl"])
        for bk in tr.get("backupUrl") or []:
            if bk:
                urls.append(bk)
    return urls


def get_cid(bvid: str) -> Optional[int]:
    """获取视频第一P的 cid (直连 → pagelist → 中继兜底)"""
    # 先看中继缓存里是否已有
    bundle = fetch_video_bundle_from_proxy(bvid) if _has_proxy_cache(bvid) else None
    if bundle and bundle.get("cid"):
        return bundle["cid"]

    # 1. 直连 x/web-interface/wbi/view
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/web-interface/wbi/view",
            params=_sign_wbi({"bvid": bvid}),
            headers=_make_headers(mobile=False),
            timeout=15,
        )
        data = resp.json()
        if data.get("code") == 0:
            d = data.get("data") or {}
            cid = d.get("cid") or (d.get("pages") or [{}])[0].get("cid")
            if cid:
                return cid
    except Exception:
        pass

    # 2. 直连 x/player/pagelist
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/player/pagelist",
            params={"bvid": bvid},
            headers=_make_headers(mobile=True),
            timeout=15,
        )
        data = resp.json()
        if data.get("code") == 0 and data.get("data"):
            return data["data"][0].get("cid")
    except Exception:
        pass

    # 3. 中继兜底
    bundle = fetch_video_bundle_from_proxy(bvid)
    if bundle and bundle.get("cid"):
        return bundle["cid"]

    return None


def _has_proxy_cache(bvid: str) -> bool:
    import bili_api
    return bvid in bili_api._proxy_info_cache


# ==================== playurl CDN 方案 ====================

def get_audio_urls_from_playurl(bvid: str, cid: Optional[int] = None, force_refresh: bool = False) -> Optional[list]:
    """获取所有可用音频直链 (优先复用中继缓存，其次直连 wbi/playurl & playurl，再回退中继)"""
    # 如果之前 get_video_info 已经走了中继，直接复用拿到的 audio_urls（免二次请求）
    if not force_refresh and _has_proxy_cache(bvid):
        bundle = fetch_video_bundle_from_proxy(bvid)
        if bundle and bundle.get("audio_urls"):
            urls = bundle["audio_urls"]
            print(f"    [playurl] 复用中继缓存的 {len(urls)} 条音频直链")
            return urls

    if not cid:
        cid = get_cid(bvid)

    # 1. 直连 WBI playurl / 普通 playurl
    if cid:
        for endpoint, use_wbi in [
            ("https://api.bilibili.com/x/player/wbi/playurl", True),
            ("https://api.bilibili.com/x/player/playurl", False),
        ]:
            try:
                params = {"bvid": bvid, "cid": cid, "fnval": 16, "qn": 16, "fourk": 1}
                if use_wbi:
                    params = _sign_wbi(params)
                resp = requests.get(
                    endpoint,
                    params=params,
                    headers=_make_headers(mobile=False),
                    timeout=15,
                )
                data = resp.json()
                if data.get("code") == 0:
                    urls = _extract_sorted_audio_urls(data.get("data", {}).get("dash"))
                    if urls:
                        print(f"    [playurl] 直连获取到 {len(urls)} 条音频直链")
                        return urls
                else:
                    print(f"    [playurl] 直连错误: code={data.get('code')} msg={data.get('message')}")
            except Exception as e:
                print(f"    [playurl] 直连异常: {e}")

    # 2. Vercel 中继兜底
    print(f"    [playurl] 切换中继获取音频直链...")
    bundle = fetch_video_bundle_from_proxy(bvid, force_refresh=force_refresh)
    if bundle and bundle.get("audio_urls"):
        urls = bundle["audio_urls"]
        print(f"    [playurl] ✅ 中继获取到 {len(urls)} 条音频直链")
        return urls

    return None


def download_from_cdn(audio_url: str, output_path: str, timeout: int = 60) -> bool:
    """从B站CDN下载音频 (m4s/AAC)，timeout=60秒"""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        ),
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
    }
    try:
        resp = requests.get(audio_url, headers=headers, timeout=timeout, stream=True)
        if resp.status_code not in (200, 206):
            print(f"    [CDN] HTTP {resp.status_code}")
            return False

        cl = resp.headers.get("Content-Length")
        if cl:
            print(f"    [CDN] 文件大小: {int(cl)/1024/1024:.1f} MB")

        total = 0
        with open(output_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=16384):
                if chunk:
                    f.write(chunk)
                    total += len(chunk)
        print(f"    [CDN] 下载完成 ({total/1024/1024:.1f} MB)")
        return total > 1000
    except requests.exceptions.Timeout:
        print(f"    [CDN] 超时 ({timeout}秒)")
        return False
    except Exception as e:
        print(f"    [CDN] 异常: {e}")
        return False


def download_via_proxy(audio_url: str, output_path: str, chunk_size: int = 3 * 1024 * 1024) -> bool:
    """
    通过 Vercel 中继按 HTTP Range 分片下载音频 (每片 <= 3MB，绕过 4.5MB 响应体限制与 GHA CDN 567/403 封禁)
    """
    proxy = get_bili_proxy_url()
    if not proxy:
        return False

    endpoint = f"{proxy}/api/bili-audio"
    start = 0
    total_size = None
    written = 0

    try:
        with open(output_path, "wb") as f:
            while True:
                end = start + chunk_size - 1
                if total_size is not None:
                    end = min(end, total_size - 1)
                    if start > end:
                        break

                resp = None
                for attempt in range(1, 3):
                    try:
                        r = requests.get(
                            endpoint,
                            params={"url": audio_url, "range": f"bytes={start}-{end}"},
                            timeout=30,
                        )
                        if r.status_code in (200, 206):
                            resp = r
                            break
                        print(f"    [中继CDN] 分片 {start}-{end} HTTP {r.status_code} (attempt {attempt})")
                        if r.status_code in (403, 404, 410):
                            return False
                    except Exception as e:
                        print(f"    [中继CDN] 分片 {start}-{end} 异常 (attempt {attempt}): {e}")
                    time.sleep(1)

                if resp is None:
                    return False

                chunk = resp.content
                if not chunk:
                    break

                f.write(chunk)
                written += len(chunk)

                # 从 Content-Range: bytes 0-3145727/5550813 解析总大小
                cr = resp.headers.get("Content-Range", "")
                m = re.search(r"/(\d+)$", cr)
                if m:
                    total_size = int(m.group(1))
                    if start == 0:
                        print(f"    [中继CDN] 文件大小: {total_size/1024/1024:.1f} MB")
                elif resp.status_code == 200:
                    # 一次性返回了完整文件
                    break

                start += len(chunk)
                if total_size is not None and start >= total_size:
                    break
                if len(chunk) < chunk_size and total_size is None:
                    break

        print(f"    [中继CDN] ✅ 下载完成 ({written/1024/1024:.1f} MB)")
        return written > 1000
    except Exception as e:
        print(f"    [中继CDN] 异常: {e}")
        return False


# ==================== 硅基流动 语音识别 ====================

def _call_siliconflow_stt_once(audio_path: str, api_key: str, model: str, timeout: int = 180) -> tuple:
    """单次调用硅基流动音频转录 REST 接口，返回 (text_or_None, retryable_bool)"""
    url = "https://api.siliconflow.cn/v1/audio/transcriptions"
    filename = os.path.basename(audio_path)
    try:
        with open(audio_path, "rb") as f:
            resp = requests.post(
                url,
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": (filename, f, "audio/mp4")},
                data={"model": model},
                timeout=timeout,
            )
        if resp.status_code == 200:
            try:
                j = resp.json()
                text = j.get("text", "") if isinstance(j, dict) else str(j)
            except Exception:
                text = resp.text
            if text and text.strip():
                return text.strip(), False
            print(f"    [SiFlow] ({model}) 返回文本为空")
            return None, True

        preview = resp.text[:200].replace("\n", " ")
        print(f"    [SiFlow] ({model}) HTTP {resp.status_code}: {preview}")
        # 401/403 为鉴权失败，无需同 key 反复重试
        retryable = resp.status_code in (429, 500, 502, 503, 504)
        return None, retryable
    except requests.exceptions.Timeout:
        print(f"    [SiFlow] ({model}) 请求超时 ({timeout}s)")
        return None, True
    except Exception as e:
        print(f"    [SiFlow] ({model}) 异常: {e}")
        return None, True


def transcribe_with_groq(audio_path: str, api_key: str = "", model: str = "") -> Optional[str]:
    """
    可选免费方案: Groq Cloud Whisper (免费层: 2000次/天, 8小时音频/天, 单文件<=25MB)
    只需在 GitHub Secrets 配置 GROQ_API_KEY 即可自动启用，完全免费。
    """
    if not api_key:
        return None
    size_bytes = os.path.getsize(audio_path)
    if size_bytes > GROQ_MAX_BYTES:
        print(f"    [Groq] 文件 {size_bytes/1024/1024:.1f} MB 超过 24MB 限制，跳过转用硅基流动")
        return None

    model = (model or GROQ_FREE_STT_MODEL).strip()
    url = "https://api.groq.com/openai/v1/audio/transcriptions"
    filename = os.path.basename(audio_path)
    print(f"    [Groq] 尝试免费 {model} ({size_bytes/1024/1024:.1f} MB)...")
    for attempt in range(1, 3):
        try:
            with open(audio_path, "rb") as f:
                resp = requests.post(
                    url,
                    headers={"Authorization": f"Bearer {api_key}"},
                    files={"file": (filename, f, "audio/mp4")},
                    data={"model": model, "language": "zh", "response_format": "json"},
                    timeout=180,
                )
            if resp.status_code == 200:
                text = (resp.json().get("text") or "").strip()
                if text:
                    print(f"    [Groq] ✅ 转录成功 ({model}, {len(text)} 字符)")
                    return text
            else:
                print(f"    [Groq] HTTP {resp.status_code}: {resp.text[:160]}")
                if resp.status_code in (401, 403):
                    return None
        except Exception as e:
            print(f"    [Groq] 异常 (attempt {attempt}): {e}")
        if attempt < 2:
            time.sleep(2)
    return None


def transcribe_with_siliconflow(audio_path: str, api_key: str = "", model: str = "") -> Optional[str]:
    if not api_key:
        print("    [SiFlow] 未配置 API_KEY")
        return None

    current_model = (model or FREE_SILICONFLOW_STT_MODEL).strip()
    file_size = os.path.getsize(audio_path) / 1024 / 1024
    print(f"    [SiFlow] 上传至免费模型 {current_model} ({file_size:.1f} MB)...")

    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        if attempt > 1:
            print(f"    [SiFlow] 第 {attempt}/{max_attempts} 次尝试 ({current_model})...")
        text, retryable = _call_siliconflow_stt_once(audio_path, api_key, current_model)
        if text:
            print(f"    [SiFlow] ✅ 转录成功 ({current_model}, {len(text)} 字符)")
            return text
        if not retryable:
            break
        if attempt < max_attempts:
            wait_s = 2 ** attempt
            print(f"    [SiFlow] {wait_s}s 后重试...")
            time.sleep(wait_s)

    print("    [SiFlow] ❌ 语音识别失败")
    return None


# ==================== 一站式入口 ====================

def get_text_from_audio(
    bvid: str,
    siliconflow_api_key: str = "",
    siliconflow_stt_model: str = "",
) -> Optional[str]:
    """
    一站式: B站音频下载 → 直接上传硅基流动语音识别
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        m4s_path = os.path.join(tmpdir, f"{bvid}.m4s")
        m4a_path = os.path.join(tmpdir, f"{bvid}.m4a")

        print("    [音频] 获取视频音频直链...")
        all_urls = get_audio_urls_from_playurl(bvid)
        if not all_urls:
            print("    [音频] ❌ 无法获取音频直链")
            return None

        download_ok = False
        # 1. 先尝试直连 CDN (最多试前 2 条，避免 GHA 封禁时浪费时间)
        for idx, url in enumerate(all_urls[:2]):
            print(f"    [CDN] 直连 #{idx+1}/{min(len(all_urls), 2)} (60s)...")
            if download_from_cdn(url, m4s_path, timeout=60):
                download_ok = True
                break

        # 2. 直连被拒 (如 GHA 返回 567/403) 时，自动通过中继获取同源直链并分片下载
        if not download_ok and get_bili_proxy_url():
            print("    [CDN] 直连失败，切换中继分片下载...")
            bundle = fetch_video_bundle_from_proxy(bvid, force_refresh=True)
            proxy_urls = (bundle or {}).get("audio_urls") or all_urls
            for idx, url in enumerate(proxy_urls[:3]):
                print(f"    [中继CDN] #{idx+1}/{min(len(proxy_urls), 3)}...")
                if download_via_proxy(url, m4s_path):
                    download_ok = True
                    break

        # 3. 兜底再试剩余直连 URL
        if not download_ok and len(all_urls) > 2:
            for idx, url in enumerate(all_urls[2:], start=3):
                print(f"    [CDN] 备选直连 #{idx}/{len(all_urls)} (60s)...")
                if download_from_cdn(url, m4s_path, timeout=60):
                    download_ok = True
                    break

        if not download_ok:
            print("    [音频] ❌ 下载失败")
            return None

        # .m4s = AAC/M4A 容器，直接改名即可
        os.rename(m4s_path, m4a_path)

        # 如果配置了免费的 GROQ_API_KEY，优先尝试高精度免费的 Groq Whisper (<=24MB)，失败回退免费硅基流动 SenseVoiceSmall
        groq_key = os.environ.get("GROQ_API_KEY", "").strip()
        if groq_key:
            groq_text = transcribe_with_groq(m4a_path, api_key=groq_key)
            if groq_text:
                return groq_text

        if siliconflow_api_key:
            return transcribe_with_siliconflow(
                m4a_path, api_key=siliconflow_api_key, model=siliconflow_stt_model,
            )
        return None
