/**
 * Agent TODO SDK 使用示例
 *
 * 这个示例展示了如何使用 SDK 来帮助智能体管理任务
 */

const AgentTODOSDK = require('./agent-todo-sdk.js');

async function example() {
  // 初始化 SDK
  const agentId = 'b5248f09-b57e-4a18-85ab-e04523c9e6a5'; // 替换为你的智能体ID
  const todo = new AgentTODOSDK('http://localhost:3000', agentId);

  console.log('🚀 Agent TODO SDK 示例\n');

  // ==================== 基础使用 ====================

  console.log('=== 1. 基础任务管理 ===\n');

  // 创建项目
  const project = await todo.createProject({
    name: '网站重构项目',
    description: '重构公司网站，提升用户体验',
    color: '#3498db'
  });
  console.log('创建项目:', project.data.name);

  // 创建任务
  const task1 = await todo.quickAdd('设计新的首页布局', {
    priority: 'high',
    context: '需要参考竞品网站的设计',
    projectId: project.data.id,
    tags: ['设计', '首页']
  });
  console.log('创建任务:', task1.data.title);

  const task2 = await todo.quickAdd('编写响应式CSS', {
    priority: 'medium',
    context: '需要兼容移动端和桌面端',
    projectId: project.data.id,
    tags: ['前端', 'CSS']
  });
  console.log('创建任务:', task2.data.title);

  const task3 = await todo.quickAdd('添加动画效果', {
    priority: 'low',
    context: '提升用户体验',
    projectId: project.data.id,
    tags: ['前端', '动画']
  });
  console.log('创建任务:', task3.data.title);

  // ==================== 依赖关系 ====================

  console.log('\n=== 2. 设置任务依赖 ===\n');

  // 设置依赖: 编写CSS依赖于完成设计
  await todo.addDependency(task2.data.id, task1.data.id);
  console.log(`🔗 "${task2.data.title}" 依赖于 "${task1.data.title}"`);

  // 设置依赖: 添加动画依赖于完成CSS
  await todo.addDependency(task3.data.id, task2.data.id);
  console.log(`🔗 "${task3.data.title}" 依赖于 "${task2.data.title}"`);

  // ==================== 上下文聚焦 ====================

  console.log('\n=== 3. 获取上下文摘要 ===\n');

  const focus = await todo.focus();
  console.log(focus.message);

  // ==================== 便捷方法 ====================

  console.log('\n=== 4. 使用便捷方法 ===\n');

  // 开始第一个任务
  await todo.startTask(task1.data.id);
  console.log(`⚡ 开始任务: ${task1.data.title}`);

  // 完成任务
  await todo.doneTask(task1.data.id);
  console.log(`✅ 完成任务: ${task1.data.title}`);

  // 再次查看状态
  console.log('\n任务完成后重新查看状态:');
  const focus2 = await todo.focus();
  console.log(focus2.message);

  // ==================== 任务链 ====================

  console.log('\n=== 5. 使用任务链规划 ===\n');

  const chainTasks = [
    {
      title: '用户调研',
      priority: 'critical',
      context: '了解用户需求和痛点'
    },
    {
      title: '需求分析',
      priority: 'high',
      context: '整理用户反馈，形成需求文档',
      dependsOnPrevious: true
    },
    {
      title: '原型设计',
      priority: 'high',
      context: '基于需求设计产品原型',
      dependsOnPrevious: true
    },
    {
      title: '开发迭代',
      priority: 'high',
      context: '按照优先级开发功能',
      dependsOnPrevious: true
    },
    {
      title: '测试验证',
      priority: 'medium',
      context: '确保功能符合需求',
      dependsOnPrevious: true
    }
  ];

  const plannedTasks = await todo.planTaskChain(chainTasks);
  console.log('\n已创建任务链:');
  plannedTasks.forEach((task, i) => {
    console.log(`${i + 1}. ${task.data.title} (${task.data.dependencies.length > 0 ? '有依赖' : '无依赖'})`);
  });

  // ==================== 查询功能 ====================

  console.log('\n=== 6. 查询功能 ===\n');

  // 获取高优先级任务
  const highPriority = await todo.listTodos({ priority: 'high' });
  console.log(`高优先级任务: ${highPriority.count} 个`);

  // 获取可执行任务
  const ready = await todo.getReadyTasks();
  console.log(`可执行任务: ${ready.count} 个`);
  ready.data.forEach(task => {
    console.log(`- ${task.title}`);
  });

  // 获取统计数据
  const stats = await todo.getStats();
  console.log('\n统计信息:');
  console.log(`- 总计: ${stats.data.total}`);
  console.log(`- 待处理: ${stats.data.pending}`);
  console.log(`- 进行中: ${stats.data.in_progress}`);
  console.log(`- 已完成: ${stats.data.completed}`);
  console.log(`- 紧急任务: ${stats.data.critical_pending}`);

  // 搜索任务
  const searchResults = await todo.searchTodos('测试');
  console.log(`\n搜索"测试"结果: ${searchResults.count} 个`);

  console.log('\n✅ 示例完成！');
}

// 运行示例
example().catch(console.error);
