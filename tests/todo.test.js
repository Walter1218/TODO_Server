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
