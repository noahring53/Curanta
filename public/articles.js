/* ════════════════════════════════════════════════════════════════════════════
   Curanta — Articles
   ────────────────────────────────────────────────────────────────────────────
   Another mode of the Newsletter builder, not another application. The shell,
   the sidebar, the section frames, the story blocks, the buttons and the
   skeletons are all the builder's own components (see renderBuilder in app.js
   and the BUILDER block in styles.css) — this file supplies the article
   workflow that runs inside them.

   Layout mirrors the builder exactly:
     builder-shell → builder-topbar → builder-body → source-sidebar + editor-main

   Deliberately reused rather than reimplemented:
     .source-sidebar / .source-add-form / .sources-list / .source-manager
     .source-pill / .article-card / .source-divider / .source-empty
     .editor-main / .newsletter-meta / .meta-input
     .editor-section / .section-header / .section-label / .section-prompt-wrap
     .section-content / .drop-placeholder / .story-block / .story-skeleton
     .panel-tabs (as the RSS|URL segmented control) / .feed-health-item (as the
     CMS-style table row) / .nl-action-btn / .btn* / .badge* / .trial-banner
   plus app.js's own submitAddSource, quickAddFeed, removeFeed, autoFetchSources,
   escHtml, timeAgo, toast, showConfirm, writeRichClipboard and readSSEStream.

   Cost discipline lives on the server (lib/articles.mjs). The one rule this
   file must honour: never send the master prompt over the wire — it is configured
   once in Settings → AI Settings and the server reads it per generation. This
   page sends only the angle (plus an optional one-off override).
════════════════════════════════════════════════════════════════════════════ */

const art = {
  sourceMode: 'rss',       // 'rss' | 'url'
  search: '',              // sidebar headline filter
  urlInput: '',
  extractingUrl: '',       // url currently being fetched — drives the row spinner
  // Ordered list of sources the writer has dragged/added into the Article
  // Sources workspace. The ORDER is the writer's chosen priority and is sent to
  // generation as-is. Independent of state.sources so an RSS refresh never wipes
  // a selection. Each: { id, title, publication, url, imageUrl, timeAgo, publishedAt, fromRss, wordCount? }
  sources: [],
  _dragSrcId: null,        // staged-source id currently being reordered
  angle: '',
  notes: '',
  // The master prompt lives in Settings → AI Settings and is applied by the
  // server automatically. promptOverride is the optional Advanced-Options escape
  // hatch: non-empty replaces the master prompt for this one generation only.
  promptOverride: '',
  advancedOpen: false,
  generating: false,
  genStatus: '',
  draft: null,             // { id, title, bodyHtml, status, sourceUrl, … }
  drafts: [],
  recentUrls: [],          // last few pasted URLs — re-picking one is a cache hit
  loaded: false,
  dbReady: null,           // null = unknown, true = tables exist, false = localStorage
  saving: false,
  _saveTimer: null,
  _paintQueued: false,
};

// ── Storage keys (localStorage fallback when the tables aren't migrated yet) ──
const artDraftsKey  = () => `lwai_article_drafts_${state.currentPublicationId || 'default'}`;
const artRecentKey  = () => `lwai_article_recent_${state.currentPublicationId || 'default'}`;

function artReadLocal(key, fallback = []) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function artWriteLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota */ }
}

const artHasDB = () => Boolean(sb && state.user && art.dbReady !== false);

// One probe decides which storage backend the drafts use. A missing table means
// the migration hasn't been run — drafts still work, locally, and the page says
// so once, rather than erroring on every keystroke. (The master prompt itself
// rides user_settings.default_prompts, which always exists once you're signed in.)
async function artDetectDB() {
  if (art.dbReady !== null) return art.dbReady;
  if (!sb || !state.user) { art.dbReady = false; return false; }
  const { error } = await sb.from('articles').select('id').limit(1);
  art.dbReady = !error;
  if (error) console.warn('[articles] falling back to local storage:', error.message);
  return art.dbReady;
}

// ── DRAFTS (data) ─────────────────────────────────────────────────────────────
async function artLoadDrafts() {
  if (await artDetectDB()) {
    const pubId = state.currentPublicationId || null;
    let q = sb.from('articles').select('*').eq('user_id', state.user.id)
      .order('updated_at', { ascending: false }).limit(50);
    q = pubId ? q.eq('publication_id', pubId) : q.is('publication_id', null);
    const { data, error } = await q;
    if (!error) return (data || []).map(artRowToDraft);
    console.error('[articles] draft load error:', error.message);
  }
  return artReadLocal(artDraftsKey());
}

function artRowToDraft(r) {
  return {
    id: r.id, title: r.title, bodyHtml: r.body_html || '', status: r.status || 'draft',
    angle: r.angle || '', notes: r.notes || '', mode: r.mode || 'news',
    sourceUrl: r.source_url || '', sourceTitle: r.source_title || '',
    sourcePublication: r.source_publication || '', promptId: r.prompt_id || '',
    // How the draft was created — 'auto' marks an Auto-Draft, shown with a badge.
    generationSource: r.generation_source || 'manual',
    createdAt: r.created_at, updatedAt: r.updated_at || r.created_at,
  };
}

// Open a specific draft by id (used by the Inbox "Open article" link). Loads the
// drafts list from the DB if the page hasn't yet, then routes through the normal
// open-draft flow so the workspace/editor are restored identically.
async function artOpenDraftById(id) {
  if (!art.drafts.length || !art.drafts.some(d => d.id === id)) {
    art.loaded = true;
    art.drafts = await artLoadDrafts();
  }
  if (!art.drafts.some(d => d.id === id)) return false;
  await articlesHandleAction('art-open-draft', { id });
  return true;
}
window.artOpenDraftById = artOpenDraftById;

async function artPersistDraft(draft) {
  draft.updatedAt = new Date().toISOString();
  if (!draft.createdAt) draft.createdAt = draft.updatedAt;
  if (await artDetectDB()) {
    const row = {
      user_id: state.user.id,
      title: draft.title, body_html: draft.bodyHtml, status: draft.status || 'draft',
      angle: draft.angle, notes: draft.notes, mode: draft.mode || 'news',
      source_url: draft.sourceUrl, source_title: draft.sourceTitle,
      source_publication: draft.sourcePublication,
      // Local prompt IDs are not UUIDs and would be rejected by the FK.
      prompt_id: /^[0-9a-f-]{36}$/i.test(draft.promptId || '') ? draft.promptId : null,
      publication_id: state.currentPublicationId || null,
    };
    if (draft.id && !String(draft.id).startsWith('local_')) {
      const { error } = await sb.from('articles').update(row).eq('id', draft.id).eq('user_id', state.user.id);
      if (error) { console.error('[articles] save error:', error.message); return false; }
      return true;
    }
    const { data, error } = await sb.from('articles').insert(row).select('id').single();
    if (error) { console.error('[articles] save error:', error.message); return false; }
    draft.id = data.id;
    return true;
  }
  const list = artReadLocal(artDraftsKey());
  if (!draft.id) draft.id = 'local_' + uid();
  const i = list.findIndex(d => d.id === draft.id);
  if (i >= 0) list[i] = draft; else list.unshift(draft);
  artWriteLocal(artDraftsKey(), list.slice(0, 50));
  return true;
}

