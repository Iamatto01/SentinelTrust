// Groq Analyzer — Uses Llama 3.3 70B for fact-checking and translation
// Free tier: ~1000 req/day, no credit card
// Optimized: response caching, reduced token limits

import { LRUCache, simpleHash } from './shared-constants.js';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
const GROQ_KEY_ENV_ORDER = ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4', 'GROQ_API_KEY_5'];

function parseKeyList(raw = '') {
  return String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildGroqKeyStates() {
  const orderedFromEnv = GROQ_KEY_ENV_ORDER
    .map((envName) => String(process.env[envName] || '').trim())
    .filter(Boolean);

  const appendedKeys = parseKeyList(process.env.GROQ_API_KEYS || '');
  const uniqueKeys = [...new Set([...orderedFromEnv, ...appendedKeys])];

  return uniqueKeys.map((apiKey, index) => ({
    slot: index + 1,
    apiKey,
    callCount: 0,
    lastReset: Date.now(),
    cooldownByModel: {},
    lastError: null,
    disabled: false,
  }));
}

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

// ── Response caches ──
const analysisCache = new LRUCache(200, 30 * 60 * 1000); // 30min TTL
const translationCache = new LRUCache(200, 60 * 60 * 1000); // 1hr TTL

class GroqAnalyzer {
  constructor() {
    this.keyStates = buildGroqKeyStates();
    this.primaryModel = String(process.env.GROQ_PRIMARY_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
    this.fallbackModel = String(process.env.GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant').trim();
    this.model = this.primaryModel;
    this.analysisMaxTokens = Math.max(200, parseInt(process.env.GROQ_ANALYZE_MAX_TOKENS || '450', 10));
    this.translationMaxTokens = Math.max(300, parseInt(process.env.GROQ_TRANSLATE_MAX_TOKENS || '900', 10));
    this.maxPerMinutePerKey = Math.max(1, parseInt(process.env.GROQ_MAX_PER_MINUTE || '25', 10));
    this.lastUsedSlot = null;
    this.lastUsedModel = null;
    this.lastError = null;
  }

  isAvailable() {
    return this.keyStates.some((state) => state.apiKey && !state.disabled);
  }

  _checkRateLimit(keyState) {
    if (Date.now() - keyState.lastReset > 60000) {
      keyState.callCount = 0;
      keyState.lastReset = Date.now();
    }
    return keyState.callCount < this.maxPerMinutePerKey;
  }

  _buildModelSequence(preferredModel = this.primaryModel) {
    const models = [];
    const primary = String(preferredModel || this.primaryModel || '').trim();
    const fallback = String(this.fallbackModel || '').trim();

    if (primary) models.push(primary);
    if (fallback && fallback !== primary) models.push(fallback);

    return models;
  }

  _getModelCooldownRemainingMs(keyState, model) {
    const until = Number(keyState?.cooldownByModel?.[model] || 0);
    return until - Date.now();
  }

  _setModelCooldown(keyState, model, retryAfterMs) {
    if (!keyState.cooldownByModel || typeof keyState.cooldownByModel !== 'object') {
      keyState.cooldownByModel = {};
    }
    keyState.cooldownByModel[model] = Date.now() + retryAfterMs;
  }

  _clearModelCooldown(keyState, model) {
    if (!keyState.cooldownByModel || typeof keyState.cooldownByModel !== 'object') {
      keyState.cooldownByModel = {};
    }
    keyState.cooldownByModel[model] = 0;
  }

  _extractRetryAfterMs(errorText = '') {
    try {
      const parsed = JSON.parse(errorText);
      const retryAfter = parsed?.error?.message?.match(/try again in\s+([0-9]+(?:\.[0-9]+)?)s/i);
      if (retryAfter) {
        const seconds = parseFloat(retryAfter[1]);
        if (Number.isFinite(seconds) && seconds > 0) {
          return Math.max(1000, Math.ceil(seconds * 1000));
        }
      }
    } catch {
      // Ignore parse errors and fall back to regex/default.
    }

    const retryMatch = errorText.match(/try again in\s+([0-9]+(?:\.[0-9]+)?)s/i);
    if (retryMatch) {
      const seconds = parseFloat(retryMatch[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.max(1000, Math.ceil(seconds * 1000));
      }
    }

    return 30000;
  }

  async _call(messages, maxTokens = this.analysisMaxTokens, preferredModel = this.primaryModel) {
    if (!this.isAvailable()) throw new Error('No Groq API key');

    const modelSequence = this._buildModelSequence(preferredModel);
    const modelAttemptErrors = [];

    for (const modelToTry of modelSequence) {
      const attemptErrors = [];
      let hasActiveKey = false;
      let allBlockedByModelCooldown = true;

      for (const keyState of this.keyStates) {
        if (!keyState.apiKey || keyState.disabled) continue;
        hasActiveKey = true;

        const cooldownRemainingMs = this._getModelCooldownRemainingMs(keyState, modelToTry);
        if (cooldownRemainingMs > 0) {
          attemptErrors.push(`key${keyState.slot}: ${modelToTry} cooldown ${Math.ceil(cooldownRemainingMs / 1000)}s`);
          continue;
        }
        allBlockedByModelCooldown = false;

        if (!this._checkRateLimit(keyState)) {
          attemptErrors.push(`key${keyState.slot}: local throttle`);
          continue;
        }

        try {
          keyState.callCount += 1;

          const response = await fetch(`${GROQ_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${keyState.apiKey}`
            },
            body: JSON.stringify({
              model: modelToTry,
              messages,
              temperature: 0.2,
              max_tokens: maxTokens,
              response_format: { type: 'json_object' }
            })
          });

          if (!response.ok) {
            const err = await response.text();
            keyState.lastError = `${modelToTry}: Groq API ${response.status}`;

            if (response.status === 429) {
              const retryAfterMs = this._extractRetryAfterMs(err);
              this._setModelCooldown(keyState, modelToTry, retryAfterMs);
              attemptErrors.push(`key${keyState.slot}: ${modelToTry} 429 (${Math.ceil(retryAfterMs / 1000)}s)`);
              continue;
            }

            if (response.status === 401 || response.status === 403) {
              keyState.disabled = true;
              attemptErrors.push(`key${keyState.slot}: ${response.status} auth`);
              continue;
            }

            attemptErrors.push(`key${keyState.slot}: ${modelToTry} ${response.status}`);
            continue;
          }

          const data = await response.json();
          keyState.lastError = null;
          this._clearModelCooldown(keyState, modelToTry);
          this.lastUsedSlot = keyState.slot;
          this.lastUsedModel = modelToTry;
          this.lastError = null;
          return data.choices?.[0]?.message?.content || '';
        } catch (error) {
          keyState.lastError = `${modelToTry}: ${error.message}`;
          attemptErrors.push(`key${keyState.slot}: ${modelToTry} ${error.message}`);
        }
      }

      if (hasActiveKey && allBlockedByModelCooldown && modelToTry === this.primaryModel && modelSequence.length > 1) {
        console.warn(`[Groq] Primary model ${this.primaryModel} cooling down on all keys. Falling back to ${modelSequence[1]}.`);
      }

      const reason = attemptErrors.length > 0 ? attemptErrors.join('; ') : 'no active keys';
      modelAttemptErrors.push(`${modelToTry}: ${reason}`);
    }

    this.lastError = modelAttemptErrors.length > 0
      ? `All Groq attempts failed (${modelAttemptErrors.join(' | ')})`
      : 'No Groq API key';
    throw new Error(this.lastError);
  }

  async analyzeTopic(topic) {
    const { title, snippet, party, category, sources } = topic;

    // ── Cache check ──
    const cacheKey = `groq:analyze:${simpleHash((title || '').toLowerCase())}`;
    const cached = analysisCache.get(cacheKey);
    if (cached) {
      console.log(`[Groq] Cache hit for: "${title}"`);
      return cached;
    }

    const systemPrompt = `You are SentinelTruth, a Malaysian political fact-checking AI. You analyze political claims with strict neutrality and evidence-based reasoning. You are familiar with all Malaysian political parties: PKR, DAP, AMANAH (Pakatan Harapan/PH), UMNO (Barisan Nasional/BN), PAS, BERSATU (Perikatan Nasional/PN), GPS, and MUDA.

Your job is to:
1. Assess the truthfulness of the political claim
2. Provide detailed analysis with reasoning
3. Identify the primary party involved
4. Suggest related topics/connections
5. Rate the impact level
  6. Assess whether framing language leans toward the government ("pro_kerajaan") or opposition ("pro_pembangkang")
  7. Detect logical fallacies present in the claim wording

  IMPORTANT:
  - Be transparent about confidence level.
  - If you cannot verify with high confidence, return UNVERIFIED.
  - Do not show institutional deference. Treat government and opposition claims with the same skepticism standard.
  - If no logical fallacy is present, return an empty array for logicalFallacies.
  - Use "pro_kerajaan" (not pro_government) and "pro_pembangkang" (not anti_government) for Malaysian political context.`;

    const userPrompt = `Analyze this Malaysian political claim:

Title: ${title}
Summary: ${snippet || ''}
Mentioned party: ${party || 'Unknown'}
Category: ${category || 'General'}
${sources?.length ? `Sources: ${sources.map(s => s.name + ' - ' + s.url).join(', ')}` : ''}

Return a JSON object with EXACTLY these fields:
{
  "verdict": "ONE OF: TRUE, HOAX, MISLEADING, PARTIALLY_TRUE, UNVERIFIED",
  "summary": "Clear 2-3 sentence summary of the claim and its context",
  "analysis": "Detailed 3-5 sentence analysis explaining why this verdict was given, with specific evidence or reasoning",
  "party": "Primary party (ONE OF: PKR, DAP, AMANAH, UMNO, PAS, BERSATU, GPS, MUDA, UNSPECIFIED)",
  "category": "Topic category",
  "impact": "ONE OF: high, medium, low",
  "region": "Affected region (e.g., National, Kelantan, Sabah)",
  "factCheckRef": "Which fact-checking source would verify this (e.g., Sebenarnya.my, JomCheck, MyCheck.my)",
  "confidence": "ONE OF: high, medium, low",
  "biasAssessment": {
    "overallBias": "ONE OF: neutral, pro_kerajaan, pro_pembangkang, mixed, unclear",
    "justification": "1-2 sentence rationale for the bias judgment",
    "governmentClaimsChecked": "boolean",
    "oppositionClaimsChecked": "boolean",
    "loadedLanguage": "ONE OF: none, mild, strong"
  },
  "logicalFallacies": [
    {
      "type": "ONE OF: ad_hominem, straw_man, false_dilemma, hasty_generalization, slippery_slope, false_cause, cherry_picking, whataboutism, appeal_to_authority, appeal_to_fear",
      "excerpt": "exact quote or short excerpt",
      "explanation": "why this is a fallacy in context",
      "severity": "ONE OF: low, medium, high",
      "confidence": "ONE OF: low, medium, high"
    }
  ]
}`;

    try {
      const result = await this._call([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], this.analysisMaxTokens);

      const parsed = JSON.parse(result);
      const output = {
        success: true,
        ...parsed,
        party: normalizeParty(parsed.party, normalizeParty(party, 'UNSPECIFIED')),
        biasAssessment: normalizeBiasAssessment(parsed.biasAssessment),
        logicalFallacies: normalizeLogicalFallacies(parsed.logicalFallacies),
      };
      console.log(`[Groq] Analyzed: "${title}" → ${output.verdict}`);

      // ── Cache the result ──
      analysisCache.set(cacheKey, output);
      return output;
    } catch (err) {
      console.error('[Groq] Analysis error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async translateTopic(topic) {
    const { title, summary, analysis } = topic;

    // ── Cache check ──
    const cacheKey = `groq:trans:${simpleHash((title || '').toLowerCase())}`;
    const cached = translationCache.get(cacheKey);
    if (cached) {
      console.log(`[Groq] Translation cache hit for: "${title}"`);
      return cached;
    }

    const prompt = `Translate the following Malaysian political fact-check content into 3 languages. Keep political party names (PKR, DAP, UMNO, PAS, etc.) untranslated.

Title: ${title}
Summary: ${summary}
Analysis: ${analysis}

Return a JSON object with translations:
{
  "ms": { "title": "...", "summary": "...", "analysis": "..." },
  "hi": { "title": "...", "summary": "...", "analysis": "..." },
  "zh": { "title": "...", "summary": "...", "analysis": "..." }
}

ms = Bahasa Melayu, hi = Hindi, zh = Simplified Chinese.
Return ONLY the JSON object.`;

    try {
      const result = await this._call([
        { role: 'system', content: 'You are a professional multilingual translator specializing in Malaysian political content. Translate accurately while preserving meaning and political context.' },
        { role: 'user', content: prompt }
      ], this.translationMaxTokens);

      const parsed = JSON.parse(result);
      console.log(`[Groq] Translated: "${title}"`);
      const output = { success: true, translations: parsed };

      // ── Cache the result ──
      translationCache.set(cacheKey, output);
      return output;
    } catch (err) {
      console.error('[Groq] Translation error:', err.message);
      return { success: false, error: err.message };
    }
  }

  getUsage() {
    const activeKeys = this.keyStates.filter((state) => state.apiKey && !state.disabled);
    const totalCalls = activeKeys.reduce((sum, state) => sum + state.callCount, 0);
    const allPrimaryCoolingDown = activeKeys.length > 0
      && activeKeys.every((state) => this._getModelCooldownRemainingMs(state, this.primaryModel) > 0);
    const cooldownRemainingSec = allPrimaryCoolingDown
      ? Math.max(
          0,
          Math.min(...activeKeys.map((state) => Math.ceil(this._getModelCooldownRemainingMs(state, this.primaryModel) / 1000)))
        )
      : 0;
    const keyPool = this.keyStates.map((state) => ({
      slot: state.slot,
      enabled: !state.disabled,
      callsThisMinute: state.callCount,
      primaryCooldownRemainingSec: Math.max(0, Math.ceil(this._getModelCooldownRemainingMs(state, this.primaryModel) / 1000)),
      fallbackCooldownRemainingSec: Math.max(0, Math.ceil(this._getModelCooldownRemainingMs(state, this.fallbackModel) / 1000)),
      lastError: state.lastError,
    }));

    return {
      provider: 'Groq',
      callsThisMinute: totalCalls,
      maxPerMinute: this.maxPerMinutePerKey * Math.max(1, activeKeys.length),
      available: this.isAvailable(),
      model: this.primaryModel,
      primaryModel: this.primaryModel,
      fallbackModel: this.fallbackModel,
      lastUsedModel: this.lastUsedModel,
      analysisMaxTokens: this.analysisMaxTokens,
      translationMaxTokens: this.translationMaxTokens,
      keysConfigured: this.keyStates.length,
      keysActive: activeKeys.length,
      lastUsedSlot: this.lastUsedSlot,
      keyPool,
      cooldownRemainingSec,
      lastError: this.lastError,
      cacheSize: analysisCache.size + translationCache.size,
    };
  }
}

export const groqAnalyzer = new GroqAnalyzer();
