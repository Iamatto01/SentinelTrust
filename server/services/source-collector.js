import { XMLParser } from 'fast-xml-parser';
import {
  includesAnySignal,
  MALAYSIA_SIGNAL_TERMS,
  NATIONAL_ISSUE_SIGNAL_TERMS,
  POLITICAL_SIGNAL_TERMS,
} from './shared-constants.js';

const DEFAULT_REQUEST_TIMEOUT_MS = parseInt(process.env.COLLECTOR_TIMEOUT_MS || '15000', 10);
const DEFAULT_TARGET_COUNT = parseInt(process.env.COLLECTOR_DEFAULT_TARGET || '1000', 10);
const FACEBOOK_GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v22.0';
const SEARCH_START_DATE = process.env.SEARCH_START_DATE || '2019-01-01';
const SEARCH_END_DATE = process.env.SEARCH_END_DATE || '';

const RSS_FEEDS = [
  // Keep base RSS sources focused on Malaysian outlets.
  'https://www.freemalaysiatoday.com/category/nation/feed/',
  'https://www.freemalaysiatoday.com/category/nation/politics/feed/',
  'https://www.malaymail.com/feed/rss/malaysia',
];

const GOOGLE_NEWS_QUERIES = [
  'Malaysia politics',
  'Malaysia cost of living',
  'Malaysia inflation',
  'Malaysia subsidy policy',
  'Malaysia subsidy cut impact',
  'Malaysia fuel subsidy rationalisation',
  'Malaysia diesel subsidy reform',
  'Malaysia unemployment',
  'Malaysia wages',
  'Malaysia debt burden issue',
  'Malaysia fiscal deficit issue',
  'Malaysia tax policy controversy',
  'Malaysia housing affordability',
  'Malaysia public healthcare',
  'Malaysia hospital issue',
  'Malaysia school education issue',
  'Malaysia public transport issue',
  'Malaysia road safety',
  'Malaysia major accident',
  'Malaysia fatal road crash',
  'Malaysia bus crash',
  'Malaysia train collision',
  'Malaysia fire incident',
  'Malaysia industrial accident',
  'Malaysia crime rate',
  'Malaysia scam cases',
  'Malaysia political crime case',
  'Malaysia minister charged in court',
  'Malaysia MP corruption case',
  'Malaysia abuse of power case',
  'Malaysia money laundering politician',
  'Malaysia flood response',
  'Malaysia landslide',
  'Malaysia water disruption',
  'Malaysia electricity outage',
  'Malaysia climate and haze',
  'Malaysia poverty and welfare',
  'Malaysia strategic asset sale',
  'Malaysia national asset sold foreign',
  'Malaysia foreign ownership strategic company',
  'Malaysia privatisation controversy',
  'Malaysia GLC sale foreign investor',
  'Malaysia sovereignty asset issue',
  'Malaysia governance issue',
  'Malaysia parliament debate',
  'Malaysia corruption case',
  'Malaysia anti corruption',
  'Dewan Rakyat debate',
  'Anwar Ibrahim policy',
  'Malaysia budget policy',
  'Malaysia federal state issue',
  'Malaysia social media claim fact check',
  'Malaysia judiciary issue',
];

const PARTY_TERMS = [
  'PKR', 'AMANAH', 'UMNO', 'PAS', 'BERSATU', 'GPS', 'MUDA',
  'Anwar Ibrahim', 'Democratic Action Party', 'Prime Minister',
  'Finance Minister', 'Cabinet Minister', 'Member of Parliament',
  'Menteri', 'Ahli Parlimen',
];
const TOPIC_TERMS = [
  'cost of living', 'inflation', 'housing affordability', 'wages', 'unemployment',
  'healthcare', 'hospital', 'education', 'school', 'crime',
  'accident', 'fatal crash', 'bus crash', 'train collision', 'fire incident',
  'industrial accident',
  'political crime', 'abuse of power', 'money laundering', 'asset seizure',
  'scam', 'flood', 'landslide', 'water disruption', 'electricity outage',
  'public transport', 'road safety', 'pollution', 'haze', 'poverty',
  'subsidy cut', 'fuel subsidy', 'diesel subsidy', 'fiscal deficit', 'debt burden', 'tax',
  'asset sale', 'national asset', 'strategic asset', 'foreign ownership', 'privatisation', 'sovereignty',
  'social welfare', 'policy', 'governance', 'corruption',
];