async function artDeleteDraftRow(id) {
  if (await artDetectDB() && !String(id).startsWith('local_')) {
    const { error } = await sb.from('articles').delete().eq('id', id).eq('user_id', state.user.id);
    if (error) toast('Could not delete: ' + error.message, 'error');
    return;
  }
  artWriteLocal(artDraftsKey(), artReadLocal(artDraftsKey()).filter(d => d.id !== id));
}

// ── MARKDOWN → EDITOR HTML ────────────────────────────────────────────────────
// The model writes markdown; the editor edits HTML. Escaped first, so model
// output can never inject markup into the page.
function artMdToHtml(md = '') {
  const inline = (s) => escHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const out = [];
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); const lvl = Math.max(2, h[1].length); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }

    if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }

    const ul = line.match(/^[-*•]\s+(.*)$/);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }

    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }

    if (/^(-{3,}|\*{3,})$/.test(line)) { closeList(); out.push('<hr>'); continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

// The first "# " line is the headline — it belongs in the headline field, not in
// the body, or the writer ends up with two headlines to keep in sync.
function artSplitHeadline(md = '') {
  const lines = md.replace(/\r/g, '').split('\n');
  const idx = lines.findIndex(l => l.trim());
  if (idx >= 0) {
    const m = lines[idx].trim().match(/^#\s+(.*)$/);
    if (m) return { title: m[1].trim(), body: lines.slice(idx + 1).join('\n').trim() };
  }
  return { title: '', body: md.trim() };
}

function artWordCount(html = '') {
  const el = document.createElement('div');
  el.innerHTML = html;
  return (el.textContent || '').split(/\s+/).filter(Boolean).length;
}

function artHost(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ── PAGE ──────────────────────────────────────────────────────────────────────
// Called by app.js's router before rendering the Articles view.
async function articlesOnNavigate() {
  if (!art.loaded) {
    art.loaded = true;
    art.recentUrls = artReadLocal(artRecentKey());
    art.drafts = await artLoadDrafts();
  }
  // Feeds are shared with the builder — loaded the same way it loads them.
  if (sb && state.user && !state.sources.length) state.sources = await loadSourcesFromDB();
  autoFetchSources();
}

function renderArticlesPage() {
  const wordCount = art.draft ? artWordCount(art.draft.bodyHtml) : 0;
  return `
<div class="builder-shell">
  <header class="builder-topbar">
    <div class="builder-topbar-left">
      <button class="btn btn-ghost btn-sm" data-action="navigate" data-view="dashboard">← Back</button>
      <span class="section-label" style="min-width:0">Articles</span>
      ${art.draft?.generationSource === 'auto' ? '<span class="badge badge-accent" title="This draft was generated automatically by Auto-Draft">✦ Auto-Drafted</span>' : ''}
      ${art.draft ? `<span class="save-pill" id="art-save-state">${art.saving ? 'Saving…' : 'Auto-saved'}</span>` : ''}
      ${art.draft ? `<span class="text-xs text-dim">${wordCount} words</span>` : ''}
    </div>
    <div class="builder-topbar-center">
      ${canUsePubs() ? `<div class="nav-pub-chip" data-action="navigate" data-view="publications" title="Switch publication">📰 ${escHtml(currentPublicationName())}</div>` : ''}
      ${!state.hasAI ? `<div class="mock-badge" title="No ANTHROPIC_API_KEY is configured, so Generate returns a placeholder">✦ Mock AI</div>` : `<div class="badge badge-green"><span class="dot dot-green"></span> AI Connected</div>`}
    </div>
    <div class="builder-topbar-right">
      <button class="btn btn-ghost btn-sm" data-action="art-new" title="Clear the workspace and start a new article">＋ New</button>
      <button class="btn btn-ghost btn-sm" data-action="art-open-drafts">🗂 Drafts${art.drafts.length ? ` (${art.drafts.length})` : ''}</button>
      <button class="btn btn-outline btn-sm" data-action="art-export" ${art.draft ? '' : 'disabled'}>↓ HTML</button>
      <button class="btn btn-outline btn-sm" data-action="art-to-newsletter" ${art.draft ? '' : 'disabled'} title="Add this article to a newsletter as an editable block">→ Newsletter</button>
      <button class="btn btn-primary btn-sm" data-action="art-copy" ${art.draft ? '' : 'disabled'} title="Copy with formatting and links intact">⎘ Copy article</button>
    </div>
  </header>

  <div class="builder-body">
    <aside class="source-sidebar source-sidebar-wide" id="source-sidebar">
      <div class="source-sidebar-header">
        <span class="source-sidebar-title">Source</span>
        <span class="text-xs text-dim">${state.sources.reduce((a, s) => a + s.articles.length, 0)} articles</span>
      </div>
      <div class="panel-tabs">
        <button class="panel-tab ${art.sourceMode === 'rss' ? 'active' : ''}" data-action="art-source-mode" data-mode="rss">RSS</button>
        <button class="panel-tab ${art.sourceMode === 'url' ? 'active' : ''}" data-action="art-source-mode" data-mode="url">URL</button>
      </div>
      ${art.sourceMode === 'rss' ? `
      <form id="source-form" class="source-add-form">
        <input class="input input-sm" name="url" id="source-url-input" placeholder="Add RSS, YouTube, or subreddit" autocomplete="off">
        <button type="submit" class="btn btn-sm btn-primary" id="source-add-btn">Add</button>
      </form>
      <div class="source-add-form">
        <input class="input input-sm" id="art-search" value="${escHtml(art.search)}" placeholder="🔍 Filter headlines…" autocomplete="off">
      </div>` : `
      <form id="art-url-form" class="source-add-form">
        <input class="input input-sm" id="art-url-input" type="url" value="${escHtml(art.urlInput)}" placeholder="Paste any article URL…" autocomplete="off">
        <button type="submit" class="btn btn-sm btn-primary" ${art.extractingUrl ? 'disabled' : ''}>${art.extractingUrl ? '…' : '+ Add'}</button>
      </form>`}
      <div class="sources-list" id="sources-list">
        ${renderArticleSourceList()}
      </div>
    </aside>

    <main class="editor-main" id="editor-main">
      ${art.dbReady === false && sb && state.user ? `
      <div class="trial-banner" style="border-color:var(--border-md);background:var(--bg-2);color:var(--text-2)">
        <span>Saving to this browser only — run the <code>articles</code> migration in <code>supabase-schema.sql</code> to sync across devices.</span>
      </div>` : ''}

      <div class="newsletter-meta">
        <input id="art-headline" class="meta-input meta-subject" value="${escHtml(art.draft?.title || '')}"
          placeholder="Headline — generated, then yours to sharpen…" ${art.draft ? '' : 'disabled'}>
        <div class="meta-preview" style="display:flex;align-items:center;gap:8px;min-height:22px">${renderArticleSourceSummary()}</div>
      </div>

      ${renderArticleSourcesSection()}
      ${renderArticleDirectionSection()}
      ${renderArticleDraftSection()}
    </main>
  </div>
</div>`;
}

// One-line summary under the headline: how many sources feed this draft.
function renderArticleSourceSummary() {
  const n = art.sources.length;
  if (!n) return `<span class="text-dim">No sources yet — drag stories in from the left, or paste a URL.</span>`;
  const lead = art.sources[0];
  return `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
    <strong style="color:var(--text-1);font-weight:600">${n} source${n === 1 ? '' : 's'}</strong>
    — leads with “${escHtml((lead.title || '').slice(0, 60))}”${n > 1 ? ` +${n - 1} more` : ''}
  </span>`;
}

// ── ARTICLE SOURCES WORKSPACE ──────────────────────────────────────────────────
// A builder section whose drop zone is the "Article Sources" workspace. RSS
// cards drag in from the sidebar; staged rows reorder among themselves and can
// be removed; a URL can be pasted straight in. Reuses the builder's
// .editor-section / .section-drop-zone / .drop-placeholder / .drag-over CSS.
function renderArticleSourcesSection() {
  const n = art.sources.length;
  return `
<div class="editor-section">
  <div class="section-header">
    <span class="section-label">Article Sources</span>
    <div class="section-prompt-wrap">
      <span class="text-xs text-dim" style="flex:1">${n ? `${n} selected · drag to reorder` : 'Drag stories here, or paste a URL'}</span>
      ${n ? `<button class="btn btn-sm btn-ghost btn-icon-sm" data-action="art-clear-sources" title="Remove all sources">Clear</button>` : ''}
    </div>
  </div>
  <div class="section-drop-zone" id="art-sources-zone">
    <div class="section-content" id="art-sources-content">
      ${renderArticleSourcesBody()}
    </div>
    <div style="display:flex;gap:6px;padding:8px 12px;border-top:1px dashed var(--border)">
      <input id="art-url-add" class="input input-sm" type="url" style="flex:1;font-size:11.5px"
        placeholder="Or paste an article URL to add it…" autocomplete="off"
        onkeydown="if(event.key==='Enter'){event.preventDefault();articlesHandleAction('art-add-url',{})}">
      <button class="btn btn-sm btn-outline" data-action="art-add-url" ${art.extractingUrl ? 'disabled' : ''} style="flex-shrink:0">
        ${art.extractingUrl ? '…' : '+ Add'}
      </button>
    </div>
  </div>
</div>`;
}

function renderArticleSourcesBody() {
  if (!art.sources.length) {
    return `<div class="drop-placeholder" id="art-drop-placeholder">
      <p style="font-size:13px;color:var(--text-2)">Drag an RSS story here</p>
      <small style="font-size:11.5px">or paste a URL below. Add several — they're combined in this order.</small>
    </div>`;
  }
  return `<div class="art-source-stack">${art.sources.map(renderStagedSource).join('')}</div>`;
}

// A staged source row: drag handle (reorder), thumbnail, title/meta, open, remove.
function renderStagedSource(s, i) {
  const host = artHost(s.url);
  const meta = [s.publication || host, s.timeAgo || (s.publishedAt ? timeAgo(s.publishedAt) : '')].filter(Boolean).map(escHtml).join(' · ');
  return `
<div class="art-source-row" draggable="true" data-src-id="${escHtml(s.id)}"
  ondragstart="artSourceDragStart(event,'${escHtml(s.id)}')" ondragend="artSourceDragEnd(event)" title="${escHtml(s.title || '')}">
  <span class="art-source-handle" title="Drag to reorder">⠿</span>
  <span class="art-source-num">${i + 1}</span>
  ${s.imageUrl ? `<img class="art-source-thumb" src="${escHtml(s.imageUrl)}" alt="" onerror="this.remove()">` : ''}
  <div class="art-source-body">
    <div class="art-source-title">${escHtml(s.title || 'Untitled')}</div>
    <div class="art-source-meta">${meta}</div>
  </div>
  <a class="nl-action-btn" href="${escHtml(s.url)}" target="_blank" rel="noopener" title="Open the original">↗</a>
  <button class="nl-action-btn danger" data-action="art-remove-source" data-id="${escHtml(s.id)}" title="Remove">×</button>
</div>`;
}

// ── SOURCE STATE (add / remove / reorder / dedup) ──────────────────────────────
// Pure-ish operations on the ordered art.sources array. Kept small and explicit
// so ordering and dedup are obvious (and mirrored by the exported test helpers
// in lib/articles.mjs). Every mutation refreshes only the workspace + summary,
// never the whole page, so the caret in the angle box is never lost.
function artSourceExists(url, id) {
  return art.sources.some(s => (id && s.id === id) || (url && s.url === url));
}

// Matches the server's fan-out cap (orderedUniqueUrls) so the count shown on the
// button can never promise more sources than generation will actually use.
const ART_MAX_SOURCES = 8;

function artAddSource(src) {
  const url = (src.url || '').trim();
  if (!url) { toast('That source has no URL', 'warn'); return false; }
  if (artSourceExists(url, src.id)) { toast('Already in your sources', 'warn'); return false; }
  if (art.sources.length >= ART_MAX_SOURCES) { toast(`Up to ${ART_MAX_SOURCES} sources per article`, 'warn'); return false; }
  art.sources.push({
    id: src.id || 'src_' + uid(),
    title: src.title || url,
    publication: src.source || src.publication || artHost(url),
    url,
    imageUrl: src.imageUrl || '',
    timeAgo: src.timeAgo || (src.publishedAt ? timeAgo(src.publishedAt) : ''),
    publishedAt: src.publishedAt || '',
    fromRss: !!src.rss,
  });
  refreshArticleWorkspace();
  refreshArticleSidebar();   // reflect the ✓ added state on the card
  artSyncGenerateButton();
  return true;
}

function artRemoveSource(id) {
  art.sources = art.sources.filter(s => s.id !== id);
  refreshArticleWorkspace();
  refreshArticleSidebar();
  artSyncGenerateButton();
}

// Move the dragged source so it lands before `beforeId` (or to the end when
// beforeId is null). Order is the whole point, so this is index arithmetic, not
// a visual trick.
function artMoveSource(dragId, beforeId) {
  const from = art.sources.findIndex(s => s.id === dragId);
  if (from === -1) return;
  const [moved] = art.sources.splice(from, 1);
  let to = beforeId == null ? art.sources.length : art.sources.findIndex(s => s.id === beforeId);
  if (to === -1) to = art.sources.length;
  art.sources.splice(to, 0, moved);
  refreshArticleWorkspace();
}

function refreshArticleWorkspace() {
  const body = document.getElementById('art-sources-content');
  if (body) body.innerHTML = renderArticleSourcesBody();
  const summary = document.querySelector('#editor-main .newsletter-meta .meta-preview');
  if (summary) summary.innerHTML = renderArticleSourceSummary();
  setupArticleWorkspace();
}

// ── DRAG-AND-DROP ──────────────────────────────────────────────────────────────
// Two drag sources feed one drop zone:
//   • sidebar RSS/recent cards  → add to the workspace (artCardDragStart)
//   • staged rows               → reorder within the workspace (artSourceDragStart)
// Native HTML5 DnD (same mechanism the newsletter builder uses) gives us
// mouse+touch/pointer support and clean click-vs-drag separation for free.
function artCardDragStart(e, el) {
  art._dragCard = el.dataset.src || '';
  art._dragSrcId = null;
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', 'card');
  setTimeout(() => el.classList.add('dragging'), 0);
}
function artCardDragEnd(e) { e.currentTarget.classList.remove('dragging'); art._dragCard = null; }
window.artCardDragStart = artCardDragStart;
window.artCardDragEnd = artCardDragEnd;

function artSourceDragStart(e, id) {
  art._dragSrcId = id;
  art._dragCard = null;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'row');
  setTimeout(() => e.target.classList.add('dragging'), 0);
}
function artSourceDragEnd(e) { e.target.classList.remove('dragging'); art._dragSrcId = null; }
window.artSourceDragStart = artSourceDragStart;
window.artSourceDragEnd = artSourceDragEnd;

// Wires the workspace drop zone. Idempotent: a data flag prevents double-binding
// across the partial refreshes, so one drop never fires twice.
function setupArticleWorkspace() {
  const zone = document.getElementById('art-sources-zone');
  if (!zone || zone.dataset.dndBound) return;
  zone.dataset.dndBound = '1';

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over'); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');

    // Reorder an existing staged row: drop position = the row we're hovering.
    if (art._dragSrcId) {
      const rows = [...zone.querySelectorAll('.art-source-row')].filter(r => r.dataset.srcId !== art._dragSrcId);
      let beforeId = null;
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) { beforeId = r.dataset.srcId; break; }
      }
      artMoveSource(art._dragSrcId, beforeId);
      art._dragSrcId = null;
      return;
    }
    // Add a card dragged in from the sidebar.
    if (art._dragCard) {
      try { artAddSource(JSON.parse(art._dragCard)); } catch { /* malformed payload */ }
      art._dragCard = null;
    }
  });
}

