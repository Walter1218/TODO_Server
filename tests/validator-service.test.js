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
const ValidatorService = require('../src/services/ValidatorService');

function createTestAgent(name = 'validator-agent') {
  return Agent.create({
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name
  });
}

function createValidatorService() {
  return new ValidatorService({
    modules: {
      llmManager: {
        hasProvider: () => false
      }
    }
  });
}

describe('ValidatorService policy validation', () => {
  test('passes script task with structured completion evidence', async () => {
    const agent = createTestAgent();
    const task = Todo.create(agent.id, {
      title: '每日数据同步',
      description: '脚本同步任务',
      taskCategory: 'script',
      status: 'pending_validation',
      acceptanceCriteria: '1. 有产出物\n2. 有完成证据'
    });

    Todo.update(agent.id, task.id, {
      completionReport: JSON.stringify({
        type: 'script',
        summary: '脚本执行完成',
        sections: [
          { label: '产出位置', items: ['/tmp/output.json'] },
          { label: '执行结果', items: ['同步完成'] }
        ],
        validationEvidence: {
          criteriaMet: ['有产出物', '有完成证据'],
          artifacts: ['/tmp/output.json'],
          evidenceLines: ['产出位置: /tmp/output.json'],
          summary: '脚本执行完成'
        }
      })
    });

    const service = createValidatorService();
    const result = await service.validateTask(agent.id, Todo.findById(agent.id, task.id));
    const refreshed = Todo.findById(agent.id, task.id);

    expect(result.pass).toBe(true);
    expect(result.validator).toBe('policy:script');
    expect(refreshed.status).toBe('completed');
    expect(refreshed.validated_by).toBe('policy:script');
  });

  test('fails task without structured evidence and marks validation_failed', async () => {
    const agent = createTestAgent();
    const task = Todo.create(agent.id, {
      title: '缺少证据的任务',
      description: '只有一句完成描述',
      taskCategory: 'script',
      status: 'pending_validation',
      acceptanceCriteria: '1. 必须有结构化产出'
    });

    const service = createValidatorService();
    const result = await service.validateTask(agent.id, Todo.findById(agent.id, task.id));
    const refreshed = Todo.findById(agent.id, task.id);

    expect(result.pass).toBe(false);
    expect(refreshed.status).toBe('validation_failed');
    expect(refreshed.failure_bucket).toBe('validation_failed');
  });
});
