"""
音频转文字模块
=============
当B站视频没有AI字幕时，下载音频并转录为文字。

方案:
  1. playurl API → 获取音频CDN直链 → FFmpeg转WAV
  2. 智谱AI GLM-4-Audio → 语音转文字 (国内直连，GHA可用)
  3. yt-dlp (备选，GHA可能被412拦截)
"""

import os
import requests
import subprocess
import tempfile
from typing import Optional


def _get_play_headers() -> dict:
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.bilibili.com/",
    }


def get_audio_url_from_playurl(bvid: str, cid: int) -> Optional[str]:
    """从B站 playurl API 获取音频直链 (无需Cookie)"""
    try:
        resp = requests.get(
            "https://api.bilibili.com/x/player/playurl",
            params={"bvid": bvid, "cid": cid, "fnval": 16, "qn": 16, "fourk": 1},
            headers=_get_play_headers(), timeout=15,
        )
        data = resp.json()
        if data.get("code") != 0:
            print(f"    [playurl] API错误: code={data.get('code')} msg={data.get('message')}")
            return None
        dash = data.get("data", {}).get("dash")
        if not dash or not dash.get("audio"):
            print(f"    [playurl] 未找到音频流")
            return None
        best = dash["audio"][-1]
        url = best.get("baseUrl", "") or (best.get("backupUrl") or [None])[0]
        if url:
            print(f"    [playurl] ✅ 获取音频直链 (codec={best.get('codecs','?')[:20]})")
            return url
        return None
    except Exception as e:
        print(f"    [playurl] ❌ 异常: {e}")
        return None


def get_cid(bvid: str) -> Optional[int]:
    """获取视频第一P的cid"""
    try:
        resp = requests.get("https://api.bilibili.com/x/web-interface/view",
            params={"bvid": bvid},
            headers={"User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36", "Referer": "https://m.bilibili.com/"},
            timeout=15)
        data = resp.json()
        if data.get("code") != 0: return None
        pages = data.get("data", {}).get("pages", [])
        return pages[0].get("cid") if pages else None
    except Exception: return None


def download_audio_from_url(audio_url: str, output_path: str, timeout: int = 180) -> bool:
    """从CDN直链下载音频文件 (m4s/AAC格式)"""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.bilibili.com/", "Origin": "https://www.bilibili.com",
    }
    try:
        print(f"    [下载] 正在下载音频...")
        resp = requests.get(audio_url, headers=headers, timeout=timeout, stream=True)
        if resp.status_code not in (200, 206):
            print(f"    [下载] ❌ HTTP {resp.status_code}")
            return False
        total = 0
        max_size = 10 * 1024 * 1024
        with open(output_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk: f.write(chunk); total += len(chunk)
                if total >= max_size: break
        print(f"    [下载] ✅ 完成 ({total/1024/1024:.1f} MB)")
        return total > 1000
    except Exception as e:
        print(f"    [下载] ❌ 失败: {e}")
        return False


def convert_to_wav(input_path: str, output_path: str) -> bool:
    """ffmpeg 将音频转为 16kHz mono WAV"""
    try:
        subprocess.run(["ffmpeg", "-y", "-i", input_path, "-ac", "1", "-ar", "16000", "-f", "wav", "-loglevel", "error", output_path],
            capture_output=True, check=True, timeout=60)
        return os.path.exists(output_path) and os.path.getsize(output_path) > 100
    except FileNotFoundError:
        print(f"    [ffmpeg] ❌ 未找到 ffmpeg")
        return False
    except Exception as e:
        print(f"    [ffmpeg] ❌ 转换失败: {e}")
        return False


def _get_audio_duration(audio_path: str) -> Optional[float]:
    """用ffprobe获取音频时长(秒)"""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", audio_path],
            capture_output=True, text=True, timeout=15)
        if result.returncode == 0 and result.stdout.strip():
            return float(result.stdout.strip())
        return None
    except Exception:
        return None


def transcribe_with_zhipu(audio_path: str, api_key: str = "") -> Optional[str]:
    """
    使用智谱AI GLM-4-Audio 语音转文字
    国内直连，GHA上正常可用，免费额度覆盖
    注: 智谱AI限制音频≤30秒，超长自动截断

    API: POST https://open.bigmodel.cn/api/paas/v4/audio/transcriptions
    """
    if not api_key:
        print("    [智谱AI] ❌ 未配置ZHIPU_API_KEY")
        return None

    # 检查音频时长，超30秒则截断
    duration = _get_audio_duration(audio_path)
    if duration and duration > 30:
        print(f"    [智谱AI] 音频 {duration:.0f}秒 >30秒限制，自动截取前30秒...")
        trimmed_path = audio_path + ".trimmed.wav"
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", audio_path, "-t", "30",
                 "-ac", "1", "-ar", "16000", "-f", "wav",
                 "-loglevel", "error", trimmed_path],
                capture_output=True, check=True, timeout=30)
            audio_path = trimmed_path
        except Exception as e:
            print(f"    [智谱AI] ⚠ 截断失败: {e}，仍尝试原文件")

    file_size = os.path.getsize(audio_path) / 1024 / 1024
    print(f"    [智谱AI] 上传音频 ({file_size:.1f} MB)...")

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url="https://open.bigmodel.cn/api/paas/v4/")

        with open(audio_path, "rb") as f:
            resp = client.audio.transcriptions.create(
                model="glm-4-audio",
                file=f,
                language="zh",
            )

        text = resp.text if hasattr(resp, 'text') else str(resp)
        if text and text.strip():
            print(f"    [智谱AI] ✅ 转录成功 ({len(text)} 字符)")
            return text
        print(f"    [智谱AI] ⚠ 返回文本为空")
        return None

    except ImportError:
        print(f"    [智谱AI] ❌ 缺少 openai 库")
        return None
    except Exception as e:
        print(f"    [智谱AI] ❌ 失败: {e}")
        return None


