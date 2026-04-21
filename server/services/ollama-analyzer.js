// Ollama Analyzer — Local/self-hosted model with caching & optimized settings
// Requires OLLAMA_ENABLED=true and a reachable Ollama server.

import { LRUCache, simpleHash, extractJsonObject } from './shared-constants.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_FALLBACK_MODELS = ['llama3.1:8b', 'qwen2.5:14b', 'mistral:7b'];
const ALLOWED_PARTIES = new Set(['PKR', 'DAP', 'AMANAH', 'UMNO', 'PAS', 'BERSATU', 'GPS', 'MUDA', 'UNSPECIFIED']);
const ALLOWED_BIAS = new Set(['neutral', 'pro_kerajaan', 'pro_pembangkang', 'mixed', 'unclear']);
const ALLOWED_LOADED_LANGUAGE = new Set(['none', 'mild', 'strong']);
const ALLOWED_FALLACY_TYPES = new Set([
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

function parseModelList(raw = '') {
  return String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function defaultBiasAssessment() {
  return {
    overallBias: 'unclear',
    justification: 'Bukti tidak mencukupi untuk menentukan kecenderungan bias dengan yakin.',
    governmentClaimsChecked: false,
    oppositionClaimsChecked: false,
    loadedLanguage: 'none',
  };
}

function normalizeParty(rawParty, fallback = 'UNSPECIFIED') {
  const value = String(rawParty || '').trim().toUpperCase();
  if (!value) return fallback;
  if (ALLOWED_PARTIES.has(value)) return value;
  return fallback;
}

function normalizeBiasAssessment(raw) {
  const base = defaultBiasAssessment();
  const value = raw && typeof raw === 'object' ? raw : {};

  const overallCandidate = String(value.overallBias || value.overall || '').toLowerCase()
    .replace('pro_government', 'pro_kerajaan').replace('anti_government', 'pro_pembangkang');
  const overallBias = ALLOWED_BIAS.has(overallCandidate) ? overallCandidate : base.overallBias;

  const loadedCandidate = String(value.loadedLanguage || '').toLowerCase();
  const loadedLanguage = ALLOWED_LOADED_LANGUAGE.has(loadedCandidate) ? loadedCandidate : base.loadedLanguage;

  return {
    overallBias,
    justification: String(value.justification || '').trim() || base.justification,
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
      if (!ALLOWED_FALLACY_TYPES.has(type)) return null;

      const excerpt = String(item.excerpt || '').trim();
      const explanation = String(item.explanation || '').trim();
      if (!excerpt || !explanation) return null;

      const severityRaw = String(item.severity || '').toLowerCase();
      const confidenceRaw = String(item.confidence || '').toLowerCase();

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

// ── Response cache: avoids re-analyzing identical/similar topics ──
const analysisCache = new LRUCache(200, 30 * 60 * 1000); // 200 entries, 30min TTL
const translationCache = new LRUCache(200, 60 * 60 * 1000); // 200 entries, 1hr TTL

class OllamaAnalyzer {
  constructor() {
    this.enabled = process.env.OLLAMA_ENABLED === 'true';
    this.baseUrl = (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
    this.fallbackModels = parseModelList(process.env.OLLAMA_FALLBACK_MODELS || DEFAULT_FALLBACK_MODELS.join(','));
    this.activeModel = this.model;
    this.availableModels = [];
    this.timeoutMs = Math.max(5000, parseInt(process.env.OLLAMA_TIMEOUT_MS || '30000', 10));
    this.translationTimeoutMs = Math.min(this.timeoutMs, 25000); // Shorter for translations
    this.callCount = 0;
    this.lastReset = Date.now();
    this.lastError = null;
    this._healthy = null; // null = unknown, true/false = last check result
    this._healthCheckAt = 0;
  }

  isAvailable() {
    return this.enabled;
  }

  _checkRateLimit() {
    if (Date.now() - this.lastReset > 60000) {
      this.callCount = 0;
      this.lastReset = Date.now();
    }
    return this.callCount < 30;
  }

  /**
   * Quick health check — ping Ollama every 60s to avoid wasting time
   * on requests when the server is down.
   */
  async _ensureHealthy(forceRefresh = false) {
    if (!forceRefresh && Date.now() - this._healthCheckAt < 60000 && this._healthy !== null) {
      return this._healthy;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        this._healthy = false;
        return this._healthy;
      }

      const data = await res.json();
      const modelNames = Array.isArray(data?.models)
        ? data.models.map((model) => String(model?.name || '').trim()).filter(Boolean)
        : [];

      this.availableModels = modelNames;
      if (modelNames.length === 0) {
        this.lastError = 'Ollama reachable but no local models installed';
        this._healthy = false;
        return this._healthy;
      }

      const preferred = [this.model, ...this.fallbackModels];
      const selected = preferred.find((name) => modelNames.includes(name)) || modelNames[0];
      this.activeModel = selected;
      this.lastError = null;
      this._healthy = true;
    } catch {
      this._healthy = false;
    }

    this._healthCheckAt = Date.now();
    return this._healthy;
  }

  async _call(messages, { timeoutMs = this.timeoutMs, numPredict = 800, retried = false } = {}) {
    if (!this.isAvailable()) {
      throw new Error('Ollama is disabled');
    }
    if (!this._checkRateLimit()) {
      throw new Error('Ollama local throttle (30 req/min)');
    }

    // Health gate — skip if Ollama was recently unreachable
    const healthy = await this._ensureHealthy();
    if (!healthy) {
      throw new Error('Ollama server unreachable (health check failed)');
    }

    this.callCount += 1;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'keep-alive',
        },
        body: JSON.stringify({
          model: this.activeModel || this.model,
          messages,
          stream: false,
          format: 'json',
          options: {
            temperature: 0.15,      // Lower = faster + more deterministic
            num_predict: numPredict, // Cap max tokens to prevent runaway generation
            top_p: 0.9,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.text();

        if (!retried && response.status === 404 && /model\s+["'][^"']+["']\s+not found/i.test(err)) {
          // Refresh installed models and retry once with a valid local model.
          const healthyAfterRefresh = await this._ensureHealthy(true);
          if (healthyAfterRefresh) {
            return this._call(messages, { timeoutMs, numPredict, retried: true });
          }
        }

        throw new Error(`Ollama API ${response.status}: ${err}`);
      }

      const data = await response.json();
      const content = data?.message?.content || '';
      return String(content || '').trim();
    } finally {
      clearTimeout(timeout);
    }
  }

  async analyzeTopic(topic) {
    // ── Cache check ──
    const cacheKey = `analyze:${simpleHash((topic.title || '').toLowerCase())}`;
    const cached = analysisCache.get(cacheKey);
    if (cached) {
      console.log(`[Ollama] Cache hit for: "${topic.title}"`);
      return cached;
    }

    const systemPrompt = `You are SentinelTruth, a Malaysian political fact-checking assistant.
  Return strict JSON only and avoid fabricated certainty.
  If evidence is weak, use verdict UNVERIFIED.
  Do not show institutional deference. Apply equal skepticism to government and opposition claims.
  If no logical fallacy is present, return an empty array for logicalFallacies.`;

    const userPrompt = `Analyze this Malaysian political topic and return JSON.

Title: ${topic.title}
Summary: ${topic.snippet || ''}
Party hint: ${topic.party || 'Unknown'}
Category hint: ${topic.category || 'General'}

Return EXACT JSON fields:
{
  "verdict": "TRUE|HOAX|MISLEADING|PARTIALLY_TRUE|UNVERIFIED",
  "summary": "2-3 concise sentences",
  "analysis": "3-5 concise sentences with reasoning",
  "party": "PKR|DAP|AMANAH|UMNO|PAS|BERSATU|GPS|MUDA|UNSPECIFIED",
  "category": "string",
  "impact": "high|medium|low",
  "region": "string",
  "factCheckRef": "string",
  "confidence": "high|medium|low",
  "biasAssessment": {
    "overallBias": "neutral|pro_kerajaan|pro_pembangkang|mixed|unclear",
    "justification": "string",
    "governmentClaimsChecked": "boolean",
    "oppositionClaimsChecked": "boolean",
    "loadedLanguage": "none|mild|strong"
  },
  "logicalFallacies": [
    {
      "type": "ad_hominem|straw_man|false_dilemma|hasty_generalization|slippery_slope|false_cause|cherry_picking|whataboutism|appeal_to_authority|appeal_to_fear",
      "excerpt": "string",
      "explanation": "string",
      "severity": "low|medium|high",
      "confidence": "low|medium|high"
    }
  ]
}`;

    try {
      const raw = await this._call(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { numPredict: 800 }
      );

      const parsed = extractJsonObject(raw);
      if (!parsed) {
        this.lastError = 'Ollama returned non-JSON output';
        return { success: false, error: this.lastError };
      }

      this.lastError = null;
      const result = {
        success: true,
        verdict: parsed.verdict,
        summary: parsed.summary,
        analysis: parsed.analysis,
        party: normalizeParty(parsed.party, normalizeParty(topic.party, 'UNSPECIFIED')),
        category: parsed.category,
        impact: parsed.impact,
        region: parsed.region,
        factCheckRef: parsed.factCheckRef,
        confidence: parsed.confidence,
        biasAssessment: normalizeBiasAssessment(parsed.biasAssessment),
        logicalFallacies: normalizeLogicalFallacies(parsed.logicalFallacies),
      };

      // ── Cache the result ──
      analysisCache.set(cacheKey, result);
      return result;
    } catch (error) {
      this.lastError = error.message;
      return { success: false, error: error.message };
    }
  }

  async translateTopic(topic) {
    const { title, summary, analysis } = topic;

    // ── Cache check ──
    const cacheKey = `trans:${simpleHash((title || '').toLowerCase())}`;
    const cached = translationCache.get(cacheKey);
    if (cached) {
      console.log(`[Ollama] Translation cache hit for: "${title}"`);
      return cached;
    }

    const systemPrompt = 'You are a professional multilingual translator for Malaysian political content. Return strict JSON only.';
    const userPrompt = `Translate the following content into Bahasa Melayu (ms), Hindi (hi), and Simplified Chinese (zh).
Keep political party names (PKR, DAP, UMNO, PAS, BERSATU, AMANAH, GPS, MUDA) unchanged.

Title: ${title || ''}
Summary: ${summary || ''}
Analysis: ${analysis || ''}

Return EXACT JSON:
{
  "ms": { "title": "...", "summary": "...", "analysis": "..." },
  "hi": { "title": "...", "summary": "...", "analysis": "..." },
  "zh": { "title": "...", "summary": "...", "analysis": "..." }
}`;

    try {
      const raw = await this._call(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { timeoutMs: this.translationTimeoutMs, numPredict: 1200 }
      );

      const parsed = extractJsonObject(raw);
      if (!parsed || !parsed.ms || !parsed.hi || !parsed.zh) {
        this.lastError = 'Ollama translation JSON invalid';
        return { success: false, error: this.lastError };
      }

      this.lastError = null;
      const result = { success: true, translations: parsed };

      // ── Cache the result ──
      translationCache.set(cacheKey, result);
      return result;
    } catch (error) {
      this.lastError = error.message;
      return { success: false, error: error.message };
    }
  }

  getUsage() {
    return {
      provider: 'Ollama',
      available: this.isAvailable(),
      model: this.activeModel || this.model,
      configuredModel: this.model,
      availableModels: this.availableModels,
      baseUrl: this.baseUrl,
      callsThisMinute: this.callCount,
      maxPerMinute: 30,
      lastError: this.lastError,
      cacheSize: analysisCache.size + translationCache.size,
      healthy: this._healthy,
    };
  }
}

export const ollamaAnalyzer = new OllamaAnalyzer();
