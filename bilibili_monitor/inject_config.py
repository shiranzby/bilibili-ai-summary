#!/usr/bin/env python3
"""
配置注入工具
============
从环境变量读取 Secrets 并写入 config.py。

GHA workflow 调用: python inject_config.py
本地测试调用:   先 export 环境变量，再 python inject_config.py

注入的配置项 (环境变量 → config.py 字段):
    ZHIPU_API_KEY    → ZHIPU_API_KEY
    GEMINI_API_KEY   → GEMINI_API_KEY
    SMTP_USER        → SMTP_USER
    SMTP_PASS        → SMTP_PASS
    SMTP_TO          → SMTP_TO
    HF_TOKEN         → HF_TOKEN
    BILI_COOKIE      → BILI_COOKIE  (完整Cookie字符串,自动解析为三个字段)
    BILI_SESSDATA    → BILI_SESSDATA (单独注入,优先级高于 BILI_COOKIE)
    BILI_BILI_JCT    → BILI_BILI_JCT
    BILI_BUVID3      → BILI_BUVID3
    SILICONFLOW_API_KEY → SILICONFLOW_API_KEY (语音识别)
"""

import os
import re
import sys

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.py")

# 需要注入的环境变量映射: 环境变量名 → config.py 中的变量名
VAR_MAP = {
    "ZHIPU_API_KEY":  "ZHIPU_API_KEY",
    "GEMINI_API_KEY": "GEMINI_API_KEY",
    "SMTP_USER":      "SMTP_USER",
    "SMTP_PASS":      "SMTP_PASS",
    "SMTP_TO":        "SMTP_TO",
    "HF_TOKEN":       "HF_TOKEN",
    "BILI_COOKIE":    "BILI_COOKIE",
    "BILI_SESSDATA":  "BILI_SESSDATA",
    "BILI_BILI_JCT":  "BILI_BILI_JCT",
    "BILI_BUVID3":    "BILI_BUVID3",
    "SILICONFLOW_API_KEY": "SILICONFLOW_API_KEY",
}


def _parse_cookie(cookie_str: str) -> dict:
    """
    从完整 Cookie 字符串中解析出 SESSDATA / bili_jct / buvid3

    支持常见格式:
      - "buvid3=xxx; SESSDATA=xxx; bili_jct=xxx"
      - 浏览器直接复制粘贴的一整段 Cookie 头
    """
    result = {}
    # 正则匹配: name=value; 支持空格和引号
    pairs = re.findall(r'(\w[\w.-]*)\s*=\s*([^;]+)', cookie_str)
    for name, value in pairs:
        name = name.strip()
        value = value.strip().strip('"').strip("'")
        if name == "SESSDATA":
            result["BILI_SESSDATA"] = value
        elif name == "bili_jct":
            result["BILI_BILI_JCT"] = value
        elif name == "buvid3":
            result["BILI_BUVID3"] = value
    return result


def _set_config_var(content: str, var_name: str, value: str) -> str:
    """替换 config.py 中的单个变量值"""
    pattern = rf'({var_name}\s*=\s*)"[^"]*"'
    replacement = rf'\1"{value}"'
    new_content, count = re.subn(pattern, replacement, content)
    if count > 0:
        masked = value[:4] + "****" + value[-4:] if len(value) > 8 else "****"
        print(f"[注入] ✅ {var_name} = {masked} (从完整Cookie解析)")
    return new_content if count > 0 else content


def inject():
    """从环境变量读取并注入到 config.py"""
    if not os.path.exists(CONFIG_PATH):
        print(f"[注入] ❌ 找不到 config.py: {CONFIG_PATH}")
        sys.exit(1)

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    injected_count = 0
    had_cookie = False
    skipped = []

    for env_name, var_name in VAR_MAP.items():
        env_val = os.environ.get(env_name, "")
        if not env_val:
            skipped.append(var_name)
            continue

        # 匹配模式: VAR_NAME = "" 或 VAR_NAME = "old_value"
        pattern = rf'({var_name}\s*=\s*)"[^"]*"'
        replacement = rf'\1"{env_val}"'

        new_content, count = re.subn(pattern, replacement, content)
        if count > 0:
            content = new_content
            injected_count += count
            if env_name == "BILI_COOKIE":
                had_cookie = True
                masked = env_val[:20] + "****" + env_val[-10:] if len(env_val) > 30 else "****"
                print(f"[注入] ✅ {var_name} = {masked}")
            else:
                masked = env_val[:4] + "****" + env_val[-4:] if len(env_val) > 8 else "****"
                print(f"[注入] ✅ {var_name} = {masked}")
        else:
            print(f"[注入] ⚠ {var_name}: 未找到匹配行，跳过")

    # --- 完整Cookie解析 (如果BILI_COOKIE提供了,但单个字段没提供) ---
    if had_cookie:
        raw_cookie = os.environ.get("BILI_COOKIE", "")
        parsed = _parse_cookie(raw_cookie)
        for key in ["BILI_SESSDATA", "BILI_BILI_JCT", "BILI_BUVID3"]:
            # 只有当单个字段还没被注入时才解析
            if key in parsed and key in skipped:
                content = _set_config_var(content, key, parsed[key])
                injected_count += 1
                skipped.remove(key)

    if injected_count == 0:
        print("\n[注入] ⚠ 没有注入任何配置! 请检查 GHA Secrets 是否已设置。")
    else:
        print(f"[注入] 📋 共注入 {injected_count} 项配置")
        if skipped:
            print(f"[注入] ℹ 跳过 (未设置/为空): {', '.join(skipped)}")

    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        f.write(content)


if __name__ == "__main__":
    inject()
