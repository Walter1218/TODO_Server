const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const Context = require('./Context');

// 安全解析 JSON 字段，处理可能的非 JSON 格式
const safeParseJson = (str, defaultValue = []) => {
  if (!str) return defaultValue;
  try {
    return JSON.parse(str);
  } catch {
    // 如果不是 JSON，尝试作为逗号分隔字符串处理
    if (typeof str === 'string' && !str.startsWith('[')) {
      return str.split(',').map(s => s.trim()).filter(Boolean);
    }
    return defaultValue;
  }
};

class Todo {
  static create(agentId, data) {
    const db = getDb();
    const id = data.id || uuidv4();
    const {
      title,
      description = '',
      status = 'pending',
      priority = 'medium',
      context = '',
      tags = [],
      dependencies = [],
      projectId = null,
      parentId = null,
      position = 0,
      acceptanceCriteria = '',
      criteriaConfirmed = false,
      maxAttempts = 3,
      schedule = null,
      isTemplate = false,
      assignedAgentId = null,
      validationReport = '',
      validatedBy = null,
      validationCount = 0
    } = data;

    // Auto-set isTemplate=true if schedule is provided but isTemplate not explicitly set
    // This prevents LLM from forgetting to mark scheduled tasks as templates
    let finalIsTemplate = isTemplate;
    if (schedule && data.isTemplate === undefined) {
      finalIsTemplate = true;
    }

    // Compute next due date for scheduled tasks
    const nextDueAt = schedule ? this.computeNextDueAt(schedule, new Date()) : null;

    const stmt = db.prepare(`
      INSERT INTO todos (
        id, agent_id, project_id, parent_id, title, description, status, priority,
        context, tags, dependencies, position,
        acceptance_criteria, criteria_confirmed, max_attempts,
        origin_agent_id, assigned_agent_id, schedule, is_template, next_due_at,
        validation_report, validated_by, validation_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id, agentId, projectId, parentId, title, description, status, priority,
      context, JSON.stringify(tags), JSON.stringify(dependencies), position,
      acceptanceCriteria, criteriaConfirmed ? 1 : 0, maxAttempts,
      agentId, assignedAgentId, schedule, finalIsTemplate ? 1 : 0, nextDueAt,
      validationReport, validatedBy, validationCount
    );

    return this.findById(agentId, id);
  }

  static findById(agentId, id) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM todos WHERE id = ? AND agent_id = ?');
    const todo = stmt.get(id, agentId);

    if (todo) {
      todo.tags = safeParseJson(todo.tags);
      todo.dependencies = safeParseJson(todo.dependencies);
      todo.attempt_log = safeParseJson(todo.attempt_log);
      todo.heartbeat_blockers = safeParseJson(todo.heartbeat_blockers);
    }

    return todo;
  }

  static findByTitle(agentId, title) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM todos WHERE agent_id = ? AND title = ? ORDER BY created_at DESC LIMIT 1');
    const todo = stmt.get(agentId, title);

    if (todo) {
      todo.tags = safeParseJson(todo.tags);
      todo.dependencies = safeParseJson(todo.dependencies);
      todo.attempt_log = safeParseJson(todo.attempt_log);
      todo.heartbeat_blockers = safeParseJson(todo.heartbeat_blockers);
    }

    return todo;
  }

  static findAllByAgent(agentId, filters = {}) {
    const db = getDb();
    const { status, priority, tags, projectId, isTemplate, title, includeArchived, limit = 100, offset = 0, source } = filters;

    let query = 'SELECT * FROM todos WHERE agent_id = ?';
    const params = [agentId];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (priority) {
      query += ' AND priority = ?';
      params.push(priority);
    }

    if (projectId) {
      query += ' AND project_id = ?';
      params.push(projectId);
    }

    if (isTemplate !== undefined) {
      query += ' AND is_template = ?';
      params.push(isTemplate ? 1 : 0);
    }

    if (tags && tags.length > 0) {
      const tagConditions = tags.map(() => 'tags LIKE ?').join(' OR ');
      query += ` AND (${tagConditions})`;
      tags.forEach(tag => params.push(`%"${tag}"%`));
    }

    if (title) {
      query += ' AND title LIKE ?';
      params.push(`%${title}%`);
    }

    if (!includeArchived) {
      query += ' AND (archived = 0 OR archived IS NULL)';
    }

    if (source === 'agent') {
      query += ' AND (origin_agent_id != ? OR assigned_agent_id = ?)';
      params.push(agentId, agentId);
    } else if (source === 'human') {
      query += ' AND origin_agent_id = ? AND (assigned_agent_id IS NULL OR assigned_agent_id = ?)';
      params.push(agentId, agentId);
    }

    query += ' ORDER BY CASE priority WHEN \'critical\' THEN 1 WHEN \'high\' THEN 2 WHEN \'medium\' THEN 3 ELSE 4 END, created_at DESC';
    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(query);
    const todos = stmt.all(...params);

    return todos.map(todo => ({
      ...todo,
      tags: safeParseJson(todo.tags),
      dependencies: safeParseJson(todo.dependencies),
      attempt_log: safeParseJson(todo.attempt_log),
      heartbeat_blockers: safeParseJson(todo.heartbeat_blockers)
    }));
  }

  static update(agentId, id, data) {
    const db = getDb();
    const {
      title,
      description,
      status,
      priority,
      context,
      tags,
      dependencies,
      projectId,
      parentId,
      position,
      acceptanceCriteria,
      criteriaConfirmed,
      maxAttempts,
      attemptCount,
      attemptLog,
      lastHeartbeat,
      heartbeatProgress,
      heartbeatStep,
      heartbeatBlockers,
      assignedAgentId,
      assignmentNote,
      schedule,
      isTemplate,
      expectedDurationMinutes,
      validationReport,
      validatedBy,
      validationCount,
      validationDeadline
    } = data;

    const updates = [];
    const values = [];

    if (title !== undefined) {
      updates.push('title = ?');
      values.push(title);
    }

    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }

    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);

      if (status === 'completed') {
        updates.push('completed_at = CURRENT_TIMESTAMP');
      } else {
        updates.push('completed_at = NULL');
      }
    }

    if (priority !== undefined) {
      updates.push('priority = ?');
      values.push(priority);
    }

    if (context !== undefined) {
      updates.push('context = ?');
      values.push(context);
    }

    if (tags !== undefined) {
      updates.push('tags = ?');
      values.push(JSON.stringify(tags));
    }

    if (dependencies !== undefined) {
      updates.push('dependencies = ?');
      values.push(JSON.stringify(dependencies));
    }

    if (projectId !== undefined) {
      updates.push('project_id = ?');
      values.push(projectId);
    }

    if (parentId !== undefined) {
      updates.push('parent_id = ?');
      values.push(parentId);
    }

    if (position !== undefined) {
      updates.push('position = ?');
      values.push(position);
    }

    if (acceptanceCriteria !== undefined) {
      updates.push('acceptance_criteria = ?');
      values.push(acceptanceCriteria);
    }

    if (criteriaConfirmed !== undefined) {
      updates.push('criteria_confirmed = ?');
      values.push(criteriaConfirmed ? 1 : 0);
    }

    if (maxAttempts !== undefined) {
      updates.push('max_attempts = ?');
      values.push(maxAttempts);
    }

    if (attemptCount !== undefined) {
      updates.push('attempt_count = ?');
      values.push(attemptCount);
    }

    if (attemptLog !== undefined) {
      updates.push('attempt_log = ?');
      values.push(JSON.stringify(attemptLog));
    }

    if (lastHeartbeat !== undefined) {
      updates.push('last_heartbeat = ?');
      values.push(lastHeartbeat);
    }

    if (heartbeatProgress !== undefined) {
      updates.push('heartbeat_progress = ?');
      values.push(heartbeatProgress);
    }

    if (heartbeatStep !== undefined) {
      updates.push('heartbeat_step = ?');
      values.push(heartbeatStep);
    }

    if (heartbeatBlockers !== undefined) {
      updates.push('heartbeat_blockers = ?');
      values.push(JSON.stringify(heartbeatBlockers));
    }

    if (assignedAgentId !== undefined) {
      updates.push('assigned_agent_id = ?');
      values.push(assignedAgentId);
      updates.push('assigned_at = CURRENT_TIMESTAMP');
    }

    if (assignmentNote !== undefined) {
      updates.push('assignment_note = ?');
      values.push(assignmentNote);
    }

    if (expectedDurationMinutes !== undefined) {
      updates.push('expected_duration_minutes = ?');
      values.push(expectedDurationMinutes);
    }

    if (validationReport !== undefined) {
      updates.push('validation_report = ?');
      values.push(validationReport);
    }

    if (validatedBy !== undefined) {
      updates.push('validated_by = ?');
      values.push(validatedBy);
    }

    if (validationCount !== undefined) {
      updates.push('validation_count = ?');
      values.push(validationCount);
    }

    if (validationDeadline !== undefined) {
      updates.push('validation_deadline = ?');
      values.push(validationDeadline);
    }

    if (schedule !== undefined) {
      updates.push('schedule = ?');
      values.push(schedule);
      // Recompute next_due_at when schedule changes
      if (schedule) {
        updates.push('next_due_at = ?');
        values.push(this.computeNextDueAt(schedule, new Date()));
      } else {
        updates.push('next_due_at = NULL');
        // Also clear template flag when schedule is removed
        updates.push('is_template = 0');
      }
    }

    if (isTemplate !== undefined) {
      updates.push('is_template = ?');
      values.push(isTemplate ? 1 : 0);
    }

    if (data.nextDueAt !== undefined) {
      updates.push('next_due_at = ?');
      values.push(data.nextDueAt);
    }

    if (data.lastSpawnedAt !== undefined) {
      updates.push('last_spawned_at = ?');
      values.push(data.lastSpawnedAt);
    }

    if (updates.length === 0) {
      return this.findById(agentId, id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id, agentId);

    const stmt = db.prepare(`
      UPDATE todos SET ${updates.join(', ')}
      WHERE id = ? AND agent_id = ?
    `);

    stmt.run(...values);

    return this.findById(agentId, id);
  }

  static delete(agentId, id) {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM todos WHERE id = ? AND agent_id = ?');
    const result = stmt.run(id, agentId);

    return result.changes > 0;
  }

  static complete(agentId, id) {
    return this.update(agentId, id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      heartbeatStep: '已完成',
      heartbeatBlockers: []
    });
  }

  static updateStatus(agentId, id, status) {
    return this.update(agentId, id, { status });
  }

  static getStats(agentId) {
    const db = getDb();

    const stmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_template = 0 THEN 1 ELSE 0 END) as active_tasks,
        SUM(CASE WHEN status = 'pending' AND is_template = 0 THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' AND is_template = 0 THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'completed' AND is_template = 0 THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'cancelled' AND is_template = 0 THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status = 'blocked' AND is_template = 0 THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN status = 'pending_validation' AND is_template = 0 THEN 1 ELSE 0 END) as pending_validation,
        SUM(CASE WHEN status = 'validating' AND is_template = 0 THEN 1 ELSE 0 END) as validating,
        SUM(CASE WHEN status = 'validation_failed' AND is_template = 0 THEN 1 ELSE 0 END) as validation_failed,
        SUM(CASE WHEN priority = 'critical' AND status NOT IN ('completed', 'cancelled') AND is_template = 0 THEN 1 ELSE 0 END) as critical_pending,
        SUM(CASE WHEN priority = 'high' AND status NOT IN ('completed', 'cancelled') AND is_template = 0 THEN 1 ELSE 0 END) as high_pending
      FROM todos
      WHERE agent_id = ?
    `);

    return stmt.get(agentId);
  }

