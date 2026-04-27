/**
 * MiniMax 集成示例
 * 
 * 展示如何使用 MiniMax LLM
 */

const AgentTaskFramework = require('../core/Framework');

async function example1_MiniMaxBasic() {
  console.log('\n========== 示例1：MiniMax 基础使用 ==========\n');

  // 检查环境变量
  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  
  if (!apiKey) {
    console.log('⚠️ 未设置 MINIMAX_API_KEY 环境变量');
    console.log('请运行：');
    console.log('  export MINIMAX_API_KEY=your-api-key');
    console.log('  export MINIMAX_GROUP_ID=your-group-id');
    console.log();
    console.log('获取API Key: https://platform.minimax.io/');
    return;
  }

  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: 'minimax-demo'
    },
    llm: {
      provider: 'minimax',
      apiKey: apiKey,
      groupId: groupId,
      model: 'MiniMax-Text-01',
      temperature: 0.7,
      maxTokens: 1000
    },
    features: {
      taskManagement: { enabled: true },
      promptManagement: { enabled: true }
    }
  });

  await framework.initialize();

  console.log('LLM信息:', framework.getLLMManager().getModelInfo());

  // 创建任务
  const taskManager = framework.modules.taskManager;
  await taskManager.createTask({
    title: '完成市场分析报告',
    priority: 'high',
    context: '这是Q2季度的核心任务'
  });

  console.log('\n📝 已创建任务\n');

  // 对话
  const result = await framework.processMessage('我有哪些待处理的任务？');
  console.log('MiniMax 回复：');
  console.log(result.response.message);

  if (result.response.usage) {
    console.log('\nToken使用：', result.response.usage);
  }

  return framework;
}

async function example2_MiniMaxWithTasks() {
  console.log('\n\n========== 示例2：MiniMax + 任务管理 ==========\n');

  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  
  if (!apiKey) {
    console.log('⚠️ 未设置 MINIMAX_API_KEY');
    return;
  }

  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: 'minimax-demo-2'
    },
    llm: {
      provider: 'minimax',
      apiKey: apiKey,
      groupId: groupId,
      model: 'MiniMax-Text-01'
    },
    features: {
      taskManagement: { enabled: true },
      contextManagement: { enabled: true },
      promptManagement: { enabled: true }
    }
  });

  await framework.initialize();

  // 创建任务链
  const taskManager = framework.modules.taskManager;
  await taskManager.planTaskChain([
    {
      title: '用户调研',
      priority: 'critical',
      context: '了解目标用户的需求和痛点'
    },
    {
      title: '竞品分析',
      priority: 'high',
      dependsOnPrevious: true
    },
    {
      title: '撰写报告',
      priority: 'medium',
      dependsOnPrevious: true
    }
  ]);

  console.log('✅ 任务链已创建\n');

  // 对话
  const result = await framework.processMessage('我的任务优先级是什么？应该先做什么？');
  console.log('回复：');
  console.log(result.response.message);

  return framework;
}

async function runExamples() {
  console.log('🚀 MiniMax LLM 集成示例\n');
  console.log('='.repeat(60));

  try {
    await example1_MiniMaxBasic();
    await example2_MiniMaxWithTasks();

    console.log('\n\n' + '='.repeat(60));
    console.log('✅ 示例执行完成！\n');
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message);
    console.error(error.stack);
  }
}

// 运行示例
runExamples();
