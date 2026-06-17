"""
音频转文字模块
=============
当B站视频需要转录时，下载音频并转为文字。

方案:
  1. yt-dlp (优先，GHA可用，B站原生支持)
  2. playurl API + CDN直链 (备选，国内环境更快)
  3. 硅基流动 SenseVoiceSmall → 语音转文字
"""

import os
import requests
import subprocess
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

# ==================== yt-dlp 方案 (优先) ====================

def download_with_ytdlp(bvid: str, output_dir: str) -> Optional[str]:
    """
    使用 yt-dlp 下载B站视频音频 (mp3格式)
    返回: 音频文件路径, 或 None
    
    GHA 美国节点: yt-dlp 可直接访问B站，比 CDN 直链更稳定
    """
    url = f"https://www.bilibili.com/video/{bvid}"
    output_tpl = os.path.join(output_dir, f"{bvid}.%(ext)s")

    cmd = [
        "yt-dlp",
        "-x",  # 只下载音频
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "-o", output_tpl,
        "--quiet",
        "--no-warnings",
        "--geo-bypass",
        "--socket-timeout", "30",
        url,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            print(f"    [yt-dlp] 失败: {result.stderr[:300]}")
            return None

        # 找到下载的音频文件
        for f in os.listdir(output_dir):
            path = os.path.join(output_dir, f)
            if os.path.isfile(path) and os.path.getsize(path) > 1000:
                print(f"    [yt-dlp] 下载完成: {path} ({os.path.getsize(path)/1024/1024:.1f} MB)")
                return path

        print(f"    [yt-dlp] 未找到音频文件")
        return None
    except subprocess.TimeoutExpired:
        print(f"    [yt-dlp] 超时 (300秒)")
        return None
    except FileNotFoundError:
        print(f"    [yt-dlp] 未安装")
        return None
    except Exception as e:
        print(f"    [yt-dlp] 异常: {e}")
        return None


# ==================== playurl CDN 方案 (备选) ====================

def get_audio_urls_from_playurl(bvid: str, cid: int) -> Optional[list]:
    """从B站 playurl API 获取音频直链"""
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/player/playurl",
            params={"bvid": bvid, "cid": cid, "fnval": 16, "qn": 16, "fourk": 1},
            headers=_get_play_headers(),
            timeout=15,
        )
        data = resp.json()
        if data.get("code") != 0:
            return None

        dash = data.get("data", {}).get("dash")
        if not dash or not dash.get("audio"):
            return None

        best = dash["audio"][-1]
        urls = []
        if best.get("baseUrl"):
            urls.append(best["baseUrl"])
        for bk in best.get("backupUrl") or []:
            if bk:
                urls.append(bk)
        return urls if urls else None
    except Exception:
        return None


def download_from_cdn(audio_url: str, output_path: str, timeout: int = 60) -> bool:
    """从B站CDN下载音频"""
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
    }
    try:
        resp = requests.get(audio_url, headers=headers, timeout=timeout, stream=True)
        if resp.status_code not in (200, 206):
            return False

        total = 0
        with open(output_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    total += len(chunk)
        return total > 1000
    except Exception:
        return False


def convert_to_wav(input_path: str, output_path: str) -> bool:
    """ffmpeg 将音频转为 16kHz mono WAV"""
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", input_path, "-ac", "1", "-ar", "16000", "-f", "wav", "-loglevel", "error", output_path],
            capture_output=True,
            check=True,
            timeout=60,
        )
        return os.path.exists(output_path) and os.path.getsize(output_path) > 100
    except Exception:
        return False


# ==================== 硅基流动 语音识别 ====================

def transcribe_with_siliconflow(audio_path: str, api_key: str = "", model: str = "") -> Optional[str]:
    if not api_key:
        return None

    model = model or "FunAudioLLM/SenseVoiceSmall"
    file_size = os.path.getsize(audio_path) / 1024 / 1024
    print(f"    [SiFlow] 上传音频 ({file_size:.1f} MB)...")

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
    一站式: B站音频下载 -> 智能转写 -> 返回文本

    下载策略 (GHA环境):
      优先 yt-dlp (绕过CDN地域限制)
      备选 playurl CDN (国内环境)
    """

    with tempfile.TemporaryDirectory() as tmpdir:
        wav_audio = os.path.join(tmpdir, f"{bvid}.wav")

        # ---- 策略1: yt-dlp (优先) ----
        print(f"    [音频] 策略1: yt-dlp 下载...")
        audio_file = download_with_ytdlp(bvid, tmpdir)

        if audio_file:
            # 转为 WAV 16kHz mono
            if convert_to_wav(audio_file, wav_audio):
                print(f"    [音频] 转换 WAV 完成")
                # 转录
                if siliconflow_api_key:
                    return transcribe_with_siliconflow(wav_audio, api_key=siliconflow_api_key, model=siliconflow_stt_model)
                return None

        # ---- 策略2: playurl + CDN (备选, 国内环境更快) ----
        print(f"    [音频] 策略2: playurl CDN 下载...")
        cid = get_cid(bvid)
        if cid:
            all_urls = get_audio_urls_from_playurl(bvid, cid)
            if all_urls:
                raw_audio = os.path.join(tmpdir, f"{bvid}.m4s")
                for idx, url in enumerate(all_urls):
                    print(f"    [音频] CDN #{idx+1}/{len(all_urls)}...")
                    if download_from_cdn(url, raw_audio):
                        if convert_to_wav(raw_audio, wav_audio):
                            if siliconflow_api_key:
                                return transcribe_with_siliconflow(wav_audio, api_key=siliconflow_api_key, model=siliconflow_stt_model)
                        break

    print(f"    [音频] 所有方案均失败")
    return None
