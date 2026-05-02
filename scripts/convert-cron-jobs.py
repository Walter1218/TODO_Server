#!/usr/bin/env python3
"""
convert-cron-jobs.py

将 Hermes cron jobs.json 中的直接 HTTP PUT 调用转换为结构化工具调用模式。
"""

import json
import re
import sys

def transform_prompt(prompt: str) -> str:
    """将旧的 HTTP PUT 模式转换为工具调用模式"""
    
    # 移除旧的 HTTP PUT 块
    pattern1 = re.compile(r'## TODO Server \u5199\u5165(?:\u8981\u6c42)?\uff08\u5fc5\u987b\u6267\u884c\uff09[\s\S]*?(?=\n## |\Z)', re.DOTALL)
    prompt = pattern1.sub('', prompt)
    
    # 清理残留的 HTTP 相关内容
    prompt = re.sub(r'Headers: X-Agent-Secret: [^\n]+\n', '', prompt)
    prompt = re.sub(r'Content-Type: application/json\n', '', prompt)
    prompt = re.sub(r'Body: \{.*?\}\n', '', prompt)
    prompt = re.sub(r'```\n\n注意：\n- 先 POST 创建 todo[\s\S]*?(?=\n## |\Z)', '', prompt)
    prompt = re.sub(r'注意：\n- 先 POST 创建 todo[\s\S]*?(?=\n## |\Z)', '', prompt)
    
    # 添加工具调用说明
    tool_instructions = """
## 工具调用说明

完成任务后必须调用以下工具之一来更新任务状态：

1. **updateProgress** - 更新进度（每次工作循环都应该调用）
   ```json
   {"tool_calls":[{"function":{"name":"updateProgress","arguments":{"progress":80,"step":"数据采集完成","blockers":[]}}]}
   ```

2. **confirmCompletion** - 确认任务完成（任务完全完成时调用）
   ```json
   {"tool_calls":[{"function":{"name":"confirmCompletion","arguments":{"summary":"执行摘要","criteriaMet":["标准1","标准2"],"evidence":"验证证据"}}]}
   ```

3. **askForHelp** - 请求支持（遇到难题时调用）
   ```json
   {"tool_calls":[{"function":{"name":"askForHelp","arguments":{"blocker":"难题描述","neededResource":"需要的资源","alternativesTried":["已尝试方案"]}}]}
   ```

**重要提醒**：
- 使用 `{"tool_calls":[...]}` 格式进行工具调用
- `<todo_id>` 将自动被 TODO Server 填充
- 任务完成必须调用 `confirmCompletion`，并填充 `criteriaMet`
- 如有阻塞请调用 `askForHelp`，而不是直接标记完成
"""
    
    # 在 "## 输出要求" 之后插入工具说明
    if "## 输出要求" in prompt:
        prompt = prompt.replace("## 输出要求", f"## 输出要求{tool_instructions}")
    elif "## 目标" in prompt:
        prompt = prompt.replace("## 目标", f"## 目标{tool_instructions}")
    else:
        prompt += tool_instructions
    
    # 清理多余空行
    prompt = re.sub(r'\n{3,}', '\n\n', prompt)
    
    return prompt.strip()

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 convert-cron-jobs.py <jobs.json路径>")
        sys.exit(1)
    
    jobs_path = sys.argv[1]
    
    with open(jobs_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    changed = 0
    for job in data.get('jobs', []):
        original = job.get('prompt', '')
        transformed = transform_prompt(original)
        if transformed != original:
            changed += 1
            job['prompt'] = transformed
    
    with open(jobs_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"已转换 {changed} 个 jobs")

if __name__ == "__main__":
    main()
