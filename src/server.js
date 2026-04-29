require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const agentsRouter = require('./routes/agents');
const todosRouter = require('./routes/todos');
const projectsRouter = require('./routes/projects');
const focusRouter = require('./routes/focus');
const contextsRouter = require('./routes/contexts');
const notificationsRouter = require('./routes/notifications');
const Agent = require('./models/Agent');
const { getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure logs directory exists
const logsDir = path.join(__dirname, '..', 'logs');
if (!require('fs').existsSync(logsDir)) {
  require('fs').mkdirSync(logsDir, { recursive: true });
}

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

// Auth middleware: verify X-Agent-Secret header matches agent's secret_key
// Supports cross-agent operations: if the secret belongs to ANY agent in the system,
// allow the request (for multi-agent collaboration)
function requireAgentAuth(req, res, next) {
  const agentId = req.params.agentId;
  const providedSecret = req.headers['x-agent-secret'];

  if (!agentId) {
    return next(); // No agent context, skip auth (e.g. POST /api/agents)
  }

  if (!providedSecret) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing X-Agent-Secret header'
    });
  }

  const storedSecret = Agent.getSecretKey(agentId);
  if (storedSecret && storedSecret === providedSecret) {
    return next(); // Direct match
  }

  // Cross-agent: check if secret belongs to any known agent
  const allAgents = Agent.findAll();
  const isKnownAgent = allAgents.some(a => a.secret_key === providedSecret);
  if (isKnownAgent) {
    return next();
  }

  // Agent not found → idempotent for DELETE, 404 for others
  if (!storedSecret && req.method === 'DELETE') {
    return res.status(200).json({ success: true, message: 'Agent not found or already deleted' });
  }

  if (!storedSecret) {
    return res.status(404).json({ error: 'Not found', message: 'Agent not found' });
  }

  return res.status(403).json({
    error: 'Forbidden',
    message: 'Invalid agent secret'
  });
}

// Mount auth middleware on agent-scoped routes
app.use('/api/agents/:agentId', requireAgentAuth);
app.use('/api/agents', agentsRouter);
app.use('/api/agents/:agentId/todos', todosRouter);
app.use('/api/agents/:agentId/projects', projectsRouter);
app.use('/api/agents/:agentId/focus', focusRouter);
app.use('/api/agents/:agentId/contexts', contextsRouter);
app.use('/api/agents/:agentId/notifications', notificationsRouter);

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
