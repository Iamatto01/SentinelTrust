// SentinelTruth v2 — Main Application with API, SSE, i18n
import { Chart, registerables } from 'chart.js';
import { PARTIES, VERDICTS, COALITIONS, getAllPartyIds } from './data/parties.js';
import { t, setLang } from './i18n/translations.js';
import { formatDate, timeAgo, debounce, animateCounter, truncate } from './utils/helpers.js';

Chart.register(...registerables);

// ============================================================
// App State
// ============================================================
const state = {
  currentSection: 'dashboard',
  lang: 'ms',
  filters: { party: 'ALL', verdict: 'ALL', category: 'ALL', search: '', page: 1 },
  charts: {},
  sse: null,
  agentStatus: { status: 'idle', currentAction: '', topicsAnalyzed: 0, queueLength: 0, providers: {} },
  cachedTopics: [],
  cachedStats: null,
  cachedQuality: null,
};

const API = '';
const TOPICS_PAGE_SIZE = 20;

const LOCALE_BY_LANG = {
  en: 'en-MY',
  ms: 'ms-MY',
  hi: 'hi-IN',
  zh: 'zh-CN',
};

const CATEGORY_KEY_MAP = {
  'Coalition Politics': 'categoryCoalitionPolitics',
  Corruption: 'categoryCorruption',
  'Digital Security': 'categoryDigitalSecurity',
  Economy: 'categoryEconomy',
  Education: 'categoryEducation',
  Elections: 'categoryElections',
  Federalism: 'categoryFederalism',
  Governance: 'categoryGovernance',
  Legal: 'categoryLegal',
  Policy: 'categoryPolicy',
  'Racial Politics': 'categoryRacialPolitics',
  'Social Issues': 'categorySocialIssues',
  Legislation: 'categoryLegislation',
  'Foreign Relations': 'categoryForeignRelations',
  'Digital Rights': 'categoryDigitalRights',
  'Party Leadership': 'categoryPartyLeadership',
  'Disaster Management': 'categoryDisasterManagement',
  General: 'categoryGeneral',
};

const COALITION_NAME_KEY_MAP = {
  PH: 'coalitionPH',
  BN: 'coalitionBN',
  PN: 'coalitionPN',
  GPS: 'coalitionGPS',
  Independent: 'coalitionIndependent',
};

const COALITION_STATUS_KEY_MAP = {
  Ruling: 'coalitionStatusRuling',
  'Ruling (Partner)': 'coalitionStatusRulingPartner',
  Opposition: 'coalitionStatusOpposition',
};

const FIXED_LANG = 'ms';

function getUiLocale() {
  return LOCALE_BY_LANG[state.lang] || LOCALE_BY_LANG.ms;
}

function getCategoryLabel(category) {
  const normalized = String(category || '').trim();
  if (!normalized) return '';
  const key = CATEGORY_KEY_MAP[normalized];
  return key ? _(key) : normalized;
}

function getVerdictLabel(verdictKey) {
  if (verdictKey === 'TRUE') return _('verifiedTrueLabel');
  if (verdictKey === 'HOAX') return _('hoax');
  if (verdictKey === 'MISLEADING') return _('misleading');
  if (verdictKey === 'PARTIALLY_TRUE') return _('partiallyTrue');
  if (verdictKey === 'UNVERIFIED') return _('unverified');
  return String(verdictKey || '');
}

function getRegionLabel(region) {
  const normalized = String(region || '').trim();
  if (!normalized || normalized.toLowerCase() === 'national') return _('regionNational');
  return normalized;
}

function getCoalitionNameLabel(coalitionId, fallbackName = '') {
  const key = COALITION_NAME_KEY_MAP[String(coalitionId || '').trim()];
  if (!key) return fallbackName || coalitionId || '';
  return _(key);
}

function getCoalitionStatusLabel(status) {
  const key = COALITION_STATUS_KEY_MAP[String(status || '').trim()];
  return key ? _(key) : (status || '');
}

function getVerificationStatusLabel(status) {
  const normalized = String(status || 'UNKNOWN').toUpperCase();
  if (normalized === 'VERIFIED') return _('statusVerified');
  if (normalized === 'LIKELY_REAL') return _('statusLikelyReal');
  if (normalized === 'WEAK') return _('statusWeak');
  if (normalized === 'REJECTED') return _('statusRejected');
  return _('statusUnknown');
}

function getProviderDisplay(provider) {
  if (provider === 'Groq') return `🤖 ${_('providerGroq')}`;
  if (provider === 'Ollama') return `🦙 ${_('providerOllama')}`;
  if (provider === 'HuggingFace') return `🧩 ${_('providerHuggingFace')}`;
  if (provider === 'SourceVerifier') return `🛡️ ${_('providerSourceVerifier')}`;
  if (provider === 'Heuristic') return `⚡ ${_('providerHeuristic')}`;
  return `❓ ${_('providerUnknown')}`;
}

// ============================================================
// API Helpers + Client-side cache
// ============================================================
const _apiCache = new Map();
const API_CACHE_TTL = 5000; // 5 seconds

async function api(path, opts = {}) {
  // GET requests can be cached
  const isGet = !opts.method || opts.method === 'GET';
  if (isGet) {
    const cached = _apiCache.get(path);
    if (cached && (Date.now() - cached.ts) < API_CACHE_TTL) {
      return cached.data;
    }
  }

  try {
    const res = await fetch(`${API}${path}`, opts);
    const data = await res.json();
    if (isGet && data) {
      _apiCache.set(path, { data, ts: Date.now() });
    }
    return data;
  } catch (err) {
    console.error('API error:', err);
    return null;
  }
}

function invalidateApiCache(pathPrefix = '') {
  if (!pathPrefix) { _apiCache.clear(); return; }
  for (const key of _apiCache.keys()) {
    if (key.startsWith(pathPrefix)) _apiCache.delete(key);
  }
}

async function apiPost(path, body = null) {
  const opts = { method: 'POST' };
  if (body !== null) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  invalidateApiCache(); // POST invalidates all caches
  return api(path, opts);
}

// Debounced SSE render helper — coalesces rapid events
let _sseRenderTimer = null;
function debouncedSSERender(renderFn, delayMs = 500) {
  if (_sseRenderTimer) clearTimeout(_sseRenderTimer);
  _sseRenderTimer = setTimeout(() => {
    _sseRenderTimer = null;
    renderFn();
  }, delayMs);
}

// ============================================================
// i18n Helper
// ============================================================
function _(key, replacements = {}) {
  return t(key, state.lang, replacements);
}

// ============================================================
// SSE — Live progress stream
// ============================================================
function connectSSE() {
  if (state.sse) state.sse.close();

  state.sse = new EventSource(`${API}/api/progress`);

  state.sse.addEventListener('connected', () => {
    console.log('[SSE] Connected to progress stream');
  });

  state.sse.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    state.agentStatus = data;
    updateAgentBadge();
    if (state.currentSection === 'agent') updateAgentUI();
  });

  state.sse.addEventListener('action', (e) => {
    const data = JSON.parse(e.data);
    state.agentStatus.currentAction = data.action;
    if (state.currentSection === 'agent') {
      updateActionBanner(data);
      appendLogEntry(data);
    }
  });

  state.sse.addEventListener('newTopic', (e) => {
    const topic = JSON.parse(e.data);
    if (topic?.id) {
      showToast(`✅ ${_('newTopicToast', { title: topic.title?.substring(0, 50) || '' })}`, 'success');
      invalidateApiCache();
      // Debounced refresh — coalesces rapid SSE bursts into one render
      debouncedSSERender(() => {
        if (state.currentSection === 'dashboard') renderDashboard();
        if (state.currentSection === 'topics') renderTopics();
        if (state.currentSection === 'statistics') renderStatistics();
      }, 500);
    }
  });

  state.sse.addEventListener('ingestionReport', (e) => {
    const report = JSON.parse(e.data);
    state.agentStatus.lastIngestionReport = report;
    showToast(`📥 ${_('ingestionFinishedToast', { n: report.stored })}`, 'success');
    invalidateApiCache();
    debouncedSSERender(() => {
      if (state.currentSection === 'agent') renderAgent();
      if (state.currentSection === 'dashboard') renderDashboard();
      if (state.currentSection === 'statistics') renderStatistics();
    }, 500);
  });

  state.sse.onerror = () => {
    console.log('[SSE] Connection lost, reconnecting in 5s...');
    setTimeout(connectSSE, 5000);
  };
}

function updateAgentBadge() {
  const badge = document.getElementById('agent-status-badge');
  if (!badge) return;
  const dot = badge.querySelector('.status-dot');
  const text = badge.querySelector('.status-text');
  const s = state.agentStatus.status;
  dot.className = `status-dot ${s}`;
  text.textContent = s === 'running' ? _('agentRunning') : s === 'paused' ? _('agentPaused') : _('agentIdle');
}

