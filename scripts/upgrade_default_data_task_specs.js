const Todo = require('../src/models/Todo');
const DataTaskSpecService = require('../src/services/DataTaskSpecService');

function main() {
  const agentId = 'hermes-default';
  const templates = Todo.findTemplates(agentId).filter(template => !template.archived);
  let updatedTemplates = 0;
  let updatedTasks = 0;

  for (const template of templates) {
    const spec = DataTaskSpecService.inferTaskSpec(template);
    if (!spec) continue;

    Todo.update(agentId, template.id, {
      taskSpec: spec,
      acceptanceCriteria: DataTaskSpecService.buildAcceptanceCriteria(template.title, spec)
    });
    updatedTemplates += 1;

    const siblings = Todo.findAllByAgent(agentId, {
      title: template.title,
      includeArchived: false,
      isTemplate: false,
      limit: 200
    });

    for (const task of siblings) {
      if (task.parent_id !== template.id && task.title !== template.title) continue;
      const patch = {};
      if (!task.task_spec) patch.taskSpec = spec;
      if (!task.acceptance_criteria) patch.acceptanceCriteria = DataTaskSpecService.buildAcceptanceCriteria(task.title, spec);
      if (Object.keys(patch).length > 0) {
        Todo.update(agentId, task.id, patch);
        updatedTasks += 1;
      }
    }
  }

  console.log(JSON.stringify({ agentId, updatedTemplates, updatedTasks }, null, 2));
}

main();
