# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**자프뉴스 (ZAF News)** — A Korean economic news aggregator and AI analysis tool. Single-page application with no build step.

## Running the App

Open `index.html` directly in a browser, or serve via HTTP to avoid CORS issues:

```bash
python -m http.server 8000
# Then open http://localhost:8000
```

No build, no install, no compilation. All dependencies load from CDN.

## Architecture

Four files only: `index.html`, `app.js`, `style.css`, `favicon.svg`.

All logic is in `app.js` (~63 KB). It is organized into clearly labeled sections separated by `───` dividers.

### Data Layer

- **Firebase Realtime Database** (`zaf-news-default-rtdb.firebaseio.com`): persists `categories/`, `savedArticles/`, `fetchedArticles/`, and memo content. Config is hardcoded at the top of `app.js` (lines 9–18).
- **localStorage**: stores the Claude API key and user settings only.
- **In-memory state**: `state` object (categories, savedArticles, settings) and `fetchedMap` (categoryId → articles[]).

### News Fetching Pipeline

1. Each category holds a `keywords` array.
2. For each keyword, three Google News RSS queries run in parallel — one per source (매일경제 `mk.co.kr`, 한국경제 `hankyung.com`, 네이버뉴스 `n.news.naver.com`).
3. RSS is fetched through a 3-proxy fallback chain: `rss2json.com` → `allorigins.win` → `corsproxy.io`.
4. Results are merged and deduplicated by URL, sorted newest-first, capped at 10 per category.
5. Optionally, article titles are sent to Claude Haiku for 50-character summaries (JSON array response).

### AI Features

Both AI features call the Claude API directly from the browser using the key stored in localStorage:

- **Auto-summarize** (`app.js` ~line 1360): batch-summarizes fetched article titles; model `claude-haiku-4-5-20251001`.
- **Trend analysis** (`app.js` ~line 1173): sends up to 30 saved articles for markdown trend analysis; same model. The response markdown is converted to HTML for display.

### UI Structure

Three-column layout (sidebar / fetched news / saved articles):
- **Sidebar**: category list with drag-and-drop reordering (native HTML5), add/edit/delete category, keywords as tags.
- **Main content**: fetched articles per category + saved articles with date/category filters and a calendar popup.
- **Memos**: `contenteditable` rich text per article; auto-saves to Firebase with 1.2 s debounce; floating format toolbar on selection.

## Key Conventions

- **XSS protection**: all user-supplied and external content must pass through the `escapeHtml()` utility before being inserted into the DOM via `innerHTML`.
- **Duplicate prevention**: always URL-based (`article.link`), both for fetched dedup and before saving to Firebase.
- **Error handling in fetch**: the proxy fallback chain is intentional; do not simplify to a single proxy without testing all three Korean news sources.
- **Model string**: AI calls use the literal string `claude-haiku-4-5-20251001` — update here when upgrading models.
- **Firebase paths**: `categories/`, `savedArticles/`, `fetchedArticles/` are the canonical root keys; don't rename without migrating existing data.
