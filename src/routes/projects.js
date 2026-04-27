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

    if (!Project.exists(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Project not found'
      });
    }

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

module.exports = router;
