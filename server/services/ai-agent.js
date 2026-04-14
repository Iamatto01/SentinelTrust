// AI Agent — Server-side continuous analysis pipeline
// Searches → Analyzes → Translates → Stores → Broadcasts

import { groqAnalyzer } from './groq-analyzer.js';
import { huggingFaceFallback } from './huggingface-fallback.js';
import { dataManager } from './data-manager.js';
import { sourceCollector } from './source-collector.js';
import { sourceVerifier } from './source-verifier.js';

const PARTY_KEYWORDS = {
  PKR: ['pkr', 'anwar ibrahim', 'rafizi', 'nurul izzah'],
  DAP: ['democratic action party', 'anthony loke', 'lim guan eng'],
  AMANAH: ['amanah', 'mohamad sabu', 'mat sabu'],
  UMNO: ['umno', 'zahid', 'ahmad zahid', 'tok mat', 'ismail sabri'],
  PAS: ['pas', 'hadi awang', 'abdul hadi', 'sanusi'],
  BERSATU: ['bersatu', 'muhyiddin', 'hamzah zainudin', 'pn'],
  GPS: ['gps', 'abang johari', 'sarawak coalition'],
  MUDA: ['muda', 'syed saddiq'],
};

const CATEGORY_KEYWORDS = {
  Corruption: ['corruption', 'bribe', 'macc', 'graft', 'money laundering'],
  Elections: ['election', 'poll', 'spr', 'undi18', 'by-election', 'campaign'],
  Economy: ['economy', 'budget', 'ringgit', 'inflation', 'subsidy', 'fiscal'],
  Policy: ['policy', 'proposal', 'cabinet', 'ministry', 'initiative'],
  Governance: ['governance', 'administration', 'parliament', 'dewan rakyat'],
  Legal: ['court', 'judge', 'trial', 'legal', 'prosecution'],
  Education: ['education', 'school', 'university', 'moe'],
  'Racial Politics': ['racial', 'ethnic', 'religion', 'bumiputera', 'unity'],
  'Social Issues': ['welfare', 'poverty', 'housing', 'healthcare'],
  'Digital Security': ['cyber', 'data breach', 'security', 'hack'],
};

const MALAYSIA_TOPIC_SIGNALS = [
  'malaysia',
  'malaysian',
  'putrajaya',
  'dewan rakyat',
  'dewan negara',
  'parlimen',
  'parliament malaysia',
  'kerajaan',
  'pakatan harapan',
  'perikatan nasional',
  'barisan nasional',
  'sprm',
  'macc',
  'pilihan raya',
  'suruhanjaya pilihan raya',
];

const POLITICAL_TOPIC_SIGNALS = [
  'politic',
  'political',
  'election',
  'policy',
  'parliament',
  'cabinet',
  'minister',
  'coalition',
  'opposition',
  'government',
  'governance',
  'corruption',
  'campaign',
  'bill',
  'legislation',
  'manifesto',
  'undi',
  'politik',
  'dasar',
];

function includesAnySignal(text = '', terms = []) {
  return terms.some((term) => {
    const normalized = String(term || '').toLowerCase();
    if (!normalized) return false;

    if (/^[a-z0-9]+$/.test(normalized) && normalized.length <= 4) {
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
    }

    return text.includes(normalized);
  });
}

class AIAgent {
  constructor() {
    this.status = 'idle'; // idle, running, paused
    this._searchInterval = null;
    this._analyzeInterval = null;
    this._analyzeKickTimer = null;
    this._analyzeInFlight = false;
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
    this._updateAction(`⚡ Parallel pipeline active: feed discovery + Groq analysis (batch ${this.analyzeBatchSize})`, 'system');
    this._broadcast('status', this.getStatus());

    // Start search cycle
    this._doSearch();
    this._searchInterval = setInterval(() => this._doSearch(), this.searchIntervalMs);

    // Start analyze cycle
    this._analyzeInterval = setInterval(() => this._doAnalyze(), this.analyzeIntervalMs);

    // Run first analyze quickly
    this._scheduleAnalyzeSoon(5000);
  }

  pause() {
    if (this.status !== 'running') return;
    this.status = 'paused';
    clearInterval(this._searchInterval);
    clearInterval(this._analyzeInterval);
    clearTimeout(this._analyzeKickTimer);
    this._analyzeKickTimer = null;
    this._searchInterval = null;
    this._analyzeInterval = null;
    this._updateAction('⏸️ AI Agent paused', 'system');
    this._broadcast('status', this.getStatus());
  }

  stop() {
    this.status = 'idle';
    clearInterval(this._searchInterval);
    clearInterval(this._analyzeInterval);
    clearTimeout(this._analyzeKickTimer);
    this._analyzeKickTimer = null;
    this._searchInterval = null;
    this._analyzeInterval = null;
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
      party: this._guessParty(combined),
      category: this._guessCategory(combined),
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
    const combinedText = `${topic.title || ''} ${topic.snippet || ''} ${topic.summary || ''}`.toLowerCase();
    const hasPartySignal = Object.values(PARTY_KEYWORDS)
      .flat()
      .some((keyword) => combinedText.includes(keyword.toLowerCase()));

    const hasMalaysiaSignal =
      hasPartySignal ||
      includesAnySignal(combinedText, MALAYSIA_TOPIC_SIGNALS);

    const hasPoliticalSignal =
      hasPartySignal ||
      includesAnySignal(combinedText, POLITICAL_TOPIC_SIGNALS);

    return hasMalaysiaSignal && hasPoliticalSignal;
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

  // --- Analyze Phase ---

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

    // Try Groq first, fall back to HuggingFace
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

    // Build the full topic object
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
      translations: {},
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

    // Try to translate
    if (providerUsed === 'Groq') {
      this._updateAction(`🌐 Translating to BM, Hindi, Chinese...`, 'action');
      const transResult = await groqAnalyzer.translateTopic(newTopic);
      if (transResult.success) {
        newTopic.translations = transResult.translations;
      }
    }

    // Store
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
      analysis: 'This topic was analyzed using basic heuristics as no AI API keys are configured. For accurate fact-checking, please configure Groq and/or HuggingFace API keys.',
      party: topic.party || 'PKR',
      category: topic.category || 'General',
      impact: 'medium',
      region: 'National',
      confidence,
      factCheckRef: 'Pending AI verification'
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

  _guessParty(text) {
    const lower = text.toLowerCase();
    for (const [party, keywords] of Object.entries(PARTY_KEYWORDS)) {
      if (keywords.some(keyword => lower.includes(keyword))) return party;
    }
    return 'PKR';
  }

  _guessCategory(text) {
    const lower = text.toLowerCase();
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (keywords.some(keyword => lower.includes(keyword))) return category;
    }
    return 'Governance';
  }

  _scoreToConfidence(score) {
    if (score >= 80) return 'high';
    if (score >= 65) return 'medium';
    return 'low';
  }

  _toTopicFromVerifiedRecord(record, index) {
    const combinedText = `${record.title || ''} ${record.summary || ''}`;
    const party = this._guessParty(combinedText);
    const category = this._guessCategory(combinedText);
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
