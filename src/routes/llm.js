const express = require('express');
const router = express.Router();

function getFramework(req) {
  return req.app.get('driveFramework');
}

router.get('/status', (req, res) => {
  try {
    const fw = getFramework(req);
    if (!fw || !fw.modules.llmManager) {
      return res.json({
        success: true,
        data: { hasProvider: false, primary: null, fallback: null }
      });
    }

    const llmStatus = fw.modules.llmManager.getStatus();
    res.json({ success: true, data: llmStatus });
  } catch (err) {
    console.error('[LLM] status error:', err.message);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

router.post('/swap', async (req, res) => {
  try {
    const fw = getFramework(req);
    if (!fw || !fw.modules.llmManager) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'Framework 未初始化，无法切换 LLM Provider'
      });
    }

    const { provider, apiKey, model, baseUrl, temperature, maxTokens, testTimeoutMs } = req.body;

    if (!provider) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'provider 字段必填（openai / anthropic / minimax / ollama）'
      });
    }

    const newConfig = { provider };
    if (apiKey) newConfig.apiKey = apiKey;
    if (model) newConfig.model = model;
    if (baseUrl) newConfig.baseUrl = baseUrl;
    if (temperature !== undefined) newConfig.temperature = temperature;
    if (maxTokens !== undefined) newConfig.maxTokens = maxTokens;

    const result = await fw.modules.llmManager.swapProvider(newConfig, {
      testTimeoutMs: testTimeoutMs || 10000
    });

    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    console.error('[LLM] swap error:', err.message);
    res.status(400).json({
      error: 'Swap failed',
      message: err.message
    });
  }
});

module.exports = router;
