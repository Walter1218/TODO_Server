#!/usr/bin/env node
/**
 * TODO Server 安装向导
 * 
 * 一键完成环境初始化：
 * - 创建必要目录（data/, logs/）
 * - 生成 .env 环境变量文件
 * - 生成 config.json（框架客户端配置）
 * - 验证 Node.js 版本
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

function ensureDir(dir) {
  const fullPath = path.join(PROJECT_ROOT, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
    console.log(`  ✅ 创建目录: ${dir}/`);
  } else {
    console.log(`  ⏭️  目录已存在: ${dir}/`);
  }
}

function writeFileIfNotExists(filePath, content) {
  const fullPath = path.join(PROJECT_ROOT, filePath);
  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, content);
    console.log(`  ✅ 创建文件: ${filePath}`);
  } else {
    console.log(`  ⏭️  文件已存在: ${filePath}`);
  }
}

function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0]);
  if (major < 18) {
    console.error(`  ❌ Node.js 版本过低: ${version}，需要 >= 18`);
    process.exit(1);
  }
  console.log(`  ✅ Node.js 版本: ${version}`);
}

function main() {
  console.log('🚀 TODO Server 安装向导\n');
  console.log('='.repeat(50));

  // 1. 检查 Node.js 版本
  console.log('\n📋 检查环境...');
  checkNodeVersion();

  // 2. 创建必要目录
  console.log('\n📁 创建目录...');
  ensureDir('data');
  ensureDir('logs');

  // 3. 创建 .env（服务器配置）
  console.log('\n⚙️  生成环境变量配置...');
  writeFileIfNotExists('.env', `PORT=3000
DB_PATH=./data/todo.db
LOG_LEVEL=info
NODE_ENV=development
`);

  // 4. 创建 .env.example（模板）
  writeFileIfNotExists('.env.example', `PORT=3000
DB_PATH=./data/todo.db
LOG_LEVEL=info
NODE_ENV=development
`);

  // 5. 创建 config.json（框架客户端配置）
  console.log('\n🔧 生成框架客户端配置...');
  const defaultConfig = {
    server: {
      url: 'http://localhost:3000'
    },
    llm: {
      provider: 'minimax',
      minimax: {
        apiKey: '',
        groupId: '',
        model: 'MiniMax-Text-01',
        temperature: 0.7,
        maxTokens: 2000
      },
      openai: {
        apiKey: '',
        model: 'gpt-3.5-turbo',
        temperature: 0.7,
        maxTokens: 2000
      },
      anthropic: {
        apiKey: '',
        model: 'claude-3-5-haiku-20241022',
        temperature: 0.7,
        maxTokens: 1024
      }
    },
    agent: {
      id: require('crypto').randomUUID(),
      name: '我的智能体'
    },
    features: {
      taskManagement: {
        enabled: true,
        autoCreateTasks: false,
        autoUpdateStatus: false,
        priority: 'medium'
      },
      contextManagement: {
        enabled: true,
        injectInterval: 'every_turn',
        maxContextLength: 2000,
        prioritizeBy: 'priority'
      },
      memoryManagement: {
        enabled: false,
        memoryRetention: 7
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
        suggestOnIdle: true
      },
      dependencyManagement: {
        enabled: true,
        showBlockers: true
      }
    }
  };

  writeFileIfNotExists('config.json', JSON.stringify(defaultConfig, null, 2));

  // 6. 完成提示
  console.log('\n' + '='.repeat(50));
  console.log('✅ 安装完成！\n');
  console.log('📖 快速开始：');
  console.log('   npm start          # 启动 TODO Server (API)');
  console.log('   npm run dev        # 开发模式（热重载）');
  console.log('   npm run agent      # 启动框架客户端（需配置 LLM）');
  console.log('\n⚠️  如需使用框架客户端，请编辑 config.json 填写 LLM API Key');
  console.log('   或设置环境变量: export MINIMAX_API_KEY=your_key');
  console.log('');
}

main();
