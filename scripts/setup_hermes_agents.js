const Agent = require('../src/models/Agent');
const { getDb } = require('../src/db');
const fs = require('fs');
const path = require('path');

async function setupAgents() {
  console.log('🛠️ 开始初始化 Hermes 智能体接入...');

  const agentsToCreate = [
    { id: 'hermes-default', name: 'hermes-default' },
    { id: 'hermes-ops', name: 'hermes-ops' },
    { id: 'hermes-coder', name: 'hermes-coder' }
  ];

  const results = [];

  for (const agentDef of agentsToCreate) {
    let agent = Agent.findById(agentDef.id, true);
    if (!agent) {
      agent = Agent.create(agentDef);
      console.log(`✅ 已注册新智能体: ${agent.name} (ID: ${agent.id})`);
    } else {
      console.log(`ℹ️ 智能体已存在: ${agent.name}`);
    }
    results.push(agent);
  }

  // 为每个智能体创建独立的配置文件
  const baseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

  for (const agent of results) {
    const agentConfig = {
      ...baseConfig,
      agent: {
        id: agent.id,
        name: agent.name,
        secretKey: agent.secret_key
      }
    };

    const configPath = path.join(__dirname, '..', `config.${agent.name}.json`);
    fs.writeFileSync(configPath, JSON.stringify(agentConfig, null, 2));
    console.log(`📝 已生成配置文件: ${path.basename(configPath)}`);
  }

  // 同步凭证到 Hermes 的 agents.yaml
  try {
    const hermesHome = process.env.HERMES_HOME || path.join(process.env.HOME || process.env.USERPROFILE, '.hermes');
    const skillPath = path.join(hermesHome, 'skills', 'hermes-todo-skill');
    const agentsYamlPath = path.join(skillPath, 'agents.yaml');

    if (fs.existsSync(skillPath)) {
      console.log(`\n🔄 正在同步凭证到 Hermes Skill (${agentsYamlPath})...`);
      
      const agentsYamlContent = {
        agents: {
          default: { agent_id: 'hermes-default', secret_key: results.find(a => a.id === 'hermes-default').secret_key },
          ops: { agent_id: 'hermes-ops', secret_key: results.find(a => a.id === 'hermes-ops').secret_key },
          coder: { agent_id: 'hermes-coder', secret_key: results.find(a => a.id === 'hermes-coder').secret_key }
        }
      };

      // 简单的 YAML 写入
      const yamlStr = "agents:\n" + Object.entries(agentsYamlContent.agents).map(([k, v]) => 
        `  ${k}:\n    agent_id: ${v.agent_id}\n    secret_key: ${v.secret_key}`
      ).join("\n");
      
      fs.writeFileSync(agentsYamlPath, yamlStr);
      console.log('✅ agents.yaml 同步成功');
    }
  } catch (err) {
    console.log(`⚠️ 同步 agents.yaml 失败: ${err.message}`);
  }

  console.log('\n🚀 所有智能体已成功接入！');
  console.log('='.repeat(30));
  results.forEach(a => {
    console.log(`- ${a.name}: ${a.id} (Secret: ${a.secret_key.substring(0, 4)}***)`);
  });
}

setupAgents().catch(console.error);
