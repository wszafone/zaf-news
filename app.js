/* ===================================================
   경제뉴스 관리 - app.js
   뉴스: 매일경제·한국경제·네이버뉴스 (Google News RSS 경유)
   분석: Claude API (claude-haiku-4-5)
=================================================== */

// ─── Firebase ────────────────────────────────────

const firebaseConfig = {
  apiKey: "AIzaSyCGvKOuesMb2PUYfsMyS9otpQOwbOKdSYY",
  authDomain: "zaf-news.firebaseapp.com",
  databaseURL: "https://zaf-news-default-rtdb.firebaseio.com",
  projectId: "zaf-news",
  storageBucket: "zaf-news.firebasestorage.app",
  messagingSenderId: "815294579559",
  appId: "1:815294579559:web:39a48de69b3a151127e5c2",
  measurementId: "G-RXSSW07M4X"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ─── 상태 관리 ───────────────────────────────────

function defaultState() {
  return {
    categories: [],
    savedArticles: [],
    settings: { claudeApiKey: '' }
  };
}

const SETTINGS_KEY = 'zafnews_settings';

function saveSettingsToStorage(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

function loadSettingsFromStorage() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
}

function saveStateToStorage() {}

// ─── 앱 상태 ─────────────────────────────────────

let state = defaultState();
let fetchedMap = {};      // { categoryId: [article, ...] }
let currentCatId = null;  // null = 전체, string = 특정 분야
let editingCatId = null;
let memoTargetId = null;
let dragSrcIdx = null;
let currentMemoEditable = null;
let editingKeywords = []; // 모달에서 편집 중인 키워드 배열
let savedDateFilter = null;   // null = 전체, "YYYY-MM-DD" = 특정 날짜
let savedViewMode = 'category'; // 'category' | 'date'
let calendarMonth  = null;    // 달력에 표시 중인 월 (Date 객체, 1일로 고정)

// SVG 연필 아이콘 (모든 수정 버튼 공용)
const ICON_EDIT = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

// 분야명별 기본 검색 키워드 (배열)
const DEFAULT_KEYWORDS = {
  '반도체': ['반도체', '반도체 주가', '삼성전자 반도체', 'SK하이닉스'],
  '부동산': ['부동산', '아파트 시세', '부동산 규제', '분양'],
  '주식': ['주식', '코스피', '코스닥', '주가'],
  '금융': ['금융', '금리', '은행 대출', '기준금리'],
  '환율': ['환율', '달러 원화', '외환시장'],
  '수출입': ['수출', '수입', '무역 관세', '무역수지'],
  '물가': ['물가', '인플레이션', '소비자물가', 'CPI'],
  'AI 경제': ['AI 경제', '인공지능 산업', 'AI 주가'],
};

function defaultKeywords(name) {
  return DEFAULT_KEYWORDS[name] || [name];
}

// keywords 정규화: 구버전 문자열 → 배열
function normalizeKeywords(kw, name) {
  if (!kw) return [name];
  if (Array.isArray(kw)) return kw.filter(Boolean);
  return [kw.trim()].filter(Boolean); // 구버전 단일 문자열
}

// URL 기준 중복 제거 후 최신순 병합, 분야별 최대 10개 유지
// 기존 기사의 summary가 비어있으면 새로 가져온 summary로 갱신
function mergeArticles(existing, incoming) {
  const existingMap = new Map(existing.map(a => [a.url, { ...a }]));
  for (const a of incoming) {
    if (existingMap.has(a.url)) {
      if (a.summary) existingMap.get(a.url).summary = a.summary;
    } else {
      existingMap.set(a.url, a);
    }
  }
  const merged = [...existingMap.values()];
  merged.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return merged.slice(0, 10);
}

// ─── 유틸 ────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function dateLabel(iso) {
  return new Date(iso).toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
  });
}

function toDateStr(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseDateStr(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateNav(ds) {
  return parseDateStr(ds).toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
  });
}

function shortDateLabel(iso) {
  const d = new Date(iso);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const wd = d.toLocaleDateString('ko-KR', { weekday: 'short' });
  return `${m}/${day}(${wd})`;
}

