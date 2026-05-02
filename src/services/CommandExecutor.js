const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const DEFAULTS = {
  maxCommands: 3,
  timeoutMultiplier: 0.25,
  minTimeoutMs: 30000,
  maxTimeoutMs: 600000,
  defaultExpectedMinutes: 60,
  cwd: process.env.HOME,
};

const BLOCK_REGEX = /```(?:bash|shell|sh)\n([\s\S]*?)```/g;

class CommandExecutor {
  static extractBashBlocks(reply) {
    if (!reply || typeof reply !== 'string') return [];
    const blocks = [];
    let match;
    const re = new RegExp(BLOCK_REGEX.source, 'g');
    while ((match = re.exec(reply)) !== null) {
      const cmd = match[1].trim();
      if (cmd) {
        blocks.push({ index: blocks.length, command: cmd });
      }
    }
    return blocks;
  }

  static calcTimeout(task, opts = {}) {
    const multiplier = opts.timeoutMultiplier || DEFAULTS.timeoutMultiplier;
    const minMs = opts.minTimeoutMs || DEFAULTS.minTimeoutMs;
    const maxMs = opts.maxTimeoutMs || DEFAULTS.maxTimeoutMs;
    const expectedMin = task?.expected_duration_minutes || DEFAULTS.defaultExpectedMinutes;
    return Math.max(minMs, Math.min(maxMs, expectedMin * 60 * 1000 * multiplier));
  }

  static async executeCommands(commands, opts = {}) {
    if (!commands || commands.length === 0) return [];
    const maxCommands = opts.maxCommands || DEFAULTS.maxCommands;
    const timeoutMs = opts.timeoutMs || 60000;
    const cwd = opts.cwd || DEFAULTS.cwd;
    const toRun = commands.slice(0, maxCommands);
    const results = [];

    for (const { index, command } of toRun) {
      const startMs = Date.now();
      try {
        const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs, cwd });
        const output = stdout.trim() || stderr.trim() || '(无输出)';
        results.push({ index, command, output, success: true, duration: Date.now() - startMs });
      } catch (execErr) {
        const errOutput = execErr.stdout?.trim() || execErr.stderr?.trim() || execErr.message;
        results.push({ index, command, output: errOutput, success: false, duration: Date.now() - startMs });
      }
    }
    return results;
  }

  static buildExecutionSummary(results) {
    if (!results || results.length === 0) return '(无命令执行)';
    return results.map((r) => {
      const icon = r.success ? '✅' : '❌';
      const dur = r.duration != null ? ` (${r.duration}ms)` : '';
      const out = r.output?.substring(0, 200) || '';
      return `[${r.index}] ${icon} ${r.command}${dur}\n${out}`;
    }).join('\n---\n');
  }

  static async extractAndRun(reply, opts = {}) {
    const commands = this.extractBashBlocks(reply);
    if (commands.length === 0) return { commands: [], results: [] };
    const timeoutMs = opts.timeoutMs || this.calcTimeout(opts.task, opts);
    const results = await this.executeCommands(commands, { timeoutMs, cwd: opts.cwd, maxCommands: opts.maxCommands });
    return { commands, results };
  }
}

module.exports = CommandExecutor;
