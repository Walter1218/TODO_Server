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
        evidence: 'Unit test evidence'
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
  });
});

describe('DriveOrchestrator tool loop', () => {
  let agent;
  let todo;

  beforeEach(() => {
    agent = createTestAgent('orchestrator-agent');
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

    expect(result.success).toBe(true);
    expect(result.validationTriggered).toBe(true);
    expect(result.toolLoop).toBe(true);
    expect(refreshed.status).toBe('pending_validation');
    expect(refreshed.heartbeat_progress).toBe(100);
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
});