function dateTimeLabel(iso) {
  return new Date(iso).toLocaleString('ko-KR', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function stripHtml(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  const clean = stripHtml(text);
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

// RSS description에서 제목 중복 부분 제거 후 200자 반환
// Google News RSS는 description = 제목 반복이 대부분 → 제목 앞부분 제거 후 남은 텍스트 반환
function cleanSummary(raw, title) {
  const text = stripHtml(raw).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const normText  = text.toLowerCase();
  const normTitle = title.toLowerCase().slice(0, 30);
  let result = text;
  if (normText.startsWith(normTitle)) {
    result = text.slice(normTitle.length).replace(/^[\s\-·|,]+/, '').trim();
  }
  if (!result) return '';
  return result.length > 200 ? result.slice(0, 200) + '…' : result;
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show${type ? ' ' + type : ''}`;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// ─── 모달 ────────────────────────────────────────

function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-close]');
  if (btn) closeModal(btn.dataset.close);

  // 오버레이 클릭 시 닫기
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
});

// ─── 뉴스 조회 ───────────────────────────────────

// 조회 대상 뉴스 소스
const NEWS_SOURCES = [
  { id: 'mk',     label: '매일경제',  domain: 'mk.co.kr' },
  { id: 'hk',     label: '한국경제',  domain: 'hankyung.com' },
  { id: 'naver',  label: '네이버뉴스', domain: 'n.news.naver.com' }
];

// RSS 조회 전략 (순서대로 시도, 성공 즉시 반환)
async function fetchRssArticles(rssUrl, cutoff, catId, catName, platform) {
  const strategies = [
    // 1순위: rss2json.com — RSS 전용 JSON 변환 (403 없음, 안정적)
    async () => {
      const api = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}&count=100`;
      const res = await fetch(api, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`rss2json ${res.status}`);
      const data = await res.json();
      if (data.status !== 'ok') throw new Error(data.message || 'rss2json 오류');
      return parseRss2Json(data.items, cutoff, catId, catName, platform);
    },
    // 2순위: allorigins.win — XML 프록시
    async () => {
      const api = `https://api.allorigins.win/get?url=${encodeURIComponent(rssUrl)}`;
      const res = await fetch(api, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`allorigins ${res.status}`);
      const data = await res.json();
      if (!data.contents) throw new Error('allorigins 빈 응답');
      return parseRSS(data.contents, cutoff, catId, catName, platform);
    },
    // 3순위: corsproxy.io — XML 프록시
    async () => {
      const api = `https://corsproxy.io/?${encodeURIComponent(rssUrl)}`;
      const res = await fetch(api, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`corsproxy ${res.status}`);
      const text = await res.text();
      if (!text.trim().startsWith('<')) throw new Error('corsproxy 잘못된 응답');
      return parseRSS(text, cutoff, catId, catName, platform);
    },
  ];

  let lastErr;
  for (const strategy of strategies) {
    try {
      return await strategy();
    } catch (err) {
      console.warn(`[${platform}] 전략 실패: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

// rss2json 응답 → 기사 배열
function parseRss2Json(items, cutoff, categoryId, categoryName, platform) {
  const articles = [];
  for (const item of (items || [])) {
    const title = (item.title || '').replace(/\s*-\s*[^-]+$/, '').trim();
    if (!title) continue;
    const url = item.link || item.guid || '';
    if (!url) continue;
    const pubDate = new Date(item.pubDate);
    if (isNaN(pubDate.getTime()) || pubDate < cutoff) continue;
    const summary = cleanSummary(item.description || item.content || '', title);
    articles.push({
      id: uid(), categoryId, categoryName, title,
      summary, url, source: '',
      platform, publishedAt: pubDate.toISOString()
    });
  }
  return articles;
}

// platform: NEWS_SOURCES 의 id ('mk' | 'hk' | 'naver')
function parseRSS(xmlText, cutoff, categoryId, categoryName, platform) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');

  if (doc.querySelector('parsererror')) {
    throw new Error('RSS 파싱에 실패했습니다.');
  }

  const items = Array.from(doc.querySelectorAll('item'));
  const articles = [];

  for (const item of items) {
    const rawTitle = item.querySelector('title')?.textContent || '';
    // "제목 - 출처" 형식에서 제목만 추출
    const title = rawTitle.replace(/\s*-\s*[^-]+$/, '').trim();
    if (!title) continue;

    // link 추출 (RSS에서 <link>는 text node로 존재)
    let url = '';
    for (const node of item.childNodes) {
      if (node.nodeName === 'link') { url = node.textContent.trim(); break; }
    }
    if (!url) url = item.querySelector('guid')?.textContent?.trim() || '';
    if (!url) continue;

    const pubDateStr = item.querySelector('pubDate')?.textContent || '';
    const pubDate = new Date(pubDateStr);
    if (isNaN(pubDate.getTime())) continue;
    if (pubDate < cutoff) continue;

    const descRaw = item.querySelector('description')?.textContent || '';
    const summary = cleanSummary(descRaw, title);
    const source = item.querySelector('source')?.textContent?.trim() || '';

    articles.push({
      id: uid(),
      categoryId,
      categoryName,
      title,
      summary,
      url,
      source,
      platform,
      publishedAt: pubDate.toISOString()
    });
  }

  return articles;
}

// 단일 소스에서 기사 조회 (실패 시 null 반환)
async function fetchFromSource(keyword, src, cutoff, catId, catName) {
  try {
    const q = encodeURIComponent(`${keyword} site:${src.domain}`);
    const rssUrl = `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
    return await fetchRssArticles(rssUrl, cutoff, catId, catName, src.id);
  } catch (err) {
    console.warn(`[${src.label}] 모든 전략 실패:`, err.message);
    return null;
  }
}

// site 필터 없는 일반 키워드 검색 (폴백)
async function fetchGeneralNews(keyword, cutoff, catId, catName) {
  const q = encodeURIComponent(keyword);
  const rssUrl = `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
  return await fetchRssArticles(rssUrl, cutoff, catId, catName, 'general');
}

async function fetchNewsForCategory(cat, force = false) {
  const dayAgo      = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const lastFetched = cat.lastFetched ? new Date(cat.lastFetched) : null;
  // force=true(재조회)이면 항상 24시간 전부터, 아니면 이전 조회 시점부터
  const cutoff  = (!force && lastFetched && lastFetched > dayAgo) ? lastFetched : dayAgo;
  const kwArray = normalizeKeywords(cat.keywords, cat.name);

  // 키워드별 × 소스별 조회 (키워드 순차, 소스 병렬)
  const seen   = new Set();
  const merged = [];

  for (const kw of kwArray) {
    const results = await Promise.all(
      NEWS_SOURCES.map(src => fetchFromSource(kw, src, cutoff, cat.id, cat.name))
    );
    const allFailed = results.every(r => r === null);
    if (allFailed) {
      // 이 키워드는 일반 검색으로 폴백
      const fallback = await fetchGeneralNews(kw, cutoff, cat.id, cat.name).catch(() => []);
      for (const a of fallback) {
        if (!seen.has(a.url)) { seen.add(a.url); merged.push(a); }
      }
      continue;
    }
    for (const arr of results) {
      if (!arr) continue;
      for (const a of arr) {
        if (!seen.has(a.url)) { seen.add(a.url); merged.push(a); }
      }
    }
  }

  if (!merged.length) {
    throw new Error('뉴스를 가져올 수 없습니다. 잠시 후 다시 시도해주세요.');
  }

  merged.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return filterByKeyword(merged, cat.name).slice(0, 10);
}

// 제목·요약에 분야 키워드가 포함된 기사만 반환 (결과가 너무 적으면 원본 반환)
function filterByKeyword(articles, keyword) {
  const parts = keyword.toLowerCase().trim().split(/\s+/).filter(p => p.length >= 2);
  const relevant = articles.filter(a => {
    const text = ((a.title || '') + ' ' + (a.summary || '')).toLowerCase();
    return parts.every(p => text.includes(p));
  });
  return relevant.length >= 3 ? relevant : articles;
}

// ─── 렌더링: 사이드바 ─────────────────────────────

function renderSidebar() {
  const list = document.getElementById('category-list');

  const allItem = `
    <li class="category-item all-item${currentCatId === null ? ' active' : ''}" data-id="all">
      <span class="category-dot"></span>
      <span class="category-name">전체 보기</span>
      <span class="cat-count">${state.savedArticles.length}</span>
    </li>`;

  const catItems = state.categories.map((cat, idx) => {
    const cnt = state.savedArticles.filter(a => a.categoryId === cat.id).length;
    const active = cat.id === currentCatId;
    return `
      <li class="category-item${active ? ' active' : ''}" data-id="${cat.id}" data-idx="${idx}" draggable="true">
        <span class="drag-handle" title="드래그하여 순서 변경">⠿</span>
        <span class="category-name">${esc(cat.name)}</span>
        ${cnt ? `<span class="cat-count">${cnt}</span>` : ''}
        <div class="cat-btns">
          <button class="cat-btn edit" data-id="${cat.id}" title="수정">${ICON_EDIT}</button>
          <button class="cat-btn del"  data-id="${cat.id}" title="삭제">✕</button>
        </div>
      </li>`;
  }).join('');

  list.innerHTML = allItem + catItems;

  // 클릭 이벤트
  list.onclick = e => {
    if (e.target.closest('.drag-handle')) return;
    const editBtn = e.target.closest('.cat-btn.edit');
    const delBtn  = e.target.closest('.cat-btn.del');
    const item    = e.target.closest('.category-item');
    if (!item) return;
    if (editBtn) { openEditCategory(editBtn.dataset.id); return; }
    if (delBtn)  { deleteCategory(delBtn.dataset.id);    return; }
    selectCategory(item.dataset.id === 'all' ? null : item.dataset.id);
  };

  // 드래그앤드롭 이벤트 (before/after 정밀 삽입)
  function clearDragIndicators() {
    list.querySelectorAll('.drag-before, .drag-after').forEach(d => {
      d.classList.remove('drag-before', 'drag-after');
    });
  }

  list.querySelectorAll('.category-item[draggable]').forEach(el => {
    el.addEventListener('dragstart', e => {
      dragSrcIdx = +el.dataset.idx;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDragIndicators();
      const rect = el.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        el.classList.add('drag-before');
      } else {
        el.classList.add('drag-after');
      }
    });
    el.addEventListener('dragleave', e => {
      // 자식 요소로 이동 시 무시
      if (!el.contains(e.relatedTarget)) clearDragIndicators();
    });
    el.addEventListener('drop', async e => {
      e.preventDefault();
      const isBefore = el.classList.contains('drag-before');
      clearDragIndicators();
      const targetIdx = +el.dataset.idx;
      if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;

      const cats = [...state.categories];
      const [moved] = cats.splice(dragSrcIdx, 1);
      // 제거 후 인덱스 보정
      let insertAt = dragSrcIdx < targetIdx ? targetIdx - 1 : targetIdx;
      if (!isBefore) insertAt++;
      cats.splice(Math.max(0, Math.min(insertAt, cats.length)), 0, moved);
      state.categories = cats;
      await saveCategoryOrderToFirebase();
      renderSidebar();
    });
    el.addEventListener('dragend', () => {
      clearDragIndicators();
      list.querySelectorAll('.dragging').forEach(d => d.classList.remove('dragging'));
      dragSrcIdx = null;
    });
  });
}

// ─── 렌더링: 최신 뉴스 ───────────────────────────

function renderFetched() {
  const container = document.getElementById('fetched-articles');
  const savedUrls = new Set(state.savedArticles.map(a => a.url));
  const noApiKey = !state.settings.claudeApiKey;
  const apiKeyNotice = noApiKey
    ? `<div class="api-key-notice">💡 <strong>설정</strong>에서 Claude API 키를 입력하면 기사 요약이 자동 생성됩니다</div>`
    : '';

  if (currentCatId === null) {
    // 전체 보기: 조회된 분야 존재 여부 확인
    const fetchedCatIds = new Set(Object.keys(fetchedMap));
    if (!fetchedCatIds.size) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📡</div>
          <p>조회 버튼을 눌러<br>전체 분야 뉴스를 가져오세요</p>
        </div>`;
      return;
    }

    // state.categories 순서대로 조회된 분야를 렌더링 (빈 분야 포함)
    const groupsHtml = state.categories
      .filter(cat => fetchedCatIds.has(cat.id))
      .map(cat => {
        const articles = fetchedMap[cat.id] || [];
        const body = articles.length
          ? articles.map(a => fetchedItemHtml(a, savedUrls)).join('')
          : `<div class="fetched-empty">📭 해당 기간에 기사가 없습니다</div>`;
        return `
          <div class="fetched-group">
            <div class="fetched-group-header">
              ${esc(cat.name)}
              <span class="fetched-group-count">${articles.length ? articles.length + '건' : '없음'}</span>
            </div>
            ${body}
          </div>`;
      }).join('');
    container.innerHTML = apiKeyNotice + groupsHtml;
  } else {
    const articles = fetchedMap[currentCatId] || [];
    if (!articles.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📡</div>
          <p>조회 버튼을 눌러 뉴스를 가져오세요</p>
        </div>`;
      return;
    }
    container.innerHTML = apiKeyNotice + articles.map(a => fetchedItemHtml(a, savedUrls)).join('');
  }

  container.querySelectorAll('.btn-do-save').forEach(btn => {
    btn.onclick = () => saveArticle(btn.dataset.aid);
  });
}

function fetchedItemHtml(a, savedUrls) {
  const saved = savedUrls.has(a.url);
  const srcInfo = NEWS_SOURCES.find(s => s.id === a.platform);
  const platformBadge = srcInfo
    ? `<span class="platform-badge plat-${srcInfo.id}">${srcInfo.label}</span>`
    : a.platform === 'general' ? `<span class="platform-badge plat-general">구글뉴스</span>` : '';
  const srcLabel = srcInfo?.label || '';
  const isDup = a.source && (srcLabel.includes(a.source) || a.source.includes(srcLabel));
  const metaSource = (a.source && !isDup) ? `${esc(a.source)} · ` : '';
  return `
    <div class="fetched-item${saved ? ' is-saved' : ''}">
      <div class="fetched-item-meta">
        ${platformBadge}
        <span class="fetched-meta-info">${metaSource}${timeAgo(a.publishedAt)}</span>
        ${saved
          ? `<span class="saved-badge">✓ 저장됨</span>`
          : `<button class="btn btn-xs btn-success-sm btn-do-save" data-aid="${a.id}">+ 저장</button>`}
      </div>
      <a class="card-title" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>
      ${a.summary ? `<p class="card-summary fetched-summary">${esc(a.summary)}</p>` : ''}
    </div>`;
}

// ─── 렌더링: 저장된 기사 ──────────────────────────

function articleCardHtml(a, showCatTag) {
  const srcInfo = NEWS_SOURCES.find(s => s.id === a.platform);
  const platformBadge = srcInfo
    ? `<span class="platform-badge plat-${srcInfo.id}">${srcInfo.label}</span>`
    : a.platform === 'general' ? `<span class="platform-badge plat-general">구글뉴스</span>` : '';
  const srcLabel = srcInfo?.label || '';
  const isDup = a.source && (srcLabel.includes(a.source) || a.source.includes(srcLabel));
  const metaSource = (a.source && !isDup)
    ? `<span class="meta-dot">·</span><span class="meta-source">${esc(a.source)}</span>` : '';
  return `
  <div class="article-card is-saved">
    <div class="saved-card-layout">
      <div class="saved-card-content">
        <div class="card-meta">
          ${showCatTag ? `<span class="cat-tag">${esc(a.categoryName)}</span><span class="meta-dot">·</span>` : ''}
          ${platformBadge}
          ${metaSource}
          <span class="meta-dot">·</span>
          <span class="meta-date">${timeAgo(a.publishedAt)}</span>
        </div>
        <a class="card-title" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>
        ${a.summary ? `<p class="card-summary">${esc(a.summary)}</p>` : ''}
        <div class="card-actions">
          <button class="btn btn-xs btn-danger-sm do-delete" data-aid="${a.id}">삭제</button>
        </div>
      </div>
      <div class="saved-card-memo">
        <div class="memo-editable" id="memo-edit-${a.id}" contenteditable="true" data-aid="${a.id}">${memoToHtml(a.memo)}</div>
        <span class="memo-save-status" id="memo-status-${a.id}"></span>
      </div>
    </div>
  </div>`;
}

function renderSaved() {
  const container = document.getElementById('saved-articles');

  // 전체 기사 최신순 정렬
  const base = [...state.savedArticles].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

  if (!base.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🗂</div>
        <p>저장된 기사가 없습니다</p>
      </div>`;
    return;
  }

  // ── 분류 필터 옵션: 저장된 기사에 실제 존재하는 분류만
  const catOrder = state.categories.map(c => c.id);
  const existingCatIds = [...new Set(base.map(a => a.categoryId))]
    .sort((a, b) => (catOrder.indexOf(a) ?? 999) - (catOrder.indexOf(b) ?? 999));

  // savedCatFilter가 유효하지 않으면 리셋
  if (currentCatId && !existingCatIds.includes(currentCatId)) currentCatId = null;

  // 분류 필터 적용
  const afterCat = currentCatId
    ? base.filter(a => a.categoryId === currentCatId)
    : base;

  // ── 날짜 필터: "YYYY-MM-DD" 기준
  const availDateStrs = new Set(afterCat.map(a => toDateStr(a.savedAt)));

  // 날짜 필터 적용
  const articles = savedDateFilter
    ? afterCat.filter(a => toDateStr(a.savedAt) === savedDateFilter)
    : afterCat;

  // 날짜 네비게이터 텍스트
  // ── 필터 UI (분류 드롭다운 + 날짜 네비게이터 한 줄)
  const catOptions = [
    `<option value=""${!currentCatId ? ' selected' : ''}>전체</option>`,
    ...existingCatIds.map(id => {
      const name = state.categories.find(c => c.id === id)?.name
                || base.find(a => a.categoryId === id)?.categoryName || id;
      return `<option value="${esc(id)}"${currentCatId === id ? ' selected' : ''}>${esc(name)}</option>`;
    })
  ].join('');

  const dateNavLabel = savedDateFilter ? formatDateNav(savedDateFilter) : '전체 날짜';

  const filterHtml = `
    <div class="saved-filters">
      <div class="sf-row">
        <select class="sf-cat-select" id="sf-cat-select">${catOptions}</select>
        <div class="sf-date-nav">
          <button class="sf-nav-btn" id="sf-date-prev" title="이전 날짜">&#8249;</button>
          <button class="sf-date-btn${savedDateFilter ? '' : ' all-dates'}" id="sf-date-pick">${esc(dateNavLabel)}</button>
          <button class="sf-nav-btn" id="sf-date-next" title="다음 날짜">&#8250;</button>
        </div>
      </div>
    </div>`;

  // ── 기사 목록 렌더링
  let listHtml = '';
  const showCatTag = !currentCatId;

  if (savedViewMode === 'category' && !currentCatId) {
    // 분류별 → 일자별
    const byCat = {};
    articles.forEach(a => { (byCat[a.categoryId] = byCat[a.categoryId] || []).push(a); });
    const sortedIds = Object.keys(byCat).sort(
      (a, b) => (catOrder.indexOf(a) ?? 999) - (catOrder.indexOf(b) ?? 999)
    );
    for (const catId of sortedIds) {
      const catArticles = byCat[catId];
      const catName = catArticles[0].categoryName;
      listHtml += `<div class="cat-section-header">${esc(catName)}<span class="cat-section-count">${catArticles.length}개</span></div>`;
      const dayGroups = {};
      catArticles.forEach(a => { const k = dateLabel(a.savedAt); (dayGroups[k] = dayGroups[k] || []).push(a); });
      for (const [dk, list] of Object.entries(dayGroups)) {
        listHtml += `<div class="date-divider date-divider-sub">📅 ${dk}</div>`;
        listHtml += list.map(a => articleCardHtml(a, false)).join('');
      }
    }
  } else {
    // 일별
    const dayGroups = {};
    articles.forEach(a => { const k = dateLabel(a.savedAt); (dayGroups[k] = dayGroups[k] || []).push(a); });
    for (const [dk, list] of Object.entries(dayGroups)) {
      listHtml += `<div class="date-divider">📅 ${dk}</div>`;
      listHtml += list.map(a => articleCardHtml(a, showCatTag)).join('');
    }
  }

  if (!articles.length) {
    listHtml = `<div class="empty-state"><div class="empty-icon">🗂</div><p>해당 조건의 기사가 없습니다</p></div>`;
  }

  container.innerHTML = filterHtml + listHtml;

  // 분류 드롭다운 변경
  container.querySelector('#sf-cat-select').onchange = e => {
    currentCatId = e.target.value || null;
    renderAll();
  };

  // 날짜 이전/다음
  container.querySelector('#sf-date-prev').onclick = () => navigateSavedDate(-1);
  container.querySelector('#sf-date-next').onclick = () => navigateSavedDate(+1);

  // 달력 열기
  container.querySelector('#sf-date-pick').onclick = e => {
    e.stopPropagation();
    openDateCalendar(e.currentTarget, availDateStrs);
  };

  // contenteditable 메모 이벤트 설정
  container.querySelectorAll('.memo-editable').forEach(el => {
    const aid    = el.dataset.aid;
    const status = document.getElementById(`memo-status-${aid}`);
    let saveTimer = null;

    async function saveMemo() {
      clearTimeout(saveTimer);
      const memo = el.innerHTML;
      const idx = state.savedArticles.findIndex(a => a.id === aid);
      if (idx === -1) return;
      if (state.savedArticles[idx].memo === memo) return;
      try {
        await db.ref('savedArticles/' + aid + '/memo').set(memo);
        state.savedArticles[idx].memo = memo;
        if (status) { status.textContent = '저장됨'; setTimeout(() => { status.textContent = ''; }, 1500); }
      } catch (err) {
        if (status) status.textContent = '저장 실패';
      }
    }

    el.addEventListener('focus', () => { currentMemoEditable = el; });
    el.addEventListener('input', () => {
      if (status) status.textContent = '…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveMemo, 1200);
    });
    el.addEventListener('blur', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveMemo, 200);
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); saveMemo(); }
    });
  });

  container.querySelectorAll('.do-delete').forEach(btn => {
    btn.onclick = () => deleteSaved(btn.dataset.aid);
  });
}

