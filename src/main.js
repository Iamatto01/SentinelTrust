// SentinelTruth v2 — Main Application with API, SSE, i18n
import { Chart, registerables } from 'chart.js';
import { PARTIES, VERDICTS, COALITIONS, getAllPartyIds } from './data/parties.js';
import { T, LANGUAGES, t, getCurrentLang, setLang } from './i18n/translations.js';
import { formatDate, timeAgo, debounce, animateCounter, truncate } from './utils/helpers.js';

Chart.register(...registerables);

// ============================================================
// App State
// ============================================================
const state = {
  currentSection: 'dashboard',
  lang: getCurrentLang(),
  filters: { party: 'ALL', verdict: 'ALL', category: 'ALL', search: '' },
  charts: {},
  sse: null,
  agentStatus: { status: 'idle', currentAction: 'Agent idle', topicsAnalyzed: 0, queueLength: 0, providers: {} },
  cachedTopics: [],
  cachedStats: null,
  cachedQuality: null,
};

const API = '';

// ============================================================
// API Helpers
// ============================================================
async function api(path, opts = {}) {
  try {
    const res = await fetch(`${API}${path}`, opts);
    return await res.json();
  } catch (err) {
    console.error('API error:', err);
    return null;
  }
}

async function apiPost(path, body = null) {
  const opts = { method: 'POST' };
  if (body !== null) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  return api(path, opts);
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
      showToast(`✅ New: ${topic.title?.substring(0, 50)}...`, 'success');
      // Refresh current view
      if (state.currentSection === 'dashboard') renderDashboard();
      if (state.currentSection === 'topics') renderTopics();
      if (state.currentSection === 'statistics') renderStatistics();
    }
  });

  state.sse.addEventListener('ingestionReport', (e) => {
    const report = JSON.parse(e.data);
    state.agentStatus.lastIngestionReport = report;
    showToast(`📥 Real ingestion finished: ${report.stored} stored`, 'success');
    if (state.currentSection === 'agent') renderAgent();
    if (state.currentSection === 'dashboard') renderDashboard();
    if (state.currentSection === 'statistics') renderStatistics();
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
  const sectionToKeyMap = { dashboard: 'dashboard', topics: 'topics', statistics: 'statistics', agent: 'aiAgent' };
  document.querySelectorAll('.nav-link').forEach(link => {
    const section = link.dataset.section;
    const labelEl = link.querySelector('.nav-label');
    if (labelEl) labelEl.textContent = _(sectionToKeyMap[section] || section);
  });
}

// ============================================================
// Language Switcher
// ============================================================
window.switchLanguage = function(lang) {
  state.lang = lang;
  setLang(lang);
  // Re-render current section
  updateNavLabels();
  updateAgentBadge();
  navigate(state.currentSection);
  // Close dropdown
  document.getElementById('lang-dropdown')?.classList.remove('active');
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
        <div class="quality-title">🔎 Real Data Transparency</div>
        <div class="quality-subtitle">Strict mode: ${quality.strictRealMode ? 'ON' : 'OFF'} · Min verification score: ${quality.minimumVerificationScore}</div>
        <div class="quality-grid">
          <div class="quality-item"><div class="quality-value">${quality.totalStored}</div><div class="quality-label">Stored Records</div></div>
          <div class="quality-item"><div class="quality-value">${quality.visibleTopics}</div><div class="quality-label">Visible Real Records</div></div>
          <div class="quality-item"><div class="quality-value">${quality.countedForStats}</div><div class="quality-label">Counted In Statistics</div></div>
          <div class="quality-item"><div class="quality-value">${quality.excludedFromStats}</div><div class="quality-label">Excluded From Statistics</div></div>
          <div class="quality-item"><div class="quality-value">${quality.syntheticExcluded}</div><div class="quality-label">Synthetic Excluded</div></div>
          <div class="quality-item"><div class="quality-value">${quality.acceptanceRate}%</div><div class="quality-label">Acceptance Rate</div></div>
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
  `;

  setTimeout(() => {
    container.querySelectorAll('[data-counter]').forEach(el => animateCounter(el, parseInt(el.dataset.counter)));
  }, 200);

  container.querySelectorAll('.recent-topic-item').forEach(item => {
    item.addEventListener('click', () => openTopicModal(item.dataset.topicId));
  });
}

function renderRecentTopicItem(topic) {
  const verdictClass = topic.verdict.toLowerCase().replace('_', '-');
  const party = PARTIES[topic.party];
  const title = topic.translations?.[state.lang]?.title || topic.title;
  return `
    <div class="recent-topic-item" data-topic-id="${topic.id}">
      <div class="topic-verdict-dot ${verdictClass}"></div>
      <div class="recent-topic-content">
        <div class="recent-topic-title">${title}</div>
        <div class="recent-topic-meta">
          <span style="color: ${party?.color || '#888'}">${topic.party}</span>
          <span>·</span><span>${topic.category}</span>
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

  const topics = await api(`/api/topics?${params.toString()}`);
  if (!topics) return;

  const allTopicsForCats = await api('/api/topics');
  const allCategories = [...new Set((allTopicsForCats || []).map(t => t.category))];
  const regionGroups = buildRegionTopicGroups(topics);
  const partyGroups = buildPartyTopicGroups(topics);

  container.innerHTML = `
    <div class="topics-header">
      <div>
        <h1 class="topics-title">${_('politicalTopics')}</h1>
        <div class="topics-count">${_('topicsFound', { n: topics.length })}</div>
      </div>
    </div>
    <div class="search-bar">
      <span class="search-icon">🔍</span>
      <input type="text" id="search-input" placeholder="${_('searchPlaceholder')}" value="${state.filters.search}" />
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
        ${allCategories.map(cat => `<button class="filter-chip ${state.filters.category === cat ? 'active' : ''}" data-filter="category" data-value="${cat}">${cat}</button>`).join('')}
      </div>
    </div>
    ${topics.length > 0
      ? `
        <div class="topics-separated-grid">
          <section class="topics-group-panel">
            <div class="topics-group-panel-header">
              <h2 class="topics-group-panel-title">🗺️ Topics by Region</h2>
              <span class="topics-group-panel-meta">${regionGroups.length} groups</span>
            </div>
            <div class="topics-group-stack">
              ${regionGroups.map(group => renderGroupedTopicGroup(group, 'region')).join('')}
            </div>
          </section>

          <section class="topics-group-panel">
            <div class="topics-group-panel-header">
              <h2 class="topics-group-panel-title">🏛️ Topics by Party</h2>
              <span class="topics-group-panel-meta">${partyGroups.length} groups</span>
            </div>
            <div class="topics-group-stack">
              ${partyGroups.map(group => renderGroupedTopicGroup(group, 'party')).join('')}
            </div>
          </section>
        </div>
      `
      : `<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-text">${_('noTopics')}</div><div class="empty-state-sub">${_('tryAdjusting')}</div></div>`}
  `;

  container.querySelector('#search-input')?.addEventListener('input', debounce((e) => { state.filters.search = e.target.value; renderTopics(); }, 300));
  container.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => { state.filters[chip.dataset.filter] = chip.dataset.value; renderTopics(); });
  });
  container.querySelectorAll('.group-topic-item').forEach(item => {
    item.addEventListener('click', () => openTopicModal(item.dataset.topicId));
  });
}

function normalizeRegionLabel(region) {
  return String(region || '').trim() || 'National';
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
    groups.push({ key: 'UNKNOWN', label: 'Unknown Party', party: null, items: unknown });
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
  const title = topic.translations?.[state.lang]?.title || topic.title;
  const region = normalizeRegionLabel(topic.region);
  const context = mode === 'region' ? (party?.abbr || topic.party || 'N/A') : region;
  const contextStyle = mode === 'region' ? `color:${party?.color || '#8b8ba3'};` : '';

  return `
    <button class="group-topic-item" data-topic-id="${topic.id}" type="button">
      <span class="group-topic-verdict ${verdictClass}">${verdict?.icon || '•'}</span>
      <span class="group-topic-body">
        <span class="group-topic-title">${truncate(title, 140)}</span>
        <span class="group-topic-meta">
          <span class="group-topic-context" style="${contextStyle}">${context}</span>
          <span>·</span>
          <span>${topic.category}</span>
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
  const title = topic.translations?.[state.lang]?.title || topic.title;
  const summary = topic.translations?.[state.lang]?.summary || topic.summary;

  return `
    <div class="topic-card verdict-${verdictClass}" data-topic-id="${topic.id}">
      <div class="topic-card-header">
        <div class="topic-card-title">${title}</div>
        <span class="verdict-badge ${verdictClass}">${verdict?.icon || ''} ${verdict?.label || topic.verdict}</span>
      </div>
      <div class="topic-card-summary">${summary}</div>
      <div class="topic-card-footer">
        <div class="topic-tags">
          <span class="party-tag" style="background: ${party?.colorLight || 'rgba(255,255,255,0.05)'}; color: ${party?.color || '#888'}"><span style="width:6px;height:6px;border-radius:50%;background:${party?.color || '#888'};display:inline-block"></span> ${topic.party}</span>
          <span class="category-tag">${topic.category}</span>
          ${topic.impact === 'high' ? `<span class="category-tag" style="border-color: rgba(239,68,68,0.3); color: #ef4444;">⚡ ${_('highImpact')}</span>` : ''}
          ${topic.aiProvider ? `<span class="category-tag" style="border-color: rgba(124,58,237,0.3); color: var(--text-accent);">🤖 ${topic.aiProvider}</span>` : ''}
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
      ${quality ? `<p class="stats-page-subtitle" style="font-size:0.9rem; margin-top: 8px; color: var(--text-muted);">Counted records: ${quality.countedForStats}/${quality.totalStored} · Excluded: ${quality.excludedFromStats} · Strict mode: ${quality.strictRealMode ? 'ON' : 'OFF'}</p>` : ''}
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
        <div class="party-card-coalition">${coalition?.name || party.coalition}</div>
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
    state.charts.vd = new Chart(ctx3, { type: 'doughnut', data: { labels: Object.values(VERDICTS).map(v => v.label), datasets: [{ data: Object.keys(VERDICTS).map(k => stats.verdictCounts[k] || 0), backgroundColor: ['rgba(34,197,94,0.8)','rgba(239,68,68,0.8)','rgba(245,158,11,0.8)','rgba(107,114,128,0.8)','rgba(234,179,8,0.8)'], borderWidth: 0, hoverOffset: 8 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true, pointStyle: 'circle' } } } } });
  }

  const ctx4 = document.getElementById('chart-category');
  if (ctx4) {
    const catLabels = Object.keys(stats.categoryCounts);
    state.charts.cat = new Chart(ctx4, { type: 'polarArea', data: { labels: catLabels, datasets: [{ data: Object.values(stats.categoryCounts), backgroundColor: catLabels.map((_, i) => `hsla(${(i * 40 + 200) % 360}, 60%, 55%, 0.6)`), borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { padding: 12, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } } }, scales: { r: { ticks: { display: false }, grid: { color: 'rgba(255,255,255,0.05)' } } } } });
  }

  const ctx5 = document.getElementById('chart-trend');
  if (ctx5) {
    const months = Object.keys(stats.monthlyTrend).sort();
    state.charts.trend = new Chart(ctx5, { type: 'line', data: { labels: months.map(m => { const [y, mo] = m.split('-'); return new Date(y, mo - 1).toLocaleDateString('en-MY', { month: 'short', year: '2-digit' }); }), datasets: [
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
  const ingestReport = as.lastIngestionReport;

  container.innerHTML = `
    <div class="agent-header">
      <div class="agent-title-area"><h1 class="agent-page-title">🤖 ${_('agentTitle')}</h1></div>
      <div class="agent-controls">
        <button class="agent-btn start" id="agent-start" ${as.status === 'running' ? 'disabled style="opacity:0.5"' : ''}>▶ ${_('start')}</button>
        <button class="agent-btn pause" id="agent-pause" ${as.status !== 'running' ? 'disabled style="opacity:0.5"' : ''}>⏸ ${_('pause')}</button>
        <button class="agent-btn stop" id="agent-stop" ${as.status === 'idle' ? 'disabled style="opacity:0.5"' : ''}>⏹ ${_('stop')}</button>
        <button class="agent-btn ingest" id="agent-ingest" ${as.bulkIngesting ? 'disabled style="opacity:0.5"' : ''}>📥 Collect 1000 Real</button>
        <button class="agent-btn reset" id="agent-reset">🔄 ${_('resetData')}</button>
      </div>
    </div>

    <div class="current-action" id="agent-current-action">
      <div class="action-spinner" style="${as.status !== 'running' ? 'display:none' : ''}"></div>
      <span id="action-text">${as.currentAction || _('idle')}</span>
    </div>

    <!-- API Provider Status -->
    <div class="provider-status-row">
      ${renderProviderBadge('Groq', providers.groq, '🤖')}
      ${renderProviderBadge('HuggingFace', providers.huggingface, '🧩')}
    </div>

    <div class="agent-panel" style="margin-bottom: var(--space-md);">
      <div class="panel-header"><div class="panel-title">📦 Real Ingestion Report</div></div>
      ${ingestReport ? `
        <div class="quality-grid">
          <div class="quality-item"><div class="quality-value">${ingestReport.targetCount}</div><div class="quality-label">Target</div></div>
          <div class="quality-item"><div class="quality-value">${ingestReport.collectedCount}</div><div class="quality-label">Collected</div></div>
          <div class="quality-item"><div class="quality-value">${ingestReport.dedupedCount}</div><div class="quality-label">Deduped</div></div>
          <div class="quality-item"><div class="quality-value">${ingestReport.verifiedAccepted}</div><div class="quality-label">Verified Accepted</div></div>
          <div class="quality-item"><div class="quality-value">${ingestReport.verifiedRejected}</div><div class="quality-label">Rejected</div></div>
          <div class="quality-item"><div class="quality-value">${ingestReport.stored}</div><div class="quality-label">Stored</div></div>
        </div>
        <div style="font-size: 0.82rem; color: var(--text-secondary); margin-top: var(--space-sm);">
          Acceptance Rate: ${ingestReport.acceptanceRate}% · Duplicates skipped: ${ingestReport.duplicatesSkipped} · Finished: ${new Date(ingestReport.finishedAt).toLocaleString('en-MY')}
        </div>
        ${Array.isArray(ingestReport.sourceErrors) && ingestReport.sourceErrors.length > 0
          ? `<div style="font-size: 0.78rem; color: var(--color-misleading); margin-top: var(--space-sm);">Source warnings: ${ingestReport.sourceErrors.length}. Open server logs for details.</div>`
          : ''}
      ` : `<div style="font-size: 0.85rem; color: var(--text-secondary);">No ingestion run yet. Click "Collect 1000 Real" to start.</div>`}
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
              • RSS + Google News feeds (real news)<br>• Sebenarnya.my fact-check DB<br>• JomCheck archives<br>• MyCheck.my verifications<br>• Social media monitoring
            </div>
          </div>
          <div style="padding: var(--space-md); background: rgba(255,255,255,0.02); border-radius: var(--radius-md);">
            <div style="font-size: 0.85rem; font-weight: 600; margin-bottom: var(--space-sm);">🧠 ${_('analysisPipeline')}</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.6;">
              • Groq (Llama 3.3 70B) → primary<br>• HuggingFace → fallback<br>• Multi-language translation<br>• Party attribution<br>• Connection mapping
            </div>
          </div>
          <div style="padding: var(--space-md); background: rgba(255,255,255,0.02); border-radius: var(--radius-md);">
            <div style="font-size: 0.85rem; font-weight: 600; margin-bottom: var(--space-sm);">⏱️ ${_('timing')}</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.6;">
              • News search: every 30 min<br>• Topic analysis: every 1 min<br>• Translation: per topic<br>• Data persistence: real-time<br>• SSE updates: instant
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
  document.getElementById('agent-reset')?.addEventListener('click', async () => {
    if (confirm(_('resetConfirm'))) {
      await apiPost('/api/agent/reset');
      showToast('🔄 Data reset', 'info');
      renderAgent();
    }
  });
  document.getElementById('agent-ingest')?.addEventListener('click', async () => {
    const targetRaw = prompt('How many real records to collect?', '1000');
    if (!targetRaw) return;
    const targetCount = Math.max(50, Math.min(parseInt(targetRaw, 10) || 1000, 5000));

    showToast(`📥 Starting real ingestion (${targetCount})...`, 'info');
    const result = await apiPost('/api/ingest/run', {
      targetCount,
      includeInternet: true,
      includeFacebook: true,
    });

    if (result?.success) {
      showToast(`✅ Stored ${result.report?.stored || 0} verified real records`, 'success');
    } else {
      showToast(`❌ Ingestion failed: ${result?.error || 'Unknown error'}`, 'warning');
    }

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
    ? `<div class="provider-usage">retry in ${blockedForSec}s</div>`
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
  const time = new Date(data.timestamp).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
  const time = new Date(entry.timestamp).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const icons = { system: '⚡', action: '🔄', discovery: '🆕' };
  return `<div class="log-entry ${entry.type}"><span class="log-time">${time}</span><span class="log-icon">${icons[entry.type] || '•'}</span><span class="log-message">${entry.message}</span></div>`;
}

// ============================================================
// TOPIC DETAIL MODAL
// ============================================================
async function openTopicModal(topicId) {
  const topic = await api(`/api/topics/${topicId}`);
  if (!topic) return;

  const party = PARTIES[topic.party];
  const verdict = VERDICTS[topic.verdict];
  const verdictClass = topic.verdict.toLowerCase().replace('_', '-');
  const coalition = party ? COALITIONS[party.coalition] : null;

  // Get translated content
  const title = topic.translations?.[state.lang]?.title || topic.title;
  const summary = topic.translations?.[state.lang]?.summary || topic.summary;
  const analysis = topic.translations?.[state.lang]?.analysis || topic.analysis;

  const modal = document.getElementById('modal-content');
  modal.innerHTML = `
    <button class="modal-close" id="modal-close-btn">✕</button>
    <div class="modal-verdict"><span class="verdict-badge ${verdictClass}" style="font-size: 0.85rem; padding: 6px 16px;">${verdict?.icon || ''} ${verdict?.label || topic.verdict}</span></div>
    <h2 class="modal-title">${title}</h2>
    <div class="modal-meta">
      <span class="party-tag" style="background: ${party?.colorLight}; color: ${party?.color}; font-size: 0.8rem; padding: 4px 12px;">${topic.party} ${coalition ? '(' + coalition.name + ')' : ''}</span>
      <span class="category-tag" style="font-size: 0.8rem; padding: 4px 12px;">📁 ${topic.category}</span>
      <span class="category-tag" style="font-size: 0.8rem; padding: 4px 12px;">📅 ${formatDate(topic.date)}</span>
      <span class="category-tag" style="font-size: 0.8rem; padding: 4px 12px;">📍 ${topic.region || 'National'}</span>
      ${topic.aiProvider ? `<span class="category-tag" style="font-size: 0.8rem; padding: 4px 12px; border-color: rgba(124,58,237,0.3); color: var(--text-accent);">🤖 ${_('analyzedBy')}: ${topic.aiProvider}</span>` : ''}
      ${topic.confidence ? `<span class="category-tag" style="font-size: 0.8rem; padding: 4px 12px;">${_('confidence')}: ${topic.confidence}</span>` : ''}
    </div>
    <div class="modal-section"><div class="modal-section-title">📝 ${_('summary')}</div><div class="modal-section-content">${summary}</div></div>
    <div class="modal-section"><div class="modal-section-title">🧠 ${_('aiAnalysis')}</div><div class="modal-section-content">${analysis || 'No detailed analysis available.'}</div></div>
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
        ${coalition ? ` — ${coalition.name} (${coalition.status})` : ''}<br><br>
        ${party?.description || ''}<br><br>
        <span style="color: var(--text-muted); font-size: 0.85rem;">${_('leader')}: ${party?.leader || 'N/A'} · ${_('founded')}: ${party?.founded || 'N/A'} · ${_('ideology')}: ${party?.ideology || 'N/A'}</span>
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
