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

function createTestAgent(name = 'test-agent') {
  return Agent.create({ id: `agent-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, name });
}

describe('Todo CRUD', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('create and find todo', () => {
    const todo = Todo.create(agent.id, { title: 'Test Task', priority: 'high' });
    expect(todo).toBeDefined();
    expect(todo.title).toBe('Test Task');
    expect(todo.priority).toBe('high');
    expect(todo.status).toBe('pending');

    const found = Todo.findById(agent.id, todo.id);
    expect(found).toBeDefined();
    expect(found.title).toBe('Test Task');
  });

  test('create todo with default values', () => {
    const todo = Todo.create(agent.id, { title: 'Default Values' });
    expect(todo.priority).toBe('medium');
    expect(todo.status).toBe('pending');
    expect(todo.max_attempts).toBe(3);
    expect(todo.attempt_count).toBe(0);
  });

  test('update todo fields', () => {
    const todo = Todo.create(agent.id, { title: 'Original' });
    const updated = Todo.update(agent.id, todo.id, {
      title: 'Updated',
      priority: 'critical',
      status: 'in_progress'
    });
    expect(updated.title).toBe('Updated');
    expect(updated.priority).toBe('critical');
    expect(updated.status).toBe('in_progress');
  });

  test('persists task_spec and clones it from template to spawned task', () => {
    const template = Todo.create(agent.id, {
      title: '每日资金流向数据增量同步（moneyflow）',
      schedule: '5 17 * * 1-5',
      isTemplate: true,
      taskSpec: {
        kind: 'data_task',
        engine: 'duckdb',
        path: '/tmp/example.duckdb',
        checks: [{ label: 'x', sql: 'SELECT 1 AS passed' }]
      }
    });

    const foundTemplate = Todo.findById(agent.id, template.id);
    const spawned = Todo.spawnFromTemplate(agent.id, template.id);

    expect(foundTemplate.task_spec).toBeTruthy();
    expect(foundTemplate.task_spec.kind).toBe('data_task');
    expect(spawned.task_spec).toBeTruthy();
    expect(spawned.task_spec.path).toContain('tushare_moneyflow.duckdb');
  });

  test('findById refreshes stale data-task task_spec to canonical preset', () => {
    const todo = Todo.create(agent.id, {
      title: '每日龙虎榜数据增量同步（top_list）',
      taskSpec: {
        kind: 'data_task',
        engine: 'duckdb',
        path: '/tmp/legacy.duckdb',
        target: { table: 'legacy_top_list' },
        checks: [{
          label: 'legacy_latest_date',
          sql: "SELECT CAST(MAX(trade_date) AS VARCHAR) >= strftime(CURRENT_DATE - INTERVAL 1 DAY, '%Y%m%d') AS passed FROM legacy_top_list"
        }]
      }
    });

    const refreshed = Todo.findById(agent.id, todo.id);

    expect(refreshed.task_spec.path).toContain('tushare_toplist.duckdb');
    expect(refreshed.task_spec.target.table).toBe('fact_top_list');
    expect(refreshed.task_spec.checks[0].sql).toContain('CURRENT_DATE - INTERVAL 0 DAY');
  });

  test('spawnFromTemplate stores last_spawned_at in ISO format', () => {
    const template = Todo.create(agent.id, {
      title: '每日龙虎榜数据增量同步（top_list）',
      schedule: '10 17 * * 1-5',
      isTemplate: true
    });

    Todo.spawnFromTemplate(agent.id, template.id);
    const refreshed = Todo.findById(agent.id, template.id);

    expect(refreshed.last_spawned_at).toMatch(/T/);
    expect(refreshed.last_spawned_at).toMatch(/Z$/);
  });

  test('archiveSiblingActiveInstances keeps current instance and archives other active siblings', () => {
    const template = Todo.create(agent.id, {
      title: '每日 A股数据同步到 SQLite stock.db',
      schedule: '50 17 * * 1-5',
      isTemplate: true
    });

    const old1 = Todo.spawnFromTemplate(agent.id, template.id);
    const old2 = Todo.spawnFromTemplate(agent.id, template.id);
    const current = Todo.spawnFromTemplate(agent.id, template.id);

    Todo.update(agent.id, old1.id, { status: 'in_progress' });
    Todo.update(agent.id, old2.id, { status: 'blocked' });
    Todo.update(agent.id, current.id, { status: 'pending' });

    const archived = Todo.archiveSiblingActiveInstances(agent.id, current.id);

    expect(archived.map(t => t.id).sort()).toEqual([old1.id, old2.id].sort());
    expect(Todo.findById(agent.id, current.id).status).toBe('pending');
    expect(Todo.findById(agent.id, old1.id).status).toBe('cancelled');
    expect(Todo.findById(agent.id, old1.id).archived).toBe(1);
    expect(Todo.findById(agent.id, old2.id).status).toBe('cancelled');
    expect(Todo.findById(agent.id, old2.id).archived).toBe(1);
  });

  test('delete todo', () => {
    const todo = Todo.create(agent.id, { title: 'To Delete' });
    const deleted = Todo.delete(agent.id, todo.id);
    expect(deleted).toBe(true);
    expect(Todo.findById(agent.id, todo.id)).toBeUndefined();
  });

  test('delete non-existent todo returns false', () => {
    const deleted = Todo.delete(agent.id, 'non-existent-id');
    expect(deleted).toBe(false);
  });

  test('complete todo sets completed_at', () => {
    const todo = Todo.create(agent.id, { title: 'Complete Me' });
    const completed = Todo.complete(agent.id, todo.id);
    expect(completed.status).toBe('completed');
    expect(completed.completed_at).toBeTruthy();
  });

  test('find todos by agent with filters', () => {
    Todo.create(agent.id, { title: 'Task 1', priority: 'high' });
    const t2 = Todo.create(agent.id, { title: 'Task 2', priority: 'low' });
    Todo.complete(agent.id, t2.id);
    Todo.create(agent.id, { title: 'Task 3', priority: 'high' });

    const highPending = Todo.findAllByAgent(agent.id, { priority: 'high', status: 'pending' });
    expect(highPending.length).toBe(2);

    const completed = Todo.findAllByAgent(agent.id, { status: 'completed' });
    expect(completed.length).toBe(1);
  });

  test('find todos by agent with todayOnly excludes historical instances', () => {
    const todayTask = Todo.create(agent.id, { title: 'Today Task' });
    const oldTask = Todo.create(agent.id, { title: 'Old Task' });
    db.prepare("UPDATE todos SET created_at = datetime('now', '-1 day') WHERE id = ?").run(oldTask.id);

    const todos = Todo.findAllByAgent(agent.id, { todayOnly: true });

    expect(todos.map(t => t.id)).toContain(todayTask.id);
    expect(todos.map(t => t.id)).not.toContain(oldTask.id);
  });

  test('search todos by text', () => {
    Todo.create(agent.id, { title: 'Deploy to production', description: 'Run the deploy script' });
    Todo.create(agent.id, { title: 'Write unit tests', description: 'Test the API endpoints' });

    const results = Todo.search(agent.id, 'deploy');
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Deploy to production');
  });

  test('get stats', () => {
    Todo.create(agent.id, { title: 'P1', priority: 'critical' });
    Todo.create(agent.id, { title: 'P2', priority: 'high' });
    Todo.create(agent.id, { title: 'P3', priority: 'medium' });

    const t3 = Todo.create(agent.id, { title: 'P4' });
    Todo.update(agent.id, t3.id, { status: 'in_progress' });
    const t4 = Todo.create(agent.id, { title: 'P5' });
    Todo.complete(agent.id, t4.id);

    const stats = Todo.getStats(agent.id);
    expect(stats.total).toBe(5);
    expect(stats.pending).toBe(3);
    expect(stats.in_progress).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.critical_pending).toBe(1);
  });

  test('get stats excludes archived history from total and active counts', () => {
    const active = Todo.create(agent.id, { title: 'Active Task', priority: 'high' });
    const archivedCompleted = Todo.create(agent.id, { title: 'Archived Completed' });
    Todo.complete(agent.id, archivedCompleted.id);
    Todo.update(agent.id, archivedCompleted.id, { archived: true });
    const archivedPending = Todo.create(agent.id, { title: 'Archived Pending' });
    Todo.update(agent.id, archivedPending.id, { archived: true });

    const stats = Todo.getStats(agent.id);
    expect(stats.total).toBe(1);
    expect(stats.active_tasks).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.completed).toBe(0);
    expect(Todo.findById(agent.id, active.id).title).toBe('Active Task');
  });
});

describe('Circular Dependency Detection', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('no circular dependency with empty dependencies', () => {
    expect(Todo.hasCircularDependency(agent.id, 'any-id', [])).toBe(false);
    expect(Todo.hasCircularDependency(agent.id, 'any-id', null)).toBe(false);
  });

  test('no circular dependency for new todo', () => {
    const t1 = Todo.create(agent.id, { title: 'Task 1' });
    expect(Todo.hasCircularDependency(agent.id, 'new-todo', [t1.id])).toBe(false);
  });

  test('detect direct circular dependency', () => {
    const t1 = Todo.create(agent.id, { title: 'Task 1' });
    const t2 = Todo.create(agent.id, { title: 'Task 2', dependencies: [t1.id] });

    expect(Todo.hasCircularDependency(agent.id, t1.id, [t2.id])).toBe(true);
  });

  test('detect indirect circular dependency (A->B->C->A)', () => {
    const t1 = Todo.create(agent.id, { title: 'Task A' });
    const t2 = Todo.create(agent.id, { title: 'Task B', dependencies: [t1.id] });
    const t3 = Todo.create(agent.id, { title: 'Task C', dependencies: [t2.id] });

    expect(Todo.hasCircularDependency(agent.id, t1.id, [t3.id])).toBe(true);
  });

  test('no circular dependency for independent tasks', () => {
    const t1 = Todo.create(agent.id, { title: 'Task 1' });
    const t2 = Todo.create(agent.id, { title: 'Task 2' });
    const t3 = Todo.create(agent.id, { title: 'Task 3' });

    expect(Todo.hasCircularDependency(agent.id, t1.id, [t2.id])).toBe(false);
    expect(Todo.hasCircularDependency(agent.id, t1.id, [t3.id])).toBe(false);
  });

  test('add dependency with circular check', () => {
    const t1 = Todo.create(agent.id, { title: 'Task 1' });
    const t2 = Todo.create(agent.id, { title: 'Task 2', dependencies: [t1.id] });

    expect(() => Todo.addDependency(agent.id, t1.id, t2.id)).toThrow('Circular dependency detected');
  });

  test('add valid dependency', () => {
    const t1 = Todo.create(agent.id, { title: 'Task 1' });
    const t2 = Todo.create(agent.id, { title: 'Task 2' });

    const updated = Todo.addDependency(agent.id, t2.id, t1.id);
    expect(updated.dependencies).toContain(t1.id);
  });

  test('remove dependency', () => {
    const t1 = Todo.create(agent.id, { title: 'Task 1' });
    const t2 = Todo.create(agent.id, { title: 'Task 2', dependencies: [t1.id] });

    const updated = Todo.removeDependency(agent.id, t2.id, t1.id);
    expect(updated.dependencies).not.toContain(t1.id);
  });
});

describe('Dependency Tree', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('build dependency tree', () => {
    const t1 = Todo.create(agent.id, { title: 'Root' });
    const t2 = Todo.create(agent.id, { title: 'Child 1', dependencies: [t1.id] });
    const t3 = Todo.create(agent.id, { title: 'Child 2', dependencies: [t1.id] });

    const tree = Todo.getDependencyTree(agent.id, t3.id);
    expect(tree).toBeDefined();
    expect(tree.title).toBe('Child 2');
    expect(tree.dependencies.length).toBe(1);
    expect(tree.dependencies[0].title).toBe('Root');
  });

  test('get ready tasks', () => {
    const t1 = Todo.create(agent.id, { title: 'Independent' });
    const t2 = Todo.create(agent.id, { title: 'Blocked', dependencies: ['non-existent'] });

    const ready = Todo.getReadyTasks(agent.id);
    expect(ready.length).toBe(1);
    expect(ready[0].title).toBe('Independent');
  });
});

describe('Heartbeat and Retry', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('update heartbeat', () => {
    const todo = Todo.create(agent.id, { title: 'Heartbeat Task' });
    const updated = Todo.updateHeartbeat(agent.id, todo.id, {
      progress: 50,
      step: 'Testing',
      blockers: ['Waiting for review']
    });

    expect(updated.heartbeat_progress).toBe(50);
    expect(updated.heartbeat_step).toBe('Testing');
    expect(updated.heartbeat_blockers).toContain('Waiting for review');
    expect(updated.last_heartbeat).toBeTruthy();

    const run = db.prepare('SELECT * FROM job_runs WHERE task_id = ?').get(todo.id);
    expect(run).toBeDefined();
    expect(run.first_heartbeat_at).toBeTruthy();
  });

  test('record successful attempt', () => {
    const todo = Todo.create(agent.id, { title: 'Retry Task' });
    const updated = Todo.recordAttempt(agent.id, todo.id, {
      success: true,
      reason: 'Worked first time',
      output: 'Done'
    });

    expect(updated.attempt_count).toBe(1);
    expect(updated.attempt_log.length).toBe(1);
    expect(updated.attempt_log[0].success).toBe(true);
  });

  test('record failed attempts and block', () => {
    const todo = Todo.create(agent.id, { title: 'Fail Task', maxAttempts: 2 });

    Todo.recordAttempt(agent.id, todo.id, { success: false, reason: 'Error 1' });
    const blocked = Todo.recordAttempt(agent.id, todo.id, { success: false, reason: 'Error 2' });

    expect(blocked.status).toBe('blocked');
    expect(blocked.attempt_count).toBe(2);
    expect(blocked.failure_bucket).toBe('tool_failure');

    const run = db.prepare('SELECT * FROM job_runs WHERE task_id = ?').get(todo.id);
    expect(run.final_status).toBe('blocked');
    expect(run.failure_bucket).toBe('tool_failure');
  });
});

describe('Job run state sync', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('completed todo clears failure bucket and records completion time', () => {
    const todo = Todo.create(agent.id, { title: 'Complete with run sync' });
    Todo.update(agent.id, todo.id, { status: 'blocked', failureBucket: 'tool_failure' });

    const completed = Todo.update(agent.id, todo.id, { status: 'completed' });
    const run = db.prepare('SELECT * FROM job_runs WHERE task_id = ?').get(todo.id);

    expect(completed.status).toBe('completed');
    expect(completed.failure_bucket).toBeNull();
    expect(run.final_status).toBe('completed');
    expect(run.failure_bucket).toBeNull();
    expect(run.completed_at).toBeTruthy();
  });
});

describe('Subtasks', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('create and find subtasks', () => {
    const parent = Todo.create(agent.id, { title: 'Parent' });
    Todo.create(agent.id, { title: 'Child 1', parentId: parent.id });
    Todo.create(agent.id, { title: 'Child 2', parentId: parent.id });

    const subtasks = Todo.findSubtasks(agent.id, parent.id);
    expect(subtasks.length).toBe(2);
  });

  test('auto-complete parent when all subtasks done', () => {
    const parent = Todo.create(agent.id, { title: 'Parent' });
    const child1 = Todo.create(agent.id, { title: 'Child 1', parentId: parent.id });
    const child2 = Todo.create(agent.id, { title: 'Child 2', parentId: parent.id });

    Todo.complete(agent.id, child1.id);
    Todo.complete(agent.id, child2.id);

    const parentCompleted = Todo.checkAndCompleteParent(agent.id, child2.id);
    expect(parentCompleted).toBe(true);

    const parentNow = Todo.findById(agent.id, parent.id);
    expect(parentNow.status).toBe('completed');
  });
});

describe('Archive', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('archive old completed tasks', () => {
    const t1 = Todo.create(agent.id, { title: 'Old Task' });
    Todo.complete(agent.id, t1.id);
    const t2 = Todo.create(agent.id, { title: 'Active Task' });

    const archived = Todo.archiveOldCompleted(agent.id, 0);
    expect(archived).toBe(1);
  });

  test('purge archived tasks', () => {
    const t1 = Todo.create(agent.id, { title: 'To Archive' });
    Todo.complete(agent.id, t1.id);
    Todo.archiveOldCompleted(agent.id, 0);

    const purged = Todo.purgeArchived(agent.id);
    expect(purged).toBe(1);
  });
});

describe('Templates and Scheduling', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('create template task with schedule auto-sets isTemplate', () => {
    const template = Todo.create(agent.id, {
      title: 'Daily Standup',
      schedule: 'daily'
    });
    expect(template.is_template).toBe(1);
    expect(template.next_due_at).toBeTruthy();
  });

  test('spawn from template', () => {
    const template = Todo.create(agent.id, {
      title: 'Weekly Report',
      schedule: 'weekly:fri',
      isTemplate: true
    });

    const spawned = Todo.spawnFromTemplate(agent.id, template.id);
    expect(spawned).toBeDefined();
    expect(spawned.title).toBe('Weekly Report');
    expect(spawned.is_template).toBe(0);
    expect(spawned.status).toBe('pending');
  });

  test('spawn from template sets parent_id to template', () => {
    const template = Todo.create(agent.id, {
      title: 'Daily Check',
      schedule: 'daily',
      isTemplate: true,
      description: 'Check all services'
    });

    const spawned = Todo.spawnFromTemplate(agent.id, template.id);
    expect(spawned.parent_id).toBe(template.id);
  });

  test('spawn from template inherits description and context', () => {
    const template = Todo.create(agent.id, {
      title: 'Health Check',
      schedule: 'cron:0 9 * * *',
      isTemplate: true,
      description: 'Check system health',
      context: 'production env'
    });

    const spawned = Todo.spawnFromTemplate(agent.id, template.id);
    expect(spawned.description).toBe('Check system health');
    expect(spawned.context).toBe('production env');
  });

  test('findPendingByTemplate returns pending spawned tasks', () => {
    const template = Todo.create(agent.id, {
      title: 'Patrol',
      schedule: 'daily',
      isTemplate: true
    });

    Todo.spawnFromTemplate(agent.id, template.id);
    Todo.spawnFromTemplate(agent.id, template.id);

    const pending = Todo.findPendingByTemplate(agent.id, template.id);
    expect(pending.length).toBe(2);
    expect(pending[0].parent_id).toBe(template.id);
  });

  test('findPendingByTemplate excludes completed tasks', () => {
    const template = Todo.create(agent.id, {
      title: 'Patrol',
      schedule: 'daily',
      isTemplate: true
    });

    const s1 = Todo.spawnFromTemplate(agent.id, template.id);
    Todo.spawnFromTemplate(agent.id, template.id);
    Todo.updateStatus(agent.id, s1.id, 'completed');

    const pending = Todo.findPendingByTemplate(agent.id, template.id);
    expect(pending.length).toBe(1);
  });

  test('writeReport updates description and context', () => {
    const template = Todo.create(agent.id, {
      title: 'Health Check',
      schedule: 'daily',
      isTemplate: true,
      description: 'Check health'
    });

    const spawned = Todo.spawnFromTemplate(agent.id, template.id);
    const updated = Todo.writeReport(agent.id, spawned.id, {
      status: 'completed',
      description: 'All services healthy',
      context: 'CPU 20%, Memory 45%'
    });

    expect(updated.status).toBe('completed');
    expect(updated.description).toBe('All services healthy');
    expect(updated.context).toBe('CPU 20%, Memory 45%');
    expect(updated.completed_at).toBeTruthy();
  });

  test('writeReport partial update preserves other fields', () => {
    const template = Todo.create(agent.id, {
      title: 'Check',
      schedule: 'daily',
      isTemplate: true,
      description: 'Original desc'
    });

    const spawned = Todo.spawnFromTemplate(agent.id, template.id);
    const updated = Todo.writeReport(agent.id, spawned.id, {
      heartbeatProgress: 50,
      heartbeatStep: 'Running checks'
    });

    expect(updated.description).toBe('Original desc');
    expect(updated.heartbeat_progress).toBe(50);
    expect(updated.heartbeat_step).toBe('Running checks');
  });

  test('writeReport throws for non-existent task', () => {
    expect(() => Todo.writeReport(agent.id, 'non-existent', { status: 'completed' }))
      .toThrow('Task not found');
  });

  test('computeNextDueAt daily', () => {
    const now = new Date('2025-01-15T10:00:00Z');
    const next = Todo.computeNextDueAt('daily', now);
    const expected = new Date('2025-01-16T10:00:00Z');
    expect(new Date(next).toISOString().split('T')[0]).toBe(expected.toISOString().split('T')[0]);
  });

  test('computeNextDueAt weekly', () => {
    const now = new Date('2025-01-13T10:00:00Z');
    const next = Todo.computeNextDueAt('weekly:fri', now);
    expect(new Date(next).getDay()).toBe(5);
  });

  test('computeNextDueAt cron', () => {
    const now = new Date('2025-01-15T10:00:00Z');
    const next = Todo.computeNextDueAt('cron:0 9 * * *', now);
    const d = new Date(next);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  test('computeNextDueAt cron respects weekday constraints in local time', () => {
    const wednesdayAfternoon = new Date('2025-01-15T13:00:00+08:00');
    const next = Todo.computeNextDueAt('cron:0 9 * * 1', wednesdayAfternoon);
    const due = new Date(next);

    expect(due.getDay()).toBe(1);
    expect(due.getHours()).toBe(9);
    expect(due.getMinutes()).toBe(0);
    expect(due.getTime()).toBeGreaterThan(wednesdayAfternoon.getTime());
  });

  test('findDueTemplates reconciles stale next_due_at before deciding due', () => {
    const template = Todo.create(agent.id, {
      title: 'Local-time gated template',
      schedule: '5 17 * * 1-5',
      isTemplate: true
    });

    db.prepare(`
      UPDATE todos
      SET last_spawned_at = ?, next_due_at = ?
      WHERE id = ? AND agent_id = ?
    `).run('2026-05-07 04:31:32', '2026-05-07T03:05:00.000Z', template.id, agent.id);

    const dueTemplates = Todo.findDueTemplates(agent.id, new Date('2026-05-07T13:06:49+08:00'), { reconcile: true });
    const refreshed = Todo.findById(agent.id, template.id);

    expect(dueTemplates.map(t => t.id)).not.toContain(template.id);
    expect(refreshed.next_due_at).toBe('2026-05-07T09:05:00.000Z');
  });

  test('findDueTemplates skips cross-day catch-up for market-close templates', () => {
    const template = Todo.create(agent.id, {
      title: '每日资金流向数据增量同步（moneyflow）',
      schedule: '5 17 * * 1-5',
      isTemplate: true,
      description: '每日收盘后同步 A股资金流向数据'
    });

    db.prepare(`
      UPDATE todos
      SET last_spawned_at = ?, next_due_at = ?
      WHERE id = ? AND agent_id = ?
    `).run('2026-05-07 07:24:11', '2026-05-07T09:05:00.000Z', template.id, agent.id);

    const dueTemplates = Todo.findDueTemplates(agent.id, new Date('2026-05-08T01:07:49+08:00'), { reconcile: true });
    const refreshed = Todo.findById(agent.id, template.id);

    expect(dueTemplates.map(t => t.id)).not.toContain(template.id);
    expect(refreshed.next_due_at).toBe('2026-05-08T09:05:00.000Z');
  });

  test('findDueTemplates skips cross-day catch-up for top_list templates after SQLite-style timestamps', () => {
    const template = Todo.create(agent.id, {
      title: '每日龙虎榜数据增量同步（top_list）',
      schedule: '10 17 * * 1-5',
      isTemplate: true,
      description: '每日收盘后同步龙虎榜数据'
    });

    db.prepare(`
      UPDATE todos
      SET last_spawned_at = ?, next_due_at = ?
      WHERE id = ? AND agent_id = ?
    `).run('2026-05-07 09:21:45', '2026-05-07T09:10:00.000Z', template.id, agent.id);

    const dueTemplates = Todo.findDueTemplates(agent.id, new Date('2026-05-08T01:21:00+08:00'), { reconcile: true });
    const refreshed = Todo.findById(agent.id, template.id);

    expect(dueTemplates.map(t => t.id)).not.toContain(template.id);
    expect(refreshed.next_due_at).toBe('2026-05-08T09:10:00.000Z');
  });
});

describe('Multi-agent Collaboration', () => {
  let agent1, agent2;
  beforeEach(() => {
    agent1 = createTestAgent('agent-1');
    agent2 = createTestAgent('agent-2');
  });

  test('assign task to another agent', () => {
    const todo = Todo.create(agent1.id, { title: 'Assign Me' });
    const assigned = Todo.assign(agent1.id, todo.id, agent2.id, 'Please handle this');
    expect(assigned.assigned_agent_id).toBe(agent2.id);
    expect(assigned.assignment_note).toBe('Please handle this');
  });

  test('find tasks assigned to me', () => {
    const todo = Todo.create(agent1.id, { title: 'For Agent 2' });
    Todo.assign(agent1.id, todo.id, agent2.id);

    const assigned = Todo.findAssignedToMe(agent2.id);
    expect(assigned.length).toBe(1);
    expect(assigned[0].title).toBe('For Agent 2');
  });

  test('find tasks created by me', () => {
    Todo.create(agent1.id, { title: 'My Task 1' });
    Todo.create(agent1.id, { title: 'My Task 2' });
    Todo.create(agent2.id, { title: 'Not My Task' });

    const created = Todo.findCreatedByMe(agent1.id);
    expect(created.length).toBe(2);
  });

  test('transfer task', () => {
    const todo = Todo.create(agent1.id, { title: 'Transfer Me' });
    Todo.assign(agent1.id, todo.id, agent2.id);

    const transferred = Todo.transfer(agent1.id, todo.id, agent1.id, 'Need different skills');
    expect(transferred.assigned_agent_id).toBe(agent1.id);
    expect(transferred.transferred_from).toBe(agent2.id);
  });
});

describe('Stuck Tasks', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('find stuck tasks with no heartbeat', () => {
    const todo = Todo.create(agent.id, { title: 'Active Task' });
    Todo.update(agent.id, todo.id, { status: 'in_progress' });

    const stuck = Todo.findStuckTasks(agent.id, 0);
    expect(stuck.length).toBe(1);
  });

  test('non-in_progress tasks are not stuck', () => {
    Todo.create(agent.id, { title: 'Pending Task' });

    const stuck = Todo.findStuckTasks(agent.id, 0);
    expect(stuck.length).toBe(0);
  });
});

describe('Template Normalization', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('create auto-normalizes template defaults for scheduled jobs', () => {
    const todo = Todo.create(agent.id, {
      title: '  每日数据库备份  ',
      schedule: '  cron:0 17 * * 1-5  ',
      description: '   ',
      acceptanceCriteria: '   ',
      maxAttempts: 0
    });

    expect(todo.title).toBe('每日数据库备份');
    expect(todo.is_template).toBe(1);
    expect(todo.schedule).toBe('cron:0 17 * * 1-5');
    expect(todo.assigned_agent_id).toBe(agent.id);
    expect(todo.description).toContain('定时模板任务');
    expect(todo.acceptance_criteria).toContain('执行结果');
    expect(todo.max_attempts).toBe(3);
    expect(todo.task_category).toBe('script');
    expect(todo.next_due_at).toBeTruthy();
  });

  test('update normalizes template fields when task becomes scheduled template', () => {
    const todo = Todo.create(agent.id, { title: '每周巡检' });

    const updated = Todo.update(agent.id, todo.id, {
      isTemplate: true,
      schedule: ' weekly:mon ',
      description: '',
      acceptanceCriteria: '',
      assignedAgentId: '   '
    });

    expect(updated.is_template).toBe(1);
    expect(updated.schedule).toBe('weekly:mon');
    expect(updated.assigned_agent_id).toBe(agent.id);
    expect(updated.description).toContain('定时模板任务');
    expect(updated.acceptance_criteria).toContain('巡检结论');
    expect(updated.task_category).toBe('inspection');
    expect(updated.next_due_at).toBeTruthy();
  });
});