// ─── XSS 방어 ────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 메모를 contenteditable용 HTML로 변환 (구버전 plain text 호환)
function memoToHtml(memo) {
  if (!memo) return '';
  // HTML 태그가 포함되어 있으면 그대로 사용
  if (/<[a-zA-Z]/.test(memo)) return memo;
  // 순수 텍스트이면 escape 후 줄바꿈을 <br>로
  return esc(memo).replace(/\n/g, '<br>');
}

// ─── 전체 렌더 ────────────────────────────────────

function renderAll() {
  renderSidebar();
  renderFetched();
  renderSaved();
  syncHeaderButtons();
}

function syncHeaderButtons() {
  const hasCat = currentCatId !== null;
  const hasCats = state.categories.length > 0;
  const hasFetched = hasCat
    ? (fetchedMap[currentCatId]?.length > 0)
    : Object.values(fetchedMap).some(a => a.length > 0);
  document.getElementById('btn-fetch').disabled = !hasCats;
  const refetchBtn = document.getElementById('btn-refetch');
  if (refetchBtn) refetchBtn.disabled = !hasCats;
  document.getElementById('btn-clear-fetched').disabled = !hasFetched;
  document.getElementById('btn-analyze-category').disabled = !hasCat;
  document.getElementById('btn-clear-saved').disabled = !hasCat;

  const chip1 = document.getElementById('fetched-chip');
  const chip2 = document.getElementById('saved-chip');
  const cat = state.categories.find(c => c.id === currentCatId);

  if (hasCat && cat) {
    chip1.textContent = cat.name;
    chip2.textContent = cat.name;
  } else {
    chip1.textContent = '전체';
    chip2.textContent = '';
  }

  // 마지막 조회 시간 표시
  if (hasCat && cat?.lastFetched) {
    document.getElementById('last-fetch-time').textContent = `마지막 조회: ${timeAgo(cat.lastFetched)}`;
  } else {
    document.getElementById('last-fetch-time').textContent = '';
  }
}

