const { getDb } = require('../src/db');
const db = getDb();

console.log('=== 每日调度任务有效性分析 ===\n');

const templates = db.prepare(`
  SELECT id, agent_id, title, description, schedule, next_due_at, last_spawned_at, acceptance_criteria
  FROM todos
  WHERE is_template = 1 AND schedule IS NOT NULL
  ORDER BY agent_id, title
`).all();

console.log(`定时模板总数: ${templates.length}`);

let validTasks = [];
let emptyTasks = [];

templates.forEach(t => {
  const hasDescription = t.description && t.description.trim().length > 0;
  const hasCriteria = t.acceptance_criteria && t.acceptance_criteria.trim().length > 0;
  
  if (!hasDescription && !hasCriteria) {
    emptyTasks.push(t);
  } else {
    validTasks.push(t);
  }
});

console.log(`\n✅ 有效任务: ${validTasks.length} 个`);
validTasks.forEach(t => {
  const hasDesc = t.description ? '📝' : '';
  const hasCrit = t.acceptance_criteria ? '✅' : '';
  console.log(`  ${hasDesc}${hasCrit} '${t.title}'`);
  console.log(`    └─ schedule: ${t.schedule}`);
  if (t.next_due_at) {
    console.log(`    └─ 下次执行: ${t.next_due_at}`);
  }
});

console.log(`\n⚠️ 空任务（无描述无验收标准）: ${emptyTasks.length} 个`);
emptyTasks.forEach(t => {
  console.log(`  - '${t.title}' (ID: ${t.id})`);
  console.log(`    └─ schedule: ${t.schedule}`);
});

console.log(`\n=== 最近生成的任务实例 ===`);
const recentSpawns = db.prepare(`
  SELECT t.title, t.created_at, t.status, p.title as parent_title
  FROM todos t
  LEFT JOIN todos p ON t.parent_id = p.id
  WHERE t.is_template = 0 AND t.parent_id IS NOT NULL
  ORDER BY t.created_at DESC
  LIMIT 10
`).all();

console.log(`最近生成的实例: ${recentSpawns.length} 个`);
recentSpawns.forEach(t => {
  console.log(`  - ${t.title} (${t.status}) - ${t.created_at}`);
});

console.log(`\n=== 分析完成 ===`);