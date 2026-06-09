"""
音频转文字模块 (Whisper)
=======================
当B站视频没有AI字幕时，使用此模块下载视频音频并转录为文字。

流程: yt-dlp 下载音频 → Hugging Face Whisper API 转录 → 返回文本

费用:
  Hugging Face Inference API 免费层可用 (有速率限制)
  yt-dlp 免费开源
  GitHub Actions 上需安装 yt-dlp + ffmpeg
"""

import os
import requests
import subprocess
import tempfile
from typing import Optional


def transcribe_audio(
    audio_path: str,
    hf_token: str = "",
    model: str = "openai/whisper-large-v3",
) -> Optional[str]:
    """
    使用 Hugging Face 免费 Inference API 将音频转为文字

    参数:
        audio_path: 音频文件路径
        hf_token: Hugging Face API Token (免费: https://huggingface.co/settings/tokens)
        model: Whisper 模型名

    返回:
        转录文本或 None
    """
    if not hf_token:
        print("    [音频转写] ❌ 未配置 Hugging Face Token")
        print("    [音频转写]    免费获取: https://huggingface.co/settings/tokens")
        return None

    api_url = f"https://api-inference.huggingface.co/models/{model}"

    if not os.path.exists(audio_path):
        print(f"    [音频转写] ❌ 音频文件不存在: {audio_path}")
        return None

    file_size_mb = os.path.getsize(audio_path) / 1024 / 1024
    print(f"    [音频转写] 正在上传音频 ({file_size_mb:.1f} MB) 到 Hugging Face...")

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
                print(f"    [音频转写] ✅ 成功转录 ({len(text)} 字符)")
                return text
            else:
                print(f"    [音频转写] ⚠ 返回文本为空")
                return None
        elif resp.status_code == 503:
            print(f"    [音频转写] ⏳ 模型正在加载，请稍后重试")
            return None
        else:
            print(f"    [音频转写] ❌ API 错误: {resp.status_code}")
            print(f"    [音频转写]    响应: {resp.text[:200]}")
            return None

    except requests.exceptions.Timeout:
        print(f"    [音频转写] ❌ 请求超时 (文件可能过大)")
        return None
    except Exception as e:
        print(f"    [音频转写] ❌ 失败: {e}")
        return None


def download_bilibili_audio(
    bvid: str,
    output_dir: str = "",
) -> Optional[str]:
    """
    使用 yt-dlp 下载B站视频的音频

    返回:
        音频文件路径，或 None
    """
    url = f"https://www.bilibili.com/video/{bvid}"
    if not output_dir:
        output_dir = tempfile.mkdtemp()

    output_template = os.path.join(output_dir, f"{bvid}.%(ext)s")

    # 只下载音频，转为 mp3 格式
    cmd = [
        "yt-dlp",
        "-x",                              # 只提取音频
        "--audio-format", "mp3",           # 转为 mp3
        "--audio-quality", "0",            # 最佳音质
        "-o", output_template,             # 输出路径
        "--quiet",                         # 安静模式
        "--no-warnings",
        url,
    ]

    print(f"    [音频下载] 正在下载音频 (yt-dlp)...")
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,  # 5分钟超时
        )
        if result.returncode != 0:
            print(f"    [音频下载] ❌ yt-dlp 失败: {result.stderr[:200]}")
            return None

        # yt-dlp 输出文件名: bvid.mp3
        expected_path = os.path.join(output_dir, f"{bvid}.mp3")
        if os.path.exists(expected_path):
            file_size = os.path.getsize(expected_path) / 1024 / 1024
            print(f"    [音频下载] ✅ 下载完成 ({file_size:.1f} MB)")
            return expected_path

        # 尝试查找其他格式
        for f in os.listdir(output_dir):
            if f.startswith(bvid):
                path = os.path.join(output_dir, f)
                print(f"    [音频下载] ✅ 下载完成 ({os.path.getsize(path)/1024/1024:.1f} MB)")
                return path

        print(f"    [音频下载] ⚠ 下载完成但找不到文件")
        return None

    except subprocess.TimeoutExpired:
        print(f"    [音频下载] ❌ 下载超时 (视频可能过长)")
        return None
    except FileNotFoundError:
        print(f"    [音频下载] ❌ 未找到 yt-dlp，请先安装")
        print(f"    [音频下载]    安装: pip install yt-dlp")
        return None
    except Exception as e:
        print(f"    [音频下载] ❌ 失败: {e}")
        return None


def get_text_from_audio(
    bvid: str,
    hf_token: str = "",
    model: str = "openai/whisper-large-v3",
) -> Optional[str]:
    """
    一站式: 下载B站视频音频 → Whisper转写 → 返回文本

    参数:
        bvid: 视频BV号
        hf_token: Hugging Face Token
        model: Whisper模型

    返回:
        转录文本或 None
    """
    # 1. 下载音频
    audio_path = download_bilibili_audio(bvid)
    if not audio_path:
        return None

    # 2. 转写
    text = transcribe_audio(audio_path, hf_token=hf_token, model=model)

    # 3. 清理临时文件
    try:
        os.remove(audio_path)
    except Exception:
        pass

    return text