// ─── 분야 선택 ────────────────────────────────────

function selectCategory(id) {
  currentCatId = id;
  savedDateFilter = null;
  renderAll();
}

// ─── 분야 CRUD ────────────────────────────────────

// ─── 키워드 칩 UI ─────────────────────────────────

function renderKeywordChips() {
  const area  = document.getElementById('kw-tag-area');
  const input = document.getElementById('input-keyword-new');
  area.querySelectorAll('.kw-chip').forEach(c => c.remove());
  editingKeywords.forEach((kw, idx) => {
    const chip = document.createElement('span');
    chip.className = 'kw-chip';
    chip.innerHTML = `${esc(kw)}<button class="kw-chip-del" title="삭제">×</button>`;
    chip.querySelector('.kw-chip-del').addEventListener('click', e => {
      e.stopPropagation();
      editingKeywords.splice(idx, 1);
      renderKeywordChips();
    });
    area.insertBefore(chip, input);
  });
}

function addKeyword(raw) {
  const parts = raw.split(/[,，]/).map(s => s.trim()).filter(s => s && !editingKeywords.includes(s));
  editingKeywords.push(...parts);
  renderKeywordChips();
}

function openAddCategory() {
  editingCatId = null;
  editingKeywords = [];
  document.getElementById('modal-category-title').textContent = '분야 추가';
  document.getElementById('input-category-name').value = '';
  renderKeywordChips();
  openModal('modal-category');
  setTimeout(() => document.getElementById('input-category-name').focus(), 80);
}

