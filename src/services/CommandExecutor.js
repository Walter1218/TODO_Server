const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
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
  '验证：', '验证:', '验证::', '检查：', '检查:', '检查::', '执行：', '执行:', '执行::',
  '确认：', '确认:', '确认::', '注意：', '注意:', '注意::', '建议：', '建议:', '建议::',
  '分析：', '分析:', '分析::', '问题：', '问题:', '问题::', '当前：', '当前:', '当前::',
  '状态：', '状态:', '状态::', '进度：', '进度:', '进度::', '步骤：', '步骤:', '步骤::',
  '说明：', '说明:', '说明::', '提示：', '提示:', '提示::', '警告：', '警告:', '警告::',
  '错误：', '错误:', '错误::'
];

class CommandExecutor {
  static _truncate(text, maxLen = 800) {
    if (!text) return '';
    const s = String(text);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '...(truncated)';
  }

  static _uniq(arr) {
    return [...new Set((arr || []).filter(Boolean))];
  }

  static detectEnvironmentBlockers(output) {
    const text = (output || '').toString();
    if (!text) return [];
    const blockers = [];

    const cdMissing = text.match(/cd:\s*([^:\n]+):\s*No such file or directory/i);
    if (cdMissing && cdMissing[1]) blockers.push(`缺少目录: ${cdMissing[1].trim()}`);

    const fileMissing1 = text.match(/(?:cat|ls|head|tail):\s*([^:\n]+):\s*No such file or directory/i);
    if (fileMissing1 && fileMissing1[1]) blockers.push(`缺少文件: ${fileMissing1[1].trim()}`);

    const fileMissing2 = text.match(/python(?:3)?:\s*can't open file\s+'([^']+)'/i);
    if (fileMissing2 && fileMissing2[1]) blockers.push(`缺少脚本: ${fileMissing2[1].trim()}`);

    const fileMissing3 = text.match(/\[Errno 2\].*No such file or directory.*(?:'([^']+)'|\"([^\"]+)\")/i);
    const missPath = (fileMissing3 && (fileMissing3[1] || fileMissing3[2])) ? (fileMissing3[1] || fileMissing3[2]).trim() : null;
    if (missPath) blockers.push(`缺少路径: ${missPath}`);

    const cmdNotFound = text.match(/(?:^|\n)([^:\n]+):\s*command not found/);
    if (cmdNotFound && cmdNotFound[1]) blockers.push(`缺少命令: ${cmdNotFound[1].trim()}`);

    const pyMissingMod = text.match(/ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/);
    if (pyMissingMod && pyMissingMod[1]) blockers.push(`缺少Python包: ${pyMissingMod[1].trim()}`);

    const pyImportErr = text.match(/ImportError:\s*cannot import name ['"]([^'"]+)['"]/);
    if (pyImportErr && pyImportErr[1]) blockers.push(`Python导入失败: ${pyImportErr[1].trim()}`);

    if (/permission denied/i.test(text)) blockers.push('权限不足: Permission denied');

    return this._uniq(blockers);
  }

  static summarizeAttemptFromResults(results, opts = {}) {
    const maxOut = opts.maxOutputLen ?? 1200;
    const maxCmd = opts.maxCommandLen ?? 160;
    const rs = Array.isArray(results) ? results : [];
    const failed = rs.filter(r => r && r.success === false);
    const success = failed.length === 0;

    if (rs.length === 0) {
      return {
        success: true,
        reason: '无命令执行',
        output: '',
        blockers: []
      };
    }

    if (success) {
      const first = rs[0];
      const cmd = (first.command || '').toString().slice(0, maxCmd);
      const out = rs.map(r => this._truncate(r.output, 200)).join('\n---\n');
      return {
        success: true,
        reason: `命令执行成功（${rs.length}条）`,
        output: this._truncate(out, maxOut),
        blockers: []
      };
    }

    const firstFail = failed[0];
    const failCmd = (firstFail.command || '').toString().slice(0, maxCmd);
    const out = this._truncate(firstFail.output || '', maxOut);
    const blockers = this.detectEnvironmentBlockers(firstFail.output || '');
    return {
      success: false,
      reason: `命令执行失败: ${failCmd}`,
      output: out,
      blockers
    };
  }

  static extractPreflightSpec(description) {
    if (!description || typeof description !== 'string') return null;

    const lines = description.split('\n').map(l => l.trim()).filter(Boolean);
    const spec = {
      cwd: null,
      scripts: [],
      requiresBins: [],
      requiresEnv: [],
      requiresPaths: []
    };

    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
      if (!m) continue;
      const key = m[1].toUpperCase();
      const val = m[2].trim();
      if (!val) continue;

      if (key === 'CWD') spec.cwd = val;
      if (key === 'SCRIPT' || key === 'SCRIPTS') spec.scripts.push(...val.split(',').map(s => s.trim()).filter(Boolean));
      if (key === 'REQUIRES_BIN' || key === 'REQUIRES_BINS') spec.requiresBins.push(...val.split(',').map(s => s.trim()).filter(Boolean));
      if (key === 'REQUIRES_ENV' || key === 'REQUIRES_ENVS') spec.requiresEnv.push(...val.split(',').map(s => s.trim()).filter(Boolean));
      if (key === 'REQUIRES_PATH' || key === 'REQUIRES_PATHS') spec.requiresPaths.push(...val.split(',').map(s => s.trim()).filter(Boolean));
    }

    spec.scripts = this._uniq(spec.scripts);
    spec.requiresBins = this._uniq(spec.requiresBins);
    spec.requiresEnv = this._uniq(spec.requiresEnv);
    spec.requiresPaths = this._uniq(spec.requiresPaths);

    const any = spec.cwd || spec.scripts.length || spec.requiresBins.length || spec.requiresEnv.length || spec.requiresPaths.length;
    return any ? spec : null;
  }

  static _safeBinName(name) {
    if (!name) return null;
    const s = String(name).trim();
    if (!/^[A-Za-z0-9._+-]+$/.test(s)) return null;
    return s;
  }

  static _exists(p) {
    try {
      return fs.existsSync(p);
    } catch (e) {
      return false;
    }
  }

  static _resolvePath(p, cwd) {
    if (!p) return null;
    let s = String(p).trim();
    if (!s) return null;
    if (s.startsWith('~/')) s = path.join(process.env.HOME || '', s.slice(2));
    if (path.isAbsolute(s)) return s;
    if (cwd) return path.join(cwd, s);
    return s;
  }

  static evaluatePreflight(spec) {
    if (!spec) return { blockers: [], notes: [] };
    const blockers = [];
    const notes = [];

    const cwd = spec.cwd ? this._resolvePath(spec.cwd, null) : null;
    if (cwd && !this._exists(cwd)) blockers.push(`缺少目录: ${cwd}`);

    for (const s of (spec.scripts || [])) {
      const full = this._resolvePath(s, cwd);
      if (full && !this._exists(full)) blockers.push(`缺少脚本: ${full}`);
    }

    for (const p of (spec.requiresPaths || [])) {
      const full = this._resolvePath(p, cwd);
      if (full && !this._exists(full)) blockers.push(`缺少路径: ${full}`);
    }

    for (const e of (spec.requiresEnv || [])) {
      const envName = String(e).trim();
      if (!envName) continue;
      if (!process.env[envName]) blockers.push(`缺少环境变量: ${envName}`);
    }

    for (const b of (spec.requiresBins || [])) {
      const bin = this._safeBinName(b);
      if (!bin) {
        notes.push(`忽略不安全的 REQUIRES_BIN: ${String(b).trim()}`);
        continue;
      }
      try {
        const out = execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (!out) blockers.push(`缺少命令: ${bin}`);
      } catch (e) {
        blockers.push(`缺少命令: ${bin}`);
      }
    }

    return { blockers: this._uniq(blockers), notes: this._uniq(notes) };
  }

  static preflightFromTask(task) {
    const spec = this.extractPreflightSpec(task?.description || '');
    if (!spec) return null;
    const { blockers, notes } = this.evaluatePreflight(spec);
    return { spec, blockers, notes };
  }

  static extractBashBlocks(reply) {
    if (!reply || typeof reply !== 'string') return [];
    const blocks = [];
    let match;
    const re = new RegExp(BLOCK_REGEX.source, 'g');
    while ((match = re.exec(reply)) !== null) {
      const content = match[1].trim();
      if (content) {
        const lines = content.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
        let currentCommand = null;
        let currentLineIndex = -1;
        lines.forEach((line, idx) => {
          const cmd = line.trim();
          if (cmd) {
            const hasInvalidPrefix = INVALID_PREFIXES.some(prefix => cmd.startsWith(prefix));
            if (hasInvalidPrefix) return;
            
            const hasValidPrefix = VALID_COMMAND_PREFIXES.some(prefix => cmd.startsWith(prefix) || cmd.startsWith('./') || cmd.startsWith('/'));
            
            if (hasValidPrefix) {
              if (currentCommand !== null) {
                blocks.push({ index: blocks.length, command: currentCommand, source: 'block', blockIndex: match.index, lineIndex: currentLineIndex });
              }
              currentCommand = cmd;
              currentLineIndex = idx;
            } else if (currentCommand !== null) {
              if (cmd.startsWith('-') || cmd.startsWith('"') || cmd.startsWith("'")) {
                if (currentCommand.endsWith('\\')) {
                  currentCommand = currentCommand.slice(0, -1) + ' ' + cmd;
                } else if (currentCommand.match(/\s$/) || cmd.startsWith('"') || cmd.startsWith("'")) {
                  currentCommand += ' ' + cmd;
                } else {
                  currentCommand += ' ' + cmd;
                }
              } else {
                currentCommand += '\n' + cmd;
              }
            }
          }
        });
        if (currentCommand !== null) {
          blocks.push({ index: blocks.length, command: currentCommand, source: 'block', blockIndex: match.index, lineIndex: currentLineIndex });
        }
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
        const stdoutText = stdout != null ? String(stdout) : '';
        const stderrText = stderr != null ? String(stderr) : '';
        const output = stdoutText.trim() || stderrText.trim() || '(无输出)';
        results.push({
          index,
          command,
          output,
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: 0,
          success: true,
          duration: Date.now() - startMs
        });
      } catch (execErr) {
        const stdoutText = execErr.stdout != null ? String(execErr.stdout) : '';
        const stderrText = execErr.stderr != null ? String(execErr.stderr) : '';
        const errOutput = stdoutText.trim() || stderrText.trim() || execErr.message;
        const exitCode = typeof execErr.code === 'number' ? execErr.code : null;
        results.push({
          index,
          command,
          output: errOutput,
          stdout: stdoutText,
          stderr: stderrText,
          exitCode,
          success: false,
          duration: Date.now() - startMs
        });
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