// ============================================================
// Router
// ============================================================
function navigate(section) {
  state.currentSection = section;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(`section-${section}`);
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.section === section);
  });
  document.getElementById('nav-links')?.classList.remove('active');
  if (section === 'dashboard') renderDashboard();
  else if (section === 'topics') renderTopics();
  else if (section === 'parties') renderParties();
  else if (section === 'statistics') renderStatistics();
  else if (section === 'agent') renderAgent();
}

// ============================================================
// Initialize
// ============================================================
function init() {
  createSections();
  setupNavigation();
  setupModal();
  connectSSE();
  updateNavLabels();

  // Force Malay-only UI and remove language switcher controls.
  state.lang = FIXED_LANG;
  setLang(FIXED_LANG);
  document.documentElement.lang = FIXED_LANG;
  const langSwitcher = document.getElementById('lang-switcher');
  if (langSwitcher) langSwitcher.remove();

  const hash = window.location.hash.slice(1) || 'dashboard';
  navigate(hash);

  window.addEventListener('hashchange', () => {
    navigate(window.location.hash.slice(1) || 'dashboard');
  });

  window.addEventListener('scroll', () => {
    document.getElementById('navbar')?.classList.toggle('scrolled', window.scrollY > 20);
  });

  // Fetch initial agent status
  api('/api/agent/status').then(data => {
    if (data) { state.agentStatus = data; updateAgentBadge(); }
  });
}

