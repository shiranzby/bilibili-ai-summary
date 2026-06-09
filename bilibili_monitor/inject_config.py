import os, re
path = 'bilibili_monitor/config.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
for key in ['ZHIPU_API_KEY', 'SMTP_USER', 'SMTP_PASS', 'SMTP_TO', 'HF_TOKEN']:
    val = os.environ.get(key, '')
    if val:
        content = re.sub(key + r' = ".*"', key + ' = "' + val + '"', content)
with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('Config injected successfully')
