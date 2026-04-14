// Ollama Analyzer — Local/self-hosted model with caching & optimized settings
// Requires OLLAMA_ENABLED=true and a reachable Ollama server.

import { LRUCache, simpleHash, extractJsonObject } from './shared-constants.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

// ── Response cache: avoids re-analyzing identical/similar topics ──
const analysisCache = new LRUCache(200, 30 * 60 * 1000); // 200 entries, 30min TTL
const translationCache = new LRUCache(200, 60 * 60 * 1000); // 200 entries, 1hr TTL

class OllamaAnalyzer {
  constructor() {
    this.enabled = process.env.OLLAMA_ENABLED === 'true';
    this.baseUrl = (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
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
  async _ensureHealthy() {
    if (Date.now() - this._healthCheckAt < 60000 && this._healthy !== null) {
      return this._healthy;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);
      this._healthy = res.ok;
    } catch {
      this._healthy = false;
    }
    this._healthCheckAt = Date.now();
    return this._healthy;
  }

  async _call(messages, { timeoutMs = this.timeoutMs, numPredict = 800 } = {}) {
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
          model: this.model,
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
If evidence is weak, use verdict UNVERIFIED.`;

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
  "party": "PKR|DAP|AMANAH|UMNO|PAS|BERSATU|GPS|MUDA",
  "category": "string",
  "impact": "high|medium|low",
  "region": "string",
  "factCheckRef": "string",
  "confidence": "high|medium|low"
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
        party: parsed.party,
        category: parsed.category,
        impact: parsed.impact,
        region: parsed.region,
        factCheckRef: parsed.factCheckRef,
        confidence: parsed.confidence,
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
      model: this.model,
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
