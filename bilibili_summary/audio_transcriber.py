"""
音频转文字模块
=============
当B站视频需要转录时，下载音频并转为文字。

方案:
  1. playurl API → 获取音频CDN直链 → FFmpeg转WAV
  2. 硅基流动 SenseVoiceSmall → 语音转文字
  3. yt-dlp (备选)
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


def get_audio_urls_from_playurl(bvid: str, cid: int) -> Optional[list]:
    """
    从B站 playurl API 获取所有可用音频直链 (baseUrl + backupUrl)

    返回: URL列表 (按优先级排序)，或 None
    """
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
        urls = []
        # 主链接
        if best.get("baseUrl"):
            urls.append(best["baseUrl"])
        # 备用链接
        for bk in (best.get("backupUrl") or []):
            if bk: urls.append(bk)

        if urls:
            print(f"    [playurl] ✅ 获取到 {len(urls)} 条音频直链")
            return urls
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
    """从CDN直链下载音频文件 (m4s/AAC格式)，由 timeout 参数控制最大耗时"""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.bilibili.com/", "Origin": "https://www.bilibili.com",
    }
    try:
        resp = requests.get(audio_url, headers=headers, timeout=timeout, stream=True)
        if resp.status_code not in (200, 206):
            print(f"    [下载] ❌ HTTP {resp.status_code}")
            return False

        content_len = resp.headers.get("Content-Length")
        if content_len:
            print(f"    [下载] 文件大小: {int(content_len)/1024/1024:.1f} MB")

        total = 0
        with open(output_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk: f.write(chunk); total += len(chunk)
        print(f"    [下载] ✅ 完成 ({total/1024/1024:.1f} MB)")
        return total > 1000
    except requests.exceptions.Timeout:
        print(f"    [下载] ❌ 超时 ({timeout}秒)")
        return False
    except Exception as e:
        print(f"    [下载] ❌ 异常: {e}")
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


# ==================== 主入口 ====================

def transcribe_with_siliconflow(audio_path: str, api_key: str = "", model: str = "") -> Optional[str]:
    """
    使用硅基流动 SiliconFlow 语音转文字
    国内直连，GHA正常可用，完全免费

    API: POST https://api.siliconflow.cn/v1/audio/transcriptions
    """
    if not api_key:
        print("    [SiFlow] ❌ 未配置 SILICONFLOW_API_KEY")
        return None

    model = model or "FunAudioLLM/SenseVoiceSmall"
    file_size = os.path.getsize(audio_path) / 1024 / 1024
    print(f"    [SiFlow] 上传音频 ({file_size:.1f} MB)...")

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url="https://api.siliconflow.cn/v1")

        with open(audio_path, "rb") as f:
            resp = client.audio.transcriptions.create(
                model=model,
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
    siliconflow_api_key: str = "",
    siliconflow_stt_model: str = "",
) -> Optional[str]:
    """
    一站式: B站音频下载 → 智能转写 → 返回文本

    转录方案: 硅基流动 SenseVoiceSmall (稳定可靠)

    参数:
        bvid: BV号
        siliconflow_api_key: 硅基流动 API Key
        siliconflow_stt_model: 语音转文字模型 (默认 FunAudioLLM/SenseVoiceSmall)

    返回: 转录文本或 None
    """

    # 获取所有可用音频直链 (baseUrl + backupUrl)
    print(f"    [音频] 使用 playurl API 获取音频...")
    cid = get_cid(bvid)
    if not cid:
        print(f"    [音频] 无法获取 cid")
        return _fallback_ytdlp(bvid, siliconflow_api_key, siliconflow_stt_model)

    all_urls = get_audio_urls_from_playurl(bvid, cid)
    if not all_urls:
        print(f"    [音频] playurl 失败")
        return _fallback_ytdlp(bvid, siliconflow_api_key, siliconflow_stt_model)

    # 下载并转换 (遍历所有链接 + 重试)
    with tempfile.TemporaryDirectory() as tmpdir:
        raw_audio = os.path.join(tmpdir, f"{bvid}.m4s")
        wav_audio = os.path.join(tmpdir, f"{bvid}.wav")

        download_ok = False
        # 先试所有已有链接
        for idx, url in enumerate(all_urls):
            print(f"    [音频] 尝试下载 #{idx+1}/{len(all_urls)}...")
            if download_audio_from_url(url, raw_audio):
                download_ok = True
                break

        # 如果都失败，重新获取新链接重试 (最多2轮)
        if not download_ok:
            for retry in range(1, 3):
                print(f"    [音频] 第{retry}轮重试 (获取新链接)...")
                import time; time.sleep(1)
                new_urls = get_audio_urls_from_playurl(bvid, cid)
                if not new_urls:
                    continue
                for idx, url in enumerate(new_urls):
                    print(f"    [音频] 重试 #{idx+1}/{len(new_urls)}...")
                    if download_audio_from_url(url, raw_audio):
                        download_ok = True
                        break
                if download_ok:
                    break

        if not download_ok:
            print(f"    [音频] CDN下载彻底失败，尝试 yt-dlp...")
            return _fallback_ytdlp(bvid, siliconflow_api_key, siliconflow_stt_model)

        if not convert_to_wav(raw_audio, wav_audio):
            print(f"    [音频] ffmpeg转换失败")
            return None

        # 转录: 硅基流动 SenseVoiceSmall (稳定可靠)
        if siliconflow_api_key:
            text = transcribe_with_siliconflow(wav_audio, api_key=siliconflow_api_key, model=siliconflow_stt_model)
            if text:
                return text
            print(f"    [音频] 硅基流动转录失败")
        else:
            print(f"    [音频] 未配置 SILICONFLOW_API_KEY，跳过转录")
        return None


def _fallback_ytdlp(bvid: str, siliconflow_api_key: str = "", siliconflow_stt_model: str = "") -> Optional[str]:
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
                if siliconflow_api_key:
                    return transcribe_with_siliconflow(path, api_key=siliconflow_api_key, model=siliconflow_stt_model)
                return None
            return None
        except FileNotFoundError:
            print(f"    [yt-dlp] ❌ 未安装")
            return None
        except Exception as e:
            print(f"    [yt-dlp] ❌ 异常: {e}")
            return None
