// AI Agent — Server-side continuous analysis pipeline
// Searches → Analyzes → Translates (deferred) → Stores → Broadcasts
// Optimized: deferred translation cycle, parallel batch translation, shared constants

import { groqAnalyzer } from './groq-analyzer.js';
import { dataManager } from './data-manager.js';
import { sourceCollector } from './source-collector.js';
import {
  PARTY_KEYWORDS,
  CATEGORY_KEYWORDS,
  isMalaysiaNationalIssueContent,
  guessParty,
  guessCategory,
  guessSourceLeaning,
} from './shared-constants.js';

const KNOWN_FALLACY_TYPES = new Set([
  'ad_hominem',
  'straw_man',
  'false_dilemma',
  'hasty_generalization',
  'slippery_slope',
  'false_cause',
  'cherry_picking',
  'whataboutism',
  'appeal_to_authority',
  'appeal_to_fear',
]);

function defaultBiasAssessment() {
  return {
    overallBias: 'unclear',
    justification: 'Bukti tidak mencukupi untuk menentukan kecenderungan bias dengan yakin.',
    governmentClaimsChecked: false,
    oppositionClaimsChecked: false,
    loadedLanguage: 'none',
  };
}

// Map old English bias values to new Malay-first values for backward compat
const BIAS_COMPAT_MAP = {
  pro_government: 'pro_kerajaan',
  anti_government: 'pro_pembangkang',
};

function normalizeBiasAssessment(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  let candidateOverall = String(value.overallBias || value.overall || '').toLowerCase();
  // Map old values to new
  if (BIAS_COMPAT_MAP[candidateOverall]) candidateOverall = BIAS_COMPAT_MAP[candidateOverall];
  const overallBias = ['neutral', 'pro_kerajaan', 'pro_pembangkang', 'mixed', 'unclear'].includes(candidateOverall)
    ? candidateOverall
    : 'unclear';

  const loadedLanguageRaw = String(value.loadedLanguage || '').toLowerCase();
  const loadedLanguage = ['none', 'mild', 'strong'].includes(loadedLanguageRaw)
    ? loadedLanguageRaw
    : 'none';

  const justification = String(value.justification || '').trim()
    || defaultBiasAssessment().justification;

  return {
    overallBias,
    justification,
    governmentClaimsChecked: Boolean(value.governmentClaimsChecked),
    oppositionClaimsChecked: Boolean(value.oppositionClaimsChecked),
    loadedLanguage,
  };
}

