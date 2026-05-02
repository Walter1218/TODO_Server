#!/usr/bin/env python3
"""
clean-duplicate-tools.py - 清理 jobs.json 中重复的工具调用说明
"""

import json
import re

def clean_prompt(prompt: str) -> str:
    """移除重复的工具调用说明"""
    # 匹配工具调用说明块
    tool_pattern = re.compile(
        r'(## \u5de5\u5177\u8c03\u7528\u8bf4\u660e\n\n\u5b8c\u6210\u4efb\u52a1\u540e\u5fc5\u987b\u8c03\u7528\u4ee5\u4e0b\u5de5\u5177\u4e4b\u4e00\u6765\u66f4\u65b0\u4efb\u52a1\u72b6\u6001\uff1a\n\n1. \*\*updateProgress\*\*.*?\*\*重要提醒\*\*：\n- 使用 `\{\\"tool_calls\\":\[\.\.\.\]\}` 格式进行工具调用\n- `<todo_id>` 将自动被 TODO Server 填充\n- 任务完成必须调用 `confirmCompletion`，并填充 `criteriaMet`\n- 如有阻塞请调用 `askForHelp`，而不是直接标记完成)',
        re.DOTALL
    )
    
    # 找到所有匹配
    matches = tool_pattern.findall(prompt)
    if len(matches) > 1:
        # 保留第一个，移除其余重复的
        first_tool_block = matches[0]
        # 移除所有工具块
        prompt = tool_pattern.sub('', prompt)
        # 添加回第一个
        prompt = prompt + '\n\n' + first_tool_block
    
    # 清理多余空行
    prompt = re.sub(r'\n{3,}', '\n\n', prompt)
    
    return prompt.strip()

def main():
    jobs_path = '/Users/onetwo/.hermes/profiles/ops/cron/jobs.json'
    
    with open(jobs_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    changed = 0
    for job in data.get('jobs', []):
        original = job.get('prompt', '')
        cleaned = clean_prompt(original)
        if cleaned != original:
            changed += 1
            job['prompt'] = cleaned
    
    with open(jobs_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"已清理 {changed} 个 jobs")

if __name__ == "__main__":
    main()
