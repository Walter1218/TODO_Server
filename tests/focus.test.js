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
const FocusState = require('../src/models/FocusState');

function createTestAgent(name = 'test-agent') {
  return Agent.create({ id: `agent-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, name });
}

describe('FocusState CRUD', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('create focus state with null task', () => {
    const focus = FocusState.createOrUpdate(agent.id, {
      focusMode: 'auto',
      contextWindowSize: 5
    });
    expect(focus).toBeDefined();
    expect(focus.focus_mode).toBe('auto');
    expect(focus.context_window_size).toBe(5);
  });

  test('create focus state with valid task', () => {
    const todo = Todo.create(agent.id, { title: 'My Task' });
    const focus = FocusState.createOrUpdate(agent.id, {
      currentTaskId: todo.id,
      focusMode: 'manual',
      contextWindowSize: 5
    });
    expect(focus).toBeDefined();
    expect(focus.current_task_id).toBe(todo.id);
    expect(focus.focus_mode).toBe('manual');
  });

  test('update existing focus state', () => {
    const t1 = Todo.create(agent.id, { title: 'Task 1' });
    const t2 = Todo.create(agent.id, { title: 'Task 2' });
    FocusState.createOrUpdate(agent.id, { currentTaskId: t1.id });
    const updated = FocusState.createOrUpdate(agent.id, { currentTaskId: t2.id });
    expect(updated.current_task_id).toBe(t2.id);
  });

  test('find focus by agent', () => {
    FocusState.createOrUpdate(agent.id, { focusMode: 'auto' });
    const found = FocusState.findByAgent(agent.id);
    expect(found).toBeDefined();
    expect(found.focus_mode).toBe('auto');
  });
});

describe('AutoFocus', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('returns null when no tasks exist', async () => {
    const result = await FocusState.autoFocus(agent.id);
    expect(result).toBeNull();
  });

  test('prioritizes in_progress tasks', async () => {
    const t1 = Todo.create(agent.id, { title: 'Pending' });
    const t2 = Todo.create(agent.id, { title: 'In Progress' });
    Todo.update(agent.id, t2.id, { status: 'in_progress' });

    const result = await FocusState.autoFocus(agent.id);
    expect(result).not.toBeNull();
    expect(result.title).toBe('In Progress');
    expect(result.focus_reason).toBe('continue_in_progress');
  });

  test('picks highest scoring ready task', async () => {
    const t1 = Todo.create(agent.id, { title: 'Low Priority', priority: 'low' });
    const t2 = Todo.create(agent.id, { title: 'Critical Priority', priority: 'critical' });

    const result = await FocusState.autoFocus(agent.id);
    expect(result).not.toBeNull();
    expect(result.title).toBe('Critical Priority');
    expect(result.focus_reason).toBe('ready_highest_score');
  });

  test('blocked tasks with remaining attempts get lowest priority', async () => {
    const t1 = Todo.create(agent.id, { title: 'Ready Task', priority: 'low' });
    const t2 = Todo.create(agent.id, { title: 'Blocked Task', priority: 'low', maxAttempts: 5 });
    Todo.update(agent.id, t2.id, { status: 'blocked', attemptCount: 2 });

    const result = await FocusState.autoFocus(agent.id);
    expect(result).not.toBeNull();
    expect(result.title).toBe('Ready Task');
  });

  test('filters out template tasks', async () => {
    Todo.create(agent.id, { title: 'Template', isTemplate: true, schedule: 'daily' });
    Todo.create(agent.id, { title: 'Real Task' });

    const result = await FocusState.autoFocus(agent.id);
    expect(result).not.toBeNull();
    expect(result.title).toBe('Real Task');
  });

  test('includes tasks assigned to this agent', async () => {
    const otherAgent = createTestAgent('other');
    const todo = Todo.create(otherAgent.id, { title: 'Assigned to me' });
    Todo.assign(otherAgent.id, todo.id, agent.id);

    const result = await FocusState.autoFocus(agent.id);
    expect(result).not.toBeNull();
    expect(result.title).toBe('Assigned to me');
  });
});

describe('FocusScore Calculation', () => {
  test('critical priority has highest weight', () => {
    const criticalTodo = { priority: 'critical', dependencies: '[]', attempt_count: 0, max_attempts: 3, created_at: new Date().toISOString() };
    const lowTodo = { priority: 'low', dependencies: '[]', attempt_count: 0, max_attempts: 3, created_at: new Date().toISOString() };

    const criticalScore = FocusState.calculateFocusScore(criticalTodo, new Set());
    const lowScore = FocusState.calculateFocusScore(lowTodo, new Set());

    expect(criticalScore).toBeGreaterThan(lowScore);
  });

  test('tasks with no dependencies get readiness bonus', () => {
    const noDeps = { priority: 'medium', dependencies: '[]', attempt_count: 0, max_attempts: 3, created_at: new Date().toISOString() };
    const withDeps = { priority: 'medium', dependencies: '["dep1"]', attempt_count: 0, max_attempts: 3, created_at: new Date().toISOString() };

    const noDepsScore = FocusState.calculateFocusScore(noDeps, new Set());
    const withDepsScore = FocusState.calculateFocusScore(withDeps, new Set());

    expect(noDepsScore).toBeGreaterThan(withDepsScore);
  });

  test('attempt count penalizes score', () => {
    const noAttempts = { priority: 'medium', dependencies: '[]', attempt_count: 0, max_attempts: 3, created_at: new Date().toISOString() };
    const twoAttempts = { priority: 'medium', dependencies: '[]', attempt_count: 2, max_attempts: 3, created_at: new Date().toISOString() };

    const noAttemptScore = FocusState.calculateFocusScore(noAttempts, new Set());
    const twoAttemptScore = FocusState.calculateFocusScore(twoAttempts, new Set());

    expect(noAttemptScore).toBeGreaterThan(twoAttemptScore);
  });

  test('blocked tasks (max attempts reached) get heavy penalty', () => {
    const notBlocked = { priority: 'medium', dependencies: '[]', attempt_count: 2, max_attempts: 3, created_at: new Date().toISOString() };
    const blocked = { priority: 'medium', dependencies: '[]', attempt_count: 3, max_attempts: 3, created_at: new Date().toISOString() };

    const notBlockedScore = FocusState.calculateFocusScore(notBlocked, new Set());
    const blockedScore = FocusState.calculateFocusScore(blocked, new Set());

    expect(notBlockedScore).toBeGreaterThan(blockedScore);
    expect(notBlockedScore - blockedScore).toBe(40);
  });

  test('older tasks get age bonus', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const newDate = new Date().toISOString();

    const oldTodo = { priority: 'medium', dependencies: '[]', attempt_count: 0, max_attempts: 3, created_at: oldDate };
    const newTodo = { priority: 'medium', dependencies: '[]', attempt_count: 0, max_attempts: 3, created_at: newDate };

    const oldScore = FocusState.calculateFocusScore(oldTodo, new Set());
    const newScore = FocusState.calculateFocusScore(newTodo, new Set());

    expect(oldScore).toBeGreaterThan(newScore);
  });
});

describe('getFocusContext', () => {
  let agent;
  beforeEach(() => {
    agent = createTestAgent();
  });

  test('returns null when no tasks exist', async () => {
    const ctx = await FocusState.getFocusContext(agent.id);
    expect(ctx).toBeNull();
  });

  test('returns current focus task via autoFocus', async () => {
    const todo = Todo.create(agent.id, { title: 'Focused', priority: 'critical' });

    const ctx = await FocusState.getFocusContext(agent.id);
    expect(ctx).not.toBeNull();
    expect(ctx.current_task).toBeDefined();
    expect(ctx.current_task.title).toBe('Focused');
  });

  test('auto-reFocuses when current task is deleted', async () => {
    const t1 = Todo.create(agent.id, { title: 'Task 1' });
    Todo.update(agent.id, t1.id, { status: 'in_progress' });
    const t2 = Todo.create(agent.id, { title: 'Task 2', priority: 'high' });
    await FocusState.autoFocus(agent.id);

    Todo.delete(agent.id, t1.id);

    const ctx = await FocusState.getFocusContext(agent.id);
    expect(ctx).not.toBeNull();
    expect(ctx.current_task).toBeDefined();
    expect(ctx.current_task.title).toBe('Task 2');
  });
});