function openEditCategory(id) {
  const cat = state.categories.find(c => c.id === id);
  if (!cat) return;
  editingCatId = id;
  editingKeywords = normalizeKeywords(cat.keywords, cat.name);
  document.getElementById('modal-category-title').textContent = '분야 수정';
  document.getElementById('input-category-name').value = cat.name;
  renderKeywordChips();
  openModal('modal-category');
  setTimeout(() => document.getElementById('input-category-name').focus(), 80);
}

async function saveCategory() {
  const name = document.getElementById('input-category-name').value.trim();
  if (!name) { showToast('분야명을 입력해주세요', 'err'); return; }

  // 입력 중인 키워드도 포함
  const pending = document.getElementById('input-keyword-new').value.trim();
  if (pending) addKeyword(pending);
  document.getElementById('input-keyword-new').value = '';

  const keywords = editingKeywords.length ? editingKeywords : defaultKeywords(name);

  if (editingCatId) {
    const idx = state.categories.findIndex(c => c.id === editingCatId);
    if (idx !== -1) {
      state.categories[idx].name     = name;
      state.categories[idx].keywords = keywords;
      state.savedArticles.forEach(a => {
        if (a.categoryId === editingCatId) a.categoryName = name;
      });
      await db.ref('categories/' + editingCatId).update({ name, keywords }).catch(() => {});
    }
    showToast('분야가 수정되었습니다', 'ok');
  } else {
    if (state.categories.some(c => c.name === name)) {
      showToast('이미 존재하는 분야입니다', 'warn'); return;
    }
    const cat = { id: uid(), name, keywords, lastFetched: null, order: state.categories.length };
    state.categories.push(cat);
    await db.ref('categories/' + cat.id).set(cat).catch(() => {});
    showToast('분야가 추가되었습니다', 'ok');
  }

  closeModal('modal-category');
  renderAll();
}

function deleteCategory(id) {
  const cat = state.categories.find(c => c.id === id);
  if (!cat) return;
  const cnt = state.savedArticles.filter(a => a.categoryId === id).length;
  const msg = cnt > 0
    ? `"${cat.name}" 분야와 저장된 기사 ${cnt}개를 삭제합니다. 계속할까요?`
    : `"${cat.name}" 분야를 삭제합니다. 계속할까요?`;
  if (!confirm(msg)) return;

  state.categories = state.categories.filter(c => c.id !== id);
  state.savedArticles = state.savedArticles.filter(a => a.categoryId !== id);
  delete fetchedMap[id];
  db.ref('categories/' + id).remove().catch(() => {});
  db.ref('fetchedArticles/' + id).remove().catch(() => {});

  if (currentCatId === id) currentCatId = null;
  renderAll();
  showToast('분야가 삭제되었습니다');
}

// ─── 뉴스 조회 실행 ───────────────────────────────

