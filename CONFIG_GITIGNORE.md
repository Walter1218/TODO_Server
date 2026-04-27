# ⚠️ config.json 已从 Git 追踪中排除

`config.json` 包含敏感信息（API Key），已被 `.gitignore` 排除。

## 📋 设置步骤

### 1. 复制配置模板
```bash
cp config.example.json config.json
```

### 2. 填入你的配置
编辑 `config.json`，填入：
- MiniMax API Key
- Agent ID

### 3. 忽略已追踪的文件（如果之前提交过）
```bash
git rm --cached config.json
```
