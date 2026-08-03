/* ════════════════════════════════════════════════════════════════════════════
   Curanta — Articles
   ────────────────────────────────────────────────────────────────────────────
   A separate workflow from the Newsletter builder: ONE source (an RSS item or
   any pasted article URL) → an angle → a master prompt → a full draft in a rich
   text editor.

   Everything shared with the builder is borrowed, not re-implemented: the RSS
   feeds in state.sources, the Supabase client (sb), auth, escHtml/toast/
   showConfirm/writeRichClipboard, and the SSE reader. What lives here is only
   what is genuinely new.

   Cost discipline lives on the server (lib/articles.mjs). The one rule this file
   must honour: never send prompt text when a prompt ID will do.
════════════════════════════════════════════════════════════════════════════ */

// Feature-local state. Deliberately not merged into the global `state` object —
// the newsletter draft is autosaved wholesale and this has nothing to do with it.
const art = {
  tab: 'write',            // 'write' | 'drafts' | 'prompts'
  sourceMode: 'rss',       // 'rss' | 'url'
  view: 'setup',           // 'setup' | 'editor'
  urlInput: '',
  extracting: false,
  source: null,            // { title, publication, author, publishedAt, url, wordCount, trimmed, cached, preview }
  angle: '',
  notes: '',
  promptId: '',
  generating: false,
  streamText: '',          // markdown as it arrives
  progress: '',
  draft: null,             // { id, title, bodyHtml, status, sourceUrl, sourcePublication, sourceTitle, angle, notes, promptId, updatedAt }
  drafts: [],
  prompts: [],
  loaded: false,
  dbReady: null,           // null = unknown, true = tables exist, false = localStorage fallback
  saving: false,
  _saveTimer: null,
};

// ── Storage keys (localStorage fallback when the tables aren't migrated yet) ──
const artPromptsKey = () => `lwai_article_prompts_${state.currentPublicationId || 'default'}`;
const artDraftsKey  = () => `lwai_article_drafts_${state.currentPublicationId || 'default'}`;

function artReadLocal(key, fallback = []) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function artWriteLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota */ }
}

const artHasDB = () => Boolean(sb && state.user && art.dbReady !== false);

// One probe decides which storage backend the whole feature uses. A missing
// table means the user hasn't run supabase-schema.sql yet — the feature still
// works, locally, and says so, rather than erroring on every keystroke.
async function artDetectDB() {
  if (art.dbReady !== null) return art.dbReady;
  if (!sb || !state.user) { art.dbReady = false; return false; }
  const { error } = await sb.from('article_prompts').select('id').limit(1);
  art.dbReady = !error;
  if (error) console.warn('[articles] falling back to local storage:', error.message);
  return art.dbReady;
}

// ── PROMPT LIBRARY ────────────────────────────────────────────────────────────
const STARTER_PROMPT = `Write in the publication's house voice: direct, concrete, and free of hype.

Structure:
- Headline: specific and factual. No clickbait, no colons unless they earn their place.
- Lead paragraph: the news itself — what happened, who it affects, why now.
- Body: 5–9 short paragraphs. Lead each with a fact, not a transition.
- Include the strongest verbatim quote from the source, attributed by name and title.
- Close on what happens next or what remains unresolved. Never close on a summary.

Rules:
- 700–900 words.
- Attribute every claim that isn't self-evident to the reporting outlet.
- No "in today's fast-paced world", no rhetorical questions, no em-dash pile-ups.`;

async function artLoadPrompts() {
  if (await artDetectDB()) {
    const pubId = state.currentPublicationId || null;
    let q = sb.from('article_prompts').select('*').eq('user_id', state.user.id).order('created_at');
    q = pubId ? q.eq('publication_id', pubId) : q.is('publication_id', null);
    const { data, error } = await q;
    if (!error) {
      return (data || []).map(r => ({
        id: r.id, name: r.name, description: r.description || '',
        prompt: r.prompt || '', isDefault: !!r.is_default, mode: r.mode || 'news',
      }));
    }
    console.error('[articles] prompt load error:', error.message);
  }
  return artReadLocal(artPromptsKey());
}

