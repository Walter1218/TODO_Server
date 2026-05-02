class ProgressValidator {
  static snapshot(task) {
    const blockers = Array.isArray(task.heartbeat_blockers)
      ? task.heartbeat_blockers
      : JSON.parse(task.heartbeat_blockers || '[]');
    return {
      progress: task.heartbeat_progress || 0,
      step: task.heartbeat_step || '',
      blockers: [...blockers],
      updatedAt: task.last_heartbeat || task.updated_at || null,
    };
  }

  static compare(before, after) {
    const delta = {};
    let changed = false;

    if (before.progress !== after.progress) {
      delta.progress = after.progress - before.progress;
      changed = true;
    }
    if (before.step !== after.step) {
      delta.step = after.step;
      changed = true;
    }
    if (JSON.stringify(before.blockers) !== JSON.stringify(after.blockers)) {
      delta.blockers = after.blockers;
      changed = true;
    }

    return { changed, delta };
  }

  static buildReport(taskId, before, after, result) {
    const { changed, delta } = this.compare(before, after);
    const lines = [
      `[ProgressValidator] task=${taskId}`,
      `before: progress=${before.progress} step="${before.step}" blockers=${JSON.stringify(before.blockers)}`,
      `after:  progress=${after.progress} step="${after.step}" blockers=${JSON.stringify(after.blockers)}`,
      `changed=${changed} delta=${JSON.stringify(delta)}`,
    ];
    if (result) {
      lines.push(`result: success=${result.success} attempts=${result.attempts}`);
    }
    return lines.join(' | ');
  }
}

module.exports = ProgressValidator;
