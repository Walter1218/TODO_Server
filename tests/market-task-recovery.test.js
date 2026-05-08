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
const MarketTaskRecoveryService = require('../src/services/MarketTaskRecoveryService');

function createTestAgent(name = 'market-recovery-agent') {
  return Agent.create({
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name
  });
}

describe('MarketTaskRecoveryService', () => {
  let agent;

  beforeEach(() => {
    agent = createTestAgent();
  });

  test('getTodayLatestTasks picks latest today instance per market title', () => {
    const template = Todo.create(agent.id, {
      title: '每日 A股数据同步到 SQLite stock.db',
      isTemplate: true,
      schedule: 'cron:50 17 * * 1-5'
    });

    const oldTask = Todo.spawnFromTemplate(agent.id, template.id);
    const todayEarly = Todo.spawnFromTemplate(agent.id, template.id);
    const todayLatest = Todo.spawnFromTemplate(agent.id, template.id);

    db.prepare("UPDATE todos SET created_at = datetime('now', '-1 day') WHERE id = ?").run(oldTask.id);
    db.prepare("UPDATE todos SET created_at = datetime('now', '-10 minutes') WHERE id = ?").run(todayEarly.id);
    db.prepare("UPDATE todos SET created_at = datetime('now', '-1 minute') WHERE id = ?").run(todayLatest.id);

    const tasks = MarketTaskRecoveryService.getTodayLatestTasks(agent.id, ['每日 A股数据同步到 SQLite stock.db']);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(todayLatest.id);
    expect(tasks[0].id).not.toBe(oldTask.id);
    expect(tasks[0].id).not.toBe(todayEarly.id);
  });

  test('recoverTodayTasks archives sibling instances and drives active task', async () => {
    const template = Todo.create(agent.id, {
      title: '每日龙虎榜数据增量同步（top_list）',
      isTemplate: true,
      schedule: 'cron:35 17 * * 1-5'
    });

    const oldTask = Todo.spawnFromTemplate(agent.id, template.id);
    const currentTask = Todo.spawnFromTemplate(agent.id, template.id);
    db.prepare("UPDATE todos SET created_at = datetime('now', '-10 minutes') WHERE id = ?").run(oldTask.id);
    db.prepare("UPDATE todos SET created_at = datetime('now', '-1 minute') WHERE id = ?").run(currentTask.id);
    Todo.update(agent.id, oldTask.id, { status: 'blocked' });
    Todo.update(agent.id, currentTask.id, { status: 'pending' });

    const driveOrchestrator = {
      triggerTaskDrive: jest.fn().mockResolvedValue({
        queued: true,
        started: true,
        result: { success: true }
      })
    };

    const result = await MarketTaskRecoveryService.recoverTodayTasks(agent.id, driveOrchestrator, {
      titles: ['每日龙虎榜数据增量同步（top_list）']
    });

    expect(result.processed).toBe(1);
    expect(result.results[0].task_id).toBe(currentTask.id);
    expect(result.results[0].archived_siblings).toContain(oldTask.id);
    expect(Todo.findById(agent.id, oldTask.id).archived).toBe(1);
    expect(Todo.findById(agent.id, oldTask.id).status).toBe('cancelled');
    expect(driveOrchestrator.triggerTaskDrive).toHaveBeenCalledWith(agent.id, currentTask.id, expect.objectContaining({
      allowPendingChildren: true,
      waitForCompletion: true
    }));
  });

  test('recoverTodayTasks skips completed tasks', async () => {
    const template = Todo.create(agent.id, {
      title: '每日分红数据增量同步（dividend）',
      isTemplate: true,
      schedule: 'cron:15 17 * * 1-5'
    });

    const currentTask = Todo.spawnFromTemplate(agent.id, template.id);
    Todo.update(agent.id, currentTask.id, { status: 'completed' });

    const driveOrchestrator = {
      triggerTaskDrive: jest.fn()
    };

    const result = await MarketTaskRecoveryService.recoverTodayTasks(agent.id, driveOrchestrator, {
      titles: ['每日分红数据增量同步（dividend）']
    });

    expect(result.results[0].skipped).toBe(true);
    expect(result.results[0].reason).toBe('status_completed');
    expect(driveOrchestrator.triggerTaskDrive).not.toHaveBeenCalled();
  });

  test('recoverTodayTasks revives blocked tasks before driving', async () => {
    const template = Todo.create(agent.id, {
      title: '每日沪深港通数据增量同步（hsgt）',
      isTemplate: true,
      schedule: 'cron:25 17 * * 1-5'
    });

    const currentTask = Todo.spawnFromTemplate(agent.id, template.id);
    Todo.update(agent.id, currentTask.id, { status: 'blocked' });

    const driveOrchestrator = {
      triggerTaskDrive: jest.fn().mockResolvedValue({
        queued: true,
        started: true,
        result: { success: true }
      })
    };

    const result = await MarketTaskRecoveryService.recoverTodayTasks(agent.id, driveOrchestrator, {
      titles: ['每日沪深港通数据增量同步（hsgt）']
    });

    const refreshed = Todo.findById(agent.id, currentTask.id);
    expect(refreshed.status).toBe('in_progress');
    expect(refreshed.attempt_count).toBe(1);
    expect(result.results[0].before_status).toBe('in_progress');
    expect(driveOrchestrator.triggerTaskDrive).toHaveBeenCalledWith(agent.id, currentTask.id, expect.any(Object));
  });
});
