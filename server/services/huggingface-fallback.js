// HuggingFace Fallback — OpenAI-compatible Inference Providers endpoint
// Free tier depends on account/token permissions and provider availability.

const HF_API_BASE = 'https://router.huggingface.co/v1/chat/completions';
const DEFAULT_HF_MODELS = [
  'Qwen/Qwen2.5-72B-Instruct',
  'Qwen/Qwen2.5-32B-Instruct',
  'meta-llama/Llama-3.1-8B-Instruct',
];

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

function withDefaultPolicy(modelId) {
  const value = String(modelId || '').trim();
  if (!value) return '';
  // Keep explicit provider or pricing policy if already supplied.
  return value.includes(':') ? value : `${value}:fastest`;
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

class HuggingFaceFallback {
  constructor() {
    this.token = process.env.HF_API_TOKEN || process.env.HUGGING_FACE_API_KEY || process.env.HUGGINGFACE_API_KEY || '';
    const configuredModels = (process.env.HUGGING_FACE_MODELS || process.env.HF_MODELS || '')
      .split(',')
      .map((m) => withDefaultPolicy(m))
      .filter(Boolean);

    this.models = configuredModels.length > 0
      ? configuredModels
      : DEFAULT_HF_MODELS.map((m) => withDefaultPolicy(m));

    this.model = this.models[0] || withDefaultPolicy('meta-llama/Llama-3.1-8B-Instruct');
    this.callCount = 0;
    this.lastReset = Date.now();
    this.lastError = null;
    this.blockedUntil = 0;
  }

  isAvailable() {
    return !!this.token;
  }

  _checkRateLimit() {
    if (Date.now() - this.lastReset > 3600000) {
      this.callCount = 0;
      this.lastReset = Date.now();
    }
    return this.callCount < 50;
  }

  async analyzeTopic(topic) {
    if (!this.isAvailable()) {
      return { success: false, error: 'No HF token' };
    }

    if (Date.now() < this.blockedUntil) {
      return { success: false, error: this.lastError || 'HF temporarily unavailable' };
    }
    const systemPrompt = 'You are a Malaysian political fact-checker. Return strict JSON only. Apply equal skepticism to government and opposition claims and avoid institutional deference. If no logical fallacy is present, return an empty logicalFallacies array.';
    const userPrompt = `Analyze this claim and return a JSON object.

Claim: ${topic.title}
Context: ${topic.snippet || ''}
Party: ${topic.party || 'Unknown'}

Return JSON with: verdict (TRUE/HOAX/MISLEADING/PARTIALLY_TRUE/UNVERIFIED), summary, analysis, party (PKR/DAP/AMANAH/UMNO/PAS/BERSATU/GPS/MUDA/UNSPECIFIED), category, impact (high/medium/low), region, confidence (high/medium/low), biasAssessment { overallBias (neutral/pro_kerajaan/pro_pembangkang/mixed/unclear), justification, governmentClaimsChecked, oppositionClaimsChecked, loadedLanguage (none/mild/strong) }, logicalFallacies [{ type (ad_hominem/straw_man/false_dilemma/hasty_generalization/slippery_slope/false_cause/cherry_picking/whataboutism/appeal_to_authority/appeal_to_fear), excerpt, explanation, severity (low/medium/high), confidence (low/medium/high) }].

Return ONLY valid JSON, nothing else.`;

    let lastError = 'HF inference failed';

    for (const model of this.models) {
      if (!this._checkRateLimit()) {
        return { success: false, error: 'Rate limited' };
      }

      try {
        this.callCount++;
        const response = await fetch(HF_API_BASE, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: 900,
            stream: false,
          })
        });

        if (!response.ok) {
          const err = await response.text();
          lastError = `HF API ${response.status}`;

          if (response.status === 404 || response.status === 400) {
            console.warn(`[HF] Model unavailable on router (${model})`);
            continue;
          }

          if (response.status === 402) {
            this.lastError = 'HF credits depleted (402)';
            this.blockedUntil = Date.now() + 3600000;
            console.error('[HF] API error:', response.status, err);
            return { success: false, error: this.lastError };
          }

          if (response.status === 429) {
            this.lastError = 'HF rate limited (429)';
            this.blockedUntil = Date.now() + 60000;
            console.error('[HF] API error:', response.status, err);
            return { success: false, error: this.lastError };
          }

          this.lastError = lastError;
          console.error('[HF] API error:', response.status, err);
          return { success: false, error: lastError };
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);

        if (!jsonMatch) {
          lastError = 'Could not parse response';
          console.warn(`[HF] Non-JSON response from model ${model}`);
          continue;
        }

        const parsed = JSON.parse(jsonMatch[0]);
        this.model = model;
        this.lastError = null;
        this.blockedUntil = 0;
        console.log(`[HF] Analyzed: "${topic.title}" → ${parsed.verdict} (${model})`);
        return {
          success: true,
          ...parsed,
          party: normalizeParty(parsed.party, normalizeParty(topic.party, 'UNSPECIFIED')),
          biasAssessment: normalizeBiasAssessment(parsed.biasAssessment),
          logicalFallacies: normalizeLogicalFallacies(parsed.logicalFallacies),
        };
      } catch (err) {
        lastError = err.message;
        this.lastError = err.message;
        console.error('[HF] Error:', err.message);
      }
    }

    this.lastError = lastError;
    return { success: false, error: lastError };
  }

  getUsage() {
    const blockedForSec = Math.max(0, Math.ceil((this.blockedUntil - Date.now()) / 1000));

    return {
      provider: 'HuggingFace',
      callsThisHour: this.callCount,
      maxPerHour: 50,
      available: this.isAvailable(),
      model: this.model,
      fallbackModels: this.models,
      blockedForSec,
      lastError: this.lastError,
    };
  }
}

export const huggingFaceFallback = new HuggingFaceFallback();
