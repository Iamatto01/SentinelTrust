// SentinelTruth Server — Express + API + SSE + AI Agent
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dataManager } from './services/data-manager.js';
import { aiAgent } from './services/ai-agent.js';
import { groqAnalyzer } from './services/groq-analyzer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// Serve Vite's built frontend (production) or dev files
// ============================================================
const distPath = join(__dirname, '..', 'dist');
const publicPath = join(__dirname, '..');
let hasScheduledAgentStart = false;

if (existsSync(distPath)) {
  // Production: serve built files
  app.use(express.static(distPath));
} else {
  // Dev: serve source files directly (Vite handles in real dev, but this works for basic serving)
  app.use(express.static(publicPath));
}

// ============================================================
// Health endpoint (for cron-job.org keep-alive)
// ============================================================
app.get('/health', (req, res) => {
  const quality = dataManager.getDataQualityStats();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    agent: aiAgent.status,
    topics: dataManager.getAllTopics().length,
    countedForStats: quality.countedForStats,
    strictRealMode: quality.strictRealMode,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/ping', (req, res) => res.json({ pong: true }));

// ============================================================
// SSE — Real-time progress stream
// ============================================================
app.get('/api/progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to SentinelTruth progress stream' })}\n\n`);

  // Register this client with the AI agent
  aiAgent.addSSEClient(res);

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(`event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on('close', () => clearInterval(heartbeat));
});

// ============================================================
// Topics API
// ============================================================
app.get('/api/topics', (req, res) => {
  const { party, verdict, category, search, limit } = req.query;
  const topics = dataManager.filterTopics({ party, verdict, category, search, limit: parseInt(limit) || 100 });
  res.json(topics);
});

app.get('/api/topics/:id', (req, res) => {
  const topic = dataManager.getTopicById(req.params.id);
  if (!topic) return res.status(404).json({ error: 'Not found' });
  res.json(topic);
});

app.post('/api/topics/backfill-translations', async (req, res) => {
  const limit = parseInt(req.body?.limit, 10) || 60;
  const result = await aiAgent.backfillTranslations({ limit });

  if (!result.success) {
    return res.status(400).json(result);
  }

  return res.json(result);
});

// ============================================================
// Statistics API
// ============================================================
app.get('/api/stats', (req, res) => {
  res.json(dataManager.getStats());
});

app.get('/api/data-quality', (req, res) => {
  res.json(dataManager.getDataQualityStats());
});

// ============================================================
// Agent API
// ============================================================
app.get('/api/agent/status', (req, res) => {
  res.json(aiAgent.getStatus());
});

app.post('/api/agent/start', (req, res) => {
  aiAgent.start();
  res.json({ success: true, status: aiAgent.getStatus() });
});

app.post('/api/agent/pause', (req, res) => {
  aiAgent.pause();
  res.json({ success: true, status: aiAgent.getStatus() });
});

app.post('/api/agent/stop', (req, res) => {
  aiAgent.stop();
  res.json({ success: true, status: aiAgent.getStatus() });
});

app.get('/api/agent/log', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(dataManager.getLog(limit));
});

app.post('/api/agent/log/clear', (req, res) => {
  dataManager.clearLog();
  res.json({ success: true });
});

app.post('/api/agent/reset', (req, res) => {
  if (process.env.ENABLE_AGENT_RESET !== 'true') {
    return res.status(403).json({ success: false, error: 'Reset endpoint disabled' });
  }
  aiAgent.stop();
  dataManager.reset();
  res.json({ success: true });
});

// ============================================================
// Provider status API
// ============================================================
app.get('/api/providers', (req, res) => {
  res.json({
    groq: groqAnalyzer.getUsage(),
  });
});

// ============================================================
// Fallback to frontend for SPA routing
// ============================================================
app.get('*', (req, res) => {
  if (existsSync(join(distPath, 'index.html'))) {
    res.sendFile(join(distPath, 'index.html'));
  } else {
    res.sendFile(join(publicPath, 'index.html'));
  }
});

// ============================================================
// Start server
// ============================================================
function printStartupBanner(activePort) {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       🛡️  SentinelTruth v2.0             ║');
  console.log('║   Malaysian Political Fact-Checker       ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  🌐 Server: http://localhost:${activePort}        ║`);
  console.log(`║  📡 SSE:    http://localhost:${activePort}/api/progress ║`);
  console.log(`║  ❤️  Health: http://localhost:${activePort}/health      ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  🤖 Groq:     ${groqAnalyzer.isAvailable() ? '✅ Connected' : '❌ No API key'}          ║`);
  console.log('║  🧠 Mode:     Groq key-pool pipeline                  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
}

function maybeAutoStartAgent() {
  if (hasScheduledAgentStart) return;
  hasScheduledAgentStart = true;

  // Auto-start agent if configured
  if (process.env.AGENT_AUTO_START === 'true') {
    console.log('[Server] Auto-starting AI Agent...');
    setTimeout(() => aiAgent.start(), 2000);
  } else {
    console.log('[Server] Agent ready — start via dashboard or POST /api/agent/start');
  }
}

function startServer(preferredPort, retriesLeft = 8) {
  const numericPort = Number(preferredPort) || 3000;
  const server = app.listen(numericPort);

  server.once('listening', () => {
    const address = server.address();
    const activePort = typeof address === 'object' && address ? address.port : numericPort;
    printStartupBanner(activePort);
    maybeAutoStartAgent();
  });

  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE' && retriesLeft > 0) {
      const nextPort = numericPort + 1;
      console.warn(`[Server] Port ${numericPort} is already in use. Retrying on ${nextPort}...`);
      startServer(nextPort, retriesLeft - 1);
      return;
    }

    console.error(`[Server] Failed to start: ${error.message}`);
    process.exit(1);
  });
}

startServer(PORT);
