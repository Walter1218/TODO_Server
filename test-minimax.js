const MiniMaxProvider = require('./framework/llm/MiniMaxProvider');

async function test() {
  const provider = new MiniMaxProvider({
    apiKey: process.env.MINIMAX_API_KEY || 'test-api-key',
    model: 'MiniMax-M2.7'
  });

  console.log('测试 MiniMax Provider...\n');

  try {
    const result = await provider.chat({
      messages: [
        { role: 'user', content: '你好，请介绍一下你自己' }
      ],
      system: '你是一个有帮助的助手',
      maxTokens: 500
    });

    console.log('✅ 成功！');
    console.log('\n回复内容：');
    console.log(result.content);
    console.log('\n使用信息：', result.usage);
  } catch (error) {
    console.error('❌ 失败:', error.message);
  }
}

test();
