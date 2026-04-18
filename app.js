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

function saveStateToStorage() {}

// ─── 앱 상태 ─────────────────────────────────────

let state = defaultState();
let fetchedMap = {};      // { categoryId: [article, ...] }
let currentCatId = null;  // null = 전체, string = 특정 분야
let editingCatId = null;
let memoTargetId = null;

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

const PROXIES = [
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`
];

// 조회 대상 뉴스 소스
const NEWS_SOURCES = [
  { id: 'mk',     label: '매일경제', domain: 'mk.co.kr' },
  { id: 'hk',     label: '한국경제', domain: 'hankyung.com' },
  { id: 'naver',  label: '네이버뉴스', domain: 'n.news.naver.com' }
];

async function fetchRaw(url) {
  let lastErr;
  for (let i = 0; i < PROXIES.length; i++) {
    try {
      const proxyUrl = PROXIES[i](url);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();

      // allorigins JSON 응답 처리 (get 엔드포인트)
      if (proxyUrl.includes('allorigins.win/get')) {
        try {
          const json = JSON.parse(text);
          if (json.contents) return json.contents;
        } catch {}
      }
      // raw XML인지 확인
      if (text.trim().startsWith('<')) return text;
      // JSON 시도
      try {
        const json = JSON.parse(text);
        if (json.contents) return json.contents;
      } catch {}
      return text;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
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
    const summary = truncate(descRaw, 200);
    const source = item.querySelector('source')?.textContent?.trim() || '';

    articles.push({
      id: uid(),
      categoryId,
      categoryName,
      title,
      summary,
      url,
      source,    // RSS의 실제 언론사명
      platform,  // 'mk' | 'hk' | 'naver'
      publishedAt: pubDate.toISOString()
    });

    if (articles.length >= 10) break;
  }

  return articles;
}

// 단일 소스에서 기사 조회 (실패해도 빈 배열 반환)
async function fetchFromSource(keyword, src, cutoff, catId, catName) {
  try {
    const q = encodeURIComponent(`${keyword} site:${src.domain}`);
    const rssUrl = `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
    const xmlText = await fetchRaw(rssUrl);
    return parseRSS(xmlText, cutoff, catId, catName, src.id);
  } catch (err) {
    console.warn(`[${src.label}] 조회 실패:`, err.message);
    return null; // null = 오류, [] = 성공이나 결과 없음
  }
}