function createSections() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <section class="section active" id="section-dashboard"><div class="section-container" id="dashboard-content"></div></section>
    <section class="section" id="section-topics"><div class="section-container" id="topics-content"></div></section>
    <section class="section" id="section-parties"><div class="section-container" id="parties-content"></div></section>
    <section class="section" id="section-statistics"><div class="section-container" id="statistics-content"></div></section>
    <section class="section" id="section-agent"><div class="section-container" id="agent-content"></div></section>
  `;
}

function setupNavigation() {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.hash = link.dataset.section;
    });
  });
  document.getElementById('nav-toggle')?.addEventListener('click', () => {
    document.getElementById('nav-links')?.classList.toggle('active');
  });
}

function setupModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

function updateNavLabels() {
  const sectionToKeyMap = { dashboard: 'dashboard', topics: 'topics', parties: 'parties', statistics: 'statistics', agent: 'aiAgent' };
  document.querySelectorAll('.nav-link').forEach(link => {
    const section = link.dataset.section;
    const labelEl = link.querySelector('.nav-label');
    if (labelEl) labelEl.textContent = _(sectionToKeyMap[section] || section);
  });
}

// ============================================================
// Language Switcher
// ============================================================
window.switchLanguage = function() {
  state.lang = FIXED_LANG;
  setLang(FIXED_LANG);
  document.documentElement.lang = FIXED_LANG;
  updateNavLabels();
  updateAgentBadge();
  navigate(state.currentSection);
};

// ============================================================
// DASHBOARD
// ============================================================
async function renderDashboard() {
  const container = document.getElementById('dashboard-content');
  if (!container) return;

  const stats = await api('/api/stats');
  const topics = await api('/api/topics?limit=6');
  if (!stats || !topics) return;

  state.cachedStats = stats;
  state.cachedTopics = topics;

  const partyLeaderboard = Object.values(stats.partyStats)
    .filter(p => p.total > 0)
    .sort((a, b) => b.credibilityScore - a.credibilityScore);

  const quality = stats.dataQuality || null;
  state.cachedQuality = quality;

  container.innerHTML = `
    <div class="dashboard-hero">
      <div class="hero-badge">🛡️ ${_('heroBadge')}</div>
      <h1 class="hero-title">${_('heroTitle1')} <span class="highlight">${_('heroTruth')}</span> ${_('heroTitle2')}</h1>
      <p class="hero-subtitle">${_('heroSubtitle')}</p>
    </div>

    <div class="stats-grid">
      <div class="stat-card total">
        <div class="stat-card-icon">📊</div>
        <div class="stat-card-value" data-counter="${stats.total}">0</div>
        <div class="stat-card-label">${_('topicsAnalyzed')}</div>
        <div class="stat-card-detail">${_('acrossParties', { n: Object.values(stats.partyStats).filter(p => p.total > 0).length })}</div>
      </div>
      <div class="stat-card hoax">
        <div class="stat-card-icon">🚫</div>
        <div class="stat-card-value" data-counter="${stats.verdictCounts.HOAX || 0}">0</div>
        <div class="stat-card-label">${_('hoaxesDetected')}</div>
        <div class="stat-card-detail">${_('ofAllClaims', { n: stats.hoaxRate })}</div>
      </div>
      <div class="stat-card truth">
        <div class="stat-card-icon">✅</div>
        <div class="stat-card-value" data-counter="${stats.verdictCounts.TRUE || 0}">0</div>
        <div class="stat-card-label">${_('verifiedTrue')}</div>
        <div class="stat-card-detail">${_('accuracyRate', { n: stats.truthRate })}</div>
      </div>
      <div class="stat-card parties">
        <div class="stat-card-icon">🏛️</div>
        <div class="stat-card-value" data-counter="${Object.values(stats.partyStats).filter(p => p.total > 0).length}">0</div>
        <div class="stat-card-label">${_('partiesTracked')}</div>
        <div class="stat-card-detail">PH · PN · BN · GPS</div>
      </div>
    </div>

    ${quality ? `
      <div class="quality-panel">
        <div class="quality-title">🔎 ${_('realDataTransparency')}</div>
        <div class="quality-subtitle">${_('strictModeLine', { mode: quality.strictRealMode ? _('modeOn') : _('modeOff'), score: quality.minimumVerificationScore })}</div>
        <div class="quality-grid">
          <div class="quality-item"><div class="quality-value">${quality.totalStored}</div><div class="quality-label">${_('storedRecords')}</div></div>
          <div class="quality-item"><div class="quality-value">${quality.visibleTopics}</div><div class="quality-label">${_('visibleRealRecords')}</div></div>
          <div class="quality-item"><div class="quality-value">${quality.countedForStats}</div><div class="quality-label">${_('countedInStatistics')}</div></div>
          <div class="quality-item"><div class="quality-value">${quality.excludedFromStats}</div><div class="quality-label">${_('excludedFromStatistics')}</div></div>
          <div class="quality-item"><div class="quality-value">${quality.syntheticExcluded}</div><div class="quality-label">${_('syntheticExcluded')}</div></div>
          <div class="quality-item"><div class="quality-value">${quality.acceptanceRate}%</div><div class="quality-label">${_('acceptanceRate')}</div></div>
        </div>
      </div>
    ` : ''}

    <div class="dashboard-grid">
      <div class="dashboard-panel">
        <div class="panel-header">
          <div class="panel-title">📰 ${_('recentTopics')}</div>
          <button class="panel-action" onclick="window.location.hash='topics'">${_('viewAll')}</button>
        </div>
        <div id="recent-topics-list">
          ${topics.map(t => renderRecentTopicItem(t)).join('')}
        </div>
      </div>
      <div class="dashboard-panel">
        <div class="panel-header">
          <div class="panel-title">🏆 ${_('partyCredibility')}</div>
          <button class="panel-action" onclick="window.location.hash='statistics'">${_('details')}</button>
        </div>
        <div id="party-leaderboard">
          ${partyLeaderboard.map((p, i) => renderLeaderboardItem(p, i + 1)).join('')}
        </div>
      </div>
    </div>

    <div class="charts-grid dashboard-charts-grid">
      <div class="chart-panel">
        <div class="chart-title">📊 ${_('overallVerdict')}</div>
        <div class="chart-wrapper"><canvas id="dashboard-chart-verdict"></canvas></div>
      </div>
      <div class="chart-panel">
        <div class="chart-title">📁 ${_('topicsByCategory')}</div>
        <div class="chart-wrapper"><canvas id="dashboard-chart-category"></canvas></div>
      </div>
    </div>
  `;

  setTimeout(() => {
    container.querySelectorAll('[data-counter]').forEach(el => animateCounter(el, parseInt(el.dataset.counter)));
  }, 200);

  setTimeout(() => {
    renderDashboardCharts(stats);
  }, 150);

  container.querySelectorAll('.recent-topic-item').forEach(item => {
    item.addEventListener('click', () => openTopicModal(item.dataset.topicId));
  });
}

function renderDashboardCharts(stats) {
  if (state.charts.dashboardVerdict) {
    state.charts.dashboardVerdict.destroy();
    delete state.charts.dashboardVerdict;
  }
  if (state.charts.dashboardCategory) {
    state.charts.dashboardCategory.destroy();
    delete state.charts.dashboardCategory;
  }

  const verdictCanvas = document.getElementById('dashboard-chart-verdict');
  if (verdictCanvas) {
    state.charts.dashboardVerdict = new Chart(verdictCanvas, {
      type: 'doughnut',
      data: {
        labels: Object.keys(VERDICTS).map(getVerdictLabel),
        datasets: [{
          data: Object.keys(VERDICTS).map(k => stats.verdictCounts[k] || 0),
          backgroundColor: ['rgba(34,197,94,0.8)','rgba(239,68,68,0.8)','rgba(245,158,11,0.8)','rgba(107,114,128,0.8)','rgba(234,179,8,0.8)'],
          borderWidth: 0,
          hoverOffset: 8,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { padding: 12, usePointStyle: true, pointStyle: 'circle' },
          },
        },
      },
    });
  }

  const categoryCanvas = document.getElementById('dashboard-chart-category');
  if (categoryCanvas) {
    const categories = Object.entries(stats.categoryCounts || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    state.charts.dashboardCategory = new Chart(categoryCanvas, {
      type: 'bar',
      data: {
        labels: categories.map(([name]) => getCategoryLabel(name)),
        datasets: [{
          label: _('topicsByCategory'),
          data: categories.map(([, count]) => count),
          backgroundColor: categories.map((_, i) => `hsla(${(i * 37 + 220) % 360}, 65%, 56%, 0.72)`),
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.05)' } },
        },
      },
    });
  }
}

function renderRecentTopicItem(topic) {
  const verdictClass = topic.verdict.toLowerCase().replace('_', '-');
  const party = PARTIES[topic.party];
  const title = topic.translations?.[state.lang]?.title || topic.title;
  const categoryLabel = getCategoryLabel(topic.category);
  return `
    <div class="recent-topic-item" data-topic-id="${topic.id}">
      <div class="topic-verdict-dot ${verdictClass}"></div>
      <div class="recent-topic-content">
        <div class="recent-topic-title">${title}</div>
        <div class="recent-topic-meta">
          <span style="color: ${party?.color || '#888'}">${topic.party}</span>
          <span>·</span><span>${categoryLabel}</span>
          <span>·</span><span>${timeAgo(topic.date)}</span>
        </div>
      </div>
    </div>
  `;
}

function renderLeaderboardItem(ps, rank) {
  const party = PARTIES[ps.id];
  if (!party) return '';
  return `
    <div class="leaderboard-item">
      <div class="leaderboard-rank">#${rank}</div>
      <div class="leaderboard-party-dot" style="background: ${party.color}"></div>
      <div class="leaderboard-info">
        <div class="leaderboard-party-name">${party.abbr}</div>
        <div class="leaderboard-bar-container"><div class="leaderboard-bar" style="width: ${ps.credibilityScore}%; background: ${party.color}"></div></div>
      </div>
      <div class="leaderboard-score">${ps.credibilityScore}%</div>
    </div>
  `;
}

// ============================================================
// TOPICS FEED
// ============================================================
async function renderTopics() {
  const container = document.getElementById('topics-content');
  if (!container) return;

  const params = new URLSearchParams();
  if (state.filters.party !== 'ALL') params.set('party', state.filters.party);
  if (state.filters.verdict !== 'ALL') params.set('verdict', state.filters.verdict);
  if (state.filters.category !== 'ALL') params.set('category', state.filters.category);
  if (state.filters.search) params.set('search', state.filters.search);
  params.set('limit', '500');

  // Single API call (was double-fetching before)
  const topics = await api(`/api/topics?${params.toString()}`);
  if (!topics) return;
  // Use the same result for categories — avoid second request
  const allTopicsRaw = topics;

  const sorted = [...topics].sort((a, b) => new Date(b.date) - new Date(a.date));
  const totalPages = Math.max(1, Math.ceil(sorted.length / TOPICS_PAGE_SIZE));
  state.filters.page = Math.min(Math.max(state.filters.page || 1, 1), totalPages);
  const pageStart = (state.filters.page - 1) * TOPICS_PAGE_SIZE;
  const pagedTopics = sorted.slice(pageStart, pageStart + TOPICS_PAGE_SIZE);
  const allCategories = [...new Set((allTopicsRaw || []).map(t => t.category))].filter(Boolean).sort();

  container.innerHTML = `
    <div class="hero-search-section">
      <div class="hero-search-title">${_('searchHeroTitle')}</div>
      <div class="hero-search-sub">${_('searchHeroSub')}</div>
      <div class="hero-search-bar">
        <span class="hero-search-icon">🔍</span>
        <input type="text" id="search-input" placeholder="${_('searchPlaceholder')}" value="${state.filters.search}" autofocus />
        ${state.filters.search ? `<button class="search-clear" id="search-clear-btn">✕</button>` : ''}
      </div>
      <div class="hero-search-hint">${_('searchHint')}</div>
    </div>

    <div class="topics-header">
      <div>
        <h2 class="topics-title">${_('politicalTopics')}</h2>
        <div class="topics-count">${_('topicsFound', { n: sorted.length })} · ${_('sortedNewest')} · ${_('pageStatus', { page: state.filters.page, pages: totalPages })}</div>
      </div>
    </div>
    <div class="filter-row">
      <div class="filter-group">
        <span class="filter-label">${_('verdict')}</span>
        <button class="filter-chip ${state.filters.verdict === 'ALL' ? 'active' : ''}" data-filter="verdict" data-value="ALL">${_('all')}</button>
        ${Object.entries(VERDICTS).map(([key, v]) => `
          <button class="filter-chip ${state.filters.verdict === key ? 'active' : ''}" data-filter="verdict" data-value="${key}">${v.icon} ${_(key === 'TRUE' ? 'verifiedTrueLabel' : key === 'HOAX' ? 'hoax' : key === 'MISLEADING' ? 'misleading' : key === 'UNVERIFIED' ? 'unverified' : 'partiallyTrue')}</button>
        `).join('')}
      </div>
    </div>
    <div class="filter-row">
      <div class="filter-group">
        <span class="filter-label">${_('party')}</span>
        <button class="filter-chip ${state.filters.party === 'ALL' ? 'active' : ''}" data-filter="party" data-value="ALL">${_('allParties')}</button>
        ${getAllPartyIds().map(id => {
          const p = PARTIES[id];
          return `<button class="filter-chip party-chip ${state.filters.party === id ? 'active' : ''}" data-filter="party" data-value="${id}"><span class="party-chip-dot" style="background: ${p.color}"></span>${p.abbr}</button>`;
        }).join('')}
      </div>
    </div>
    <div class="filter-row">
      <div class="filter-group">
        <span class="filter-label">${_('category')}</span>
        <button class="filter-chip ${state.filters.category === 'ALL' ? 'active' : ''}" data-filter="category" data-value="ALL">${_('all')}</button>
        ${allCategories.map(cat => `<button class="filter-chip ${state.filters.category === cat ? 'active' : ''}" data-filter="category" data-value="${cat}">${getCategoryLabel(cat)}</button>`).join('')}
      </div>
    </div>
    ${sorted.length > 0
      ? `<div class="topics-feed">${pagedTopics.map(t => renderTopicFeedItem(t)).join('')}</div>${renderTopicsPagination(state.filters.page, totalPages)}`
      : `<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-text">${_('noTopics')}</div><div class="empty-state-sub">${_('tryAdjusting')}</div></div>`}
  `;

  container.querySelector('#search-input')?.addEventListener('input', debounce((e) => {
    state.filters.search = e.target.value;
    state.filters.page = 1;
    renderTopics();
  }, 300));
  container.querySelector('#search-clear-btn')?.addEventListener('click', () => {
    state.filters.search = '';
    state.filters.page = 1;
    renderTopics();
  });
  container.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      state.filters[chip.dataset.filter] = chip.dataset.value;
      state.filters.page = 1;
      renderTopics();
    });
  });
  container.querySelectorAll('.pagination-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const nextPage = Number(btn.dataset.page);
      if (!Number.isFinite(nextPage)) return;
      state.filters.page = Math.min(totalPages, Math.max(1, nextPage));
      renderTopics();
    });
  });
  container.querySelectorAll('.feed-topic-item').forEach(item => {
    item.addEventListener('click', () => openTopicModal(item.dataset.topicId));
  });
}

function getVisiblePageNumbers(currentPage, totalPages, maxButtons = 5) {
  if (totalPages <= maxButtons) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const half = Math.floor(maxButtons / 2);
  let start = Math.max(1, currentPage - half);
  let end = Math.min(totalPages, start + maxButtons - 1);

  if (end - start + 1 < maxButtons) {
    start = Math.max(1, end - maxButtons + 1);
  }

  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function renderTopicsPagination(currentPage, totalPages) {
  if (totalPages <= 1) return '';

  const pages = getVisiblePageNumbers(currentPage, totalPages, 5);

  return `
    <div class="topics-pagination" role="navigation" aria-label="${_('paginationAria')}">
      <button class="pagination-btn nav ${currentPage === 1 ? 'disabled' : ''}" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>${_('paginationPrev')}</button>
      ${pages.map(p => `<button class="pagination-btn number ${p === currentPage ? 'active' : ''}" data-page="${p}" ${p === currentPage ? 'aria-current="page"' : ''}>${p}</button>`).join('')}
      <button class="pagination-btn nav ${currentPage === totalPages ? 'disabled' : ''}" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>${_('paginationNext')}</button>
    </div>
  `;
}

function getConfidenceInfo(conf) {
  if (conf === 'high') return { color: 'var(--color-true)', label: '●●●', text: _('confidenceHigh') };
  if (conf === 'medium') return { color: 'var(--color-misleading)', label: '●●○', text: _('confidenceMedium') };
  return { color: 'var(--color-unverified)', label: '●○○', text: _('confidenceLow') };
}

function renderTopicFeedItem(topic) {
  const party = PARTIES[topic.party];
  const verdict = VERDICTS[topic.verdict];
  const verdictClass = topic.verdict.toLowerCase().replace('_', '-');
  const verdictLabel = getVerdictLabel(topic.verdict);
  const title = topic.translations?.[state.lang]?.title || topic.title;
  const summary = topic.translations?.[state.lang]?.summary || topic.summary;
  const categoryLabel = getCategoryLabel(topic.category);
  const regionLabel = getRegionLabel(topic.region);
  const conf = getConfidenceInfo(topic.confidence);
  const vScore = topic.verification?.score;
  return `
    <div class="feed-topic-item" data-topic-id="${topic.id}">
      <div class="feed-verdict-col">
        <span class="group-topic-verdict ${verdictClass}">${verdict?.icon || '•'}</span>
      </div>
      <div class="feed-body">
        <div class="feed-title">${title}</div>
        <div class="feed-summary">${truncate(summary || '', 180)}</div>
        <div class="feed-meta">
          <span class="feed-party" style="color: ${party?.color || '#888'}">${topic.party}</span>
          <span>·</span><span>${categoryLabel}</span>
          ${topic.region ? `<span>·</span><span>📍 ${regionLabel}</span>` : ''}
          <span>·</span><span class="feed-date">📅 ${formatDate(topic.date)}</span>
          ${topic.impact === 'high' ? `<span>·</span><span style="color:#ef4444">⚡ ${_('highImpact')}</span>` : ''}
          <span>·</span><span style="color:${conf.color}" title="${_('confidence')}: ${conf.text}">${conf.label} ${conf.text}</span>
          ${vScore !== undefined ? `<span>·</span><span title="${_('sourceVerificationScore')}">🛡️ ${vScore}/100</span>` : ''}
        </div>
      </div>
      <div class="feed-verdict-badge">
        <span class="verdict-badge ${verdictClass}">${verdict?.icon || ''} ${verdictLabel}</span>
      </div>
    </div>
  `;
}

function normalizeRegionLabel(region) {
  return String(region || '').trim() || 'National';
}

// ============================================================
// PARTIES SECTION
// ============================================================
const PARTY_MEMBERS = {
  PKR: [
    { name: 'Anwar Ibrahim', role: 'President / Prime Minister', title: 'YAB' },
    { name: 'Rafizi Ramli', role: 'Deputy President / Economy Minister', title: 'YB' },
    { name: 'Nurul Izzah Anwar', role: 'Vice President', title: 'YB' },
    { name: 'Saifuddin Nasution', role: 'Secretary-General / Home Minister', title: 'YB' },
    { name: 'Fuziah Salleh', role: 'Vice President', title: 'YB' },
    { name: 'Johari Abdul', role: 'Treasurer / Finance Minister II', title: 'YB' },
    { name: 'Nik Nazmi Nik Ahmad', role: 'Natural Resources & Environment Minister', title: 'YB' },
    { name: 'Hannah Yeoh', role: 'Women, Family & Community Development Minister', title: 'YB' },
  ],
  DAP: [
    { name: 'Anthony Loke', role: 'Secretary-General / Transport Minister', title: 'YB' },
    { name: 'Lim Guan Eng', role: 'Chairman', title: 'YB' },
    { name: 'Gobind Singh Deo', role: 'Communications Minister', title: 'YB' },
    { name: 'RSN Rayer', role: 'Deputy Minister', title: 'YB' },
    { name: 'Nga Kor Ming', role: 'Local Government & Housing Minister', title: 'YB' },
    { name: 'Steven Sim', role: 'Human Resources Minister', title: 'YB' },
    { name: 'Ong Kian Ming', role: 'Deputy Minister II', title: 'YB' },
  ],
  AMANAH: [
    { name: 'Mohamad Sabu', role: 'President / Defence Minister', title: 'YB' },
    { name: 'Salahuddin Ayub', role: 'Deputy President / Agriculture Minister', title: 'YB' },
    { name: 'Mujahid Yusof Rawa', role: 'Secretary-General', title: 'YB' },
    { name: 'Siti Zailah Mohd Yusoff', role: 'Deputy Women Minister', title: 'YB' },
  ],
  UMNO: [
    { name: 'Ahmad Zahid Hamidi', role: 'President / Deputy PM', title: 'YAB' },
    { name: 'Mohamad Hassan', role: 'Deputy President', title: 'YB' },
    { name: 'Khaled Nordin', role: 'Vice President / Higher Education Minister', title: 'YB' },
    { name: 'Zambry Abd Kadir', role: 'Foreign Affairs Minister', title: 'YB' },
    { name: 'Annuar Musa', role: 'Federal Territories Minister', title: 'YB' },
    { name: 'Noraini Ahmad', role: 'Science & Technology Minister', title: 'YB' },
    { name: 'Hishammuddin Hussein', role: 'Special Envoy', title: 'YB' },
  ],
  PAS: [
    { name: 'Abdul Hadi Awang', role: 'President', title: 'YB' },
    { name: 'Tuan Ibrahim Tuan Man', role: 'Deputy President', title: 'YB' },
    { name: 'Khairuddin Aman Razali', role: 'Secretary-General', title: 'YB' },
    { name: 'Idris Ahmad', role: 'Information Chief', title: 'YB' },
    { name: 'Ahmad Samsuri Mokhtar', role: 'Terengganu MB', title: 'YAB' },
    { name: 'Mohd Sanusi Md Nor', role: 'Kedah MB', title: 'YAB' },
    { name: 'Nasruddin Hassan', role: 'Youth Wing Chief', title: 'YB' },
  ],
  BERSATU: [
    { name: 'Hamzah Zainudin', role: 'President', title: 'YB' },
    { name: 'Faizal Azumu', role: 'Deputy President', title: 'YB' },
    { name: 'Muhyiddin Yassin', role: 'Supreme Council Member / Former PM', title: 'Tan Sri' },
    { name: 'Radzi Jidin', role: 'Information Chief', title: 'YB' },
    { name: 'Amirudin Hamzah', role: 'Secretary-General', title: 'YB' },
  ],
  GPS: [
    { name: 'Abang Johari Openg', role: 'Chairman / Sarawak CM', title: 'YAB' },
    { name: 'Fadillah Yusof', role: 'Deputy Chairman / Deputy PM II', title: 'YAB' },
    { name: 'Abdul Karim Rahman Hamzah', role: 'Tourism Minister', title: 'YB' },
    { name: 'Julaihi Narawi', role: 'Deputy CM I Sarawak', title: 'YB' },
    { name: 'Awang Tengah Ali Hasan', role: 'Deputy CM II Sarawak', title: 'YB' },
    { name: 'Wan Junaidi Tuanku Jaafar', role: 'Deputy Speaker', title: 'YB' },
  ],
  MUDA: [
    { name: 'Syed Saddiq Abdul Rahman', role: 'Chairman / MP Muar', title: 'YB' },
    { name: 'Amira Aisya', role: 'Dept. Secretary-General', title: 'YB' },
  ],
};

async function renderParties() {
  const container = document.getElementById('parties-content');
  if (!container) return;

  const stats = state.cachedStats || await api('/api/stats');
  if (stats) state.cachedStats = stats;

  const coalitionOrder = ['PH', 'BN', 'PN', 'GPS', 'Independent'];
  const byCoalition = {};
  coalitionOrder.forEach(c => byCoalition[c] = []);
  Object.values(PARTIES).forEach(p => {
    if (byCoalition[p.coalition]) byCoalition[p.coalition].push(p);
    else byCoalition['Independent'] = [...(byCoalition['Independent'] || []), p];
  });

  container.innerHTML = `
    <div class="parties-page-header">
      <h1 class="stats-page-title">🏛️ ${_('partiesTitle')}</h1>
      <p class="stats-page-subtitle">${_('partiesSubtitle')}</p>
    </div>
    ${coalitionOrder.map(coalId => {
      const parties = byCoalition[coalId];
      if (!parties || parties.length === 0) return '';
      const coalition = COALITIONS[coalId];
      return `
        <div class="coalition-section">
          <div class="coalition-header">
            <div class="coalition-dot" style="background: ${coalition?.color || '#888'}"></div>
            <div>
              <div class="coalition-name">${getCoalitionNameLabel(coalId, coalition?.name || coalId)}</div>
              <div class="coalition-status">${getCoalitionStatusLabel(coalition?.status || '')}</div>
            </div>
          </div>
          <div class="party-member-grid">
            ${parties.map(p => renderPartyMemberCard(p, stats)).join('')}
          </div>
        </div>
      `;
    }).join('')}
  `;

  container.querySelectorAll('.party-expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const list = btn.closest('.party-member-card').querySelector('.member-list-full');
      const preview = btn.closest('.party-member-card').querySelector('.member-list-preview');
      if (list.style.display === 'none') {
        list.style.display = 'block';
        preview.style.display = 'none';
        btn.textContent = _('showLess');
      } else {
        list.style.display = 'none';
        preview.style.display = 'block';
        btn.textContent = _('showMore');
      }
    });
  });
}

function renderPartyMemberCard(party, stats) {
  const ps = stats?.partyStats?.[party.id];
  const members = PARTY_MEMBERS[party.id] || [];
  const coalition = COALITIONS[party.coalition];
  const scoreColor = !ps ? '#888' : ps.credibilityScore >= 60 ? 'var(--color-true)' : ps.credibilityScore >= 40 ? 'var(--color-misleading)' : 'var(--color-hoax)';
  const preview = members.slice(0, 3);
  const rest = members.slice(3);

  return `
    <div class="party-member-card" style="--party-color: ${party.color}">
      <div class="party-member-card-top">
        <div class="party-member-badge" style="background: ${party.colorLight}; border-color: ${party.color}40">
          <div class="party-member-abbr" style="color: ${party.color}">${party.abbr}</div>
          <div class="party-member-fullname">${party.name}</div>
        </div>
        <div class="party-member-score">
          ${ps ? `<div class="score-value" style="color:${scoreColor}">${ps.credibilityScore}%</div><div class="score-label">${_('credibilityScore')}</div>` : `<div class="score-label" style="color:var(--text-muted)">${_('noDataYet')}</div>`}
        </div>
      </div>
      ${ps ? `
        <div class="party-mini-stats">
          <span style="color:var(--color-true)">✅ ${ps.true}</span>
          <span style="color:var(--color-hoax)">🚫 ${ps.hoax}</span>
          <span style="color:var(--color-misleading)">⚠️ ${ps.misleading}</span>
          <span style="color:var(--text-muted)">❓ ${ps.unverified || 0}</span>
        </div>
      ` : ''}
      <div class="party-member-info">${party.description}</div>
      <div class="coalition-tag" style="color:${coalition?.color || '#888'}">${getCoalitionNameLabel(party.coalition, coalition?.name || party.coalition)}</div>
      <div class="members-heading">${_('keyMembers')}</div>
      <div class="member-list-preview">
        ${preview.map(m => `
          <div class="member-row">
            <div class="member-avatar" style="background: ${party.colorLight}; border: 2px solid ${party.color}40">${m.name.split(' ').map(w=>w[0]).join('').substring(0,2)}</div>
            <div class="member-info">
              <div class="member-name">${m.title ? m.title + ' ' : ''}${m.name}</div>
              <div class="member-role">${m.role}</div>
            </div>
          </div>
        `).join('')}
      </div>
      ${rest.length > 0 ? `
        <div class="member-list-full" style="display:none">
          ${rest.map(m => `
            <div class="member-row">
              <div class="member-avatar" style="background: ${party.colorLight}; border: 2px solid ${party.color}40">${m.name.split(' ').map(w=>w[0]).join('').substring(0,2)}</div>
              <div class="member-info">
                <div class="member-name">${m.title ? m.title + ' ' : ''}${m.name}</div>
                <div class="member-role">${m.role}</div>
              </div>
            </div>
          `).join('')}
        </div>
        <button class="party-expand-btn">${_('showMore')}</button>
      ` : ''}
    </div>
  `;
}

function buildRegionTopicGroups(topics) {
  const groups = new Map();
  topics.forEach((topic) => {
    const region = normalizeRegionLabel(topic.region);
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(topic);
  });

  return [...groups.entries()]
    .map(([key, items]) => ({ key, label: key, items }))
    .sort((a, b) => {
      const aNational = a.label.toLowerCase() === 'national';
      const bNational = b.label.toLowerCase() === 'national';
      if (aNational !== bNational) return aNational ? -1 : 1;
      return b.items.length - a.items.length || a.label.localeCompare(b.label);
    });
}

function buildPartyTopicGroups(topics) {
  const order = getAllPartyIds();
  const buckets = new Map(order.map((id) => [id, []]));
  const unknown = [];

  topics.forEach((topic) => {
    if (buckets.has(topic.party)) buckets.get(topic.party).push(topic);
    else unknown.push(topic);
  });

  const groups = order
    .map((id) => ({
      key: id,
      label: PARTIES[id]?.abbr || id,
      party: PARTIES[id] || null,
      items: buckets.get(id) || [],
    }))
    .filter((group) => group.items.length > 0);

  if (unknown.length > 0) {
    groups.push({ key: 'UNKNOWN', label: _('unknownParty'), party: null, items: unknown });
  }

  return groups;
}

function renderGroupedTopicGroup(group, mode) {
  const heading = mode === 'party'
    ? `<span class="group-heading-party"><span class="group-heading-dot" style="background:${group.party?.color || '#666'}"></span>${group.label}</span>`
    : group.label;

  return `
    <div class="topics-subgroup">
      <div class="topics-subgroup-header">
        <div class="topics-subgroup-title">${heading}</div>
        <div class="topics-subgroup-count">${group.items.length}</div>
      </div>
      <div class="topics-subgroup-list">
        ${group.items.map((topic) => renderGroupedTopicItem(topic, mode)).join('')}
      </div>
    </div>
  `;
}

function renderGroupedTopicItem(topic, mode) {
  const party = PARTIES[topic.party];
  const verdict = VERDICTS[topic.verdict];
  const verdictClass = topic.verdict.toLowerCase().replace('_', '-');
  const verdictLabel = getVerdictLabel(topic.verdict);
  const title = topic.translations?.[state.lang]?.title || topic.title;
  const region = normalizeRegionLabel(topic.region);
  const context = mode === 'region' ? (party?.abbr || topic.party || _('unknownParty')) : getRegionLabel(region);
  const contextStyle = mode === 'region' ? `color:${party?.color || '#8b8ba3'};` : '';

  return `
    <button class="group-topic-item" data-topic-id="${topic.id}" type="button">
      <span class="group-topic-verdict ${verdictClass}">${verdict?.icon || '•'}</span>
      <span class="group-topic-body">
        <span class="group-topic-title">${truncate(title, 140)}</span>
        <span class="group-topic-meta">
          <span class="group-topic-context" style="${contextStyle}">${context}</span>
          <span>·</span>
          <span>${getCategoryLabel(topic.category)}</span>
          <span>·</span>
          <span>${formatDate(topic.date)}</span>
        </span>
      </span>
    </button>
  `;
}

function renderTopicCard(topic) {
  const party = PARTIES[topic.party];
  const verdict = VERDICTS[topic.verdict];
  const verdictClass = topic.verdict.toLowerCase().replace('_', '-');
  const verdictLabel = getVerdictLabel(topic.verdict);
  const title = topic.translations?.[state.lang]?.title || topic.title;
  const summary = topic.translations?.[state.lang]?.summary || topic.summary;

  return `
    <div class="topic-card verdict-${verdictClass}" data-topic-id="${topic.id}">
      <div class="topic-card-header">
        <div class="topic-card-title">${title}</div>
        <span class="verdict-badge ${verdictClass}">${verdict?.icon || ''} ${verdictLabel}</span>
      </div>
      <div class="topic-card-summary">${summary}</div>
      <div class="topic-card-footer">
        <div class="topic-tags">
          <span class="party-tag" style="background: ${party?.colorLight || 'rgba(255,255,255,0.05)'}; color: ${party?.color || '#888'}"><span style="width:6px;height:6px;border-radius:50%;background:${party?.color || '#888'};display:inline-block"></span> ${topic.party}</span>
          <span class="category-tag">${getCategoryLabel(topic.category)}</span>
          ${topic.impact === 'high' ? `<span class="category-tag" style="border-color: rgba(239,68,68,0.3); color: #ef4444;">⚡ ${_('highImpact')}</span>` : ''}
          ${topic.aiProvider ? `<span class="category-tag" style="border-color: rgba(124,58,237,0.3); color: var(--text-accent);">${getProviderDisplay(topic.aiProvider)}</span>` : ''}
        </div>
        <span class="topic-date">${formatDate(topic.date)}</span>
      </div>
    </div>
  `;
}

// ============================================================
// STATISTICS
// ============================================================
async function renderStatistics() {
  const container = document.getElementById('statistics-content');
  if (!container) return;
  const stats = await api('/api/stats');
  if (!stats) return;

  const quality = stats.dataQuality || null;

  container.innerHTML = `
    <div class="stats-page-header">
      <h1 class="stats-page-title">📈 ${_('statsTitle')}</h1>
      <p class="stats-page-subtitle">${_('statsSubtitle')}</p>
      ${quality ? `<p class="stats-page-subtitle" style="font-size:0.9rem; margin-top: 8px; color: var(--text-muted);">${_('statsQualityLine', { counted: quality.countedForStats, total: quality.totalStored, excluded: quality.excludedFromStats, mode: quality.strictRealMode ? _('modeOn') : _('modeOff') })}</p>` : ''}
    </div>
    <div class="charts-grid">
      <div class="chart-panel"><div class="chart-title">🎯 ${_('verdictByParty')}</div><div class="chart-wrapper"><canvas id="chart-party-verdicts"></canvas></div></div>
      <div class="chart-panel"><div class="chart-title">🔴 ${_('problemScore')}</div><div class="chart-wrapper"><canvas id="chart-problem-score"></canvas></div></div>
      <div class="chart-panel"><div class="chart-title">📊 ${_('overallVerdict')}</div><div class="chart-wrapper"><canvas id="chart-verdict-donut"></canvas></div></div>
      <div class="chart-panel"><div class="chart-title">📁 ${_('topicsByCategory')}</div><div class="chart-wrapper"><canvas id="chart-category"></canvas></div></div>
      <div class="chart-panel full-width"><div class="chart-title">📅 ${_('monthlyTrend')}</div><div class="chart-wrapper"><canvas id="chart-trend"></canvas></div></div>
    </div>
    <div class="stats-page-header" style="margin-top: var(--space-xl)">
      <h2 class="stats-page-title">🏛️ ${_('partyProfiles')}</h2>
      <p class="stats-page-subtitle">${_('partyProfilesSub')}</p>
    </div>
    <div class="party-cards-grid">${Object.keys(PARTIES).filter(p => stats.partyStats[p]?.total > 0).map(p => renderPartyCard(p, stats.partyStats[p])).join('')}</div>
  `;
  setTimeout(() => renderCharts(stats), 100);
}

function renderPartyCard(partyId, ps) {
  const party = PARTIES[partyId];
  const coalition = COALITIONS[party.coalition];
  const scoreColor = ps.credibilityScore >= 60 ? 'var(--color-true)' : ps.credibilityScore >= 40 ? 'var(--color-misleading)' : 'var(--color-hoax)';
  const trueW = ps.total > 0 ? (ps.true / ps.total * 100) : 0;
  const hoaxW = ps.total > 0 ? (ps.hoax / ps.total * 100) : 0;
  const misleadW = ps.total > 0 ? (ps.misleading / ps.total * 100) : 0;
  const partialW = ps.total > 0 ? (ps.partiallyTrue / ps.total * 100) : 0;

  return `
    <div class="party-profile-card" style="--party-color: ${party.color}">
      <style>.party-profile-card[style*="${party.color}"]::before { background: ${party.gradient}; }</style>
      <div class="party-card-header">
        <div class="party-card-name" style="color: ${party.color}">${party.abbr}</div>
        <div class="party-card-coalition">${getCoalitionNameLabel(party.coalition, coalition?.name || party.coalition)}</div>
      </div>
      <div class="party-card-score">
        <div class="score-value" style="color: ${scoreColor}">${ps.credibilityScore}%</div>
        <div class="score-label">${_('credibilityScore')}</div>
      </div>
      <div class="party-card-stats">
        <div class="party-stat-item"><div class="party-stat-value" style="color: var(--color-true)">${ps.true}</div><div class="party-stat-label">${_('true')}</div></div>
        <div class="party-stat-item"><div class="party-stat-value" style="color: var(--color-hoax)">${ps.hoax}</div><div class="party-stat-label">${_('hoax')}</div></div>
        <div class="party-stat-item"><div class="party-stat-value" style="color: var(--color-misleading)">${ps.misleading}</div><div class="party-stat-label">${_('misleading')}</div></div>
      </div>
      <div class="party-card-bar">
        <div class="bar-labels"><span>${_('verdicts')} (${ps.total})</span><span>${_('problem')}: ${ps.problemScore}%</span></div>
        <div class="stacked-bar">
          <div class="stacked-bar-segment" style="width:${trueW}%;background:var(--color-true)"></div>
          <div class="stacked-bar-segment" style="width:${partialW}%;background:var(--color-partial)"></div>
          <div class="stacked-bar-segment" style="width:${misleadW}%;background:var(--color-misleading)"></div>
          <div class="stacked-bar-segment" style="width:${hoaxW}%;background:var(--color-hoax)"></div>
        </div>
      </div>
    </div>
  `;
}

function renderCharts(stats) {
  Object.values(state.charts).forEach(c => c.destroy());
  state.charts = {};
  Chart.defaults.color = '#8b8ba3';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';

  const partyIds = Object.keys(PARTIES).filter(p => stats.partyStats[p]?.total > 0);
  const partyLabels = partyIds.map(p => PARTIES[p].abbr);

  const ctx1 = document.getElementById('chart-party-verdicts');
  if (ctx1) {
    state.charts.pv = new Chart(ctx1, { type: 'bar', data: { labels: partyLabels, datasets: [
      { label: _('true'), data: partyIds.map(p => stats.partyStats[p].true), backgroundColor: 'rgba(34,197,94,0.8)', borderRadius: 4 },
      { label: _('partiallyTrue'), data: partyIds.map(p => stats.partyStats[p].partiallyTrue), backgroundColor: 'rgba(234,179,8,0.8)', borderRadius: 4 },
      { label: _('misleading'), data: partyIds.map(p => stats.partyStats[p].misleading), backgroundColor: 'rgba(245,158,11,0.8)', borderRadius: 4 },
      { label: _('hoax'), data: partyIds.map(p => stats.partyStats[p].hoax), backgroundColor: 'rgba(239,68,68,0.8)', borderRadius: 4 },
    ]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true, pointStyle: 'circle' } } }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } } } });
  }

  const ctx2 = document.getElementById('chart-problem-score');
  if (ctx2) {
    const sorted = [...partyIds].sort((a, b) => stats.partyStats[b].problemScore - stats.partyStats[a].problemScore);
    state.charts.ps = new Chart(ctx2, { type: 'bar', data: { labels: sorted.map(p => PARTIES[p].abbr), datasets: [{ label: `${_('problemScore')} (%)`, data: sorted.map(p => stats.partyStats[p].problemScore), backgroundColor: sorted.map(p => { const s = stats.partyStats[p].problemScore; return s >= 60 ? 'rgba(239,68,68,0.8)' : s >= 40 ? 'rgba(245,158,11,0.8)' : 'rgba(34,197,94,0.8)'; }), borderRadius: 6, barPercentage: 0.6 }] }, options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' }, grid: { color: 'rgba(255,255,255,0.03)' } }, y: { grid: { display: false } } } } });
  }

  const ctx3 = document.getElementById('chart-verdict-donut');
  if (ctx3) {
    state.charts.vd = new Chart(ctx3, { type: 'doughnut', data: { labels: Object.keys(VERDICTS).map(getVerdictLabel), datasets: [{ data: Object.keys(VERDICTS).map(k => stats.verdictCounts[k] || 0), backgroundColor: ['rgba(34,197,94,0.8)','rgba(239,68,68,0.8)','rgba(245,158,11,0.8)','rgba(107,114,128,0.8)','rgba(234,179,8,0.8)'], borderWidth: 0, hoverOffset: 8 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true, pointStyle: 'circle' } } } } });
  }

  const ctx4 = document.getElementById('chart-category');
  if (ctx4) {
    const catLabels = Object.keys(stats.categoryCounts);
    state.charts.cat = new Chart(ctx4, { type: 'polarArea', data: { labels: catLabels.map(getCategoryLabel), datasets: [{ data: Object.values(stats.categoryCounts), backgroundColor: catLabels.map((_, i) => `hsla(${(i * 40 + 200) % 360}, 60%, 55%, 0.6)`), borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { padding: 12, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } } }, scales: { r: { ticks: { display: false }, grid: { color: 'rgba(255,255,255,0.05)' } } } } });
  }

  const ctx5 = document.getElementById('chart-trend');
  if (ctx5) {
    const months = Object.keys(stats.monthlyTrend).sort();
    state.charts.trend = new Chart(ctx5, { type: 'line', data: { labels: months.map(m => { const [y, mo] = m.split('-'); return new Date(y, mo - 1).toLocaleDateString(getUiLocale(), { month: 'short', year: '2-digit' }); }), datasets: [
      { label: _('totalTopics'), data: months.map(m => stats.monthlyTrend[m].total), borderColor: 'rgba(124,58,237,0.8)', backgroundColor: 'rgba(124,58,237,0.1)', fill: true, tension: 0.4, pointRadius: 4, pointHoverRadius: 6 },
      { label: _('hoax'), data: months.map(m => stats.monthlyTrend[m].hoax), borderColor: 'rgba(239,68,68,0.8)', backgroundColor: 'rgba(239,68,68,0.05)', fill: true, tension: 0.4, pointRadius: 3 },
      { label: _('true'), data: months.map(m => stats.monthlyTrend[m].true), borderColor: 'rgba(34,197,94,0.8)', backgroundColor: 'rgba(34,197,94,0.05)', fill: true, tension: 0.4, pointRadius: 3 },
    ] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true, pointStyle: 'circle' } } }, scales: { x: { grid: { color: 'rgba(255,255,255,0.03)' } }, y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.03)' } } }, interaction: { intersect: false, mode: 'index' } } });
  }
}

// ============================================================
// AI AGENT PAGE
// ============================================================
async function renderAgent() {
  const container = document.getElementById('agent-content');
  if (!container) return;

  const agentStatus = await api('/api/agent/status') || state.agentStatus;
  const agentLog = await api('/api/agent/log?limit=30') || [];
  const stats = await api('/api/stats') || { total: 0 };

  state.agentStatus = agentStatus;
  const as = agentStatus;
  const providers = as.providers || {};

  container.innerHTML = `
    <div class="agent-header">
      <div class="agent-title-area"><h1 class="agent-page-title">🤖 ${_('agentTitle')}</h1></div>
      <div class="agent-controls">
        <button class="agent-btn start" id="agent-start" ${as.status === 'running' ? 'disabled style="opacity:0.5"' : ''}>▶ ${_('start')}</button>
        <button class="agent-btn pause" id="agent-pause" ${as.status !== 'running' ? 'disabled style="opacity:0.5"' : ''}>⏸ ${_('pause')}</button>
        <button class="agent-btn stop" id="agent-stop" ${as.status === 'idle' ? 'disabled style="opacity:0.5"' : ''}>⏹ ${_('stop')}</button>
      </div>
    </div>

    <div class="current-action" id="agent-current-action">
      <div class="action-spinner" style="${as.status !== 'running' ? 'display:none' : ''}"></div>
      <span id="action-text">${as.currentAction || _('idle')}</span>
    </div>

    <!-- API Provider Status -->
    <div class="provider-status-row">
      ${renderProviderBadge('Groq', providers.groq, '🤖')}
    </div>

    <div class="agent-grid">
      <div class="agent-panel">
        <div class="panel-header"><div class="panel-title">📡 ${_('agentStatus')}</div></div>
        <div class="agent-status-display">
          <div class="agent-status-icon ${as.status}" id="agent-status-icon">${as.status === 'running' ? '🟢' : as.status === 'paused' ? '🟡' : '⚪'}</div>
          <div class="agent-status-text">
            <h3 id="agent-status-label">${as.status === 'running' ? _('activelyAnalyzing') : as.status === 'paused' ? _('paused') : _('idle')}</h3>
            <p>${_('agentDesc')}</p>
          </div>
        </div>
        <div class="agent-stats-row">
          <div class="agent-stat"><div class="agent-stat-value" style="color: var(--text-accent)" id="stat-analyzed">${as.topicsAnalyzed}</div><div class="agent-stat-label">${_('analyzedSession')}</div></div>
          <div class="agent-stat"><div class="agent-stat-value" style="color: var(--color-true)" id="stat-total">${stats.total}</div><div class="agent-stat-label">${_('totalTopics')}</div></div>
          <div class="agent-stat"><div class="agent-stat-value" style="color: var(--color-hoax)" id="stat-queue">${as.queueLength}</div><div class="agent-stat-label">${_('queueRemaining')}</div></div>
        </div>
      </div>

      <div class="agent-panel">
        <div class="panel-header">
          <div class="panel-title">📋 ${_('activityLog')}</div>
          <button class="panel-action" id="clear-log-btn">${_('clear')}</button>
        </div>
        <div class="activity-log" id="activity-log">
          ${agentLog.length > 0
            ? agentLog.reverse().map(e => renderLogEntry(e)).join('')
            : `<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">${_('noActivity')}</div><div class="empty-state-sub">${_('startAgent')}</div></div>`}
        </div>
      </div>

      <div class="agent-panel full-width">
        <div class="panel-header"><div class="panel-title">⚙️ ${_('agentConfig')}</div></div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: var(--space-md);">
          <div style="padding: var(--space-md); background: rgba(255,255,255,0.02); border-radius: var(--radius-md);">
            <div style="font-size: 0.85rem; font-weight: 600; margin-bottom: var(--space-sm);">📡 ${_('dataSources')}</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.6;">
              ${_('agentDataSourcesList')}
            </div>
          </div>
          <div style="padding: var(--space-md); background: rgba(255,255,255,0.02); border-radius: var(--radius-md);">
            <div style="font-size: 0.85rem; font-weight: 600; margin-bottom: var(--space-sm);">🧠 ${_('analysisPipeline')}</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.6;">
              ${_('agentAnalysisPipelineList')}
            </div>
          </div>
          <div style="padding: var(--space-md); background: rgba(255,255,255,0.02); border-radius: var(--radius-md);">
            <div style="font-size: 0.85rem; font-weight: 600; margin-bottom: var(--space-sm);">⏱️ ${_('timing')}</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.6;">
              ${_('agentTimingList')}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Button handlers
  document.getElementById('agent-start')?.addEventListener('click', async () => {
    await apiPost('/api/agent/start');
    showToast(`🟢 ${_('agentRunning')}`, 'success');
    renderAgent();
  });
  document.getElementById('agent-pause')?.addEventListener('click', async () => {
    await apiPost('/api/agent/pause');
    showToast(`🟡 ${_('agentPaused')}`, 'warning');
    renderAgent();
  });
  document.getElementById('agent-stop')?.addEventListener('click', async () => {
    await apiPost('/api/agent/stop');
    showToast(`🔴 ${_('agentIdle')}`, 'info');
    renderAgent();
  });
  document.getElementById('clear-log-btn')?.addEventListener('click', async () => {
    await apiPost('/api/agent/log/clear');
    renderAgent();
  });
}