// ── SIDEBAR LIST ──────────────────────────────────────────────────────────────
// Rendered into #sources-list, the same node the builder's sidebar uses, so
// app.js's refreshSourceSidebar() keeps working for both views.
function renderArticleSourceList() {
  if (art.sourceMode === 'url') return renderArticleUrlList();

  if (!state.sources.length) {
    return `<div class="source-empty">
      <div class="source-empty-icon">📡</div>
      <strong style="color:var(--text-2);font-size:13px">No sources yet</strong>
      <p style="margin-top:6px">Add a feed above, or switch to URL to paste a single article.</p>
      <div style="margin-top:14px;display:flex;flex-direction:column;gap:6px">
        <button class="btn btn-sm btn-outline" onclick="quickAddFeed('https://feeds.npr.org/1001/rss.xml')">Try NPR</button>
        <button class="btn btn-sm btn-outline" onclick="quickAddFeed('https://feeds.bbci.co.uk/news/rss.xml')">Try BBC News</button>
        <button class="btn btn-sm btn-outline" onclick="quickAddFeed('https://techcrunch.com/feed/')">Try TechCrunch</button>
      </div>
    </div>`;
  }

  const q = art.search.trim().toLowerCase();
  const all = state.sources
    .flatMap(feed => feed.articles.map(a => ({ ...a, feedId: feed.id, _icon: sourceIcon(feed) })))
    .filter(a => !q || (a.title || '').toLowerCase().includes(q) || (a.source || '').toLowerCase().includes(q))
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const fetching = state.sources.filter(s => s.articles.length === 0).length;

  return `
<div class="source-manager">
  ${state.sources.map(feed => `
  <div class="source-pill">
    <span style="flex-shrink:0;font-size:11px">${sourceIcon(feed)}</span>
    <span class="source-pill-name">${escHtml(feed.title)}</span>
    <span class="source-pill-count">${feed.articles.length}</span>
    <button class="feed-remove-btn" data-action="remove-feed" data-feed-id="${feed.id}" title="Remove">×</button>
  </div>`).join('')}
  ${fetching ? `<div style="font-size:11px;color:var(--text-3);padding:4px 2px">Fetching ${fetching} source${fetching > 1 ? 's' : ''}…</div>` : ''}
</div>
<div class="source-divider"></div>
${!all.length
  ? `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12px">${q ? 'No headlines match that filter.' : 'Fetching articles…'}</div>`
  : `<div class="art-list">${all.map(a => renderArticleRow(a, { rss: true })).join('')}</div>`}`;
}

function renderArticleUrlList() {
  const recents = art.recentUrls;
  return `
