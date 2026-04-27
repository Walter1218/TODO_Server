/**
 * LLM集成示例
 * 
 * 展示如何使用OpenAI和Anthropic LLM
 */

const AgentTaskFramework = require('../core/Framework');

async function example1_NoLLM() {
  console.log('\n========== 示例1：无LLM模式 ==========\n');
  
  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: 'llm-demo-1'
    },
    features: {
      taskManagement: { enabled: true }
    }
    // 没有配置 llm
  });

  await framework.initialize();

  const result = await framework.processMessage('你好');
  console.log('回复：');
  console.log(result.response.message);

  console.log('\n状态信息：', framework.getStatus());

  return framework;
}

async function example2_OpenAI() {
  console.log('\n\n========== 示例2：OpenAI集成 ==========\n');

  // 检查是否配置了API Key
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    console.log('⚠️ 未设置 OPENAI_API_KEY 环境变量');
    console.log('请运行：export OPENAI_API_KEY=your-api-key\n');
    return;
  }

  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: 'llm-demo-2'
    },
    llm: {
      provider: 'openai',
      apiKey: apiKey,
      model: 'gpt-3.5-turbo',
      temperature: 0.7,
      maxTokens: 500
    },
    features: {
      taskManagement: { enabled: true },
      promptManagement: { enabled: true }
    }
  });

  await framework.initialize();

  console.log('LLM状态：', framework.getLLMManager().getModelInfo());

  // 创建几个任务
  const taskManager = framework.modules.taskManager;
  await taskManager.createTask({
    title: '完成项目报告',
    priority: 'high',
    context: '这是Q2季度的核心交付物'
  });
  await taskManager.createTask({
    title: '修复Bug',
    priority: 'critical',
    context: '生产环境紧急Bug'
  });

  console.log('\n📝 已创建2个任务\n');

  // 处理消息
  const result = await framework.processMessage('帮我整理一下当前的工作任务');
  console.log('AI回复：');
  console.log(result.response.message);

  console.log('\nToken使用：', result.response.usage);

  return framework;
}

async function example3_Anthropic() {
  console.log('\n\n========== 示例3：Anthropic (Claude) 集成 ==========\n');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    console.log('⚠️ 未设置 ANTHROPIC_API_KEY 环境变量');
    console.log('请运行：export ANTHROPIC_API_KEY=your-api-key\n');
    return;
  }

  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: 'llm-demo-3'
    },
    llm: {
      provider: 'anthropic',
      apiKey: apiKey,
      model: 'claude-3-5-haiku-20241022',
      temperature: 0.7,
      maxTokens: 500
    },
    features: {
      taskManagement: { enabled: true },
      promptManagement: { enabled: true }
    }
  });

  await framework.initialize();

  console.log('LLM状态：', framework.getLLMManager().getModelInfo());

  const result = await framework.processMessage('我有哪些待完成的任务？');
  console.log('Claude回复：');
  console.log(result.response.message);

  return framework;
}

async function example4_FullFeatured() {
  console.log('\n\n========== 示例4：完整功能 + LLM ==========\n');

  const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    console.log('⚠️ 未设置 LLM API Key');
    console.log('请设置 OPENAI_API_KEY 或 ANTHROPIC_API_KEY\n');
    return;
  }

  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: 'llm-demo-4'
    },
    llm: {
      provider: process.env.OPENAI_API_KEY ? 'openai' : 'anthropic',
      apiKey: apiKey,
      model: process.env.OPENAI_API_KEY ? 'gpt-3.5-turbo' : 'claude-3-5-haiku-20241022',
      temperature: 0.7,
      maxTokens: 800
    },
    features: {
      taskManagement: { enabled: true },
      contextManagement: { enabled: true },
      memoryManagement: { enabled: true },
      promptManagement: {
        enabled: true,
        addChecklist: true,
        addProgress: true
      },
      proactiveInteraction: { enabled: true }
    }
  });

  await framework.initialize();

  console.log('框架状态：');
  console.log('- 已启用功能：', framework.getStatus().enabledFeatures);
  console.log('- LLM信息：', framework.getLLMManager().getModelInfo());

  // 创建任务链
  const taskManager = framework.modules.taskManager;
  await taskManager.planTaskChain([
    {
      title: '用户调研',
      priority: 'high',
      context: '了解用户需求'
    },
    {
      title: '需求分析',
      priority: 'high',
      dependsOnPrevious: true
    },
    {
      title: '撰写报告',
      priority: 'medium',
      dependsOnPrevious: true
    }
  ]);

  console.log('\n✅ 任务链已创建\n');

  // 对话
  const messages = [
    { role: 'user', content: '我需要完成一个用户调研项目' },
    { role: 'assistant', content: '好的，我来帮你规划。用户调研通常包括以下几个步骤...' },
    { role: 'user', content: '先帮我开始调研阶段吧' }
  ];

  const result = await framework.processMessage('我现在的任务进度如何？', messages);
  
  console.log('\n💬 AI回复：');
  console.log(result.response.message);

  console.log('\n📊 处理指标：');
  console.log('- 处理时间：', result.metrics.duration, 'ms');
  console.log('- 活跃模块：', result.metrics.modulesActive);

  return framework;
}

async function runExamples() {
  console.log('🚀 LLM集成示例\n');
  console.log('='.repeat(60));

  try {
    await example1_NoLLM();
    await example2_OpenAI();
    await example3_Anthropic();
    await example4_FullFeatured();

    console.log('\n\n' + '='.repeat(60));
    console.log('✅ 所有示例执行完成！\n');
  } catch (error) {
    console.error('\n❌ 示例执行失败:', error.message);
    console.error(error.stack);
  }
}

// 运行示例
runExamples();
