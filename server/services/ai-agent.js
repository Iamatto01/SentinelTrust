// AI Agent — Server-side continuous analysis pipeline
// Searches → Analyzes → Translates (deferred) → Stores → Broadcasts
// Optimized: deferred translation cycle, parallel batch translation, shared constants

import { groqAnalyzer } from './groq-analyzer.js';
import { ollamaAnalyzer } from './ollama-analyzer.js';
import { huggingFaceFallback } from './huggingface-fallback.js';
import { dataManager } from './data-manager.js';
import { sourceCollector } from './source-collector.js';
import { sourceVerifier } from './source-verifier.js';
import {
  PARTY_KEYWORDS,
  CATEGORY_KEYWORDS,
  isMalaysiaPoliticalContent,
  guessParty,
  guessCategory,
} from './shared-constants.js';

class AIAgent {
  constructor() {
    this.status = 'idle'; // idle, running, paused
    this._searchInterval = null;
    this._analyzeInterval = null;
    this._translateInterval = null; // NEW: separate translation cycle
    this._analyzeKickTimer = null;
    this._analyzeInFlight = false;
    this._translateInFlight = false;
    this._queue = [];
    this._topicsAnalyzed = 0;
    this._currentAction = 'Agent idle';
    this._sseClients = new Set();
    this._bulkIngesting = false;
    this._lastIngestionReport = null;
    this.allowSimulatedData = process.env.ALLOW_SIMULATED_DATA === 'true';

    // Intervals from env or defaults
    this.searchIntervalMs = parseInt(process.env.SEARCH_INTERVAL_MS || '1800000'); // 30 min
    this.analyzeIntervalMs = parseInt(process.env.ANALYZE_INTERVAL_MS || '30000'); // 30 sec
    this.translateIntervalMs = 60000; // Translation cycle: every 60s
    this.translateBatchSize = 3; // Parallel translations per cycle
    this.analyzeBatchSize = Math.max(1, parseInt(process.env.ANALYZE_BATCH_SIZE || '1', 10));
  }

  // --- SSE Client Management ---

  addSSEClient(res) {
    this._sseClients.add(res);
    // Send current status immediately
    this._sendSSE(res, 'status', this.getStatus());
    res.on('close', () => this._sseClients.delete(res));
  }

  _broadcast(event, data) {
    const dead = [];
    for (const client of this._sseClients) {
      try {
        this._sendSSE(client, event, data);
      } catch {
        dead.push(client);
      }
    }
    dead.forEach(c => this._sseClients.delete(c));
  }