${recents.length ? `
  <div class="source-manager" style="padding-bottom:0">
    <div class="source-sidebar-title" style="padding:2px">Recently added</div>
  </div>
  <div class="art-list">${recents.map(r => renderArticleRow({
    url: r.url, title: r.title, source: r.publication, timeAgo: timeAgo(r.at),
  }, { rss: false })).join('')}</div>`
: `<div class="source-empty">
    <div class="source-empty-icon">🔗</div>
    <strong style="color:var(--text-2);font-size:13px">Paste an article URL</strong>
    <p style="margin-top:6px">Type a URL in the Article Sources box on the right, or paste one below to add it. Combine as many as you like.</p>
  </div>`}`;
}

// One candidate article. The SAME .article-card the builder's sidebar uses, now
// draggable into the Article Sources workspace (reusing the builder's dragStart/
// dragEnd via a source-specific payload). Click also adds it — a plain click
// never starts a drag (native HTML5 DnD needs movement), so the two never
// collide. Cards already in the workspace show a check and dim.
function renderArticleRow(a, { rss } = {}) {
  const inWorkspace = art.sources.some(s => (a.id && s.id === a.id) || (a.url && s.url === a.url));
  const busy = art.extractingUrl === a.url;
  const host = artHost(a.url);
  const payload = escHtml(JSON.stringify({ id: a.id || '', url: a.url || '', title: a.title || '', source: a.source || '', imageUrl: a.imageUrl || '', timeAgo: a.timeAgo || '', publishedAt: a.publishedAt || '', rss: !!rss }));
  return `
<div class="article-card ${inWorkspace ? 'in-section' : ''}" data-action="art-add" data-src="${payload}"
  draggable="true" ondragstart="artCardDragStart(event, this)" ondragend="artCardDragEnd(event)"
  style="cursor:grab" title="${escHtml(a.title || '')}">
  <div class="article-card-title">${escHtml(a.title || 'Untitled')}</div>
  <div class="article-card-meta">
    <span class="article-card-source" style="display:flex;align-items:center;gap:5px;min-width:0">
      ${host ? `<img class="art-favicon" src="https://${escHtml(host)}/favicon.ico" alt="" onerror="this.remove()">` : ''}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.source || host || '')}</span>
    </span>
    <span class="article-card-time">${busy ? '<span class="spinner"></span>' : inWorkspace ? '✓ added' : escHtml(a.timeAgo || '')}</span>
  </div>
</div>`;
}

// ── DIRECTION ─────────────────────────────────────────────────────────────────
// A builder section, header and all: Generate lives in the header (exactly where
// every builder section keeps its Generate button), leaving the body for the one
// field that matters — the angle. The master prompt is set once in Settings and
// applied by the server automatically; it is deliberately absent from this page.
function renderArticleDirectionSection() {
  const ready = art.sources.length > 0 && art.angle.trim().length > 0 && !art.generating;
  const overriding = art.promptOverride.trim().length > 0;
  return `