async function doFetch(force = false) {
  const btn = document.getElementById('btn-fetch');
  const refetchBtn = document.getElementById('btn-refetch');
  btn.disabled = true;
  if (refetchBtn) refetchBtn.disabled = true;

  const container = document.getElementById('fetched-articles');

  // 전체 조회 — 순차 처리로 누락 방지
  if (!currentCatId) {
    if (!state.categories.length) { btn.disabled = false; if (refetchBtn) refetchBtn.disabled = false; return; }
    btn.textContent = force ? '재조회 중...' : '조회 중...';

    const cats  = state.categories;
    const total = cats.length;
    const now   = new Date().toISOString();
    let totalArticles = 0;

    try {
      for (let i = 0; i < cats.length; i++) {
        const cat = cats[i];
        container.innerHTML = `
          <div class="loading-row">
            <div class="spinner"></div>
            <span>(${i + 1}/${total}) <strong>${esc(cat.name)}</strong> 조회 중…</span>
          </div>`;

        try {
          let articles = await fetchNewsForCategory(cat, force);
          articles = await summarizeWithAI(articles);
          fetchedMap[cat.id] = mergeArticles(fetchedMap[cat.id] || [], articles);
          totalArticles += articles.length;
        } catch {
          fetchedMap[cat.id] = fetchedMap[cat.id] || []; // 실패 시 기존 유지
        }

        const idx = state.categories.findIndex(c => c.id === cat.id);
        if (idx !== -1) state.categories[idx].lastFetched = now;
        await saveFetchedToFirebase(cat.id, fetchedMap[cat.id]);
      }

      showToast(
        totalArticles ? `전체 ${totalArticles}개 기사를 가져왔습니다` : '새 기사가 없습니다',
        totalArticles ? 'ok' : 'warn'
      );
      renderAll();
    } catch (err) {
      console.error(err);
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>조회 실패: ${esc(err.message)}</p></div>`;
      showToast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 조회';
      if (refetchBtn) refetchBtn.disabled = false;
    }
    return;
  }

  // 단일 분야 조회
  const cat = state.categories.find(c => c.id === currentCatId);
  if (!cat) { btn.disabled = false; if (refetchBtn) refetchBtn.disabled = false; return; }

  btn.textContent = force ? '재조회 중...' : '조회 중...';
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div>뉴스를 가져오는 중...</div>`;

  try {
    let articles = await fetchNewsForCategory(cat, force);
    articles = await summarizeWithAI(articles);
    fetchedMap[currentCatId] = mergeArticles(fetchedMap[currentCatId] || [], articles);

    const idx = state.categories.findIndex(c => c.id === currentCatId);
    if (idx !== -1) state.categories[idx].lastFetched = new Date().toISOString();
    await saveFetchedToFirebase(currentCatId, fetchedMap[currentCatId]);

    showToast(articles.length ? `${articles.length}개 기사를 가져왔습니다` : '해당 기간에 새 기사가 없습니다', articles.length ? 'ok' : 'warn');
    renderAll();
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>조회 실패: ${esc(err.message)}</p></div>`;
    showToast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 조회';
    if (refetchBtn) refetchBtn.disabled = false;
  }
}

// ─── 기사 저장 / 삭제 ─────────────────────────────

async function saveArticle(articleId) {
  let article = null;
  for (const arr of Object.values(fetchedMap)) {
    article = arr.find(a => a.id === articleId);
    if (article) break;
  }
  if (!article) return;

  if (state.savedArticles.some(a => a.url === article.url)) {
    showToast('이미 저장된 기사입니다', 'warn'); return;
  }

  const saved = { ...article, savedAt: new Date().toISOString(), memo: '' };
  try {
    await db.ref('savedArticles/' + saved.id).set(saved);
    state.savedArticles.push(saved);
    showToast('기사가 저장되었습니다', 'ok');
    renderAll();
  } catch (err) {
    showToast('저장 실패: ' + err.message, 'err');
  }
}

async function deleteSaved(articleId) {
  try {
    await db.ref('savedArticles/' + articleId).remove();
    state.savedArticles = state.savedArticles.filter(a => a.id !== articleId);
    showToast('기사가 삭제되었습니다');
    renderAll();
  } catch (err) {
    showToast('삭제 실패: ' + err.message, 'err');
  }
}

async function clearSavedForCategory() {
  if (!currentCatId) return;
  const toDelete = state.savedArticles.filter(a => a.categoryId === currentCatId);
  if (!toDelete.length) { showToast('저장된 기사가 없습니다', 'warn'); return; }
  if (!confirm(`저장된 기사 ${toDelete.length}개를 모두 삭제합니다. 계속할까요?`)) return;

  try {
    const updates = {};
    toDelete.forEach(a => { updates['savedArticles/' + a.id] = null; });
    await db.ref().update(updates);
    state.savedArticles = state.savedArticles.filter(a => a.categoryId !== currentCatId);
    renderAll();
    showToast('삭제 완료');
  } catch (err) {
    showToast('삭제 실패: ' + err.message, 'err');
  }
}

// ─── 메모 ────────────────────────────────────────

function openMemoModal(articleId) {
  const article = state.savedArticles.find(a => a.id === articleId);
  if (!article) return;
  memoTargetId = articleId;

  document.getElementById('memo-article-preview').innerHTML = `
    <strong>${esc(article.title)}</strong>
    ${dateTimeLabel(article.publishedAt)} · ${esc(article.source || '')}`;

  document.getElementById('input-memo').value = article.memo || '';
  openModal('modal-memo');
  setTimeout(() => document.getElementById('input-memo').focus(), 80);
}

function saveMemo() {
  const memo = document.getElementById('input-memo').value.trim();
  const idx = state.savedArticles.findIndex(a => a.id === memoTargetId);
  if (idx === -1) return;
  state.savedArticles[idx].memo = memo;
  saveStateToStorage(state);
  closeModal('modal-memo');
  showToast('메모가 저장되었습니다', 'ok');
  renderSaved();
}

// ─── 설정 ────────────────────────────────────────

function openSettings() {
  const key = state.settings.claudeApiKey || '';
  document.getElementById('input-api-key').value = key;
  const statusEl = document.getElementById('api-key-status');
  if (statusEl) {
    statusEl.textContent = key ? `✓ 저장된 키: ${key.slice(0, 12)}…` : '키가 저장되지 않았습니다';
    statusEl.className = `api-key-status ${key ? 'status-ok' : 'status-warn'}`;
  }
  openModal('modal-settings');
  setTimeout(() => document.getElementById('input-api-key').focus(), 80);
}

function saveSettings() {
  state.settings.claudeApiKey = document.getElementById('input-api-key').value.trim();
  saveSettingsToStorage(state.settings);
  const statusEl = document.getElementById('api-key-status');
  if (statusEl) {
    const key = state.settings.claudeApiKey;
    statusEl.textContent = key ? `✓ 저장된 키: ${key.slice(0, 12)}…` : '키가 저장되지 않았습니다';
    statusEl.className = `api-key-status ${key ? 'status-ok' : 'status-warn'}`;
  }
  closeModal('modal-settings');
  showToast('설정이 저장되었습니다', 'ok');
}

const CLAUDE_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-3-5-haiku-latest',
  'claude-3-5-haiku-20241022'
];

function extractClaudeText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

async function callClaudeWithFallback(apiKey, messages, maxTokens = 1024) {
  let lastError = '응답을 받을 수 없습니다';

  for (const model of CLAUDE_MODELS) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages
        })
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        const msg = errBody.error?.message || `HTTP ${resp.status}`;
        lastError = msg;
        if (resp.status === 404 || /model/i.test(msg)) continue;
        throw new Error(msg);
      }

      const data = await resp.json();
      return { model, text: extractClaudeText(data), data };
    } catch (err) {
      lastError = err.message || String(err);
      if (/model/i.test(lastError)) continue;
      throw err;
    }
  }

  throw new Error(`사용 가능한 Claude 모델이 없습니다: ${lastError}`);
}

async function testApiKey() {
  const key = document.getElementById('input-api-key').value.trim();
  const statusEl = document.getElementById('api-key-status');
  if (!key) {
    if (statusEl) { statusEl.textContent = '⚠ API 키를 입력하세요'; statusEl.className = 'api-key-status status-warn'; }
    return;
  }
  if (statusEl) { statusEl.textContent = '테스트 중...'; statusEl.className = 'api-key-status'; }
  try {
    const result = await callClaudeWithFallback(
      key,
      [{ role: 'user', content: '안녕' }],
      20
    );
    if (statusEl) { statusEl.textContent = `✓ 연결 성공! (${result.model})`; statusEl.className = 'api-key-status status-ok'; }
  } catch (err) {
    if (statusEl) { statusEl.textContent = `✕ 연결 실패: ${err.message}`; statusEl.className = 'api-key-status status-err'; }
  }
}

// ─── 트렌드 분석 (Claude API) ────────────────────

async function analyzeTrends(catId) {
  const apiKey = state.settings.claudeApiKey;
  if (!apiKey) {
    showToast('설정에서 Claude API 키를 먼저 입력해주세요', 'err');
    openSettings();
    return;
  }

  let articles = catId
    ? state.savedArticles.filter(a => a.categoryId === catId)
    : [...state.savedArticles];

  if (!articles.length) {
    showToast('저장된 기사가 없습니다. 기사를 먼저 저장해주세요', 'warn');
    return;
  }

  const cat = state.categories.find(c => c.id === catId);
  const title = catId ? `"${cat?.name}" 트렌드 분석` : '경제 전반 트렌드 분석';
  document.getElementById('analysis-modal-title').textContent = title;

  document.getElementById('analysis-result').innerHTML = `
    <div class="analysis-loading">
      <div class="spinner"></div>
      <p>AI가 분석하고 있습니다…</p>
    </div>`;
  openModal('modal-analysis');

  // 최신 순, 최대 30개
  const sorted = [...articles].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt)).slice(0, 30);
  const articleBlock = sorted.map((a, i) => {
    const dateStr = new Date(a.savedAt).toLocaleDateString('ko-KR');
    const lines = [
      `${i + 1}. [${dateStr}] ${a.title}`,
      a.summary ? `   요약: ${a.summary}` : '',
      a.memo    ? `   내 메모: ${a.memo}` : ''
    ].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n');

  const context = catId
    ? `"${cat?.name}" 분야의`
    : '경제 전반의';

  const prompt = [
    `다음은 ${context} 최근 경제 뉴스 기사 목록입니다 (최신 순):`,
    '',
    articleBlock,
    '',
    '위 기사들을 분석하여 다음 내용을 한국어로 상세하게 작성해주세요:',
    '',
    '1. **주요 이슈 및 핵심 트렌드** (3~5가지)',
    '2. **최근 변화 및 흐름** (시간적 관점)',
    '3. **시장·경제에 미치는 영향**',
    '4. **향후 주목 포인트 및 전망**',
    '',
    '전문적이고 실용적인 분석을 부탁드립니다.'
  ].join('\n');

  try {
    const result = await callClaudeWithFallback(
      apiKey,
      [{ role: 'user', content: prompt }],
      2048
    );
    const text = result.text;
    renderAnalysis(text, sorted.length);

  } catch (err) {
    console.error(err);
    document.getElementById('analysis-result').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <p>분석 실패: ${esc(err.message)}</p>
      </div>`;
  }
}

function renderAnalysis(text, articleCount) {
  // 마크다운 → HTML (기본 변환)
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,3} (.+)$/gm, '<h4>$1</h4>')
    .replace(/^([0-9]+)\. (.+)$/gm, '<p><strong>$1.</strong> $2</p>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)\n(?=<li>)/g, '$1')
    .replace(/(<li>.*<\/li>)/gs, m => `<ul>${m}</ul>`)
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br>');

  // <p> 래핑 정리
  if (!html.startsWith('<')) html = '<p>' + html;
  if (!html.endsWith('>')) html += '</p>';

  const meta = `<div class="analysis-meta">분석 기준 기사 수: ${articleCount}개 · ${new Date().toLocaleString('ko-KR')}</div>`;

  document.getElementById('analysis-result').innerHTML =
    `<div class="analysis-text">${html}</div>${meta}`;
}

// ─── 이벤트 바인딩 ────────────────────────────────

function bindEvents() {
  // 설정
  document.getElementById('btn-settings').onclick = openSettings;
  document.getElementById('btn-save-settings').onclick = saveSettings;
  document.getElementById('btn-test-api').onclick = testApiKey;

  // 분야 추가
  document.getElementById('btn-add-category').onclick = openAddCategory;
  document.getElementById('btn-save-category').onclick = saveCategory;
  document.getElementById('input-category-name').onkeydown = e => {
    if (e.key === 'Enter') saveCategory();
  };

  // 분야명 입력 시 키워드 자동 설정 (추가 모드에서만)
  document.getElementById('input-category-name').oninput = e => {
    if (editingCatId) return;
    editingKeywords = defaultKeywords(e.target.value.trim());
    renderKeywordChips();
  };

  // 키워드 입력 필드 — Enter·쉼표로 추가, Backspace로 마지막 삭제
  document.getElementById('input-keyword-new').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = e.target.value.trim();
      if (val) { addKeyword(val); e.target.value = ''; }
    } else if (e.key === 'Backspace' && !e.target.value && editingKeywords.length) {
      editingKeywords.pop();
      renderKeywordChips();
    }
  });

  // 추천 태그 클릭 → 분야명 + 기본 키워드 자동 설정
  document.querySelectorAll('.tag-btn').forEach(btn => {
    btn.onclick = () => {
      document.getElementById('input-category-name').value = btn.dataset.tag;
      editingKeywords = defaultKeywords(btn.dataset.tag);
      renderKeywordChips();
      document.getElementById('input-category-name').focus();
    };
  });

  // 뉴스 조회
  document.getElementById('btn-fetch').onclick = () => doFetch(false);
  document.getElementById('btn-refetch').onclick = () => doFetch(true);

  // 메모
  document.getElementById('btn-save-memo').onclick = saveMemo;
  document.getElementById('input-memo').onkeydown = e => {
    if (e.key === 'Enter' && e.ctrlKey) saveMemo();
  };

  // 분석
  document.getElementById('btn-analyze-all').onclick = () => analyzeTrends(null);
  document.getElementById('btn-analyze-category').onclick = () => analyzeTrends(currentCatId);

  // 조회 기사 삭제
  document.getElementById('btn-clear-fetched').onclick = clearFetchedArticles;

  // 전체 삭제
  document.getElementById('btn-clear-saved').onclick = clearSavedForCategory;

}

