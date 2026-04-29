const express = require('express');
const Agent = require('../models/Agent');
const Notification = require('../models/Notification');

const router = express.Router({ mergeParams: true });

router.use((req, res, next) => {
  const { agentId } = req.params;
  if (!Agent.exists(agentId)) {
    return res.status(404).json({ error: 'Not found', message: 'Agent not found' });
  }
  next();
});

// GET /api/agents/:agentId/notifications
router.get('/', (req, res) => {
  try {
    const { agentId } = req.params;
    const { unreadOnly, limit } = req.query;
    const notifications = Notification.findByAgent(agentId, {
      unreadOnly: unreadOnly === 'true',
      limit: parseInt(limit) || 50
    });
    const unreadCount = Notification.getUnreadCount(agentId);

    res.json({
      success: true,
      data: notifications,
      count: notifications.length,
      unread_count: unreadCount
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// POST /api/agents/:agentId/notifications/:id/read
router.post('/:id/read', (req, res) => {
  try {
    const { id } = req.params;
    const notification = Notification.markAsRead(id);
    if (!notification) {
      return res.status(404).json({ error: 'Not found', message: 'Notification not found' });
    }
    res.json({ success: true, data: notification });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// POST /api/agents/:agentId/notifications/read-all
router.post('/read-all', (req, res) => {
  try {
    const { agentId } = req.params;
    const changed = Notification.markAllAsRead(agentId);
    res.json({ success: true, changed_count: changed });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

module.exports = router;
