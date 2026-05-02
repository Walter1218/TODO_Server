const { getDb } = require('../src/db');
const db = getDb();

console.log('=== 每日调度任务重复检测报告 ===\n');

// 1. 分析模板任务
const templates = db.prepare(`
  SELECT id, agent_id, title, schedule, next_due_at, last_spawned_at, created_at
  FROM todos
  WHERE is_template = 1 AND schedule IS NOT NULL
  ORDER BY agent_id, title
`).all();

console.log(`模板任务总数: ${templates.length}`);
console.log('---');

const agentTasks = {};
templates.forEach(t => {
  if (!agentTasks[t.agent_id]) agentTasks[t.agent_id] = [];
  agentTasks[t.agent_id].push(t);
});

let duplicateTemplates = [];

Object.keys(agentTasks).forEach(agentId => {
  console.log(`\n🤖 Agent: ${agentId}`);
  const tasks = agentTasks[agentId];
  
  const titleGroups = {};
  tasks.forEach(t => {
    if (!titleGroups[t.title]) titleGroups[t.title] = [];
    titleGroups[t.title].push(t);
  });
  
  Object.keys(titleGroups).forEach(title => {
    const group = titleGroups[title];
    if (group.length > 1) {
      console.log(`  ⚠️ [重复] '${title}' - ${group.length} 个模板`);
      group.forEach(t => {
        console.log(`    - ID: ${t.id}, 下次执行: ${t.next_due_at || '未设置'}`);
      });
      duplicateTemplates.push({ agentId, title, count: group.length, tasks: group });
    } else {
      console.log(`  ✓ '${title}'`);
    }
  });
});

// 2. 分析生成的实例任务
console.log('\n=== 生成的任务实例分析 ===');
const spawnedTasks = db.prepare(`
  SELECT t.title, t.status, t.created_at, t.parent_id, p.title as parent_title
  FROM todos t
  LEFT JOIN todos p ON t.parent_id = p.id
  WHERE t.is_template = 0 AND t.parent_id IS NOT NULL
    AND t.status NOT IN ('completed', 'cancelled')
  ORDER BY t.title, t.created_at DESC
`).all();

console.log(`进行中的实例任务: ${spawnedTasks.length}`);

let duplicateInstances = [];
const instanceGroups = {};
spawnedTasks.forEach(t => {
  if (!instanceGroups[t.title]) instanceGroups[t.title] = [];
  instanceGroups[t.title].push(t);
});

Object.keys(instanceGroups).forEach(title => {
  const group = instanceGroups[title];
  if (group.length > 1) {
    console.log(`\n⚠️ [重复实例] '${title}' - ${group.length} 个进行中实例`);
    group.forEach(t => {
      console.log(`    - ${t.status} 创建于: ${t.created_at} (模板: ${t.parent_title || t.parent_id})`);
    });
    duplicateInstances.push({ title, count: group.length, instances: group });
  }
});

// 3. 分析过时任务（7天未更新）
console.log('\n=== 7天未更新的任务 ===');
const oldTasks = db.prepare(`
  SELECT id, title, status, created_at, updated_at
  FROM todos
  WHERE is_template = 0 AND status NOT IN ('completed', 'cancelled')
    AND updated_at < datetime('now', '-7 days')
  ORDER BY updated_at ASC
`).all();

console.log(`7天未更新的进行中任务: ${oldTasks.length}`);
oldTasks.forEach(t => {
  console.log(`  ⏰ '${t.title}' - ${t.status} - 最后更新: ${t.updated_at}`);
});

// 4. 生成建议
console.log('\n=== 清理建议 ===');
if (duplicateTemplates.length === 0 && duplicateInstances.length === 0 && oldTasks.length === 0) {
  console.log('✅ 未发现重复或过时任务');
} else {
  if (duplicateTemplates.length > 0) {
    console.log('\n🔧 重复模板处理建议:');
    duplicateTemplates.forEach(d => {
      console.log(`  - Agent ${d.agentId} 的 '${d.title}' 有 ${d.count} 个重复模板`);
      console.log(`    建议: 删除多余模板或合并到一个`);
    });
  }
  
  if (duplicateInstances.length > 0) {
    console.log('\n🔧 重复实例处理建议:');
    duplicateInstances.forEach(d => {
      console.log(`  - '${d.title}' 有 ${d.count} 个进行中实例`);
      console.log(`    建议: 保留最新实例，取消其他实例`);
    });
  }
  
  if (oldTasks.length > 0) {
    console.log('\n🔧 过时任务处理建议:');
    oldTasks.forEach(t => {
      console.log(`  - '${t.title}' (${t.id}) - 建议检查状态或标记为完成`);
    });
  }
}

console.log('\n=== 报告结束 ===');