const MALAYSIAN_NEWS_DOMAINS = [
  'freemalaysiatoday.com', 'malaymail.com', 'bernama.com',
  'thestar.com.my', 'bharian.com.my', 'astroawani.com',
  'malaysiakini.com', 'thesun.my', 'sinardaily.my',
  'utusan.com.my', 'nst.com.my',
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: true,
  textNodeName: '#text',
  processEntities: false,
});

// ── Pre-built Google News feed URLs (cached at module load) ──────
let _cachedFeedUrls = null;

function toYmd(input, fallback) {
  const raw = String(input || '').trim();
  if (!raw) return fallback;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString().slice(0, 10);
}

function buildGoogleNewsDateFilter() {
  const today = new Date().toISOString().slice(0, 10);
  const start = toYmd(SEARCH_START_DATE, '2019-01-01');
  let end = SEARCH_END_DATE ? toYmd(SEARCH_END_DATE, today) : today;

  if (end < start) {
    end = today;
  }

  return `after:${start} before:${end}`;
}

function buildGoogleNewsFeedUrls() {
  if (_cachedFeedUrls) return _cachedFeedUrls;

  const comboQueries = [];
  for (const party of PARTY_TERMS) {
    for (const topic of TOPIC_TERMS) {
      comboQueries.push(`${party} ${topic} Malaysia`);
    }
  }

  const allQueries = [...new Set([...GOOGLE_NEWS_QUERIES, ...comboQueries])];
  const dateFilter = buildGoogleNewsDateFilter();

  _cachedFeedUrls = allQueries.map((query) => {
    const encodedQuery = encodeURIComponent(`${query} ${dateFilter}`);
    return `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-MY&gl=MY&ceid=MY:en`;
  });

  return _cachedFeedUrls;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function decodeHtml(text = '') {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(text = '') {
  return decodeHtml(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const paramsToDrop = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
      'utm_content', 'fbclid', 'gclid', 'ocid', 'ref', 'ref_src',
    ];
    paramsToDrop.forEach((param) => url.searchParams.delete(param));
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function toIsoDate(input) {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function pickAtomLink(entry) {
  const links = toArray(entry.link);
  const preferred = links.find((link) => link?.rel === 'alternate' && link?.href) || links.find((link) => link?.href);
  if (preferred?.href) return preferred.href;
  if (typeof entry.link === 'string') return entry.link;
  return '';
}

function textFromNode(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    return node['#text'] || node.text || '';
  }
  return '';
}

function normalizeTitle(title = '') {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMalaysiaNationalIssueRecord(record = {}) {
  const combinedText = `${record.title || ''} ${record.summary || ''}`.toLowerCase();
  const hasPartySignal = PARTY_TERMS.some((term) => combinedText.includes(term.toLowerCase()));

  const hasMalaysiaSignal =
    hasPartySignal ||
    includesAnySignal(combinedText, MALAYSIA_SIGNAL_TERMS);

  const hasNationalIssueSignal =
    hasPartySignal ||
    includesAnySignal(combinedText, POLITICAL_SIGNAL_TERMS) ||
    includesAnySignal(combinedText, NATIONAL_ISSUE_SIGNAL_TERMS);

  return hasMalaysiaSignal && hasNationalIssueSignal;
}

function dedupeRecords(records) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const kept = [];

  const sorted = [...records].sort((a, b) => {
    const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bTime - aTime;
  });

  for (const record of sorted) {
    const normalizedUrl = normalizeUrl(record.url);
    const titleKey = normalizeTitle(record.title);

    if (!record.title || !normalizedUrl) continue;
    if (seenUrls.has(normalizedUrl)) continue;
    if (titleKey && seenTitles.has(titleKey)) continue;

    seenUrls.add(normalizedUrl);
    if (titleKey) seenTitles.add(titleKey);

    kept.push({ ...record, url: normalizedUrl, sourceDomain: getDomain(normalizedUrl) });
  }

  return kept;
}

async function fetchWithTimeout(url, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function mapRssItem(item, feedUrl, feedName) {
  const rawLink = textFromNode(item.link) || textFromNode(item.guid);
  const url = normalizeUrl(rawLink);
  const title = stripHtml(textFromNode(item.title));
  const description = stripHtml(textFromNode(item.description) || textFromNode(item['content:encoded']) || textFromNode(item.summary));
  const publishedAt = toIsoDate(item.pubDate || item.published || item.updated || item.dcdate || item['dc:date']);
  const sourceNode = item.source || null;
  const sourceName = stripHtml(textFromNode(sourceNode)) || feedName;
  const sourceUrl = normalizeUrl(sourceNode?.url || '');
  const sourceDomain = getDomain(sourceUrl || url);

  if (!title || !url) return null;

  const summary = description || title;

  return {
    sourceType: 'internet',
    title,
    summary,
    url,
    publishedAt,
    sourceName,
    sourceDomain,
    publisherUrl: sourceUrl || null,
    sourceFeed: feedUrl,
    collectedAt: new Date().toISOString(),
    evidence: [
      { name: sourceName, url: sourceUrl || url, domain: sourceDomain, type: 'article' },
      ...(sourceUrl && sourceUrl !== url ? [{ name: 'Aggregator', url, domain: getDomain(url), type: 'aggregator' }] : []),
    ],
  };
}

function mapAtomEntry(entry, feedUrl, feedName) {
  const rawLink = pickAtomLink(entry);
  const url = normalizeUrl(rawLink);
  const title = stripHtml(textFromNode(entry.title));
  const description = stripHtml(textFromNode(entry.summary) || textFromNode(entry.content));
  const publishedAt = toIsoDate(entry.published || entry.updated || entry.created);

  if (!title || !url) return null;

  return {
    sourceType: 'internet',
    title,
    summary: description || title,
    url,
    publishedAt,
    sourceName: feedName,
    sourceDomain: getDomain(url),
    publisherUrl: null,
    sourceFeed: feedUrl,
    collectedAt: new Date().toISOString(),
    evidence: [{ name: feedName, url, domain: getDomain(url), type: 'article' }],
  };
}

async function collectFromFeed(feedUrl) {
  try {
    const xml = await fetchWithTimeout(feedUrl);
    const parsed = parser.parse(xml);

    if (parsed?.rss?.channel) {
      const channel = parsed.rss.channel;
      const feedName = stripHtml(textFromNode(channel.title)) || getDomain(feedUrl) || 'RSS Feed';
      const items = toArray(channel.item).map((item) => mapRssItem(item, feedUrl, feedName)).filter(Boolean);
      return { success: true, feedUrl, feedName, items };
    }

    if (parsed?.feed) {
      const feed = parsed.feed;
      const feedName = stripHtml(textFromNode(feed.title)) || getDomain(feedUrl) || 'Atom Feed';
      const items = toArray(feed.entry).map((entry) => mapAtomEntry(entry, feedUrl, feedName)).filter(Boolean);
      return { success: true, feedUrl, feedName, items };
    }

    return { success: false, feedUrl, error: 'Unsupported feed format', items: [] };
  } catch (error) {
    return { success: false, feedUrl, error: error.message, items: [] };
  }
}

function parseFacebookPageIds() {
  const fromEnv = (process.env.FACEBOOK_PAGE_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (fromEnv.length > 0) return fromEnv;

  return [
    'bernamaofficial',
    'malaysiakini',
    'themalaysianinsight',
    'TheStarOnline',
    'FMTNews',
  ];
}

async function collectFacebookPagePosts({ pageId, token, limitPerPage }) {
  const records = [];
  const errors = [];

  let nextUrl = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${pageId}/posts?fields=id,message,story,created_time,permalink_url,from&limit=${Math.min(limitPerPage, 100)}&access_token=${encodeURIComponent(token)}`;

  while (nextUrl && records.length < limitPerPage) {
    try {
      const response = await fetch(nextUrl);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      const data = await response.json();
      const posts = toArray(data.data);

      for (const post of posts) {
        const message = stripHtml(post.message || post.story || '');
        const title = message.split(/[.!?]/)[0]?.slice(0, 140).trim() || `Facebook post by ${post.from?.name || pageId}`;
        const url = normalizeUrl(post.permalink_url || '');

        if (!url || !title) continue;

        records.push({
          sourceType: 'facebook',
          title,
          summary: message || title,
          url,
          publishedAt: toIsoDate(post.created_time),
          sourceName: post.from?.name || pageId,
          sourceDomain: 'facebook.com',
          sourceFeed: `facebook:${pageId}`,
          collectedAt: new Date().toISOString(),
          author: post.from?.name || null,
          socialId: post.id || null,
          evidence: [{ name: post.from?.name || pageId, url, domain: 'facebook.com', type: 'facebook_post' }],
        });

        if (records.length >= limitPerPage) break;
      }

      nextUrl = data?.paging?.next || null;
    } catch (error) {
      errors.push({ pageId, error: error.message });
      break;
    }
  }

  return { records, errors };
}

class SourceCollector {
  constructor() {
    this.defaultTargetCount = DEFAULT_TARGET_COUNT;
  }

  async collect({ targetCount = this.defaultTargetCount, includeInternet = true, includeFacebook = true } = {}) {
    const cappedTarget = Math.max(50, Math.min(Number(targetCount) || this.defaultTargetCount, 5000));
    const records = [];
    const feedErrors = [];

    if (includeInternet) {
      const feedUrls = [...new Set([...RSS_FEEDS, ...buildGoogleNewsFeedUrls()])];

      const queue = [...feedUrls];
      const workers = Array.from({ length: Math.min(8, feedUrls.length) }, async () => {
        while (queue.length > 0 && records.length < cappedTarget * 2) {
          const feedUrl = queue.shift();
          if (!feedUrl) break;

          const result = await collectFromFeed(feedUrl);
          if (!result.success) {
            feedErrors.push({ source: feedUrl, error: result.error });
            continue;
          }

          records.push(...result.items);
        }
      });

      await Promise.all(workers);
    }

    if (includeFacebook) {
      const token = process.env.FACEBOOK_ACCESS_TOKEN || '';
      if (!token) {
        feedErrors.push({ source: 'facebook', error: 'FACEBOOK_ACCESS_TOKEN missing; skipped Facebook collection.' });
      } else {
        const pageIds = parseFacebookPageIds();
        const perPageLimit = Math.max(10, Math.ceil(cappedTarget / Math.max(pageIds.length, 1)));

        for (const pageId of pageIds) {
          const facebookData = await collectFacebookPagePosts({ pageId, token, limitPerPage: perPageLimit });
          records.push(...facebookData.records);
          feedErrors.push(...facebookData.errors.map((entry) => ({ source: `facebook:${entry.pageId}`, error: entry.error })));

          if (records.length >= cappedTarget * 2) {
            break;
          }
        }
      }
    }

    const malaysiaNationalIssueRecords = records.filter((record) => isMalaysiaNationalIssueRecord(record));
    const deduped = dedupeRecords(malaysiaNationalIssueRecords).slice(0, cappedTarget);

    return {
      success: true,
      targetCount: cappedTarget,
      collectedCount: records.length,
      malaysiaNationalIssueCount: malaysiaNationalIssueRecords.length,
      malaysiaPoliticalCount: malaysiaNationalIssueRecords.length,
      dedupedCount: deduped.length,
      records: deduped,
      errors: feedErrors,
    };
  }
}

export const sourceCollector = new SourceCollector();