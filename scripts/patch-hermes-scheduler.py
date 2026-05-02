#!/usr/bin/env python3
"""
patch-hermes-scheduler.py

Automatically patches hermes-agent/cron/scheduler.py to integrate with the
TODO Server unified scheduling API.

What this patch does:
  1. Adds _fetch_todo_for_job() helper after _resolve_delivery_target()
  2. In run_job(), before _build_job_prompt(), calls _fetch_todo_for_job()
     to inject job["todo_id"] from GET /scheduled/pending
  3. In _build_job_prompt(), replaces <todo_id> placeholder with real UUID
  4. Converts cron job prompts from HTTP PUT to structured tool calls

Activation: Set HERMES_TODO_SERVER_URL in Hermes .env (or it stays dormant).
Idempotent: Safe to run multiple times — checks for sentinels before applying changes.

Usage:
  node scripts/patch-hermes-scheduler.js [hermes_home]

  hermes_home defaults to ~/.hermes
"""

import os
import re
import sys
import urllib.request
import urllib.error
import json
from pathlib import Path

_MARKER = "# _HERMES_TODO_UNIFIED_SCHEDULING_MARKER_"
_JOBS_CONVERTED_MARKER = "# _HERMES_TODO_JOBS_CONVERTED_MARKER_"

_TOOL_INSTRUCTIONS = """
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

_HERMES_TODO_FETCH = """
def _fetch_todo_for_job(job: dict) -> None:
    \"\"\"
    Pre-flight hook: query GET /scheduled/pending and inject the matched
    todo UUID into job['todo_id'] so _build_job_prompt() can replace
    <todo_id> placeholders in cron job prompts.

    Activation gate: only active when HERMES_TODO_SERVER_URL is set.
    \"\"\"
    server_url = os.getenv("HERMES_TODO_SERVER_URL", "").rstrip("/")
    if not server_url:
        return

    secret = os.getenv("HERMES_OPS_TODO_SECRET", "")
    agent_id = os.getenv("HERMES_OPS_AGENT_ID", "4b5ad916-435f-4292-be5c-8ec049e4faaa")
    if not secret:
        return

    job_id = job.get("id", "")
    job_name = job.get("name", "")

    try:
        req = urllib.request.Request(
            f"{server_url}/scheduled/pending",
            headers={
                "X-Agent-Secret": secret,
                "X-Agent-Id": agent_id,
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                return
            pending_list = json.loads(resp.read()).get("data", [])
        for t in pending_list:
            title = t.get("title", "") or ""
            parent_id = t.get("parent_id") or ""
            if job_name and title and job_name in title:
                job["todo_id"] = t["id"]
                logger.info(
                    "Job '%s': matched TODO '%s' (id=%s) from unified scheduling",
                    job_id, title[:60], t["id"],
                )
                return
            if job_id and parent_id and job_id in parent_id:
                job["todo_id"] = t["id"]
                logger.info(
                    "Job '%s': matched TODO by parent_id (id=%s)",
                    job_id, t["id"],
                )
                return
    except Exception as exc:
        logger.debug("Job '%s': unified scheduling lookup skipped — %s", job_id, exc)


"""

_RUN_JOB_TODO_CALL = """    # Pre-flight: inject todo_id from unified scheduling API
    _fetch_todo_for_job(job)

    prompt = _build_job_prompt(job)"""

_BUILD_PROMPT_TODO_REPLACE = '''    prompt = job.get("prompt", "")

    # Replace <todo_id> placeholder with the real UUID from TODO Server.
    if job.get("todo_id"):
        prompt = prompt.replace("<todo_id>", job["todo_id"])

    skills = job.get("skills")'''


def find_scheduler(hermes_home: Path) -> Path | None:
    candidates = [
        hermes_home / "hermes-agent" / "cron" / "scheduler.py",
        hermes_home / "hermes-agent" / "cron" / "scheduler.pyi",
    ]
    for p in candidates:
        if p.is_file():
            return p
    return None


def find_jobs_json(hermes_home: Path) -> Path | None:
    candidates = [
        hermes_home / "profiles" / "ops" / "cron" / "jobs.json",
        hermes_home / "profiles" / "default" / "cron" / "jobs.json",
    ]
    for p in candidates:
        if p.is_file():
            return p
    return None


def is_scheduler_patched(content: str) -> bool:
    return _MARKER in content


def is_jobs_converted(content: str) -> bool:
    return _JOBS_CONVERTED_MARKER in content


def apply_scheduler_patch(content: str) -> str:
    if _MARKER in content:
        return content

    media_marker = "# Media extension sets — keep in sync with"
    if media_marker not in content:
        raise RuntimeError(
            "Could not find injection anchor 'Media extension sets' in scheduler.py. "
            "File may have changed significantly. Please verify patch manually."
        )

    inject_pos = content.index(media_marker)
    patched = (
        content[:inject_pos]
        + _MARKER
        + "\n"
        + _HERMES_TODO_FETCH
        + "\n"
        + content[inject_pos:]
    )

    old_run_job_build = "    prompt = _build_job_prompt(job)\n    origin = _resolve_origin(job)"
    if old_run_job_build not in patched:
        raise RuntimeError(
            "Could not find 'prompt = _build_job_prompt(job)\\n    origin = _resolve_origin(job)' "
            "in scheduler.py. File structure may have changed. Please verify patch manually."
        )
    patched = patched.replace(
        old_run_job_build,
        _RUN_JOB_TODO_CALL + "\n    origin = _resolve_origin(job)",
    )

    old_prompt_start = '    prompt = job.get("prompt", "")\n    skills = job.get("skills")'
    if old_prompt_start not in patched:
        raise RuntimeError(
            "Could not find prompt / skills pattern in _build_job_prompt(). "
            "Please verify patch manually."
        )
    patched = patched.replace(old_prompt_start, _BUILD_PROMPT_TODO_REPLACE)

    return patched


def convert_job_prompt(prompt: str) -> str:
    """Convert old HTTP PUT pattern to structured tool calls."""

    # Check if already has tool instructions
    if "## 工具调用说明" in prompt and "confirmCompletion" in prompt:
        return prompt  # Already converted

    # Remove old HTTP PUT blocks
    http_put_pattern = re.compile(
        r'## TODO Server \u5199\u5165(?:\u8981\u6c42)?\uff08\u5fc5\u987b\u6267\u884c\uff09[\s\S]*?(?=\n## |\Z)',
        re.DOTALL
    )
    prompt = http_put_pattern.sub('', prompt)

    prompt = re.sub(r'Headers: X-Agent-Secret: [^\n]+\n', '', prompt)
    prompt = re.sub(r'Content-Type: application/json\n', '', prompt)
    prompt = re.sub(r'Body: \{.*?\}\n', '', prompt)
    prompt = re.sub(r'```\n\n注意：\n- 先 POST 创建 todo[\s\S]*?(?=\n## |\Z)', '', prompt)
    prompt = re.sub(r'注意：\n- 先 POST 创建 todo[\s\S]*?(?=\n## |\Z)', '', prompt)

    # Remove any existing duplicate tool instructions blocks
    tool_block_pattern = re.compile(
        r'## 工具调用说明\n\n[\s\S]*?直接标记完成\n\n',
        re.DOTALL
    )
    prompt = tool_block_pattern.sub('', prompt)

    # Add tool instructions in the right place
    if "## 输出要求" in prompt:
        prompt = prompt.replace("## 输出要求", f"## 输出要求\n{_TOOL_INSTRUCTIONS}")
    elif "## 目标" in prompt:
        prompt = prompt.replace("## 目标", f"## 目标\n{_TOOL_INSTRUCTIONS}")
    else:
        prompt += _TOOL_INSTRUCTIONS

    # Clean up multiple blank lines
    prompt = re.sub(r'\n{3,}', '\n\n', prompt)

    # Remove marker from prompt if present (will be added by caller)
    prompt = prompt.replace(_JOBS_CONVERTED_MARKER, '').strip()

    return prompt


def apply_jobs_conversion(jobs_path: Path) -> int:
    """Convert all job prompts in jobs.json. Returns number of jobs converted."""
    content = jobs_path.read_text(encoding='utf-8')

    if _JOBS_CONVERTED_MARKER in content:
        return 0

    data = json.loads(content)
    changed = 0

    for job in data.get('jobs', []):
        original = job.get('prompt', '')
        if original and "## 工具调用说明" not in original:
            job['prompt'] = convert_job_prompt(original) + "\n" + _JOBS_CONVERTED_MARKER
            changed += 1
        elif original:
            # Already has tool instructions, just add marker
            if _JOBS_CONVERTED_MARKER not in original:
                job['prompt'] = original.strip() + "\n" + _JOBS_CONVERTED_MARKER

    if changed > 0:
        jobs_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

    return changed


def get_ops_credentials(hermes_home: Path) -> tuple[str, str]:
    """Read ops agent credentials from Hermes .env."""
    env_path = hermes_home / ".env"
    secret = ""
    agent_id = "4b5ad916-435f-4292-be5c-8ec049e4faaa"
    if env_path.is_file():
        for line in env_path.read_text().splitlines():
            if line.startswith("HERMES_OPS_TODO_SECRET"):
                secret = line.split("=", 1)[1].strip().strip('"').strip("'")
            elif line.startswith("HERMES_OPS_AGENT_ID"):
                agent_id = line.split("=", 1)[1].strip().strip('"').strip("'")
    return agent_id, secret


def update_hermes_env(hermes_home: Path, todo_server_url: str) -> None:
    """Append TODO Server configuration to Hermes .env if not already present."""
    env_path = hermes_home / ".env"
    new_lines = []
    if not env_path.is_file():
        content = ""
    else:
        content = env_path.read_text()

    for key in ("HERMES_TODO_SERVER_URL",):
        marker = f"# TODO Server unified scheduling (auto-patched by patch-hermes-scheduler.py)"
        line = f'{marker}\n{key}={todo_server_url}'
        if key not in content:
            new_lines.append(line)
        else:
            print(f"  .env already has {key}, skipping")

    if new_lines:
        with open(env_path, "a") as f:
            f.write("\n" + "\n".join(new_lines) + "\n")
        print(f"  Updated {env_path}")


def main() -> None:
    hermes_home_arg = None
    if len(sys.argv) > 1:
        hermes_home_arg = Path(sys.argv[1])

    hermes_home = hermes_home_arg or Path(os.path.expanduser("~/.hermes"))

    # 1. Patch scheduler.py
    scheduler_path = find_scheduler(hermes_home)
    if scheduler_path:
        content = scheduler_path.read_text()
        if not is_scheduler_patched(content):
            print(f"[patch-hermes-scheduler] Patching: {scheduler_path}")
            patched = apply_scheduler_patch(content)
            scheduler_path.write_text(patched)
            print(f"[patch-hermes-scheduler] Written:   {scheduler_path}")
        else:
            print(f"[patch-hermes-scheduler] Already patched: {scheduler_path}")
    else:
        print(
            f"[patch-hermes-scheduler] scheduler.py not found under {hermes_home}/hermes-agent/cron/. "
            "Skipping scheduler patch."
        )

    # 2. Convert job prompts in jobs.json
    jobs_path = find_jobs_json(hermes_home)
    if jobs_path:
        content = jobs_path.read_text(encoding='utf-8')
        if not is_jobs_converted(content):
            print(f"[patch-hermes-scheduler] Converting job prompts in: {jobs_path}")
            changed = apply_jobs_conversion(jobs_path)
            print(f"[patch-hermes-scheduler] Converted {changed} job prompts")
        else:
            print(f"[patch-hermes-scheduler] Job prompts already converted: {jobs_path}")
    else:
        print(
            f"[patch-hermes-scheduler] jobs.json not found. "
            "Skipping job prompt conversion."
        )

    # 3. Update .env
    ops_id, ops_secret = get_ops_credentials(hermes_home)
    todo_server_url = os.getenv("TODO_SERVER_URL", "http://localhost:3000").rstrip("/")
    update_hermes_env(hermes_home, todo_server_url)

    print(
        "\n[patch-hermes-scheduler] Hermes unified scheduling integration complete.\n"
        "Restart Hermes gateway for changes to take effect:\n"
        f"  hermes restart  (or: launchctl unload/load ~/.hermes/hermes-*.plist)\n\n"
        "To activate, add to Hermes .env:\n"
        f"  HERMES_TODO_SERVER_URL={todo_server_url}\n"
        f"  HERMES_OPS_TODO_SECRET={ops_secret or '<your ops agent secret>'}\n"
    )


if __name__ == "__main__":
    main()