<div class="editor-section">
  <div class="section-header">
    <span class="section-label">Direction</span>
    <div class="section-prompt-wrap">
      <span style="flex:1"></span>
      <button class="btn btn-sm btn-primary" data-action="art-generate" ${ready ? '' : 'disabled'}
        title="${!art.sources.length ? 'Add at least one source first' : !art.angle.trim() ? 'An angle is required' : 'Draft the article'}">
        ${art.generating ? '<span class="spinner"></span> Generating' : `✦ Generate Article${art.sources.length > 1 ? ` (${art.sources.length})` : ''}`}
      </button>
    </div>
  </div>
  <div class="section-content">
    <div>
      <label class="design-label" for="art-angle">Article angle <span>required</span></label>
      <textarea id="art-angle" class="input" rows="3" style="margin-top:5px"
        placeholder="What this ruling means for small landlords — lead with the compliance deadline.">${escHtml(art.angle)}</textarea>
    </div>
    <div>
      <label class="design-label" for="art-notes">Notes <span>optional</span></label>
      <textarea id="art-notes" class="input input-sm" rows="2" style="margin-top:5px;min-height:0"
        placeholder="Length, who to quote, what to leave out.">${escHtml(art.notes)}</textarea>
    </div>

    <!-- Advanced: everyday flow never opens this. The master prompt from Settings
         is used unless an override is typed here, for this one generation only. -->
    <div style="border-top:1px solid var(--border);padding-top:10px">
      <button class="btn btn-ghost btn-sm btn-icon-sm" data-action="art-toggle-advanced"
        style="padding-left:0;color:var(--text-3);font-size:11.5px">
        ${art.advancedOpen ? '▾' : '▸'} Advanced options${overriding && !art.advancedOpen ? ' <span class="badge badge-accent" style="margin-left:4px">override on</span>' : ''}
      </button>
      ${art.advancedOpen ? `
      <div style="margin-top:8px">
        <label class="design-label" for="art-override">Prompt override <span>optional</span></label>
        <textarea id="art-override" class="input input-sm" rows="5" style="margin-top:5px;font-size:12px;line-height:1.6"
          placeholder="Leave blank to use your Master Article Prompt from Settings. Type here to replace it for this one article only.">${escHtml(art.promptOverride)}</textarea>
        <div class="text-xs text-dim" style="margin-top:5px;display:flex;align-items:center;gap:6px">
          ${overriding
            ? '⚠️ Overriding your master prompt for this generation.'
            : 'Using your <strong>Master Article Prompt</strong> from Settings → AI Settings.'}
          <span style="flex:1"></span>
          <button class="nl-action-btn" data-action="art-edit-master" title="Edit the master prompt in Settings">Edit master →</button>
        </div>
      </div>` : ''}
    </div>
  </div>
</div>`;
}

// ── DRAFT ─────────────────────────────────────────────────────────────────────
const ART_TOOLS = [
  ['bold', 'B', 'Bold', 'font-weight:800'],
  ['italic', 'I', 'Italic', 'font-style:italic'],
  ['formatBlock:h2', 'H2', 'Subhead'],
  ['formatBlock:h3', 'H3', 'Sub-subhead'],
  ['formatBlock:p', '¶', 'Paragraph'],
  ['formatBlock:blockquote', '❝', 'Pull quote'],
  ['insertUnorderedList', '•', 'Bulleted list'],
  ['insertOrderedList', '1.', 'Numbered list'],
  ['createLink', '🔗', 'Link'],
];

function renderArticleDraftSection() {
  const d = art.draft;
  return `
<div class="editor-section">
  <div class="section-header">
    <span class="section-label">Draft</span>
    <div class="section-prompt-wrap">
      ${d ? ART_TOOLS.map(([cmd, label, title, style]) => `
        <button class="btn btn-sm btn-ghost btn-icon-sm" data-action="art-exec" data-cmd="${cmd}" title="${title}" style="${style || ''}">${label}</button>`).join('')
      : ''}
      <span style="flex:1"></span>
      ${d ? `
      <select class="input input-sm section-type-picker" id="art-status" style="max-width:110px" title="Draft status">
        ${['draft', 'review', 'published'].map(s => `<option value="${s}" ${(d.status || 'draft') === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
      </select>
      <button class="btn btn-sm btn-ghost btn-icon-sm" data-action="art-regenerate" title="Regenerate from the same source and angle" ${art.generating ? 'disabled' : ''}>⟲</button>` : ''}
    </div>
  </div>
  <div class="section-drop-zone">
    <div class="section-content" id="art-draft-content">
      ${renderArticleDraftBody()}
    </div>
  </div>
</div>`;
}

function renderArticleDraftBody() {
  if (art.generating && !art.draft) {
    return `
    <div class="story-block loading">
      <div class="story-block-header">
        <span class="story-source">Drafting</span>
        <span style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--accent)">
          <div class="spinner"></div> <span class="gen-status">${escHtml(art.genStatus || 'Reading the source…')}</span>
        </span>
      </div>
      <div class="story-skeleton">
        <div class="skeleton-line h-10 w-full"></div><div class="skeleton-line h-10 w-80"></div>
        <div class="skeleton-line h-8 w-full"></div><div class="skeleton-line h-8 w-65"></div>
        <div class="skeleton-line h-8 w-80"></div><div class="skeleton-line h-8 w-45"></div>
      </div>
    </div>`;
  }

  if (!art.draft) {
    return `
    <div class="drop-placeholder">
      <p style="font-size:13px;color:var(--text-2)">Add sources, write the angle, hit <strong>✦ Generate Article</strong>.</p>
      <small style="font-size:11.5px">The draft opens here, editable, and saves as you type.</small>
    </div>`;
  }

  return `
  <div class="story-block">
    <div class="story-block-header">
      <span class="story-source">${escHtml(art.draft.sourcePublication || 'Article')}</span>
      ${art.generating ? `<span style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--accent)"><div class="spinner"></div> <span class="gen-status">${escHtml(art.genStatus || 'Writing…')}</span></span>`
        : `<span style="margin-left:auto;font-size:10px;color:var(--text-3)" id="art-wordcount">${artWordCount(art.draft.bodyHtml)} words</span>`}
    </div>
    <div class="article-editor" id="art-editor" contenteditable="${art.generating ? 'false' : 'true'}" spellcheck="true"
      data-placeholder="Start writing…">${art.draft.bodyHtml}</div>
  </div>`;
}

// Repaint just the draft body — a full render() would restart the skeleton
// animation and drop the caret out of the editor.
function refreshArticleDraft() {
  const el = document.getElementById('art-draft-content');
  if (!el) { render(); return; }
  el.innerHTML = renderArticleDraftBody();
  artBindEditor();
}

function refreshArticleSidebar() {
  const el = document.getElementById('sources-list');
  if (el) el.innerHTML = renderArticleSourceList();
}

// ── EDITOR ────────────────────────────────────────────────────────────────────
// contenteditable listeners can't be delegated the way clicks are, so they are
// (re)bound whenever the editor is put on screen.
function artBindEditor() {
  const ed = document.getElementById('art-editor');
  if (!ed || ed.dataset.bound) return;
  ed.dataset.bound = '1';

  ed.addEventListener('input', () => {
    if (!art.draft) return;
    art.draft.bodyHtml = ed.innerHTML;
    const wc = document.getElementById('art-wordcount');
    if (wc) wc.textContent = `${artWordCount(ed.innerHTML)} words`;
    artScheduleSave();
  });

  // Paste as plain text. Pasted markup drags in another site's fonts, colours
  // and tracking spans — and is the one route by which foreign HTML could reach
  // the document at all.
  ed.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });
}

function artScheduleSave() {
  clearTimeout(art._saveTimer);
  art.saving = true;
  const el = document.getElementById('art-save-state');
  if (el) el.textContent = 'Saving…';
  art._saveTimer = setTimeout(async () => {
    await artPersistDraft(art.draft);
    art.saving = false;
    const s = document.getElementById('art-save-state');
    if (s) s.textContent = 'Auto-saved';
    const i = art.drafts.findIndex(d => d.id === art.draft.id);
    if (i >= 0) art.drafts[i] = { ...art.draft }; else art.drafts.unshift({ ...art.draft });
  }, 1200);
}

function artExec(cmd) {
  const ed = document.getElementById('art-editor');
  if (ed) ed.focus();
  if (cmd.startsWith('formatBlock:')) {
    document.execCommand('formatBlock', false, cmd.split(':')[1]);
  } else if (cmd === 'createLink') {
    const url = window.prompt('Link URL');
    if (url) document.execCommand('createLink', false, url);
  } else {
    document.execCommand(cmd, false, null);
  }
  if (art.draft && ed) { art.draft.bodyHtml = ed.innerHTML; artScheduleSave(); }
}

// ── MODALS: drafts + prompt library ───────────────────────────────────────────
// Both are CMS-style tables built from .feed-health-item rows and .nl-action-btn
// controls — the app's existing compact row vocabulary.
function artModal(title, sub, body, footer = '') {
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal" style="max-width:720px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px">
        <div>
          <div style="font-size:16px;font-weight:700">${title}</div>
          ${sub ? `<div class="text-xs text-dim" style="margin-top:3px">${sub}</div>` : ''}
        </div>
        ${footer}
      </div>
      ${body}
    </div>
  </div>`;
  modal.querySelector('#modal-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
}