function renderProviderBadge(name, usage, icon) {
  if (!usage) return '';
  const isConnected = usage.available;
  const hasIssue = !!usage.lastError;
  const blockedForSec = Number(usage.blockedForSec || 0);
  const color = !isConnected
    ? 'var(--color-unverified)'
    : hasIssue
      ? 'var(--color-misleading)'
      : 'var(--color-true)';
  const statusText = !isConnected
    ? _('noKey')
    : hasIssue
      ? usage.lastError
      : _('connected');
  
  let usageText = '';
  if (usage.callsThisMinute !== undefined) usageText = `${usage.callsThisMinute}/${usage.maxPerMinute} ${_('callsPerMin')}`;
  else if (usage.callsThisHour !== undefined) usageText = `${usage.callsThisHour}/${usage.maxPerHour} ${_('callsPerHour')}`;

  const cooldownText = blockedForSec > 0
    ? `<div class="provider-usage">${_('retryIn', { n: blockedForSec })}</div>`
    : '';

  return `
    <div class="provider-badge">
      <span class="provider-icon">${icon}</span>
      <div class="provider-info">
        <div class="provider-name">${name}</div>
        <div class="provider-status" style="color: ${color}">${statusText}</div>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
        ${usageText ? `<div class="provider-usage">${usageText}</div>` : ''}
        ${cooldownText}
      </div>
    </div>
  `;
}

