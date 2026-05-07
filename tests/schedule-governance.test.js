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
