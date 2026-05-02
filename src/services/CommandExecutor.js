const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const DEFAULTS = {
  maxCommands: 5,
  timeoutMultiplier: 0.25,
  minTimeoutMs: 30000,
  maxTimeoutMs: 600000,
  defaultExpectedMinutes: 60,
  cwd: process.env.HOME,
};

const BLOCK_REGEX = /```(?:bash|shell|sh|console)?\n([\s\S]*?)```/g;
const LINE_CMD_REGEX = /^\s*\$?\s*([^\n]+)/gm;

const VALID_COMMAND_PREFIXES = [
  'python', 'python3', 'node', 'npm', 'yarn', 'pip', 'git', 'cd', 'ls', 'cat',
  'echo', 'mkdir', 'rm', 'cp', 'mv', 'chmod', 'chown', 'curl', 'wget',
  'docker', 'kubectl', 'aws', 'gcloud', 'duckdb', 'sqlite3', 'psql',
  'grep', 'sed', 'awk', 'find', 'tar', 'zip', 'unzip', 'ssh', 'scp',
  'export', 'source', 'bash', 'sh', 'zsh', 'eval', 'exec', 'nohup',
  'screen', 'tmux', 'nano', 'vim', 'less', 'more', 'head', 'tail',
  'wc', 'sort', 'uniq', 'cut', 'tr', 'tee', 'xargs', 'parallel',
  'make', 'cmake', 'npm', 'yarn', 'pnpm', 'cargo', 'go', 'rustc',
  'java', 'javac', 'gradle', 'mvn', 'dotnet', 'powershell', 'pwsh'
];

const INVALID_PREFIXES = [
  '📋', '📊', '🔍', '✅', '❌', '⚠️', '💡', '---', '##', '# ', '- ', '* ',
  '[', ']', '{', '}', '|', '>', '<', '=', ':', ';', '，', '。', '！', '？',
  '验证：', '检查：', '执行：', '确认：', '注意：', '建议：', '分析：', '问题：',
  '当前：', '状态：', '进度：', '步骤：', '说明：', '提示：', '警告：', '错误：'
];

class CommandExecutor {
  static extractBashBlocks(reply) {
    if (!reply || typeof reply !== 'string') return [];
    const blocks = [];
    let match;
    const re = new RegExp(BLOCK_REGEX.source, 'g');
    while ((match = re.exec(reply)) !== null) {
      const content = match[1].trim();
      if (content) {
        const lines = content.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
        lines.forEach((line, idx) => {
          if (line.trim()) {
            blocks.push({ index: blocks.length, command: line.trim(), source: 'block', blockIndex: match.index, lineIndex: idx });
          }
        });
      }
    }
    return blocks;
  }

  static extractLineCommands(reply) {
    if (!reply || typeof reply !== 'string') return [];
    const commands = [];
    let match;
    const re = new RegExp(LINE_CMD_REGEX.source, 'gm');
    while ((match = re.exec(reply)) !== null) {
      const cmd = match[1].trim();
      if (cmd && !cmd.startsWith('#') && !cmd.startsWith('//') && cmd.length > 2) {
        // 检查是否以无效前缀开头（markdown 元素、emoji 等）
        const hasInvalidPrefix = INVALID_PREFIXES.some(prefix => cmd.startsWith(prefix));
        if (hasInvalidPrefix) continue;
        
        // 检查是否以有效的命令前缀开头
        const hasValidPrefix = VALID_COMMAND_PREFIXES.some(prefix => cmd.startsWith(prefix) || cmd.startsWith('./') || cmd.startsWith('/'));
        
        if (hasValidPrefix) {
          if (!commands.some(c => c.command === cmd)) {
            commands.push({ index: commands.length, command: cmd, source: 'line' });
          }
        }
      }
    }
    return commands;
  }

  static extractCommandsFromTaskDescription(description) {
    if (!description || typeof description !== 'string') return [];
    const commands = [];
    const steps = description.split('\n').filter(line => line.trim());
    
    steps.forEach((line, idx) => {
      const trimmed = line.trim();
      const numberedMatch = trimmed.match(/^\d+[\.\-\)]\s*(.+)$/);
      if (numberedMatch) {
        const content = numberedMatch[1].trim();
        if (content.includes('kill ') || content.includes('python') || content.includes('.py') || 
            content.includes('cd ') || content.includes('duckdb') || content.includes('SELECT ') ||
            content.includes('git ') || content.includes('npm ') || content.includes('curl ') ||
            content.includes('wget ') || content.includes('docker ') || content.includes('kubectl ')) {
          const cmd = content.replace(/^[A-Za-z\u4e00-\u9fa5]+\s*[：:]\s*/, '').trim();
          if (cmd && cmd.length > 3) {
            commands.push({ index: commands.length, command: cmd, source: 'task_desc', step: idx + 1 });
          }
        }
      }
    });
    return commands;
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
    let commands = [];
    
    commands = commands.concat(this.extractBashBlocks(reply));
    
    if (commands.length === 0) {
      commands = commands.concat(this.extractLineCommands(reply));
    }
    
    if (commands.length === 0 && opts.task?.description) {
      commands = commands.concat(this.extractCommandsFromTaskDescription(opts.task.description));
    }
    
    if (commands.length === 0) return { commands: [], results: [], source: 'none' };
    
    const timeoutMs = opts.timeoutMs || this.calcTimeout(opts.task, opts);
    const results = await this.executeCommands(commands, { timeoutMs, cwd: opts.cwd, maxCommands: opts.maxCommands });
    const sources = [...new Set(commands.map(c => c.source))];
    
    return { commands, results, source: sources.join(', ') };
  }
}

module.exports = CommandExecutor;