  _sendSSE(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  _updateAction(action, type = 'action') {
    this._currentAction = action;
    const logEntry = { type, message: action };
    dataManager.addLog(logEntry);
    this._broadcast('action', { action, type, timestamp: new Date().toISOString() });
    console.log(`[Agent] ${action}`);
  }

  // --- Agent Controls ---

  start() {
    if (this.status === 'running') return;
    this.status = 'running';
    this._updateAction('🚀 AI Agent started — beginning continuous analysis', 'system');
    this._updateAction(`⚡ Parallel pipeline active: feed discovery + AI analysis (Groq/Ollama/HF, batch ${this.analyzeBatchSize}) + deferred translation`, 'system');
    this._broadcast('status', this.getStatus());

    // Start search cycle
    this._doSearch();
    this._searchInterval = setInterval(() => this._doSearch(), this.searchIntervalMs);

    // Start analyze cycle
    this._analyzeInterval = setInterval(() => this._doAnalyze(), this.analyzeIntervalMs);

    // Start deferred translation cycle (NEW)
    this._translateInterval = setInterval(() => this._doTranslate(), this.translateIntervalMs);

    // Run first analyze quickly
    this._scheduleAnalyzeSoon(5000);
  }

  pause() {
    if (this.status !== 'running') return;
    this.status = 'paused';
    clearInterval(this._searchInterval);
    clearInterval(this._analyzeInterval);
    clearInterval(this._translateInterval);
    clearTimeout(this._analyzeKickTimer);
    this._analyzeKickTimer = null;
    this._searchInterval = null;
    this._analyzeInterval = null;
    this._translateInterval = null;
    this._updateAction('⏸️ AI Agent paused', 'system');
    this._broadcast('status', this.getStatus());
  }

  stop() {
    this.status = 'idle';
    clearInterval(this._searchInterval);
    clearInterval(this._analyzeInterval);
    clearInterval(this._translateInterval);
    clearTimeout(this._analyzeKickTimer);
    this._analyzeKickTimer = null;
    this._searchInterval = null;
    this._analyzeInterval = null;
    this._translateInterval = null;
    this._updateAction('⏹️ AI Agent stopped', 'system');
    this._broadcast('status', this.getStatus());
  }

  getStatus() {
    return {
      status: this.status,
      currentAction: this._currentAction,
      topicsAnalyzed: this._topicsAnalyzed,
      queueLength: this._queue.length,
      bulkIngesting: this._bulkIngesting,
      lastIngestionReport: this._lastIngestionReport,
      providers: {
        groq: groqAnalyzer.getUsage(),
        ollama: ollamaAnalyzer.getUsage(),
        huggingface: huggingFaceFallback.getUsage(),
      }
    };
  }

  // --- Search Phase ---

  _scheduleAnalyzeSoon(delayMs = 1000) {
    if (this.status !== 'running') return;
    clearTimeout(this._analyzeKickTimer);
    this._analyzeKickTimer = setTimeout(() => {
      this._analyzeKickTimer = null;
      this._doAnalyze();
    }, delayMs);
  }

  async _doSearch() {
    if (this.status !== 'running') return;

    this._updateAction('🔍 Searching for new Malaysian political topics via RSS/Google News feeds...', 'action');

    const fallbackQueued = await this._fallbackSearchFromFeeds('Feed discovery');

    if (fallbackQueued === 0 && this.allowSimulatedData) {
      this._addSimulatedTopics();
    } else if (fallbackQueued === 0 && !this.allowSimulatedData) {
      this._updateAction('⚠️ Feed collection returned no topics and simulated data is disabled (strict real mode)', 'system');
    } else if (fallbackQueued > 0) {
      this._scheduleAnalyzeSoon(800);
    }

    this._broadcast('status', this.getStatus());
  }

  _mapCollectedRecordToQueuedTopic(record) {
    const combined = `${record.title || ''} ${record.summary || ''}`;

    return {
      title: record.title,
      snippet: record.summary || record.title,
      party: guessParty(combined),
      category: guessCategory(combined),
      sourceUrl: record.url,
      sourceName: record.sourceName || 'Source',
      sourceType: record.sourceType || 'internet',
      recordType: 'ai',
      verification: {
        status: 'UNKNOWN',
        score: 0,
        method: 'feed_fallback',
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  _isMalaysiaPoliticalTopic(topic = {}) {
    return isMalaysiaPoliticalContent(topic.title, topic.snippet || topic.summary);
  }

  async _fallbackSearchFromFeeds(reason = 'Feed discovery') {
    this._updateAction(`🛰️ ${reason} — collecting topics from RSS/Google News feeds...`, 'action');

    const fallbackResult = await sourceCollector.collect({
      targetCount: 40,
      includeInternet: true,
      includeFacebook: false,
    });

    if (!fallbackResult.success || fallbackResult.records.length === 0) {
      this._updateAction('⚠️ Feed collection returned no records', 'system');
      return 0;
    }

    let queued = 0;
    for (const record of fallbackResult.records.slice(0, 15)) {
      const topic = this._mapCollectedRecordToQueuedTopic(record);
      if (!this._isMalaysiaPoliticalTopic(topic)) {
        continue;
      }
      if (!this._isTopicAlreadyQueued(topic)) {
        this._queue.push(topic);
        queued++;
      }
    }

    if (queued > 0) {
      this._updateAction(`📥 Feed search queued ${queued} topics`, 'discovery');
      this._updateAction(`📋 Queue updated: ${this._queue.length} topics pending analysis`, 'action');
    } else {
      this._updateAction('🔁 Feed search found only duplicates', 'action');
    }

    return queued;
  }

  _addSimulatedTopics() {
    const templates = [
      { title: `New claims about government spending transparency — ${new Date().toLocaleDateString()}`, snippet: 'Social media posts allege lack of transparency in government procurement contracts.', party: 'PKR', category: 'Corruption' },
      { title: `Opposition questions election readiness — ${new Date().toLocaleDateString()}`, snippet: 'PN leadership questions whether the Election Commission is prepared for potential early elections.', party: 'BERSATU', category: 'Elections' },
      { title: `PAS youth rally draws attention — ${new Date().toLocaleDateString()}`, snippet: 'PAS Youth organizes gathering to promote Islamic values in governance, drawing media coverage.', party: 'PAS', category: 'Social Issues' },
      { title: `UMNO demands greater Cabinet representation — ${new Date().toLocaleDateString()}`, snippet: 'UMNO grassroots push for more ministerial posts in upcoming reshuffle discussions.', party: 'UMNO', category: 'Coalition Politics' },
      { title: `DAP responds to racial harmony criticism — ${new Date().toLocaleDateString()}`, snippet: 'DAP addresses allegations of not doing enough for multiracial unity within the coalition.', party: 'DAP', category: 'Racial Politics' },
    ];

    const randTopic = templates[Math.floor(Math.random() * templates.length)];
    this._queue.push(randTopic);
    this._updateAction(`📋 Added simulated topic for demo analysis (no API keys configured)`, 'action');
    this._scheduleAnalyzeSoon(800);
  }

  // --- Analyze Phase (no longer translates inline) ---

  async _doAnalyze() {
    if (this.status !== 'running' || this._queue.length === 0 || this._analyzeInFlight) return;

    this._analyzeInFlight = true;
    try {
      const toProcess = Math.min(this.analyzeBatchSize, this._queue.length);
      for (let i = 0; i < toProcess; i++) {
        const topic = this._queue.shift();
        if (!topic) break;
        await this._analyzeTopic(topic);
        if (this.status !== 'running') break;
      }
    } finally {
      this._analyzeInFlight = false;
      this._broadcast('status', this.getStatus());
    }
  }

  async _analyzeTopic(topic) {
    this._updateAction(`🧠 Analyzing: "${topic.title}"`, 'action');
    this._broadcast('status', this.getStatus());

    // Try Groq first, fall back to Ollama, then HuggingFace
    let analysisResult;
    let providerUsed = 'Heuristic';
    const groqUsage = groqAnalyzer.getUsage();
    const groqCoolingDown = (groqUsage.cooldownRemainingSec || 0) > 0;

    if (groqAnalyzer.isAvailable() && !groqCoolingDown) {
      this._updateAction(`🤖 Using Groq (Llama 3.3 70B) for analysis...`, 'action');
      analysisResult = await groqAnalyzer.analyzeTopic(topic);
      if (analysisResult?.success) providerUsed = 'Groq';
    } else if (groqAnalyzer.isAvailable() && groqCoolingDown) {
      this._updateAction(`⏳ Groq cooldown active (${groqUsage.cooldownRemainingSec}s) — using fallback analyzer`, 'action');
    }

    if (!analysisResult?.success && ollamaAnalyzer.isAvailable()) {
      this._updateAction(`🦙 Groq unavailable, trying Ollama...`, 'action');
      analysisResult = await ollamaAnalyzer.analyzeTopic(topic);
      if (analysisResult?.success) providerUsed = 'Ollama';
    }

    if (!analysisResult?.success && huggingFaceFallback.isAvailable()) {
      this._updateAction(`🔄 Groq unavailable, falling back to HuggingFace...`, 'action');
      analysisResult = await huggingFaceFallback.analyzeTopic(topic);
      if (analysisResult?.success) providerUsed = 'HuggingFace';
    }

    if (!analysisResult?.success) {
      // AI provider unavailable/rate-limited — use heuristic fallback
      this._updateAction(`⚡ Using heuristic analysis due provider limits/unavailability`, 'action');
      analysisResult = this._heuristicAnalysis(topic);
      providerUsed = 'Heuristic';
    }

    const topicSources = Array.isArray(topic.sources)
      ? topic.sources
      : (topic.sourceUrl ? [{ name: topic.sourceName || 'Source', url: topic.sourceUrl }] : []);

    // Build the full topic object (NO translation here — deferred to translation cycle)
    const newTopic = {
      id: `st-ai-${Date.now()}`,
      title: topic.title,
      summary: analysisResult.summary || topic.snippet || topic.title,
      category: analysisResult.category || topic.category || 'General',
      party: analysisResult.party || topic.party || 'PKR',
      verdict: analysisResult.verdict || 'UNVERIFIED',
      date: new Date().toISOString().split('T')[0],
      sources: topicSources,
      analysis: analysisResult.analysis || 'Analysis pending.',
      connections: [],
      impact: analysisResult.impact || 'medium',
      region: analysisResult.region || 'National',
      factCheckRef: analysisResult.factCheckRef || 'AI Analysis',
      confidence: analysisResult.confidence || 'medium',
      translations: {}, // Will be filled by deferred translation cycle
      aiProvider: providerUsed,
      sourceType: topic.sourceType || 'internet',
      recordType: topic.recordType || 'ai',
      verification: topic.verification || {
        status: 'UNKNOWN',
        score: 0,
        method: 'ai_pipeline',
        verifiedAt: new Date().toISOString(),
      },
    };

    // Store the topic immediately (translation happens later)
    const stored = dataManager.addTopic(newTopic);
    if (stored) {
      this._topicsAnalyzed++;
      this._updateAction(`✅ Completed: "${newTopic.title}" → ${newTopic.verdict} (by ${newTopic.aiProvider})`, 'discovery');
    } else {
      this._updateAction(`⏭️ Skipped duplicate: "${newTopic.title}"`, 'action');
    }

    this._broadcast('status', this.getStatus());
    this._broadcast('newTopic', stored || {});
  }

  _heuristicAnalysis(topic) {
    // Simple keyword-based heuristic when no AI is available
    const titleLower = (topic.title || '').toLowerCase();
    const snippetLower = (topic.snippet || '').toLowerCase();
    const combined = titleLower + ' ' + snippetLower;

    let verdict = 'UNVERIFIED';
    let confidence = 'low';

    // Hoax indicators
    const hoaxWords = ['secretly', 'viral claim', 'whatsapp', 'shocking', 'exposed', 'leaked'];
    const trueWords = ['confirmed', 'official statement', 'announced', 'approved', 'signed'];
    const misleadingWords = ['alleged', 'reportedly', 'sources say', 'claims that'];

    if (hoaxWords.some(w => combined.includes(w))) {
      verdict = 'UNVERIFIED'; // Mark as unverified rather than guessing hoax
    } else if (trueWords.some(w => combined.includes(w))) {
      verdict = 'UNVERIFIED';
    } else if (misleadingWords.some(w => combined.includes(w))) {
      verdict = 'UNVERIFIED';
    }

    return {
      success: true,
      verdict,
      summary: topic.snippet || topic.title,
      analysis: 'This topic was analyzed using basic heuristics because no AI provider was reachable. For accurate fact-checking, configure Groq, Ollama, and/or HuggingFace.',
      party: topic.party || 'PKR',
      category: topic.category || 'General',
      impact: 'medium',
      region: 'National',
      confidence,
      factCheckRef: 'Pending AI verification'
    };
  }

  // --- Deferred Translation Cycle (NEW) ---

  _hasCompleteTranslations(topic) {
    const t = topic?.translations || {};
    const requiredLangs = ['ms', 'hi', 'zh'];
    return requiredLangs.every((lang) => {
      const payload = t[lang];
      return payload && payload.title && payload.summary && payload.analysis;
    });
  }

  /**
   * Background translation cycle — runs every 60s, processes a batch of
   * untranslated topics in parallel (3 at a time).
   */
  async _doTranslate() {
    if (this.status !== 'running' || this._translateInFlight) return;

    // Skip if no translation provider is available
    if (!groqAnalyzer.isAvailable() && !ollamaAnalyzer.isAvailable()) return;

    // Skip if Groq is cooling down and Ollama isn't available
    const groqUsage = groqAnalyzer.getUsage();
    const groqCoolingDown = (groqUsage.cooldownRemainingSec || 0) > 0;
    if (groqCoolingDown && !ollamaAnalyzer.isAvailable()) return;

    const candidates = dataManager
      .getAllTopics()
      .filter((topic) => !this._hasCompleteTranslations(topic))
      .slice(0, this.translateBatchSize);

    if (candidates.length === 0) return;

    this._translateInFlight = true;
    try {
      this._updateAction(`🌐 Translating ${candidates.length} topics (BM, Hindi, Chinese)...`, 'action');

      // Parallel batch translation
      const results = await Promise.allSettled(
        candidates.map(async (topic) => {
          const transResult = await this._translateTopicWithProviders(topic, { emitLog: false });
          if (transResult?.success) {
            dataManager.updateTopicTranslations(topic.id, transResult.translations);
            return true;
          }
          return false;
        })
      );

      const updated = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
      if (updated > 0) {
        this._updateAction(`✅ Translated ${updated} topics`, 'action');
      }
    } finally {
      this._translateInFlight = false;
    }
  }

  async _translateTopicWithProviders(topic, { emitLog = true } = {}) {
    if (emitLog) {
      this._updateAction('🌐 Translating to BM, Hindi, Chinese...', 'action');
    }

    if (groqAnalyzer.isAvailable()) {
      const viaGroq = await groqAnalyzer.translateTopic(topic);
      if (viaGroq?.success) return viaGroq;
    }

    if (ollamaAnalyzer.isAvailable()) {
      const viaOllama = await ollamaAnalyzer.translateTopic(topic);
      if (viaOllama?.success) return viaOllama;
    }

    return { success: false, error: 'No translation provider available' };
  }

  async backfillTranslations({ limit = 60 } = {}) {
    const maxItems = Math.max(1, Math.min(parseInt(limit, 10) || 60, 300));

    if (!groqAnalyzer.isAvailable() && !ollamaAnalyzer.isAvailable()) {
      return {
        success: false,
        error: 'No translation provider available. Configure Groq or Ollama.',
        scanned: 0,
        updated: 0,
        remaining: 0,
      };
    }

    const candidates = dataManager
      .getAllTopics()
      .filter((topic) => !this._hasCompleteTranslations(topic))
      .slice(0, maxItems);

    let updated = 0;

    if (candidates.length > 0) {
      this._updateAction(`🌐 Backfilling translations for ${candidates.length} topics...`, 'action');
    }

    // Process in parallel batches of 3 for speed
    for (let i = 0; i < candidates.length; i += 3) {
      const batch = candidates.slice(i, i + 3);
      const results = await Promise.allSettled(
        batch.map(async (topic) => {
          const translationResult = await this._translateTopicWithProviders(topic, { emitLog: false });
          if (!translationResult?.success) return false;
          const saved = dataManager.updateTopicTranslations(topic.id, translationResult.translations);
          return !!saved;
        })
      );
      updated += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    }

    const remaining = dataManager
      .getAllTopics()
      .filter((topic) => !this._hasCompleteTranslations(topic)).length;

    if (updated > 0) {
      this._updateAction(`✅ Translation backfill updated ${updated} topics`, 'system');
    } else if (candidates.length > 0) {
      this._updateAction('ℹ️ Translation backfill finished with 0 updates', 'system');
    }

    return {
      success: true,
      scanned: candidates.length,
      updated,
      remaining,
    };
  }

  _isTopicAlreadyQueued(topic) {
    const incomingTitle = (topic.title || '').toLowerCase();
    const incomingUrl = (topic.sourceUrl || topic.url || topic.sources?.[0]?.url || '').toLowerCase();

    return this._queue.some(queued => {
      const queuedTitle = (queued.title || '').toLowerCase();
      const queuedUrl = (queued.sourceUrl || queued.url || queued.sources?.[0]?.url || '').toLowerCase();
      if (incomingUrl && queuedUrl && incomingUrl === queuedUrl) return true;
      return incomingTitle && queuedTitle && incomingTitle === queuedTitle;
    });
  }

  _scoreToConfidence(score) {
    if (score >= 80) return 'high';
    if (score >= 65) return 'medium';
    return 'low';
  }

  _toTopicFromVerifiedRecord(record, index) {
    const combinedText = `${record.title || ''} ${record.summary || ''}`;
    const party = guessParty(combinedText);
    const category = guessCategory(combinedText);
    const score = Number(record?.verification?.score || 0);
    const verificationStatus = record?.verification?.status || 'UNKNOWN';
    const sourceName = record?.sourceName || 'Source';

    return {
      id: `st-real-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
      title: record.title,
      summary: record.summary,
      category,
      party,
      verdict: 'UNVERIFIED',
      date: (record.publishedAt || new Date().toISOString()).split('T')[0],
      sources: [{ name: sourceName, url: record.url }],
      analysis: `Source authenticity verification: ${verificationStatus} (${score}/100). This record is included for evidence tracking; factual claim verdict remains UNVERIFIED until explicit claim-level fact-checking is completed.`,
      connections: [],
      impact: 'medium',
      region: 'National',
      factCheckRef: `SourceVerifier (${record?.verification?.method || 'rule_based_v1'})`,
      confidence: this._scoreToConfidence(score),
      translations: {},
      aiProvider: 'SourceVerifier',
      sourceType: record.sourceType || 'internet',
      recordType: 'collected',
      verification: record.verification,
      sourceMeta: {
        sourceName,
        sourceDomain: record.sourceDomain || '',
        publishedAt: record.publishedAt || null,
        collectedAt: record.collectedAt || new Date().toISOString(),
        sourceFeed: record.sourceFeed || null,
      },
    };
  }

  async ingestRealArticles({ targetCount = 1000, includeInternet = true, includeFacebook = true } = {}) {
    if (this._bulkIngesting) {
      return { success: false, error: 'Ingestion already running', report: this._lastIngestionReport };
    }

    this._bulkIngesting = true;
    this._broadcast('status', this.getStatus());

    try {
      const target = Math.max(50, Math.min(Number(targetCount) || 1000, 5000));
      this._updateAction(`📥 Collecting up to ${target} real articles from internet${includeFacebook ? ' + Facebook' : ''}...`, 'action');

      const collected = await sourceCollector.collect({ targetCount: target, includeInternet, includeFacebook });
      this._updateAction(`🧪 Verifying authenticity for ${collected.dedupedCount} collected records...`, 'action');

      const verification = sourceVerifier.verifyBatch(collected.records);
      const topics = verification.accepted.map((record, index) => this._toTopicFromVerifiedRecord(record, index));
      const saved = dataManager.addTopicsBulk(topics);

      const report = {
        targetCount: target,
        collectedCount: collected.collectedCount,
        dedupedCount: collected.dedupedCount,
        verifiedAccepted: verification.metrics.accepted,
        verifiedRejected: verification.metrics.rejected,
        stored: saved.added,
        duplicatesSkipped: saved.duplicates,
        acceptanceRate: verification.metrics.acceptanceRate,
        sourceErrors: collected.errors,
        statusCounts: verification.metrics.statusCounts,
        finishedAt: new Date().toISOString(),
      };

      this._lastIngestionReport = report;

      this._updateAction(`✅ Ingestion complete: stored ${saved.added} verified real records (duplicates: ${saved.duplicates})`, 'discovery');
      this._broadcast('ingestionReport', report);
      this._broadcast('status', this.getStatus());

      return { success: true, report };
    } catch (error) {
      this._updateAction(`❌ Ingestion failed: ${error.message}`, 'system');
      return { success: false, error: error.message };
    } finally {
      this._bulkIngesting = false;
      this._broadcast('status', this.getStatus());
    }
  }
}

export const aiAgent = new AIAgent();
