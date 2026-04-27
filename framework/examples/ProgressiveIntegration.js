/**
 * 渐进式集成示例
 * 
 * 展示如何从简单到复杂，逐步使用框架的功能
 */

const AgentTaskFramework = require('../core/Framework');
const TaskManager = require('../modules/TaskManager');
const ContextManager = require('../modules/ContextManager');
const MemoryManager = require('../modules/MemoryManager');
const PromptManager = require('../modules/PromptManager');
const ProactiveManager = require('../modules/ProactiveManager');

// 将模块注册到框架
AgentTaskFramework.prototype.TaskManager = TaskManager;
AgentTaskFramework.prototype.ContextManager = ContextManager;
AgentTaskFramework.prototype.MemoryManager = MemoryManager;
AgentTaskFramework.prototype.PromptManager = PromptManager;
AgentTaskFramework.prototype.ProactiveManager = ProactiveManager;

async function ensureAgent(todoServerUrl, agentId) {
  const response = await fetch(`${todoServerUrl}/api/agents/${agentId}`);
  if (!response.ok) {
    console.log(`创建新的智能体: ${agentId}`);
    const createResponse = await fetch(`${todoServerUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: agentId, metadata: { source: 'framework-demo' } })
    });
    const data = await createResponse.json();
    console.log(`智能体已创建: ${data.data.id}`);
    return data.data.id;
  }
  return agentId;
}

async function example1_MinimalUsage() {
  console.log('\n========== 阶段1：最小化使用 ==========\n');
  
  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: 'demo-agent-1',
      enableLogging: true
    }
  });

  await framework.initialize();

  console.log('\n框架状态:', framework.getStatus());
  console.log('✅ 框架已就绪，可以开始对话\n');
  
  return framework;
}

async function example2_BasicTaskManagement() {
  console.log('\n\n========== 阶段2：基础任务管理 ==========\n');
  
  const agentId = await ensureAgent('http://localhost:3000', 'demo-agent-2');
  
  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: agentId,
      enableLogging: true
    },
    features: {
      taskManagement: {
        enabled: true,
        autoCreateTasks: false,
        autoUpdateStatus: false,
        priority: 'medium'
      }
    }
  });

  await framework.initialize();

  const taskManager = framework.modules.taskManager;
  
  const task1 = await taskManager.createTask({
    title: '完成用户调研报告',
    priority: 'high',
    context: '这是Q2季度的核心交付物'
  });
  console.log('✅ 任务1创建成功:', task1.title);

  const task2 = await taskManager.createTask({
    title: '修复登录Bug',
    priority: 'critical'
  });
  console.log('✅ 任务2创建成功:', task2.title);

  const taskInfo = await taskManager.getTaskInfo();
  console.log('\n📊 任务概览:');
  console.log(`   总计: ${taskInfo.total}`);
  console.log(`   待处理: ${taskInfo.pending}`);
  console.log(`   已完成: ${taskInfo.completed}`);
  console.log(`   被阻塞: ${taskInfo.blocked}`);

  await taskManager.startTask(task1.id);
  console.log(`\n⚡ 已标记任务开始: ${task1.title}`);

  const readyTasks = await taskManager.getReadyTasks();
  console.log(`✨ 可执行任务: ${readyTasks.length} 个`);

  return framework;
}

async function example3_FullFeatured() {
  console.log('\n\n========== 阶段3：完整功能 ==========\n');
  
  const agentId = await ensureAgent('http://localhost:3000', 'demo-agent-3');
  
  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: agentId,
      enableLogging: true
    },
    features: {
      taskManagement: {
        enabled: true,
        autoCreateTasks: true,
        autoUpdateStatus: false,  // 禁用自动更新，避免误判
        priority: 'medium'
      },
      contextManagement: {
        enabled: true,
        injectInterval: 'every_turn',
        maxContextLength: 2000,
        prioritizeBy: 'priority'
      },
      memoryManagement: {
        enabled: true,
        memoryTypes: ['task_history', 'key_decisions'],
        memoryRetention: 7,
        autoSummarize: true
      },
      promptManagement: {
        enabled: true,
        autoEnhance: true,
        addChecklist: true,
        addProgress: true
      },
      proactiveInteraction: {
        enabled: true,
        remindInterval: 5,
        suggestOnIdle: true,
        blockOffTopic: false
      },
      dependencyManagement: {
        enabled: true,
        autoDetect: false,
        blockOnMissing: false,
        showBlockers: true
      }
    }
  });

  await framework.initialize();

  console.log('框架状态:', framework.getStatus());

  const taskManager = framework.modules.taskManager;
  await taskManager.planTaskChain([
    {
      title: '收集用户反馈',
      priority: 'high',
      context: '通过访谈和问卷收集'
    },
    {
      title: '分析反馈数据',
      priority: 'high',
      dependsOnPrevious: true
    },
    {
      title: '撰写分析报告',
      priority: 'medium',
      dependsOnPrevious: true
    }
  ]);
  console.log('✅ 任务链已规划');

  const result = await framework.processMessage('帮我整理一下用户反馈');
  console.log('\n📝 处理结果:');
  console.log('   - 活跃模块:', result.metrics.modulesActive);
  console.log('   - 处理时间:', result.metrics.duration, 'ms');
  console.log('   - 上下文摘要:', result.context.features.contextSummary ? '已生成' : '未生成');

  return framework;
}

async function example4_DynamicFeatureToggle() {
  console.log('\n\n========== 阶段4：动态功能开关 ==========\n');
  
  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: 'demo-agent-4',
      enableLogging: true
    }
  });

  await framework.initialize();

  console.log('初始状态:', framework.getStatus());

  console.log('\n🔌 启用任务管理...');
  framework.enableFeature('taskManagement');
  console.log('状态:', framework.getStatus());

  console.log('\n🔌 启用上下文管理...');
  framework.enableFeature('contextManagement');
  console.log('状态:', framework.getStatus());

  console.log('\n🔌 启用主动交互...');
  framework.enableFeature('proactiveInteraction');
  console.log('状态:', framework.getStatus());

  console.log('\n🔌 禁用主动交互...');
  framework.disableFeature('proactiveInteraction');
  console.log('状态:', framework.getStatus());

  return framework;
}

async function example5_CustomIntegration() {
  console.log('\n\n========== 阶段5：自定义集成 ==========\n');
  
  const agentId = await ensureAgent('http://localhost:3000', 'demo-agent-5');
  
  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: agentId,
      enableLogging: true
    },
    features: {
      taskManagement: {
        enabled: true,
        autoCreateTasks: true,
        autoUpdateStatus: false,  // 禁用自动更新，避免误判
        priority: 'high'
      },
      contextManagement: {
        enabled: true,
        injectInterval: 'manual',
        maxContextLength: 1500,
        prioritizeBy: 'dependency'
      },
      promptManagement: {
        enabled: true,
        systemPrompt: `你是一个专业的项目管理AI助手。
        
你的职责：
1. 帮助用户管理项目任务
2. 跟踪项目进度
3. 识别风险和阻塞
4. 提供项目管理建议

工作方式：
- 主动询问用户的需求
- 定期更新任务状态
- 识别任务依赖关系
- 预测潜在风险`,
        autoEnhance: true,
        addChecklist: true,
        addProgress: true
      }
    }
  });

  await framework.initialize();

  const promptManager = framework.modules.promptManager;
  
  promptManager.createPromptTemplate('daily_standup', `
你是敏捷团队的助手。请生成每日站会的汇报。

当前任务状态：
{{taskStatus}}

请按以下格式生成汇报：
1. 昨天完成了什么
2. 今天计划做什么
3. 遇到什么阻碍

保持简洁，每个点不超过2句话。`);

  const taskInfo = await framework.modules.taskManager.getTaskInfo();
  const dailyPrompt = await promptManager.useTemplate('daily_standup', {
    taskStatus: JSON.stringify(taskInfo)
  });

  console.log('✅ 自定义Prompt模板创建成功');
  console.log('   Prompt长度:', dailyPrompt.length, '字符');

  const result = await framework.processMessage('帮我生成今天的站会汇报');
  console.log('\n📋 生成的汇报预览:');
  console.log(result.response.message.substring(0, 300) + '...\n');

  return framework;
}

async function runAllExamples() {
  console.log('🚀 Agent Task Framework 渐进式集成示例\n');
  console.log('='.repeat(60));

  try {
    await example1_MinimalUsage();
    await example2_BasicTaskManagement();
    await example3_FullFeatured();
    await example4_DynamicFeatureToggle();
    await example5_CustomIntegration();

    console.log('\n\n' + '='.repeat(60));
    console.log('✅ 所有示例执行完成！\n');
    console.log('📚 下一步：');
    console.log('   1. 查看 examples/ConfigExamples.js 获取配置示例');
    console.log('   2. 查看 framework/README.md 获取完整文档');
    console.log('   3. 根据需求组合不同功能模块\n');
  } catch (error) {
    console.error('\n❌ 示例执行失败:', error.message);
    console.error(error.stack);
  }
}

// 运行示例
runAllExamples();
