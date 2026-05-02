#!/usr/bin/env python3
"""
Hermes TODO Skill - 主入口
提供任务管理、聚焦引擎、多智能体协作等能力
"""

import os
import sys
import json
import time
import requests
import yaml
from datetime import datetime
from typing import Optional, Dict, Any, List

# Profile-aware config loader
def _get_profile_name():
    hermes_home = os.path.expanduser(os.environ.get("HERMES_HOME", "~/.hermes"))
    if "/profiles/" in hermes_home:
        return hermes_home.split("/profiles/")[-1].split("/")[0]
    return "default"

def _load_agent_credentials(profile_name):
    agents_yaml = os.path.join(os.path.dirname(__file__), "agents.yaml")
    if os.path.exists(agents_yaml):
        with open(agents_yaml, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
            agents = data.get("agents", {})
            # Try exact match first
            if profile_name in agents:
                return agents[profile_name]
            # Fallback: default profile uses "default" key
            if profile_name == "default" and "default" in agents:
                return agents["default"]
    return {}

# 配置路径
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "todo_skill_config.yaml")
CACHE_DIR = os.path.expanduser("~/.hermes/skills/todo/cache")


class TODOSkillClient:
    """TODO Server 客户端"""

    def __init__(self, server_url: str = None, agent_id: str = None, secret_key: str = None):
        self.config = self._load_config()
        self.profile = _get_profile_name()
        self.creds = _load_agent_credentials(self.profile)

        self.base_url = (server_url or self.config.get("server", {}).get("url", "http://localhost:3000")).rstrip("/")
        self.agent_id = agent_id or self.creds.get("agent_id") or self.config.get("agent", {}).get("id", "")
        self.secret_key = secret_key or self.creds.get("secret_key") or self.config.get("server", {}).get("secret_key", "")
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        if self.secret_key:
            self.session.headers.update({"X-Agent-Secret": self.secret_key})

        os.makedirs(CACHE_DIR, exist_ok=True)

    def _load_config(self) -> dict:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return yaml.safe_load(f) or {}
        return {}

    def _request(self, method: str, endpoint: str, data: dict = None, params: dict = None) -> dict:
        url = f"{self.base_url}/api/agents/{self.agent_id}{endpoint}"
        try:
            if method == "GET":
                resp = self.session.get(url, params=data, timeout=30)
            elif method == "POST":
                resp = self.session.post(url, params=params, json=data, timeout=30)
            elif method == "PUT":
                resp = self.session.put(url, params=params, json=data, timeout=30)
            elif method == "PATCH":
                resp = self.session.patch(url, json=data, timeout=30)
            elif method == "DELETE":
                resp = self.session.delete(url, params=params, timeout=30)
            else:
                raise ValueError(f"Unsupported method: {method}")

            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.ConnectionError:
            return {"success": False, "error": "TODO Server 未启动", "data": None}
        except requests.exceptions.Timeout:
            return {"success": False, "error": "请求超时", "data": None}
        except Exception as e:
            return {"success": False, "error": str(e), "data": None}

    # ==================== 任务管理 ====================

    def create_task(self, title: str, **kwargs) -> dict:
        data = {"title": title, **kwargs}
        return self._request("POST", "/todos", data)

    def get_task(self, task_id: str) -> dict:
        return self._request("GET", f"/todos/{task_id}")

    def list_tasks(self, **filters) -> dict:
        return self._request("GET", "/todos", filters)

    def update_task(self, task_id: str, **data) -> dict:
        return self._request("PUT", f"/todos/{task_id}", data)

    def delete_task(self, task_id: str) -> dict:
        return self._request("DELETE", f"/todos/{task_id}")

    # ---------------- 模板任务 ----------------

    def list_templates(self) -> dict:
        """获取所有定时模板任务"""
        return self._request("GET", "/todos/templates")

    def spawn_from_template(self, task_id: str) -> dict:
        """从模板生成实例任务"""
        return self._request("POST", f"/todos/{task_id}/spawn")

    # ---------------- 查询扩展 ----------------

    def get_ready_tasks(self) -> dict:
        """获取所有就绪（依赖已满足）的任务"""
        return self._request("GET", "/todos/ready")

    def search_tasks(self, query: str) -> dict:
        """搜索任务"""
        return self._request("GET", "/todos/search", {"q": query})

    def get_summary(self) -> dict:
        """获取任务上下文摘要"""
        return self._request("GET", "/todos/summary")

    def get_agent_tasks(self, **filters) -> dict:
        """获取由 Agent 创建的任务列表"""
        return self._request("GET", "/todos/agent-tasks", filters)

    def force_complete_task(self, task_id: str) -> dict:
        """强制标记为完成（绕过校验）"""
        return self._request("PATCH", f"/todos/{task_id}/complete")

    def propose_completion(self, task_id: str) -> dict:
        """提交验收申请（触发自驱校验）"""
        return self.update_status(task_id, "pending_validation")

    def update_status(self, task_id: str, status: str) -> dict:
        return self._request("PATCH", f"/todos/{task_id}/status", {"status": status})

    # ==================== 依赖关系 ====================

    def add_dependency(self, task_id: str, dependency_id: str) -> dict:
        return self._request("POST", f"/todos/{task_id}/dependencies", {"dependencyId": dependency_id})

    def remove_dependency(self, task_id: str, dependency_id: str) -> dict:
        return self._request("DELETE", f"/todos/{task_id}/dependencies/{dependency_id}")

    def get_dependency_tree(self, task_id: str) -> dict:
        return self._request("GET", f"/todos/{task_id}/dependency-tree")

    # ==================== 项目管理 ====================

    def create_project(self, name: str, **kwargs) -> dict:
        return self._request("POST", "/projects", {"name": name, **kwargs})

    def get_project(self, project_id: str) -> dict:
        return self._request("GET", f"/projects/{project_id}")

    def list_projects(self) -> dict:
        return self._request("GET", "/projects")

    def get_project_board(self, project_id: str) -> dict:
        return self._request("GET", f"/projects/{project_id}/board")

    # ==================== 聚焦引擎 ====================

    def get_focus(self) -> dict:
        return self._request("GET", "/focus")

    def set_focus(self, task_id: str) -> dict:
        return self._request("PUT", "/focus", {"taskId": task_id})

    def auto_focus(self) -> dict:
        return self._request("POST", "/focus/auto", {})

    # ==================== 心跳与重试 ====================

    def update_heartbeat(self, task_id: str, progress: float = 0, step: str = "", blockers: List[str] = None) -> dict:
        data = {"progress": progress, "step": step, "blockers": blockers or []}
        return self._request("POST", f"/todos/{task_id}/heartbeat", data)

    def record_attempt(self, task_id: str, success: bool, result: str = "", error: str = "") -> dict:
        data = {"success": success, "reason": result, "output": error}
        return self._request("POST", f"/todos/{task_id}/attempt", data)

    def get_stuck_tasks(self, max_idle_minutes: int = 30) -> dict:
        return self._request("GET", "/todos/stuck/list", {"maxIdleMinutes": max_idle_minutes})

    def get_subtasks(self, task_id: str) -> dict:
        return self._request("GET", f"/todos/{task_id}/subtasks")

    def drive_task(self, task_id: str) -> dict:
        """手动推进任务（驱动 blocked/pending 状态的任务）"""
        return self._request("POST", f"/todos/{task_id}/drive")

    def confirm_completion(self, task_id: str, summary: str = "", criteria_met: list = None, evidence: str = "") -> dict:
        """显式确认任务完成（带 criteriaMet 校验）"""
        data = {"summary": summary, "criteriaMet": criteria_met or [], "evidence": evidence}
        return self._request("POST", f"/todos/{task_id}/confirm-completion", data)

    def create_subtask(self, parent_id: str, title: str, **kwargs) -> dict:
        """安全创建子任务（自动关联父任务）"""
        return self._request("POST", f"/todos/{parent_id}/sub-tasks", {"title": title, **kwargs})

    # ==================== 多智能体协作 ====================

    def assign_task(self, task_id: str, target_agent_id: str, note: str = "") -> dict:
        return self._request("POST", f"/todos/{task_id}/assign", {
            "targetAgentId": target_agent_id,
            "note": note
        })

    def transfer_task(self, task_id: str, target_agent_id: str, note: str = "") -> dict:
        return self._request("POST", f"/todos/{task_id}/transfer", {
            "targetAgentId": target_agent_id,
            "note": note
        })

    def get_assigned_tasks(self, **filters) -> dict:
        return self._request("GET", "/todos/assigned", filters)

    def get_created_tasks(self, **filters) -> dict:
        return self._request("GET", "/todos/created", filters)

    def get_notifications(self, unread_only: bool = False) -> dict:
        return self._request("GET", "/notifications", {"unreadOnly": unread_only})

    def mark_notification_read(self, notification_id: str) -> dict:
        return self._request("POST", f"/notifications/{notification_id}/read", {})

    def mark_all_notifications_read(self) -> dict:
        return self._request("POST", "/notifications/read-all", {})

    # ==================== 上下文存储 ====================

    def save_context(self, session_id: str, role: str, content: str, metadata: dict = None) -> dict:
        data = {"sessionId": session_id, "role": role, "content": content, "metadata": metadata or {}}
        return self._request("POST", "/contexts", data)

    def get_contexts(self, session_id: str, limit: int = 100) -> dict:
        return self._request("GET", "/contexts", {"sessionId": session_id, "limit": limit})

    # ==================== 便捷方法 ====================

    def quick_add(self, title: str, **kwargs) -> dict:
        return self.create_task(title, **kwargs)

    def start_task(self, task_id: str) -> dict:
        return self.update_status(task_id, "in_progress")

    def focus_summary(self) -> str:
        result = self.get_focus()
        if not result.get("success"):
            return f"❌ 获取聚焦状态失败: {result.get('error', '未知错误')}"

        data = result.get("data", {})
        task = data.get("current_task")
        if not task:
            return "🎯 当前没有聚焦任务"

        return f"""🎯 当前聚焦任务
ID: {task.get('id')}
标题: {task.get('title')}
状态: {task.get('status')}
优先级: {task.get('priority', 'normal')}
心跳进度: {task.get('heartbeat_progress', 0)}%
当前步骤: {task.get('heartbeat_step', '无')}
"""

    def task_stats(self) -> str:
        result = self._request("GET", "/todos/stats")
        if not result.get("success"):
            return f"❌ 获取统计失败: {result.get('error', '未知错误')}"

        stats = result.get("data", {})
        active = (stats.get('pending') or 0) + (stats.get('in_progress') or 0) + (stats.get('pending_validation') or 0)
        high_priority = (stats.get('high_pending') or 0) + (stats.get('critical_pending') or 0)
        return f"""📊 任务统计
总任务: {stats.get('total') or 0}
活跃: {active}
已完成: {stats.get('completed') or 0}
待校验: {stats.get('pending_validation') or 0}
被阻塞: {stats.get('blocked') or 0}
高优先级: {high_priority}
"""

    def archive_old_tasks(self, days: int = 30) -> dict:
        """归档 N 天前已完成的任务"""
        return self._request("POST", "/todos/archive-old", params={"days": days})

    def delete_archived(self) -> dict:
        """清空已归档任务"""
        return self._request("DELETE", "/todos/archived")