function showArticleDraftsModal() {
  const q = (art.draftSearch || '').trim().toLowerCase();
  const rows = art.drafts.filter(d => !q
    || (d.title || '').toLowerCase().includes(q)
    || (d.sourcePublication || '').toLowerCase().includes(q));

  artModal('Drafts', `${art.drafts.length} article${art.drafts.length === 1 ? '' : 's'} in ${escHtml(currentPublicationName())}`, `
    <div class="source-add-form" style="padding:0 0 12px;border:none">
      <input class="input input-sm" id="art-draft-search" value="${escHtml(art.draftSearch || '')}" placeholder="🔍 Search drafts…" autocomplete="off">
    </div>
    <div class="feed-health-list" style="max-height:52vh;overflow-y:auto">
      ${!rows.length ? `<div class="source-empty"><div class="source-empty-icon">📝</div><strong style="color:var(--text-2);font-size:13px">${q ? 'No matches' : 'No drafts yet'}</strong></div>`
      : rows.map(d => `
      <div class="feed-health-item">
        <span class="dot ${d.status === 'published' ? 'dot-green' : d.status === 'review' ? 'dot-amber' : 'dot-dim'}"></span>
        <div style="flex:1;min-width:0">
          <div class="feed-health-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(d.title || 'Untitled Article')}${d.generationSource === 'auto' ? ' <span class="badge badge-accent" style="vertical-align:middle;font-size:10px">✦ Auto</span>' : ''}</div>
          <div class="text-xs text-dim" style="margin-top:2px">
            ${escHtml(d.sourcePublication || 'No source')} · ${artWordCount(d.bodyHtml)} words ·
            created ${escHtml(timeAgo(d.createdAt) || 'just now')} · updated ${escHtml(timeAgo(d.updatedAt) || 'just now')}
          </div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="nl-action-btn" data-action="art-open-draft" data-id="${escHtml(d.id)}">Open</button>
          <button class="nl-action-btn" data-action="art-duplicate-draft" data-id="${escHtml(d.id)}">Copy</button>
          <button class="nl-action-btn danger" data-action="art-delete-draft" data-id="${escHtml(d.id)}">Delete</button>
        </div>
      </div>`).join('')}
    </div>`);
}

// ── ACTIONS ───────────────────────────────────────────────────────────────────
async function articlesHandleAction(action, d) {
  switch (action) {
    case 'art-source-mode':
      art.sourceMode = d.mode; render(); return true;

    case 'art-search-clear':
      art.search = ''; render(); return true;

    // Click-to-add: the sidebar card carries its metadata in data-src so no
    // network call is needed — an RSS story's text is fetched server-side at
    // generation, exactly like the newsletter builder.
    case 'art-add':
      try { artAddSource(JSON.parse(d.src)); } catch { /* malformed */ }
      return true;

    case 'art-add-url':
      await artAddUrl(); return true;

    case 'art-remove-source':
      artRemoveSource(d.id); return true;

    case 'art-clear-sources':
      art.sources = []; refreshArticleWorkspace(); refreshArticleSidebar(); artSyncGenerateButton(); return true;

    case 'art-new':
      art.sources = []; art.angle = ''; art.notes = ''; art.draft = null; art.urlInput = '';
      art.promptOverride = ''; art.advancedOpen = false;
      render(); return true;

    case 'art-toggle-advanced':
      art.advancedOpen = !art.advancedOpen; render();
      if (art.advancedOpen) document.getElementById('art-override')?.focus();
      return true;

    case 'art-edit-master':
      state.settingsTab = 'ai'; navigate('settings'); return true;

    case 'art-generate':
      await artGenerate(); return true;

    case 'art-regenerate': {
      const ok = await showConfirm({
        title: 'Regenerate this article?',
        message: 'The current draft text is replaced. Your angle, notes and prompt stay as they are.',
        confirmText: 'Regenerate',
        danger: true,
      });
      if (ok) await artGenerate();
      return true;
    }

    case 'art-exec':
      artExec(d.cmd); return true;

    case 'art-copy': {
      const ed = document.getElementById('art-editor');
      const title = art.draft?.title || '';
      writeRichClipboard(`<h1>${escHtml(title)}</h1>${ed ? ed.innerHTML : ''}`, `${title}\n\n${ed ? ed.innerText : ''}`);
      toast('Article copied — paste anywhere with formatting intact', 'success');
      return true;
    }

    case 'art-export': {
      const ed = document.getElementById('art-editor');
      const title = art.draft?.title || 'article';
      const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title></head><body><article><h1>${escHtml(title)}</h1>${ed ? ed.innerHTML : ''}</article></body></html>`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
      a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) || 'article'}.html`;
      a.click();
      URL.revokeObjectURL(a.href);
      return true;
    }

    case 'art-to-newsletter': await artAddToNewsletter(); return true;

    case 'art-open-drafts':  showArticleDraftsModal(); return true;
    case 'art-close-modal':  closeModal(); return true;

    case 'art-open-draft': {
      const draft = art.drafts.find(x => x.id === d.id);
      if (!draft) return true;
      art.draft = { ...draft };
      art.angle = draft.angle || art.angle;
      art.notes = draft.notes || art.notes;
      // Restore the draft's sources into the workspace so Regenerate works and
      // the reader can see what it was written from. No network: metadata only.
      art.sources = Array.isArray(draft.sources) && draft.sources.length
        ? draft.sources.map(s => ({ ...s, id: s.id || 'src_' + uid() }))
        : (draft.sourceUrl ? [{ id: 'src_' + uid(), title: draft.sourceTitle || draft.sourceUrl, publication: draft.sourcePublication || '', url: draft.sourceUrl, imageUrl: '', timeAgo: '', publishedAt: '', fromRss: false }] : []);
      closeModal();
      render();
      return true;
    }

    case 'art-duplicate-draft': {
      const src = art.drafts.find(x => x.id === d.id);
      if (!src) return true;
      const copy = { ...src, id: null, createdAt: null, title: `${src.title} (copy)`, status: 'draft' };
      await artPersistDraft(copy);
      art.drafts.unshift(copy);
      showArticleDraftsModal();
      toast('Draft duplicated', 'success');
      return true;
    }

    case 'art-delete-draft': {
      const target = art.drafts.find(x => x.id === d.id);
      const ok = await showConfirm({
        title: 'Delete this article?',
        message: `"${target?.title || 'Untitled'}" will be permanently removed.`,
        danger: true,
      });
      if (!ok) { showArticleDraftsModal(); return true; }
      await artDeleteDraftRow(d.id);
      art.drafts = art.drafts.filter(x => x.id !== d.id);
      if (art.draft?.id === d.id) art.draft = null;
      render();
      showArticleDraftsModal();
      toast('Article deleted', 'success');
      return true;
    }
  }
  return false;
}

