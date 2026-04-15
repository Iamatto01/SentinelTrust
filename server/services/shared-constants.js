// Shared Constants & Helpers — Single source of truth for signal terms,
// domain lists, and text-matching utilities used across the pipeline.

// ── Malaysian political party keywords ──────────────────────────
export const PARTY_KEYWORDS = {
  PKR: ['pkr', 'anwar ibrahim', 'rafizi', 'nurul izzah'],
  DAP: ['democratic action party', 'anthony loke', 'lim guan eng'],
  AMANAH: ['amanah', 'mohamad sabu', 'mat sabu'],
  UMNO: ['umno', 'zahid', 'ahmad zahid', 'tok mat', 'ismail sabri'],
  PAS: ['pas', 'hadi awang', 'abdul hadi', 'sanusi'],
  BERSATU: ['bersatu', 'muhyiddin', 'hamzah zainudin', 'pn'],
  GPS: ['gps', 'abang johari', 'sarawak coalition'],
  MUDA: ['muda', 'syed saddiq'],
};

// ── Malaysia-related signal terms ───────────────────────────────
export const MALAYSIA_SIGNAL_TERMS = [
  'malaysia', 'malaysian', 'putrajaya', 'dewan rakyat', 'dewan negara',
  'parlimen', 'parliament malaysia', 'kerajaan', 'kerajaan perpaduan',
  'pakatan harapan', 'perikatan nasional', 'barisan nasional',
  'sprm', 'macc', 'pilihan raya', 'suruhanjaya pilihan raya',
  'klang valley', 'sabah', 'sarawak',
  'petronas', 'khazanah', 'kwsp', 'epf', 'felda', 'tabung haji',
  'bank negara', 'bnm', 'lhdn', 'tenaga nasional', 'prasarana',
];

// ── Political signal terms ──────────────────────────────────────
export const POLITICAL_SIGNAL_TERMS = [
  'politic', 'political', 'election', 'policy', 'parliament',
  'cabinet', 'minister', 'coalition', 'opposition', 'government',
  'governance', 'corruption', 'campaign', 'bill', 'legislation',
  'manifesto', 'undi', 'politik', 'dasar', 'budget', 'macc', 'sprm',
  'umno', 'pas', 'pkr', 'bersatu', 'amanah', 'gps', 'muda',
];

// ── National issue signal terms (beyond politics) ─────────────
export const NATIONAL_ISSUE_SIGNAL_TERMS = [
  'cost of living', 'inflation', 'harga barang', 'subsidi',
  'unemployment', 'job loss', 'wage', 'gaji',
  'housing', 'rumah mampu milik', 'eviction',
  'healthcare', 'hospital', 'clinic', 'medicine',
  'education', 'school', 'student',
  'crime', 'jenayah', 'scam', 'drug abuse',
  'accident', 'kemalangan', 'fatal crash', 'bus crash', 'train collision',
  'fire incident', 'industrial accident', 'explosion',
  'flood', 'banjir', 'landslide', 'disaster response',
  'water supply', 'water disruption', 'electricity', 'blackout',
  'public transport', 'lrt', 'mrt', 'bus service', 'road safety',
  'politician charged', 'minister charged', 'mp charged', 'abuse of power',
  'salah guna kuasa', 'money laundering', 'asset seizure',
  'subsidy cut', 'subsidy removal', 'fuel subsidy', 'diesel subsidy',
  'fiscal deficit', 'debt burden', 'tax burden',
  'asset sale', 'jualan aset', 'national asset', 'aset negara',
  'state asset', 'strategic asset', 'foreign ownership', 'pemilikan asing',
  'sold to foreign company', 'privatisation', 'sovereignty risk',
  'pollution', 'haze', 'climate',
  'poverty', 'social aid', 'welfare',
  'public service', 'bureaucracy',
];

// ── Category keyword map ────────────────────────────────────────
export const CATEGORY_KEYWORDS = {
  Corruption: ['corruption', 'bribe', 'macc', 'graft', 'money laundering'],
  Elections: ['election', 'poll', 'spr', 'undi18', 'by-election', 'campaign'],
  Economy: ['economy', 'budget', 'ringgit', 'inflation', 'subsidy', 'fiscal'],
  'Finance & Subsidy': ['subsidy', 'fuel subsidy', 'diesel subsidy', 'fiscal deficit', 'debt burden', 'cost of living', 'tax'],
  Policy: ['policy', 'proposal', 'cabinet', 'ministry', 'initiative'],
  Governance: ['governance', 'administration', 'parliament', 'dewan rakyat'],
  Legal: ['court', 'judge', 'trial', 'legal', 'prosecution'],
  Crime: ['crime', 'jenayah', 'murder', 'kidnap', 'drug', 'scam', 'extortion', 'abuse of power'],
  'Public Safety': ['accident', 'kemalangan', 'fatal crash', 'bus crash', 'train collision', 'fire incident', 'explosion', 'road safety'],
  'National Assets': ['asset sale', 'national asset', 'state asset', 'strategic asset', 'foreign ownership', 'privatisation', 'sovereignty'],
  Education: ['education', 'school', 'university', 'moe'],
  'Racial Politics': ['racial', 'ethnic', 'religion', 'bumiputera', 'unity'],
  'Social Issues': ['welfare', 'poverty', 'housing', 'healthcare'],
  'Digital Security': ['cyber', 'data breach', 'security', 'hack'],
};

