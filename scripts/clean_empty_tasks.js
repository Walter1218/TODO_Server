const { getDb } = require('../src/db');
const db = getDb();

const emptyTaskIds = [
  'dfc7481f-1a53-42db-9c86-80f1dee5a75f',  // 每周一五检查
  '6884f77d-9d8e-49d8-80de-9bf5c7e215df',  // 每天9点
  '7b9fb2e3-703c-434d-8a05-90a93e30968b',  // 每日数据同步测试2
  '495fafc7-f595-495a-8677-3a08284e8380'   // 每日数据同步（指派给ops）
];

console.log('=== 清理空任务 ===\n');

emptyTaskIds.forEach(id => {
  const task = db.prepare('SELECT title, schedule FROM todos WHERE id = ?').get(id);
  if (task) {
    db.prepare('DELETE FROM todos WHERE id = ?').run(id);
    console.log(`✅ 已删除: '${task.title}' (schedule: ${task.schedule})`);
  } else {
    console.log(`⚠️ 未找到任务: ${id}`);
  }
});

const remainingTemplates = db.prepare(
  'SELECT COUNT(*) as count FROM todos WHERE is_template = 1 AND schedule IS NOT NULL'
).get();

console.log(`\n清理完成！剩余定时模板: ${remainingTemplates.count} 个`);