// site 필터 없는 일반 키워드 검색 (폴백)
async function fetchGeneralNews(keyword, cutoff, catId, catName) {
  const q = encodeURIComponent(keyword);
  const rssUrl = `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
  const xmlText = await fetchRaw(rssUrl);
  return parseRSS(xmlText, cutoff, catId, catName, 'general');
}

async function fetchNewsForCategory(cat) {
  // cutoff는 항상 24시간 (lastFetched 기반 제한 제거 — 재조회 시 결과 안 나오는 버그 수정)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // 3개 소스 병렬 조회
  const results = await Promise.all(
    NEWS_SOURCES.map(src => fetchFromSource(cat.name, src, cutoff, cat.id, cat.name))
  );

  const hasProxyError = results.every(r => r === null);

  // 모든 소스가 프록시 오류면 키워드 일반 검색으로 폴백
  if (hasProxyError) {
    console.warn('모든 소스 조회 실패 — 일반 키워드 검색으로 폴백');
    const fallback = await fetchGeneralNews(cat.name, cutoff, cat.id, cat.name);
    if (fallback.length > 0) return fallback;
    throw new Error('뉴스를 가져올 수 없습니다. CORS 프록시 서버가 응답하지 않습니다. 잠시 후 다시 시도해주세요.');
  }

  // null(오류)은 빈 배열로 교체
  const validResults = results.map(r => r || []);

  // 소스별로 균형 있게 합치고 URL 중복 제거
  const seen = new Set();
  const merged = [];
  const buckets = validResults.map(arr => [...arr]);

  let round = 0;
  while (merged.length < 12) {
    let added = false;
    for (const bucket of buckets) {
      if (bucket.length === 0) continue;
      const article = bucket.shift();
      if (seen.has(article.url)) continue;
      seen.add(article.url);
      merged.push(article);
      added = true;
      if (merged.length >= 12) break;
    }
    if (!added) break;
    round++;
    if (round > 30) break;
  }

  // 결과가 없으면 일반 검색 폴백
  if (merged.length === 0) {
    const fallback = await fetchGeneralNews(cat.name, cutoff, cat.id, cat.name).catch(() => []);
    if (fallback.length > 0) return filterByKeyword(fallback, cat.name);
  }

  merged.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return filterByKeyword(merged, cat.name);
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

  const catItems = state.categories.map(cat => {
    const cnt = state.savedArticles.filter(a => a.categoryId === cat.id).length;
    const active = cat.id === currentCatId;
    return `
      <li class="category-item${active ? ' active' : ''}" data-id="${cat.id}">
        <span class="category-dot"></span>
        <span class="category-name">${esc(cat.name)}</span>
        ${cnt ? `<span class="cat-count">${cnt}</span>` : ''}
        <div class="cat-btns">
          <button class="cat-btn edit" data-id="${cat.id}" title="수정"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="cat-btn del"  data-id="${cat.id}" title="삭제">✕</button>
        </div>
      </li>`;
  }).join('');

  list.innerHTML = allItem + catItems;

  // 이벤트 위임
  list.onclick = e => {
    const editBtn = e.target.closest('.cat-btn.edit');
    const delBtn  = e.target.closest('.cat-btn.del');
    const item    = e.target.closest('.category-item');
    if (!item) return;

    if (editBtn) { openEditCategory(editBtn.dataset.id); return; }
    if (delBtn)  { deleteCategory(delBtn.dataset.id);    return; }
    selectCategory(item.dataset.id === 'all' ? null : item.dataset.id);
  };
}

// ─── 렌더링: 최신 뉴스 ───────────────────────────

function renderFetched() {
  const container = document.getElementById('fetched-articles');
  const savedUrls = new Set(state.savedArticles.map(a => a.url));

  if (currentCatId === null) {
    // 전체 보기: 분야별 그룹
    const groups = Object.entries(fetchedMap).filter(([, arr]) => arr.length > 0);
    if (!groups.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📡</div>
          <p>조회 버튼을 눌러<br>전체 분야 뉴스를 가져오세요</p>
        </div>`;
      return;
    }
    container.innerHTML = groups.map(([catId, articles]) => {
      const cat = state.categories.find(c => c.id === catId);
      return `
        <div class="fetched-group">
          <div class="fetched-group-header">${esc(cat?.name || '기타')}</div>
          ${articles.map(a => fetchedItemHtml(a, savedUrls)).join('')}
        </div>`;
    }).join('');
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
    container.innerHTML = articles.map(a => fetchedItemHtml(a, savedUrls)).join('');
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