async function artSavePrompt(p) {
  if (await artDetectDB()) {
    const row = {
      user_id: state.user.id,
      name: p.name, description: p.description, prompt: p.prompt,
      is_default: !!p.isDefault, mode: p.mode || 'news',
      publication_id: state.currentPublicationId || null,
    };
    if (p.id) {
      const { error } = await sb.from('article_prompts').update(row).eq('id', p.id).eq('user_id', state.user.id);
      if (error) { toast('Could not save prompt: ' + error.message, 'error'); return null; }
      return p.id;
    }
    const { data, error } = await sb.from('article_prompts').insert(row).select('id').single();
    if (error) { toast('Could not save prompt: ' + error.message, 'error'); return null; }
    return data.id;
  }
  const list = artReadLocal(artPromptsKey());
  if (p.id) {
    const i = list.findIndex(x => x.id === p.id);
    if (i >= 0) list[i] = { ...list[i], ...p };
  } else {
    p.id = 'local_' + uid();
    list.push(p);
  }
  artWriteLocal(artPromptsKey(), list);
  return p.id;
}

async function artDeletePromptRow(id) {
  if (await artDetectDB()) {
    const { error } = await sb.from('article_prompts').delete().eq('id', id).eq('user_id', state.user.id);
    if (error) toast('Could not delete prompt: ' + error.message, 'error');
    return;
  }
  artWriteLocal(artPromptsKey(), artReadLocal(artPromptsKey()).filter(p => p.id !== id));
}

// Exactly one default. Enforced here rather than in the DB because the rule is
// per-publication and a partial unique index would fight the localStorage path.
async function artApplyDefault(id) {
  art.prompts = art.prompts.map(p => ({ ...p, isDefault: p.id === id }));
  if (await artDetectDB()) {
    const pubId = state.currentPublicationId || null;
    let clear = sb.from('article_prompts').update({ is_default: false }).eq('user_id', state.user.id);
    clear = pubId ? clear.eq('publication_id', pubId) : clear.is('publication_id', null);
    await clear;
    await sb.from('article_prompts').update({ is_default: true }).eq('id', id).eq('user_id', state.user.id);
  } else {
    artWriteLocal(artPromptsKey(), art.prompts);
  }
  art.promptId = id;
}

// ── DRAFTS ────────────────────────────────────────────────────────────────────
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
    updatedAt: r.updated_at || r.created_at,
  };
}

