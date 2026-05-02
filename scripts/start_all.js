const { spawn } = require('child_process');
const path = require('path');

const agents = [
  { name: 'Default', config: 'config.hermes-default.json' },
  { name: 'Ops', config: 'config.hermes-ops.json' },
  { name: 'Coder', config: 'config.hermes-coder.json' }
];

console.log('🚀 正在启动 Hermes 多智能体集群...');
console.log('='.repeat(40));

agents.forEach(agent => {
  const child = spawn('node', ['start.js', '--config', agent.config], {
    stdio: 'inherit',
    shell: true
  });

  child.on('error', (err) => {
    console.error(`❌ [${agent.name}] 启动失败:`, err.message);
  });

  console.log(`✅ [${agent.name}] 已启动 (配置: ${agent.config})`);
});

console.log('='.repeat(40));
console.log('💡 所有智能体已在后台运行。您可以查看控制台输出以监控它们的行为。');
