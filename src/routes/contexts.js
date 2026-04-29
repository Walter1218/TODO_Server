const express = require('express');
const Agent = require('../models/Agent');
const Context = require('../models/Context');

const router = express.Router({ mergeParams: true });

router.use((req, res, next) => {
  const { agentId } = req.params;
  if (!Agent.exists(agentId)) {
    return res.status(404).json({ error: 'Not found', message: 'Agent not found' });
  }
  next();
});

// POST /api/agents/:agentId/contexts — 保存对话消息
router.post('/', (req, res) => {
  try {
    const { agentId } = req.params;
    const { sessionId, role, content, metadata } = req.body;

    if (!sessionId || !role || !content) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'sessionId, role, and content are required'
      });
    }

    const validRoles = ['user', 'assistant', 'system'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'role must be one of: user, assistant, system'
      });
    }

    const ctx = Context.create(agentId, {
      sessionId,
      role,
      content,
      metadata
    });

    res.status(201).json({ success: true, data: ctx });
  } catch (error) {
    console.error('Error creating context:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// GET /api/agents/:agentId/contexts — 按 session 获取对话历史
router.get('/', (req, res) => {
  try {
    const { agentId } = req.params;
    const { sessionId, limit } = req.query;

    if (sessionId) {
      const contexts = Context.findBySession(agentId, sessionId, parseInt(limit) || 100);
      return res.json({ success: true, data: contexts, count: contexts.length });
    }

    // No sessionId: return recent across all sessions
    const contexts = Context.findRecentByAgent(agentId, parseInt(limit) || 50);
    res.json({ success: true, data: contexts, count: contexts.length });
  } catch (error) {
    console.error('Error fetching contexts:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// GET /api/agents/:agentId/contexts/summary — 获取会话摘要
router.get('/summary', (req, res) => {
  try {
    const { agentId } = req.params;
    const { sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'sessionId is required'
      });
    }

    const summary = Context.getSessionSummary(agentId, sessionId);
    res.json({ success: true, data: summary });
  } catch (error) {
    console.error('Error fetching context summary:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// DELETE /api/agents/:agentId/contexts — 清理指定 session 的对话
router.delete('/', (req, res) => {
  try {
    const { agentId } = req.params;
    const { sessionId, maxAgeDays } = req.query;

    if (sessionId) {
      const deleted = Context.deleteBySession(agentId, sessionId);
      return res.json({ success: true, deleted_count: deleted });
    }

    if (maxAgeDays) {
      const deleted = Context.pruneOldContexts(agentId, parseInt(maxAgeDays));
      return res.json({ success: true, deleted_count: deleted });
    }

    return res.status(400).json({
      error: 'Validation error',
      message: 'Either sessionId or maxAgeDays is required'
    });
  } catch (error) {
    console.error('Error deleting contexts:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

module.exports = router;