function renderSaved() {
  const container = document.getElementById('saved-articles');

  let articles = currentCatId === null
    ? [...state.savedArticles]
    : state.savedArticles.filter(a => a.categoryId === currentCatId);

  // 최신 순 정렬
  articles.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

  if (!articles.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🗂</div>
        <p>저장된 기사가 없습니다</p>
      </div>`;
    return;
  }

  // 날짜별 그룹핑
  const groups = {};
  articles.forEach(a => {
    const key = dateLabel(a.savedAt);
    (groups[key] = groups[key] || []).push(a);
  });

  let html = '';
  for (const [dateKey, list] of Object.entries(groups)) {
    html += `<div class="date-divider">📅 ${dateKey}</div>`;
    html += list.map(a => {
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
              ${currentCatId === null ? `<span class="cat-tag">${esc(a.categoryName)}</span><span class="meta-dot">·</span>` : ''}
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
            <div class="memo-display" id="memo-display-${a.id}">
              ${a.memo
                ? `<div class="card-memo">${esc(a.memo)}</div>`
                : `<p class="memo-empty">메모를 입력하세요</p>`}
              <button class="btn btn-xs btn-memo do-memo" data-aid="${a.id}">${a.memo ? '✏ 수정' : '💬 추가'}</button>
            </div>
            <div class="inline-memo-editor" id="memo-editor-${a.id}">
              <textarea class="inline-memo-textarea" placeholder="의견, 분석, 메모...">${esc(a.memo || '')}</textarea>
              <div class="inline-memo-actions">
                <button class="btn btn-xs btn-primary do-save-inline-memo" data-aid="${a.id}">저장</button>
                <button class="btn btn-xs btn-secondary do-cancel-memo" data-aid="${a.id}">취소</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  container.innerHTML = html;

  container.querySelectorAll('.do-memo').forEach(btn => {
    btn.onclick = () => {
      const aid = btn.dataset.aid;
      const editor = document.getElementById(`memo-editor-${aid}`);
      const display = document.getElementById(`memo-display-${aid}`);
      const isOpen = editor.classList.contains('open');
      // 다른 에디터 모두 닫기
      container.querySelectorAll('.inline-memo-editor').forEach(e => e.classList.remove('open'));
      container.querySelectorAll('.memo-display').forEach(d => d.style.display = '');
      if (!isOpen) {
        editor.classList.add('open');
        display.style.display = 'none';
        editor.querySelector('textarea').focus();
      }
    };
  });

  container.querySelectorAll('.do-save-inline-memo').forEach(btn => {
    btn.onclick = async () => {
      const aid = btn.dataset.aid;
      const editor = document.getElementById(`memo-editor-${aid}`);
      const memo = editor.querySelector('textarea').value.trim();
      const idx = state.savedArticles.findIndex(a => a.id === aid);
      if (idx !== -1) {
        try {
          await db.ref('savedArticles/' + aid + '/memo').set(memo);
          state.savedArticles[idx].memo = memo;
          showToast('메모가 저장되었습니다', 'ok');
          renderSaved();
        } catch (err) {
          showToast('저장 실패: ' + err.message, 'err');
        }
      }
    };
  });

  container.querySelectorAll('.do-cancel-memo').forEach(btn => {
    btn.onclick = () => {
      const aid = btn.dataset.aid;
      document.getElementById(`memo-editor-${aid}`).classList.remove('open');
      document.getElementById(`memo-display-${aid}`).style.display = '';
    };
  });

  container.querySelectorAll('.inline-memo-textarea').forEach(ta => {
    ta.onkeydown = e => {
      if (e.key === 'Enter' && e.ctrlKey) {
        ta.closest('.inline-memo-editor').querySelector('.do-save-inline-memo').click();
      }
    };
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
  renderAll();
}

// ─── 분야 CRUD ────────────────────────────────────

function openAddCategory() {
  editingCatId = null;
  document.getElementById('modal-category-title').textContent = '분야 추가';
  document.getElementById('input-category-name').value = '';
  openModal('modal-category');
  setTimeout(() => document.getElementById('input-category-name').focus(), 80);
}

function openEditCategory(id) {
  const cat = state.categories.find(c => c.id === id);
  if (!cat) return;
  editingCatId = id;
  document.getElementById('modal-category-title').textContent = '분야 수정';
  document.getElementById('input-category-name').value = cat.name;
  openModal('modal-category');
  setTimeout(() => document.getElementById('input-category-name').focus(), 80);
}

async function saveCategory() {
  const name = document.getElementById('input-category-name').value.trim();
  if (!name) { showToast('분야명을 입력해주세요', 'err'); return; }

  if (editingCatId) {
    const idx = state.categories.findIndex(c => c.id === editingCatId);
    if (idx !== -1) {
      state.categories[idx].name = name;
      state.savedArticles.forEach(a => {
        if (a.categoryId === editingCatId) a.categoryName = name;
      });
      await db.ref('categories/' + editingCatId + '/name').set(name).catch(() => {});
    }
    showToast('분야가 수정되었습니다', 'ok');
  } else {
    if (state.categories.some(c => c.name === name)) {
      showToast('이미 존재하는 분야입니다', 'warn'); return;
    }
    const cat = { id: uid(), name, lastFetched: null };
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

async function doFetch() {
  const btn = document.getElementById('btn-fetch');
  btn.disabled = true;

  const container = document.getElementById('fetched-articles');

  // 전체 조회
  if (!currentCatId) {
    if (!state.categories.length) return;
    btn.textContent = '조회 중...';
    container.innerHTML = `<div class="loading-row"><div class="spinner"></div>전체 분야 뉴스를 가져오는 중...</div>`;

    try {
      const now = new Date().toISOString();
      await Promise.all(state.categories.map(async cat => {
        let articles = await fetchNewsForCategory(cat).catch(() => []);
        articles = await summarizeWithAI(articles);
        fetchedMap[cat.id] = articles;
        const idx = state.categories.findIndex(c => c.id === cat.id);
        if (idx !== -1) state.categories[idx].lastFetched = now;
        await saveFetchedToFirebase(cat.id, articles);
      }));

      const total = Object.values(fetchedMap).reduce((s, a) => s + a.length, 0);
      showToast(total ? `전체 ${total}개 기사를 가져왔습니다` : '새 기사가 없습니다', total ? 'ok' : 'warn');
      renderAll();
    } catch (err) {
      console.error(err);
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>조회 실패: ${esc(err.message)}</p></div>`;
      showToast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 조회';
    }
    return;
  }

  // 단일 분야 조회
  const cat = state.categories.find(c => c.id === currentCatId);
  if (!cat) { btn.disabled = false; return; }

  btn.textContent = '조회 중...';
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div>뉴스를 가져오는 중...</div>`;

  try {
    let articles = await fetchNewsForCategory(cat);
    articles = await summarizeWithAI(articles);
    fetchedMap[currentCatId] = articles;

    const idx = state.categories.findIndex(c => c.id === currentCatId);
    if (idx !== -1) state.categories[idx].lastFetched = new Date().toISOString();
    await saveFetchedToFirebase(currentCatId, articles);

    showToast(articles.length ? `${articles.length}개 기사를 가져왔습니다` : '해당 기간에 새 기사가 없습니다', articles.length ? 'ok' : 'warn');
    renderAll();
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>조회 실패: ${esc(err.message)}</p></div>`;
    showToast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 조회';
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
  document.getElementById('input-api-key').value = state.settings.claudeApiKey || '';
  openModal('modal-settings');
  setTimeout(() => document.getElementById('input-api-key').focus(), 80);
}

