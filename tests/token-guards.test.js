const ValidationAgent = require('../src/services/ValidationAgent');
const TaskReportService = require('../src/services/TaskReportService');
const TemplateNormalizationService = require('../src/services/TemplateNormalizationService');
const DriveOrchestrator = require('../src/services/DriveOrchestrator');

describe('token guards', () => {
  test('ValidationAgent keeps validation budget small and truncates prompt input', async () => {
    const chat = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        pass: true,
        reason: '验证通过',
        score: 88,
        feedback: '存在有效产出物',
        evidence_summary: ['artifact exists']
      })
    });
    const agent = new ValidationAgent({
      modules: {
        llmManager: { chat }
      }
    });

    await agent.validate('agent-1', {
      id: 'task-1',
      title: '超长验证任务',
      description: 'D'.repeat(3000),
      acceptance_criteria: 'A'.repeat(2000),
      heartbeat_step: 'H'.repeat(500),
      status: 'pending_validation',
      attempt_count: 1,
      attempt_log: []
    });

    expect(chat).toHaveBeenCalledTimes(1);
    const call = chat.mock.calls[0][0];
    expect(call.maxTokens).toBe(3000);
    expect(call.messages[1].content).toContain('Description:');
    expect(call.messages[1].content.length).toBeLessThan(2600);
  });

  test('TaskReportService builds compact consult prompt instead of dumping raw execution JSON', () => {
    const prompt = TaskReportService.buildConsultPrompt({
      id: 'task-2',
      title: '排障任务',
      status: 'blocked',
      priority: 'high',
      heartbeat_progress: 30,
      heartbeat_step: 'S'.repeat(400),
      heartbeat_blockers: ['目录不存在', '环境变量缺失'],
      attempt_count: 2,
      max_attempts: 3,
      task_category: 'script',
      attempt_log: [
        { timestamp: '2026-05-07 10:00:00', success: false, reason: '脚本失败', output: 'O'.repeat(1000) },
        { timestamp: '2026-05-07 10:10:00', success: false, reason: '仍然失败', output: 'P'.repeat(1000) }
      ]
    }, {
      execution: {
        totalDrives: 5,
        totalCommandExecutions: 4,
        totalProgressReports: 3,
        totalLLMReplies: 2,
        commandHistory: [
          { timestamp: '2026-05-07 10:00:00', commands: [{ success: false, command: 'python3 ' + 'x'.repeat(400) }] }
        ]
      },
      validation: {
        validationCount: 1,
        validatedBy: 'validator-1',
        finalResult: {
          pass: false,
          score: 45,
          reason: 'R'.repeat(300),
          feedback: 'F'.repeat(300)
        }
      },
      timeline: [
        { timestamp: '2026-05-07 10:00:00', type: 'drive_execution', description: 'D'.repeat(300) }
      ]
    }, '请给出修复步骤');

    expect(prompt).toContain('"execution_summary"');
    expect(prompt).toContain('"validation_summary"');
    expect(prompt.length).toBeLessThan(3200);
    expect(prompt).not.toContain('O'.repeat(500));
    expect(prompt).not.toContain('python3 ' + 'x'.repeat(300));
  });

  test('TemplateNormalizationService caps normalization response budget and clips long fields', async () => {
    const chat = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'ok',
        dialogue: [],
        patch: {},
        requiresHumanReview: false,
        humanReviewReason: ''
      })
    });
    const service = new TemplateNormalizationService({
      framework: {
        modules: {
          llmManager: {
            hasProvider: () => true,
            chat
          }
        }
      }
    });

    await service.requestDialogue('owner-agent', {
      id: 'template-1',
      title: 'T'.repeat(300),
      description: 'D'.repeat(2000),
      schedule: null,
      assigned_agent_id: null,
      task_category: null,
      acceptance_criteria: 'A'.repeat(2000),
      max_attempts: 0,
      context: 'C'.repeat(2000)
    }, {
      missingFields: ['schedule', 'description']
    });

    expect(chat).toHaveBeenCalledTimes(1);
    const call = chat.mock.calls[0][0];
    expect(call.maxTokens).toBe(1200);
    expect(call.messages[0].content.length).toBeLessThan(2600);
  });

  test('TemplateNormalizationService only skips LLM for deterministic field gaps', () => {
    const service = new TemplateNormalizationService({
      framework: {
        modules: {
          llmManager: {
            hasProvider: () => true,
            chat: jest.fn()
          }
        }
      }
    });

    const template = {
      id: 'template-2',
      title: '每日巡检模板',
      description: '已有描述',
      schedule: null,
      assigned_agent_id: null,
      task_category: null,
      acceptance_criteria: '已有验收',
      max_attempts: 0,
      context: ''
    };
    const report = service.evaluateTemplate(template);
    const rulePatch = service.buildRuleBasedPatch('owner-agent', template);
    const predicted = service.evaluateTemplate({
      ...template,
      assigned_agent_id: rulePatch.assignedAgentId || template.assigned_agent_id,
      task_category: rulePatch.taskCategory || template.task_category,
      acceptance_criteria: rulePatch.acceptanceCriteria || template.acceptance_criteria,
      max_attempts: rulePatch.maxAttempts || template.max_attempts,
      schedule: rulePatch.schedule || template.schedule
    });

    expect(service.shouldSkipLlmNormalization(report, rulePatch, predicted)).toBe(true);
    expect(rulePatch.assignedAgentId).toBe('owner-agent');
    expect(rulePatch.schedule).toBe('daily');
    expect(rulePatch.taskCategory).toBe('inspection');
  });

  test('TemplateNormalizationService still keeps LLM for semantic content gaps', () => {
    const service = new TemplateNormalizationService();
    const template = {
      id: 'template-3',
      title: '每周巡检模板',
      description: '',
      schedule: 'weekly:mon',
      assigned_agent_id: null,
      task_category: null,
      acceptance_criteria: '',
      max_attempts: 0,
      context: ''
    };
    const report = service.evaluateTemplate(template);
    const rulePatch = service.buildRuleBasedPatch('owner-agent', template);
    const predicted = service.evaluateTemplate({
      ...template,
      assigned_agent_id: rulePatch.assignedAgentId || template.assigned_agent_id,
      task_category: rulePatch.taskCategory || template.task_category,
      acceptance_criteria: rulePatch.acceptanceCriteria || template.acceptance_criteria,
      max_attempts: rulePatch.maxAttempts || template.max_attempts,
      description: rulePatch.description || template.description
    });

    expect(service.shouldSkipLlmNormalization(report, rulePatch, predicted)).toBe(false);
  });

  test('DriveOrchestrator builds deterministic healing steps for env blockers without model call', () => {
    const orchestrator = new DriveOrchestrator();
    const plan = orchestrator._buildDeterministicHealingPlan({
      id: 'task-3',
      description: '需要 python 脚本与环境变量'
    }, ['目录不存在: /tmp/a', '环境变量 DB_URL 未设置'], 'Preflight 阻塞');

    expect(plan.fix_steps.length).toBeGreaterThan(0);
    expect(plan.fix_steps.join('\n')).toContain('环境变量');
    expect(plan.fix_steps.join('\n')).toContain('目录');
  });
});
