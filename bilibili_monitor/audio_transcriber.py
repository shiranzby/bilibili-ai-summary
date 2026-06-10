"""
音频转文字模块 (Whisper)
=======================
当B站视频没有AI字幕时，使用此模块下载视频音频并转录为文字。

优先级:
  1. playurl API (B站官方，无需Cookie) → 获取DASH音频直链
  2. yt-dlp (备选，GHA上可能被B站412拦截)

费用:
  Hugging Face Inference API 免费层可用 (有速率限制)
  GitHub Actions 上需安装 ffmpeg
"""

import os
import requests
import subprocess
import tempfile
from typing import Optional


def _get_play_headers() -> dict:
    """获取播放API请求头 (桌面端UA用于playurl接口)"""
    return {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": "https://www.bilibili.com/",
    }


def get_audio_url_from_playurl(bvid: str, cid: int) -> Optional[str]:
    """
    从B站 playurl API 获取音频直链 (无需Cookie)

    API: https://api.bilibili.com/x/player/playurl
    参数: fnval=16 返回 DASH 格式 (包含音视频分离的CDN直链)

    返回:
        音频CDN直链 (m4s/AAC格式)，或 None
    """
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
        if not dash:
            print(f"    [playurl] 未找到DASH数据")
            return None

        audios = dash.get("audio", [])
        if not audios:
            print(f"    [playurl] 未找到音频流")
            return None

        # 选择最佳音质 (最后一个通常音质最好)
        best = audios[-1]
        url = best.get("baseUrl", "")
        if url:
            print(f"    [playurl] ✅ 获取音频直链 (codec={best.get('codecs','?')[:20]})")
            return url

        # 回退到 backup URL
        backups = best.get("backupUrl", [])
        if backups:
            url = backups[0]
            print(f"    [playurl] ✅ 获取备用音频链接")
            return url

        print(f"    [playurl] 音频流无有效URL")
        return None

    except Exception as e:
        print(f"    [playurl] ❌ 异常: {e}")
        return None


def get_cid(bvid: str) -> Optional[int]:
    """获取视频第一P的cid (使用移动端UA避免风控)"""
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/web-interface/view",
            params={"bvid": bvid},
            headers={
                "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36",
                "Referer": "https://m.bilibili.com/",
            },
            timeout=15,
        )
        data = resp.json()
        if data.get("code") != 0:
            return None
        pages = data.get("data", {}).get("pages", [])
        return pages[0].get("cid") if pages else None
    except Exception:
        return None


