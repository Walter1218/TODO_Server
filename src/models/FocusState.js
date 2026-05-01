const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const Todo = require('./Todo');

class FocusState {
  static findByAgent(agentId) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM focus_states WHERE agent_id = ?');
    return stmt.get(agentId);
  }

  static createOrUpdate(agentId, data) {
    const db = getDb();
    const existing = this.findByAgent(agentId);

    if (existing) {
      const updates = [];
      const values = [];

      if (data.currentTaskId !== undefined) {
        updates.push('current_task_id = ?');
        values.push(data.currentTaskId);
      }
      if (data.focusMode !== undefined) {
        updates.push('focus_mode = ?');
        values.push(data.focusMode);
      }
      if (data.contextWindowSize !== undefined) {
        updates.push('context_window_size = ?');
        values.push(data.contextWindowSize);
      }

      updates.push('last_focused_at = CURRENT_TIMESTAMP');
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(agentId);

      const stmt = db.prepare(`
        UPDATE focus_states SET ${updates.join(', ')}
        WHERE agent_id = ?
      `);
      stmt.run(...values);
      return this.findByAgent(agentId);
    }

    const id = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO focus_states (id, agent_id, current_task_id, focus_mode, context_window_size, last_focused_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(
      id,
      agentId,
      data.currentTaskId || null,
      data.focusMode || 'auto',
      data.contextWindowSize || 10
    );
    return this.findByAgent(agentId);
  }

  static autoFocus(agentId) {
    const db = getDb();

    // Get tasks for this agent:
    // 1. Own tasks that are unassigned (assigned_agent_id IS NULL)
    // 2. Own tasks assigned to self (assigned_agent_id = agentId)
    // 3. Tasks assigned to this agent by others (assigned_agent_id = agentId)
    // Include blocked tasks that still have retry attempts remaining
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE (
          (agent_id = ? AND (assigned_agent_id IS NULL OR assigned_agent_id = ?))
          OR assigned_agent_id = ?
        )
        AND (
          status IN ('pending', 'in_progress')
          OR (status = 'blocked' AND attempt_count < max_attempts)
        )
        AND (is_template = 0 OR is_template IS NULL)
      ORDER BY
        CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        created_at ASC
    `);
    const todos = stmt.all(agentId, agentId, agentId);

    if (todos.length === 0) {
      return null;
    }

    // Priority 1: in_progress tasks (continue working on them)
    const inProgress = todos.find(t => t.status === 'in_progress');
    if (inProgress) {
      this.createOrUpdate(agentId, { currentTaskId: inProgress.id });
      return { ...inProgress, focus_reason: 'continue_in_progress' };
    }

    // Priority 2: ready tasks (dependencies resolved)
    const completedStmt = db.prepare(`
      SELECT id FROM todos
      WHERE agent_id = ? AND status IN ('completed', 'cancelled')
    `);
    const completedIds = new Set(completedStmt.all(agentId).map(r => r.id));

    const readyTasks = todos.filter(t => {
      if (t.status !== 'pending') return false;
      const deps = JSON.parse(t.dependencies || '[]');
      return deps.length === 0 || deps.every(d => completedIds.has(d));
    });

    if (readyTasks.length > 0) {
      // Score and pick the best one
      const scored = readyTasks.map(t => ({
        ...t,
        score: this.calculateFocusScore(t, completedIds)
      })).sort((a, b) => b.score - a.score);

      const chosen = scored[0];
      this.createOrUpdate(agentId, { currentTaskId: chosen.id });
      return { ...chosen, focus_reason: 'ready_highest_score' };
    }

    // Priority 3: blocked tasks with most dependencies resolved
    const blockedTasks = todos.filter(t => {
      if (t.status !== 'pending') return false;
      const deps = JSON.parse(t.dependencies || '[]');
      return deps.length > 0 && deps.some(d => completedIds.has(d));
    });

    if (blockedTasks.length > 0) {
      const chosen = blockedTasks[0];
      this.createOrUpdate(agentId, { currentTaskId: chosen.id });
      return { ...chosen, focus_reason: 'blocked_partially_ready' };
    }

    return null;
  }

  static calculateFocusScore(todo, completedIds) {
    let score = 0;

    // Priority weight
    const priorityWeight = { critical: 100, high: 50, medium: 20, low: 5 };
    score += priorityWeight[todo.priority] || 0;

    // Age bonus (older pending tasks get higher score)
    const ageDays = (Date.now() - new Date(todo.created_at).getTime()) / (24 * 3600 * 1000);
    score += Math.min(ageDays, 20);

    // Dependency readiness bonus
    const deps = JSON.parse(todo.dependencies || '[]');
    if (deps.length === 0) {
      score += 30; // No dependencies = ready immediately
    } else {
      const resolvedCount = deps.filter(d => completedIds.has(d)).length;
      score += (resolvedCount / deps.length) * 25;
    }

    // Attempt penalty (failed tasks get lower score)
    const attemptCount = todo.attempt_count || 0;
    const maxAttempts = todo.max_attempts || 3;
    if (attemptCount >= maxAttempts) {
      score -= 50; // Heavily penalize blocked tasks
    } else {
      score -= attemptCount * 5;
    }

    return score;
  }

  static getFocusContext(agentId) {
    let state = this.findByAgent(agentId);

    // 没有聚焦记录时自动尝试聚焦，保证前后端行为一致
    if (!state || !state.current_task_id) {
      const reevaluated = this.autoFocus(agentId);
      if (!reevaluated) {
        return null;
      }
      state = this.findByAgent(agentId);
      if (!state) return null;
    }

    let currentTask = Todo.findById(agentId, state.current_task_id);
    if (!currentTask) {
      // 当前聚焦的任务已不存在（被删除或归档），清理并尝试自动重新聚焦
      this.createOrUpdate(agentId, { currentTaskId: null });
      const reevaluated = this.autoFocus(agentId);
      if (reevaluated) {
        currentTask = reevaluated;
        state = this.findByAgent(agentId);
      } else {
        return null;
      }
    }

    // If current focus is a template task, re-evaluate via autoFocus
    if (currentTask.is_template === 1) {
      const reevaluated = this.autoFocus(agentId);
      if (reevaluated) {
        currentTask = reevaluated;
        state = this.findByAgent(agentId);
      } else {
        // No eligible task found — clear the invalid focus
        this.createOrUpdate(agentId, { currentTaskId: null });
        return null;
      }
    }

    // Get parent task if exists
    let parentTask = null;
    if (currentTask.parent_id) {
      parentTask = Todo.findById(agentId, currentTask.parent_id);
    }

    // Get subtasks if exists
    const subtasks = Todo.findSubtasks(agentId, currentTask.id);

    // Get sibling tasks (same parent)
    let siblings = [];
    if (currentTask.parent_id) {
      const allSubtasks = Todo.findSubtasks(agentId, currentTask.parent_id);
      siblings = allSubtasks.filter(t => t.id !== currentTask.id);
    }

    return {
      focus_state: state,
      current_task: currentTask,
      parent_task: parentTask,
      subtasks: subtasks,
      siblings: siblings
    };
  }
}

module.exports = FocusState;
