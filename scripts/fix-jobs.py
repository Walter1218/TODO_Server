#!/usr/bin/env python3
"""
fix-jobs.py - 修复 jobs.json 中的重复内容
"""

import json
import re

def fix_prompt(prompt: str) -> str:
    """修复重复的工具调用说明和残留内容"""
    
    # 移除重复的工具调用说明（保留第一个）
    tool_block_pattern = re.compile(
        r'(## \u5de5\u5177\u8c03\u7528\u8bf4\u660e\n\n[\s\S]*?\n- 如有阻塞请调用 `askForHelp`，而不是直接标记完成)',
        re.DOTALL
    )
    
    matches = tool_block_pattern.findall(prompt)
    if len(matches) > 1:
        # 移除所有工具块
        prompt = tool_block_pattern.sub('', prompt)
        # 添加回第一个
        prompt = prompt.strip() + '\n\n' + matches[0]
    
    # 移除残留的 Body: {...} 内容
    prompt = re.sub(r'Body: \{\s*"title": [^}]+\}\n?', '', prompt)
    
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
        fixed = fix_prompt(original)
        if fixed != original:
            changed += 1
            job['prompt'] = fixed
    
    with open(jobs_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"已修复 {changed} 个 jobs")

if __name__ == "__main__":
    main()
