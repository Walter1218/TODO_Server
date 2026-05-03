const TaskType = {
  NORMAL: 'normal',
  VALIDATION: 'validation',
  TEMPLATE: 'template',
  SCHEDULED: 'scheduled',
};

const TaskTypeLabels = {
  [TaskType.NORMAL]: '普通任务',
  [TaskType.VALIDATION]: '验证任务',
  [TaskType.TEMPLATE]: '模板任务',
  [TaskType.SCHEDULED]: '定时任务',
};

const TaskBehavior = {
  [TaskType.VALIDATION]: {
    triggerValidationOnComplete: false,
    allowRevalidation: false,
    priorityBoost: 10,
    timeoutMinutes: 30,
    allowNestedValidation: false,
    focusProtection: true,
    description: '第三方验证任务，完成后直接结束，不触发新的验证流程',
  },
  [TaskType.NORMAL]: {
    triggerValidationOnComplete: true,
    allowRevalidation: true,
    priorityBoost: 0,
    timeoutMinutes: 60,
    allowNestedValidation: true,
    focusProtection: false,
    description: '普通任务，完成后触发验证流程',
  },
  [TaskType.TEMPLATE]: {
    triggerValidationOnComplete: false,
    allowRevalidation: false,
    priorityBoost: 0,
    timeoutMinutes: 60,
    allowNestedValidation: false,
    focusProtection: false,
    description: '模板任务，用于创建新任务的蓝图',
  },
  [TaskType.SCHEDULED]: {
    triggerValidationOnComplete: true,
    allowRevalidation: true,
    priorityBoost: 5,
    timeoutMinutes: 120,
    allowNestedValidation: true,
    focusProtection: false,
    description: '定时任务，按计划自动执行',
  },
};

function getTaskType(task) {
  if (!task) return TaskType.NORMAL;

  if (task.is_template === 1 || task.is_template === true) {
    return TaskType.TEMPLATE;
  }

  if (task.title && typeof task.title === 'string' && task.title.startsWith('[验证]')) {
    return TaskType.VALIDATION;
  }

  if (task.context) {
    try {
      const ctx = typeof task.context === 'string' ? JSON.parse(task.context) : task.context;
      if (ctx.type === 'third_party_validation') {
        return TaskType.VALIDATION;
      }
      if (ctx.type === 'scheduled') {
        return TaskType.SCHEDULED;
      }
    } catch (e) {
      // context 不是有效 JSON，忽略
    }
  }

  return TaskType.NORMAL;
}

function getTaskBehavior(task) {
  const type = getTaskType(task);
  return TaskBehavior[type] || TaskBehavior[TaskType.NORMAL];
}

function isValidationTask(task) {
  return getTaskType(task) === TaskType.VALIDATION;
}

function isTemplateTask(task) {
  return getTaskType(task) === TaskType.TEMPLATE;
}

function shouldTriggerValidation(task) {
  const behavior = getTaskBehavior(task);
  return behavior.triggerValidationOnComplete;
}

function getTaskPriority(task) {
  const behavior = getTaskBehavior(task);
  const basePriority = task.priority || 0;
  return basePriority + behavior.priorityBoost;
}

function getTaskTimeout(task) {
  const behavior = getTaskBehavior(task);
  return behavior.timeoutMinutes * 60 * 1000;
}

function getTaskTypeLabel(task) {
  const type = getTaskType(task);
  return TaskTypeLabels[type] || TaskTypeLabels[TaskType.NORMAL];
}

module.exports = {
  TaskType,
  TaskTypeLabels,
  TaskBehavior,
  getTaskType,
  getTaskBehavior,
  isValidationTask,
  isTemplateTask,
  shouldTriggerValidation,
  getTaskPriority,
  getTaskTimeout,
  getTaskTypeLabel,
};