def download_audio_from_url(
    audio_url: str,
    output_path: str,
    timeout: int = 180,
) -> bool:
    """
    从CDN直链下载音频文件 (m4s/AAC格式)

    返回:
        是否下载成功
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
        "Range": "bytes=0-10485760",  # 最大下载 10MB (约10分钟音频)
    }

    try:
        print(f"    [下载] 正在下载音频...")
        resp = requests.get(audio_url, headers=headers, timeout=timeout, stream=True)
        if resp.status_code not in (200, 206):
            print(f"    [下载] ❌ HTTP {resp.status_code}")
            return False

        total = 0
        max_size = 10 * 1024 * 1024  # 10MB 上限
        with open(output_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    total += len(chunk)
                    if total >= max_size:
                        break  # 刺客边风视频都很短，10MB足够

        file_size = total / 1024 / 1024
        print(f"    [下载] ✅ 完成 ({file_size:.1f} MB)")
        return total > 1000  # 至少1KB

    except requests.exceptions.Timeout:
        print(f"    [下载] ❌ 下载超时")
        return False
    except Exception as e:
        print(f"    [下载] ❌ 失败: {e}")
        return False


def convert_to_wav(input_path: str, output_path: str) -> bool:
    """
    用 ffmpeg 将音频转为 16kHz mono WAV (Whisper要求)

    返回:
        是否转换成功
    """
    try:
        cmd = [
            "ffmpeg",
            "-y",                # 覆盖输出
            "-i", input_path,    # 输入
            "-ac", "1",          # 单声道
            "-ar", "16000",      # 16kHz 采样率
            "-f", "wav",         # WAV 格式
            "-loglevel", "error",
            output_path,
        ]
        subprocess.run(cmd, capture_output=True, check=True, timeout=60)
        if os.path.exists(output_path) and os.path.getsize(output_path) > 100:
            return True
        return False
    except subprocess.TimeoutExpired:
        print(f"    [ffmpeg] 转换超时")
        return False
    except FileNotFoundError:
        print(f"    [ffmpeg] ❌ 未找到 ffmpeg，请先安装")
        return False
    except Exception as e:
        print(f"    [ffmpeg] ❌ 转换失败: {e}")
        return False


def transcribe_audio(
    audio_path: str,
    hf_token: str = "",
    model: str = "openai/whisper-large-v3",
) -> Optional[str]:
    """
    使用 Hugging Face 免费 Inference API 将音频转为文字

    参数:
        audio_path: 音频文件路径 (WAV, 16kHz mono)
        hf_token: Hugging Face API Token
        model: Whisper 模型名

    返回:
        转录文本或 None
    """
    if not hf_token:
        print("    [Whisper] ❌ 未配置 Hugging Face Token")
        return None

    api_url = f"https://api-inference.huggingface.co/models/{model}"

    file_size_mb = os.path.getsize(audio_path) / 1024 / 1024
    print(f"    [Whisper] 正在上传音频 ({file_size_mb:.1f} MB)...")

    try:
        with open(audio_path, "rb") as f:
            resp = requests.post(
                api_url,
                headers={"Authorization": f"Bearer {hf_token}"},
                data=f,
                timeout=300,
            )

        if resp.status_code == 200:
            result = resp.json()
            text = result.get("text", "")
            if text:
                print(f"    [Whisper] ✅ 转录成功 ({len(text)} 字符)")
                return text
            print(f"    [Whisper] ⚠ 返回文本为空")
            return None
        elif resp.status_code == 503:
            print(f"    [Whisper] ⏳ 模型加载中，请稍后重试")
            return None
        else:
            print(f"    [Whisper] ❌ HTTP {resp.status_code}: {resp.text[:200]}")
            return None

    except requests.exceptions.Timeout:
        print(f"    [Whisper] ❌ 上传超时")
        return None
    except Exception as e:
        print(f"    [Whisper] ❌ 失败: {e}")
        return None


# ==================== 主入口 ====================

def get_text_from_audio(
    bvid: str,
    hf_token: str = "",
    model: str = "openai/whisper-large-v3",
) -> Optional[str]:
    """
    一站式: B站音频下载 → Whisper转写 → 返回文本

    首选方案: playurl API 获取 CDN 音频直链
    备选方案: yt-dlp (可能被412拦截)

    返回:
        转录文本或 None
    """
    # 方案1: playurl API 获取音频直链
    print(f"    [音频] 尝试 playurl API 获取音频...")
    cid = get_cid(bvid)
    if not cid:
        print(f"    [音频] 无法获取 cid，回退到 yt-dlp")
        return _fallback_ytdlp(bvid, hf_token, model)

    audio_url = get_audio_url_from_playurl(bvid, cid)
    if not audio_url:
        print(f"    [音频] playurl 失败，回退到 yt-dlp")
        return _fallback_ytdlp(bvid, hf_token, model)

    # 下载 + 转换 + 转写
    with tempfile.TemporaryDirectory() as tmpdir:
        raw_audio = os.path.join(tmpdir, f"{bvid}.m4s")
        wav_audio = os.path.join(tmpdir, f"{bvid}.wav")

        # Step 1: 下载
        if not download_audio_from_url(audio_url, raw_audio):
            print(f"    [音频] CDN下载失败，回退到 yt-dlp")
            return _fallback_ytdlp(bvid, hf_token, model)

        # Step 2: 转WAV
        if not convert_to_wav(raw_audio, wav_audio):
            print(f"    [音频] ffmpeg转换失败")
            return None

        # Step 3: 转写
        text = transcribe_audio(wav_audio, hf_token=hf_token, model=model)
        return text


def _fallback_ytdlp(bvid: str, hf_token: str, model: str) -> Optional[str]:
    """yt-dlp 备选方案"""
    print(f"    [音频] 尝试 yt-dlp 下载...")
    url = f"https://www.bilibili.com/video/{bvid}"

    with tempfile.TemporaryDirectory() as tmpdir:
        output_tpl = os.path.join(tmpdir, f"{bvid}.%(ext)s")
        cmd = [
            "yt-dlp", "-x", "--audio-format", "mp3",
            "--audio-quality", "0", "-o", output_tpl,
            "--quiet", "--no-warnings", url,
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if result.returncode != 0:
                print(f"    [yt-dlp] ❌ 失败: {result.stderr[:200]}")
                return None

            mp3_path = os.path.join(tmpdir, f"{bvid}.mp3")
            if os.path.exists(mp3_path):
                return transcribe_audio(mp3_path, hf_token=hf_token, model=model)

            for f in os.listdir(tmpdir):
                return transcribe_audio(os.path.join(tmpdir, f), hf_token=hf_token, model=model)
            return None
        except FileNotFoundError:
            print(f"    [yt-dlp] ❌ 未安装")
            return None
        except Exception as e:
            print(f"    [yt-dlp] ❌ 异常: {e}")
            return None
