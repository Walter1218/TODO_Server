/**
 * 配置文件使用示例
 * 
 * 展示如何使用配置文件初始化框架
 */

const { AgentTaskFramework, ConfigLoader } = require('../index');

async function example1_LoadFromConfigFile() {
  console.log('\n========== 示例1：从配置文件加载 ==========\n');
  
  try {
    // 方式1：自动查找配置文件（默认查找 config.json）
    const framework1 = AgentTaskFramework.fromConfig();
    await framework1.initialize();
    
    console.log('框架状态：', framework1.getStatus());
    console.log('\nLLM信息：', framework1.getLLMManager().getModelInfo());

    // 处理消息
    const result = await framework1.processMessage('你好');
    console.log('\n回复：', result.response.message.substring(0, 200) + '...');

    return framework1;
  } catch (error) {
    console.error('❌ 加载失败:', error.message);
    return null;
  }
}

async function example2_LoadSpecificConfigFile() {
  console.log('\n\n========== 示例2：指定配置文件路径 ==========\n');
  
  try {
    // 指定配置文件路径
    const configPath = '/path/to/your/config.json';
    const framework = AgentTaskFramework.fromConfig(configPath);
    await framework.initialize();
    
    console.log('框架状态：', framework.getStatus());
    return framework;
  } catch (error) {
    console.error('❌ 加载失败:', error.message);
    return null;
  }
}

async function example3_LoadWithOverrides() {
  console.log('\n\n========== 示例3：加载配置并覆盖 ==========\n');
  
  try {
    // 从配置文件加载，但覆盖某些设置
    const framework = AgentTaskFramework.fromConfig(null, {
      base: {
        agentId: 'custom-agent-id'
      },
      features: {
        taskManagement: {
          enabled: true,
          autoUpdateStatus: true  // 开启自动更新
        }
      }
    });
    
    await framework.initialize();
    
    console.log('框架状态：', framework.getStatus());
    console.log('\n配置已覆盖：');
    console.log('- agentId: custom-agent-id');
    console.log('- autoUpdateStatus: true');

    return framework;
  } catch (error) {
    console.error('❌ 加载失败:', error.message);
    return null;
  }
}

async function example4_ManualConfigLoader() {
  console.log('\n\n========== 示例4：手动使用配置加载器 ==========\n');
  
  try {
    // 手动加载配置
    const config = ConfigLoader.load();
    console.log('原始配置：', JSON.stringify(config, null, 2).substring(0, 300) + '...');

    // 验证配置
    const validation = ConfigLoader.validate(config);
    console.log('\n配置验证：', validation);

    if (!validation.valid) {
      console.warn('\n⚠️ 配置存在问题：');
      validation.errors.forEach(err => console.warn(`  - ${err}`));
    }

    // 转换为框架配置
    const frameworkConfig = ConfigLoader.toFrameworkConfig(config);
    console.log('\n框架配置：', JSON.stringify(frameworkConfig, null, 2).substring(0, 300) + '...');

    // 创建框架
    const framework = new AgentTaskFramework(frameworkConfig);
    await framework.initialize();
    
    console.log('\n框架状态：', framework.getStatus());

    return framework;
  } catch (error) {
    console.error('❌ 加载失败:', error.message);
    return null;
  }
}

async function example5_CreateDefaultConfig() {
  console.log('\n\n========== 示例5：创建默认配置 ==========\n');
  
  try {
    // 创建默认配置
    const defaultConfig = ConfigLoader.createDefault();
    console.log('默认配置已创建：');
    console.log('- provider:', defaultConfig.llm.provider);
    console.log('- model:', defaultConfig.llm.minimax.model);
    console.log('- features:', Object.keys(defaultConfig.features));

    // 保存到文件
    ConfigLoader.save(defaultConfig, 'my-config.json');
    console.log('\n✅ 配置已保存到 my-config.json');

    return defaultConfig;
  } catch (error) {
    console.error('❌ 创建失败:', error.message);
    return null;
  }
}

async function runExamples() {
  console.log('🚀 配置文件使用示例\n');
  console.log('='.repeat(60));
  console.log('提示：请先在 config.json 中配置你的 API Key\n');

  try {
    await example1_LoadFromConfigFile();
    await example2_LoadSpecificConfigFile();
    await example3_LoadWithOverrides();
    await example4_ManualConfigLoader();
    await example5_CreateDefaultConfig();

    console.log('\n\n' + '='.repeat(60));
    console.log('✅ 示例执行完成！\n');
    console.log('📝 下一步：');
    console.log('   1. 编辑 config.json 填入你的 API Key');
    console.log('   2. 运行示例查看效果');
    console.log('   3. 根据需要调整 features 配置\n');
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message);
    console.error(error.stack);
  }
}

// 运行示例
runExamples();
