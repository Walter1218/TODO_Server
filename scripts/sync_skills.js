const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function syncSkills() {
  console.log('🔄 开始同步 Hermes Todo Skill...');

  const hermesHome = process.env.HERMES_HOME || path.join(process.env.HOME || process.env.USERPROFILE, '.hermes');
  const targetSkillDir = path.join(hermesHome, 'skills', 'hermes-todo-skill');
  const sourceSkillDir = path.join(__dirname, '..', 'skills', 'hermes-todo-skill');

  if (!fs.existsSync(sourceSkillDir)) {
    console.error(`❌ 源码目录不存在: ${sourceSkillDir}`);
    return;
  }

  if (!fs.existsSync(targetSkillDir)) {
    console.log(`📂 创建目标目录: ${targetSkillDir}`);
    fs.mkdirSync(targetSkillDir, { recursive: true });
  }

  const filesToSync = ['todo_skill.py', 'SKILL.md', 'todo_skill_config.yaml'];

  for (const file of filesToSync) {
    const src = path.join(sourceSkillDir, file);
    const dest = path.join(targetSkillDir, file);
    
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`✅ 已同步: ${file}`);
      
      // 如果是 python 脚本，确保可执行
      if (file.endsWith('.py')) {
        try {
          execSync(`chmod +x "${dest}"`);
        } catch (e) {
          // ignore on windows
        }
      }
    }
  }

  console.log('\n✨ Skill 同步完成！');
  console.log(`目标路径: ${targetSkillDir}`);
}

syncSkills().catch(console.error);
