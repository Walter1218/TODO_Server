const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

class Todo {
  static create(agentId, data) {
    const db = getDb();
    const id = uuidv4();
    const {
      title,
      description = '',
      priority = 'medium',
      context = '',
      tags = [],
      dependencies = [],
      projectId = null,
      position = 0
    } = data;

    const stmt = db.prepare(`
      INSERT INTO todos (id, agent_id, project_id, title, description, priority, context, tags, dependencies, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, agentId, projectId, title, description, priority, context, JSON.stringify(tags), JSON.stringify(dependencies), position);

    return this.findById(agentId, id);
  }

  static findById(agentId, id) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM todos WHERE id = ? AND agent_id = ?');
    const todo = stmt.get(id, agentId);

    if (todo) {
      todo.tags = JSON.parse(todo.tags || '[]');
      todo.dependencies = JSON.parse(todo.dependencies || '[]');
    }

    return todo;
  }

  static findAllByAgent(agentId, filters = {}) {
    const db = getDb();
    const { status, priority, tags, projectId, limit = 100, offset = 0 } = filters;

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

    if (tags && tags.length > 0) {
      const tagConditions = tags.map(() => 'tags LIKE ?').join(' OR ');
      query += ` AND (${tagConditions})`;
      tags.forEach(tag => params.push(`%"${tag}"%`));
    }

    query += ' ORDER BY CASE priority WHEN \'critical\' THEN 1 WHEN \'high\' THEN 2 WHEN \'medium\' THEN 3 ELSE 4 END, created_at DESC';
    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(query);
    const todos = stmt.all(...params);

    return todos.map(todo => ({
      ...todo,
      tags: JSON.parse(todo.tags || '[]'),
      dependencies: JSON.parse(todo.dependencies || '[]')
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
      position
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

    if (position !== undefined) {
      updates.push('position = ?');
      values.push(position);
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
      completed_at: new Date().toISOString()
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
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN priority = 'critical' AND status != 'completed' AND status != 'cancelled' THEN 1 ELSE 0 END) as critical_pending,
        SUM(CASE WHEN priority = 'high' AND status != 'completed' AND status != 'cancelled' THEN 1 ELSE 0 END) as high_pending
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
      tags: JSON.parse(todo.tags || '[]'),
      dependencies: JSON.parse(todo.dependencies || '[]')
    }));
  }

  static hasCircularDependency(agentId, todoId, newDependencies) {
    const db = getDb();
    const visited = new Set();
    const stack = [...newDependencies];

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
        const deps = JSON.parse(row.dependencies || '[]');
        stack.push(...deps);
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
    const todo = this.findById(agentId, todoId);
    if (!todo) {
      throw new Error('Todo not found');
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

    const activeTasks = allTodos.filter(t => t.status === 'in_progress');

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
        total: stats.total,
        active: stats.pending + stats.in_progress,
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
          progress: t.status
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

    if (stats.completed > 0 && stats.pending === 0 && stats.in_progress === 0) {
      suggestions.push({
        type: 'all_done',
        message: `🎉 所有任务已完成！`,
        priority: 5
      });
    }

    return suggestions.sort((a, b) => a.priority - b.priority);
  }
}

module.exports = Todo;