function normalizeLogicalFallacies(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;

      const type = String(item.type || '').trim().toLowerCase().replace(/\s+/g, '_');
      if (!KNOWN_FALLACY_TYPES.has(type)) return null;

      const severityRaw = String(item.severity || '').toLowerCase();
      const confidenceRaw = String(item.confidence || '').toLowerCase();

      const excerpt = String(item.excerpt || '').trim();
      const explanation = String(item.explanation || '').trim();
      if (!excerpt || !explanation) return null;

      return {
        type,
        excerpt,
        explanation,
        severity: ['low', 'medium', 'high'].includes(severityRaw) ? severityRaw : 'low',
        confidence: ['low', 'medium', 'high'].includes(confidenceRaw) ? confidenceRaw : 'low',
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

const DETERMINISTIC_FALLACY_PATTERNS = [
  {
    type: 'ad_hominem',
    regex: /\b(idiot|stupid|traitor|pengkhianat|bodoh|pengkhianat bangsa)\b/i,
    explanation: 'The claim attacks a person or group rather than addressing the argument itself.',
  },
  {
    type: 'false_dilemma',
    regex: /\b(either\s+[^.]{0,80}\s+or\s+[^.]{0,80}|hanya\s+dua\s+pilihan|only\s+two\s+choices)\b/i,
    explanation: 'The claim frames a complex issue as if only two choices exist.',
  },
  {
    type: 'slippery_slope',
    regex: /\b(if\s+[^.]{0,80}\s+then\s+[^.]{0,80}\b(collapse|destroy|ruin|hancur)|will\s+inevitably|pasti\s+akan)\b/i,
    explanation: 'The claim asserts an inevitable extreme outcome without sufficient causal support.',
  },
  {
    type: 'hasty_generalization',
    regex: /\b(all\s+politicians|everyone\s+knows|semua\s+ahli\s+politik|semua\s+orang\s+tahu)\b/i,
    explanation: 'The claim generalizes broadly from limited or unspecified evidence.',
  },
  {
    type: 'whataboutism',
    regex: /\b(what\s+about|bagaimana\s+pula|tapi\s+pihak\s+lain|but\s+the\s+other\s+side)\b/i,
    explanation: 'The claim deflects criticism by shifting attention to a different issue.',
  },
  {
    type: 'appeal_to_fear',
    regex: /\b(if\s+we\s+do\s+not\s+[^.]{0,80}\b(chaos|disaster|doom)|negara\s+akan\s+hancur)\b/i,
    explanation: 'The claim relies on fear-triggering outcomes instead of proportional evidence.',
  },
  {
    type: 'appeal_to_authority',
    regex: /\b(experts\s+say|pakar\s+kata|because\s+\w+\s+said\s+so)\b/i,
    explanation: 'The claim depends on authority assertion without presenting verifiable support.',
  },
];

const STRONG_LOADED_LANGUAGE_PATTERNS = [
  /\b(regime|dictator|pengkhianat|pengkhianat\s+bangsa|propaganda\s+murahan|hancur\s+total)\b/i,
  /\b(corrupt\s+government|incompetent\s+government|kerajaan\s+gagal\s+total)\b/i,
];

const MILD_LOADED_LANGUAGE_PATTERNS = [
  /\b(failed|disaster|catastrophic|spin\s+story|agenda\s+tersembunyi|berat\s+sebelah)\b/i,
];

const PRO_GOVERNMENT_FRAMING_PATTERNS = [
  /\b(government\s+proved|government\s+clearly\s+right|institutional\s+independence\s+proven)\b/i,
  /\b(kerajaan\s+jelas\s+betul|kejayaan\s+mutlak\s+kerajaan|kerajaan\s+berjaya)\b/i,
];

const ANTI_GOVERNMENT_FRAMING_PATTERNS = [
  /\b(government\s+is\s+the\s+sole\s+cause|government\s+alone\s+to\s+blame)\b/i,
  /\b(kerajaan\s+satu-satunya\s+punca|semua\s+salah\s+kerajaan|kerajaan\s+gagal)\b/i,
];

const GOVERNMENT_SIGNAL_TERMS = [
  'government', 'kerajaan', 'cabinet', 'minister', 'prime minister', 'pm', 'federal',
];

const OPPOSITION_SIGNAL_TERMS = [
  'opposition', 'pembangkang', 'perikatan nasional', 'pn', 'pas', 'bersatu', 'umno', 'muda',
];

function detectDeterministicFallacies(text = '') {
  const fallacies = [];

  for (const pattern of DETERMINISTIC_FALLACY_PATTERNS) {
    const match = text.match(pattern.regex);
    if (!match) continue;

    fallacies.push({
      type: pattern.type,
      excerpt: String(match[0] || '').trim(),
      explanation: pattern.explanation,
      severity: 'low',
      confidence: 'medium',
    });

    if (fallacies.length >= 3) break;
  }

  return fallacies;
}

function mergeLogicalFallacies(primary = [], secondary = []) {
  const merged = [];
  const seen = new Set();

  for (const item of [...primary, ...secondary]) {
    const type = String(item?.type || '').trim();
    const excerpt = String(item?.excerpt || '').trim().toLowerCase();
    if (!type || !excerpt) continue;

    const key = `${type}:${excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);

    if (merged.length >= 5) break;
  }

  return merged;
}

function applyDeterministicGuardrails(topic = {}, rawResult = {}) {
  const base = rawResult && typeof rawResult === 'object' ? { ...rawResult } : {};
  const title = String(topic.title || '').trim();
  const snippet = String(topic.snippet || topic.summary || '').trim();
  const analysis = String(base.analysis || '').trim();
  const combinedText = `${title} ${snippet} ${analysis}`.trim();
  const lowerCombined = combinedText.toLowerCase();

  const biasAssessment = normalizeBiasAssessment(base.biasAssessment);

  const hasGovSignal = GOVERNMENT_SIGNAL_TERMS.some((term) => lowerCombined.includes(term));
  const hasOppositionSignal = OPPOSITION_SIGNAL_TERMS.some((term) => lowerCombined.includes(term));

  biasAssessment.governmentClaimsChecked = biasAssessment.governmentClaimsChecked || hasGovSignal;
  biasAssessment.oppositionClaimsChecked = biasAssessment.oppositionClaimsChecked || hasOppositionSignal;

  if (biasAssessment.loadedLanguage === 'none') {
    if (STRONG_LOADED_LANGUAGE_PATTERNS.some((regex) => regex.test(combinedText))) {
      biasAssessment.loadedLanguage = 'strong';
    } else if (MILD_LOADED_LANGUAGE_PATTERNS.some((regex) => regex.test(combinedText))) {
      biasAssessment.loadedLanguage = 'mild';
    }
  }

  if (biasAssessment.overallBias === 'unclear') {
    if (PRO_GOVERNMENT_FRAMING_PATTERNS.some((regex) => regex.test(combinedText))) {
      biasAssessment.overallBias = 'pro_kerajaan';
    } else if (ANTI_GOVERNMENT_FRAMING_PATTERNS.some((regex) => regex.test(combinedText))) {
      biasAssessment.overallBias = 'pro_pembangkang';
    }
  }

  if (
    biasAssessment.justification === defaultBiasAssessment().justification
    && biasAssessment.loadedLanguage !== 'none'
  ) {
    biasAssessment.justification = 'Loaded framing cues were detected, so this claim should be interpreted with caution.';
  }

  const modelFallacies = normalizeLogicalFallacies(base.logicalFallacies);
  const deterministicFallacies = detectDeterministicFallacies(`${title} ${snippet}`);

  return {
    ...base,
    biasAssessment,
    logicalFallacies: mergeLogicalFallacies(modelFallacies, deterministicFallacies),
  };
}

class AIAgent {
  constructor() {
    this.status = 'idle'; // idle, running, paused
    this._searchInterval = null;
    this._analyzeInterval = null;
    this._translateInterval = null; // NEW: separate translation cycle
    this._reverifyInterval = null;
    this._analyzeKickTimer = null;
    this._analyzeInFlight = false;
    this._translateInFlight = false;
    this._reverifyInFlight = false;
    this._queue = [];
    this._topicsAnalyzed = 0;
    this._currentAction = 'Agent idle';
    this._sseClients = new Set();
    this.allowSimulatedData = process.env.ALLOW_SIMULATED_DATA === 'true';
    this.providerMode = String(process.env.AI_PROVIDER_MODE || 'groq-only').trim().toLowerCase();

    // Intervals from env or defaults
    this.searchIntervalMs = parseInt(process.env.SEARCH_INTERVAL_MS || '1800000'); // 30 min
    this.analyzeIntervalMs = parseInt(process.env.ANALYZE_INTERVAL_MS || '30000'); // 30 sec
    this.translateIntervalMs = 60000; // Translation cycle: every 60s
    this.translateBatchSize = 3; // Parallel translations per cycle
    this.analyzeBatchSize = Math.max(1, parseInt(process.env.ANALYZE_BATCH_SIZE || '1', 10));
    this.searchQueueBatchSize = Math.max(1, parseInt(process.env.SEARCH_QUEUE_BATCH_SIZE || '1', 10));
    const configuredSearchFetchTarget = parseInt(process.env.SEARCH_FETCH_TARGET || '300', 10);
    const safeSearchFetchTarget = Number.isFinite(configuredSearchFetchTarget) ? configuredSearchFetchTarget : 300;
    this.searchFetchTarget = Math.max(this.searchQueueBatchSize * 20, Math.min(safeSearchFetchTarget, 5000));
    this.reverifyEnabled = process.env.REVERIFY_ENABLED !== 'false';
    this.reverifyIntervalMs = Math.max(10000, parseInt(process.env.REVERIFY_INTERVAL_MS || '45000', 10));
    this.reverifyBatchSize = Math.max(1, parseInt(process.env.REVERIFY_BATCH_SIZE || '1', 10));
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
    this._updateAction(`⚡ Parallel pipeline active: feed discovery + Groq key-pool analysis (batch ${this.analyzeBatchSize}) + deferred translation + reverify queue`, 'system');
    this._broadcast('status', this.getStatus());

    // Start search cycle
    this._doSearch();
    this._searchInterval = setInterval(() => this._doSearch(), this.searchIntervalMs);

    // Start analyze cycle
    this._analyzeInterval = setInterval(() => this._doAnalyze(), this.analyzeIntervalMs);

    // Start deferred translation cycle (NEW)
    this._translateInterval = setInterval(() => this._doTranslate(), this.translateIntervalMs);

    // Start re-verify cycle for old UNVERIFIED topics
    if (this.reverifyEnabled) {
      this._reverifyInterval = setInterval(() => this._doReverify(), this.reverifyIntervalMs);
      this._doReverify();
    }

    // Run first analyze quickly
    this._scheduleAnalyzeSoon(5000);
  }

  pause() {
    if (this.status !== 'running') return;
    this.status = 'paused';
    clearInterval(this._searchInterval);
    clearInterval(this._analyzeInterval);
    clearInterval(this._translateInterval);
    clearInterval(this._reverifyInterval);
    clearTimeout(this._analyzeKickTimer);
    this._analyzeKickTimer = null;
    this._searchInterval = null;
    this._analyzeInterval = null;
    this._translateInterval = null;
    this._reverifyInterval = null;
    this._updateAction('⏸️ AI Agent paused', 'system');
    this._broadcast('status', this.getStatus());
  }

  stop() {
    this.status = 'idle';
    clearInterval(this._searchInterval);
    clearInterval(this._analyzeInterval);
    clearInterval(this._translateInterval);
    clearInterval(this._reverifyInterval);
    clearTimeout(this._analyzeKickTimer);
    this._analyzeKickTimer = null;
    this._searchInterval = null;
    this._analyzeInterval = null;
    this._translateInterval = null;
    this._reverifyInterval = null;
    this._updateAction('⏹️ AI Agent stopped', 'system');
    this._broadcast('status', this.getStatus());
  }

  getStatus() {
    return {
      status: this.status,
      currentAction: this._currentAction,
      topicsAnalyzed: this._topicsAnalyzed,
      queueLength: this._queue.length,
      reverifyEnabled: this.reverifyEnabled,
      providers: {
        groq: groqAnalyzer.getUsage(),
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

    this._updateAction('🔍 Searching for new Malaysian national issue topics via RSS/Google News feeds...', 'action');

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

    let sources = record.evidence ? [...record.evidence] : [];
    if (sources.length === 0 && record.url) {
      sources.push({ name: record.sourceName || 'Source', url: record.url, domain: record.sourceDomain || 'news.google.com', type: 'article' });
    }

    return {
      title: record.title,
      snippet: record.summary || record.title,
      party: guessParty(combined),
      category: guessCategory(combined),
      sourceUrl: record.url,
      sourceName: record.sourceName || 'Source',
      sourceType: record.sourceType || 'internet',
      recordType: 'ai',
      sources,
      verification: {
        status: 'UNKNOWN',
        score: 0,
        method: 'feed_fallback',
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  _isMalaysiaNationalIssueTopic(topic = {}) {
    return isMalaysiaNationalIssueContent(topic.title, topic.snippet || topic.summary);
  }

  async _fallbackSearchFromFeeds(reason = 'Feed discovery') {
    this._updateAction(`🛰️ ${reason} — collecting topics from RSS/Google News feeds...`, 'action');

    const fallbackResult = await sourceCollector.collect({
      targetCount: this.searchFetchTarget,
      includeInternet: true,
      includeFacebook: false,
    });

    if (!fallbackResult.success || fallbackResult.records.length === 0) {
      this._updateAction('⚠️ Feed collection returned no records', 'system');
      return 0;
    }

    let queued = 0;
    for (const record of fallbackResult.records) {
      const topic = this._mapCollectedRecordToQueuedTopic(record);
      if (!this._isMalaysiaNationalIssueTopic(topic)) {
        continue;
      }
      if (!this._isTopicAlreadyQueued(topic)) {
        this._queue.push(topic);
        queued++;
        if (queued >= this.searchQueueBatchSize) break;
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

    // Groq-only analysis pipeline (with internal multi-key failover).
    let analysisResult;
    let providerUsed = 'Heuristic';

    if (groqAnalyzer.isAvailable()) {
      this._updateAction('🤖 Using Groq key-pool pipeline for analysis...', 'action');
      analysisResult = await groqAnalyzer.analyzeTopic(topic);
      if (analysisResult?.success) providerUsed = 'Groq';
    }

    if (!analysisResult?.success) {
      // AI provider unavailable/rate-limited — use heuristic fallback
      this._updateAction(`⚡ Using heuristic analysis due provider limits/unavailability`, 'action');
      analysisResult = this._heuristicAnalysis(topic);
      providerUsed = 'Heuristic';
    }

    analysisResult = applyDeterministicGuardrails(topic, analysisResult);

    const topicSources = Array.isArray(topic.sources)
      ? topic.sources
      : (topic.sourceUrl ? [{ name: topic.sourceName || 'Source', url: topic.sourceUrl }] : []);

    // Detect source domain political leaning
    const primaryDomain = topicSources[0]?.domain || '';
    const sourceLeaning = guessSourceLeaning(primaryDomain);

    // Build the full topic object (NO translation here — deferred to translation cycle)
    const score = analysisResult?.confidence === 'high' ? 95 : analysisResult?.confidence === 'medium' ? 75 : 55;
    const biasAssessment = normalizeBiasAssessment(analysisResult?.biasAssessment);
    const logicalFallacies = normalizeLogicalFallacies(analysisResult?.logicalFallacies);
    
    const newTopic = {
      id: `st-ai-${Date.now()}`,
      title: topic.title,
      summary: analysisResult.summary || topic.snippet || topic.title,
      category: analysisResult.category || topic.category || 'General',
      party: analysisResult.party || topic.party || 'UNSPECIFIED',
      verdict: analysisResult.verdict || 'UNVERIFIED',
      date: new Date().toISOString().split('T')[0],
      sources: topicSources,
      analysis: analysisResult.analysis || 'Analysis pending.',
      biasAssessment,
      logicalFallacies,
      sourceLeaning: {
        leaning: sourceLeaning.leaning,
        owner: sourceLeaning.owner,
        note: sourceLeaning.note,
        domain: primaryDomain,
      },
      connections: [],
      impact: analysisResult.impact || 'medium',
      region: analysisResult.region || 'National',
      factCheckRef: analysisResult.factCheckRef || 'AI Analysis',
      confidence: analysisResult.confidence || 'medium',
      translations: {}, // Will be filled by deferred translation cycle
      aiProvider: providerUsed,
      sourceType: topic.sourceType || 'internet',
      recordType: topic.recordType || 'ai',
      verification: {
        status: analysisResult?.success ? 'VERIFIED' : 'UNKNOWN',
        score: analysisResult?.success ? score : 0,
        method: providerUsed === 'Groq' ? 'groq_llama_3_3' : 'ai_pipeline',
        checks: {
          hasTitle: !!topic.title,
          hasSummary: !!(analysisResult.summary || topic.snippet || topic.title),
          hasUrl: !!(topic.sourceUrl || topicSources.length > 0),
          hasPublishedAt: true,
          sourceTrusted: false, // Wait for source verifier
          multiSourceSupport: topicSources.length > 1,
          hasSuspiciousSignal: analysisResult.verdict === 'HOAX'
        },
        reasons: [],
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
    return stored || null;
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
      analysis: 'This topic was analyzed using basic heuristics because Groq keys were unavailable or rate-limited. Configure Groq key pipeline for stronger fact-checking.',
      party: topic.party || 'UNSPECIFIED',
      category: topic.category || 'General',
      impact: 'medium',
      region: 'National',
      confidence,
      factCheckRef: 'Pending AI verification',
      biasAssessment: defaultBiasAssessment(),
      logicalFallacies: [],
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

    // Groq-only translation provider
    if (!groqAnalyzer.isAvailable()) return;

    const candidates = dataManager
      .getAllTopics()
      .filter((topic) => !this._hasCompleteTranslations(topic))
      .slice(0, this.translateBatchSize);

    if (candidates.length === 0) return;

    this._translateInFlight = true;
    try {

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

      // Silent background translation to avoid noisy UI logs.
    } finally {
      this._translateInFlight = false;
    }
  }

  async _translateTopicWithProviders(topic, { emitLog = true } = {}) {
    if (emitLog) {
      this._updateAction('🌐 Translating with Groq key-pool...', 'action');
    }

    if (groqAnalyzer.isAvailable()) {
      const viaGroq = await groqAnalyzer.translateTopic(topic);
      if (viaGroq?.success) return viaGroq;
    }

    return { success: false, error: 'No translation provider available' };
  }

  async backfillTranslations({ limit = 60 } = {}) {
    const maxItems = Math.max(1, Math.min(parseInt(limit, 10) || 60, 300));

    if (!groqAnalyzer.isAvailable()) {
      return {
        success: false,
        error: 'No translation provider available. Configure Groq key pipeline.',
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

  _getReverifyCandidates(limit = 1) {
    const maxItems = Math.max(1, Number(limit) || 1);

    return dataManager
      .getAllTopics()
      .filter((topic) => {
        if (!topic || topic.verdict !== 'UNVERIFIED') return false;
        // Re-verify historical non-Groq topics once; Groq-analyzed topics are treated as final.
        return topic.aiProvider !== 'Groq';
      })
      .sort((a, b) => {
        const aTime = Date.parse(a?.date || '');
        const bTime = Date.parse(b?.date || '');
        const aSafe = Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER;
        const bSafe = Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER;
        if (aSafe !== bSafe) return aSafe - bSafe;
        return String(a?.id || '').localeCompare(String(b?.id || ''));
      })
      .slice(0, maxItems);
  }

  async _doReverify() {
    if (!this.reverifyEnabled || this.status !== 'running' || this._reverifyInFlight) return;
    if (!groqAnalyzer.isAvailable()) return;

    const candidates = this._getReverifyCandidates(this.reverifyBatchSize);
    if (candidates.length === 0) return;

    this._reverifyInFlight = true;
    try {
      for (const topic of candidates) {
        const input = {
          title: topic.title,
          snippet: topic.summary || topic.title,
          party: topic.party,
          category: topic.category,
          sources: topic.sources,
        };

        const analyzed = await groqAnalyzer.analyzeTopic(input);
        if (!analyzed?.success) continue;

        const guarded = applyDeterministicGuardrails(input, analyzed);

        const saved = dataManager.updateTopic(topic.id, {
          summary: guarded.summary || topic.summary,
          analysis: guarded.analysis || topic.analysis,
          verdict: guarded.verdict || topic.verdict,
          party: guarded.party || topic.party || 'UNSPECIFIED',
          category: guarded.category || topic.category,
          impact: guarded.impact || topic.impact,
          region: guarded.region || topic.region,
          factCheckRef: guarded.factCheckRef || topic.factCheckRef,
          confidence: guarded.confidence || topic.confidence,
          biasAssessment: normalizeBiasAssessment(guarded.biasAssessment || topic.biasAssessment),
          logicalFallacies: normalizeLogicalFallacies(guarded.logicalFallacies || topic.logicalFallacies),
          aiProvider: 'Groq',
          verification: {
            ...(topic.verification || {}),
            method: 'reverify_groq',
            reverifiedAt: new Date().toISOString(),
          },
        });

        if (saved) {
          this._topicsAnalyzed++;
          this._updateAction(`🔁 Re-verified: "${saved.title}" → ${saved.verdict}`, 'action');
          this._broadcast('status', this.getStatus());
        }
      }
    } finally {
      this._reverifyInFlight = false;
    }
  }

  async ingestRealArticles({ targetCount = 1000, includeInternet = true, includeFacebook = true } = {}) {
    const safeTarget = Math.max(1, Math.min(parseInt(targetCount, 10) || 1000, 5000));

    this._updateAction(`📦 Bulk ingestion started (target ${safeTarget})`, 'system');

    const collected = await sourceCollector.collect({
      targetCount: safeTarget,
      includeInternet: includeInternet !== false,
      includeFacebook: includeFacebook !== false,
    });

    if (!collected?.success) {
      const error = collected?.error || 'Source collection failed';
      this._updateAction(`❌ Bulk ingestion failed: ${error}`, 'system');
      return { success: false, error };
    }

    const candidates = [];
    const seenBatch = new Set();

    for (const record of collected.records || []) {
      const topic = this._mapCollectedRecordToQueuedTopic(record);
      if (!this._isMalaysiaNationalIssueTopic(topic)) continue;

      const urlKey = String(topic.sourceUrl || topic.url || topic.sources?.[0]?.url || '').toLowerCase().trim();
      const titleKey = String(topic.title || '').toLowerCase().trim();
      const batchKey = urlKey || `title:${titleKey}`;

      if (batchKey && seenBatch.has(batchKey)) continue;
      seenBatch.add(batchKey);

      if (dataManager.isDuplicateTopic(topic)) continue;

      candidates.push(topic);
      if (candidates.length >= safeTarget) break;
    }

    if (candidates.length === 0) {
      this._updateAction('ℹ️ Bulk ingestion found no new unique topics to analyze', 'system');
      return {
        success: true,
        report: {
          targetCount: safeTarget,
          collectedCount: collected.collectedCount || 0,
          dedupedCount: collected.dedupedCount || 0,
          candidates: 0,
          analyzed: 0,
          added: 0,
          skipped: 0,
          failed: 0,
          providers: { Groq: 0, Heuristic: 0 },
          errors: collected.errors || [],
        },
      };
    }

    let analyzed = 0;
    let added = 0;
    let skipped = 0;
    let failed = 0;
    const providers = { Groq: 0, Heuristic: 0 };

    for (const topic of candidates) {
      try {
        const stored = await this._analyzeTopic(topic);
        analyzed++;

        if (stored) {
          added++;
          if (stored.aiProvider === 'Groq') {
            providers.Groq++;
          } else {
            providers.Heuristic++;
          }
        } else {
          skipped++;
        }
      } catch (error) {
        failed++;
        this._updateAction(`⚠️ Bulk ingestion topic failed: ${error.message}`, 'system');
      }
    }

    this._updateAction(`✅ Bulk ingestion completed: added ${added}/${analyzed} topics`, 'system');

    return {
      success: true,
      report: {
        targetCount: safeTarget,
        collectedCount: collected.collectedCount || 0,
        malaysiaNationalIssueCount: collected.malaysiaNationalIssueCount || 0,
        dedupedCount: collected.dedupedCount || 0,
        candidates: candidates.length,
        analyzed,
        added,
        skipped,
        failed,
        providers,
        errors: collected.errors || [],
      },
    };
  }

  _isTopicAlreadyQueued(topic) {
    const incomingTitle = (topic.title || '').toLowerCase();
    const incomingUrl = (topic.sourceUrl || topic.url || topic.sources?.[0]?.url || '').toLowerCase();

    const queued = this._queue.some(queued => {
      const queuedTitle = (queued.title || '').toLowerCase();
      const queuedUrl = (queued.sourceUrl || queued.url || queued.sources?.[0]?.url || '').toLowerCase();
      if (incomingUrl && queuedUrl && incomingUrl === queuedUrl) return true;
      return incomingTitle && queuedTitle && incomingTitle === queuedTitle;
    });
    
    if (queued) return true;
    return !!dataManager.isDuplicateTopic(topic);
  }
}

export const aiAgent = new AIAgent();