// ─── Firebase 헬퍼 / 데이터 로드 ────────────────────

async function summarizeWithAI(articles) {
  const apiKey = state.settings.claudeApiKey;
  if (!apiKey) {
    console.log('[summarizeWithAI] API 키 없음 — 요약 건너뜀');
    return articles;
  }
  if (!articles.length) return articles;

  console.log(`[summarizeWithAI] 시작: ${articles.length}개 기사, 키: ${apiKey.slice(0, 12)}…`);
  showToast(`AI 요약 생성 중… (${articles.length}개)`, '');

  const items = articles.map((a, i) => `[${i}] ${a.title}`).join('\n');

  const prompt = `아래 경제 뉴스 기사 제목 목록을 보고, 각 기사의 핵심을 50자 이내 한국어 한 문장으로 요약하세요.
반드시 JSON 배열만 출력하세요 (설명 없이):
[{"i":0,"s":"요약"},{"i":1,"s":"요약"},...]

${items}`;

  try {
    const result = await callClaudeWithFallback(
      apiKey,
      [{ role: 'user', content: prompt }],
      2000
    );
    const text = result.text;
    console.log('[summarizeWithAI] 응답:', text.slice(0, 300));

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      console.error('[summarizeWithAI] JSON 파싱 실패. 응답:', text.slice(0, 300));
      showToast('AI 요약 파싱 실패 (콘솔 확인)', 'err');
      return articles;
    }

    let summaries;
    try {
      summaries = JSON.parse(match[0]);
    } catch (parseErr) {
      console.error('[summarizeWithAI] JSON 파싱 오류:', parseErr.message, match[0].slice(0, 200));
      showToast('AI 요약 JSON 오류 (콘솔 확인)', 'err');
      return articles;
    }

    const mapped = articles.map((a, i) => {
      const found = summaries.find(s => s.i === i);
      return found?.s ? { ...a, summary: found.s } : a;
    });

    const successCount = mapped.filter(a => a.summary).length;
    console.log(`[summarizeWithAI] 완료: ${successCount}/${articles.length}개 요약 성공`);
    showToast(`AI 요약 완료 (${successCount}개)`, 'ok');
    return mapped;

  } catch (err) {
    console.error('[summarizeWithAI] 예외:', err);
    showToast(`AI 요약 오류: ${err.message}`, 'err');
    return articles;
  }
}

async function saveCategoryOrderToFirebase() {
  const updates = {};
  state.categories.forEach((cat, idx) => {
    cat.order = idx;
    updates['categories/' + cat.id + '/order'] = idx;
  });
  await db.ref().update(updates).catch(() => {});
}

async function saveFetchedToFirebase(catId, articles) {
  const obj = {};
  articles.forEach(a => { obj[a.id] = a; });
  await db.ref('fetchedArticles/' + catId).set(obj).catch(() => {});
}

// ─── 날짜 네비게이터 / 달력 팝업 ─────────────────────

