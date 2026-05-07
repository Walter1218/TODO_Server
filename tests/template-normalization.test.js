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
const Context = require('../src/models/Context');
const TemplateNormalizationService = require('../src/services/TemplateNormalizationService');

function createTestAgent(name = 'owner-agent') {
  return Agent.create({
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name
  });
}

describe('TemplateNormalizationService', () => {
  test('normalizes historical non-compliant template through agent dialogue', async () => {
    const owner = createTestAgent('owner');
    const template = Todo.create(owner.id, {
      title: '每周巡检模板',
      schedule: 'weekly:mon',
      isTemplate: true
    });

    db.prepare(`
      UPDATE todos
      SET assigned_agent_id = NULL,
          description = '',
          acceptance_criteria = '',
          task_category = NULL,
          max_attempts = 0
      WHERE id = ?
    `).run(template.id);

    const service = new TemplateNormalizationService({
      framework: {
        modules: {
          llmManager: {
            hasProvider: () => true,
            chat: jest.fn().mockResolvedValue({
              content: JSON.stringify({
                summary: '已补齐巡检模板关键字段',
                dialogue: [
                  { speaker: 'owner', message: '请帮我修正这个模板' },
                  { speaker: 'governor', message: '我会补齐描述、验收和分类' }
                ],
                patch: {
                  description: '每周执行一次平台巡检，检查核心服务和数据链路状态。',
                  acceptanceCriteria: '输出巡检结论、异常项和处理建议，并明确是否允许继续运行。',
                  taskCategory: 'inspection',
                  maxAttempts: 2
                },
                requiresHumanReview: false,
                humanReviewReason: ''
              })
            })
          }
        }
      }
    });

    const result = await service.normalizeNonCompliantTemplates(owner.id);
    const updated = Todo.findById(owner.id, template.id);
    const ownerContexts = Context.findBySession(owner.id, `template-normalization:${template.id}`);
    const governorContexts = Context.findBySession(service.governorAgentId, `template-normalization:${template.id}`);

    expect(result.normalized).toBe(1);
    expect(updated.assigned_agent_id).toBe(owner.id);
    expect(updated.description).toContain('平台巡检');
    expect(updated.acceptance_criteria).toContain('巡检结论');
    expect(updated.task_category).toBe('inspection');
    expect(updated.max_attempts).toBe(2);
    expect(Agent.exists(service.governorAgentId)).toBe(true);
    expect(ownerContexts.length).toBeGreaterThanOrEqual(2);
    expect(governorContexts.length).toBeGreaterThanOrEqual(2);
  });

  test('keeps template in human review when schedule cannot be safely inferred', async () => {
    const owner = createTestAgent('owner');
    const template = Todo.create(owner.id, {
      title: '历史脏模板',
      schedule: 'daily',
      isTemplate: true
    });

    db.prepare(`
      UPDATE todos
      SET schedule = NULL,
          assigned_agent_id = NULL,
          acceptance_criteria = '',
          description = ''
      WHERE id = ?
    `).run(template.id);

    const service = new TemplateNormalizationService({
      framework: {
        modules: {
          llmManager: {
            hasProvider: () => true,
            chat: jest.fn().mockResolvedValue({
              content: JSON.stringify({
                summary: '无法安全推断调度表达式，需人工确认',
                dialogue: [
                  { speaker: 'owner', message: '这个模板缺 schedule' },
                  { speaker: 'governor', message: '我先补齐其他字段，schedule 留给人工确认' }
                ],
                patch: {
                  description: '历史模板，待补充明确调度规则后再投入使用。',
                  acceptanceCriteria: '确认调度规则后，再补充最终验收标准。',
                  taskCategory: 'general',
                  maxAttempts: 3
                },
                requiresHumanReview: true,
                humanReviewReason: '标题和描述无法唯一确定 schedule'
              })
            })
          }
        }
      }
    });

    const result = await service.normalizeNonCompliantTemplates(owner.id);
    const updated = Todo.findById(owner.id, template.id);

    expect(result.requiresHumanReview).toBe(1);
    expect(result.results[0].status).toBe('partially_normalized');
    expect(result.results[0].missingFieldsAfter).toContain('schedule');
    expect(updated.assigned_agent_id).toBe(owner.id);
    expect(updated.acceptance_criteria).toContain('调度规则');
    expect(updated.schedule).toBeNull();
  });

  test('rule engine auto-fills task_spec for known data template without LLM', async () => {
    const owner = createTestAgent('owner');
    const template = Todo.create(owner.id, {
      title: '每日资金流向数据增量同步（moneyflow）',
      schedule: '5 17 * * 1-5',
      isTemplate: true
    });

    db.prepare(`
      UPDATE todos
      SET acceptance_criteria = '',
          task_spec = NULL
      WHERE id = ?
    `).run(template.id);

    const service = new TemplateNormalizationService({
      framework: {
        modules: {
          llmManager: {
            hasProvider: () => false
          }
        }
      }
    });

    const result = await service.normalizeNonCompliantTemplates(owner.id, { templateIds: [template.id] });
    const updated = Todo.findById(owner.id, template.id);

    expect(result.normalized).toBe(1);
    expect(updated.task_spec).toBeTruthy();
    expect(updated.task_spec.kind).toBe('data_task');
    expect(updated.acceptance_criteria).toContain('库校验 SQL');
  });
});
