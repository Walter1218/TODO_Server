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
  jest.resetModules();
});

const Agent = require('../src/models/Agent');
const Todo = require('../src/models/Todo');
const OpsBackfillService = require('../src/services/OpsBackfillService');
const OpsMetricsService = require('../src/services/OpsMetricsService');

describe('OpsBackfillService', () => {
  test('classifies stale pending and in-progress tasks into actionable failure buckets', () => {
    const now = Date.parse('2026-05-07T16:00:00Z');

    expect(OpsBackfillService.classifyTask({
      status: 'pending',
      created_at: '2026-05-07 14:00:00',
      updated_at: '2026-05-07 14:00:00',
      last_heartbeat: null,
      is_template: 0,
      archived: 0
    }, now)).toBe('not_started');

    expect(OpsBackfillService.classifyTask({
      status: 'in_progress',
      created_at: '2026-05-07 14:30:00',
      updated_at: '2026-05-07 15:00:00',
      last_heartbeat: null,
      is_template: 0,
      archived: 0
    }, now)).toBe('no_heartbeat');
  });

  test('backfills job runs and failure buckets for current active tasks', () => {
    const agent = Agent.create({ id: 'agent-1', name: 'Agent 1' });

    const pendingTask = Todo.create(agent.id, {
      title: '待启动修复任务',
      status: 'pending',
      priority: 'high'
    });
    db.prepare(`
      UPDATE todos
      SET created_at = ?, updated_at = ?
      WHERE id = ?
    `).run('2026-05-07 12:00:00', '2026-05-07 12:00:00', pendingTask.id);

    const activeTask = Todo.create(agent.id, {
      title: '执行中但无心跳任务',
      status: 'in_progress',
      priority: 'high'
    });
    db.prepare(`
      UPDATE todos
      SET created_at = ?, updated_at = ?, last_heartbeat = NULL
      WHERE id = ?
    `).run('2026-05-07 12:05:00', '2026-05-07 12:20:00', activeTask.id);

    const result = OpsBackfillService.backfillActiveRuns({ hours: 24 });

    expect(result.scannedTasks).toBe(2);
    expect(result.runsCreated).toBe(2);
    expect(result.bucketsAssigned).toBe(2);

    const refreshedPending = Todo.findById(agent.id, pendingTask.id);
    const refreshedActive = Todo.findById(agent.id, activeTask.id);
    expect(refreshedPending.failure_bucket).toBe('not_started');
    expect(refreshedActive.failure_bucket).toBe('no_heartbeat');

    const metrics = OpsMetricsService.getAgentMetrics(agent.id, { hours: 24 });
    expect(metrics.counts.spawned_jobs).toBe(2);
    expect(metrics.failure_buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bucket: 'not_started', count: 1 }),
        expect.objectContaining({ bucket: 'no_heartbeat', count: 1 })
      ])
    );
  });

  test('cancels stale auto-healing tasks when parent task is already terminal', () => {
    const agent = Agent.create({ id: 'agent-2', name: 'Agent 2' });
    const parent = Todo.create(agent.id, {
      title: '父任务',
      status: 'pending'
    });
    Todo.complete(agent.id, parent.id);

    const child = Todo.create(agent.id, {
      title: '[修复] 自动修复任务 for parent-1',
      status: 'in_progress',
      parentId: parent.id,
      assignedAgentId: agent.id
    });

    const result = OpsBackfillService.reconcileAutoHealingTasks();
    const refreshed = Todo.findById(agent.id, child.id);

    expect(result.cancelledChildren).toBe(1);
    expect(refreshed.status).toBe('cancelled');
    expect(refreshed.heartbeat_step).toContain('父任务已完成');
  });
});
