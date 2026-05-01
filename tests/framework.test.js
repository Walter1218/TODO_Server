const path = require('path');
const fs = require('fs');

const ConfigLoader = require('../framework/utils/ConfigLoader');

describe('ConfigLoader', () => {
  const testConfigPath = path.join(__dirname, 'test-config.json');

  afterEach(() => {
    if (fs.existsSync(testConfigPath)) {
      fs.unlinkSync(testConfigPath);
    }
  });

  test('load config from file', () => {
    const config = {
      server: { url: 'http://localhost:3000' },
      llm: {
        provider: 'openai',
        openai: { apiKey: 'test-key', model: 'gpt-4' }
      },
      agent: { id: 'test-agent', name: 'Test' },
      features: {
        taskManagement: { enabled: true }
      }
    };
    fs.writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

    const loaded = ConfigLoader.load(testConfigPath);
    expect(loaded.server.url).toBe('http://localhost:3000');
    expect(loaded.agent.id).toBe('test-agent');
  });

  test('throws on non-existent config file', () => {
    expect(() => ConfigLoader.load('/nonexistent/config.json')).toThrow();
  });

  test('throws on invalid JSON', () => {
    fs.writeFileSync(testConfigPath, '{ invalid json }');
    expect(() => ConfigLoader.load(testConfigPath)).toThrow('配置文件格式错误');
  });

  test('toFrameworkConfig transforms correctly', () => {
    const config = {
      server: { url: 'http://localhost:4000' },
      llm: {
        provider: 'openai',
        openai: { apiKey: 'sk-test', model: 'gpt-4', temperature: 0.5 },
        fallback: {
          provider: 'ollama',
          ollama: { baseUrl: 'http://localhost:11434', model: 'llama3' }
        }
      },
      agent: { id: 'my-agent', secretKey: 'secret123' },
      features: {
        taskManagement: { enabled: true, priority: 'high' },
        memoryManagement: true
      }
    };

    const fw = ConfigLoader.toFrameworkConfig(config);
    expect(fw.base.todoServerUrl).toBe('http://localhost:4000');
    expect(fw.base.agentId).toBe('my-agent');
    expect(fw.base.agentSecret).toBe('secret123');
    expect(fw.llm.provider).toBe('openai');
    expect(fw.llm.apiKey).toBe('sk-test');
    expect(fw.llm.model).toBe('gpt-4');
    expect(fw.llm.temperature).toBe(0.5);
    expect(fw.llm.fallback.provider).toBe('ollama');
    expect(fw.llm.fallback.model).toBe('llama3');
    expect(fw.features.taskManagement.enabled).toBe(true);
    expect(fw.features.taskManagement.priority).toBe('high');
    expect(fw.features.memoryManagement.enabled).toBe(true);
  });

  test('validate returns valid for correct config', () => {
    const config = {
      server: { url: 'http://localhost:3000' },
      llm: {
        provider: 'openai',
        openai: { apiKey: 'sk-test' }
      },
      agent: { id: 'test' }
    };
    const result = ConfigLoader.validate(config);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test('validate catches missing fields', () => {
    const config = {
      llm: { provider: '' },
      agent: {},
      server: { url: '' }
    };
    const result = ConfigLoader.validate(config);
    expect(result.valid).toBe(false);
  });

  test('validate catches missing apiKey', () => {
    const config = {
      llm: { provider: 'openai', openai: {} }
    };
    const result = ConfigLoader.validate(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('apiKey'))).toBe(true);
  });

  test('createDefault returns valid structure', () => {
    const def = ConfigLoader.createDefault();
    expect(def.server.url).toBe('http://localhost:3000');
    expect(def.llm.provider).toBe('minimax');
    expect(def.agent.id).toBe('my-agent');
  });

  test('save and load roundtrip', () => {
    const config = ConfigLoader.createDefault();
    ConfigLoader.save(config, testConfigPath);
    const loaded = ConfigLoader.load(testConfigPath);
    expect(loaded.server.url).toBe(config.server.url);
    expect(loaded.agent.id).toBe(config.agent.id);
  });
});

describe('PromptManager', () => {
  const PromptManager = require('../framework/modules/PromptManager');

  function createMockFramework() {
    return {
      config: {
        features: {
          promptManagement: {
            enabled: true,
            systemPrompt: '',
            autoEnhance: false,
            addChecklist: false,
            addProgress: false
          }
        },
        base: { agentId: 'test-agent' }
      },
      modules: {
        memoryManager: {
          getRecentMemory: async () => []
        }
      },
      log: () => {}
    };
  }

  test('getSystemPrompt returns role prompt', async () => {
    const pm = new PromptManager(createMockFramework());
    await pm.initialize();
    const prompt = await pm.getSystemPrompt();
    expect(prompt).toContain('智能助手');
    expect(prompt.length).toBeGreaterThan(50);
  });

  test('getRoleTemplates returns all roles', () => {
    const pm = new PromptManager(createMockFramework());
    const roles = pm.getRoleTemplates();
    expect(roles.general).toBeDefined();
    expect(roles.developer).toBeDefined();
    expect(roles.analyst).toBeDefined();
    expect(roles.writer).toBeDefined();
    expect(roles.researcher).toBeDefined();
  });

  test('change role', async () => {
    const pm = new PromptManager(createMockFramework());
    await pm.initialize();
    pm.currentRole = 'developer';
    const prompt = await pm.getSystemPrompt();
    expect(prompt).toContain('工程师');
  });

  test('prompt history is recorded', async () => {
    const pm = new PromptManager(createMockFramework());
    await pm.initialize();
    await pm.getSystemPrompt();
    await pm.getSystemPrompt();
    expect(pm.promptHistory.length).toBe(2);
    expect(pm.promptHistory[0].version).toBe(1);
    expect(pm.promptHistory[1].version).toBe(2);
  });

  test('custom systemPrompt is appended', async () => {
    const fw = createMockFramework();
    fw.config.features.promptManagement.systemPrompt = 'Custom instruction here';
    const pm = new PromptManager(fw);
    await pm.initialize();
    const prompt = await pm.getSystemPrompt();
    expect(prompt).toContain('Custom instruction here');
  });
});

describe('MemoryManager', () => {
  const MemoryManager = require('../framework/modules/MemoryManager');

  function createMockFramework() {
    return {
      config: {
        features: {
          memoryManagement: {
            enabled: true,
            memoryTypes: ['decision', 'fact', 'constraint', 'commitment', 'important_fact'],
            memoryRetention: 7,
            autoSummarize: false
          }
        }
      },
      modules: {},
      log: () => {}
    };
  }

  test('store and retrieve memory', async () => {
    const mm = new MemoryManager(createMockFramework());
    await mm.initialize();

    const mem = await mm.storeMemory('Use PostgreSQL for database', 'decision', { importance: 'high' });
    expect(mem.content).toBe('Use PostgreSQL for database');
    expect(mem.type).toBe('decision');

    const recent = await mm.getRecentMemory();
    expect(recent.length).toBe(1);
    expect(recent[0].content).toBe('Use PostgreSQL for database');
  });

  test('memory retention filters old memories', async () => {
    const mm = new MemoryManager(createMockFramework());
    await mm.initialize();

    await mm.storeMemory('Recent memory', 'fact');
    const oldMemory = {
      id: 'old-1',
      content: 'Old memory',
      type: 'fact',
      timestamp: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      metadata: {},
      importance: 'normal'
    };
    mm.memoryStore.push(oldMemory);

    const recent = await mm.getRecentMemory();
    expect(recent.length).toBe(1);
    expect(recent[0].content).toBe('Recent memory');
  });

  test('high importance memories survive retention', async () => {
    const mm = new MemoryManager(createMockFramework());
    await mm.initialize();

    const importantOld = {
      id: 'old-important',
      content: 'Critical decision',
      type: 'decision',
      timestamp: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      metadata: {},
      importance: 'high'
    };
    mm.memoryStore.push(importantOld);

    mm.pruneOldMemories();
    expect(mm.memoryStore.length).toBe(1);
    expect(mm.memoryStore[0].content).toBe('Critical decision');
  });

  test('prune respects maxMemoryItems', async () => {
    const mm = new MemoryManager(createMockFramework());
    await mm.initialize();
    mm.maxMemoryItems = 3;

    for (let i = 0; i < 5; i++) {
      await mm.storeMemory(`Memory ${i}`, 'fact');
    }

    expect(mm.memoryStore.length).toBeLessThanOrEqual(3);
  });

  test('search memories by content', async () => {
    const mm = new MemoryManager(createMockFramework());
    await mm.initialize();

    await mm.storeMemory('Use React for frontend', 'decision');
    await mm.storeMemory('Database is PostgreSQL', 'fact');
    await mm.storeMemory('React hooks for state', 'decision');

    const results = mm.search('React');
    expect(results.length).toBe(2);
  });

  test('fallback extract stores decision memories', async () => {
    const mm = new MemoryManager(createMockFramework());
    await mm.initialize();

    await mm._fallbackExtract('我们决定使用Redis作为缓存方案');
    const recent = await mm.getRecentMemory();
    expect(recent.some(m => m.type === 'decision')).toBe(true);
  });

  test('fallback extract stores constraint memories', async () => {
    const mm = new MemoryManager(createMockFramework());
    await mm.initialize();

    await mm._fallbackExtract('系统必须支持1000并发用户');
    const recent = await mm.getRecentMemory();
    expect(recent.some(m => m.type === 'constraint')).toBe(true);
  });
});