// ── INPUT ─────────────────────────────────────────────────────────────────────
function articlesHandleInput(t) {
  switch (t.id) {
    case 'art-angle':
      art.angle = t.value; artSyncGenerateButton(); return true;
    case 'art-notes':
      art.notes = t.value; return true;
    case 'art-override':
      art.promptOverride = t.value; return true;
    case 'art-url-input':
    case 'art-url-add':
      art.urlInput = t.value; return true;
    case 'art-search':
      art.search = t.value; refreshArticleSidebar(); return true;
    case 'art-draft-search':
      art.draftSearch = t.value; showArticleDraftsModal();
      document.getElementById('art-draft-search')?.focus(); return true;
    case 'art-headline':
      if (art.draft) { art.draft.title = t.value; artScheduleSave(); }
      return true;
    case 'art-status':
      if (art.draft) { art.draft.status = t.value; artScheduleSave(); }
      return true;
  }
  return false;
}

// Toggle the button in place: a re-render on every keystroke would drop the
// caret out of the angle box.
function artSyncGenerateButton() {
  const btn = document.querySelector('[data-action="art-generate"]');
  if (!btn) return;
  const ready = art.sources.length > 0 && art.angle.trim().length > 0;
  btn.disabled = !ready || art.generating;
  // The tooltip explains WHY it's disabled, so it has to move with the state.
  btn.title = !art.sources.length ? 'Add at least one source first'
    : !art.angle.trim() ? 'An angle is required'
    : 'Draft the article';
  btn.innerHTML = art.generating ? '<span class="spinner"></span> Generating'
    : `✦ Generate Article${art.sources.length > 1 ? ` (${art.sources.length})` : ''}`;
}

function articlesHandleSubmit(form) {
  // The sidebar URL form (URL mode) and the in-workspace URL box both add a source.
  if (form.id === 'art-url-form') {
    art.urlInput = document.getElementById('art-url-input')?.value.trim() || '';
    artAddUrl();
    return true;
  }
  return false;
}