function navigateSavedDate(delta) {
  const base = savedDateFilter ? parseDateStr(savedDateFilter) : new Date();
  base.setDate(base.getDate() + delta);
  savedDateFilter = toDateStr(base.toISOString());
  renderSaved();
}

function openDateCalendar(anchorEl, availDateStrs) {
  const cal = document.getElementById('date-calendar');
  if (cal.classList.contains('open')) { cal.classList.remove('open'); return; }

  const base = savedDateFilter ? parseDateStr(savedDateFilter) : new Date();
  calendarMonth = new Date(base.getFullYear(), base.getMonth(), 1);

  renderCalendarInner(availDateStrs);

  // 위치 계산
  const rect = anchorEl.getBoundingClientRect();
  cal.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
  cal.style.top  = (rect.bottom + 6) + 'px';
  cal.classList.add('open');
  cal._availDateStrs = availDateStrs;
}

function renderCalendarInner(availDateStrs) {
  availDateStrs = availDateStrs || document.getElementById('date-calendar')._availDateStrs || new Set();
  const cal   = document.getElementById('date-calendar');
  const year  = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const todayStr   = toDateStr(new Date().toISOString());
  const monthLabel = new Date(year, month, 1).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' });
  const firstWd    = new Date(year, month, 1).getDay();
  const lastDay    = new Date(year, month + 1, 0).getDate();

  let cells = '';
  for (let i = 0; i < firstWd; i++) cells += '<span class="cal-cell empty"></span>';
  for (let d = 1; d <= lastDay; d++) {
    const ds  = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const cls = ['cal-cell',
      availDateStrs.has(ds) ? 'has-art' : 'no-art',
      ds === todayStr        ? 'today'   : '',
      ds === savedDateFilter ? 'selected': ''
    ].filter(Boolean).join(' ');
    cells += `<button class="${cls}" data-ds="${ds}">${d}</button>`;
  }

  cal.innerHTML = `
    <div class="cal-header">
      <button class="cal-nav" id="cal-prev">&#8249;</button>
      <span class="cal-month">${monthLabel}</span>
      <button class="cal-nav" id="cal-next">&#8250;</button>
    </div>
    <div class="cal-wdays"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-footer">
      <button class="cal-foot-btn" id="cal-today">오늘</button>
      <button class="cal-foot-btn" id="cal-all">전체 보기</button>
    </div>`;

  cal.querySelector('#cal-prev').onclick = e => { e.stopPropagation(); calendarMonth = new Date(year, month-1, 1); renderCalendarInner(); };
  cal.querySelector('#cal-next').onclick = e => { e.stopPropagation(); calendarMonth = new Date(year, month+1, 1); renderCalendarInner(); };
  cal.querySelector('#cal-today').onclick = e => { e.stopPropagation(); savedDateFilter = todayStr; closeDateCalendar(); renderSaved(); };
  cal.querySelector('#cal-all').onclick   = e => { e.stopPropagation(); savedDateFilter = null;    closeDateCalendar(); renderSaved(); };
  cal.querySelectorAll('.cal-cell[data-ds]').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); savedDateFilter = btn.dataset.ds; closeDateCalendar(); renderSaved(); };
  });
}

function closeDateCalendar() {
  document.getElementById('date-calendar').classList.remove('open');
}

async function clearFetchedArticles() {
  if (currentCatId) {
    if (!fetchedMap[currentCatId]?.length) return;
    delete fetchedMap[currentCatId];
    await db.ref('fetchedArticles/' + currentCatId).remove().catch(() => {});
  } else {
    if (!Object.values(fetchedMap).some(a => a.length > 0)) return;
    fetchedMap = {};
    await db.ref('fetchedArticles').remove().catch(() => {});
  }
  renderFetched();
  syncHeaderButtons();
  showToast('조회된 기사가 삭제되었습니다');
}

function loadFromFirebase() {
  Promise.all([
    db.ref('categories').once('value'),
    db.ref('savedArticles').once('value'),
    db.ref('fetchedArticles').once('value')
  ]).then(([catsSnap, savedSnap, fetchedSnap]) => {
    const catsData = catsSnap.val() || {};
    state.categories = Object.values(catsData).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

    const saved = savedSnap.val() || {};
    state.savedArticles = Object.values(saved);

    const fetched = fetchedSnap.val() || {};
    Object.entries(fetched).forEach(([catId, articlesObj]) => {
      fetchedMap[catId] = Object.values(articlesObj)
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    });

    renderAll();
  }).catch(err => {
    console.warn('Firebase 불러오기 실패:', err.message);
  });
}

// ─── 메모 플로팅 툴바 ────────────────────────────

function initFloatToolbar() {
  const toolbar = document.getElementById('memo-float-toolbar');

  // 선택 변경 감지 (rAF로 디바운스)
  let rafId = null;
  document.addEventListener('selectionchange', () => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(updateFloatToolbar);
  });

  function updateFloatToolbar() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideFloatToolbar();
      return;
    }
    const range = sel.getRangeAt(0);
    const node  = range.commonAncestorContainer;
    const editable = (node.nodeType === 3 ? node.parentElement : node)
      ?.closest('.memo-editable');
    if (!editable) { hideFloatToolbar(); return; }

    const rect = range.getBoundingClientRect();
    if (!rect.width) { hideFloatToolbar(); return; }

    currentMemoEditable = editable;
    positionFloatToolbar(rect);
  }

  function positionFloatToolbar(selRect) {
    toolbar.classList.add('visible');
    // 크기 확보 후 위치 계산
    requestAnimationFrame(() => {
      const tbW = toolbar.offsetWidth;
      const tbH = toolbar.offsetHeight;
      let top  = selRect.top - tbH - 10;
      let left = selRect.left + (selRect.width - tbW) / 2;
      // 화면 위쪽 넘침 → 선택 영역 아래에 표시
      if (top < 6) top = selRect.bottom + 10;
      left = Math.max(6, Math.min(left, window.innerWidth - tbW - 6));
      toolbar.style.top  = top  + 'px';
      toolbar.style.left = left + 'px';
    });
  }

  function hideFloatToolbar() {
    toolbar.classList.remove('visible');
  }

  // 툴바 버튼: mousedown + preventDefault → 선택 유지
  toolbar.querySelectorAll('.memo-fmt-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      if (!currentMemoEditable) return;
      currentMemoEditable.focus();
      document.execCommand(btn.dataset.cmd, false, btn.dataset.val || null);
    });
  });
  toolbar.querySelectorAll('.memo-color-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      if (!currentMemoEditable) return;
      currentMemoEditable.focus();
      document.execCommand('foreColor', false, btn.dataset.color);
    });
  });
}

// ─── 초기화 ───────────────────────────────────────

function init() {
  // localStorage에서 설정 복원
  const saved = loadSettingsFromStorage();
  if (saved.claudeApiKey) state.settings.claudeApiKey = saved.claudeApiKey;

  // 날짜 필터 기본값: 오늘
  savedDateFilter = toDateStr(new Date().toISOString());

  bindEvents();
  renderAll();
  loadFromFirebase();
  initFloatToolbar();

  // 달력 외부 클릭 시 닫기
  document.addEventListener('click', () => closeDateCalendar());
  document.getElementById('date-calendar').addEventListener('click', e => e.stopPropagation());
}

document.addEventListener('DOMContentLoaded', init);
