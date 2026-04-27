/**
 * 启动智能体 - 最简单的启动方式
 * 
 * 使用配置文件启动智能体
 */

const { AgentTaskFramework } = require('./framework');

async function main() {
  console.log('🚀 Agent TODO Framework 启动器\n');
  console.log('='.repeat(50));

  try {
    // 从配置文件加载框架
    console.log('\n📄 加载配置文件...');
    const framework = AgentTaskFramework.fromConfig();

    // 初始化
    console.log('\n⚙️ 初始化框架...');
    await framework.initialize();

    // 显示状态
    console.log('\n📊 框架状态：');
    const status = framework.getStatus();
    console.log('- 已初始化:', status.initialized);
    console.log('- 活跃模块:', status.activeModules.length);
    console.log('- 已启用功能:', status.enabledFeatures);
    console.log('- LLM:', status.llm?.provider || '未配置');

    // 测试对话
    console.log('\n💬 测试对话...');
    const result = await framework.processMessage('你好，请介绍一下你自己');
    console.log('\n🤖 回复：');
    console.log(result.response.message);

    console.log('\n' + '='.repeat(50));
    console.log('✅ 智能体启动成功！\n');

    // 返回框架实例供外部使用
    return framework;
  } catch (error) {
    console.error('\n❌ 启动失败:', error.message);
    console.error('\n请检查：');
    console.error('1. config.json 是否存在');
    console.error('2. LLM API Key 是否已配置');
    console.error('3. TODO Server 是否运行\n');
    process.exit(1);
  }
}

// 交互式对话循环
async function chatLoop(framework) {
  const readline = require('readline');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('\n💬 进入对话模式（输入 exit 退出）\n');

  const askQuestion = () => {
    rl.question('你: ', async (input) => {
      if (input.toLowerCase() === 'exit') {
        console.log('\n再见！\n');
        rl.close();
        process.exit(0);
      }

      try {
        const result = await framework.processMessage(input);
        console.log('\n🤖:', result.response.message, '\n');
      } catch (error) {
        console.error('❌ 错误:', error.message, '\n');
      }

      askQuestion();
    });
  };

  askQuestion();
}

// 运行
if (require.main === module) {
  (async () => {
    const framework = await main();
    
    // 如果提供了命令行参数 --chat，则进入对话模式
    if (process.argv.includes('--chat')) {
      chatLoop(framework);
    } else {
      console.log('💡 提示：使用 --chat 参数进入对话模式');
      console.log('   npm run agent -- --chat\n');
      process.exit(0);
    }
  })();
}

module.exports = { main, chatLoop };