// ── ADD A SOURCE BY URL ─────────────────────────────────────────────────────────
// A pasted URL is the one path that extracts on add — we validate it and pull
// real metadata before it joins the workspace. RSS cards, by contrast, never
// call the network here (their body is fetched server-side at generation).
async function artAddUrl() {
  const url = (document.getElementById('art-url-add')?.value || document.getElementById('art-url-input')?.value || art.urlInput || '').trim();
  if (!url) { toast('Paste an article URL first', 'warn'); return; }
  try { new URL(url); } catch { toast("That doesn't look like a valid URL", 'warn'); return; }
  if (artSourceExists(url)) { toast('Already in your sources', 'warn'); return; }

  art.extractingUrl = url;
  refreshArticleWorkspace();
  refreshArticleSidebar();
  try {
    const res = await fetch('/api/articles/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(artHumanError(res.status, data));
    const s = data.source;
    art.extractingUrl = '';
    artAddSource({ id: '', url: s.url, title: s.title, source: s.publication, imageUrl: s.imageUrl || '', publishedAt: s.publishedAt, rss: false });
    art.urlInput = '';
    const inWs = document.getElementById('art-url-add'); if (inWs) inWs.value = '';
    art.recentUrls = [{ url: s.url, title: s.title, publication: s.publication, at: new Date().toISOString() },
      ...art.recentUrls.filter(r => r.url !== s.url)].slice(0, 8);
    artWriteLocal(artRecentKey(), art.recentUrls);
    if (!data.cached) toast(`Added — ${s.wordCount} words`, 'success');
  } catch (e) {
    art.extractingUrl = '';
    refreshArticleWorkspace();
    toast(e.message, 'error');
  }
}

// Turns a server error into an accurate, useful sentence — WITHOUT flattening
// everything into "rate limited". The three rate-limit sources (our own throttle,
// the source site's, the monthly quota) each get their own honest message.
function artHumanError(status, data) {
  const code = data && data.error;
  const raw = (data && (data.message || data.error)) || '';
  // Typed application/provider errors — each gets its own honest message so a
  // provider hiccup is never mislabeled as our throttle, and vice versa.
  if (code === 'article_rate_limit')  return data.message || "You're going a bit fast — wait a moment and try again.";
  if (code === 'generation_limit')    return data.message || 'Monthly generation limit reached.';
  if (code === 'provider_rate_limit') return data.message || 'The AI provider is rate-limiting us — wait a moment and try again.';
  if (code === 'provider_overloaded') return data.message || 'The AI provider is temporarily overloaded — try again in a minute.';
  if (code === 'provider_auth')       return data.message || 'The AI key was rejected — check ANTHROPIC_API_KEY.';
  if (code === 'provider_bad_request')return data.message || 'The AI request was invalid.';
  if (/rate-limiting us|rate limited by/i.test(raw)) return 'The source website is rate-limiting us — wait a minute and try again.';
  if (status === 429) return raw || 'Too many requests right now — please wait a moment.';
  if (status === 401 || status === 403) return 'Your session expired — please sign in again.';
  if (status === 402) return 'A subscription is required to generate.';
  if (status === 503) return raw || 'The AI provider is temporarily unavailable — try again shortly.';
  if (status >= 500) return raw || 'The server had a problem — please try again.';
  return raw || 'Something went wrong. Please try again.';
}

// ── GENERATION ────────────────────────────────────────────────────────────────
async function artGenerate() {
  // In-flight guard: one click = one job, no matter how many times it's fired.
  if (!art.sources.length || !art.angle.trim() || art.generating) return;
  art.generating = true;
  art.genStatus = art.sources.length > 1 ? `Reading ${art.sources.length} sources…` : 'Reading the source…';
  art.draft = null;          // skeleton first, exactly like a builder section
  refreshArticleDraft();
  render();

  const lead = art.sources[0];
  const body = {
    // Ordered URLs — the workspace order IS the priority order. The master
    // prompt is NOT sent (the server reads it from this user's settings); only a
    // one-off override travels per request.
    urls: art.sources.map(s => s.url),
    angle: art.angle,
    notes: art.notes,
    promptOverride: art.promptOverride.trim(),
    publicationId: state.currentPublicationId || '',
    mode: 'news',
    stream: true,
    userId: state.user?.id || '',
    authToken: await getAuthToken(),
  };
  // No-DB installs (mock/local mode) have no settings row for the server to read,
  // so the client mirrors the locally-saved master prompt as a fallback. This is
  // the only path on which the master prompt text leaves the browser.
  if (!artHasDB() && !body.promptOverride) {
    body.masterPromptText = (articleSettings().masterPrompt || '').trim();
  }

  let markdown = '';
  let mock = false;
  let surfaced = false;   // has the user already been shown why it failed?
  try {
    const res = await fetch('/api/articles/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.error === 'subscription_required') { showSubscribeModal(); surfaced = true; throw new Error('subscription_required'); }
      // Accurate, source-specific messaging — never a blanket "rate limited".
      toast(artHumanError(res.status, data), 'error');
      surfaced = true;
      throw new Error(data.error || `http_${res.status}`);
    }

    // Live-render as it streams, the same way a builder section does: the first
    // token swaps the skeleton for the story block, later tokens update only the
    // editor node. Painting is coalesced to one frame so a fast stream doesn't
    // re-parse markdown dozens of times a second.
    let first = true;
    await readSSEStream(res, {
      onData: (data) => {
        if (data.mock) mock = true;
        if (data.delta) {
          markdown += data.delta;
          const { title, body: mdBody } = artSplitHeadline(markdown);
          if (first) {
            first = false;
            art.draft = artNewDraft(title, mdBody);
            refreshArticleDraft();
            const h = document.getElementById('art-headline');
            if (h) h.disabled = false;
          }
          art.draft.title = title || lead.title;
          art.draft.bodyHtml = artMdToHtml(mdBody);
          artQueuePaint();
        } else if (data.progress) {
          art.genStatus = researchStatusLabel(data.progress);
          const el = document.querySelector('.gen-status');
          if (el) el.textContent = art.genStatus;
        }
      },
    });

    const { title, body: mdBody } = artSplitHeadline(markdown);
    if (!art.draft) art.draft = artNewDraft(title, mdBody);
    art.draft.title = title || lead.title || 'Untitled Article';
    art.draft.bodyHtml = artMdToHtml(mdBody);
    await artPersistDraft(art.draft);
    art.drafts.unshift({ ...art.draft });
    // Never call a placeholder a draft — that is exactly how a mock run gets
    // mistaken for the model failing to write anything.
    if (mock) toast('Mock placeholder — set ANTHROPIC_API_KEY to draft for real', 'warn');
    else toast('Draft ready — edit it below', 'success');
  } catch (e) {
    // A pre-stream failure was already toasted (surfaced=true). But a mid-stream
    // failure — a real provider 429/5xx AFTER the SSE headers flushed — arrives
    // here as a thrown error frame that nothing else has shown. Surface it, or
    // the skeleton would just vanish with no explanation (the exact silent
    // failure this task set out to kill).
    console.warn('[articles] generation failed:', e.code || e.message, e.serverMessage || '');
    if (!surfaced && e.message !== 'subscription_required') {
      toast(artHumanError(e.status || 500, { error: e.code || e.message, message: e.serverMessage }), 'error');
    }
  } finally {
    art.generating = false;
    art.genStatus = '';
    render();
    document.getElementById('art-editor')?.focus();
  }
}

// ── Bridge: Article → Newsletter ──────────────────────────────────────────────
// Turns the finished article into an editable block in a newsletter, completing
// the DoD pipeline (approve an article → add it to the newsletter). It reuses the
// newsletter's own state + save path (app.js globals), so the block persists,
// renders, and is draggable exactly like any other section item.
function artHtmlToText(html = '') {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  div.querySelectorAll('h1,h2,h3,h4,p,li,br,blockquote').forEach(el => el.insertAdjacentText('afterend', '\n'));
  return (div.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

async function artAddToNewsletter() {
  if (!art.draft) { toast('Generate or open an article first', 'warn'); return; }
  const ed = document.getElementById('art-editor');
  const title = (art.draft.title || 'Untitled').trim();
  const html = ed ? ed.innerHTML : (art.draft.bodyHtml || '');
  const contentText = artHtmlToText(html);
  if (!contentText) { toast('Nothing to add yet', 'warn'); return; }

  // Persist the draft first so it also remains in Drafts.
  try { await artPersistDraft(art.draft); } catch {}

  // Start a fresh issue only if there is genuinely nothing in progress.
  if (!state.newsletterId && (!state.newsletter || !(state.newsletter.sectionOrder || []).length)) {
    resetNewsletter();
  }

  // Find a section that renders per-article blocks (hits/generic). If the current
  // template has none, add a dedicated "Articles" section so the block always
  // renders and persists — never a silent no-op.
  const meta = state.newsletter.sectionMeta || {};
  let target = (state.newsletter.sectionOrder || []).find(id => ['hits', 'generic'].includes(meta[id]?.type));
  if (!target) {
    target = 'articles_' + uid();
    state.newsletter.sectionOrder.push(target);
    state.newsletter.sectionMeta[target] = { name: 'Articles', type: 'generic' };
    state.newsletter.sections[target] = [];
    state.newsletter.prompts[target] = '';
  }
  if (!Array.isArray(state.newsletter.sections[target])) state.newsletter.sections[target] = [];

  state.newsletter.sections[target].push({
    id: 'art_' + uid(),
    title,
    content: title ? `**${title}**\n\n${contentText}` : contentText,
    source: art.draft.sourcePublication || art.draft.sourceTitle || 'Article',
    url: art.draft.sourceUrl || '',
    _fromArticle: true,
  });

  await saveNewsletter();
  toast(`Added to "${state.newsletter.title}" → ${state.newsletter.sectionMeta[target]?.name || 'Articles'}`, 'success');
  navigate('builder', { id: state.newsletterId });
}

function artNewDraft(title, mdBody) {
  const lead = art.sources[0] || {};
  return {
    id: null,
    title: title || lead.title || 'Untitled Article',
    bodyHtml: artMdToHtml(mdBody || ''),
    status: 'draft',
    generationSource: 'manual',
    angle: art.angle,
    notes: art.notes,
    mode: 'news',
    // Full ordered source list is persisted so reopening a draft restores the
    // workspace; the single fields stay for back-compat and the drafts list.
    sources: art.sources.map(({ id, title, publication, url, imageUrl, publishedAt, fromRss }) => ({ id, title, publication, url, imageUrl, publishedAt, fromRss })),
    sourceUrl: lead.url || '',
    sourceTitle: lead.title || '',
    sourcePublication: lead.publication || '',
    promptId: '',   // prompts are no longer per-draft; kept for the DB column's sake
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function artQueuePaint() {
  if (art._paintQueued) return;
  art._paintQueued = true;
  requestAnimationFrame(() => {
    art._paintQueued = false;
    const ed = document.getElementById('art-editor');
    if (ed && art.draft) { ed.innerHTML = art.draft.bodyHtml; ed.scrollTop = ed.scrollHeight; }
    const h = document.getElementById('art-headline');
    if (h && art.draft && document.activeElement !== h) h.value = art.draft.title;
  });
}

// Re-bind non-delegated listeners after every render that puts them on screen.
// app.js's render() replaces innerHTML wholesale, so the editor and the drag
// zone have to be reattached each time.
function articlesAfterRender() {
  artBindEditor();
  setupArticleWorkspace();
}
