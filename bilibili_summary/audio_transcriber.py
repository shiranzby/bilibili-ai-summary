"""
音频转文字模块
=============
当B站视频需要转录时，下载音频并转为文字。

方案:
  1. playurl API → CDN直链下载 .m4s
  2. 直接改名 .m4s → .m4a (AAC容器，无需ffmpeg)
  3. 硅基流动 SenseVoiceSmall → 语音转文字
"""

import os
import requests
import tempfile
from typing import Optional


def _get_play_headers() -> dict:
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.bilibili.com/",
    }


def get_cid(bvid: str) -> Optional[int]:
    """获取视频第一P的cid"""
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/web-interface/view",
            params={"bvid": bvid},
            headers={"User-Agent": "Mozilla/5.0", "Referer": "https://m.bilibili.com/"},
            timeout=15,
        )
        data = resp.json()
        if data.get("code") != 0:
            return None
        pages = data.get("data", {}).get("pages", [])
        return pages[0].get("cid") if pages else None
    except Exception:
        return None


# ==================== playurl CDN 方案 (优先) ====================

def get_audio_urls_from_playurl(bvid: str, cid: int) -> Optional[list]:
    """从B站 playurl API 获取所有可用音频直链"""
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/player/playurl",
            params={"bvid": bvid, "cid": cid, "fnval": 16, "qn": 16, "fourk": 1},
            headers=_get_play_headers(),
            timeout=15,
        )
        data = resp.json()
        if data.get("code") != 0:
            print(f"    [playurl] API错误: code={data.get('code')} msg={data.get('message')}")
            return None

        dash = data.get("data", {}).get("dash")
        if not dash or not dash.get("audio"):
            print(f"    [playurl] 未找到音频流")
            return None

        best = dash["audio"][0]
        urls = []
        if best.get("baseUrl"):
            urls.append(best["baseUrl"])
        for bk in best.get("backupUrl") or []:
            if bk:
                urls.append(bk)

        if urls:
            print(f"    [playurl] 获取到 {len(urls)} 条音频直链")
            return urls
        return None
    except Exception as e:
        print(f"    [playurl] 异常: {e}")
        return None


def download_from_cdn(audio_url: str, output_path: str, timeout: int = 60) -> bool:
    """从B站CDN下载音频 (m4s/AAC)，timeout=60秒"""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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
            for chunk in resp.iter_content(chunk_size=8192):
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


# ==================== 硅基流动 语音识别 ====================

def transcribe_with_siliconflow(audio_path: str, api_key: str = "", model: str = "") -> Optional[str]:
    if not api_key:
        print(f"    [SiFlow] 未配置 API_KEY")
        return None
    model = model or "FunAudioLLM/SenseVoiceSmall"
    file_size = os.path.getsize(audio_path) / 1024 / 1024
    print(f"    [SiFlow] 上传 ({file_size:.1f} MB)...")
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url="https://api.siliconflow.cn/v1")
        with open(audio_path, "rb") as f:
            resp = client.audio.transcriptions.create(
                model=model, file=f, language="zh", response_format="text",
            )
        text = resp if isinstance(resp, str) else getattr(resp, "text", str(resp))
        if text and text.strip():
            print(f"    [SiFlow] 转录成功 ({len(text)} 字符)")
            return text
        print(f"    [SiFlow] 返回文本为空")
        return None
    except Exception as e:
        print(f"    [SiFlow] 失败: {e}")
        return None


# ==================== 一站式入口 ====================

def get_text_from_audio(
    bvid: str,
    siliconflow_api_key: str = "",
    siliconflow_stt_model: str = "",
) -> Optional[str]:
    """
    一站式: B站音频下载 → 直接上传硅基流动语音识别

    流程:
      1. playurl API 获取音频 CDN 直链
      2. 下载 .m4s (AAC容器，直接改名 .m4a)
      3. 上传到硅基流动语音识别 API

    > 不需要 ffmpeg: .m4s 本身就是 AAC 音频，改后缀即可
    > 不需要 yt-dlp: playurl CDN 方案已验证每次都能成功
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        m4s_path = os.path.join(tmpdir, f"{bvid}.m4s")
        m4a_path = os.path.join(tmpdir, f"{bvid}.m4a")

        # ---- playurl CDN ----
        print(f"    [音频] 获取视频信息...")
        cid = get_cid(bvid)
        if not cid:
            print(f"    [音频] ❌ 无法获取 cid")
            return None

        all_urls = get_audio_urls_from_playurl(bvid, cid)
        if not all_urls:
            print(f"    [音频] ❌ 无法获取音频直链")
            return None

        download_ok = False
        for idx, url in enumerate(all_urls):
            print(f"    [CDN] #{idx+1}/{len(all_urls)} (60s)...")
            if download_from_cdn(url, m4s_path, timeout=60):
                download_ok = True
                break

        if not download_ok:
            print(f"    [CDN] 全部直链下载失败, 重试一次...")
            import time; time.sleep(1)
            new_urls = get_audio_urls_from_playurl(bvid, cid)
            if new_urls:
                for idx, url in enumerate(new_urls):
                    if download_from_cdn(url, m4s_path, timeout=60):
                        download_ok = True
                        break

        if not download_ok:
            print(f"    [音频] ❌ 下载失败")
            return None

        # .m4s = AAC/M4A 容器，直接改名即可
        os.rename(m4s_path, m4a_path)

        if siliconflow_api_key:
            return transcribe_with_siliconflow(
                m4a_path, api_key=siliconflow_api_key, model=siliconflow_stt_model,
            )
        return None