// ── Trusted Malaysian news domains ──────────────────────────────
export const MALAYSIAN_NEWS_DOMAINS = [
  'freemalaysiatoday.com', 'malaymail.com', 'bernama.com',
  'thestar.com.my', 'bharian.com.my', 'astroawani.com',
  'malaysiakini.com', 'thesun.my', 'sinardaily.my',
  'utusan.com.my', 'nst.com.my', 'facebook.com',
];

// ── Pre-compiled regex cache for signal matching ────────────────
// Build regexes once at module load instead of per-call.
const _regexCache = new Map();

function _getWordBoundaryRegex(term) {
  if (_regexCache.has(term)) return _regexCache.get(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'i');
  _regexCache.set(term, re);
  return re;
}

/**
 * Check if text includes any of the given signal terms.
 * Uses pre-compiled regex for short terms needing word boundaries.
 */
export function includesAnySignal(text = '', terms = []) {
  const lower = text.toLowerCase();
  for (const term of terms) {
    const normalized = String(term || '').toLowerCase();
    if (!normalized) continue;

    if (/^[a-z0-9]+$/.test(normalized) && normalized.length <= 4) {
      if (_getWordBoundaryRegex(normalized).test(lower)) return true;
    } else {
      if (lower.includes(normalized)) return true;
    }
  }
  return false;
}

/**
 * Check if a topic/record is Malaysian national-issue content.
 */
export function isMalaysiaNationalIssueContent(title = '', summary = '') {
  const combinedText = `${title} ${summary}`.toLowerCase();

  const hasPartySignal = Object.values(PARTY_KEYWORDS)
    .flat()
    .some((kw) => combinedText.includes(kw.toLowerCase()));

  const hasMalaysiaSignal =
    hasPartySignal || includesAnySignal(combinedText, MALAYSIA_SIGNAL_TERMS);

  const hasIssueSignal =
    hasPartySignal ||
    includesAnySignal(combinedText, POLITICAL_SIGNAL_TERMS) ||
    includesAnySignal(combinedText, NATIONAL_ISSUE_SIGNAL_TERMS);

  return hasMalaysiaSignal && hasIssueSignal;
}

/**
 * Backward-compatible wrapper kept for existing imports.
 */
export function isMalaysiaPoliticalContent(title = '', summary = '') {
  return isMalaysiaNationalIssueContent(title, summary);
}

/**
 * Guess the primary party from text using keyword matching.
 */
export function guessParty(text = '') {
  const lower = text.toLowerCase();
  for (const [party, keywords] of Object.entries(PARTY_KEYWORDS)) {
    if (keywords.some((keyword) => lower.includes(keyword))) return party;
  }
  return 'PKR';
}

/**
 * Guess the category from text using keyword matching.
 */
export function guessCategory(text = '') {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => lower.includes(keyword))) return category;
  }
  return 'Governance';
}

/**
 * Check if a domain is a known Malaysian news domain.
 */
export function isMalaysianDomain(domain = '') {
  const normalized = String(domain || '').toLowerCase();
  if (!normalized) return false;
  if (normalized.endsWith('.my')) return true;
  return MALAYSIAN_NEWS_DOMAINS.some(
    (known) => normalized === known || normalized.endsWith(`.${known}`)
  );
}

// ── Simple LRU Cache ────────────────────────────────────────────
export class LRUCache {
  constructor(maxSize = 200, ttlMs = 30 * 60 * 1000) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    this._map = new Map();
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this._ttlMs) {
      this._map.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this._map.delete(key);
    if (this._map.size >= this._maxSize) {
      // Evict oldest (first entry)
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
    this._map.set(key, { value, ts: Date.now() });
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  get size() {
    return this._map.size;
  }

  clear() {
    this._map.clear();
  }
}

/**
 * Create a simple hash from a string for cache keys.
 */
export function simpleHash(str = '') {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(36);
}

/**
 * Extract JSON object from potentially messy LLM output.
 */
export function extractJsonObject(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}