function updateAgentUI() {
  const as = state.agentStatus;
  const el = (id) => document.getElementById(id);
  const analyzed = el('stat-analyzed');
  const queue = el('stat-queue');
  if (analyzed) analyzed.textContent = as.topicsAnalyzed;
  if (queue) queue.textContent = as.queueLength;
}

function updateActionBanner(data) {
  const actionText = document.getElementById('action-text');
  const spinner = document.querySelector('.action-spinner');
  if (actionText) actionText.textContent = data.action;
  if (spinner) spinner.style.display = state.agentStatus.status === 'running' ? '' : 'none';
}

function appendLogEntry(data) {
  const log = document.getElementById('activity-log');
  if (!log) return;
  const time = new Date(data.timestamp).toLocaleTimeString(getUiLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const icons = { system: '⚡', action: '🔄', discovery: '🆕' };
  const entry = document.createElement('div');
  entry.className = `log-entry ${data.type}`;
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-icon">${icons[data.type] || '•'}</span><span class="log-message">${data.action}</span>`;
  
  // Remove empty state if present
  const empty = log.querySelector('.empty-state');
  if (empty) empty.remove();
  
  log.prepend(entry);
  // Keep max 50 entries in DOM
  while (log.children.length > 50) log.lastChild.remove();
}

function renderLogEntry(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString(getUiLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const icons = { system: '⚡', action: '🔄', discovery: '🆕' };
  return `<div class="log-entry ${entry.type}"><span class="log-time">${time}</span><span class="log-icon">${icons[entry.type] || '•'}</span><span class="log-message">${entry.message}</span></div>`;
}

// ============================================================
// TOPIC DETAIL MODAL — with verification evidence
// ============================================================
function buildVerificationPanel(topic) {
  const conf = getConfidenceInfo(topic.confidence || 'low');
  const v = topic.verification || {};
  const vScore = v.score ?? 0;
  const vStatus = v.status || 'UNKNOWN';
  const vMethod = v.method || 'unknown';
  const vChecks = v.checks || {};
  const vReasons = v.reasons || [];
  const provider = topic.aiProvider || 'None';

  // Status color
  const statusColors = { VERIFIED: 'var(--color-true)', LIKELY_REAL: '#22c55e', WEAK: 'var(--color-misleading)', REJECTED: 'var(--color-hoax)', UNKNOWN: 'var(--color-unverified)' };
  const sColor = statusColors[vStatus] || statusColors.UNKNOWN;

  // Score bar segments
  const scorePercent = Math.min(100, Math.max(0, vScore));
  const scoreColor = vScore >= 80 ? 'var(--color-true)' : vScore >= 65 ? '#22c55e' : vScore >= 50 ? 'var(--color-misleading)' : 'var(--color-hoax)';

  return `
    <div class="verification-panel">
      <div class="vp-header">
        <div class="vp-title">🔬 ${_('howWeVerified')}</div>
        <div class="vp-method">${_('methodLabel')}: ${vMethod}</div>
      </div>

      <div class="vp-score-row">
        <div class="vp-score-bar-container">
          <div class="vp-score-bar" style="width: ${scorePercent}%; background: ${scoreColor}"></div>
        </div>
        <div class="vp-score-value" style="color: ${scoreColor}">${vScore}/100</div>
      </div>

      <div class="vp-grid">
        <div class="vp-item">
          <div class="vp-item-label">${_('sourceStatus')}</div>
          <div class="vp-item-value" style="color: ${sColor}">${getVerificationStatusLabel(vStatus)}</div>
        </div>
        <div class="vp-item">
          <div class="vp-item-label">${_('aiConfidence')}</div>
          <div class="vp-item-value"><span style="color:${conf.color}">${conf.label}</span> ${conf.text}</div>
        </div>
        <div class="vp-item">
          <div class="vp-item-label">${_('analyzedByLabel')}</div>
          <div class="vp-item-value">${getProviderDisplay(provider)}</div>
        </div>
        <div class="vp-item">
          <div class="vp-item-label">${_('sourceTrusted')}</div>
          <div class="vp-item-value">${vChecks.sourceTrusted ? `✅ ${_('sourceTrustedYes')}` : `⚠️ ${_('sourceTrustedNo')}`}</div>
        </div>
        <div class="vp-item">
          <div class="vp-item-label">${_('multiSource')}</div>
          <div class="vp-item-value">${vChecks.multiSourceSupport ? `✅ ${_('multiSourceYes', { n: vChecks.uniqueDomainsInCluster || '2+' })}` : `❌ ${_('multiSourceNo')}`}</div>
        </div>
        <div class="vp-item">
          <div class="vp-item-label">${_('contentChecks')}</div>
          <div class="vp-item-value">${[vChecks.hasTitle ? `✅ ${_('contentTitle')}` : `❌ ${_('contentTitle')}`, vChecks.hasSummary ? `✅ ${_('contentSummary')}` : `❌ ${_('contentSummary')}`, vChecks.hasUrl ? `✅ ${_('contentUrl')}` : `❌ ${_('contentUrl')}`, vChecks.hasPublishedAt ? `✅ ${_('contentDate')}` : `❌ ${_('contentDate')}`].join(' · ')}</div>
        </div>
      </div>

      ${vReasons.length > 0 ? `
        <div class="vp-reasons">
          <div class="vp-reasons-title">⚠️ ${_('flaggedIssues')}</div>
          ${vReasons.map(r => `<div class="vp-reason">• ${r}</div>`).join('')}
        </div>
      ` : ''}

      ${vChecks.hasSuspiciousSignal ? `<div class="vp-warning">🚨 ${_('suspiciousLang')}</div>` : ''}
    </div>
  `;
}

async function openTopicModal(topicId) {
  const topic = await api(`/api/topics/${topicId}`);
  if (!topic) return;

  const party = PARTIES[topic.party];
  const verdict = VERDICTS[topic.verdict];
  const verdictClass = topic.verdict.toLowerCase().replace('_', '-');
  const coalition = party ? COALITIONS[party.coalition] : null;
  const conf = getConfidenceInfo(topic.confidence || 'low');
  const verdictLabel = getVerdictLabel(topic.verdict);

  const title = topic.translations?.[state.lang]?.title || topic.title;
  const summary = topic.translations?.[state.lang]?.summary || topic.summary;
  const analysis = topic.translations?.[state.lang]?.analysis || topic.analysis;

  // Verdict explanation
  const verdictExplanations = {
    TRUE: _('verdictExplainTrue'),
    HOAX: _('verdictExplainHoax'),
    MISLEADING: _('verdictExplainMisleading'),
    PARTIALLY_TRUE: _('verdictExplainPartial'),
    UNVERIFIED: _('verdictExplainUnverified'),
  };

  const modal = document.getElementById('modal-content');
  modal.innerHTML = `
    <button class="modal-close" id="modal-close-btn">✕</button>

    <div class="modal-verdict-hero ${verdictClass}">
      <div class="mvh-icon">${verdict?.icon || '❓'}</div>
      <div class="mvh-info">
        <div class="mvh-label">${verdictLabel}</div>
        <div class="mvh-explain">${verdictExplanations[topic.verdict] || ''}</div>
      </div>
      <div class="mvh-confidence">
        <span style="color:${conf.color}">${conf.label}</span>
        <span class="mvh-conf-text">${_('confidence')}: ${conf.text}</span>
      </div>
    </div>

    <h2 class="modal-title">${title}</h2>
    <div class="modal-meta">
      <span class="party-tag" style="background: ${party?.colorLight}; color: ${party?.color}; font-size: 0.8rem; padding: 4px 12px;">${topic.party} ${coalition ? '(' + getCoalitionNameLabel(party?.coalition, coalition.name) + ')' : ''}</span>
      <span class="category-tag" style="font-size: 0.8rem; padding: 4px 12px;">📁 ${getCategoryLabel(topic.category)}</span>
      <span class="category-tag" style="font-size: 0.8rem; padding: 4px 12px;">📅 ${formatDate(topic.date)}</span>
      <span class="category-tag" style="font-size: 0.8rem; padding: 4px 12px;">📍 ${getRegionLabel(topic.region)}</span>
    </div>

    <div class="modal-section"><div class="modal-section-title">📝 ${_('summary')}</div><div class="modal-section-content">${summary}</div></div>
    <div class="modal-section"><div class="modal-section-title">🧠 ${_('aiAnalysis')}</div><div class="modal-section-content">${analysis || _('noAnalysis')}</div></div>

    ${buildVerificationPanel(topic)}

    <div class="modal-section">
      <div class="modal-section-title">📚 ${_('sourcesRef')}</div>
      <ul class="modal-sources-list">
        ${(topic.sources || []).map(s => `<li><a href="${s.url}" target="_blank" rel="noopener">${s.name}</a> — <span style="color: var(--text-muted)">${s.url}</span></li>`).join('')}
        ${topic.factCheckRef ? `<li style="color: var(--text-accent);">${_('factCheckedBy')}: <strong>${topic.factCheckRef}</strong></li>` : ''}
      </ul>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">🏛️ ${_('partyContext')}</div>
      <div class="modal-section-content">
        <strong style="color: ${party?.color || '#888'}">${party?.name || topic.party}</strong>
        ${coalition ? ` — ${getCoalitionNameLabel(party?.coalition, coalition.name)} (${getCoalitionStatusLabel(coalition.status)})` : ''}<br><br>
        ${party?.description || ''}<br><br>
        <span style="color: var(--text-muted); font-size: 0.85rem;">${_('leader')}: ${party?.leader || _('notAvailable')} · ${_('founded')}: ${party?.founded || _('notAvailable')} · ${_('ideology')}: ${party?.ideology || _('notAvailable')}</span>
      </div>
    </div>
  `;

  document.getElementById('modal-overlay').classList.add('active');
  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
}

function closeModal() {
  document.getElementById('modal-overlay')?.classList.remove('active');
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 300); }, 3500);
}

window.showToast = showToast;

// ============================================================
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', init);
