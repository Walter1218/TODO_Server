const Todo = require('../src/models/Todo');
const Context = require('../src/models/Context');
const OpsBackfillService = require('../src/services/OpsBackfillService');

function main() {
  const reconcile = OpsBackfillService.reconcileAutoHealingTasks();
  const completions = [
    ['hermes-ops', 'ccd0b0a5-34b2-46c7-80de-e7d3a470621b', 'inspection-success'],
    ['hermes-ops', '10aced2a-2214-4423-9145-2db9dcc4d4bf', 'inspection-report-ready'],
    ['hermes-ops', 'a3804ddd-b229-4cb0-961d-942f30b6856a', 'inspection-produced-report']
  ];

  for (const [agentId, taskId, note] of completions) {
    Todo.update(agentId, taskId, {
      status: 'completed',
      heartbeatProgress: 100,
      heartbeatStep: 'manual reconcile completed',
      failureBucket: null
    });
    Context.create(agentId, {
      sessionId: 'manual-reconcile',
      role: 'system',
      content: `[manual-reconcile] set completed: ${note}`,
      metadata: { type: 'manual_reconcile_complete', task_id: taskId, note }
    });
  }

  console.log(JSON.stringify({
    reconcile,
    completed: completions.map(item => item[1])
  }, null, 2));
}

main();
