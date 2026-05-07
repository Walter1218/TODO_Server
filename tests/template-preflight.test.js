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
const TemplatePreflightService = require('../src/services/TemplatePreflightService');

function createTestAgent(name = 'template-agent') {
  return Agent.create({
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name
  });
}

describe('TemplatePreflightService', () => {
  test('blocks template spawn when explicit preflight detects missing script', () => {
    const agent = createTestAgent();
    const template = Todo.create(agent.id, {
      title: '坏模板',
      description: [
        '定时同步任务',
        'CWD=/tmp',
        'SCRIPT=/tmp/definitely-missing-script.py',
        'REQUIRES_BIN=python3'
      ].join('\n'),
      schedule: 'cron:0 17 * * 1-5',
      isTemplate: true
    });

    const service = new TemplatePreflightService();
    const result = service.evaluateBeforeSpawn(agent.id, template);
    const refreshed = Todo.findById(agent.id, template.id);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('template_preflight_blocked');
    expect(result.blockers.join(' ')).toContain('缺少脚本');
    expect(refreshed.last_preflight_status).toBe('blocked');
    expect(refreshed.last_preflight_report).toContain('template_preflight_blocked');
  });

  test('opens circuit when template failure streak reaches threshold', () => {
    const agent = createTestAgent();
    const template = Todo.create(agent.id, {
      title: '连续失败模板',
      description: '普通模板，无显式 preflight',
      schedule: 'cron:0 18 * * 1-5',
      isTemplate: true
    });

    for (let i = 0; i < 3; i++) {
      const runTask = Todo.create(agent.id, {
        title: `run-${i}`,
        parentId: template.id,
        status: 'pending'
      });
      Todo.update(agent.id, runTask.id, {
        status: 'blocked',
        failureBucket: 'tool_failure'
      });
    }

    const service = new TemplatePreflightService({ failureThreshold: 3, cooldownMinutes: 30 });
    const result = service.evaluateBeforeSpawn(agent.id, template);
    const refreshed = Todo.findById(agent.id, template.id);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('template_circuit_opened');
    expect(refreshed.circuit_open_until).toBeTruthy();
    expect(refreshed.last_preflight_status).toBe('blocked');
  });

  test('expired circuit allows one retry instead of reopening immediately from old failures', () => {
    const agent = createTestAgent();
    const template = Todo.create(agent.id, {
      title: '冷却后重试模板',
      description: '普通模板，无显式 preflight',
      schedule: 'cron:15 17 * * 1-5',
      isTemplate: true
    });

    for (let i = 0; i < 3; i++) {
      const runTask = Todo.create(agent.id, {
        title: `cool-run-${i}`,
        parentId: template.id,
        status: 'pending'
      });
      Todo.update(agent.id, runTask.id, {
        status: 'blocked',
        failureBucket: 'tool_failure'
      });
    }

    Todo.update(agent.id, template.id, {
      circuitOpenUntil: new Date(Date.now() - 5 * 60 * 1000).toISOString()
    });

    const service = new TemplatePreflightService({ failureThreshold: 3, cooldownMinutes: 30 });
    const result = service.evaluateBeforeSpawn(agent.id, template);
    const refreshed = Todo.findById(agent.id, template.id);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('no_explicit_preflight');
    expect(refreshed.circuit_open_until).toBeNull();
  });
});