# ==================== 主入口 ====================

def transcribe_with_siliconflow(audio_path: str, api_key: str = "") -> Optional[str]:
    """
    使用硅基流动 SiliconFlow FunAudioLLM/SenseVoiceSmall 语音转文字
    国内直连，GHA正常可用，按量计费 (价格极低)

    API: POST https://api.siliconflow.cn/v1/audio/transcriptions
    """
    if not api_key:
        print("    [SiFlow] ❌ 未配置 SILICONFLOW_API_KEY")
        return None

    file_size = os.path.getsize(audio_path) / 1024 / 1024
    print(f"    [SiFlow] 上传音频 ({file_size:.1f} MB)...")

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url="https://api.siliconflow.cn/v1")

        with open(audio_path, "rb") as f:
            resp = client.audio.transcriptions.create(
                model="FunAudioLLM/SenseVoiceSmall",
                file=f,
                language="zh",
                response_format="text",
            )

        text = resp if isinstance(resp, str) else getattr(resp, 'text', str(resp))
        if text and text.strip():
            print(f"    [SiFlow] ✅ 转录成功 ({len(text)} 字符)")
            return text
        print(f"    [SiFlow] ⚠ 返回文本为空")
        return None

    except Exception as e:
        print(f"    [SiFlow] ❌ 失败: {e}")
        return None


def get_text_from_audio(
    bvid: str,
    hf_token: str = "",
    model: str = "",
    zhipu_api_key: str = "",
    siliconflow_api_key: str = "",
) -> Optional[str]:
    """
    一站式: B站音频下载 → 智能转写 → 返回文本

    转录方案: 硅基流动 SenseVoiceSmall (稳定可靠)

    参数:
        bvid: BV号
        siliconflow_api_key: 硅基流动 API Key

    返回: 转录文本或 None
    """

    # 先下载音频
    print(f"    [音频] 使用 playurl API 获取音频...")
    cid = get_cid(bvid)
    if not cid:
        print(f"    [音频] 无法获取 cid")
        return _fallback_ytdlp(bvid, hf_token, model)

    audio_url = get_audio_url_from_playurl(bvid, cid)
    if not audio_url:
        print(f"    [音频] playurl 失败")
        return _fallback_ytdlp(bvid, hf_token, model)

    # 下载并转换
    with tempfile.TemporaryDirectory() as tmpdir:
        raw_audio = os.path.join(tmpdir, f"{bvid}.m4s")
        wav_audio = os.path.join(tmpdir, f"{bvid}.wav")

        if not download_audio_from_url(audio_url, raw_audio):
            print(f"    [音频] CDN下载失败")
            return _fallback_ytdlp(bvid, hf_token, model)

        if not convert_to_wav(raw_audio, wav_audio):
            print(f"    [音频] ffmpeg转换失败")
            return None

        # 转录: 硅基流动 SenseVoiceSmall (稳定可靠)
        if siliconflow_api_key:
            text = transcribe_with_siliconflow(wav_audio, api_key=siliconflow_api_key)
            if text:
                return text
            print(f"    [音频] 硅基流动转录失败")
        else:
            print(f"    [音频] 未配置 SILICONFLOW_API_KEY，跳过转录")
        return None


def _transcribe_huggingface(audio_path: str, hf_token: str, model: str) -> Optional[str]:
    """HuggingFace Whisper 转录 (备选)"""
    print(f"    [Whisper] 正在上传 ({os.path.getsize(audio_path)/1024/1024:.1f} MB)...")
    with open(audio_path, "rb") as f:
        audio_data = f.read()

    endpoints = [
        f"https://api-inference.huggingface.co/models/{model}",
        f"https://router.huggingface.co/hf-inference/models/{model}",
    ]
    for i, api_url in enumerate(endpoints):
        label = "主端点" if i == 0 else "备选端点"
        try:
            resp = requests.post(api_url,
                headers={"Authorization": f"Bearer {hf_token}"},
                data=audio_data, timeout=300)
            if resp.status_code == 200:
                text = resp.json().get("text", "")
                if text:
                    print(f"    [Whisper] ✅ 转录成功 ({len(text)} 字符)")
                    return text
                return None
            elif resp.status_code == 403:
                if i < 1: continue
                return None
            else:
                if i < 1: continue
                return None
        except Exception as e:
            print(f"    [Whisper] ❌ {label}: {e}")
            if i < 1:
                print(f"    [Whisper]    尝试下一个...")
                continue
    return None


def _fallback_ytdlp(bvid: str, hf_token: str, model: str) -> Optional[str]:
    """yt-dlp 备选方案"""
    print(f"    [音频] 尝试 yt-dlp 下载...")
    url = f"https://www.bilibili.com/video/{bvid}"
    with tempfile.TemporaryDirectory() as tmpdir:
        output_tpl = os.path.join(tmpdir, f"{bvid}.%(ext)s")
        cmd = ["yt-dlp", "-x", "--audio-format", "mp3", "--audio-quality", "0",
               "-o", output_tpl, "--quiet", "--no-warnings", url]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if result.returncode != 0:
                print(f"    [yt-dlp] ❌ 失败: {result.stderr[:200]}")
                return None
            for f in os.listdir(tmpdir):
                path = os.path.join(tmpdir, f)
                if zhipu_api_key:
                    return transcribe_with_zhipu(path, api_key=zhipu_api_key)
                return _transcribe_huggingface(path, hf_token, model) if hf_token else None
            return None
        except FileNotFoundError:
            print(f"    [yt-dlp] ❌ 未安装")
            return None
        except Exception as e:
            print(f"    [yt-dlp] ❌ 异常: {e}")
            return None