async function artPersistDraft(draft) {
  draft.updatedAt = new Date().toISOString();
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
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

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

// The first "# " line is the headline — it belongs in the title field, not in
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

// ── PAGE ──────────────────────────────────────────────────────────────────────
// Called by app.js's router before rendering the Articles view.
async function articlesOnNavigate() {
  if (!art.loaded) {
    art.loaded = true;
    const [prompts, drafts] = await Promise.all([artLoadPrompts(), artLoadDrafts()]);
    art.prompts = prompts;
    art.drafts = drafts;
    if (!art.promptId) art.promptId = (prompts.find(p => p.isDefault) || prompts[0] || {}).id || '';
  }
  // Feeds are shared with the builder — load them the same way it does.
  if (sb && state.user && !state.sources.length) state.sources = await loadSourcesFromDB();
  autoFetchSources();
}

function renderArticlesPage() {
  return `
<div class="app-shell">
  ${renderAppNav('articles')}
  <div class="app-main">
    ${renderTrialBanner()}
    <div class="app-topbar">
      <div>
        <div class="page-title">
          Articles
          ${!state.hasAI ? '<span class="mock-badge" style="margin-left:10px;vertical-align:middle" title="No ANTHROPIC_API_KEY is configured, so Generate returns a placeholder instead of a written article">✦ Mock AI</span>' : ''}
        </div>
        <div class="page-sub">Draft a full news article from an RSS item or any article URL.</div>
      </div>
      ${art.view === 'editor' ? `
        <button class="btn btn-outline btn-sm" data-action="art-back-to-setup">← Back to setup</button>
      ` : ''}
    </div>
    <div class="page-body">
      ${art.dbReady === false && sb && state.user ? `
      <div class="card" style="margin-bottom:16px;padding:12px 16px;border-left:3px solid var(--amber)">
        <div style="font-size:13px;color:var(--text-2);line-height:1.5">
          ⚠️ Articles and prompts are saved in <strong>this browser only</strong>.
          Run the <code style="font-size:11px">article_prompts</code> / <code style="font-size:11px">articles</code>
          migration from <code style="font-size:11px">supabase-schema.sql</code> to sync them across devices.
        </div>
      </div>` : ''}

      ${art.view === 'editor' ? renderArticleEditor() : `
      <div class="settings-tabs" style="max-width:520px">
        <button class="settings-tab ${art.tab === 'write' ? 'active' : ''}" data-action="art-tab" data-tab="write">Write</button>
        <button class="settings-tab ${art.tab === 'drafts' ? 'active' : ''}" data-action="art-tab" data-tab="drafts">Drafts${art.drafts.length ? ` (${art.drafts.length})` : ''}</button>
        <button class="settings-tab ${art.tab === 'prompts' ? 'active' : ''}" data-action="art-tab" data-tab="prompts">Prompt Library</button>
      </div>
      ${art.tab === 'write' ? renderArticleWriteTab()
        : art.tab === 'drafts' ? renderArticleDraftsTab()
        : renderArticlePromptsTab()}
      `}
    </div>
  </div>
</div>`;
}

// ── Write tab ─────────────────────────────────────────────────────────────────
function renderArticleWriteTab() {
  const ready = Boolean(art.source && art.angle.trim());
  return `
<div class="art-grid">
  <div class="card art-card">
    <div class="art-step">
      <span class="art-step-num">1</span>
      <div>
        <div class="art-step-title">Choose a source</div>
        <div class="art-step-sub">An article from your feeds, or any URL you paste.</div>
      </div>
    </div>

    ${art.source ? renderArticleSourceCard() : `
    <div class="settings-tabs" style="margin:14px 0 16px">
      <button class="settings-tab ${art.sourceMode === 'rss' ? 'active' : ''}" data-action="art-source-mode" data-mode="rss">From RSS</button>
      <button class="settings-tab ${art.sourceMode === 'url' ? 'active' : ''}" data-action="art-source-mode" data-mode="url">From URL</button>
    </div>
    ${art.sourceMode === 'rss' ? renderArticleFeedPicker() : renderArticleUrlPicker()}
    `}
  </div>

  <div class="card art-card ${art.source ? '' : 'art-card-dim'}">
    <div class="art-step">
      <span class="art-step-num">2</span>
      <div>
        <div class="art-step-title">Direction</div>
        <div class="art-step-sub">The angle is what makes this your story and not a summary.</div>
      </div>
    </div>

    <label class="art-label">Article angle <span style="color:var(--red)">*</span></label>
    <textarea class="input" id="art-angle" rows="3" placeholder="e.g. What this ruling means for small landlords in the Midwest — lead with the compliance deadline.">${escHtml(art.angle)}</textarea>

    <label class="art-label" style="margin-top:14px">Notes <span class="art-label-opt">optional</span></label>
    <textarea class="input" id="art-notes" rows="2" placeholder="Anything else: length, who to quote, what to leave out.">${escHtml(art.notes)}</textarea>

    <label class="art-label" style="margin-top:14px">Master prompt</label>
    ${art.prompts.length ? `
    <select class="input" id="art-prompt-select">
      <option value="">— No master prompt (house defaults) —</option>
      ${art.prompts.map(p => `
        <option value="${escHtml(p.id)}" ${p.id === art.promptId ? 'selected' : ''}>
          ${escHtml(p.name)}${p.isDefault ? ' ★ default' : ''}
        </option>`).join('')}
    </select>
    <div class="art-hint">Stored on the server — only its ID is sent when you generate.</div>
    ` : `
    <div class="art-empty-inline">
      No prompts yet.
      <button class="btn btn-ghost btn-sm" data-action="art-tab" data-tab="prompts">Build your library →</button>
    </div>`}

    ${!state.hasAI ? `
    <div class="art-empty-inline" style="margin-top:16px;border-color:var(--amber);color:var(--text-2)">
      ⚠️ <strong>Mock mode.</strong> No <code style="font-size:11px">ANTHROPIC_API_KEY</code> is set, so Generate
      returns a placeholder — the source is still fetched, cleaned and cached for real.
    </div>` : ''}

    <div style="display:flex;align-items:center;gap:12px;margin-top:20px">
      <button class="btn btn-primary" data-action="art-generate" ${ready && !art.generating ? '' : 'disabled'}>
        ${art.generating ? '<span class="spinner"></span> Generating…' : state.hasAI ? '✦ Generate Article' : '✦ Generate (mock)'}
      </button>
      ${art.generating && art.progress ? `<span class="text-xs text-dim">${escHtml(art.progress)}</span>`
        : !art.source ? '<span class="text-xs text-dim">Pick a source first</span>'
        : !art.angle.trim() ? '<span class="text-xs text-dim">An angle is required</span>' : ''}
    </div>

    ${art.generating || art.streamText ? `
    <div class="art-stream" id="art-stream">${escHtml(art.streamText)}</div>` : ''}
  </div>
</div>`;
}

function renderArticleSourceCard() {
  const s = art.source;
  return `
<div class="art-source-card">
  <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
    <div style="min-width:0">
      <div class="art-source-title">${escHtml(s.title || 'Untitled')}</div>
      <div class="art-source-meta">
        ${[s.publication, s.author ? `by ${s.author}` : '', s.publishedAt ? timeAgo(s.publishedAt) : '']
          .filter(Boolean).map(escHtml).join(' · ') || 'No publication metadata found'}
      </div>
    </div>
    <div style="display:flex;gap:6px;flex-shrink:0">
      <button class="btn btn-ghost btn-sm" data-action="art-reextract" title="Fetch the page again and replace the cached copy">↻ Re-extract</button>
      <button class="btn btn-ghost btn-sm" data-action="art-clear-source">✕</button>
    </div>
  </div>
  <div class="art-source-badges">
    <span class="badge badge-green">${s.wordCount} words ready</span>
    ${s.trimmed ? `<span class="badge badge-amber" title="Trimmed on a paragraph boundary to keep the token bill down">trimmed from ${s.sourceWordCount}</span>` : ''}
    <span class="badge ${s.cached ? 'badge-blue' : 'badge-default'}">${s.cached ? 'from cache — no refetch' : 'freshly extracted'}</span>
  </div>
  ${s.preview ? `<div class="art-source-preview">${escHtml(s.preview)}…</div>` : ''}
  <a class="art-source-link" href="${escHtml(s.url)}" target="_blank" rel="noopener">${escHtml(s.url)}</a>
</div>`;
}

function renderArticleFeedPicker() {
  if (!state.sources.length) {
    return `
    <div class="art-empty-inline">
      No feeds yet.
      <button class="btn btn-ghost btn-sm" data-action="navigate" data-view="sources">Add sources →</button>
    </div>`;
  }
  return `
<div class="art-feed-list">
  ${state.sources.map(s => `
  <div class="art-feed">
    <div class="art-feed-head">
      <span>${sourceIcon(s)} ${escHtml(s.title || s.feedUrl)}</span>
      <span class="text-xs text-dim">${s.articles.length ? `${s.articles.length} items` : 'fetching…'}</span>
    </div>
    ${s.articles.slice(0, 8).map(a => `
    <button class="art-feed-item" data-action="art-pick-rss" data-url="${escHtml(a.url)}" ${a.url ? '' : 'disabled'}>
      <span class="art-feed-item-title">${escHtml(a.title)}</span>
      <span class="art-feed-item-time">${escHtml(a.timeAgo || '')}</span>
    </button>`).join('')}
  </div>`).join('')}
</div>`;
}

function renderArticleUrlPicker() {
  return `
<form id="art-url-form" class="art-url-form">
  <input class="input" id="art-url-input" type="url" placeholder="https://apnews.com/article/…" value="${escHtml(art.urlInput)}" autocomplete="off">
  <button class="btn btn-primary" type="submit" ${art.extracting ? 'disabled' : ''}>
    ${art.extracting ? '<span class="spinner"></span>' : 'Extract'}
  </button>
</form>
<div class="art-hint">Any news article URL. The page is fetched, stripped to the story itself, and cached — the same link is never processed twice.</div>`;
}

// ── Drafts tab ────────────────────────────────────────────────────────────────
function renderArticleDraftsTab() {
  if (!art.drafts.length) {
    return `
    <div class="empty-state">
      <div style="font-size:32px;margin-bottom:12px">📝</div>
      <div class="empty-state-title">No articles yet</div>
      <div class="empty-state-sub">Generated drafts land here, and stay editable.</div>
    </div>`;
  }
  return `
<div style="display:flex;flex-direction:column;gap:10px">
  ${art.drafts.map(d => `
  <div class="card art-draft-row">
    <div style="min-width:0;flex:1">
      <div class="art-draft-title">${escHtml(d.title || 'Untitled Article')}</div>
      <div class="art-draft-meta">
        ${escHtml(d.sourcePublication || 'Unknown source')}
        · ${artWordCount(d.bodyHtml)} words
        · ${escHtml(timeAgo(d.updatedAt) || 'just now')}
        ${d.status && d.status !== 'draft' ? ` · <span class="badge badge-accent">${escHtml(d.status)}</span>` : ''}
      </div>
    </div>
    <div style="display:flex;gap:6px;flex-shrink:0">
      <button class="btn btn-outline btn-sm" data-action="art-open-draft" data-id="${escHtml(d.id)}">Open</button>
      <button class="btn btn-ghost btn-sm" data-action="art-duplicate-draft" data-id="${escHtml(d.id)}">Duplicate</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" data-action="art-delete-draft" data-id="${escHtml(d.id)}">Delete</button>
    </div>
  </div>`).join('')}
</div>`;
}

// ── Prompt library tab ────────────────────────────────────────────────────────
function renderArticlePromptsTab() {
  return `
<div class="art-prompts-head">
  <div class="page-sub" style="margin:0">
    Master prompts are stored server-side and referenced by ID at generation time.
  </div>
  <button class="btn btn-primary btn-sm" data-action="art-new-prompt">+ New prompt</button>
</div>

${!art.prompts.length ? `
<div class="empty-state">
  <div style="font-size:32px;margin-bottom:12px">📐</div>
  <div class="empty-state-title">No master prompts yet</div>
  <div class="empty-state-sub">A master prompt is your house style — written once, applied to every article.</div>
  <button class="btn btn-outline btn-sm" style="margin-top:14px" data-action="art-new-prompt" data-starter="1">Start from a template</button>
</div>` : `
<div style="display:flex;flex-direction:column;gap:10px">
  ${art.prompts.map(p => `
  <div class="card art-prompt-row">
    <div style="min-width:0;flex:1">
      <div class="art-draft-title">
        ${escHtml(p.name)}
        ${p.isDefault ? '<span class="badge badge-accent" style="margin-left:8px">★ default</span>' : ''}
      </div>
      ${p.description ? `<div class="art-draft-meta">${escHtml(p.description)}</div>` : ''}
      <div class="art-prompt-preview">${escHtml((p.prompt || '').slice(0, 180))}${(p.prompt || '').length > 180 ? '…' : ''}</div>
    </div>
    <div class="art-prompt-actions">
      <button class="btn btn-outline btn-sm" data-action="art-edit-prompt" data-id="${escHtml(p.id)}">Edit</button>
      <button class="btn btn-ghost btn-sm" data-action="art-duplicate-prompt" data-id="${escHtml(p.id)}">Duplicate</button>
      ${p.isDefault ? '' : `<button class="btn btn-ghost btn-sm" data-action="art-set-default-prompt" data-id="${escHtml(p.id)}">Set default</button>`}
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" data-action="art-delete-prompt" data-id="${escHtml(p.id)}">Delete</button>
    </div>
  </div>`).join('')}
</div>`}`;
}

function showArticlePromptModal(prompt = null, useStarter = false) {
  const p = prompt || { id: '', name: '', description: '', prompt: useStarter ? STARTER_PROMPT : '', isDefault: !art.prompts.length };
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal" style="max-width:640px">
      <div style="font-size:16px;font-weight:700;margin-bottom:16px">${p.id ? 'Edit prompt' : 'New master prompt'}</div>
      <label class="art-label">Name</label>
      <input class="input" id="art-p-name" value="${escHtml(p.name)}" placeholder="House news style">
      <label class="art-label" style="margin-top:12px">Description</label>
      <input class="input" id="art-p-desc" value="${escHtml(p.description)}" placeholder="When to use this one">
      <label class="art-label" style="margin-top:12px">Prompt</label>
      <textarea class="input" id="art-p-body" rows="12" style="font-size:12.5px;line-height:1.6" placeholder="Voice, structure, length, rules…">${escHtml(p.prompt)}</textarea>
      <label class="art-check" style="margin-top:12px">
        <input type="checkbox" id="art-p-default" ${p.isDefault ? 'checked' : ''}>
        <span>Use as default for new articles</span>
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
        <button class="btn btn-outline" data-action="close-modal">Cancel</button>
        <button class="btn btn-primary" data-action="art-save-prompt" data-id="${escHtml(p.id)}">Save prompt</button>
      </div>
    </div>
  </div>`;
  // Same overlay convention as the app's other modals: click the backdrop to
  // dismiss, and let clicks inside bubble normally so the delegated data-action
  // handler still sees the buttons.
  modal.querySelector('#modal-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  setTimeout(() => document.getElementById('art-p-name')?.focus(), 40);
}

// ── EDITOR ────────────────────────────────────────────────────────────────────
const ART_TOOLS = [
  ['bold', 'B', 'Bold', 'font-weight:700'],
  ['italic', 'I', 'Italic', 'font-style:italic'],
  ['formatBlock:h2', 'H2', 'Subhead'],
  ['formatBlock:h3', 'H3', 'Sub-subhead'],
  ['formatBlock:p', '¶', 'Paragraph'],
  ['formatBlock:blockquote', '❝', 'Pull quote'],
  ['insertUnorderedList', '•', 'Bulleted list'],
  ['insertOrderedList', '1.', 'Numbered list'],
  ['createLink', '🔗', 'Link'],
  ['removeFormat', '⌫', 'Clear formatting'],
];

function renderArticleEditor() {
  const d = art.draft || {};
  return `
<div class="art-editor-wrap">
  <div class="art-editor-main card">
    <input class="art-title-input" id="art-title" value="${escHtml(d.title || '')}" placeholder="Headline…" spellcheck="true">
    <div class="art-toolbar">
      ${ART_TOOLS.map(([cmd, label, title, style]) => `
        <button class="art-tool" data-action="art-exec" data-cmd="${cmd}" title="${title}" style="${style || ''}">${label}</button>`).join('')}
      <span class="art-toolbar-sep"></span>
      <button class="art-tool" data-action="art-exec" data-cmd="undo" title="Undo">↺</button>
      <button class="art-tool" data-action="art-exec" data-cmd="redo" title="Redo">↻</button>
      <span style="flex:1"></span>
      <span class="text-xs text-dim" id="art-wordcount">${artWordCount(d.bodyHtml)} words</span>
    </div>
    <div class="art-editor" id="art-editor" contenteditable="true" spellcheck="true">${d.bodyHtml || ''}</div>
  </div>

  <aside class="art-editor-side">
    <div class="card art-side-card">
      <div class="art-side-title">Draft</div>
      <label class="art-label">Status</label>
      <select class="input" id="art-status">
        ${['draft', 'review', 'published'].map(s => `<option value="${s}" ${(d.status || 'draft') === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
      </select>
      <div class="art-save-state" id="art-save-state">${art.saving ? 'Saving…' : 'Saved'}</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
        <button class="btn btn-outline btn-sm" data-action="art-copy">⎘ Copy article</button>
        <button class="btn btn-outline btn-sm" data-action="art-export">↓ Export HTML</button>
        <button class="btn btn-ghost btn-sm" data-action="art-regenerate" ${art.generating ? 'disabled' : ''}>
          ${art.generating ? '<span class="spinner"></span> Regenerating…' : '✦ Regenerate'}
        </button>
      </div>
    </div>

    ${d.sourceUrl ? `
    <div class="card art-side-card">
      <div class="art-side-title">Source</div>
      <div class="art-source-title" style="font-size:13px">${escHtml(d.sourceTitle || d.sourceUrl)}</div>
      <div class="art-source-meta">${escHtml(d.sourcePublication || '')}</div>
      <a class="art-source-link" href="${escHtml(d.sourceUrl)}" target="_blank" rel="noopener">Open original ↗</a>
    </div>` : ''}

    ${d.angle ? `
    <div class="card art-side-card">
      <div class="art-side-title">Angle</div>
      <div class="art-side-body">${escHtml(d.angle)}</div>
      ${d.notes ? `<div class="art-side-title" style="margin-top:12px">Notes</div><div class="art-side-body">${escHtml(d.notes)}</div>` : ''}
    </div>` : ''}
  </aside>
</div>`;
}

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
    if (s) s.textContent = 'Saved';
    // Keep the drafts list truthful without a round trip.
    const i = art.drafts.findIndex(d => d.id === art.draft.id);
    if (i >= 0) art.drafts[i] = { ...art.draft }; else art.drafts.unshift({ ...art.draft });
  }, 1200);
}