  static search(agentId, query) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ?
        AND (title LIKE ? OR description LIKE ? OR context LIKE ?)
      ORDER BY created_at DESC
    `);

    const searchTerm = `%${query}%`;
    const todos = stmt.all(agentId, searchTerm, searchTerm, searchTerm);

    return todos.map(todo => ({
      ...todo,
      tags: safeParseJson(todo.tags),
      dependencies: safeParseJson(todo.dependencies)
    }));
  }

  static hasCircularDependency(agentId, todoId, newDependencies) {
    const db = getDb();

    if (todoId === 'new-todo' || !newDependencies || newDependencies.length === 0) {
      return false;
    }

    for (const depId of newDependencies) {
      const visited = new Set();
      const stack = [depId];

      while (stack.length > 0) {
        const currentId = stack.pop();

        if (currentId === todoId) {
          return true;
        }

        if (visited.has(currentId)) {
          continue;
        }

        visited.add(currentId);

        const stmt = db.prepare('SELECT dependencies FROM todos WHERE id = ? AND agent_id = ?');
        const row = stmt.get(currentId, agentId);

        if (row) {
          const deps = safeParseJson(row.dependencies);
          for (const d of deps) {
            if (!visited.has(d)) {
              stack.push(d);
            }
          }
        }
      }
    }

    return false;
  }

  static addDependency(agentId, todoId, dependencyId) {
    const todo = this.findById(agentId, todoId);
    if (!todo) {
      throw new Error('Todo not found');
    }

    const dependency = this.findById(agentId, dependencyId);
    if (!dependency) {
      throw new Error('Dependency todo not found');
    }

    const dependencies = [...todo.dependencies];
    if (!dependencies.includes(dependencyId)) {
      if (this.hasCircularDependency(agentId, todoId, [...dependencies, dependencyId])) {
        throw new Error('Circular dependency detected');
      }
      dependencies.push(dependencyId);
      return this.update(agentId, todoId, { dependencies });
    }

    return todo;
  }

  static removeDependency(agentId, todoId, dependencyId) {
    // Idempotent: return null if todo already gone
    const todo = this.findById(agentId, todoId);
    if (!todo) {
      return null;
    }

    const dependencies = todo.dependencies.filter(id => id !== dependencyId);
    return this.update(agentId, todoId, { dependencies });
  }

  static getReadyTasks(agentId) {
    const db = getDb();
    const allTodos = this.findAllByAgent(agentId, {});

    const completedOrCancelled = new Set(
      allTodos
        .filter(t => t.status === 'completed' || t.status === 'cancelled')
        .map(t => t.id)
    );

    return allTodos.filter(todo => {
      if (todo.status !== 'pending') {
        return false;
      }

      if (todo.dependencies.length === 0) {
        return true;
      }

      return todo.dependencies.every(depId => completedOrCancelled.has(depId));
    });
  }

  static getDependencyTree(agentId, todoId) {
    const buildTree = (id, visited = new Set()) => {
      if (visited.has(id)) {
        return { id, circular: true };
      }

      visited.add(id);
      const todo = this.findById(agentId, id);

      if (!todo) {
        return null;
      }

      const dependencies = todo.dependencies.map(depId => buildTree(depId, new Set(visited))).filter(Boolean);

      return {
        ...todo,
        dependencies
      };
    };

    return buildTree(todoId);
  }

  static getContextSummary(agentId) {
    const db = getDb();

    const allTodos = this.findAllByAgent(agentId, {});
    const stats = this.getStats(agentId);
    const readyTasks = this.getReadyTasks(agentId);
    const criticalTasks = allTodos.filter(t => t.priority === 'critical' && t.status !== 'completed' && t.status !== 'cancelled');

    const activeTasks = allTodos.filter(t => ['in_progress', 'validating', 'pending_validation'].includes(t.status));

    const todosByProject = {};
    allTodos.forEach(todo => {
      const projectId = todo.project_id || 'unassigned';
      if (!todosByProject[projectId]) {
        todosByProject[projectId] = [];
      }
      todosByProject[projectId].push(todo);
    });

    const allTags = new Set();
    allTodos.forEach(todo => {
      todo.tags.forEach(tag => allTags.add(tag));
    });

    const recentlyCompleted = allTodos
      .filter(t => t.status === 'completed')
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))
      .slice(0, 5);

    const blockedTasks = allTodos.filter(todo => {
      if (todo.status !== 'pending' || todo.dependencies.length === 0) {
        return false;
      }
      return !todo.dependencies.every(depId => {
        const dep = allTodos.find(t => t.id === depId);
        return dep && (dep.status === 'completed' || dep.status === 'cancelled');
      });
    });

    return {
      overview: {
        total: stats.active_tasks || stats.total,
        active: stats.pending + stats.in_progress + (stats.pending_validation || 0) + (stats.validating || 0),
        completed: stats.completed,
        blocked: blockedTasks.length
      },
      focus: {
        critical_count: stats.critical_pending,
        high_count: stats.high_pending,
        ready_to_start: readyTasks.length,
        currently_working_on: activeTasks.map(t => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          progress: t.heartbeat_progress || 0
        }))
      },
      priority_tasks: readyTasks
        .filter(t => t.priority === 'critical' || t.priority === 'high')
        .sort((a, b) => {
          const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
          return priorityOrder[a.priority] - priorityOrder[b.priority];
        })
        .slice(0, 5)
        .map(t => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          context: t.context
        })),
      blocked: blockedTasks.map(t => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        waiting_on: t.dependencies.map(depId => {
          const dep = allTodos.find(todo => todo.id === depId);
          return dep ? { id: dep.id, title: dep.title, status: dep.status } : null;
        }).filter(Boolean)
      })),
      projects: Object.keys(todosByProject).map(projectId => {
        if (projectId === 'unassigned') {
          return {
            id: 'unassigned',
            name: '未分配',
            todo_count: todosByProject[projectId].length,
            completed: todosByProject[projectId].filter(t => t.status === 'completed').length
          };
        }
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        return {
          id: projectId,
          name: project ? project.name : 'Unknown',
          color: project ? project.color : '#667eea',
          todo_count: todosByProject[projectId].length,
          completed: todosByProject[projectId].filter(t => t.status === 'completed').length
        };
      }),
      tags: Array.from(allTags),
      recently_completed: recentlyCompleted.map(t => ({
        id: t.id,
        title: t.title,
        completed_at: t.completed_at
      })),
      suggestion: this.generateSuggestion(stats, readyTasks, blockedTasks, criticalTasks)
    };
  }

  static generateSuggestion(stats, readyTasks, blockedTasks, criticalTasks) {
    const suggestions = [];

    if (criticalTasks.length > 0) {
      suggestions.push({
        type: 'critical',
        message: `⚠️ 有 ${criticalTasks.length} 个紧急任务需要处理`,
        priority: 1
      });
    }

    if (blockedTasks.length > 0) {
      suggestions.push({
        type: 'blocked',
        message: `🚧 ${blockedTasks.length} 个任务被阻塞，等待依赖任务完成`,
        priority: 2
      });
    }

    if (stats.high_pending > 0) {
      suggestions.push({
        type: 'high_priority',
        message: `📌 有 ${stats.high_pending} 个高优先级任务待处理`,
        priority: 3
      });
    }

    if (readyTasks.length > 0) {
      suggestions.push({
        type: 'ready',
        message: `✨ 有 ${readyTasks.length} 个任务可以立即开始`,
        priority: 4
      });
    }

    if (stats.completed > 0 && stats.pending === 0 && stats.in_progress === 0 && 
        (stats.pending_validation || 0) === 0 && (stats.validating || 0) === 0) {
      suggestions.push({
        type: 'all_done',
        message: `🎉 所有任务已完成！`,
        priority: 5
      });
    }

    return suggestions.sort((a, b) => a.priority - b.priority);
  }

  static updateHeartbeat(agentId, id, heartbeatData) {
    const db = getDb();
    const todo = this.findById(agentId, id);
    if (!todo) return null;

    const updates = ['last_heartbeat = CURRENT_TIMESTAMP', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [];

    if (heartbeatData.progress !== undefined) {
      updates.push('heartbeat_progress = ?');
      values.push(heartbeatData.progress);
    }
    if (heartbeatData.step !== undefined) {
      updates.push('heartbeat_step = ?');
      values.push(heartbeatData.step);
    }
    if (heartbeatData.blockers !== undefined) {
      updates.push('heartbeat_blockers = ?');
      values.push(JSON.stringify(heartbeatData.blockers));
    }

    values.push(id, agentId);

    const stmt = db.prepare(`
      UPDATE todos SET ${updates.join(', ')}
      WHERE id = ? AND agent_id = ?
    `);
    stmt.run(...values);
    return this.findById(agentId, id);
  }

  static recordAttempt(agentId, id, attemptResult) {
    const db = getDb();
    const todo = this.findById(agentId, id);
    if (!todo) return null;

    const logEntry = {
      timestamp: new Date().toISOString(),
      success: attemptResult.success,
      reason: attemptResult.reason || '',
      output: attemptResult.output || ''
    };

    const newLog = [...todo.attempt_log, logEntry];
    const newCount = todo.attempt_count + 1;

    let newStatus = todo.status;
    if (!attemptResult.success && newCount >= todo.max_attempts) {
      newStatus = 'blocked';
    }

    return this.update(agentId, id, {
      attemptCount: newCount,
      attemptLog: newLog,
      status: newStatus
    });
  }

  static findSubtasks(agentId, parentId) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM todos WHERE agent_id = ? AND parent_id = ? ORDER BY position ASC');
    const todos = stmt.all(agentId, parentId);
    return todos.map(todo => ({
      ...todo,
      tags: safeParseJson(todo.tags),
      dependencies: safeParseJson(todo.dependencies),
      attempt_log: safeParseJson(todo.attempt_log),
      heartbeat_blockers: safeParseJson(todo.heartbeat_blockers)
    }));
  }

  static checkAndCompleteParent(agentId, childId) {
    const db = getDb();
    const child = this.findById(agentId, childId);
    if (!child || !child.parent_id) return false;

    const parent = this.findById(agentId, child.parent_id);
    if (!parent || parent.status === 'completed') return false;

    const subtasks = this.findSubtasks(agentId, parent.id);
    const allCompleted = subtasks.length > 0 && subtasks.every(t => t.status === 'completed');

    if (allCompleted) {
      this.update(agentId, parent.id, { status: 'completed' });
      console.log(`[Todo] Parent task auto-completed: ${parent.title}`);
      return true;
    }

    return false;
  }

  static findStuckTasks(agentId, maxIdleMinutes = 30) {
    const db = getDb();
    const cutoff = new Date(Date.now() - maxIdleMinutes * 60 * 1000).toISOString();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ? AND status = 'in_progress'
        AND (last_heartbeat IS NULL OR last_heartbeat < ?)
    `);
    const todos = stmt.all(agentId, cutoff);
    return todos.map(todo => ({
      ...todo,
      tags: safeParseJson(todo.tags),
      dependencies: safeParseJson(todo.dependencies),
      attempt_log: safeParseJson(todo.attempt_log),
      heartbeat_blockers: safeParseJson(todo.heartbeat_blockers)
    }));
  }

  /**
   * 查找所有 in_progress 任务（用于动态阈值检测）
   */
  static findAllInProgress(agentId) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ? AND status IN ('in_progress', 'validating', 'pending_validation')
    `);
    const todos = stmt.all(agentId);
    return todos.map(todo => ({
      ...todo,
      tags: safeParseJson(todo.tags),
      dependencies: safeParseJson(todo.dependencies),
      attempt_log: safeParseJson(todo.attempt_log),
      heartbeat_blockers: safeParseJson(todo.heartbeat_blockers)
    }));
  }

  static findProgressStalledTasks(agentId, stallMinutes = 15) {
    const db = getDb();
    const cutoff = new Date(Date.now() - stallMinutes * 60 * 1000).toISOString();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ? AND status IN ('in_progress', 'validating', 'pending_validation')
        AND last_heartbeat IS NOT NULL
        AND last_heartbeat < ?
        AND (updated_at IS NULL OR updated_at < ?)
    `);
    const todos = stmt.all(agentId, cutoff, cutoff);
    return todos.map(todo => ({
      ...todo,
      tags: safeParseJson(todo.tags),
      dependencies: safeParseJson(todo.dependencies),
      attempt_log: safeParseJson(todo.attempt_log),
      heartbeat_blockers: safeParseJson(todo.heartbeat_blockers)
    }));
  }

  // ==================== 多智能体协作方法 ====================

  static assign(agentId, todoId, assignedAgentId, note = '') {
    const db = getDb();
    const todo = this.findById(agentId, todoId);
    if (!todo) throw new Error('Todo not found');

    const stmt = db.prepare(`
      UPDATE todos SET
        assigned_agent_id = ?,
        assignment_note = ?,
        assigned_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND agent_id = ?
    `);
    stmt.run(assignedAgentId, note, todoId, agentId);
    return this.findById(agentId, todoId);
  }

  static findAssignedToMe(agentId) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE assigned_agent_id = ? AND status != 'completed' AND status != 'cancelled'
      ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        created_at DESC
    `);
    const todos = stmt.all(agentId);
    return todos.map(todo => ({
      ...todo,
      tags: safeParseJson(todo.tags),
      dependencies: safeParseJson(todo.dependencies),
      attempt_log: safeParseJson(todo.attempt_log),
      heartbeat_blockers: safeParseJson(todo.heartbeat_blockers)
    }));
  }

  static findCreatedByMe(agentId) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE origin_agent_id = ?
      ORDER BY created_at DESC
    `);
    const todos = stmt.all(agentId);
    return todos.map(todo => ({
      ...todo,
      tags: safeParseJson(todo.tags),
      dependencies: safeParseJson(todo.dependencies),
      attempt_log: safeParseJson(todo.attempt_log),
      heartbeat_blockers: safeParseJson(todo.heartbeat_blockers)
    }));
  }

  static transfer(agentId, todoId, newAssignedAgentId, reason = '') {
    const db = getDb();
    const todo = this.findById(agentId, todoId);
    if (!todo) throw new Error('Todo not found');

    const stmt = db.prepare(`
      UPDATE todos SET
        assigned_agent_id = ?,
        transferred_from = ?,
        assignment_note = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND agent_id = ?
    `);
    stmt.run(newAssignedAgentId, todo.assigned_agent_id, reason, todoId, agentId);
    return this.findById(agentId, todoId);
  }

  // 归档超过 N 天的 completed/cancelled 任务（soft delete）
  static archiveOldCompleted(agentId, daysOld = 30) {
    const db = getDb();
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(`
      UPDATE todos SET archived = 1, updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ? AND status IN ('completed', 'cancelled')
        AND completed_at < ? AND (archived = 0 OR archived IS NULL)
    `);
    const result = stmt.run(agentId, cutoff);
    return result.changes;
  }

  // 物理删除已归档的任务（谨慎使用）
  static purgeArchived(agentId) {
    const db = getDb();
    const stmt = db.prepare(`
      DELETE FROM todos
      WHERE agent_id = ? AND archived = 1
    `);
    const result = stmt.run(agentId);
    return result.changes;
  }

  // ==================== 定时调度任务方法 ====================

  static findTemplates(agentId) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ? AND is_template = 1
      ORDER BY next_due_at ASC, created_at DESC
    `);
    const todos = stmt.all(agentId);
    return todos.map(todo => ({
      ...todo,
      tags: safeParseJson(todo.tags),
      dependencies: safeParseJson(todo.dependencies),
      attempt_log: safeParseJson(todo.attempt_log),
      heartbeat_blockers: safeParseJson(todo.heartbeat_blockers)
    }));
  }

  static findDueTemplates(agentId) {
    const db = getDb();
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ? AND is_template = 1
        AND next_due_at IS NOT NULL AND next_due_at <= ?
    `);
    const todos = stmt.all(agentId, now);
    return todos.map(todo => ({
      ...todo,
      tags: safeParseJson(todo.tags),
      dependencies: safeParseJson(todo.dependencies),
      attempt_log: safeParseJson(todo.attempt_log),
      heartbeat_blockers: safeParseJson(todo.heartbeat_blockers)
    }));
  }

  static spawnFromTemplate(agentId, templateId, options = {}) {
    const db = getDb();
    const template = this.findById(agentId, templateId);
    if (!template) throw new Error('Template not found');
    if (!template.is_template) throw new Error('Task is not a template');

    const { skipDedupe = false, replacesId = null, replaceExisting = false } = options;

    let replacedTask = null;

    if (!skipDedupe && replaceExisting) {
      const activeDup = db.prepare(`
        SELECT id, title, status, priority, created_at FROM todos
        WHERE agent_id = ? AND title = ? AND archived = 0
          AND status NOT IN ('completed', 'cancelled')
          AND id != ?
        LIMIT 1
      `).get(agentId, template.title, templateId);

      if (activeDup) {
        replacedTask = activeDup;
        db.prepare(`
          UPDATE todos SET
            status = 'cancelled',
            archived = 1,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND agent_id = ?
        `).run(activeDup.id, agentId);

        Context.create(agentId, {
          sessionId: 'scheduler',
          role: 'system',
          content: `[DailyScheduler] 旧任务「${template.title}」(ID: ${activeDup.id}) 被新实例替换，已自动归档`,
          metadata: { type: 'task_replaced', old_task_id: activeDup.id, template_id: templateId }
        });
      }
    }

    const newId = uuidv4();
    const assignedAt = template.assigned_agent_id ? new Date().toISOString() : null;
    const stmt = db.prepare(`
      INSERT INTO todos (
        id, agent_id, project_id, parent_id, title, description, priority,
        context, tags, dependencies, position,
        acceptance_criteria, criteria_confirmed, max_attempts,
        origin_agent_id, assigned_agent_id, assigned_at, schedule, is_template, status, created_at, updated_at,
        transferred_from
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
    `);

    stmt.run(
      newId, agentId, template.project_id, templateId,
      template.title, template.description || '', template.priority,
      template.context || '', JSON.stringify(template.tags || []), JSON.stringify(template.dependencies || []), template.position,
      template.acceptance_criteria || '', template.criteria_confirmed ? 1 : 0, template.max_attempts,
      agentId, template.assigned_agent_id || null, assignedAt, null, 0, 'pending',
      replacedTask ? replacedTask.id : (replacesId || null)
    );

    // Update template: last_spawned_at and next_due_at
    const nextDueAt = template.schedule
      ? this.computeNextDueAt(template.schedule, new Date())
      : null;

    const updateStmt = db.prepare(`
      UPDATE todos SET last_spawned_at = CURRENT_TIMESTAMP, next_due_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND agent_id = ?
    `);
    updateStmt.run(nextDueAt, templateId, agentId);

    const spawned = this.findById(agentId, newId);
    if (replacedTask) {
      spawned._replacedFrom = replacedTask;
    }
    return spawned;
  }

  static writeReport(agentId, taskId, reportData) {
    const db = getDb();
    const todo = this.findById(agentId, taskId);
    if (!todo) throw new Error('Task not found');

    const { status, description, context, heartbeatProgress, heartbeatStep, heartbeatBlockers } = reportData;

    const updates = [];
    const values = [];

    if (status) {
      updates.push('status = ?');
      values.push(status);
      if (status === 'completed') {
        updates.push('completed_at = CURRENT_TIMESTAMP');
      }
    }

    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }

    if (context !== undefined) {
      updates.push('context = ?');
      values.push(context);
    }

    if (heartbeatProgress !== undefined) {
      updates.push('heartbeat_progress = ?');
      values.push(heartbeatProgress);
    }

    if (heartbeatStep !== undefined) {
      updates.push('heartbeat_step = ?');
      values.push(heartbeatStep);
    }

    if (heartbeatBlockers !== undefined) {
      updates.push('heartbeat_blockers = ?');
      values.push(JSON.stringify(heartbeatBlockers));
    }

    if (updates.length === 0) {
      return this.findById(agentId, taskId);
    }

    updates.push('last_heartbeat = CURRENT_TIMESTAMP', 'updated_at = CURRENT_TIMESTAMP');
    values.push(taskId, agentId);

    const stmt = db.prepare(`
      UPDATE todos SET ${updates.join(', ')}
      WHERE id = ? AND agent_id = ?
    `);
    stmt.run(...values);
    return this.findById(agentId, taskId);
  }

  static findPendingByTemplate(agentId, templateId) {
    const db = getDb();
    const stmt = db.prepare(
      'SELECT * FROM todos WHERE agent_id = ? AND parent_id = ? AND status = ?'
    );
    const todos = stmt.all(agentId, templateId, 'pending');
    return todos.map(todo => ({
      ...todo,
      tags: safeParseJson(todo.tags),
      dependencies: safeParseJson(todo.dependencies),
      attempt_log: safeParseJson(todo.attempt_log),
      heartbeat_blockers: safeParseJson(todo.heartbeat_blockers)
    }));
  }

  static computeNextDueAt(schedule, fromTime) {
    if (!schedule) return null;

    const from = new Date(fromTime);

    // daily: next occurrence is exactly 24h later
    if (schedule === 'daily') {
      const next = new Date(from);
      next.setDate(next.getDate() + 1);
      return next.toISOString();
    }

    // weekly:mon,tue,wed — comma-separated day abbreviations
    if (schedule.startsWith('weekly:')) {
      const daysPart = schedule.slice(7);
      const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const targetDays = daysPart.split(',').map(d => dayMap[d.trim().toLowerCase()]).filter(v => v !== undefined);
      if (targetDays.length === 0) return null;

      const next = new Date(from);
      // Start checking from tomorrow
      for (let i = 1; i <= 8; i++) {
        next.setDate(next.getDate() + 1);
        if (targetDays.includes(next.getDay())) {
          return next.toISOString();
        }
      }
      return null;
    }

    // cron: expression — simple parser for standard cron (minute hour day month dow)
    // Also supports legacy raw cron expressions like "0 18 * * *"
    const cronExpr = schedule.startsWith('cron:') ? schedule.slice(5).trim() : schedule;
    const parts = cronExpr.split(/\s+/);
    if (parts.length === 5) {
      const minute = parseInt(parts[0], 10);
      const hour = parseInt(parts[1], 10);
      if (!isNaN(minute) && !isNaN(hour) && hour >= 0 && hour <= 23) {
        const next = new Date(from);
        next.setSeconds(0, 0);
        next.setMinutes(minute);
        next.setHours(hour);
        if (next <= from) {
          next.setDate(next.getDate() + 1);
        }
        return next.toISOString();
      }
    }

    return null;
  }
}

module.exports = Todo;