# ==================== CLI 入口 ====================

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Hermes TODO Skill CLI")
    parser.add_argument("--agent-id", default=os.environ.get("HERMES_AGENT_ID", ""), help="Agent ID")
    parser.add_argument("--server", default="http://localhost:3000", help="TODO Server URL")
    parser.add_argument("command", choices=[
        "propose-completion", "force-complete",
        "focus", "auto-focus", "stats", "list", "create",
        "assign", "transfer", "board", "notifications", "heartbeat"
    ], help="命令")
    parser.add_argument("--task-id", help="任务 ID")
    parser.add_argument("--title", help="任务标题")
    parser.add_argument("--target-agent", help="目标 Agent ID")
    parser.add_argument("--project-id", help="项目 ID")
    parser.add_argument("--note", default="", help="备注")
    parser.add_argument("--progress", type=float, default=0, help="进度 0-100")
    parser.add_argument("--step", default="", help="当前步骤")

    args = parser.parse_args()

    client = TODOSkillClient(server_url=args.server, agent_id=args.agent_id)

    if args.command == "focus":
        print(client.focus_summary())
    elif args.command == "auto-focus":
        result = client.auto_focus()
        if result and result.get("success"):
            data = result.get("data") or {}
            task = data.get("task") or {}
            if task:
                print(f"✅ 自动聚焦: {task.get('title', '无')} ({task.get('id', '')})")
            else:
                print("📭 当前没有可聚焦的任务")
        else:
            print(f"❌ 自动聚焦失败: {result.get('error', '未知错误') if result else '无响应'}")
    elif args.command == "stats":
        print(client.task_stats())
    elif args.command == "list":
        result = client.list_tasks()
        if result.get("success"):
            tasks = result.get("data", [])
            print(f"📋 共 {len(tasks)} 个任务:")
            for t in tasks:
                print(f"  [{t.get('status', '?')}] {t.get('title', '')} ({t.get('id', '')})")
        else:
            print(f"❌ 获取失败: {result.get('error', '未知错误')}")
    elif args.command == "create":
        if not args.title:
            print("❌ 请提供 --title")
            return
        result = client.create_task(args.title)
        if result.get("success"):
            print(f"✅ 创建成功: {result.get('data', {}).get('id', '')}")
        else:
            print(f"❌ 创建失败: {result.get('error', '未知错误')}")
    elif args.command == "propose-completion":
        if not args.task_id:
            print("❌ 请提供 --task-id")
            return
        result = client.propose_completion(args.task_id)
        if result.get("success"):
            print(f"✅ 验收申请已提交: {args.task_id}")
        else:
            print(f"❌ 提交失败: {result.get('error', '未知错误')}")
    elif args.command == "force-complete":
        if not args.task_id:
            print("❌ 请提供 --task-id")
            return
        result = client.force_complete_task(args.task_id)
        if result.get("success"):
            print(f"✅ 任务 {args.task_id} 已强制标记为完成")
        else:
            print(f"❌ 操作失败: {result.get('error', '未知错误')}")
    elif args.command == "assign":
        if not args.task_id or not args.target_agent:
            print("❌ 请提供 --task-id 和 --target-agent")
            return
        result = client.assign_task(args.task_id, args.target_agent, args.note)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    elif args.command == "transfer":
        if not args.task_id or not args.target_agent:
            print("❌ 请提供 --task-id 和 --target-agent")
            return
        result = client.transfer_task(args.task_id, args.target_agent, args.note)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    elif args.command == "board":
        if not args.project_id:
            print("❌ 请提供 --project-id")
            return
        result = client.get_project_board(args.project_id)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    elif args.command == "notifications":
        result = client.get_notifications(unread_only=True)
        if result.get("success"):
            notifications = result.get("data", [])
            print(f"🔔 {len(notifications)} 条未读通知:")
            for n in notifications:
                print(f"  [{n.get('type', '?')}] {n.get('message', '')}")
        else:
            print(f"❌ 获取失败: {result.get('error', '未知错误')}")
    elif args.command == "heartbeat":
        if not args.task_id:
            print("❌ 请提供 --task-id")
            return
        result = client.update_heartbeat(args.task_id, args.progress, args.step)
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
