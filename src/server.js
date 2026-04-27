const express = require('express');
const cors = require('cors');
const path = require('path');
const agentsRouter = require('./routes/agents');
const todosRouter = require('./routes/todos');
const projectsRouter = require('./routes/projects');
const { getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use('/api/agents', agentsRouter);
app.use('/api/agents/:agentId/todos', todosRouter);
app.use('/api/agents/:agentId/projects', projectsRouter);

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.url} not found`
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message
  });
});

app.listen(PORT, () => {
  console.log(`Agent TODO Server is running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API base URL: http://localhost:${PORT}/api`);

  try {
    getDb();
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
});

module.exports = app;