function saveSettings() {
  state.settings.claudeApiKey = document.getElementById('input-api-key').value.trim();
  saveStateToStorage(state);
  closeModal('modal-settings');
  showToast('설정이 저장되었습니다', 'ok');
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
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `API 오류 (${resp.status})`);
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
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

  // 분야 추가
  document.getElementById('btn-add-category').onclick = openAddCategory;
  document.getElementById('btn-save-category').onclick = saveCategory;
  document.getElementById('input-category-name').onkeydown = e => {
    if (e.key === 'Enter') saveCategory();
  };

  // 추천 태그
  document.querySelectorAll('.tag-btn').forEach(btn => {
    btn.onclick = () => {
      document.getElementById('input-category-name').value = btn.dataset.tag;
      document.getElementById('input-category-name').focus();
    };
  });

  // 뉴스 조회
  document.getElementById('btn-fetch').onclick = doFetch;

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
  if (!apiKey || !articles.length) return articles;

  const items = articles.map((a, i) =>
    `[${i}] 제목: ${a.title}\n내용: ${a.summary || ''}`
  ).join('\n---\n');

  const prompt = `다음 뉴스 기사들을 각각 200자 이내의 한국어로 핵심 내용만 요약하세요.
반드시 아래 JSON 배열 형식으로만 응답하세요 (다른 텍스트 없이):
[{"i":0,"s":"요약"},{"i":1,"s":"요약"},...]

${items}`;

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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!resp.ok) return articles;
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return articles;
    const summaries = JSON.parse(match[0]);
    return articles.map((a, i) => {
      const found = summaries.find(s => s.i === i);
      return found ? { ...a, summary: found.s } : a;
    });
  } catch {
    return articles;
  }
}

async function saveFetchedToFirebase(catId, articles) {
  const obj = {};
  articles.forEach(a => { obj[a.id] = a; });
  await db.ref('fetchedArticles/' + catId).set(obj).catch(() => {});
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
    state.categories = Object.values(catsData);

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

// ─── 초기화 ───────────────────────────────────────

function init() {
  bindEvents();
  renderAll();
  loadFromFirebase();
}

document.addEventListener('DOMContentLoaded', init);
