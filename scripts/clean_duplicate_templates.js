const { getDb } = require('../src/db');
const db = getDb();

console.log('=== 自动清理重复模板 ===\n');

const templates = db.prepare(`
  SELECT id, agent_id, title, schedule, next_due_at, last_spawned_at, created_at
  FROM todos
  WHERE is_template = 1 AND schedule IS NOT NULL
  ORDER BY agent_id, title
`).all();

const agentTasks = {};
templates.forEach(t => {
  if (!agentTasks[t.agent_id]) agentTasks[t.agent_id] = [];
  agentTasks[t.agent_id].push(t);
});

let deletedCount = 0;
let keptCount = 0;

Object.keys(agentTasks).forEach(agentId => {
  const tasks = agentTasks[agentId];
  
  const titleGroups = {};
  tasks.forEach(t => {
    if (!titleGroups[t.title]) titleGroups[t.title] = [];
    titleGroups[t.title].push(t);
  });
  
  Object.keys(titleGroups).forEach(title => {
    const group = titleGroups[title];
    if (group.length > 1) {
      console.log(`\n处理重复模板: '${title}' (${group.length} 个)`);
      
      // 按创建时间排序，保留最新的
      group.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      
      const keep = group[0];
      const deleteList = group.slice(1);
      
      console.log(`  ✓ 保留: ${keep.id} (创建于: ${keep.created_at})`);
      keptCount++;
      
      deleteList.forEach(t => {
        console.log(`  ✗ 删除: ${t.id} (创建于: ${t.created_at})`);
        
        // 删除模板及其关联的生成任务
        db.prepare(`DELETE FROM todos WHERE id = ?`).run(t.id);
        
        deletedCount++;
      });
    }
  });
});

console.log(`\n=== 清理完成 ===`);
console.log(`保留模板: ${keptCount} 个`);
console.log(`删除模板: ${deletedCount} 个`);
console.log(`\n数据库已更新！`);