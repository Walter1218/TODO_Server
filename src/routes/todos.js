const express = require('express');
const Agent = require('../models/Agent');
const Todo = require('../models/Todo');

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
    const { title, description, priority, context, tags, dependencies, projectId, position } = req.body;

    if (!title) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'TODO title is required'
      });
    }

    const validPriorities = ['low', 'medium', 'high', 'critical'];
    if (priority && !validPriorities.includes(priority)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid priority. Must be one of: low, medium, high, critical'
      });
    }

    if (dependencies !== undefined) {
      if (!Array.isArray(dependencies)) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Dependencies must be an array'
        });
      }

      for (const depId of dependencies) {
        if (!Todo.findById(agentId, depId)) {
          return res.status(400).json({
            error: 'Validation error',
            message: `Dependency todo not found: ${depId}`
          });
        }
      }

      for (const depId of dependencies) {
        if (Todo.hasCircularDependency(agentId, 'new-todo', [depId])) {
          return res.status(400).json({
            error: 'Validation error',
            message: `Circular dependency detected for dependency: ${depId}`
          });
        }
      }
    }

    const todo = Todo.create(agentId, {
      title,
      description,
      priority,
      context,
      tags,
      dependencies,
      projectId,
      position
    });

    res.status(201).json({
      success: true,
      data: todo
    });
  } catch (error) {
    console.error('Error creating TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create TODO'
    });
  }
});

router.get('/', (req, res) => {
  try {
    const { agentId } = req.params;
    const { status, priority, tags, limit, offset } = req.query;

    const filters = {};
    if (status) filters.status = status;
    if (priority) filters.priority = priority;
    if (tags) filters.tags = tags.split(',').map(t => t.trim());
    if (limit) filters.limit = parseInt(limit);
    if (offset) filters.offset = parseInt(offset);

    const todos = Todo.findAllByAgent(agentId, filters);

    res.json({
      success: true,
      data: todos,
      count: todos.length,
      filters
    });
  } catch (error) {
    console.error('Error fetching TODOs:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch TODOs'
    });
  }
});

router.get('/stats', (req, res) => {
  try {
    const { agentId } = req.params;
    const stats = Todo.getStats(agentId);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch stats'
    });
  }
});

router.get('/search', (req, res) => {
  try {
    const { agentId } = req.params;
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Search query parameter "q" is required'
      });
    }

    const todos = Todo.search(agentId, q);

    res.json({
      success: true,
      data: todos,
      count: todos.length,
      query: q
    });
  } catch (error) {
    console.error('Error searching TODOs:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to search TODOs'
    });
  }
});

router.get('/summary', (req, res) => {
  try {
    const { agentId } = req.params;
    const summary = Todo.getContextSummary(agentId);

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Error fetching context summary:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch context summary'
    });
  }
});

router.get('/ready', (req, res) => {
  try {
    const { agentId } = req.params;
    const readyTasks = Todo.getReadyTasks(agentId);

    res.json({
      success: true,
      data: readyTasks,
      count: readyTasks.length
    });
  } catch (error) {
    console.error('Error fetching ready tasks:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch ready tasks'
    });
  }
});

router.get('/:id', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const todo = Todo.findById(agentId, id);

    if (!todo) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    res.json({
      success: true,
      data: todo
    });
  } catch (error) {
    console.error('Error fetching TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch TODO'
    });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const { agentId, id } = req.params;

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    Todo.delete(agentId, id);

    res.json({
      success: true,
      message: 'TODO deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete TODO'
    });
  }
});

router.patch('/:id/complete', (req, res) => {
  try {
    const { agentId, id } = req.params;

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    const todo = Todo.complete(agentId, id);

    res.json({
      success: true,
      data: todo
    });
  } catch (error) {
    console.error('Error completing TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to complete TODO'
    });
  }
});

router.patch('/:id/status', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Status is required'
      });
    }

    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid status. Must be one of: pending, in_progress, completed, cancelled'
      });
    }

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    const todo = Todo.updateStatus(agentId, id, status);

    res.json({
      success: true,
      data: todo
    });
  } catch (error) {
    console.error('Error updating TODO status:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update TODO status'
    });
  }
});

router.post('/:id/dependencies', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { dependencyId } = req.body;

    if (!dependencyId) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'dependencyId is required'
      });
    }

    const todo = Todo.addDependency(agentId, id, dependencyId);

    res.json({
      success: true,
      data: todo
    });
  } catch (error) {
    console.error('Error adding dependency:', error);
    const statusCode = error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      error: 'Validation error',
      message: error.message
    });
  }
});

router.delete('/:id/dependencies/:depId', (req, res) => {
  try {
    const { agentId, id, depId } = req.params;

    const todo = Todo.removeDependency(agentId, id, depId);

    res.json({
      success: true,
      data: todo
    });
  } catch (error) {
    console.error('Error removing dependency:', error);
    res.status(400).json({
      error: 'Validation error',
      message: error.message
    });
  }
});

router.get('/:id/dependency-tree', (req, res) => {
  try {
    const { agentId, id } = req.params;

    const tree = Todo.getDependencyTree(agentId, id);

    if (!tree) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    res.json({
      success: true,
      data: tree
    });
  } catch (error) {
    console.error('Error fetching dependency tree:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch dependency tree'
    });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { title, description, status, priority, context, tags, dependencies, projectId, position } = req.body;

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid status. Must be one of: pending, in_progress, completed, cancelled'
      });
    }

    const validPriorities = ['low', 'medium', 'high', 'critical'];
    if (priority && !validPriorities.includes(priority)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid priority. Must be one of: low, medium, high, critical'
      });
    }

    if (dependencies !== undefined) {
      if (!Array.isArray(dependencies)) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Dependencies must be an array'
        });
      }

      for (const depId of dependencies) {
        if (!Todo.findById(agentId, depId)) {
          return res.status(400).json({
            error: 'Validation error',
            message: `Dependency todo not found: ${depId}`
          });
        }
      }

      if (Todo.hasCircularDependency(agentId, id, dependencies)) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Circular dependency detected'
        });
      }
    }

    const todo = Todo.update(agentId, id, {
      title,
      description,
      status,
      priority,
      context,
      tags,
      dependencies,
      projectId,
      position
    });

    res.json({
      success: true,
      data: todo
    });
  } catch (error) {
    console.error('Error updating TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update TODO'
    });
  }
});

module.exports = router;
