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
  source: null,            // { title, publication, author, publishedAt, url, wordCount, trimmed, cached, preview }
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
    createdAt: r.created_at, updatedAt: r.updated_at || r.created_at,
  };
}

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
        <button type="submit" class="btn btn-sm btn-primary" ${art.extractingUrl ? 'disabled' : ''}>${art.extractingUrl ? '…' : 'Extract'}</button>
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
        <div class="meta-preview" style="display:flex;align-items:center;gap:8px;min-height:22px">${renderArticleSourceLine()}</div>
      </div>

      ${renderArticleDirectionSection()}
      ${renderArticleDraftSection()}
    </main>
  </div>
</div>`;
}

// The source line under the headline: what this draft is being written from.
function renderArticleSourceLine() {
  const s = art.source;
  if (!s) return `<span class="text-dim">No source selected — pick an article on the left, or paste a URL.</span>`;
  const bits = [s.publication, s.author, s.publishedAt ? timeAgo(s.publishedAt) : '']
    .filter(Boolean).map(escHtml).join(' · ');
  return `
    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(s.title)}">
      <strong style="color:var(--text-1);font-weight:600">${escHtml(s.title)}</strong>
      ${bits ? ` — ${bits}` : ''}
    </span>
    <span class="badge ${s.cached ? 'badge-blue' : 'badge-default'}" title="${s.trimmed ? `Trimmed from ${s.sourceWordCount} words to keep the token cost down` : 'Cleaned article text sent to the model'}">${s.wordCount}w${s.trimmed ? ' ✂' : ''}</span>
    <button class="nl-action-btn" data-action="art-reextract" title="Fetch the page again and replace the cached copy">↻</button>
    <a class="nl-action-btn" href="${escHtml(s.url)}" target="_blank" rel="noopener" title="Open the original">↗</a>
    <button class="nl-action-btn danger" data-action="art-clear-source" title="Clear the selected source">×</button>`;
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
  : `<div class="art-list">${all.map(renderArticleRow).join('')}</div>`}`;
}

function renderArticleUrlList() {
  const rows = [];
  if (art.source) rows.push(renderArticleRow({
    url: art.source.url, title: art.source.title, source: art.source.publication,
    publishedAt: art.source.publishedAt,
    timeAgo: art.source.publishedAt ? timeAgo(art.source.publishedAt) : '',
  }));
  const recents = art.recentUrls.filter(r => r.url !== art.source?.url);
  return `
${rows.length ? `<div class="art-list">${rows.join('')}</div><div class="source-divider"></div>` : ''}
${recents.length ? `
  <div class="source-manager" style="padding-bottom:0">
    <div class="source-sidebar-title" style="padding:2px">Recent</div>
  </div>
  <div class="art-list">${recents.map(r => renderArticleRow({
    url: r.url, title: r.title, source: r.publication, timeAgo: timeAgo(r.at),
  })).join('')}</div>`
: !art.source ? `<div class="source-empty">
    <div class="source-empty-icon">🔗</div>
    <strong style="color:var(--text-2);font-size:13px">Paste an article URL</strong>
    <p style="margin-top:6px">Any news page. It's fetched, stripped to the story, and cached — the same link is never processed twice.</p>
  </div>` : ''}`;
}

// One row = one candidate article. Same .article-card the builder's sidebar
// uses, minus the drag/add-to-section affordances Articles has no use for.
function renderArticleRow(a) {
  const selected = art.source && a.url === art.source.url;
  const busy = art.extractingUrl === a.url;
  const host = artHost(a.url);
  return `
<div class="article-card ${selected ? 'selected' : ''}" data-action="art-pick" data-url="${escHtml(a.url || '')}"
  style="cursor:pointer" title="${escHtml(a.title || '')}">
  <div class="article-card-title">${escHtml(a.title || 'Untitled')}</div>
  <div class="article-card-meta">
    <span class="article-card-source" style="display:flex;align-items:center;gap:5px;min-width:0">
      ${host ? `<img class="art-favicon" src="https://${escHtml(host)}/favicon.ico" alt="" onerror="this.remove()">` : ''}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.source || host || '')}</span>
    </span>
    <span class="article-card-time">${busy ? '<span class="spinner"></span>' : selected ? '✓ selected' : escHtml(a.timeAgo || '')}</span>
  </div>
</div>`;
}

