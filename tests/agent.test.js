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

describe('Agent CRUD', () => {
  test('create agent with auto-generated secret_key', () => {
    const agent = Agent.create({ name: 'Test Agent' });
    expect(agent).toBeDefined();
    expect(agent.name).toBe('Test Agent');
    expect(agent.secret_key).toBeTruthy();
    expect(agent.secret_key.length).toBe(32);
  });

  test('create agent with custom id', () => {
    const agent = Agent.create({ id: 'custom-id', name: 'Custom Agent' });
    expect(agent.id).toBe('custom-id');
  });

  test('find agent by id excludes secret_key by default', () => {
    const created = Agent.create({ name: 'Secret Agent' });
    const found = Agent.findById(created.id);
    expect(found.secret_key).toBeUndefined();
  });

  test('find agent by id includes secret_key when requested', () => {
    const created = Agent.create({ name: 'Secret Agent' });
    const found = Agent.findById(created.id, true);
    expect(found.secret_key).toBeTruthy();
  });

  test('getSecretKey returns key', () => {
    const agent = Agent.create({ name: 'Key Agent' });
    const key = Agent.getSecretKey(agent.id);
    expect(key).toBeTruthy();
  });

  test('getSecretKey returns null for non-existent agent', () => {
    const key = Agent.getSecretKey('non-existent');
    expect(key).toBeNull();
  });

  test('update agent', () => {
    const agent = Agent.create({ name: 'Original' });
    const updated = Agent.update(agent.id, { name: 'Updated', metadata: { foo: 'bar' } });
    expect(updated.name).toBe('Updated');
    expect(updated.metadata.foo).toBe('bar');
  });

  test('delete agent', () => {
    const agent = Agent.create({ name: 'To Delete' });
    const deleted = Agent.delete(agent.id);
    expect(deleted).toBe(true);
    expect(Agent.findById(agent.id)).toBeUndefined();
  });

  test('exists returns true for existing agent', () => {
    const agent = Agent.create({ name: 'Exists' });
    expect(Agent.exists(agent.id)).toBe(true);
  });

  test('exists returns false for non-existent agent', () => {
    expect(Agent.exists('no-such-agent')).toBe(false);
  });

  test('findAll returns only agents in clean DB', () => {
    Agent.create({ name: 'Agent A' });
    Agent.create({ name: 'Agent B' });

    const all = Agent.findAll();
    expect(all.length).toBe(2);
    expect(all.map(a => a.name).sort()).toEqual(['Agent A', 'Agent B']);
  });
});

describe('Notification', () => {
  const Notification = require('../src/models/Notification');
  const Todo = require('../src/models/Todo');

  let agent;
  beforeEach(() => {
    agent = Agent.create({ name: 'Notify Agent' });
  });

  test('create notification', () => {
    const todo = Todo.create(agent.id, { title: 'Task' });
    const notif = Notification.create(agent.id, todo.id, 'assigned', 'You have a new task');
    expect(notif).toBeDefined();
    expect(notif.type).toBe('assigned');
    expect(!!notif.read).toBe(false);
  });

  test('find notifications by agent', () => {
    const todo = Todo.create(agent.id, { title: 'Task' });
    Notification.create(agent.id, todo.id, 'assigned', 'Task 1');
    Notification.create(agent.id, todo.id, 'completed', 'Task done');

    const all = Notification.findByAgent(agent.id);
    expect(all.length).toBe(2);
  });

  test('find unread only', () => {
    const todo = Todo.create(agent.id, { title: 'Task' });
    const n1 = Notification.create(agent.id, todo.id, 'assigned', 'Unread');
    Notification.create(agent.id, todo.id, 'completed', 'Also unread');
    Notification.markAsRead(n1.id);

    const unread = Notification.findByAgent(agent.id, { unreadOnly: true });
    expect(unread.length).toBe(1);
  });

  test('mark all as read', () => {
    const todo = Todo.create(agent.id, { title: 'Task' });
    Notification.create(agent.id, todo.id, 'assigned', 'Notif 1');
    Notification.create(agent.id, todo.id, 'assigned', 'Notif 2');

    const marked = Notification.markAllAsRead(agent.id);
    expect(marked).toBe(2);

    const unread = Notification.getUnreadCount(agent.id);
    expect(unread).toBe(0);
  });
});

describe('Context', () => {
  const Context = require('../src/models/Context');

  let agent;
  beforeEach(() => {
    agent = Agent.create({ name: 'Context Agent' });
  });

  test('create and find context', () => {
    const ctx = Context.create(agent.id, {
      sessionId: 'session-1',
      role: 'user',
      content: 'Hello world',
      metadata: { source: 'test' }
    });
    expect(ctx).toBeDefined();
    expect(ctx.content).toBe('Hello world');
    expect(ctx.metadata.source).toBe('test');
  });

  test('find by session', () => {
    Context.create(agent.id, { sessionId: 's1', role: 'user', content: 'Msg 1' });
    Context.create(agent.id, { sessionId: 's1', role: 'assistant', content: 'Msg 2' });
    Context.create(agent.id, { sessionId: 's2', role: 'user', content: 'Msg 3' });

    const s1Contexts = Context.findBySession(agent.id, 's1');
    expect(s1Contexts.length).toBe(2);
  });

  test('session summary', () => {
    Context.create(agent.id, { sessionId: 's1', role: 'user', content: 'Hello' });
    Context.create(agent.id, { sessionId: 's1', role: 'assistant', content: 'Hi there' });

    const summary = Context.getSessionSummary(agent.id, 's1');
    expect(summary.message_count).toBe(2);
    expect(summary.started_at).toBeTruthy();
    expect(summary.last_at).toBeTruthy();
  });
});

describe('Project', () => {
  const Project = require('../src/models/Project');
  const Todo = require('../src/models/Todo');

  let agent;
  beforeEach(() => {
    agent = Agent.create({ name: 'Project Agent' });
  });

  test('create and find project', () => {
    const project = Project.create(agent.id, { name: 'My Project', description: 'Test' });
    expect(project).toBeDefined();
    expect(project.name).toBe('My Project');
  });

  test('list projects with todo counts', () => {
    const project = Project.create(agent.id, { name: 'Project A' });
    Todo.create(agent.id, { title: 'Task 1', projectId: project.id });
    const t2 = Todo.create(agent.id, { title: 'Task 2', projectId: project.id });
    Todo.complete(agent.id, t2.id);

    const projects = Project.findAllByAgent(agent.id);
    expect(projects.length).toBe(1);
    expect(projects[0].todo_count).toBe(2);
    expect(projects[0].completed_count).toBe(1);
  });

  test('update project', () => {
    const project = Project.create(agent.id, { name: 'Original' });
    const updated = Project.update(agent.id, project.id, { name: 'Updated', color: '#ff0000' });
    expect(updated.name).toBe('Updated');
    expect(updated.color).toBe('#ff0000');
  });

  test('delete project', () => {
    const project = Project.create(agent.id, { name: 'To Delete' });
    expect(Project.delete(agent.id, project.id)).toBe(true);
    expect(Project.findById(agent.id, project.id)).toBeUndefined();
  });
});
