// Data Manager — JSON file storage with debounced writes, cached stats, and URL index
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  MALAYSIA_SIGNAL_TERMS,
  POLITICAL_SIGNAL_TERMS,
  MALAYSIAN_NEWS_DOMAINS,
  includesAnySignal,
  isMalaysianDomain,
} from './shared-constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

function resolveDataFile(customPath, fallbackPath) {
  const value = String(customPath || '').trim();
  if (!value) return fallbackPath;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

const TOPICS_FILE = resolveDataFile(process.env.TOPICS_FILE_PATH, join(DATA_DIR, 'topics.json'));
const LOG_FILE = resolveDataFile(process.env.AGENT_LOG_FILE_PATH, join(DATA_DIR, 'agent-log.json'));

// Seed data import
import { SEED_TOPICS } from '../../src/data/seed-data.js';
import { PARTIES, VERDICTS } from '../../src/data/parties.js';

class DataManager {
  constructor() {
    this.strictRealMode = process.env.STRICT_REAL_MODE !== 'false';
    this.malaysiaPoliticsOnly = process.env.MALAYSIA_POLITICS_ONLY !== 'false';
    this.minimumVerificationScore = parseInt(process.env.VERIFICATION_MIN_SCORE || '65', 10);
    this.seedOnEmpty = process.env.SEED_ON_EMPTY === 'true';
    this._ensureDir();
    this._topics = this._load(TOPICS_FILE, this.seedOnEmpty ? SEED_TOPICS : []);
    this._log = this._load(LOG_FILE, []);

    // ── Performance: URL index for O(1) duplicate lookups ──
    this._urlIndex = new Set();
    this._rebuildUrlIndex();

    // ── Performance: Debounced disk writes ──
    this._saveTimer = null;
    this._saveLogTimer = null;
    this._SAVE_DEBOUNCE_MS = 2000;

    // ── Performance: Cached stats ──
    this._statsCache = null;
    this._statsCacheTs = 0;
    this._qualityCache = null;
    this._qualityCacheTs = 0;
    this._STATS_CACHE_TTL = 10000; // 10 seconds
  }

  _rebuildUrlIndex() {
    this._urlIndex.clear();
    for (const topic of this._topics) {
      const url = this._getPrimarySourceUrl(topic).toLowerCase();
      if (url) this._urlIndex.add(url);
    }
  }

  _invalidateStatsCache() {
    this._statsCache = null;
    this._qualityCache = null;
  }

  _ensureDir() {
    const dirs = new Set([DATA_DIR, dirname(TOPICS_FILE), dirname(LOG_FILE)]);
    for (const dirPath of dirs) {
      if (dirPath && !existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
      }
    }
  }

  _load(file, fallback) {
    try {
      if (existsSync(file)) {
        const loaded = JSON.parse(readFileSync(file, 'utf-8'));
        if (file === TOPICS_FILE && Array.isArray(loaded)) {
          return loaded.map(topic => this._normalizeTopic(topic));
        }
        return loaded;
      }
    } catch { /* ignore */ }
    this._writeSync(file, fallback);
    if (file === TOPICS_FILE && Array.isArray(fallback)) {
      return fallback.map(topic => this._normalizeTopic(topic));
    }
    return Array.isArray(fallback) ? [...fallback] : fallback;
  }

  _writeSync(file, data) {
    try {
      writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error('DataManager write error:', e.message);
    }
  }

  /**
   * Debounced save — coalesces rapid writes into a single disk I/O.
   * Critical for bulk operations (1000 topics → 1 write instead of 1000).
   */
  _save() {
    this._invalidateStatsCache();
    if (this._saveTimer) return; // Already scheduled
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._writeSync(TOPICS_FILE, this._topics);
    }, this._SAVE_DEBOUNCE_MS);
  }

  /** Force immediate save (e.g., on shutdown or after bulk ops). */
  _saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._invalidateStatsCache();
    this._writeSync(TOPICS_FILE, this._topics);
  }

  _saveLog() {
    if (this._log.length > 200) this._log = this._log.slice(-200);
    if (this._saveLogTimer) return;
    this._saveLogTimer = setTimeout(() => {
      this._saveLogTimer = null;
      this._writeSync(LOG_FILE, this._log);
    }, this._SAVE_DEBOUNCE_MS);
  }

  _normalizeTopic(topic) {
    const normalized = { ...topic };
    const id = normalized.id || '';

    if (!normalized.recordType) {
      if (/^st-\d+$/i.test(id)) normalized.recordType = 'seed';
      else if (/^st-ai-/i.test(id)) normalized.recordType = 'ai';
      else normalized.recordType = 'collected';
    }

    if (!normalized.sourceType) {
      if (normalized.recordType === 'seed') normalized.sourceType = 'seed';
      else if (normalized.recordType === 'simulated') normalized.sourceType = 'simulated';
      else normalized.sourceType = 'internet';
    }

    if (normalized.recordType === 'seed' || normalized.recordType === 'simulated') {
      normalized.synthetic = true;
    }

    if (!Array.isArray(normalized.sources)) {
      normalized.sources = [];
    }

    return normalized;
  }

  _topicHasSourceUrl(topic) {
    return Array.isArray(topic.sources) && topic.sources.some(src => typeof src?.url === 'string' && /^https?:\/\//i.test(src.url));
  }

  _extractSourceHost(topic) {
    if (!Array.isArray(topic?.sources)) return '';
    const sourceUrl = topic.sources.find(src => typeof src?.url === 'string' && /^https?:\/\//i.test(src.url))?.url || '';
    try {
      return new URL(sourceUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  _isMalaysiaPoliticalTopic(topic) {
    if (!topic) return false;
    const titleText = `${topic.title || ''}`.toLowerCase();
    const hasMalaysiaSignal = includesAnySignal(titleText, MALAYSIA_SIGNAL_TERMS);
    const hasPoliticalSignal = includesAnySignal(titleText, POLITICAL_SIGNAL_TERMS);
    return hasMalaysiaSignal && hasPoliticalSignal;
  }

  _getPrimarySourceUrl(topic) {
    if (!Array.isArray(topic.sources)) return '';
    const source = topic.sources.find(src => typeof src?.url === 'string' && /^https?:\/\//i.test(src.url));
    return source?.url || '';
  }

  _isSyntheticTopic(topic) {
    if (!topic) return true;
    if (topic.synthetic === true) return true;
    if (topic.recordType === 'seed' || topic.recordType === 'simulated') return true;
    if (!topic.sourceType && /^st-\d+$/i.test(topic.id || '')) return true;
    if (topic.aiProvider === 'Heuristic' && !this._topicHasSourceUrl(topic)) return true;
    return false;
  }

  _isRealRecord(topic) {
    return topic?.recordType === 'collected' || topic?.sourceType === 'internet' || topic?.sourceType === 'facebook';
  }

  _isEligibleForStats(topic) {
    if (!this.strictRealMode) return true;
    if (this._isSyntheticTopic(topic)) return false;
    if (this.malaysiaPoliticsOnly && !this._isMalaysiaPoliticalTopic(topic)) return false;
    if (!this._isRealRecord(topic)) return false;
    if (!this._topicHasSourceUrl(topic)) return false;
    const score = Number(topic?.verification?.score || 0);
    return score >= this.minimumVerificationScore;
  }

  _applyVisibilityFilter(topics) {
    let filtered = topics; // No spread — just filter in place

    if (this.strictRealMode) {
      filtered = filtered.filter(topic => !this._isSyntheticTopic(topic) && this._topicHasSourceUrl(topic));
    }

    if (this.malaysiaPoliticsOnly) {
      filtered = filtered.filter(topic => this._isMalaysiaPoliticalTopic(topic));
    }

    return filtered;
  }

  /**
   * Duplicate check — O(1) URL lookup + expensive similarity only when needed.
   */
  _isDuplicateTopic(topic) {
    const incomingUrl = this._getPrimarySourceUrl(topic).toLowerCase();

    // Fast path: URL index lookup O(1)
    if (incomingUrl && this._urlIndex.has(incomingUrl)) return true;

    // Slow path: title similarity (only run if URL didn't match)
    const incomingTitle = (topic.title || '').toLowerCase();
    if (!incomingTitle) return false;

    // Only check the last 500 topics for title similarity (recent window)
    const checkWindow = Math.min(this._topics.length, 500);
    for (let i = 0; i < checkWindow; i++) {
      const existing = this._topics[i];
      const sim = this._similarity((existing.title || '').toLowerCase(), incomingTitle);
      if (sim > 0.8) return true;
    }

    return false;
  }

  // --- Topics CRUD ---

  getAllTopics() {
    return this._applyVisibilityFilter(this._topics);
  }

  getTopicById(id) {
    const topic = this._topics.find(t => t.id === id) || null;
    if (!topic) return null;
    if (this.strictRealMode && this._isSyntheticTopic(topic)) return null;
    if (this.malaysiaPoliticsOnly && !this._isMalaysiaPoliticalTopic(topic)) return null;
    return topic;
  }

  addTopic(topic) {
    const normalized = this._normalizeTopic(topic);
    if (this._isDuplicateTopic(normalized)) return null;

    // Update URL index
    const url = this._getPrimarySourceUrl(normalized).toLowerCase();
    if (url) this._urlIndex.add(url);

    this._topics.unshift(normalized);
    this._save(); // Debounced
    return normalized;
  }

  /**
   * Bulk add — single debounced save at the end instead of per-topic.
   */
  addTopicsBulk(topics = []) {
    let added = 0;
    let duplicates = 0;

    for (const topic of topics) {
      const normalized = this._normalizeTopic(topic);
      if (this._isDuplicateTopic(normalized)) {
        duplicates++;
        continue;
      }

      const url = this._getPrimarySourceUrl(normalized).toLowerCase();
      if (url) this._urlIndex.add(url);

      this._topics.unshift(normalized);
      added++;
    }

    // Single save at the end
    if (added > 0) this._saveNow();

    return { added, duplicates, attempted: topics.length };
  }

  updateTopicTranslations(topicId, translations = {}) {
    const index = this._topics.findIndex((topic) => topic.id === topicId);
    if (index === -1) return null;

    const existing = this._topics[index];
    const mergedTranslations = { ...(existing.translations || {}) };

    for (const [lang, payload] of Object.entries(translations || {})) {
      if (!payload || typeof payload !== 'object') continue;
      mergedTranslations[lang] = {
        ...(existing.translations?.[lang] || {}),
        ...payload,
      };
    }

    this._topics[index] = this._normalizeTopic({
      ...existing,
      translations: mergedTranslations,
    });

    this._save(); // Debounced
    return this._topics[index];
  }

  filterTopics({ party, verdict, category, search, limit = 100 } = {}) {
    let results = this._applyVisibilityFilter(this._topics);
    if (party && party !== 'ALL') results = results.filter(t => t.party === party);
    if (verdict && verdict !== 'ALL') results = results.filter(t => t.verdict === verdict);
    if (category && category !== 'ALL') results = results.filter(t => t.category === category);
    if (search) {
      const q = search.toLowerCase();
      results = results.filter(t =>
        t.title.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      );
    }
    return results.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);
  }

  // --- Statistics (cached) ---

  getStats() {
    // Return cached stats if fresh
    if (this._statsCache && (Date.now() - this._statsCacheTs) < this._STATS_CACHE_TTL) {
      return this._statsCache;
    }

    const visibleTopics = this._applyVisibilityFilter(this._topics);
    const topics = this.strictRealMode
      ? visibleTopics.filter(topic => this._isEligibleForStats(topic))
      : visibleTopics;
    const total = topics.length;

    const verdictCounts = {};
    Object.keys(VERDICTS).forEach(v => { verdictCounts[v] = 0; });
    topics.forEach(t => { verdictCounts[t.verdict] = (verdictCounts[t.verdict] || 0) + 1; });

    const partyStats = {};
    Object.keys(PARTIES).forEach(p => {
      const pt = topics.filter(t => t.party === p);
      const count = pt.length;
      const hoaxes = pt.filter(t => t.verdict === 'HOAX').length;
      const misleading = pt.filter(t => t.verdict === 'MISLEADING').length;
      const trueCount = pt.filter(t => t.verdict === 'TRUE').length;
      const partial = pt.filter(t => t.verdict === 'PARTIALLY_TRUE').length;
      const unverified = pt.filter(t => t.verdict === 'UNVERIFIED').length;
      const problemScore = count > 0 ? Math.round(((hoaxes + misleading) / count) * 100) : 0;
      const credibilityScore = count > 0 ? Math.round(((trueCount + partial * 0.5) / count) * 100) : 0;
      partyStats[p] = { id: p, total: count, true: trueCount, hoax: hoaxes, misleading, partiallyTrue: partial, unverified, problemScore, credibilityScore, percentage: total > 0 ? Math.round((count / total) * 100) : 0 };
    });

    const categoryCounts = {};
    topics.forEach(t => { categoryCounts[t.category] = (categoryCounts[t.category] || 0) + 1; });

    const monthlyTrend = {};
    topics.forEach(t => {
      const month = t.date.substring(0, 7);
      if (!monthlyTrend[month]) monthlyTrend[month] = { total: 0, hoax: 0, true: 0, misleading: 0 };
      monthlyTrend[month].total++;
      if (t.verdict === 'HOAX') monthlyTrend[month].hoax++;
      if (t.verdict === 'TRUE') monthlyTrend[month].true++;
      if (t.verdict === 'MISLEADING') monthlyTrend[month].misleading++;
    });

    this._statsCache = {
      total, verdictCounts, partyStats, categoryCounts, monthlyTrend,
      hoaxRate: total > 0 ? Math.round((verdictCounts.HOAX / total) * 100) : 0,
      truthRate: total > 0 ? Math.round((verdictCounts.TRUE / total) * 100) : 0,
      dataQuality: this.getDataQualityStats(),
    };
    this._statsCacheTs = Date.now();

    return this._statsCache;
  }

  getDataQualityStats() {
    // Return cached quality stats if fresh
    if (this._qualityCache && (Date.now() - this._qualityCacheTs) < this._STATS_CACHE_TTL) {
      return this._qualityCache;
    }

    const stored = this._topics;
    const visible = this._applyVisibilityFilter(stored);
    const counted = this.strictRealMode
      ? visible.filter(topic => this._isEligibleForStats(topic))
      : visible;

    const sourceTypeCounts = {};
    const verificationBuckets = { VERIFIED: 0, LIKELY_REAL: 0, WEAK: 0, REJECTED: 0, UNKNOWN: 0 };

    for (const topic of visible) {
      const sourceType = topic.sourceType || 'unknown';
      sourceTypeCounts[sourceType] = (sourceTypeCounts[sourceType] || 0) + 1;

      const status = topic.verification?.status || 'UNKNOWN';
      verificationBuckets[status] = (verificationBuckets[status] || 0) + 1;
    }

    const withSourceUrl = visible.filter(topic => this._topicHasSourceUrl(topic)).length;
    const syntheticExcluded = stored.filter(topic => this._isSyntheticTopic(topic)).length;

    this._qualityCache = {
      strictRealMode: this.strictRealMode,
      malaysiaPoliticsOnly: this.malaysiaPoliticsOnly,
      minimumVerificationScore: this.minimumVerificationScore,
      totalStored: stored.length,
      visibleTopics: visible.length,
      countedForStats: counted.length,
      excludedFromStats: stored.length - counted.length,
      syntheticExcluded,
      withSourceUrl,
      sourceTypeCounts,
      verificationBuckets,
      acceptanceRate: visible.length > 0 ? Math.round((counted.length / visible.length) * 100) : 0,
    };
    this._qualityCacheTs = Date.now();

    return this._qualityCache;
  }

  // --- Agent Log ---

  addLog(entry) {
    this._log.push({ ...entry, timestamp: new Date().toISOString() });
    this._saveLog(); // Debounced
  }

  getLog(limit = 50) {
    return this._log.slice(-limit);
  }

  clearLog() {
    this._log = [];
    this._saveLog();
  }

  // --- Reset ---

  reset() {
    this._topics = this.seedOnEmpty
      ? SEED_TOPICS.map(topic => this._normalizeTopic({
          ...topic,
          recordType: 'seed',
          sourceType: 'seed',
          synthetic: true,
          verification: {
            status: 'UNKNOWN',
            score: 0,
            method: 'seed_data',
            verifiedAt: null,
          },
        }))
      : [];
    this._rebuildUrlIndex();
    this._saveNow();
    this._log = [];
    this._saveLog();
  }

  // Simple string similarity (Dice coefficient)
  _similarity(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const bigrams = new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const bigram = a.substring(i, i + 2);
      bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
    }
    let intersect = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const bigram = b.substring(i, i + 2);
      const count = bigrams.get(bigram) || 0;
      if (count > 0) { bigrams.set(bigram, count - 1); intersect++; }
    }
    return (2.0 * intersect) / (a.length + b.length - 2);
  }
}

export const dataManager = new DataManager();
