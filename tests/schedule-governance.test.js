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
const ScheduleGovernanceService = require('../src/services/ScheduleGovernanceService');

function createTestAgent(name = 'scheduler-agent') {
  return Agent.create({
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name
  });
}

describe('ScheduleGovernanceService', () => {
  test('blocks template when same template already has active instance', () => {
    const agent = createTestAgent();
    const template = Todo.create(agent.id, {
      title: '模板 A',
      description: '普通模板',
      schedule: 'cron:0 17 * * 1-5',
      isTemplate: true
    });

    Todo.create(agent.id, {
      title: '模板 A 实例',
      parentId: template.id,
      status: 'in_progress'
    });

    const service = new ScheduleGovernanceService();
    const result = service.evaluateBeforeSpawn(agent.id, template);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('template_active_limit');
  });

  test('allows scheduler spawn queueing even when agent execution slots are full', () => {
    const agent = createTestAgent();
    const template = Todo.create(agent.id, {
      title: '模板容量测试',
      description: '普通模板',
      schedule: 'cron:10 17 * * 1-5',
      isTemplate: true
    });

    Todo.create(agent.id, {
      title: '占用执行槽位的任务',
      status: 'in_progress'
    });

    const service = new ScheduleGovernanceService();
    const originalCanAcceptNewTask = Agent.canAcceptNewTask;
    Agent.canAcceptNewTask = () => ({ active: 1, max: 1, canAccept: false });
    const result = service.evaluateBeforeSpawn(agent.id, template);
    Agent.canAcceptNewTask = originalCanAcceptNewTask;

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('governance_passed');
    expect(result.details.agent_at_capacity).toBe(true);
    expect(result.details.active_tasks).toBe(1);
    expect(result.details.max_concurrent).toBe(1);
  });

  test('can still explicitly block when enforcing agent capacity', () => {
    const agent = createTestAgent();
    const template = Todo.create(agent.id, {
      title: '模板容量硬阻塞测试',
      description: '普通模板',
      schedule: 'cron:15 17 * * 1-5',
      isTemplate: true
    });

    Todo.create(agent.id, {
      title: '占用执行槽位的任务',
      status: 'in_progress'
    });

    const service = new ScheduleGovernanceService();
    const originalCanAcceptNewTask = Agent.canAcceptNewTask;
    Agent.canAcceptNewTask = () => ({ active: 1, max: 1, canAccept: false });
    const result = service.evaluateBeforeSpawn(agent.id, template, { enforceAgentCapacity: true });
    Agent.canAcceptNewTask = originalCanAcceptNewTask;

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('agent_capacity_reached');
  });

  test('blocks template when agent recent scheduler burst exceeds limit', () => {
    const agent = createTestAgent();
    const template = Todo.create(agent.id, {
      title: '模板 B',
      description: '普通模板',
      schedule: 'cron:5 17 * * 1-5',
      isTemplate: true
    });

    JobRunService.appendSchedulerEvent(agent.id, 'task_spawned', {
      templateId: template.id,
      eventStatus: 'success',
      details: { source: 'test' }
    });
    JobRunService.appendSchedulerEvent(agent.id, 'task_spawned', {
      templateId: template.id,
      eventStatus: 'success',
      details: { source: 'test' }
    });

    const service = new ScheduleGovernanceService({ defaultBurstLimit: 2, defaultBurstWindowMinutes: 5 });
    const result = service.evaluateBeforeSpawn(agent.id, template);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('agent_spawn_burst_limit');
  });
});
