const { setupTestDb, clearAllTables, closeTestDb } = require('./setup');

let db;
beforeAll(() => {
  db = setupTestDb();
});

afterAll(() => {
  closeTestDb();
});

beforeEach(() => {
  clearAllTables(db);
});

const Agent = require('../src/models/Agent');
const Todo = require('../src/models/Todo');
const JobRunService = require('../src/services/JobRunService');
const OpsMetricsService = require('../src/services/OpsMetricsService');

function createTestAgent(name = 'ops-agent') {
  return Agent.create({
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name
  });
}

describe('OpsMetricsService', () => {
  test('aggregates run metrics and failure buckets', () => {
    const agent = createTestAgent();

    const completedTask = Todo.create(agent.id, { title: '完成任务', status: 'pending' });
    JobRunService.markSpawned(agent.id, completedTask, { metadata: { source: 'test' } });
    JobRunService.markDriveStarted(agent.id, completedTask, { source: 'test' });
    JobRunService.markHeartbeat(agent.id, completedTask, { source: 'test' });
    JobRunService.markPendingValidation(agent.id, completedTask, { source: 'test' });
    Todo.update(agent.id, completedTask.id, { status: 'completed' });
    JobRunService.markValidated(agent.id, Todo.findById(agent.id, completedTask.id), true, { source: 'test' });

    const failedTask = Todo.create(agent.id, { title: '失败任务', status: 'pending' });
    JobRunService.markSpawned(agent.id, failedTask, { metadata: { source: 'test' } });
    Todo.update(agent.id, failedTask.id, { status: 'blocked', failureBucket: 'tool_failure' });
    JobRunService.markFailure(agent.id, Todo.findById(agent.id, failedTask.id), 'tool_failure', { source: 'test' });

    const metrics = OpsMetricsService.getAgentMetrics(agent.id, { hours: 24 });

    expect(metrics.counts.spawned_jobs).toBe(2);
    expect(metrics.counts.completed_jobs).toBe(1);
    expect(metrics.counts.entered_validation_jobs).toBe(1);
    expect(metrics.counts.validation_passed_jobs).toBe(1);
    expect(metrics.ratios.completion_rate).toBe(0.5);
    expect(metrics.ratios.validation_pass_rate).toBe(1);
    expect(metrics.failure_buckets.some(item => item.bucket === 'tool_failure' && item.count === 1)).toBe(true);
  });
});