// ── DIRECTION ─────────────────────────────────────────────────────────────────
// A builder section, header and all: Generate lives in the header (exactly where
// every builder section keeps its Generate button), leaving the body for the one
// field that matters — the angle. The master prompt is set once in Settings and
// applied by the server automatically; it is deliberately absent from this page.
function renderArticleDirectionSection() {
  const ready = Boolean(art.source && art.angle.trim()) && !art.generating;
  const overriding = art.promptOverride.trim().length > 0;
  return `
<div class="editor-section">
  <div class="section-header">
    <span class="section-label">Direction</span>
    <div class="section-prompt-wrap">
      <span style="flex:1"></span>
      <button class="btn btn-sm btn-primary" data-action="art-generate" ${ready ? '' : 'disabled'}
        title="${!art.source ? 'Pick a source first' : !art.angle.trim() ? 'An angle is required' : 'Draft the article'}">
        ${art.generating ? '<span class="spinner"></span> Generating' : '✦ Generate Article'}
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
      <p style="font-size:13px;color:var(--text-2)">Pick an article, write the angle, hit <strong>✦ Generate Article</strong>.</p>
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
          <div class="feed-health-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(d.title || 'Untitled Article')}</div>
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

    case 'art-pick':
      await artExtract(d.url, false); return true;

    case 'art-reextract':
      await artExtract(art.source.url, true); return true;

    case 'art-clear-source':
      art.source = null; render(); return true;

    case 'art-new':
      art.source = null; art.angle = ''; art.notes = ''; art.draft = null; art.urlInput = '';
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

    case 'art-open-drafts':  showArticleDraftsModal(); return true;
    case 'art-close-modal':  closeModal(); return true;

    case 'art-open-draft': {
      const draft = art.drafts.find(x => x.id === d.id);
      if (!draft) return true;
      art.draft = { ...draft };
      art.angle = draft.angle || art.angle;
      art.notes = draft.notes || art.notes;
      // Reopening a draft re-selects its source, so Regenerate works instantly
      // and the reader can see what it was written from. Cached: no refetch.
      closeModal();
      render();
      if (draft.sourceUrl && draft.sourceUrl !== art.source?.url) artExtract(draft.sourceUrl, false);
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
  btn.disabled = !(art.source && art.angle.trim()) || art.generating;
  // The tooltip explains WHY it's disabled, so it has to move with the state —
  // a stale "an angle is required" on an enabled button is worse than none.
  btn.title = !art.source ? 'Pick a source first'
    : !art.angle.trim() ? 'An angle is required'
    : 'Draft the article';
}

function articlesHandleSubmit(form) {
  if (form.id !== 'art-url-form') return false;
  artExtract(document.getElementById('art-url-input').value.trim(), false);
  return true;
}

// ── EXTRACTION ────────────────────────────────────────────────────────────────
async function artExtract(url, refresh) {
  if (!url) { toast('Paste an article URL first', 'warn'); return; }
  art.extractingUrl = url;
  refreshArticleSidebar();
  try {
    const res = await fetch('/api/articles/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, refresh }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Extraction failed');
    art.source = data.source;
    if (art.sourceMode === 'url') {
      art.urlInput = '';
      // Recents make the second pass at a story one click instead of one paste.
      art.recentUrls = [{ url: data.source.url, title: data.source.title, publication: data.source.publication, at: new Date().toISOString() },
        ...art.recentUrls.filter(r => r.url !== data.source.url)].slice(0, 8);
      artWriteLocal(artRecentKey(), art.recentUrls);
    }
    if (!data.cached) toast(`Extracted ${data.source.wordCount} words`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    art.extractingUrl = '';
    render();
    document.getElementById('art-angle')?.focus();
  }
}

// ── GENERATION ────────────────────────────────────────────────────────────────
async function artGenerate() {
  if (!art.source || !art.angle.trim() || art.generating) return;
  art.generating = true;
  art.genStatus = 'Reading the source…';
  art.draft = null;          // skeleton first, exactly like a builder section
  refreshArticleDraft();
  render();

  const body = {
    url: art.source.url,
    angle: art.angle,
    notes: art.notes,
    // The master prompt is NOT sent — the server reads it from this user's
    // settings. Only a one-off override (Advanced Options) travels per request.
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
  try {
    const res = await fetch('/api/articles/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.error === 'subscription_required') { showSubscribeModal(); throw new Error('subscription_required'); }
      if (data.error === 'generation_limit') { toast(data.message || 'Monthly generation limit reached', 'error'); throw new Error('generation_limit'); }
      throw new Error(data.error || 'Generation failed');
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
          art.draft.title = title || art.source.title;
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
    art.draft.title = title || art.source.title || 'Untitled Article';
    art.draft.bodyHtml = artMdToHtml(mdBody);
    await artPersistDraft(art.draft);
    art.drafts.unshift({ ...art.draft });
    // Never call a placeholder a draft — that is exactly how a mock run gets
    // mistaken for the model failing to write anything.
    if (mock) toast('Mock placeholder — set ANTHROPIC_API_KEY to draft for real', 'warn');
    else toast('Draft ready — edit it below', 'success');
  } catch (e) {
    if (!['subscription_required', 'generation_limit'].includes(e.message)) {
      toast(e.message || 'Generation failed', 'error');
    }
  } finally {
    art.generating = false;
    art.genStatus = '';
    render();
    document.getElementById('art-editor')?.focus();
  }
}

function artNewDraft(title, mdBody) {
  return {
    id: null,
    title: title || art.source.title || 'Untitled Article',
    bodyHtml: artMdToHtml(mdBody || ''),
    status: 'draft',
    angle: art.angle,
    notes: art.notes,
    mode: 'news',
    sourceUrl: art.source.url,
    sourceTitle: art.source.title,
    sourcePublication: art.source.publication,
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

// Re-bind the editor after every render that puts it on screen. app.js's
// render() replaces innerHTML wholesale, so listeners have to be reattached.
function articlesAfterRender() {
  artBindEditor();
}