// ── ACTIONS ───────────────────────────────────────────────────────────────────
async function articlesHandleAction(action, d) {
  switch (action) {
    case 'art-tab':
      art.tab = d.tab; render(); return true;

    case 'art-source-mode':
      art.sourceMode = d.mode; render(); return true;

    case 'art-pick-rss':
      await artExtract(d.url, false); return true;

    case 'art-reextract':
      await artExtract(art.source.url, true); return true;

    case 'art-clear-source':
      art.source = null; art.streamText = ''; render(); return true;

    case 'art-generate':
      await artGenerate(); return true;

    case 'art-regenerate': {
      const ok = await showConfirm({
        title: 'Regenerate this article?',
        message: 'The current draft text is replaced. Your angle, notes and prompt stay as they are.',
        confirmText: 'Regenerate',
        danger: true,
      });
      if (ok) { art.view = 'setup'; await artGenerate(); }
      return true;
    }

    case 'art-back-to-setup':
      art.view = 'setup'; art.tab = 'write'; render(); return true;

    case 'art-exec':
      artExec(d.cmd); return true;

    case 'art-copy': {
      const ed = document.getElementById('art-editor');
      const title = document.getElementById('art-title')?.value || '';
      const html = `<h1>${escHtml(title)}</h1>${ed ? ed.innerHTML : ''}`;
      const text = `${title}\n\n${ed ? ed.innerText : ''}`;
      writeRichClipboard(html, text);
      toast('Article copied — paste anywhere with formatting intact', 'success');
      return true;
    }

    case 'art-export': {
      const ed = document.getElementById('art-editor');
      const title = document.getElementById('art-title')?.value || 'article';
      const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title></head><body><article><h1>${escHtml(title)}</h1>${ed ? ed.innerHTML : ''}</article></body></html>`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
      a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) || 'article'}.html`;
      a.click();
      URL.revokeObjectURL(a.href);
      return true;
    }

    case 'art-open-draft': {
      const draft = art.drafts.find(x => x.id === d.id);
      if (!draft) return true;
      art.draft = { ...draft };
      art.view = 'editor';
      render();
      return true;
    }

    case 'art-duplicate-draft': {
      const src = art.drafts.find(x => x.id === d.id);
      if (!src) return true;
      const copy = { ...src, id: null, title: `${src.title} (copy)`, status: 'draft' };
      await artPersistDraft(copy);
      art.drafts.unshift(copy);
      render();
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
      if (!ok) return true;
      await artDeleteDraftRow(d.id);
      art.drafts = art.drafts.filter(x => x.id !== d.id);
      if (art.draft?.id === d.id) { art.draft = null; art.view = 'setup'; }
      render();
      toast('Article deleted', 'success');
      return true;
    }

    case 'art-new-prompt':
      showArticlePromptModal(null, d.starter === '1'); return true;

    case 'art-edit-prompt':
      showArticlePromptModal(art.prompts.find(p => p.id === d.id)); return true;

    case 'art-save-prompt': {
      const name = document.getElementById('art-p-name').value.trim();
      const body = document.getElementById('art-p-body').value;
      if (!name) { toast('Give the prompt a name', 'warn'); return true; }
      if (!body.trim()) { toast('The prompt body is empty', 'warn'); return true; }
      const p = {
        id: d.id || '',
        name,
        description: document.getElementById('art-p-desc').value.trim(),
        prompt: body,
        isDefault: document.getElementById('art-p-default').checked,
        mode: 'news',
      };
      const id = await artSavePrompt(p);
      if (!id) return true;
      p.id = id;
      const i = art.prompts.findIndex(x => x.id === id);
      if (i >= 0) art.prompts[i] = p; else art.prompts.push(p);
      if (p.isDefault) await artApplyDefault(id);
      if (!art.promptId) art.promptId = id;
      closeModal();
      render();
      toast('Prompt saved', 'success');
      return true;
    }

    case 'art-duplicate-prompt': {
      const src = art.prompts.find(p => p.id === d.id);
      if (!src) return true;
      const copy = { ...src, id: '', name: `${src.name} (copy)`, isDefault: false };
      const id = await artSavePrompt(copy);
      if (id) { copy.id = id; art.prompts.push(copy); render(); toast('Prompt duplicated', 'success'); }
      return true;
    }

    case 'art-set-default-prompt':
      await artApplyDefault(d.id); render(); toast('Default prompt updated', 'success'); return true;

    case 'art-delete-prompt': {
      const target = art.prompts.find(p => p.id === d.id);
      const ok = await showConfirm({
        title: 'Delete this prompt?',
        message: `"${target?.name || 'Untitled'}" will be removed from your library. Articles already written with it are unaffected.`,
        danger: true,
      });
      if (!ok) return true;
      await artDeletePromptRow(d.id);
      art.prompts = art.prompts.filter(p => p.id !== d.id);
      if (art.promptId === d.id) art.promptId = (art.prompts.find(p => p.isDefault) || art.prompts[0] || {}).id || '';
      render();
      toast('Prompt deleted', 'success');
      return true;
    }
  }
  return false;
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

function articlesHandleInput(t) {
  if (t.id === 'art-angle')  { art.angle = t.value; artToggleGenerate(); return true; }
  if (t.id === 'art-notes')  { art.notes = t.value; return true; }
  if (t.id === 'art-url-input') { art.urlInput = t.value; return true; }
  if (t.id === 'art-prompt-select') { art.promptId = t.value; return true; }
  if (t.id === 'art-title')  {
    if (art.draft) { art.draft.title = t.value; artScheduleSave(); }
    return true;
  }
  if (t.id === 'art-status') {
    if (art.draft) { art.draft.status = t.value; artScheduleSave(); }
    return true;
  }
  return false;
}

// Enabling the button in place beats a full re-render on every keystroke — a
// re-render would blow away the cursor position in the angle box.
function artToggleGenerate() {
  const btn = document.querySelector('[data-action="art-generate"]');
  if (btn) btn.disabled = !(art.source && art.angle.trim()) || art.generating;
}

function articlesHandleSubmit(form) {
  if (form.id !== 'art-url-form') return false;
  artExtract(document.getElementById('art-url-input').value.trim(), false);
  return true;
}

// ── EXTRACTION ────────────────────────────────────────────────────────────────
async function artExtract(url, refresh) {
  if (!url) { toast('Paste an article URL first', 'warn'); return; }
  art.extracting = true;
  art.urlInput = url;
  render();
  try {
    const res = await fetch('/api/articles/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, refresh }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Extraction failed');
    art.source = data.source;
    art.streamText = '';
    toast(data.cached ? 'Loaded from cache — no refetch, no cost' : `Extracted ${data.source.wordCount} words`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    art.extracting = false;
    render();
  }
}

// ── GENERATION ────────────────────────────────────────────────────────────────
async function artGenerate() {
  if (!art.source || !art.angle.trim() || art.generating) return;
  art.generating = true;
  art.streamText = '';
  art.progress = 'Reading the source…';
  render();

  const body = {
    url: art.source.url,
    angle: art.angle,
    notes: art.notes,
    promptId: art.promptId || '',
    mode: 'news',
    stream: true,
    userId: state.user?.id || '',
    authToken: await getAuthToken(),
  };
  // Only installs without a prompt store send prompt text over the wire.
  if (!artHasDB() && art.promptId) {
    body.promptText = (art.prompts.find(p => p.id === art.promptId) || {}).prompt || '';
  }

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

    const streamEl = () => document.getElementById('art-stream');
    let mock = false;
    await readSSEStream(res, {
      onData: (data) => {
        if (data.mock) mock = true;
        if (data.delta) {
          art.streamText += data.delta;
          const el = streamEl();
          if (el) { el.textContent = art.streamText; el.scrollTop = el.scrollHeight; }
        } else if (data.progress) {
          art.progress = researchStatusLabel(data.progress);
        }
      },
    });

    const { title, body: mdBody } = artSplitHeadline(art.streamText);
    art.draft = {
      id: null,
      title: title || art.source.title || 'Untitled Article',
      bodyHtml: artMdToHtml(mdBody),
      status: 'draft',
      angle: art.angle,
      notes: art.notes,
      mode: 'news',
      sourceUrl: art.source.url,
      sourceTitle: art.source.title,
      sourcePublication: art.source.publication,
      promptId: art.promptId,
      updatedAt: new Date().toISOString(),
    };
    await artPersistDraft(art.draft);
    art.drafts.unshift({ ...art.draft });
    art.view = 'editor';
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
    art.progress = '';
    render();
  }
}

// Re-bind the editor after every render that puts it on screen. app.js's render()
// replaces innerHTML wholesale, so the listeners have to be reattached.
function articlesAfterRender() {
  if (art.view === 'editor') artBindEditor();
}
