const express = require('express');
const Agent = require('../models/Agent');
const Project = require('../models/Project');

const router = express.Router({ mergeParams: true });

router.use((req, res, next) => {
  const { agentId } = req.params;

  if (!Agent.exists(agentId)) {
    return res.status(404).json({
      error: 'Not found',
      message: 'Agent not found'
    });
  }

  next();
});

router.post('/', (req, res) => {
  try {
    const { agentId } = req.params;
    const { name, description, color } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Project name is required'
      });
    }

    const project = Project.create(agentId, { name, description, color });

    res.status(201).json({
      success: true,
      data: project
    });
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create project'
    });
  }
});

router.get('/', (req, res) => {
  try {
    const { agentId } = req.params;
    const projects = Project.findAllByAgent(agentId);

    res.json({
      success: true,
      data: projects,
      count: projects.length
    });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch projects'
    });
  }
});

router.get('/:id', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const project = Project.findById(agentId, id);

    if (!project) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Project not found'
      });
    }

    res.json({
      success: true,
      data: project
    });
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch project'
    });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { name, description, color } = req.body;

    if (!Project.exists(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Project not found'
      });
    }

    const project = Project.update(agentId, id, { name, description, color });

    res.json({
      success: true,
      data: project
    });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update project'
    });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const { agentId, id } = req.params;

    // Idempotent: return success even if already deleted
    Project.delete(agentId, id);

    res.json({
      success: true,
      message: 'Project deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete project'
    });
  }
});

// --- 多智能体协作：全局项目看板 ---
router.get('/:id/board', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const Project = require('../models/Project');
    const Todo = require('../models/Todo');
    const db = require('../db').getDb();

    const project = Project.findById(agentId, id);
    if (!project) {
      return res.status(404).json({ error: 'Not found', message: 'Project not found' });
    }

    // 查询项目下所有任务（跨 agent）
    const stmt = db.prepare('SELECT * FROM todos WHERE project_id = ?');
    const allTodos = stmt.all(id);

    const parsedTodos = allTodos.map(t => ({
      ...t,
      tags: JSON.parse(t.tags || '[]'),
      dependencies: JSON.parse(t.dependencies || '[]')
    }));

    // 按执行者 agent 分组
    const tasksByAgent = {};
    parsedTodos.forEach(todo => {
      const execId = todo.assigned_agent_id || todo.agent_id || 'unassigned';
      if (!tasksByAgent[execId]) {
        tasksByAgent[execId] = [];
      }
      tasksByAgent[execId].push(todo);
    });

    // 获取 agent 名称映射
    const agentStmt = db.prepare('SELECT id, name FROM agents');
    const agents = agentStmt.all();
    const agentMap = {};
    agents.forEach(a => agentMap[a.id] = a.name);

    const grouped = Object.entries(tasksByAgent).map(([aid, tasks]) => ({
      agent_id: aid,
      agent_name: agentMap[aid] || aid,
      tasks: tasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        assigned_agent_id: t.assigned_agent_id
      })),
      task_count: tasks.length,
      completed_count: tasks.filter(t => t.status === 'completed').length
    }));

    const total = parsedTodos.length;
    const completed = parsedTodos.filter(t => t.status === 'completed').length;

    res.json({
      success: true,
      data: {
        project: { id: project.id, name: project.name, color: project.color },
        tasks_by_agent: grouped,
        overall_progress: total > 0 ? Math.round(completed / total * 100) : 0,
        total_tasks: total,
        completed_tasks: completed
      }
    });
  } catch (error) {
    console.error('Error fetching project board:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

module.exports = router;
