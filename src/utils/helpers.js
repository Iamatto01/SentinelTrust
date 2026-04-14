// Utility helpers

const LOCALE_BY_LANG = {
  en: 'en-MY',
  ms: 'ms-MY',
  hi: 'hi-IN',
  zh: 'zh-CN',
};

const AGO_LABELS = {
  en: {
    months: (n) => `${n}mo ago`,
    days: (n) => `${n}d ago`,
    hours: (n) => `${n}h ago`,
    minutes: (n) => `${n}m ago`,
    now: 'just now',
  },
  ms: {
    months: (n) => `${n} bln lalu`,
    days: (n) => `${n} hari lalu`,
    hours: (n) => `${n} jam lalu`,
    minutes: (n) => `${n} min lalu`,
    now: 'baru sahaja',
  },
  hi: {
    months: (n) => `${n} माह पहले`,
    days: (n) => `${n} दिन पहले`,
    hours: (n) => `${n} घंटे पहले`,
    minutes: (n) => `${n} मिनट पहले`,
    now: 'अभी',
  },
  zh: {
    months: (n) => `${n}个月前`,
    days: (n) => `${n}天前`,
    hours: (n) => `${n}小时前`,
    minutes: (n) => `${n}分钟前`,
    now: '刚刚',
  },
};

function getActiveLang(lang = '') {
  const requested = String(lang || '').trim();
  if (requested && AGO_LABELS[requested]) return requested;

  if (typeof document !== 'undefined') {
    const docLang = String(document.documentElement?.lang || '').trim();
    if (docLang && AGO_LABELS[docLang]) return docLang;
  }

  return 'en';
}

export function formatDate(dateStr, lang = '') {
  const d = new Date(dateStr);
  const activeLang = getActiveLang(lang);
  return d.toLocaleDateString(LOCALE_BY_LANG[activeLang] || LOCALE_BY_LANG.en, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function timeAgo(dateStr, lang = '') {
  const now = new Date();
  const d = new Date(dateStr);
  const diff = now - d;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);

  const activeLang = getActiveLang(lang);
  const labels = AGO_LABELS[activeLang] || AGO_LABELS.en;

  if (months > 0) return labels.months(months);
  if (days > 0) return labels.days(days);
  if (hours > 0) return labels.hours(hours);
  if (minutes > 0) return labels.minutes(minutes);
  return labels.now;
}

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function animateCounter(el, target, duration = 1500) {
  const start = 0;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const current = Math.round(start + (target - start) * eased);
    el.textContent = current;
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}

export function animatePercentage(el, target, duration = 1500) {
  const start = 0;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(start + (target - start) * eased);
    el.textContent = current + '%';
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}

export function getVerdictClass(verdict) {
  return `verdict-${verdict.toLowerCase().replace('_', '-')}`;
}

export function truncate(str, len = 120) {
  if (str.length <= len) return str;
  return str.substring(0, len) + '...';
}

export function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function createEl(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([key, val]) => {
    if (key === 'className') el.className = val;
    else if (key === 'innerHTML') el.innerHTML = val;
    else if (key === 'textContent') el.textContent = val;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), val);
    else if (key === 'style' && typeof val === 'object') Object.assign(el.style, val);
    else if (key === 'dataset' && typeof val === 'object') Object.entries(val).forEach(([k, v]) => el.dataset[k] = v);
    else el.setAttribute(key, val);
  });
  children.forEach(child => {
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else if (child) el.appendChild(child);
  });
  return el;
}
