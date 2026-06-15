#!/usr/bin/env python3
"""
配置注入工具
============
从环境变量读取 Secrets 并写入 config.py。

GHA workflow 调用: python inject_config.py
本地测试调用:   先 export 环境变量，再 python inject_config.py

    注入的配置项 (环境变量 → config.py 字段):
    SMTP_USER               → SMTP_USER
    SMTP_PASS               → SMTP_PASS
    SMTP_TO                 → SMTP_TO
    SILICONFLOW_API_KEY     → SILICONFLOW_API_KEY (语音识别 + AI总结 Key)
    SILICONFLOW_STT_MODEL   → SILICONFLOW_STT_MODEL (语音转文字模型，可选)
    SILICONFLOW_SUMMARY_MODEL → SILICONFLOW_SUMMARY_MODEL (总结模型，可选)
"""

import os
import re
import sys

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.py")

# 需要注入的环境变量映射: 环境变量名 → config.py 中的变量名
VAR_MAP = {
    "SMTP_USER":      "SMTP_USER",
    "SMTP_PASS":      "SMTP_PASS",
    "SMTP_TO":        "SMTP_TO",
    "SILICONFLOW_API_KEY": "SILICONFLOW_API_KEY",
    "SILICONFLOW_STT_MODEL":   "SILICONFLOW_STT_MODEL",
    "SILICONFLOW_SUMMARY_MODEL":   "SILICONFLOW_SUMMARY_MODEL",
}


def inject():
    """从环境变量读取并注入到 config.py"""
    if not os.path.exists(CONFIG_PATH):
        print(f"[注入] ❌ 找不到 config.py: {CONFIG_PATH}")
        sys.exit(1)

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    injected_count = 0
    skipped = []

    for env_name, var_name in VAR_MAP.items():
        env_val = os.environ.get(env_name, "")
        if not env_val:
            skipped.append(var_name)
            continue

        pattern = rf'({var_name}\s*=\s*)"[^"]*"'
        replacement = rf'\1"{env_val}"'

        new_content, count = re.subn(pattern, replacement, content)
        if count > 0:
            content = new_content
            injected_count += count
            masked = env_val[:4] + "****" + env_val[-4:] if len(env_val) > 8 else "****"
            print(f"[注入] ✅ {var_name} = {masked}")
        else:
            print(f"[注入] ⚠ {var_name}: 未找到匹配行，跳过")

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
