const { AgentTaskFramework } = require('./framework');

async function test() {
  console.log('测试 LLM 调用...\n');
  
  const framework = new AgentTaskFramework({
    base: {
      todoServerUrl: 'http://localhost:3000',
      agentId: 'be071684-a068-46f9-8fc8-04b6484cc356',
      enableLogging: true
    },
    llm: {
      provider: 'minimax',
      apiKey: 'sk-cp-5Ta1Ur5ytb4uy4HPVW9Pu6Gcox0-maiU4TGZ-GQs22JeGHPY-7jhoh2n0boUE6IUp9ilRJrMPQjaVNOP9Z61Lw-8qY8k7p0huF-vxcI6MuqNdaD3Jjxgap0',
      model: 'MiniMax-M2.7',
      temperature: 0.7,
      maxTokens: 500
    }
  });

  await framework.initialize();

  console.log('\n直接调用 LLM Manager...\n');
  
  try {
    const result = await framework.modules.llmManager.chat({
      messages: [
        { role: 'user', content: '你好' }
      ],
      system: '你是一个有帮助的助手'
    });

    console.log('\n✅ LLM调用成功！');
    console.log('内容:', result.content);
    console.log('使用:', result.usage);
  } catch (error) {
    console.error('❌ LLM调用失败:', error.message);
  }
}

test();
