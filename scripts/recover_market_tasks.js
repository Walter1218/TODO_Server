const path = require('path');
const { AgentTaskFramework } = require('../framework');
const DriveOrchestrator = require('../src/services/DriveOrchestrator');
const MarketTaskRecoveryService = require('../src/services/MarketTaskRecoveryService');

const AGENT_ID = 'hermes-default';
const CONFIG_PATH = path.join(__dirname, '..', 'config.hermes-default.json');

async function main() {
  const framework = AgentTaskFramework.fromConfig(CONFIG_PATH);
  await framework.initialize();

  const driveOrchestrator = new DriveOrchestrator({
    intervalMs: 60 * 1000,
    maxRetries: 3,
    retryBackoffMs: [0, 5000, 15000],
    driveCooldownMs: 60 * 1000,
    stallThreshold: 30 * 60 * 1000,
    useThirdPartyValidation: false,
    validationTimeoutMs: 30 * 60 * 1000
  });
  driveOrchestrator.start(framework);

  try {
    const result = await MarketTaskRecoveryService.recoverTodayTasks(AGENT_ID, driveOrchestrator, {
      source: 'market_recovery_script',
      reason: 'recover_today_market_tasks',
      maxForcedAttempts: 5
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    driveOrchestrator.stop();
  }
}

main().catch(err => {
  console.error('[recover_market_tasks] failed:', err);
  process.exit(1);
});
