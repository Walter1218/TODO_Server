const express = require('express');
const Agent = require('../models/Agent');

const router = express.Router();

router.post('/', (req, res) => {
  try {
    const { name, metadata } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Agent name is required'
      });
    }

    const agent = Agent.create({ name, metadata });

    res.status(201).json({
      success: true,
      data: agent
    });
  } catch (error) {
    console.error('Error creating agent:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create agent'
    });
  }
});

router.get('/', (req, res) => {
  try {
    const agents = Agent.findAll();

    res.json({
      success: true,
      data: agents,
      count: agents.length
    });
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch agents'
    });
  }
});

router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const agent = Agent.findById(id);

    if (!agent) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Agent not found'
      });
    }

    res.json({
      success: true,
      data: agent
    });
  } catch (error) {
    console.error('Error fetching agent:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch agent'
    });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, metadata } = req.body;

    if (!Agent.exists(id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Agent not found'
      });
    }

    const agent = Agent.update(id, { name, metadata });

    res.json({
      success: true,
      data: agent
    });
  } catch (error) {
    console.error('Error updating agent:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update agent'
    });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;

    if (!Agent.exists(id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Agent not found'
      });
    }

    Agent.delete(id);

    res.json({
      success: true,
      message: 'Agent deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting agent:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete agent'
    });
  }
});

module.exports = router;
