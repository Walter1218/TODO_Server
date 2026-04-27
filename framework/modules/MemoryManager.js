/**
 * 记忆管理器模块
 * 
 * 功能：
 * - 存储重要决策和事实
 * - 自动从对话中提取关键信息
 * - 管理记忆的保留和遗忘
 * - 支持上下文检索
 */

class MemoryManager {
  constructor(framework) {
    this.framework = framework;
    this.memoryStore = [];
    this.maxMemoryItems = 50;
  }

  async initialize() {
    const config = this.framework.config.features.memoryManagement;
    this.loadFromStorage();
    this.framework.log('✅ MemoryManager 模块已初始化');
  }

  /**
   * 获取最近的记忆
   */
  async getRecentMemory() {
    const config = this.framework.config.features.memoryManagement;
    
    // 根据配置过滤记忆类型
    let filtered = this.memoryStore.filter(memory => 
      config.memoryTypes.includes(memory.type)
    );

    // 只返回保留期内的记忆
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - config.memoryRetention);
    
    filtered = filtered.filter(memory => 
      new Date(memory.timestamp) > cutoffDate
    );

    // 按时间倒序排列
    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // 限制数量
    return filtered.slice(0, 10);
  }

  /**
   * 存储新记忆
   */
  async storeMemory(content, type = 'important_fact', metadata = {}) {
    const memory = {
      id: this.generateId(),
      content,
      type,
      timestamp: new Date().toISOString(),
      metadata,
      importance: metadata.importance || 'normal'
    };

    this.memoryStore.push(memory);

    // 保持记忆数量在限制内
    if (this.memoryStore.length > this.maxMemoryItems) {
      this.pruneOldMemories();
    }

    this.saveToStorage();
    this.framework.log(`💾 记忆已存储: [${type}] ${content.substring(0, 50)}...`);

    return memory;
  }

  /**
   * 从对话中提取并存储记忆
   */
  async extractAndStore(response, userMessage) {
    if (!this.framework.config.features.memoryManagement.autoSummarize) {
      return;
    }

    // 这里需要接入LLM来分析对话并提取关键信息
    // 临时实现：简单关键词检测
    
    const patterns = {
      decision: /(决定|选择|采用|使用)/,
      fact: /(因为|由于|数据显示|根据)/,
      constraint: /(必须|需要|应该|不应该)/,
      commitment: /(会|将|承诺|保证)/
    };

    const text = userMessage + ' ' + (response.message || response);
    
    for (const [type, pattern] of Object.entries(patterns)) {
      if (pattern.test(text)) {
        // 提取包含关键词的句子
        const sentences = text.split(/[。！？]/);
        for (const sentence of sentences) {
          if (pattern.test(sentence)) {
            await this.storeMemory(sentence.trim(), type, {
              source: 'conversation',
              importance: 'normal'
            });
          }
        }
      }
    }
  }

  /**
   * 清理过期记忆
   */
  pruneOldMemories() {
    const config = this.framework.config.features.memoryManagement;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - config.memoryRetention);

    // 保留重要记忆和近期记忆
    this.memoryStore = this.memoryStore.filter(memory => 
      memory.importance === 'high' || 
      new Date(memory.timestamp) > cutoffDate
    );

    // 如果还是太多，删除最旧的
    if (this.memoryStore.length > this.maxMemoryItems) {
      this.memoryStore = this.memoryStore
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, this.maxMemoryItems);
    }
  }

  /**
   * 搜索记忆
   */
  search(query) {
    const lowerQuery = query.toLowerCase();
    return this.memoryStore.filter(memory => 
      memory.content.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * 删除记忆
   */
  deleteMemory(memoryId) {
    const index = this.memoryStore.findIndex(m => m.id === memoryId);
    if (index !== -1) {
      this.memoryStore.splice(index, 1);
      this.saveToStorage();
      return true;
    }
    return false;
  }

  /**
   * 从存储加载
   */
  loadFromStorage() {
    // 实际应该从文件或数据库加载
    // 临时实现：使用内存存储
    try {
      const stored = localStorage?.getItem('agent_memory');
      if (stored) {
        this.memoryStore = JSON.parse(stored);
      }
    } catch (error) {
      this.framework.log('⚠️ 无法加载记忆存储');
    }
  }

  /**
   * 保存到存储
   */
  saveToStorage() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('agent_memory', JSON.stringify(this.memoryStore));
      }
    } catch (error) {
      this.framework.log('⚠️ 无法保存记忆存储');
    }
  }

  /**
   * 生成唯一ID
   */
  generateId() {
    return 'mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * 获取记忆统计
   */
  getStats() {
    const byType = {};
    this.memoryStore.forEach(memory => {
      byType[memory.type] = (byType[memory.type] || 0) + 1;
    });

    return {
      total: this.memoryStore.length,
      byType,
      oldest: this.memoryStore[0]?.timestamp,
      newest: this.memoryStore[this.memoryStore.length - 1]?.timestamp
    };
  }
}

module.exports = MemoryManager;
