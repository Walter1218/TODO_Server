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
const DriveOrchestrator = require('../src/services/DriveOrchestrator');
const TaskPlanService = require('../src/services/TaskPlanService');
const CommandExecutor = require('../src/services/CommandExecutor');
const StructuredDriveTools = require('../src/utils/StructuredDriveTools');

function createTestAgent(name = 'drive-agent') {
  return Agent.create({
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name
  });
}

function buildToolCall(name, args, id = `${name}-1`) {
  return {
    id,
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

describe('StructuredDriveTools', () => {
  let agent;
  let todo;

  beforeEach(() => {
    agent = createTestAgent();
    todo = Todo.create(agent.id, {
      title: 'Structured tool task',
      description: 'Test structured tool flow'
    });
  });

  test('executeCommand returns command output', async () => {
    const result = await StructuredDriveTools.executeToolCall(
      buildToolCall('executeCommand', {
        command: 'node -e "process.stdout.write(\'ok\')"'
      }),
      agent.id,
      todo.id,
      'test-session'
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe('command_executed');
    expect(result.data.output).toContain('ok');
  });

  test('proposeCompletion moves task to pending_validation', async () => {
    const result = await StructuredDriveTools.executeToolCall(
      buildToolCall('proposeCompletion', {
        summary: 'Task finished',
        criteriaMet: ['完成主要逻辑'],
        evidence: 'Unit test evidence',
        completionDetails: {
          dataLocation: '/tmp/output.json',
          artifacts: ['/tmp/output.json']
        }
      }),
      agent.id,
      todo.id,
      'test-session'
    );

    const refreshed = Todo.findById(agent.id, todo.id);
    expect(result.success).toBe(true);
    expect(result.action).toBe('task_pending_validation');
    expect(refreshed.status).toBe('pending_validation');
    expect(refreshed.heartbeat_progress).toBe(100);
    const report = JSON.parse(refreshed.completion_report);
    expect(report.validationEvidence.criteriaMet).toContain('完成主要逻辑');
    expect(report.validationEvidence.artifacts).toContain('/tmp/output.json');
  });
});

describe('DriveOrchestrator tool loop', () => {
  let agent;
  let todo;
  let template;

  beforeEach(() => {
    agent = createTestAgent('orchestrator-agent');
    template = Todo.create(agent.id, {
      title: 'Scheduled template',
      description: '模板任务',
      isTemplate: true,
      schedule: 'cron:0 17 * * 1-5'
    });
    todo = Todo.create(agent.id, {
      title: 'Tool loop task',
      description: '通过结构化工具执行任务',
      acceptanceCriteria: '1. 输出 ok\n2. 更新进度并提交验收'
    });
  });

  test('driveTask uses tool loop and enters pending_validation', async () => {
    const chat = jest.fn()
      .mockResolvedValueOnce({
        content: '',
        usage: { totalTokens: 100 },
        toolCalls: [
          buildToolCall('executeCommand', {
            command: 'node -e "process.stdout.write(\'ok\')"'
          }, 'tc-1'),
          buildToolCall('updateProgress', {
            progress: 60,
            step: '命令执行完成'
          }, 'tc-2')
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        usage: { totalTokens: 100 },
        toolCalls: [
          buildToolCall('proposeCompletion', {
            summary: '执行完成',
            criteriaMet: ['输出 ok', '更新进度并提交验收'],
            evidence: '命令返回 ok'
          }, 'tc-3')
        ]
      });

    const orchestrator = new DriveOrchestrator({
      maxRetries: 1,
      toolLoopMaxIterations: 4,
      maxNoProgressRounds: 2
    });
    orchestrator.framework = {
      modules: {
        llmManager: {
          hasProvider: () => true,
          chat
        }
      }
    };

    const result = await orchestrator.driveTask(agent.id, todo);
    const refreshed = Todo.findById(agent.id, todo.id);
    const run = db.prepare('SELECT * FROM job_runs WHERE task_id = ?').get(todo.id);

    expect(result.success).toBe(true);
    expect(result.validationTriggered).toBe(true);
    expect(result.toolLoop).toBe(true);
    expect(refreshed.status).toBe('pending_validation');
    expect(refreshed.heartbeat_progress).toBe(100);
    expect(run).toBeDefined();
    expect(run.pending_validation_at).toBeTruthy();
    expect(run.final_status).toBe('pending_validation');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  test('driveTask handles askForHelp path as blocked', async () => {
    const chat = jest.fn().mockResolvedValue({
      content: '',
      usage: { totalTokens: 120 },
      toolCalls: [
        buildToolCall('askForHelp', {
          blocker: '缺少生产凭证',
          neededResource: '需要人工提供 API key',
          alternativesTried: ['检查本地环境变量', '检查配置文件']
        }, 'tc-help')
      ]
    });

    const orchestrator = new DriveOrchestrator({
      maxRetries: 1,
      toolLoopMaxIterations: 2
    });
    orchestrator.framework = {
      modules: {
        llmManager: {
          hasProvider: () => true,
          chat
        }
      }
    };

    const result = await orchestrator.driveTask(agent.id, todo);
    const refreshed = Todo.findById(agent.id, todo.id);
    const contexts = Context.findRecentByAgent(agent.id, 20);

    expect(result.blocked).toBe(true);
    expect(result.helpRequested).toBe(true);
    expect(result.toolLoop).toBe(true);
    expect(refreshed.status).toBe('blocked');
    expect(refreshed.heartbeat_step).toContain('等待支援');
    expect(contexts.some(c => c.metadata?.type === 'tool_loop_exit' && c.metadata?.reason === 'help_requested')).toBe(true);
  });

  test('driveTask records fallback reason when token budget is exceeded and falls back to legacy flow', async () => {
    const chat = jest.fn().mockResolvedValue({
      content: '',
      usage: { totalTokens: 9999 },
      toolCalls: [
        buildToolCall('checkPath', {
          path: process.cwd()
        }, 'tc-check')
      ]
    });

    const processMessage = jest.fn().mockResolvedValue({
      response: {
        message: '未执行任何命令'
      }
    });

    const orchestrator = new DriveOrchestrator({
      maxRetries: 1,
      toolLoopMaxIterations: 2,
      toolLoopTokenBudget: 500
    });
    orchestrator.framework = {
      modules: {
        llmManager: {
          hasProvider: () => true,
          chat
        }
      },
      processMessage
    };
    orchestrator.consultTask = jest.fn().mockResolvedValue(null);

    const result = await orchestrator.driveTask(agent.id, todo);
    const contexts = Context.findRecentByAgent(agent.id, 50);
    const stats = orchestrator.getToolLoopStats();

    expect(result).toBeDefined();
    expect(processMessage).toHaveBeenCalled();
    expect(contexts.some(c => c.metadata?.type === 'tool_loop_exit' && c.metadata?.reason === 'token_budget_exceeded')).toBe(true);
    expect(contexts.some(c => c.metadata?.type === 'tool_loop_fallback' && c.metadata?.reason === 'token_budget_exceeded')).toBe(true);
    expect(stats.fallbackReasons.token_budget_exceeded).toBe(1);
    expect(stats.exitReasons.token_budget_exceeded).toBe(1);
  });

  test('triggerTaskDrive can immediately drive scheduled instances with parent_id', async () => {
    const scheduledInstance = Todo.create(agent.id, {
      title: 'Scheduled instance',
      description: '由模板生成的实例',
      parentId: template.id,
      status: 'pending'
    });
    const chat = jest.fn()
      .mockResolvedValueOnce({
        content: '',
        usage: { totalTokens: 80 },
        toolCalls: [
          buildToolCall('updateProgress', {
            progress: 50,
            step: '已启动定时任务'
          }, 'tc-progress')
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        usage: { totalTokens: 80 },
        toolCalls: [
          buildToolCall('proposeCompletion', {
            summary: '定时任务已启动并完成',
            criteriaMet: ['成功启动', '进入验收'],
            evidence: 'forced drive'
          }, 'tc-complete')
        ]
      });

    const orchestrator = new DriveOrchestrator({
      maxRetries: 1,
      toolLoopMaxIterations: 3
    });
    orchestrator.framework = {
      modules: {
        llmManager: {
          hasProvider: () => true,
          chat
        }
      }
    };

    const forced = await orchestrator.triggerTaskDrive(agent.id, scheduledInstance.id, {
      source: 'scheduled_task',
      reason: 'template_spawned_immediate_drive',
      allowPendingChildren: true,
      waitForCompletion: true
    });
    const refreshed = Todo.findById(agent.id, scheduledInstance.id);
    const contexts = Context.findRecentByAgent(agent.id, 20);

    expect(forced.queued).toBe(true);
    expect(forced.result.success).toBe(true);
    expect(refreshed.status).toBe('pending_validation');
    expect(contexts.some(c => c.metadata?.type === 'forced_drive_request' && c.metadata?.task_id === scheduledInstance.id)).toBe(true);
    expect(contexts.some(c => c.metadata?.type === 'forced_drive_result' && c.metadata?.task_id === scheduledInstance.id)).toBe(true);
  });

  test('triggerTaskDrive caps forced retries for the same scheduled instance', async () => {
    const scheduledInstance = Todo.create(agent.id, {
      title: 'Scheduled pending instance',
      description: '等待被强制驱动',
      parentId: template.id,
      status: 'pending'
    });

    const orchestrator = new DriveOrchestrator({
      maxForcedCronDrivesPerTask: 2
    });
    orchestrator.framework = {
      modules: {
        llmManager: {
          hasProvider: () => true,
          chat: jest.fn()
        }
      }
    };
    orchestrator.driveTask = jest.fn().mockResolvedValue({ success: false, stalled: true });

    const first = await orchestrator.triggerTaskDrive(agent.id, scheduledInstance.id, {
      source: 'scheduled_task',
      reason: 'template_spawned_immediate_drive',
      allowPendingChildren: true,
      waitForCompletion: true
    });
    const second = await orchestrator.triggerTaskDrive(agent.id, scheduledInstance.id, {
      source: 'scheduled_task',
      reason: 'cron_no_heartbeat_recovery',
      allowPendingChildren: true,
      waitForCompletion: true
    });
    const third = await orchestrator.triggerTaskDrive(agent.id, scheduledInstance.id, {
      source: 'scheduled_task',
      reason: 'cron_no_heartbeat_recovery',
      allowPendingChildren: true,
      waitForCompletion: true
    });

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(true);
    expect(third.queued).toBe(false);
    expect(third.reason).toBe('forced_attempt_limit_reached');
    expect(orchestrator.driveTask).toHaveBeenCalledTimes(2);
  });

  test('triggerTaskDrive blocks tasks whose attempt count is already exhausted', async () => {
    const exhaustedInstance = Todo.create(agent.id, {
      title: 'Exhausted scheduled instance',
      description: '超过最大尝试次数',
      parentId: template.id,
      status: 'in_progress',
      maxAttempts: 3
    });
    Todo.update(agent.id, exhaustedInstance.id, {
      attemptCount: 3
    });

    const orchestrator = new DriveOrchestrator();
    orchestrator.framework = {
      modules: {
        llmManager: {
          hasProvider: () => true,
          chat: jest.fn()
        }
      }
    };
    orchestrator.driveTask = jest.fn();

    const forced = await orchestrator.triggerTaskDrive(agent.id, exhaustedInstance.id, {
      source: 'scheduled_task',
      reason: 'cron_no_heartbeat_recovery',
      allowPendingChildren: true,
      waitForCompletion: true
    });
    const refreshed = Todo.findById(agent.id, exhaustedInstance.id);
    const contexts = Context.findRecentByAgent(agent.id, 20);

    expect(forced.queued).toBe(false);
    expect(forced.reason).toBe('attempt_limit_exhausted');
    expect(refreshed.status).toBe('blocked');
    expect(refreshed.heartbeat_step).toContain('尝试次数已达上限');
    expect(orchestrator.driveTask).not.toHaveBeenCalled();
    expect(contexts.some(c => c.metadata?.type === 'attempt_limit_exhausted' && c.metadata?.task_id === exhaustedInstance.id)).toBe(true);
  });

  test('driveTask creates approved plan and advances inspect before execute for complex default tasks', async () => {
    const defaultAgent = createTestAgent('hermes-default');
    const complexTodo = Todo.create(defaultAgent.id, {
      title: '修复 default 数据任务',
      description: '需要先检查 duckdb 表、确认依赖脚本和目标目录，再执行数据修复并补齐结果证据，避免直接跳过排查步骤。',
      acceptanceCriteria: '1. 明确输入输出\n2. 完成修复\n3. 提交可复核证据',
      taskCategory: 'script',
      taskSpec: {
        target: 'local.duckdb',
        verify: 'SELECT 1'
      }
    });
    const chat = jest.fn();
    const orchestrator = new DriveOrchestrator({ maxRetries: 1 });
    orchestrator.framework = {
      modules: {
        llmManager: {
          hasProvider: () => true,
          chat
        }
      }
    };

    const result = await orchestrator.driveTask(defaultAgent.id, complexTodo);
    const refreshed = Todo.findById(defaultAgent.id, complexTodo.id);
    const plan = db.prepare('SELECT * FROM task_plans WHERE task_id = ?').get(complexTodo.id);
    const steps = db.prepare('SELECT * FROM task_plan_steps WHERE plan_id = ? ORDER BY step_order ASC').all(plan.id);

    expect(result.success).toBe(true);
    expect(result.enforcedPlan).toBe(true);
    expect(result.planAdvanced).toBe(true);
    expect(result.step).toBe('inspect');
    expect(chat).not.toHaveBeenCalled();
    expect(refreshed.status).toBe('in_progress');
    expect(refreshed.requires_plan).toBe(true);
    expect(refreshed.plan_status).toBe('approved');
    expect(refreshed.execution_state).toBe('ready');
    expect(steps.map(step => step.status)).toEqual(['completed', 'in_progress', 'pending']);
    expect(steps[1].id).toBe(refreshed.current_step_id);
  });

  test('driveTask executes approved execute step and moves plan into verify state', async () => {
    const defaultAgent = createTestAgent('hermes-default');
    const complexTodo = Todo.create(defaultAgent.id, {
      title: '同步 default 指标结果',
      description: '先检查输入数据，再执行同步脚本，最后提交验收证据。',
      acceptanceCriteria: '1. 同步完成\n2. 输出结果位置\n3. 进入待验证',
      taskCategory: 'script',
      taskSpec: {
        targetTable: 'metrics_daily',
        verifySql: 'SELECT count(*) FROM metrics_daily'
      }
    });
    const chat = jest.fn()
      .mockResolvedValueOnce({
        content: '',
        usage: { totalTokens: 100 },
        toolCalls: [
          buildToolCall('executeCommand', {
            command: 'node -e "process.stdout.write(\'ok\')"'
          }, 'tc-step-1'),
          buildToolCall('updateProgress', {
            progress: 80,
            step: '执行同步脚本'
          }, 'tc-step-2')
        ]
      })
      .mockResolvedValueOnce({
        content: '',
        usage: { totalTokens: 100 },
        toolCalls: [
          buildToolCall('proposeCompletion', {
            summary: '同步完成',
            criteriaMet: ['同步完成', '输出结果位置', '进入待验证'],
            evidence: 'command ok'
          }, 'tc-step-3')
        ]
      });

    const orchestrator = new DriveOrchestrator({
      maxRetries: 1,
      toolLoopMaxIterations: 4,
      maxNoProgressRounds: 2
    });
    orchestrator.framework = {
      modules: {
        llmManager: {
          hasProvider: () => true,
          chat
        }
      }
    };

    await orchestrator.driveTask(defaultAgent.id, complexTodo);
    const result = await orchestrator.driveTask(defaultAgent.id, Todo.findById(defaultAgent.id, complexTodo.id));
    const refreshed = Todo.findById(defaultAgent.id, complexTodo.id);
    const verifyStep = db.prepare('SELECT * FROM task_plan_steps WHERE id = ?').get(refreshed.current_step_id);

    expect(result.success).toBe(true);
    expect(result.validationTriggered).toBe(true);
    expect(result.enforcedPlan).toBe(true);
    expect(result.step).toBe('execute');
    expect(refreshed.status).toBe('pending_validation');
    expect(refreshed.plan_status).toBe('approved');
    expect(refreshed.execution_state).toBe('waiting_validation');
    expect(verifyStep.step_key).toBe('verify');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  test('TaskPlanService syncTaskExecution closes verify step when task is completed', async () => {
    const defaultAgent = createTestAgent('hermes-default');
    const complexTodo = Todo.create(defaultAgent.id, {
      title: '分析 default 卡点任务',
      description: '需要先检查，再执行，再等待验证闭环。',
      acceptanceCriteria: '提交结果摘要与证据',
      taskCategory: 'code_change',
      taskSpec: {
        evidence: 'report.md'
      }
    });
    const orchestrator = new DriveOrchestrator({ maxRetries: 1 });
    orchestrator.framework = {
      modules: {
        llmManager: {
          hasProvider: () => true,
          chat: jest.fn()
            .mockResolvedValueOnce({
              content: '',
              usage: { totalTokens: 100 },
              toolCalls: [
                buildToolCall('proposeCompletion', {
                  summary: '分析完成',
                  criteriaMet: ['提交结果摘要与证据'],
                  evidence: 'report ready'
                }, 'tc-final-1')
              ]
            })
        }
      }
    };

    await orchestrator.driveTask(defaultAgent.id, complexTodo);
    await orchestrator.driveTask(defaultAgent.id, Todo.findById(defaultAgent.id, complexTodo.id));
    Todo.updateStatus(defaultAgent.id, complexTodo.id, 'completed');
    TaskPlanService.syncTaskExecution(defaultAgent.id, Todo.findById(defaultAgent.id, complexTodo.id));

    const refreshed = Todo.findById(defaultAgent.id, complexTodo.id);
    const steps = db.prepare(`
      SELECT step_key, status
      FROM task_plan_steps
      WHERE plan_id = ?
      ORDER BY step_order ASC
    `).all(refreshed.current_plan_id);

    expect(refreshed.plan_status).toBe('completed');
    expect(refreshed.execution_state).toBe('completed');
    expect(refreshed.current_step_id).toBeNull();
    expect(steps).toEqual([
      { step_key: 'inspect', status: 'completed' },
      { step_key: 'execute', status: 'completed' },
      { step_key: 'verify', status: 'completed' }
    ]);
  });

  test('data task prefers official script execution and skips llm fallback', async () => {
    const execSpy = jest.spyOn(CommandExecutor, 'executeCommands').mockResolvedValue([
      {
        index: 0,
        command: 'python3 fetch_top_list.py',
        output: 'ok',
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        success: true,
        duration: 12
      }
    ]);
    const processMessage = jest.fn();

    const dataTask = Todo.create(agent.id, {
      title: '每日龙虎榜数据增量同步（top_list）',
      description: '通过正式脚本补齐数据'
    });
    const orchestrator = new DriveOrchestrator({
      maxRetries: 1,
      toolLoopMaxIterations: 2,
      maxNoProgressRounds: 1
    });
    orchestrator.framework = {
      processMessage,
      modules: {
        llmManager: {
          hasProvider: () => false
        }
      }
    };
    orchestrator.validator = {
      validateTask: jest.fn().mockResolvedValue({
        applied: true,
        pass: true,
        score: 92,
        reason: '规则通过',
        validator: 'policy:data_task'
      })
    };

    const result = await orchestrator.driveTask(agent.id, dataTask);
    const refreshed = Todo.findById(agent.id, dataTask.id);

    expect(result.officialExecution).toBe(true);
    expect(result.validationTriggered).toBe(true);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(processMessage).not.toHaveBeenCalled();
    expect(orchestrator.validator.validateTask).toHaveBeenCalledTimes(1);
    expect(refreshed.status).toBe('pending_validation');

    execSpy.mockRestore();
  });
});
