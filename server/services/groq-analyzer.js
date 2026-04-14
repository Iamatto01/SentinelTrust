// Groq Analyzer — Uses Llama 3.3 70B for fact-checking and translation
// Free tier: ~1000 req/day, no credit card
// Optimized: response caching, reduced token limits

import { LRUCache, simpleHash } from './shared-constants.js';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

// ── Response caches ──
const analysisCache = new LRUCache(200, 30 * 60 * 1000); // 30min TTL
const translationCache = new LRUCache(200, 60 * 60 * 1000); // 1hr TTL

class GroqAnalyzer {
  constructor() {
    this.apiKey = process.env.GROQ_API_KEY || '';
    this.model = 'llama-3.3-70b-versatile'; // Best free-tier model for structured JSON + multilingual
    this.callCount = 0;
    this.lastReset = Date.now();
    this.cooldownUntil = 0;
    this.lastError = null;
  }

  isAvailable() {
    return !!this.apiKey;
  }

  _checkRateLimit() {
    if (Date.now() - this.lastReset > 60000) {
      this.callCount = 0;
      this.lastReset = Date.now();
    }
    return this.callCount < 25; // 25 RPM safe limit
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

  async _call(messages, maxTokens = 800) {
    if (!this.isAvailable()) throw new Error('No Groq API key');

    const cooldownRemainingMs = this.cooldownUntil - Date.now();
    if (cooldownRemainingMs > 0) {
      throw new Error(`Groq cooldown (${Math.ceil(cooldownRemainingMs / 1000)}s remaining)`);
    }

    if (!this._checkRateLimit()) throw new Error('Rate limited (local throttle)');

    this.callCount++;
    const response = await fetch(`${GROQ_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const err = await response.text();
      this.lastError = `Groq API ${response.status}`;

      if (response.status === 429) {
        const retryAfterMs = this._extractRetryAfterMs(err);
        this.cooldownUntil = Date.now() + retryAfterMs;
        throw new Error(`Groq API 429: rate limited (retry in ${Math.ceil(retryAfterMs / 1000)}s)`);
      }

      throw new Error(`Groq API ${response.status}: ${err}`);
    }

    const data = await response.json();
    this.lastError = null;
    return data.choices?.[0]?.message?.content || '';
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

IMPORTANT: Be transparent about your confidence level. If you cannot verify a claim with high confidence, mark it as UNVERIFIED rather than guessing.`;

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
  "party": "Primary party (ONE OF: PKR, DAP, AMANAH, UMNO, PAS, BERSATU, GPS, MUDA)",
  "category": "Topic category",
  "impact": "ONE OF: high, medium, low",
  "region": "Affected region (e.g., National, Kelantan, Sabah)",
  "factCheckRef": "Which fact-checking source would verify this (e.g., Sebenarnya.my, JomCheck, MyCheck.my)",
  "confidence": "ONE OF: high, medium, low"
}`;

    try {
      const result = await this._call([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], 800);

      const parsed = JSON.parse(result);
      console.log(`[Groq] Analyzed: "${title}" → ${parsed.verdict}`);
      const output = { success: true, ...parsed };

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
      ], 1500);

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
    const cooldownRemainingSec = Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000));

    return {
      provider: 'Groq',
      callsThisMinute: this.callCount,
      maxPerMinute: 25,
      available: this.isAvailable(),
      model: this.model,
      cooldownRemainingSec,
      lastError: this.lastError,
      cacheSize: analysisCache.size + translationCache.size,
    };
  }
}

export const groqAnalyzer = new GroqAnalyzer();
