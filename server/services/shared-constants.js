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
  'harakahdaily.net', 'suaramerdeka.com.my', 'roketkini.com',
];

// ── Source Domain Bias Map ──────────────────────────────────────
// Known political leaning of Malaysian media outlets.
// "pro_kerajaan"   = Generally aligns with government narrative
// "pro_pembangkang" = Generally aligns with opposition narrative
// "neutral"        = Relatively balanced or independent
// "unclear"        = Not enough info to classify
//
// NOTE: This is an approximate classification based on media ownership
// and editorial patterns. Readers should always evaluate content independently.
export const SOURCE_DOMAIN_BIAS_MAP = {
  // ── Pro-Kerajaan (Government-linked / GLC-owned) ──
  'bernama.com':           { leaning: 'pro_kerajaan', owner: 'Kerajaan Malaysia (BERNAMA — Agensi Berita Kebangsaan)', note: 'Agensi berita rasmi kerajaan' },
  'bharian.com.my':        { leaning: 'pro_kerajaan', owner: 'Media Prima Berhad (berkaitan UMNO)', note: 'Akhbar BM utama milik Media Prima' },
  'nst.com.my':            { leaning: 'pro_kerajaan', owner: 'Media Prima Berhad (berkaitan UMNO)', note: 'Akhbar Inggeris milik Media Prima' },
  'astroawani.com':        { leaning: 'pro_kerajaan', owner: 'Astro Malaysia Holdings', note: 'Portal berita bawah Astro — GLC berkaitan kerajaan' },
  'utusan.com.my':         { leaning: 'pro_kerajaan', owner: 'Media Mulia Sdn Bhd (berkaitan UMNO)', note: 'Akhbar tradisional berkaitan UMNO' },
  'thestar.com.my':        { leaning: 'pro_kerajaan', owner: 'Star Media Group (berkaitan MCA/BN)', note: 'Milik Star Media Group — berkaitan MCA' },
  'sinardaily.my':         { leaning: 'pro_kerajaan', owner: 'Karangkraf Media Group', note: 'Portal berita BM — cenderung kerajaan' },
  'thesun.my':             { leaning: 'pro_kerajaan', owner: 'Media Prima Berhad', note: 'Akhbar percuma milik Media Prima' },
  'hmetro.com.my':         { leaning: 'pro_kerajaan', owner: 'Media Prima Berhad', note: 'Tabloid milik Media Prima' },
  'kosmo.com.my':          { leaning: 'pro_kerajaan', owner: 'Karangkraf Media Group', note: 'Akhbar harian milik Karangkraf' },
  'rtm.gov.my':            { leaning: 'pro_kerajaan', owner: 'Kerajaan Malaysia', note: 'Penyiar milik kerajaan' },

  // ── Pro-Pembangkang (Opposition-linked) ──
  'harakahdaily.net':      { leaning: 'pro_pembangkang', owner: 'PAS (Parti Islam Se-Malaysia)', note: 'Portal rasmi PAS' },
  'suaramerdeka.com.my':   { leaning: 'pro_pembangkang', owner: 'Berkaitan Perikatan Nasional', note: 'Cenderung PN/PAS' },
  'tvpas.my':              { leaning: 'pro_pembangkang', owner: 'PAS', note: 'Saluran TV rasmi PAS' },

  // ── Neutral / Bebas (Independent) ──
  'malaysiakini.com':      { leaning: 'neutral', owner: 'Mkini Dot Com Sdn Bhd (bebas)', note: 'Portal berita bebas paling lama — diiktiraf kritikal terhadap semua pihak' },
  'freemalaysiatoday.com': { leaning: 'neutral', owner: 'FMT Media Sdn Bhd (bebas)', note: 'Bebas — sering kritis terhadap kerajaan dan pembangkang' },
  'malaymail.com':         { leaning: 'neutral', owner: 'Malay Mail Sdn Bhd (bebas)', note: 'Bebas — liputan seimbang' },
  'roketkini.com':         { leaning: 'pro_kerajaan', owner: 'DAP (Democratic Action Party)', note: 'Portal rasmi DAP — kini sebahagian kerajaan' },

  // ── Penyemak Fakta (Fact-checkers) ──
  'sebenarnya.my':         { leaning: 'neutral', owner: 'MCMC (Kerajaan)', note: 'Portal semakan fakta rasmi kerajaan' },
};

// ── Media Ownership & Transparency Info ─────────────────────────
export const MEDIA_OWNERSHIP_INFO = [
  { group: 'Media Prima Berhad', outlets: ['NST', 'Berita Harian', 'Harian Metro', 'The Sun', 'TV3', 'NTV7', '8TV'], leaning: 'pro_kerajaan', note: 'Konglomerat media terbesar — sejarah berkaitan UMNO/BN' },
  { group: 'Star Media Group', outlets: ['The Star', 'Star2'], leaning: 'pro_kerajaan', note: 'Dimiliki berkaitan MCA (komponen BN)' },
  { group: 'Astro Malaysia', outlets: ['Astro Awani'], leaning: 'pro_kerajaan', note: 'GLC — penyiar satelit dominan' },
  { group: 'Karangkraf', outlets: ['Sinar Harian', 'Kosmo'], leaning: 'pro_kerajaan', note: 'Penerbit media swasta — cenderung kerajaan' },
  { group: 'BERNAMA', outlets: ['BERNAMA'], leaning: 'pro_kerajaan', note: 'Agensi berita kebangsaan milik kerajaan' },
  { group: 'Mkini Dot Com', outlets: ['Malaysiakini'], leaning: 'neutral', note: 'Bebas — dibiayai langganan, pengiklanan' },
  { group: 'FMT Media', outlets: ['Free Malaysia Today'], leaning: 'neutral', note: 'Bebas — media digital' },
  { group: 'PAS Media', outlets: ['Harakah Daily', 'TV PAS'], leaning: 'pro_pembangkang', note: 'Dimiliki PAS — parti pembangkang' },
];

/**
 * Guess the political leaning of a source domain.
 * Returns: { leaning, owner, note } or a default "unclear" object.
 */
export function guessSourceLeaning(domain = '') {
  const normalized = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (!normalized) return { leaning: 'unclear', owner: '', note: '' };

  // Direct match
  if (SOURCE_DOMAIN_BIAS_MAP[normalized]) {
    return SOURCE_DOMAIN_BIAS_MAP[normalized];
  }

  // Partial match (e.g. subdomain.bernama.com)
  for (const [key, value] of Object.entries(SOURCE_DOMAIN_BIAS_MAP)) {
    if (normalized.endsWith(`.${key}`) || normalized === key) {
      return value;
    }
  }

  return { leaning: 'unclear', owner: '', note: '' };
}

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
  return 'UNSPECIFIED';
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
