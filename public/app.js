/* ════════════════════════════════════════════════════════════════════════════
   Curanta — Frontend Application
════════════════════════════════════════════════════════════════════════════ */

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  view: 'landing',         // 'landing' | 'dashboard' | 'builder'
  user: null,
  newsletter: {
    title: 'Untitled Newsletter',
    subject: '',
    previewText: '',
    subjectLines: [],
    sections: { topStories: [], leadStory: [], quickHits: [], cta: [] },
    topStoriesContent: '',
    prompts: { topStories: '', leadStory: '', quickHits: '', cta: '' },
    sectionOrder: ['topStories', 'leadStory', 'quickHits', 'cta'],
    sectionMeta: {
      topStories: { name: "Today's Briefing", type: 'briefing' },
      leadStory:  { name: 'Lead Story',       type: 'lead' },
      quickHits:  { name: 'Quick Hits',       type: 'hits' },
      cta:        { name: 'Sponsor / CTA',    type: 'cta' },
    },
  },
  sources: [],             // { id, feedUrl, title, type, articles:[], collapsed:false }
  tone: 'punchy-executive',
  brandVoice: '',
  brandVoiceSamples: '',
  audienceAvatar: '',
  defaultPrompts: {        // pre-fill section prompts on every new newsletter
    briefing: '',
    lead: '',
    hits: '',
    cta: '',
    generic: '',
  },
  settingsTab: 'content',  // 'content' | 'appearance' | 'api'
  design: {
    primaryColor: '#6366f1',
    spacing: 2,
    borderRadius: 10,
    device: 'desktop',
    darkMode: true,
  },
  rightPanel: 'ai',       // 'ai' | 'design' | 'team'
  aiLoading: false,
  aiHistory: [],
  aiResult: null,
  subjectSourceSection: 'leadStory', // which section drives subject/preview generation ('' = whole issue)
  subjectPrompt: '', // optional custom instructions for subject/preview generation
  sourcesPubScoped: null, // null = unknown, true = DB has publication_id column, false = use localStorage buckets
  newslettersPubScoped: null, // same, for the newsletters table
  teamComments: [],
  approvalStatus: 'draft', // 'draft' | 'review' | 'approved'
  versions: [],
  draggedArticleId: null,
  draggedStory: null,
  hasAI: false,
  hasStripe: false,
  hasBeehiiv: false,
  defaultPublicationName: 'Default',
  subscriptionStatus: 'inactive', // 'inactive' | 'trialing' | 'active' | 'past_due'
  subscriptionPlan: 'pro',        // 'pro' ($49) | 'multi' ($99, 3 pubs)
  grandfathered: false,
  generationsThisMonth: 0,
  trialEndsAt: null,
  voiceUrls: [],
  voiceUrlLoading: false,
  _expandedPrompts: {},     // transient: which section prompt boxes are open
  // Multi-publication
  publications: [],          // loaded from DB for grandfathered users
  currentPublicationId: null, // null = default (user_settings), uuid = publications table row
  // Persistence
  newsletterId: null,       // UUID of the current newsletter in Supabase
  saving: false,
  dbNewsletters: [],        // loaded from Supabase for the dashboard
};

// Pending checkout plan — survives page reloads via sessionStorage (needed when Supabase
// email confirmation causes a page reload before onAuthStateChange fires).
let _pendingCheckoutPlan = sessionStorage.getItem('_pendingPlan') || null;
let _justSignedUp = false;       // true for one auth cycle after a new account is created

function setPendingPlan(plan) {
  _pendingCheckoutPlan = plan;
  if (plan) sessionStorage.setItem('_pendingPlan', plan);
  else sessionStorage.removeItem('_pendingPlan');
}
function consumePendingPlan() {
  const p = _pendingCheckoutPlan;
  _pendingCheckoutPlan = null;
  sessionStorage.removeItem('_pendingPlan');
  return p;
}

// ── CONFIG & AUTH ─────────────────────────────────────────────────────────────
let cfg = { supabaseUrl: '', supabaseAnonKey: '', hasAI: false };
let sb = null;

// ── LOCAL STORAGE HELPERS ─────────────────────────────────────────────────────
const LS_SOURCES_KEY = 'lwai_sources'; // legacy global key (pre per-publication)

// Sources are bucketed per publication so they never bleed across newsletters,
// even when the DB lacks the publication_id column. Default = 'default'.
function sourcesLSKey() {
  return `lwai_sources_${state.currentPublicationId || 'default'}`;
}

function saveSourcesListLocally(list) {
  try {
    const slim = (list || []).map(s => ({ feedUrl: s.feedUrl, title: s.title, type: s.type }));
    localStorage.setItem(sourcesLSKey(), JSON.stringify(slim));
  } catch (e) { /* storage full or unavailable */ }
}

function saveSourcesLocally() {
  saveSourcesListLocally(state.sources);
}

function loadSourcesLocally() {
  try {
    let raw = localStorage.getItem(sourcesLSKey());
    // One-time migration: fold the old single global bucket into Default's bucket.
    if (!raw && !state.currentPublicationId) {
      const legacy = localStorage.getItem(LS_SOURCES_KEY);
      if (legacy) { localStorage.setItem(sourcesLSKey(), legacy); raw = legacy; }
    }
    if (!raw) return [];
    return JSON.parse(raw); // returns [{feedUrl, title, type}, ...]
  } catch (e) { return []; }
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  // Restore theme preference before first render
  try {
    const saved = localStorage.getItem('lwai_theme');
    if (saved === 'light') {
      state.design.darkMode = false;
      document.documentElement.setAttribute('data-theme', 'light');
    }
    const savedPubName = localStorage.getItem('lwai_default_pub_name');
    if (savedPubName) state.defaultPublicationName = savedPubName;
  } catch(e) {}

  try {
    const res = await fetch('/api/config');
    cfg = await res.json();
    state.hasAI = cfg.hasAI;
    state.hasStripe = cfg.hasStripe;
    state.hasBeehiiv = cfg.hasBeehiiv;
    if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        state.user = session.user;
        state.view = 'dashboard';
        await loadUserSettings();
      }
      sb.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN') {
          state.user = session.user;
          await loadUserSettings();
          const isNew = _justSignedUp;
          _justSignedUp = false;
          const specificPlan = consumePendingPlan(); // reads + clears both variable and sessionStorage
          if (isNew && specificPlan) {
            // New account + plan already chosen upfront — skip picker, go straight to Stripe
            showAccountCreatedScreen(session.user.email);
            await startCheckoutForUser(session.user, specificPlan);
          } else if (isNew) {
            // New account with no plan chosen — show plan picker
            showAccountCreatedThenPicker(session.user);
          } else if (specificPlan) {
            // Returning user clicked a specific plan CTA — go straight there
            closeModal();
            toast('Signed in! Taking you to checkout…', 'success');
            await startCheckoutForUser(session.user, specificPlan);
          } else {
            navigate('dashboard');
            toast('Signed in', 'success');
          }
        } else if (event === 'SIGNED_OUT') {
          state.user = null;
          navigate('landing');
        }
      });
    } else {
      // No Supabase — restore sources from localStorage so feeds survive page reloads
      const saved = loadSourcesLocally();
      if (saved.length) {
        state.sources = saved.map(s => ({
          id: uid(),
          feedUrl: s.feedUrl,
          title: s.title,
          type: s.type || 'rss',
          articles: [],
          collapsed: false,
        }));
        // Re-fetch articles for each restored feed in the background
        state.sources.forEach(src => {
          fetch(`/api/ingest?url=${encodeURIComponent(src.feedUrl)}&quick=1`)
            .then(r => r.json())
            .then(data => { src.articles = data.articles || []; refreshSourceSidebar(); })
            .catch(() => {});
        });
      }
    }
  } catch (e) { console.warn('Init error:', e); }

  // Restore the builder if that's where the user was before refreshing
  try {
    if (localStorage.getItem('lwai_open_view') === 'builder') {
      const openId = localStorage.getItem('lwai_open_nl');
      if (openId && openId !== 'new' && sb && state.user) {
        const ok = await loadBuilderData(openId);
        if (ok) { state.view = 'builder'; autoFetchSources(); }
        else { localStorage.removeItem('lwai_open_view'); }
      } else {
        const draft = readBuilderDraft('new');
        if (draft) {
          resetNewsletter();
          applyBuilderDraft(draft);
          state.view = 'builder';
          if (sb && state.user) { state.sources = await loadSourcesFromDB(); autoFetchSources(); }
        }
      }
    }
  } catch (e) { console.warn('Builder restore error:', e); }

  render();

  // Handle Stripe redirect params
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('checkout') === 'success') {
    history.replaceState(null, '', window.location.pathname);
    setTimeout(async () => {
      if (sb && state.user) await loadUserSettings();
      render(); // now on dashboard, logged in
      showWelcomeModal();
    }, 800);
  } else if (urlParams.get('checkout') === 'cancelled') {
    history.replaceState(null, '', window.location.pathname);
    toast('Checkout cancelled — you can subscribe anytime from Settings.', 'info');
  }
  if (urlParams.get('reset') === 'true') {
    history.replaceState(null, '', window.location.pathname);
    // Supabase sets the session from the reset token in the URL hash automatically
    setTimeout(() => showUpdatePasswordModal(), 300);
  }
}

// ── ROUTER ────────────────────────────────────────────────────────────────────
async function navigate(view, params = {}) {
  state.view = view;

  if (view === 'dashboard' && sb && state.user) {
    state.dbNewsletters = await loadNewslettersFromDB();
  }
  if (view === 'sources' && sb && state.user) {
    state.sources = await loadSourcesFromDB();
    autoFetchSources();
  }

  if (view === 'builder') {
    if (params.id && params.id !== state.newsletterId) {
      await loadBuilderData(params.id);
    } else if (!params.id) {
      clearBuilderDraft('new'); // discard any stale unsaved draft so we start clean from the template
      resetNewsletter();
      cacheBuilderDraft();      // snapshot the fresh template newsletter as the 'new' draft
      if (sb && state.user) state.sources = await loadSourcesFromDB();
    }
    autoFetchSources();
  }

  // Remember where the user is so a refresh can return them here
  try {
    if (view === 'builder') {
      localStorage.setItem('lwai_open_view', 'builder');
      localStorage.setItem('lwai_open_nl', state.newsletterId || 'new');
    } else {
      localStorage.removeItem('lwai_open_view');
    }
  } catch (e) {}

  render();
  window.scrollTo(0, 0);
}

function render() {
  const root = document.getElementById('app-root');
  if (!root) return;
  if (state.view === 'landing') root.innerHTML = renderLanding();
  else if (state.view === 'dashboard') root.innerHTML = renderDashboard();
  else if (state.view === 'builder') root.innerHTML = renderBuilder();
  else if (state.view === 'sources') root.innerHTML = renderSourcesPage();
  else if (state.view === 'settings') root.innerHTML = renderSettingsPage();
  else if (state.view === 'subscription') root.innerHTML = renderSubscriptionPage();
  else if (state.view === 'publications') root.innerHTML = renderPublicationsPage();
  attachEvents();
  if (state.view === 'builder') { applyDesignSettings(); setupDropZones(); }
}

// ── EVENT DISPATCHER ──────────────────────────────────────────────────────────
function attachEvents() {
  // Click delegation
  document.removeEventListener('click', handleClick);
  document.addEventListener('click', handleClick);
  document.removeEventListener('submit', handleSubmit);
  document.addEventListener('submit', handleSubmit);
  document.removeEventListener('input', handleInput);
  document.addEventListener('input', handleInput);
  document.removeEventListener('keydown', handleKeydown);
  document.addEventListener('keydown', handleKeydown);
}

function handleClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.preventDefault();
  const { action } = el.dataset;
  const d = el.dataset;

  switch (action) {
    case 'navigate':        navigate(d.view); break;
    case 'book-demo':       window.open('https://calendly.com/noahrin/60-minute-tutoring-clone', '_blank'); break;
    case 'show-pub-upgrade': document.querySelector('.pub-enterprise-card')?.scrollIntoView({behavior:'smooth',block:'center'}); document.querySelector('.pub-enterprise-card')?.classList.add('pub-enterprise-card-highlight'); setTimeout(()=>document.querySelector('.pub-enterprise-card')?.classList.remove('pub-enterprise-card-highlight'),1800); break;
    case 'new-publication':    showNewPublicationModal(); break;
    case 'switch-publication': switchPublication(d.id || null); break;
    case 'delete-publication': deletePublication(d.id); break;
    case 'rename-publication': renamePublication(d.id); break;
    case 'rename-default-publication': renameDefaultPublication(); break;
    case 'open-builder':    navigate('builder'); break;
    case 'open-newsletter': navigate('builder', { id: d.id }); break;
    case 'show-auth':       showAuthModal(d.tab || 'login'); break;
    case 'forgot-password': showForgotPasswordForm(); break;
    case 'use-subject':     useSubjectLine(d.line); break;
    case 'close-modal':     closeModal(); break;
    case 'auth-tab':        switchAuthTab(d.tab); break;
    case 'logout':          handleLogout(); break;
    case 'manage-billing':  manageBilling(); break;
    case 'subscribe-multi': startCheckout('multi'); break;
    case 'start-trial':     scrollToPricing(); break;
    case 'pick-plan':       pickPlan(d.plan);       break;
    case 'save-section-layout': {
      const raw = document.getElementById('sections-setup-input')?.value || '';
      const sections = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0)
        .map(name => ({
          id: 'custom_' + uid(),
          name,
          type: inferSectionType(name), // best-guess; user can adjust the dropdown after
        }));
      if (!sections.length) { toast('Enter at least one section name', 'warn'); break; }
      setUserSections(sections);
      toast(`Template saved — new newsletters will start with these ${sections.length} sections`, 'success');
      break;
    }
    case 'add-section-default': addSectionDefault(); break;
    case 'remove-section-default': removeSectionDefault(d.id); break;
    case 'import-builder-sections': {
      const secs = state.newsletter.sectionOrder
        .map(id => ({ id, name: state.newsletter.sectionMeta[id]?.name || id, type: state.newsletter.sectionMeta[id]?.type || 'generic' }));
      if (!secs.length) { toast('No sections in current newsletter', 'warn'); break; }
      setUserSections(secs);
      toast('Imported from builder — these are now your template', 'success');
      break;
    }
    case 'reset-section-layout': {
      if (!confirm('Clear your section template? New newsletters will fall back to the standard layout.')) break;
      if (state.defaultPrompts) { delete state.defaultPrompts._layout; delete state.defaultPrompts._sections; }
      scheduleSettingsSave();
      render();
      toast('Template reset to standard', 'success');
      break;
    }
    case 'toggle-feed':     toggleFeed(d.feedId); break;
    case 'remove-feed':     removeFeed(d.feedId); break;
    case 'remove-article':  removeArticle(d.feedId, d.articleId); break;
    case 'add-to-section':  addToSection(d.articleId, d.section || 'leadStory'); break;
    case 'remove-from-section': removeFromSection(d.articleId, d.section); break;
    case 'apply-prompt':      applyPrompt(d.section); break;
    case 'generate-lead-story': generateLeadStory(d.section); break;
    case 'remove-lead-source':  removeLeadSource(d.section, d.articleId); break;
    case 'generate-top-stories': generateTopStories(); break;
    case 'briefing-prompt-from-examples': showBriefingPromptModal(); break;
    case 'generate-briefing-prompt': generateBriefingPrompt(); break;
    case 'remove-top-story':  removeTopStory(d.articleId); break;
    case 'clear-top-stories': state.newsletter.topStoriesContent = ''; refreshTopStoriesSection(); scheduleSave(); break;
    case 'edit-top-stories':  editTopStories(); break;
    case 'rewrite-story':   rewriteStory(d.articleId, d.section); break;
    case 'shorten-story':   shortenStory(d.articleId, d.section); break;
    case 'duplicate-story': duplicateStory(d.articleId, d.section); break;
    case 'edit-story':      startEditStory(d.articleId, d.section); break;
    case 'save-story-edit': saveStoryEdit(d.articleId, d.section); break;
    case 'cancel-story-edit': cancelStoryEdit(d.articleId, d.section); break;
    case 'insert-image':    showImageModal(d.articleId, d.section); break;
    case 'duplicate-newsletter': duplicateNewsletter(d.id); break;
    case 'delete-newsletter':   deleteNewsletter(d.id); break;
    case 'switch-panel':    switchPanel(d.panel); break;
    case 'select-tone':     selectTone(d.tone); break;
    case 'ai-rewrite':      aiRewriteSelection(); break;
    case 'ai-summarize':    aiSummarize(); break;
    case 'ai-hooks':        aiHooks(); break;
    case 'ai-cta':          aiCTA(); break;
    case 'generate-subjects': generateSubjectLines(); break;
    case 'generate-preview':  generatePreviewText(); break;
    case 'generate-brand-voice': generateBrandVoice(); break;
    case 'toggle-theme':    toggleTheme(); break;
    case 'set-device':      state.design.device = d.device; updateDesignPanel(); break;
    case 'show-preview':    showPreview(); break;
    case 'close-preview':   closePreview(); break;
    case 'copy-html':       copyHTML(); break;
    case 'export-json':     exportJSON(); break;
    case 'copy-beehiiv-section': copyBeehiivSection(d.section); break;
    case 'beehiiv-paste-modal': showBeehiivPasteModal(); break;
    case 'mock-sync':       d.platform === 'beehiiv' ? publishToBeehiiv() : mockSync(d.platform); break;
    case 'request-review':  setApproval('review'); break;
    case 'approve':         setApproval('approved'); break;
    case 'add-comment':     addComment(); break;
    case 'toggle-voice-panel': toggleVoicePanel(); break;
    case 'remove-voice-url':  removeVoiceURL(parseInt(d.idx)); break;
    case 'clear-brand-voice': state.brandVoice = ''; state.brandVoiceSamples = ''; state.voiceUrls = []; scheduleSettingsSave(); render(); break;
    case 'show-add-section':  showAddSectionModal(); break;
    case 'save-section-default':  saveSectionLayoutAsDefault(); break;
    case 'clear-section-default': clearSectionLayoutDefault(); break;
    case 'rename-section':    inlineRenameSection(d.sectionId); break;
    case 'remove-section':    removeSection(d.sectionId); break;
    case 'confirm-add-section': confirmAddSection(); break;
    case 'fetch-briefing-examples': fetchBriefingExamples(); break;
    case 'settings-tab': switchSettingsTab(d.tab); break;
    case 'toggle-section-prompt': toggleSectionPrompt(d.sectionId); break;
  }
}

function handleSubmit(e) {
  const form = e.target;
  if (form.id === 'login-form')  { e.preventDefault(); submitLogin(e); }
  else if (form.id === 'signup-form') { e.preventDefault(); submitSignup(e); }
  else if (form.id === 'source-form') { e.preventDefault(); submitAddSource(form); }
  else if (form.id === 'comment-form') { e.preventDefault(); submitComment(form); }
  else if (form.id === 'voice-url-form') { e.preventDefault(); fetchVoiceURL(form); }
}

function handleInput(e) {
  const t = e.target;
  if (t.matches('.newsletter-title-input')) { state.newsletter.title = t.value; scheduleSave(); }
  else if (t.matches('#subject-input')) { state.newsletter.subject = t.value; scheduleSave(); }
  else if (t.matches('#preview-input')) { state.newsletter.previewText = t.value; scheduleSave(); }
  else if (t.matches('.section-prompt')) { state.newsletter.prompts[t.dataset.section] = t.value; scheduleSave(); }
  else if (t.matches('#spacing-slider')) { state.design.spacing = parseInt(t.value); document.querySelector('.spacing-val') && (document.querySelector('.spacing-val').textContent = t.value); applyDesignSettings(); }
  else if (t.matches('#radius-slider')) { state.design.borderRadius = parseInt(t.value); document.querySelector('.radius-val') && (document.querySelector('.radius-val').textContent = t.value + 'px'); applyDesignSettings(); }
  else if (t.matches('#color-picker')) { state.design.primaryColor = t.value; scheduleSettingsSave(); applyDesignSettings(); }
  else if (t.matches('#brand-voice-samples')) state.brandVoiceSamples = t.value;
  else if (t.matches('#audience-avatar')) { state.audienceAvatar = t.value; scheduleSettingsSave(); }
  else if (t.matches('.default-prompt-input')) {
    const key = t.dataset.type;
    if (!state.defaultPrompts) state.defaultPrompts = {};
    state.defaultPrompts[key] = t.value;
    scheduleSettingsSave();
  }
  else if (t.matches('.story-edit-textarea')) {
    const article = state.newsletter.sections[t.dataset.section]?.find(a => a.id === t.dataset.articleId);
    if (article) article._editDraft = t.value;
  }
}

function handleKeydown(e) {
  if (e.key === 'Escape') {
    closeModal(); closePreview();
    // Cancel any open story edits
    if (e.target.matches('.story-edit-textarea')) {
      cancelStoryEdit(e.target.dataset.articleId, e.target.dataset.section);
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target.matches('.story-edit-textarea')) {
    e.preventDefault();
    saveStoryEdit(e.target.dataset.articleId, e.target.dataset.section);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'p' && state.view === 'builder') { e.preventDefault(); showPreview(); }
}

// ── LOGO SVG (inline, adapts to light/dark via CSS vars) ─────────────────────
function logoSVG(size = 32) {
  const starScale = size / 44;
  // Four-pointed star path, originally fitted to 44×44
  const star = `M22 2 L26.2 17.8 L42 22 L26.2 26.2 L22 42 L17.8 26.2 L2 22 L17.8 17.8 Z`;
  const textSize = size * 0.65;
  const gap = size + 10;
  const baseline = size * 0.72;
  return `<svg viewBox="0 0 ${gap + textSize * 4.4} ${size}" height="${size}" style="display:block;overflow:visible" aria-label="Curanta">
    <g transform="scale(${starScale})">
      <path d="${star}" fill="var(--accent)"/>
    </g>
    <text x="${gap}" y="${baseline}"
      font-family="'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
      font-size="${textSize}" font-weight="800" letter-spacing="-0.04em"
      fill="var(--text-1)">Curanta</text>
  </svg>`;
}

function logoSVGWhite(size = 32) {
  const starScale = size / 44;
  const star = `M22 2 L26.2 17.8 L42 22 L26.2 26.2 L22 42 L17.8 26.2 L2 22 L17.8 17.8 Z`;
  const textSize = size * 0.65;
  const gap = size + 10;
  const baseline = size * 0.72;
  return `<svg viewBox="0 0 ${gap + textSize * 4.4} ${size}" height="${size}" style="display:block;overflow:visible" aria-label="Curanta">
    <g transform="scale(${starScale})">
      <path d="${star}" fill="rgba(255,255,255,0.9)"/>
    </g>
    <text x="${gap}" y="${baseline}"
      font-family="'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
      font-size="${textSize}" font-weight="800" letter-spacing="-0.04em"
      fill="#ffffff">Curanta</text>
  </svg>`;
}

// ── LANDING PAGE ──────────────────────────────────────────────────────────────
function renderLanding() {
  return `
<div class="landing-page">
  <nav class="landing-nav">
    <a class="nav-logo" href="#" data-action="navigate" data-view="landing" style="text-decoration:none">${logoSVG(28)}</a>
    <div class="nav-links">
      <a class="nav-link" href="#features">Features</a>
      <a class="nav-link" href="#how">How it works</a>
      <a class="nav-link" href="#pricing">Pricing</a>
      <a class="nav-link" href="#integrations">Integrations</a>
    </div>
    <div class="nav-actions">
      <button class="btn btn-ghost" onclick="window.open('https://calendly.com/noahrin/60-minute-tutoring-clone','_blank');event.stopPropagation()">Book a demo</button>
      <button class="btn btn-ghost" data-action="show-auth" data-tab="login">Log in</button>
      <button class="btn btn-primary" data-action="start-trial">See plans & start free →</button>
    </div>
  </nav>

  <section class="hero">
    <div class="hero-eyebrow animate-in">✦ For newsletter creators who publish on a schedule</div>
    <h1 class="animate-in animate-in-d1">Your newsletter,<br>written in <span>15 minutes</span>.</h1>
    <p class="hero-sub animate-in animate-in-d2">Paste your RSS feeds. AI writes lead stories, quick hits, and subject lines in your voice. Export straight to Beehiiv, Mailchimp, or Kit.</p>
    <div class="hero-actions animate-in animate-in-d3">
      <button class="btn btn-primary" data-action="start-trial">Try free for 7 days →</button>
      <button class="btn btn-outline" onclick="document.getElementById('how').scrollIntoView({behavior:'smooth'})">See how it works</button>
    </div>
    <p class="hero-note animate-in animate-in-d4">7-day free trial · No charge until day 8 · Cancel anytime</p>

    <div class="hero-visual-wrap">
      <div class="demo-browser">
        <div class="demo-chrome">
          <div class="demo-dots"><span></span><span></span><span></span></div>
          <div class="demo-url-bar">curanta.app/builder</div>
        </div>
        <div class="demo-content">
          <div class="demo-src">
            <div class="demo-src-header">Sources</div>
            <div class="demo-feed">
              <div class="demo-feed-row"><span class="demo-feed-dot"></span> TechCrunch <span class="demo-feed-count">12</span></div>
              <div class="demo-acard active">
                <div class="demo-acard-title">Apple's AI Push Faces New Regulatory Hurdles</div>
                <div class="demo-acard-meta">TechCrunch · 2h ago</div>
              </div>
              <div class="demo-acard">
                <div class="demo-acard-title">The Chip Race Heats Up: NVIDIA vs. Intel</div>
                <div class="demo-acard-meta">TechCrunch · 4h ago</div>
              </div>
              <div class="demo-acard">
                <div class="demo-acard-title">Why Startups Are Fleeing SF for the Gulf</div>
                <div class="demo-acard-meta">TechCrunch · 6h ago</div>
              </div>
            </div>
            <div class="demo-feed" style="margin-top:8px">
              <div class="demo-feed-row"><span class="demo-feed-dot"></span> Reuters <span class="demo-feed-count">8</span></div>
            </div>
          </div>
          <div class="demo-editor">
            <div class="demo-section-tag">LEAD STORY</div>
            <div class="demo-story-card">
              <div class="demo-story-title">Apple's AI Push Faces New Regulatory Hurdles</div>
              <div class="demo-story-text">Apple's long-promised AI features are running into a regulatory wall — and the timeline is slipping.</div>
              <div class="demo-story-label">The details:</div>
              <div class="demo-story-text">Federal regulators opened a formal review last week, citing data-handling concerns with on-device AI processing.</div>
              <div class="demo-story-label">Why it matters:</div>
              <div class="demo-story-text">With 500M+ iPhones potentially affected, this isn't a minor compliance issue. It's a strategic inflection point.</div>
              <div class="demo-story-label">Real talk:</div>
              <div class="demo-story-text">Musk was right about one thing: the timeline promises are slipping. Again.</div>
              <div class="demo-action-strip">
                <span class="demo-chip primary">Rewrite ↺</span>
                <span class="demo-chip">Shorten</span>
                <span class="demo-chip">Hooks</span>
              </div>
            </div>
            <div class="demo-section-tag" style="margin-top:8px">QUICK HITS</div>
            <div style="display:flex;gap:6px">
              <div class="demo-story-card" style="flex:1;opacity:0.7">
                <div class="demo-story-text" style="font-size:9.5px">NVIDIA shares jump 8% on record data center demand...</div>
              </div>
              <div class="demo-story-card" style="flex:1;opacity:0.7">
                <div class="demo-story-text" style="font-size:9.5px">Startup funding hits 18-month low as VCs tighten belt...</div>
              </div>
            </div>
          </div>
          <div class="demo-ai">
            <div class="demo-ai-header">Generate</div>
            <div class="demo-tone-chip active">Punchy Executive</div>
            <div class="demo-tone-chip">Morning Brew</div>
            <div style="height:8px"></div>
            <div class="demo-ai-btn">↺ Rewrite Selection</div>
            <div class="demo-ai-btn">≡ Summarize 3 sentences</div>
            <div class="demo-ai-btn generating"><span class="demo-mini-spinner"></span> Generating subject lines...</div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <div class="social-strip">
    <div class="social-item"><strong>4 hrs → 15 min</strong> newsletter production time</div>
    <div class="social-item"><strong>Writes in your voice</strong> not generic AI copy</div>
    <div class="social-item"><strong>Works with</strong> Beehiiv, Mailchimp, Kit, Substack</div>
    <div class="social-item"><strong>7-day free trial</strong> no charge until day 8</div>
  </div>

  <section class="features-section" id="features">
    <div class="section-eyebrow">How it saves you time</div>
    <h2 class="section-title">Newsletter production used to take<br>half your day. Not anymore.</h2>
    <p class="section-sub">Every part of Curanta is built around one goal: getting you from blank page to scheduled send in under 20 minutes.</p>
    <div class="features-grid">
      <div class="feature-card animate-in">
        <div class="feature-icon">📡</div>
        <div class="feature-title">Your sources, instantly ready</div>
        <div class="feature-desc">Paste any RSS feed or article URL. Curanta fetches the full text and strips the junk — ads, nav, paywalls, audio widgets — so you only see the story.</div>
      </div>
      <div class="feature-card animate-in animate-in-d1">
        <div class="feature-icon">✍️</div>
        <div class="feature-title">AI that actually writes well</div>
        <div class="feature-desc">Not generic AI slop. Lead stories, quick hits, subject lines, and CTAs — written in your tone, for your audience, from your source material.</div>
      </div>
      <div class="feature-card animate-in animate-in-d2">
        <div class="feature-icon">🎙️</div>
        <div class="feature-title">Sounds exactly like you</div>
        <div class="feature-desc">Paste your newsletter URL. Curanta reads your past issues and builds an AI writer that matches your voice — your rhythm, your phrases, your style.</div>
      </div>
      <div class="feature-card animate-in animate-in-d3">
        <div class="feature-icon">🎛️</div>
        <div class="feature-title">Drag, drop, done</div>
        <div class="feature-desc">Drag articles into your sections. Hit generate. Edit if you want. The whole issue is written before your second cup of coffee.</div>
      </div>
      <div class="feature-card animate-in animate-in-d4">
        <div class="feature-icon">🎯</div>
        <div class="feature-title">Knows your reader</div>
        <div class="feature-desc">Tell Curanta who reads your newsletter once. Every generation after that is calibrated for them — what to emphasize, what to skip, what to explain.</div>
      </div>
      <div class="feature-card animate-in animate-in-d5">
        <div class="feature-icon">📋</div>
        <div class="feature-title">Publish anywhere, instantly</div>
        <div class="feature-desc">One-click HTML export. Paste straight into Beehiiv, Mailchimp, Kit, or Substack. No reformatting. No copy-paste nightmares. Just send.</div>
      </div>
    </div>
  </section>

  <section class="testimonials-section">
    <div class="section-eyebrow">Who it's for</div>
    <h2 class="section-title">Made for creators who publish on a deadline</h2>
    <div style="max-width:800px;margin:0 auto;padding:0 20px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;text-align:left">
        <div style="background:var(--bg-2);border:1px solid var(--border-md);border-radius:var(--r-lg);padding:24px">
          <div style="font-size:22px;margin-bottom:10px">📰</div>
          <div style="font-weight:700;margin-bottom:6px;font-size:15px">Solo newsletter creators</div>
          <div style="color:var(--text-2);font-size:13px;line-height:1.6">You write, curate, and send every issue alone. Curanta compresses production from a half-day to 15 minutes.</div>
        </div>
        <div style="background:var(--bg-2);border:1px solid var(--border-md);border-radius:var(--r-lg);padding:24px">
          <div style="font-size:22px;margin-bottom:10px">📡</div>
          <div style="font-weight:700;margin-bottom:6px;font-size:15px">Media brands & publishers</div>
          <div style="color:var(--text-2);font-size:13px;line-height:1.6">Multiple newsletters, multiple brands. Curanta Studio keeps each publication's voice separate and consistent.</div>
        </div>
        <div style="background:var(--bg-2);border:1px solid var(--border-md);border-radius:var(--r-lg);padding:24px">
          <div style="font-size:22px;margin-bottom:10px">🏛️</div>
          <div style="font-weight:700;margin-bottom:6px;font-size:15px">Political & advocacy teams</div>
          <div style="color:var(--text-2);font-size:13px;line-height:1.6">News moves fast. Curanta turns breaking coverage into a polished, on-brand send in minutes — not hours.</div>
        </div>
      </div>
    </div>
  </section>

  <section class="how-section" id="how">
    <div class="how-inner">
      <div class="section-eyebrow">How it works</div>
      <h2 class="section-title">From blank page to scheduled send<br>in under 20 minutes</h2>
      <div class="how-steps">
        <div class="how-step">
          <div class="how-number">1</div>
          <h3>Add your sources <span style="font-size:13px;font-weight:400;color:var(--text-3)">(~2 min)</span></h3>
          <p>Paste RSS feeds or article URLs. Curanta pulls full text and strips everything that isn't the story — ads, nav, paywalls, audio players.</p>
        </div>
        <div class="how-step">
          <div class="how-number">2</div>
          <h3>Drag in, hit generate <span style="font-size:13px;font-weight:400;color:var(--text-3)">(~5 min)</span></h3>
          <p>Drag articles into your Lead Story, Quick Hits, or Sponsor sections. Click generate. AI writes everything in your voice — lead copy, summaries, subject lines.</p>
        </div>
        <div class="how-step">
          <div class="how-number">3</div>
          <h3>Review and send <span style="font-size:13px;font-weight:400;color:var(--text-3)">(~8 min)</span></h3>
          <p>Tweak anything you want, then export clean HTML and paste it straight into Beehiiv, Mailchimp, Kit, or Substack. Done.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="integrations-section" id="integrations">
    <div class="section-eyebrow">Integrations</div>
    <h2 class="section-title">Works with your stack</h2>
    <p class="section-sub" style="margin:0 auto 0">Ingest from anywhere. Publish everywhere.</p>
    <div class="integrations-grid">
      <div class="integration-chip"><span class="integration-icon">📰</span> Any RSS Feed</div>
      <div class="integration-chip"><span class="integration-icon">🔗</span> Any Article URL</div>
      <div class="integration-chip"><span class="integration-icon">🐝</span> Beehiiv</div>
      <div class="integration-chip"><span class="integration-icon">📧</span> Mailchimp</div>
      <div class="integration-chip"><span class="integration-icon">💌</span> Kit (ConvertKit)</div>
      <div class="integration-chip"><span class="integration-icon">📝</span> Substack Export</div>
      <div class="integration-chip"><span class="integration-icon">🌐</span> WordPress</div>
      <div class="integration-chip"><span class="integration-icon">📋</span> Copy HTML</div>
    </div>
  </section>

  <section class="pricing-section" id="pricing">
    <div class="section-eyebrow">Pricing</div>
    <h2 class="section-title">Start free. Stay only if it saves you time.</h2>
    <p class="section-sub" style="margin:0 auto 16px">7-day free trial on every plan. No charge until day 8. Cancel anytime in one click.</p>
    <div class="pricing-value-bar">
      Most newsletter editors spend <strong>4–6 hours per issue</strong>. Curanta users average <strong>under 20 minutes</strong>.
      At $49/mo, that's about <strong>$1.50 per hour of your time back</strong> — every single week.
    </div>

    <div class="pricing-grid">

      <!-- Pro -->
      <div class="pricing-card">
        <div>
          <div class="pricing-tier">Curanta Pro</div>
          <div class="pricing-price"><span class="amount">$49</span><span class="period">/mo</span></div>
          <div class="pricing-trial-badge">✦ 7-day free trial included</div>
          <div class="pricing-desc">For creators who ship on a schedule and can't afford a slow week.</div>
        </div>
        <div class="pricing-features">
          <div class="pricing-feature"><strong>500 AI generations/month</strong></div>
          <div class="pricing-feature">1 publication</div>
          <div class="pricing-feature">Unlimited newsletters & drafts</div>
          <div class="pricing-feature">Unlimited RSS sources</div>
          <div class="pricing-feature">Brand voice & audience avatar</div>
          <div class="pricing-feature">Section prompt defaults</div>
          <div class="pricing-feature">HTML export for any platform</div>
        </div>
        <button class="btn btn-outline" style="width:100%;margin-top:auto;font-size:14px;padding:11px" data-action="pick-plan" data-plan="pro">Start free trial →</button>
        <div style="text-align:center;font-size:11px;color:var(--text-3);margin-top:8px">No charge for 7 days. Cancel anytime.</div>
      </div>

      <!-- Studio (featured) -->
      <div class="pricing-card featured">
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div class="pricing-tier">Curanta Studio</div>
            <div style="font-size:10px;font-weight:700;background:var(--accent);color:#fff;padding:2px 8px;border-radius:99px;letter-spacing:0.05em">BEST VALUE</div>
          </div>
          <div class="pricing-price"><span class="amount">$99</span><span class="period">/mo</span></div>
          <div class="pricing-trial-badge">✦ 7-day free trial included</div>
          <div class="pricing-desc">For operators running multiple brands from one account.</div>
        </div>
        <div class="pricing-features">
          <div class="pricing-feature"><strong>500 AI generations/month</strong> (shared)</div>
          <div class="pricing-feature"><strong>Up to 3 publications</strong></div>
          <div class="pricing-feature">Everything in Pro</div>
          <div class="pricing-feature">Per-brand voice & audience avatar</div>
          <div class="pricing-feature">Separate prompt defaults per brand</div>
          <div class="pricing-feature">Switch publications instantly</div>
        </div>
        <button class="btn btn-primary" style="width:100%;font-size:15px;padding:13px;margin-top:auto" data-action="pick-plan" data-plan="multi">Start free trial →</button>
        <div style="text-align:center;font-size:11px;color:var(--text-3);margin-top:8px">No charge for 7 days. Cancel anytime.</div>
      </div>

      <!-- Enterprise -->
      <div class="pricing-card">
        <div>
          <div class="pricing-tier">Enterprise</div>
          <div class="pricing-price"><span class="amount" style="font-size:32px;letter-spacing:-0.02em">Custom</span></div>
          <div class="pricing-desc">For agencies, media companies, and political operations running many brands.</div>
        </div>
        <div class="pricing-features">
          <div class="pricing-feature">Everything in Studio</div>
          <div class="pricing-feature">Unlimited publications</div>
          <div class="pricing-feature">Custom generation limits</div>
          <div class="pricing-feature">White-label interface</div>
          <div class="pricing-feature">API access</div>
          <div class="pricing-feature">Dedicated support + SLA</div>
        </div>
        <button class="btn btn-outline" style="width:100%;margin-top:auto;padding:10px" onclick="window.open('https://calendly.com/noahrin/60-minute-tutoring-clone','_blank');event.stopPropagation()">Book a demo →</button>
        <div style="text-align:center;font-size:11px;color:var(--text-3);margin-top:8px">We'll respond within one business day.</div>
      </div>

    </div>

    <!-- FAQ -->
    <div class="pricing-faq">
      <h3 class="pricing-faq-title">Common questions</h3>
      <div class="faq-grid">
        <div class="faq-item">
          <div class="faq-q">Do I need a credit card to start?</div>
          <div class="faq-a">Yes — a card is required to hold your trial. You will not be charged anything until day 8. Cancel any time before then and you pay absolutely nothing.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">What's the difference between Pro and Studio?</div>
          <div class="faq-a">Pro gives you one publication — one brand voice, one audience avatar, one set of defaults. Studio lets you run up to 3 completely separate publications from the same account, each with its own brand identity and AI settings. If you run more than one newsletter, Studio is worth it.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">What counts as a generation?</div>
          <div class="faq-a">Every AI write — a lead story, quick hit, briefing, subject line, or rewrite — uses one generation. 500/month is enough for a daily newsletter with room to spare.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">How does the brand voice system work?</div>
          <div class="faq-a">Paste your newsletter URL. Curanta reads your past issues and builds a voice profile the AI matches on every generation. Every piece sounds like you wrote it.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">Can I cancel anytime?</div>
          <div class="faq-a">Yes — one click from the Subscription page. No calls, no forms, no dark patterns. You keep access until the end of your billing period.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">What is an audience avatar?</div>
          <div class="faq-a">You describe your average reader — their job, experience level, and what they want. The AI uses this to decide what to emphasise, what to explain, and what to skip.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">Does it work with my existing newsletter platform?</div>
          <div class="faq-a">Yes. Curanta exports clean HTML you can paste into Beehiiv, Substack, Mailchimp, Kit, or any platform that accepts HTML. No migration required.</div>
        </div>
      </div>
    </div>
  </section>

  <section class="cta-section">
    <h2>Your next issue shouldn't take all day.</h2>
    <p>Start your 7-day free trial. No charge until day 8. Cancel in one click if it's not for you.</p>
    <div class="hero-actions">
      <button class="btn btn-primary" data-action="start-trial">Try free for 7 days →</button>
    </div>
    <p style="font-size:12px;color:var(--text-3);margin-top:14px">No charge until day 8 · Cancel anytime · Takes 60 seconds to set up</p>
  </section>

  <footer class="landing-footer">
    <a class="nav-logo" href="#" data-action="navigate" data-view="landing" style="text-decoration:none">${logoSVG(28)}</a>
    <div class="footer-links">
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a href="#" onclick="event.preventDefault();showContactPopup()">Contact</a>
    </div>
    <div style="color:var(--text-3);font-size:12px">© 2026 Curanta. All rights reserved.</div>
  </footer>
</div>`;
}

// ── AUTH MODAL ────────────────────────────────────────────────────────────────
function showAuthModal(tab = 'signup') {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const plan = _pendingCheckoutPlan;
  const planName  = plan === 'multi' ? 'Curanta Studio' : 'Curanta Pro';
  const planPrice = plan === 'multi' ? '$99' : '$49';
  const planFeatures = plan === 'multi'
    ? ['Up to 3 publications', 'Everything in Pro', 'Per-brand voice & avatar', 'Separate prompt defaults', 'Switch publications instantly']
    : ['500 AI generations/month', '1 publication', 'Brand voice & audience avatar', 'Section prompt defaults', 'HTML export for any platform'];

  // Signup gets a full-screen split layout; login stays as a compact modal
  if (tab === 'signup') {
    modal.innerHTML = `
  <div class="auth-fullscreen" id="modal-overlay">
    <button class="auth-fs-close" data-action="close-modal" aria-label="Close">×</button>

    <!-- Left panel: plan / value prop -->
    <div class="auth-fs-left">
      <div class="auth-fs-logo">${logoSVGWhite(26)}</div>
      <div class="auth-fs-plan-badge">${plan ? `${planName} · ${planPrice}/mo` : '7-day free trial'}</div>
      <div class="auth-fs-headline">Ship great newsletters,<br>faster than ever.</div>
      <div class="auth-fs-sub">7 days free. No card charged until the trial ends. Cancel anytime.</div>
      <ul class="auth-fs-features">
        ${(plan ? planFeatures : ['500 AI generations/month','Brand voice & audience avatar','Section prompt defaults','HTML export for any platform','Unlimited newsletters & drafts']).map(f => `<li>✓ ${f}</li>`).join('')}
      </ul>
      <div class="auth-fs-trust">Join newsletter creators already using Curanta</div>
    </div>

    <!-- Right panel: form -->
    <div class="auth-fs-right">
      <div class="auth-fs-form-wrap">
        <div class="auth-fs-form-title">Create your account</div>
        <div class="auth-fs-form-sub">Already have one? <button class="auth-fs-switch" data-action="show-auth" data-tab="login">Sign in →</button></div>

        ${!configured ? `
        <div class="auth-error" style="margin:20px 0">⚠️ Supabase is not configured.</div>
        ` : `
        <form id="signup-form" class="auth-fs-form" novalidate>
          <div class="auth-inline-error" id="signup-error" hidden></div>
          <div class="auth-fs-field">
            <label class="auth-fs-label" for="signup-email">Email address</label>
            <input id="signup-email" type="email" class="input auth-fs-input" placeholder="you@example.com" autocomplete="email">
          </div>
          <div class="auth-fs-field">
            <label class="auth-fs-label" for="signup-password">Password</label>
            <div class="pw-field-wrap">
              <input id="signup-password" type="password" class="input auth-fs-input" placeholder="Min. 8 characters" autocomplete="new-password" oninput="checkPwStrength(this)">
              <button type="button" class="pw-toggle" onclick="togglePw('signup-password',this)">Show</button>
            </div>
            <div id="pw-strength"></div>
          </div>
          <button type="submit" id="signup-submit" class="btn btn-primary auth-fs-submit">
            Start ${plan ? planName : 'free'} trial →
          </button>
          <p class="auth-fs-legal">By creating an account you agree to our <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
        </form>
        <div class="auth-divider">or</div>
        <button class="btn btn-outline auth-fs-magic" onclick="sendMagicLink('signup')">✉️ Email me a magic link</button>
        `}
      </div>
    </div>
  </div>`;
    modal.querySelector('#modal-overlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
    setTimeout(() => document.getElementById('signup-email')?.focus(), 80);
    document.getElementById('signup-form')?.addEventListener('submit', submitSignup);
    return;
  }

  // ── Login stays as a compact centred modal ──
  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal auth-modal">
      <button class="auth-close-btn btn-icon" data-action="close-modal" aria-label="Close">×</button>

      <div class="auth-brand">${logoSVG(24)}</div>

      <div id="auth-headline" class="auth-headline">
        <div class="auth-headline-title">Welcome back</div>
        <div class="auth-headline-sub">Sign in to your account</div>
      </div>

      ${!configured ? `
      <div class="auth-body">
        <div class="auth-error" style="margin-bottom:14px">⚠️ Supabase is not configured.</div>
        <button class="btn btn-outline" style="width:100%;justify-content:center" onclick="state.user={email:'demo@example.com',id:'demo'};closeModal();navigate('dashboard')">Continue as demo user →</button>
      </div>
      ` : `
      <div class="auth-body">
        <form id="login-form" class="auth-form" novalidate>
          <div class="auth-inline-error" id="login-error" hidden></div>
          <div class="form-group">
            <label class="form-label" for="login-email">Email</label>
            <input id="login-email" type="email" class="input" placeholder="you@example.com" autocomplete="email">
          </div>
          <div class="form-group">
            <label class="form-label" for="login-password">Password</label>
            <div class="pw-field-wrap">
              <input id="login-password" type="password" class="input" placeholder="••••••••" autocomplete="current-password">
              <button type="button" class="pw-toggle" onclick="togglePw('login-password',this)">Show</button>
            </div>
          </div>
          <button type="submit" id="login-submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:4px">Sign in →</button>
        </form>
        <button class="auth-link-btn" data-action="forgot-password">Forgot password?</button>
        <div class="auth-divider">or</div>
        <button class="btn btn-outline" id="magic-login-btn" style="width:100%;justify-content:center" onclick="sendMagicLink('login')">✉️ Email me a magic link</button>
        <div style="text-align:center;margin-top:16px;font-size:13px;color:var(--text-3)">
          No account? <button class="auth-fs-switch" data-action="show-auth" data-tab="signup">Start free trial →</button>
        </div>
      </div>`}
    </div>
  </div>`;
  modal.querySelector('#modal-overlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  setTimeout(() => document.getElementById(tab === 'login' ? 'login-email' : 'signup-email')?.focus(), 80);
}

function closeModal() {
  const m = document.getElementById('modal-root');
  if (m) m.innerHTML = '';
}

function switchAuthTab(tab) {
  // Signup is now a full-screen page; login is a compact modal.
  // Switching between them just re-renders the appropriate layout.
  showAuthModal(tab);
}

function showForgotPasswordForm() {
  // The login modal uses .auth-body; replace its contents with the reset form
  const panel = document.querySelector('#modal-root .auth-body') || document.getElementById('auth-panel-login');
  if (!panel) return;
  panel.innerHTML = `
    <div style="margin-bottom:16px">
      <div style="font-size:14px;font-weight:700;margin-bottom:4px">Reset your password</div>
      <div style="font-size:13px;color:var(--text-2);line-height:1.5">Enter your email and we'll send you a link to set a new password.</div>
    </div>
    <form id="reset-form" class="auth-form">
      <div id="reset-msg" class="auth-error hidden"></div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input id="reset-email" type="email" class="input" placeholder="you@example.com" required autocomplete="email">
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">Send reset link →</button>
      <button type="button" class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:6px;font-size:12px" data-action="show-auth" data-tab="login">← Back to sign in</button>
    </form>`;
  document.getElementById('reset-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('reset-email')?.value?.trim();
    const msgEl = document.getElementById('reset-msg');
    if (!email || !sb) return;
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + '/?reset=true',
      });
      if (error) throw error;
      msgEl.classList.remove('hidden');
      msgEl.style.cssText = 'color:var(--green);background:var(--green-soft);border-color:rgba(52,211,153,0.3)';
      msgEl.textContent = '✓ Reset link sent — check your inbox (and spam folder).';
      btn.style.display = 'none';
    } catch (err) {
      msgEl.classList.remove('hidden');
      msgEl.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Send reset link →';
    }
  });
}

function showUpdatePasswordModal() {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <div class="modal-header">
        <div>
          <div class="modal-title">Set new password</div>
          <div class="modal-sub">Choose a new password for your account.</div>
        </div>
      </div>
      <div class="modal-body">
        <form id="update-pass-form" class="auth-form">
          <div id="update-pass-msg" class="auth-error hidden"></div>
          <div class="form-group">
            <label class="form-label">New password</label>
            <input id="new-password" type="password" class="input" placeholder="Min. 8 characters" minlength="8" required autocomplete="new-password">
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">Update password →</button>
        </form>
      </div>
    </div>
  </div>`;
  document.getElementById('update-pass-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = document.getElementById('new-password')?.value;
    const msgEl = document.getElementById('update-pass-msg');
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Updating…';
    try {
      const { error } = await sb.auth.updateUser({ password: pass });
      if (error) throw error;
      closeModal();
      toast('✓ Password updated — you\'re now signed in.', 'success');
      navigate('dashboard');
    } catch (err) {
      msgEl.classList.remove('hidden');
      msgEl.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Update password →';
    }
  });
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function friendlyAuthError(msg) {
  if (!msg) return 'Something went wrong. Please try again.';
  if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (/email not confirmed/i.test(msg)) return 'Please confirm your email first — check your inbox.';
  if (/already registered/i.test(msg)) return 'An account with this email already exists. Try signing in instead.';
  if (/password should be/i.test(msg)) return 'Password must be at least 8 characters.';
  if (/rate limit/i.test(msg)) return 'Too many attempts. Please wait a moment and try again.';
  return msg;
}
function showAuthError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.removeAttribute('hidden');
}
function clearAuthError(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = '';
  el.setAttribute('hidden', '');
}
function setAuthBtn(id, loading, text) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading
    ? `<span class="spinner" style="width:14px;height:14px;border-width:2px;vertical-align:middle;margin-right:6px"></span>${text}`
    : text;
}
function togglePw(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Hide' : 'Show';
}
function checkPwStrength(input) {
  const el = document.getElementById('pw-strength');
  if (!el) return;
  const v = input.value;
  if (!v) { el.innerHTML = ''; return; }
  const score = [v.length >= 8, /[A-Z]/.test(v), /[0-9]/.test(v), /[^a-zA-Z0-9]/.test(v)].filter(Boolean).length;
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = ['', 'var(--red)', 'var(--amber)', 'var(--accent)', 'var(--green)'];
  el.innerHTML = `<div style="display:flex;gap:3px;align-items:center;margin-top:6px">
    ${[1,2,3,4].map(i => `<div style="height:3px;flex:1;border-radius:99px;background:${i<=score?colors[score]:'var(--bg-5)'}"></div>`).join('')}
    <span style="font-size:11px;color:${colors[score]};margin-left:6px;min-width:38px">${labels[score]}</span>
  </div>`;
}
function scrollToPricing() {
  if (state.view !== 'landing') {
    navigate('landing');
    // After render, scroll to pricing
    setTimeout(() => {
      document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  } else {
    document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function showInitialPlanPicker() {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal" style="max-width:580px;padding:36px 36px 28px;position:relative">
      <button class="btn btn-ghost btn-sm" data-action="close-modal" style="position:absolute;top:14px;right:14px;font-size:20px;line-height:1;padding:2px 9px;color:var(--text-3)">×</button>
      <div style="text-align:center;margin-bottom:28px">
        <div style="font-size:23px;font-weight:800;letter-spacing:-0.03em;margin-bottom:8px">Start your free trial</div>
        <div style="font-size:13px;color:var(--text-2)">7 days free on both plans · No charge until day 8 · Cancel anytime</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
        <!-- Pro -->
        <div style="padding:24px;border:1px solid var(--border-md);border-radius:var(--r-lg);display:flex;flex-direction:column">
          <div style="font-size:12px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Curanta Pro</div>
          <div style="font-size:32px;font-weight:900;letter-spacing:-0.03em;line-height:1;margin-bottom:4px">$49<span style="font-size:14px;font-weight:500;color:var(--text-3)">/mo</span></div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:18px">1 publication</div>
          <div style="display:flex;flex-direction:column;gap:9px;font-size:12px;color:var(--text-2);flex:1;margin-bottom:20px">
            <div>✓ 500 AI generations / month</div>
            <div>✓ Brand voice &amp; audience avatar</div>
            <div>✓ Section prompt defaults</div>
            <div>✓ HTML export to any platform</div>
            <div>✓ Unlimited newsletters &amp; drafts</div>
          </div>
          <button class="btn btn-outline" style="width:100%;justify-content:center;padding:11px" data-action="pick-plan" data-plan="pro">Start Pro trial →</button>
        </div>
        <!-- Studio -->
        <div style="padding:24px;border:2px solid var(--accent);border-radius:var(--r-lg);background:var(--accent-soft);display:flex;flex-direction:column;position:relative">
          <div style="position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:3px 12px;border-radius:99px;white-space:nowrap;letter-spacing:0.06em">BEST VALUE</div>
          <div style="font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Curanta Studio</div>
          <div style="font-size:32px;font-weight:900;letter-spacing:-0.03em;line-height:1;margin-bottom:4px">$99<span style="font-size:14px;font-weight:500;color:var(--text-3)">/mo</span></div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:18px">Up to 3 publications</div>
          <div style="display:flex;flex-direction:column;gap:9px;font-size:12px;color:var(--text-2);flex:1;margin-bottom:20px">
            <div><strong style="color:var(--text-1)">✓ Up to 3 publications</strong></div>
            <div>✓ Everything in Pro</div>
            <div>✓ Per-brand voice &amp; avatar</div>
            <div>✓ Separate prompt defaults per brand</div>
            <div>✓ Switch publications instantly</div>
          </div>
          <button class="btn btn-primary" style="width:100%;justify-content:center;padding:11px" data-action="pick-plan" data-plan="multi">Start Studio trial →</button>
        </div>
      </div>
      <div style="text-align:center;font-size:11px;color:var(--text-3)">Not sure which? Start with Pro — you can always upgrade to Studio from your account.</div>
    </div>
  </div>`;
  modal.querySelector('#modal-overlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
}
window.showInitialPlanPicker = showInitialPlanPicker;

function showAccountCreatedThenPicker(user) {
  showPlanPickerModal(user);
}

function showPlanPickerModal(user) {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  window._planPickerUser = user;
  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal" style="max-width:580px;padding:36px 36px 28px">
      <div style="text-align:center;margin-bottom:28px">
        <div style="display:inline-flex;align-items:center;gap:7px;background:var(--green-soft);border:1px solid var(--green);border-radius:99px;padding:5px 14px;font-size:12px;font-weight:600;color:var(--green);margin-bottom:14px">
          <span>✓</span> Account created
        </div>
        <div style="font-size:23px;font-weight:800;letter-spacing:-0.03em;margin-bottom:8px">Choose your plan</div>
        <div style="font-size:13px;color:var(--text-2)">7-day free trial on both. No charge until it ends.</div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">

        <!-- Pro -->
        <div style="padding:24px;border:1px solid var(--border-md);border-radius:var(--r-lg);display:flex;flex-direction:column">
          <div style="font-size:12px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Curanta Pro</div>
          <div style="font-size:32px;font-weight:900;letter-spacing:-0.03em;line-height:1;margin-bottom:4px">$49<span style="font-size:14px;font-weight:500;color:var(--text-2)">/mo</span></div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:18px">1 publication</div>
          <div style="display:flex;flex-direction:column;gap:9px;font-size:12px;color:var(--text-2);flex:1;margin-bottom:20px">
            <div>✓ 500 AI generations / month</div>
            <div>✓ Brand voice & audience avatar</div>
            <div>✓ Section prompt defaults</div>
            <div>✓ HTML export to any platform</div>
            <div>✓ Unlimited newsletters & drafts</div>
          </div>
          <button class="btn btn-outline" style="width:100%;justify-content:center;padding:11px" data-action="pick-plan" data-plan="pro">Start Pro trial →</button>
        </div>

        <!-- Studio -->
        <div style="padding:24px;border:2px solid var(--accent);border-radius:var(--r-lg);background:var(--accent-soft);display:flex;flex-direction:column;position:relative">
          <div style="position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:3px 12px;border-radius:99px;white-space:nowrap;letter-spacing:0.06em">BEST VALUE</div>
          <div style="font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Curanta Studio</div>
          <div style="font-size:32px;font-weight:900;letter-spacing:-0.03em;line-height:1;margin-bottom:4px">$99<span style="font-size:14px;font-weight:500;color:var(--text-2)">/mo</span></div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:18px">Up to 3 publications</div>
          <div style="display:flex;flex-direction:column;gap:9px;font-size:12px;color:var(--text-2);flex:1;margin-bottom:20px">
            <div>✓ Everything in Pro</div>
            <div><strong style="color:var(--text-1)">✓ Up to 3 publications</strong></div>
            <div>✓ Per-brand voice & audience avatar</div>
            <div>✓ Separate prompt defaults per brand</div>
            <div>✓ Switch publications instantly</div>
          </div>
          <button class="btn btn-primary" style="width:100%;justify-content:center;padding:11px" data-action="pick-plan" data-plan="multi">Start Studio trial →</button>
        </div>

      </div>
      <div style="text-align:center;font-size:11px;color:var(--text-3)">
        Not sure which? Start with Pro — you can upgrade to Studio anytime from your account.
      </div>
    </div>
  </div>`;
  modal.querySelector('#modal-overlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
}

async function pickPlan(plan) {
  // If already logged in, startCheckout will go straight to Stripe.
  // If not logged in, it sets _pendingCheckoutPlan and shows signup — after auth
  // the plan is carried through and we skip the post-signup picker.
  await startCheckout(plan);
}
window.pickPlan = pickPlan;

function showWelcomeModal() {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  const planName = state.subscriptionPlan === 'multi' ? 'Curanta Studio' : 'Curanta Pro';
  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal" style="max-width:520px;padding:44px 40px 36px">

      <!-- Header -->
      <div style="text-align:center;margin-bottom:32px">
        <div style="font-size:48px;margin-bottom:16px;line-height:1">🎉</div>
        <div style="font-size:24px;font-weight:800;letter-spacing:-0.03em;margin-bottom:8px">Welcome to Curanta!</div>
        <div style="font-size:13px;color:var(--text-2)">
          Your <strong style="color:var(--text-1)">${planName}</strong> trial has started ·
          <strong style="color:var(--green)">7 days free</strong>
        </div>
      </div>

      <!-- Step 1: Voice setup — do it right here -->
      <div style="background:var(--accent-soft);border:2px solid var(--accent);border-radius:var(--r-lg);padding:24px;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <div style="width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">1</div>
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text-1)">Set up your AI writer — takes 30 seconds</div>
            <div style="font-size:12px;color:var(--text-2)">Paste your newsletter URL. Curanta reads your past issues and builds a voice profile that makes every AI generation sound like you.</div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <input id="welcome-voice-url" class="input" type="url" placeholder="https://yourname.substack.com  or  https://yourpub.beehiiv.com" style="flex:1;font-size:13px">
          <button class="btn btn-primary" onclick="welcomeStartVoice()" style="white-space:nowrap">Build my AI writer →</button>
        </div>
        <div style="font-size:11px;color:var(--text-3);margin-top:6px">Works with Substack, Beehiiv, Ghost, WordPress and more</div>
      </div>

      <!-- Steps 2 & 3 -->
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:28px">
        <div style="display:flex;gap:12px;align-items:center;padding:12px 16px;border-radius:var(--r-md);background:var(--bg-3)">
          <div style="width:24px;height:24px;border-radius:50%;background:var(--bg-5);color:var(--text-2);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">2</div>
          <div style="font-size:13px"><strong>Add your RSS sources</strong> <span style="color:var(--text-3)">→ Sources → paste any feed URL</span></div>
        </div>
        <div style="display:flex;gap:12px;align-items:center;padding:12px 16px;border-radius:var(--r-md);background:var(--bg-3)">
          <div style="width:24px;height:24px;border-radius:50%;background:var(--bg-5);color:var(--text-2);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">3</div>
          <div style="font-size:13px"><strong>Build your first issue</strong> <span style="color:var(--text-3)">→ Dashboard → New newsletter</span></div>
        </div>
      </div>

      <button class="btn btn-ghost btn-sm" style="width:100%;justify-content:center;color:var(--text-3)" onclick="closeModal()">Skip for now — I'll set this up in Settings</button>
    </div>
  </div>`;
  modal.querySelector('#modal-overlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
}

window.welcomeStartVoice = function() {
  const input = document.getElementById('welcome-voice-url');
  const url = input?.value.trim();
  if (!url) { toast('Paste your newsletter URL first', 'warn'); return; }
  try { new URL(url); } catch { toast('That doesn\'t look like a valid URL', 'warn'); return; }
  showVoiceWizard(url);
};

function showAccountCreatedScreen(email) {
  const modal = document.getElementById('modal-root');
  if (!modal) { toast('Account created! Taking you to checkout…', 'success'); return; }
  modal.innerHTML = `
  <div class="modal-overlay">
    <div class="modal auth-modal" style="text-align:center;padding:44px 36px 36px">
      <div class="account-created-check">✓</div>
      <div style="font-size:22px;font-weight:800;letter-spacing:-0.03em;margin-bottom:8px">Account created!</div>
      <div style="font-size:13px;color:var(--text-2);margin-bottom:6px">${escHtml(email)}</div>
      <div style="font-size:13px;color:var(--text-2);margin-bottom:20px">Opening Stripe checkout…</div>
      <div style="height:3px;background:var(--bg-4);border-radius:99px;overflow:hidden;margin-bottom:8px">
        <div id="checkout-progress-bar" style="height:100%;width:0%;background:var(--accent);border-radius:99px;transition:width 2s linear"></div>
      </div>
      <div style="font-size:11px;color:var(--text-3)">You'll be redirected automatically</div>
    </div>
  </div>`;
  setTimeout(() => {
    const bar = document.getElementById('checkout-progress-bar');
    if (bar) bar.style.width = '85%';
  }, 60);
}

function showCheckEmailScreen(email) {
  // Replace the entire modal — never depends on existing DOM state, always visible
  const modal = document.getElementById('modal-root');
  if (!modal) { toast('Account created! Check your email to confirm.', 'success'); return; }
  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal auth-modal" style="text-align:center;padding:44px 36px 36px">
      <div style="font-size:56px;line-height:1;margin-bottom:20px">📬</div>
      <div style="font-size:21px;font-weight:800;letter-spacing:-0.03em;margin-bottom:10px">Check your inbox</div>
      <div style="font-size:13px;color:var(--text-2);line-height:1.75;margin-bottom:28px">
        We sent a confirmation link to<br>
        <strong style="color:var(--text-1)">${escHtml(email)}</strong>.<br>
        Click it to activate your account and start your
        ${_pendingCheckoutPlan === 'multi' ? 'Curanta Studio' : 'Curanta Pro'} free trial.
      </div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:20px">
        Didn't get it? Check your spam folder, or
        <button style="color:var(--accent);text-decoration:underline;background:none;border:none;cursor:pointer;font-size:inherit;padding:0"
          onclick="resendConfirmation('${escHtml(email)}')">resend the email</button>.
      </div>
      <button class="btn btn-ghost btn-sm" style="color:var(--text-3);width:100%;justify-content:center" data-action="close-modal">Close</button>
    </div>
  </div>`;
  modal.querySelector('#modal-overlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
}
function showSignupLoadingScreen() {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  modal.innerHTML = `
  <div class="modal-overlay" style="display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px)">
    <div style="text-align:center;padding:48px 40px;background:var(--bg-2);border-radius:var(--r-xl);border:1px solid var(--border-md);min-width:300px;max-width:360px;animation:fade-in 0.2s ease">
      <div style="display:flex;justify-content:center;margin-bottom:24px">
        <div class="signup-spinner"></div>
      </div>
      <div style="font-size:20px;font-weight:800;letter-spacing:-0.03em;margin-bottom:8px">Setting up your account</div>
      <div style="font-size:13px;color:var(--text-2);line-height:1.6">Just a moment while we get everything ready…</div>
    </div>
  </div>`;
}

function showMagicLinkSentScreen(email) {
  const modal = document.getElementById('modal-root');
  if (!modal) { toast('Magic link sent — check your inbox!', 'success'); return; }
  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal auth-modal" style="text-align:center;padding:44px 36px 36px">
      <div style="font-size:56px;line-height:1;margin-bottom:20px">✉️</div>
      <div style="font-size:21px;font-weight:800;letter-spacing:-0.03em;margin-bottom:10px">Magic link sent</div>
      <div style="font-size:13px;color:var(--text-2);line-height:1.75;margin-bottom:28px">
        We emailed a sign-in link to<br>
        <strong style="color:var(--text-1)">${escHtml(email)}</strong>.<br>
        Click it to sign in instantly — no password needed.
      </div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:20px">Didn't get it? Check your spam folder.</div>
      <button class="btn btn-ghost btn-sm" style="color:var(--text-3);width:100%;justify-content:center" data-action="close-modal">Close</button>
    </div>
  </div>`;
  modal.querySelector('#modal-overlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
}

async function resendConfirmation(email) {
  if (!sb || !email) return;
  try {
    await sb.auth.resend({ type: 'signup', email });
    toast('Confirmation email resent — check your inbox', 'success');
  } catch(e) { toast(e.message, 'error'); }
}
async function sendMagicLink(panel) {
  const emailId = panel === 'login' ? 'login-email' : 'signup-email';
  const btnId   = panel === 'login' ? 'magic-login-btn' : 'magic-signup-btn';
  const email = document.getElementById(emailId)?.value.trim();
  if (!email) { toast('Enter your email above first', 'warn'); document.getElementById(emailId)?.focus(); return; }
  if (!sb) return;
  const btn = document.getElementById(btnId);
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const { error } = await sb.auth.signInWithOtp({ email });
    if (error) throw error;
    showMagicLinkSentScreen(email);
  } catch(err) {
    toast(err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '✉️ Email me a magic link'; }
  }
}

async function submitLogin(e) {
  e.preventDefault();
  const email    = document.getElementById('login-email')?.value.trim();
  const password = document.getElementById('login-password')?.value;
  clearAuthError('login-error');
  if (!email)    { showAuthError('login-error', 'Please enter your email.'); return; }
  if (!password) { showAuthError('login-error', 'Please enter your password.'); return; }
  setAuthBtn('login-submit', true, 'Signing in…');
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    closeModal();
    if (!_pendingCheckoutPlan) toast('Signed in', 'success');
    // onAuthStateChange handles navigation / checkout redirect
  } catch(err) {
    showAuthError('login-error', friendlyAuthError(err.message));
    setAuthBtn('login-submit', false, 'Sign in →');
  }
}

async function submitSignup(e) {
  e.preventDefault();
  const email    = document.getElementById('signup-email')?.value.trim();
  const password = document.getElementById('signup-password')?.value;
  clearAuthError('signup-error');
  if (!email)                        { showAuthError('signup-error', 'Please enter your email.'); return; }
  if (!password || password.length < 8) { showAuthError('signup-error', 'Password must be at least 8 characters.'); return; }
  setAuthBtn('signup-submit', true, 'Creating account…');
  try {
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    // Supabase anti-enumeration: existing emails return fake success with empty identities
    if (data?.user?.identities?.length === 0) {
      showAuthError('signup-error', 'An account with this email already exists. Try signing in instead.');
      setAuthBtn('signup-submit', false, 'Start free trial →');
      return;
    }
    _justSignedUp = true;
    if (data?.user && !data?.session) {
      // Email confirmation required — show inbox screen; onAuthStateChange handles checkout after confirm
      showCheckEmailScreen(email);
    } else if (data?.session) {
      // Immediate session — show loading screen right away so user isn't staring at the signup form
      showSignupLoadingScreen();
    }
    // onAuthStateChange will replace this with the account created screen + plan picker / checkout
  } catch(err) {
    showAuthError('signup-error', friendlyAuthError(err.message));
    setAuthBtn('signup-submit', false, 'Start free trial →');
  }
}

async function handleLogout() {
  if (sb) await sb.auth.signOut();
  else { state.user = null; navigate('landing'); }
  toast('Signed out', 'info');
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const user = state.user;
  const email = user?.email || 'demo@example.com';
  const initial = email[0].toUpperCase();
  return `
<div class="app-shell">
  ${renderAppNav('dashboard')}
  <div class="app-main">
    ${renderTrialBanner()}
    <div class="app-topbar">
      <div>
        <div class="page-title">Dashboard</div>
        ${canUsePubs() ? `<div style="font-size:12px;color:var(--text-3);margin-top:2px">
          📰 <span style="color:var(--text-2);font-weight:600">${escHtml(currentPublicationName())}</span>
          <button class="btn btn-ghost btn-sm" data-action="navigate" data-view="publications" style="font-size:11px;padding:2px 7px;margin-left:4px">Switch →</button>
        </div>` : ''}
      </div>
      <div class="flex items-center gap-2">
        <button class="btn btn-primary" data-action="open-builder">+ New Newsletter</button>
      </div>
    </div>
    <div class="dashboard-content">

      ${!state.brandVoice ? `
      <div style="background:var(--accent-soft);border:1.5px solid var(--accent);border-radius:var(--r-lg);padding:20px 24px;margin-bottom:24px;display:flex;align-items:center;gap:20px;flex-wrap:wrap">
        <div style="font-size:36px;flex-shrink:0">🧠</div>
        <div style="flex:1;min-width:200px">
          <div style="font-size:15px;font-weight:700;color:var(--text-1);margin-bottom:3px">Set up your AI writer</div>
          <div style="font-size:13px;color:var(--text-2)">Paste your newsletter URL — Curanta reads your past issues and builds a voice profile in 30 seconds. Every AI generation will sound like you wrote it.</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
          <input id="dash-voice-url" class="input" type="url" placeholder="yourname.substack.com" style="width:220px;font-size:13px">
          <button class="btn btn-primary" onclick="dashStartVoice()" style="white-space:nowrap">Build AI writer →</button>
        </div>
      </div>` : ''}

      <div class="stat-grid">
        <div class="stat-card animate-in">
          <div class="stat-label">Newsletters</div>
          <div class="stat-value">${state.dbNewsletters.length || 0}</div>
          <div class="stat-change">total created</div>
        </div>
        <div class="stat-card animate-in animate-in-d1">
          <div class="stat-label">Drafts</div>
          <div class="stat-value">${state.dbNewsletters.filter(n => n.status === 'draft').length || 0}</div>
          <div class="stat-change">in progress</div>
        </div>
        <div class="stat-card animate-in animate-in-d2">
          <div class="stat-label">Sources</div>
          <div class="stat-value">${state.sources.length || 0}</div>
          <div class="stat-change">RSS feeds connected</div>
        </div>
        <div class="stat-card animate-in animate-in-d3">
          <div class="stat-label">AI Generations</div>
          <div class="stat-value" style="font-size:22px;margin-bottom:8px">${isSubscribed() ? `${state.generationsThisMonth}<span style="font-size:14px;font-weight:500;color:var(--text-3)">&thinsp;/ 500</span>` : '—'}</div>
          ${isSubscribed() ? `<div style="height:4px;background:var(--bg-4);border-radius:99px;overflow:hidden;margin-bottom:6px"><div style="height:100%;width:${Math.min(100, Math.round((state.generationsThisMonth/500)*100))}%;background:var(--nav-accent);border-radius:99px;transition:width 0.5s ease"></div></div>` : ''}
          <div class="stat-change">${isSubscribed() ? 'this month' : 'Subscribe to unlock'}</div>
        </div>
      </div>

      ${state.dbNewsletters.length === 0 ? `
      <div class="onboard-banner animate-in">
        <div class="onboard-banner-text">
          <div class="onboard-banner-title">Welcome to Curanta 👋</div>
          <div class="onboard-banner-sub">You're set up. Here's how to publish your first newsletter in under 15 minutes:</div>
          <div class="onboard-steps">
            <div class="onboard-step"><div class="onboard-num">1</div><div><strong>Add a source</strong> — paste an RSS feed URL or any article link in the builder's Sources panel.</div></div>
            <div class="onboard-step"><div class="onboard-num">2</div><div><strong>Add articles to a section</strong> — use each article's <strong>＋ Add to section</strong> menu, or drag it in.</div></div>
            <div class="onboard-step"><div class="onboard-num">3</div><div><strong>Click ✦ Generate</strong> — AI writes each section in your voice. Then <strong>Copy HTML</strong> or <strong>Copy for Beehiiv</strong> to publish.</div></div>
          </div>
        </div>
        <button class="btn btn-primary" style="flex-shrink:0;align-self:flex-start" data-action="open-builder">Create your first newsletter →</button>
      </div>` : ''}

      <div>
        <div class="dash-section-title">
          Newsletters
          <button class="btn btn-ghost text-sm" data-action="open-builder">+ New</button>
        </div>
        <div class="newsletter-grid">
          <div class="new-newsletter-card" data-action="open-builder">
            <div class="new-newsletter-icon">+</div>
            <div class="new-newsletter-label">New Newsletter</div>
          </div>
          ${state.dbNewsletters.length === 0 ? '' : state.dbNewsletters.map((nl, i) => `
          <div class="newsletter-card animate-in animate-in-d${Math.min(i+1,5)}" data-action="open-newsletter" data-id="${nl.id}">
            <div style="flex:1;min-width:0">
              <div class="newsletter-card-title">${escHtml(nl.title)}</div>
              ${nl.subject ? `<div class="newsletter-card-subject">${escHtml(nl.subject)}</div>` : ''}
              ${nl.updated_at || nl.created_at ? `<div class="newsletter-card-date">Updated ${timeAgo(nl.updated_at || nl.created_at)}</div>` : ''}
            </div>
            <div class="newsletter-card-meta">
              <span class="badge ${nl.status === 'sent' ? 'badge-green' : nl.status === 'scheduled' ? 'badge-blue' : 'badge-default'}">
                <span class="dot ${nl.status === 'sent' ? 'dot-green' : nl.status === 'scheduled' ? 'dot-blue' : 'dot-dim'}"></span>
                ${nl.status}
              </span>
              <div style="display:flex;align-items:center;gap:8px">
                <div class="newsletter-card-stats">
                  ${nl.openRate ? `<div class="newsletter-stat"><strong>${nl.openRate}%</strong> open</div>` : ''}
                  ${nl.clickRate ? `<div class="newsletter-stat"><strong>${nl.clickRate}%</strong> click</div>` : ''}
                  ${nl.scheduledFor ? `<div class="newsletter-stat">Sends ${new Date(nl.scheduledFor).toLocaleDateString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>` : ''}
                </div>
                <div class="newsletter-card-actions">
                  ${canUsePubs() ? `<select class="nl-action-btn" title="Move to a publication" onclick="event.stopPropagation()" onchange="moveNewsletterToPublication('${nl.id}', this.value); event.stopPropagation();" style="cursor:pointer;max-width:120px">
                    <option value="__cur" selected>📰 ${escHtml(currentPublicationName())}</option>
                    ${[{ id: '', name: state.defaultPublicationName || 'Default' }, ...state.publications.map(p => ({ id: p.id, name: p.name }))]
                      .filter(p => (p.id || null) !== (state.currentPublicationId || null))
                      .map(p => `<option value="${p.id}">Move to ${escHtml(p.name)}</option>`).join('')}
                  </select>` : ''}
                  <button class="nl-action-btn" data-action="duplicate-newsletter" data-id="${nl.id}" title="Duplicate">⊕ Copy</button>
                  <button class="nl-action-btn danger" data-action="delete-newsletter" data-id="${nl.id}" title="Delete">× Delete</button>
                </div>
              </div>
            </div>
          </div>`).join('')}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <div class="dash-section-title">Feed Health</div>
          <div class="feed-health-list">
            ${state.sources.length === 0 ? `
            <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-md);padding:16px;text-align:center;color:var(--text-3);font-size:12px">
              No RSS feeds yet — add them in the builder.
            </div>` : state.sources.map(s => `
            <div class="feed-health-item">
              <span class="dot dot-green"></span>
              <span class="feed-health-name">${s.title}</span>
              <span class="feed-health-count">${s.articles.length} articles</span>
            </div>`).join('')}
          </div>
        </div>
        <div>
          <div class="dash-section-title">Brand Settings</div>
          <div class="card card-sm" style="display:flex;flex-direction:column;gap:10px">
            <div class="flex items-center justify-between">
              <span class="text-sm text-muted">Brand color</span>
              <div style="width:20px;height:20px;border-radius:4px;background:${state.design.primaryColor};border:1px solid var(--border)"></div>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-sm text-muted">Voice profile</span>
              <span class="badge ${state.brandVoice ? 'badge-green' : 'badge-default'}">${state.brandVoice ? 'Configured' : 'Not set'}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-sm text-muted">Default tone</span>
              <span class="text-sm">${state.tone.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</span>
            </div>
            <button class="btn btn-outline btn-sm" data-action="navigate" data-view="settings">Configure in Settings →</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

// ── SOURCES PAGE ──────────────────────────────────────────────────────────────
function renderSourcesPage() {
  return `
<div class="app-shell">
  ${renderAppNav('sources')}
  <div class="app-main">
    ${renderTrialBanner()}
    <div class="app-topbar">
      <div>
        <div class="page-title">Sources</div>
        <div class="page-sub">${canUsePubs()
          ? `RSS feeds for <strong style="color:var(--text-2)">📰 ${escHtml(currentPublicationName())}</strong> — each publication keeps its own.`
          : 'RSS feeds and URLs you pull articles from.'}</div>
      </div>
    </div>
    <div class="page-body">
      ${canUsePubs() && state.sourcesPubScoped === false ? `
      <div class="card" style="margin-bottom:16px;padding:12px 16px;border-left:3px solid var(--amber, #f59e0b);background:var(--bg-3)">
        <div style="font-size:13px;color:var(--text-2);line-height:1.5">
          ⚠️ Sources are separated per publication on <strong>this browser</strong>.
          For separation that syncs across devices, run the one-time
          <code style="font-size:11px">publication_id</code> migration in Supabase
          (see <code style="font-size:11px">supabase-schema.sql</code>).
        </div>
      </div>` : ''}
      <div class="card" style="margin-bottom:20px;padding:16px 20px">
        <form id="source-form" style="display:flex;gap:10px;align-items:center">
          <input id="source-url-input" class="input" type="url" placeholder="Paste RSS feed URL or article URL…" style="flex:1">
          <button id="source-add-btn" type="submit" class="btn btn-primary">Add Source</button>
        </form>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          ${[
            ['TechCrunch', 'https://techcrunch.com/feed/'],
            ['The Verge', 'https://www.theverge.com/rss/index.xml'],
            ['Axios', 'https://api.axios.com/feed/'],
            ['BBC News', 'https://feeds.bbci.co.uk/news/rss.xml'],
            ['NPR', 'https://feeds.npr.org/1001/rss.xml'],
          ].map(([label, url]) => `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="quickAddFeed('${url}')">${label}</button>`).join('')}
        </div>
      </div>

      ${state.sources.length === 0 ? `
      <div class="empty-state">
        <div style="font-size:32px;margin-bottom:12px">📡</div>
        <div class="empty-state-title">No sources yet</div>
        <div class="empty-state-sub">Add an RSS feed or article URL above to get started.</div>
      </div>` : `
      <div style="display:flex;flex-direction:column;gap:12px">
        ${state.sources.map(s => `
        <div class="card" style="padding:16px 20px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:14px;margin-bottom:2px">${escHtml(s.title)}</div>
              <div style="font-size:12px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(s.feedUrl)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
              <span class="badge ${s.articles.length > 0 ? 'badge-green' : 'badge-default'}">
                ${s.articles.length > 0 ? `${s.articles.length} articles` : 'Fetching…'}
              </span>
              <button class="btn btn-ghost btn-sm" style="color:var(--red);font-size:12px" data-action="remove-feed" data-feed-id="${s.id}">Remove</button>
            </div>
          </div>
          ${s.articles.length > 0 ? `
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">
            ${s.articles.slice(0, 5).map(a => `
            <div style="display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--border)">
              <div style="flex:1;font-size:13px;color:var(--text-1)">${escHtml(a.title)}</div>
              <div style="font-size:11px;color:var(--text-3);flex-shrink:0">${a.timeAgo || ''}</div>
            </div>`).join('')}
            ${s.articles.length > 5 ? `<div style="font-size:12px;color:var(--text-3);padding-top:4px">+${s.articles.length - 5} more articles</div>` : ''}
          </div>` : ''}
        </div>`).join('')}
      </div>`}
    </div>
  </div>
</div>`;
}

function toggleSectionPrompt(sectionId) {
  if (!state._expandedPrompts) state._expandedPrompts = {};
  state._expandedPrompts[sectionId] = !state._expandedPrompts[sectionId];
  const sectionsEl = document.getElementById('editor-sections');
  if (sectionsEl) { sectionsEl.innerHTML = renderEditorSections(); setupDropZones(); }
}

// ── SETTINGS PAGE ─────────────────────────────────────────────────────────────
function switchSettingsTab(tab) {
  state.settingsTab = tab;
  render();
}

function renderSubscriptionPage() {
  const used = state.generationsThisMonth || 0;
  const pct = Math.min(100, Math.round((used / 500) * 100));
  return `
<div class="app-shell">
  ${renderAppNav('subscription')}
  <div class="app-main">
    ${renderTrialBanner()}
    <div class="app-topbar">
      <div>
        <div class="page-title">Subscription</div>
        <div class="page-sub">Manage your plan and billing.</div>
      </div>
    </div>
    <div class="page-body" style="max-width:560px">

      ${isSubscribed() ? (() => {
        const planLabel = state.grandfathered ? 'Grandfathered — Full Access'
          : state.subscriptionStatus === 'trialing'
            ? `${state.subscriptionPlan === 'multi' ? 'Curanta Studio' : 'Curanta Pro'} — Free Trial · ${trialDaysLeft()} day${trialDaysLeft() === 1 ? '' : 's'} left`
            : `${state.subscriptionPlan === 'multi' ? 'Curanta Studio' : 'Curanta Pro'} — Active`;
        const planSub = state.grandfathered ? 'Your account has permanent full access.'
          : state.subscriptionStatus === 'trialing' ? 'Your card will be charged when the trial ends. Cancel anytime before then.'
          : state.subscriptionPlan === 'multi' ? 'Up to 3 publications · 500 AI generations/month.'
          : '1 publication · 500 AI generations/month.';
        return `
      <div class="settings-section">
        <div style="padding:24px;background:var(--green-soft);border:1px solid var(--green);border-radius:var(--r-lg)">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:${state.grandfathered ? '0' : '20px'}">
            <div style="font-size:28px">✦</div>
            <div>
              <div style="font-size:16px;font-weight:700;color:var(--green)">${planLabel}</div>
              <div style="font-size:12px;color:var(--text-2);margin-top:2px">${planSub}</div>
            </div>
          </div>
          ${!state.grandfathered ? `
          <div style="margin-bottom:8px;display:flex;justify-content:space-between;font-size:12px;color:var(--text-2)">
            <span>Generations this month</span>
            <span>${used} / 500</span>
          </div>
          <div style="background:var(--bg-3);border-radius:6px;height:8px;overflow:hidden;margin-bottom:20px">
            <div style="background:var(--green);height:100%;width:${pct}%;transition:width 0.3s;border-radius:6px"></div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-outline" onclick="manageBilling()">${state.subscriptionStatus === 'trialing' ? 'Cancel trial →' : 'Manage billing →'}</button>
            ${state.subscriptionPlan !== 'multi' ? `<button class="btn btn-ghost btn-sm" onclick="startCheckout('multi')" style="color:var(--accent)">Upgrade to Studio →</button>` : ''}
          </div>
          ` : ''}
        </div>
      </div>`;
      })() : `
      <div class="settings-section">
        <div style="margin-bottom:20px">
          <div style="font-size:16px;font-weight:700;margin-bottom:4px">Choose a plan</div>
          <div style="font-size:13px;color:var(--text-2)">7-day free trial on both plans. No charge until the trial ends.</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <!-- Pro -->
          <div style="padding:22px;border:1px solid var(--border-md);border-radius:var(--r-lg)">
            <div style="font-size:13px;font-weight:700;color:var(--text-2);margin-bottom:4px">Curanta Pro</div>
            <div style="font-size:28px;font-weight:900;letter-spacing:-0.03em;margin-bottom:2px">$49<span style="font-size:14px;font-weight:500;color:var(--text-2)">/mo</span></div>
            <div style="font-size:11px;color:var(--text-3);margin-bottom:16px">1 publication</div>
            <div style="display:flex;flex-direction:column;gap:7px;font-size:12px;color:var(--text-2);margin-bottom:20px">
              <div>✓ 500 AI generations/mo</div>
              <div>✓ Brand voice & avatar</div>
              <div>✓ Section defaults</div>
              <div>✓ HTML export</div>
            </div>
            <button class="btn btn-outline" style="width:100%;justify-content:center" onclick="startCheckout('pro')">Start free trial →</button>
          </div>
          <!-- Studio -->
          <div style="padding:22px;border:2px solid var(--accent);border-radius:var(--r-lg);background:var(--accent-soft);position:relative">
            <div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:2px 10px;border-radius:99px;letter-spacing:0.05em;white-space:nowrap">BEST VALUE</div>
            <div style="font-size:13px;font-weight:700;color:var(--accent);margin-bottom:4px">Curanta Studio</div>
            <div style="font-size:28px;font-weight:900;letter-spacing:-0.03em;margin-bottom:2px">$99<span style="font-size:14px;font-weight:500;color:var(--text-2)">/mo</span></div>
            <div style="font-size:11px;color:var(--text-3);margin-bottom:16px">Up to 3 publications</div>
            <div style="display:flex;flex-direction:column;gap:7px;font-size:12px;color:var(--text-2);margin-bottom:20px">
              <div>✓ Everything in Pro</div>
              <div>✓ 3 separate publications</div>
              <div>✓ Per-brand voice & avatar</div>
              <div>✓ Separate prompt defaults</div>
            </div>
            <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="startCheckout('multi')">Start free trial →</button>
          </div>
        </div>
        <div style="text-align:center;font-size:11px;color:var(--text-3)">Cancel before the trial ends and pay nothing. No calls, no forms.</div>
        <div style="margin-top:16px;padding:14px 18px;background:var(--bg-3);border-radius:var(--r-md);font-size:12px;color:var(--text-2);text-align:center">
          Need more than 3 publications?
          <a href="mailto:noah@getcuranta.com?subject=Enterprise%20inquiry" style="color:var(--accent);margin-left:4px">Talk to us about Enterprise →</a>
        </div>
      </div>
      `}

    </div>
  </div>
</div>`;
}

function renderPublicationsPage() {
  const email = state.user?.email || '';

  if (canUsePubs()) {
    // ── Real multi-publication UI (grandfathered = unlimited, multi plan = cap 3) ─
    const limit = pubLimit();
    const totalPubs = 1 + state.publications.length; // Default + extras
    const atLimit = totalPubs >= limit;
    const allPubs = [
      { id: null, name: state.defaultPublicationName || 'Default', isDefault: true },
      ...state.publications,
    ];
    return `
<div class="app-shell">
  ${renderAppNav('publications')}
  <div class="app-main">
    ${renderTrialBanner()}
    <div class="app-topbar">
      <div class="page-title">Publications</div>
      ${!isFinite(limit) ? '' : `<div style="font-size:12px;color:var(--text-3)">${totalPubs} / ${limit} publications used</div>`}
    </div>
    <div class="settings-page" style="max-width:720px">
      <p style="font-size:13px;color:var(--text-2);margin-bottom:20px;line-height:1.6">
        Each publication has its own brand voice, audience avatar, tone, and prompt defaults.
        The active one is used for every newsletter you build — switch here, then configure in Settings.
      </p>
      <div class="pub-list">
        ${allPubs.map(pub => {
          const isActive = pub.id === state.currentPublicationId;
          return `
        <div class="pub-card ${isActive ? 'pub-card-active' : ''}">
          <div class="pub-card-left">
            <div class="pub-avatar" style="${pub.isDefault ? 'background:var(--bg-5);color:var(--text-2)' : ''}">${pub.name[0].toUpperCase()}</div>
            <div>
              <div class="pub-name">${escHtml(pub.name)}${pub.isDefault ? ' <span style="font-size:11px;color:var(--text-3);font-weight:400">(default)</span>' : ''}</div>
              <div class="pub-meta">${isActive ? '<span class="badge badge-accent" style="font-size:10px">Active</span>' : 'Click to switch'}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${isActive
              ? `<button class="btn btn-outline btn-sm" data-action="navigate" data-view="settings">Edit settings →</button>`
              : `<button class="btn btn-outline btn-sm" data-action="switch-publication" data-id="${pub.id || ''}">Switch</button>`
            }
            ${pub.isDefault
              ? `<button class="btn-icon" title="Rename" data-action="rename-default-publication" style="font-size:14px">✎</button>`
              : `<button class="btn-icon" title="Rename" data-action="rename-publication" data-id="${pub.id}" style="font-size:14px">✎</button>
                 <button class="btn-icon" title="Delete" data-action="delete-publication" data-id="${pub.id}" style="font-size:14px;color:var(--text-3)">🗑</button>`
            }
          </div>
        </div>`;
        }).join('')}

        ${atLimit
          ? `<div class="pub-card" style="opacity:0.5;cursor:default">
              <div class="pub-card-left">
                <div class="pub-avatar pub-avatar-add">+</div>
                <div>
                  <div class="pub-name" style="color:var(--text-2)">Publication limit reached</div>
                  <div class="pub-meta">${isFinite(limit) ? `Your plan includes ${limit} publications` : ''}</div>
                </div>
              </div>
             </div>`
          : `<div class="pub-card pub-card-add" data-action="new-publication">
              <div class="pub-card-left">
                <div class="pub-avatar pub-avatar-add">+</div>
                <div>
                  <div class="pub-name" style="color:var(--text-2)">Add a publication</div>
                  <div class="pub-meta">Separate voice, avatar &amp; prompts per brand</div>
                </div>
              </div>
             </div>`
        }
      </div>
    </div>
  </div>
</div>`;
  }

  // ── Upgrade wall — show $99/mo multi-pub offer ───────────────────────────
  const email2 = state.user?.email || '';
  const pubName = state.brandVoice
    ? (state.brandVoice.match(/newsletter called ["']?([^"'\n,]+)/i)?.[1] || 'My Publication')
    : 'My Publication';
  return `
<div class="app-shell">
  ${renderAppNav('publications')}
  <div class="app-main">
    ${renderTrialBanner()}
    <div class="app-topbar">
      <div class="page-title">Publications</div>
    </div>
    <div class="settings-page" style="max-width:680px">

      <div class="pub-list">
        <!-- Current publication -->
        <div class="pub-card pub-card-active">
          <div class="pub-card-left">
            <div class="pub-avatar">${(email2[0] || 'P').toUpperCase()}</div>
            <div>
              <div class="pub-name">${escHtml(pubName)}</div>
              <div class="pub-meta"><span class="badge badge-accent" style="font-size:10px">Active</span></div>
            </div>
          </div>
          <button class="btn btn-outline btn-sm" data-action="navigate" data-view="settings">Edit settings →</button>
        </div>

        <!-- Add publication — $99 upgrade card -->
        <div class="pub-card pub-card-add" data-action="subscribe-multi" style="cursor:pointer">
          <div class="pub-card-left">
            <div class="pub-avatar pub-avatar-add">+</div>
            <div>
              <div class="pub-name" style="color:var(--text-2)">Add a publication</div>
              <div class="pub-meta">Upgrade to Multi-Publication — $99/mo</div>
            </div>
          </div>
          <span class="badge badge-accent" style="font-size:11px;padding:4px 10px">Upgrade</span>
        </div>
      </div>

      <!-- $99 plan callout -->
      <div class="pub-upgrade-card">
        <div class="pub-upgrade-header">
          <div>
            <div class="pub-upgrade-title">Multi-Publication Plan</div>
            <div class="pub-upgrade-price">$99<span style="font-size:15px;font-weight:500;color:var(--text-2)">/mo</span></div>
            <div class="pub-upgrade-sub">Run up to 3 separate publications from one account. Each gets its own brand voice, audience avatar, and AI defaults.</div>
          </div>
        </div>
        <div class="pub-upgrade-features">
          <div class="pub-upgrade-feature">✓ 3 publications</div>
          <div class="pub-upgrade-feature">✓ Per-brand voice &amp; audience avatar</div>
          <div class="pub-upgrade-feature">✓ Separate prompt defaults per brand</div>
          <div class="pub-upgrade-feature">✓ 500 AI generations / month (shared)</div>
          <div class="pub-upgrade-feature">✓ Everything in Pro</div>
          <div class="pub-upgrade-feature">✓ 7-day free trial</div>
        </div>
        <button class="btn btn-primary" style="width:100%;font-size:15px;padding:13px;margin-top:4px" data-action="subscribe-multi">
          Start free trial →
        </button>
        <div style="font-size:11px;color:var(--text-3);text-align:center;margin-top:8px">No charge for 7 days. Cancel anytime.</div>
      </div>

      <!-- Enterprise note -->
      <div style="text-align:center;margin-top:24px;font-size:12px;color:var(--text-3)">
        Need more than 3 publications or custom limits?
        <a href="mailto:noah@getcuranta.com?subject=Enterprise%20inquiry" style="color:var(--accent);margin-left:4px">Talk to us about Enterprise →</a>
      </div>

    </div>
  </div>
</div>`;
}

function renderSettingsPage() {
  const tab = state.settingsTab || 'content';
  const tones = [
    { id: 'punchy-executive', label: 'Punchy Executive' },
    { id: 'morning-brew', label: 'Morning Brew' },
    { id: 'neutral-newsroom', label: 'Neutral Newsroom' },
    { id: 'sharp-political', label: 'Sharp Political' },
  ];

  return `
<div class="app-shell">
  ${renderAppNav('settings')}
  <div class="app-main">
    ${renderTrialBanner()}
    <div class="app-topbar">
      <div>
        <div class="page-title">Settings</div>
        <div class="page-sub">${canUsePubs()
          ? 'Brand voice, audience, and section defaults below are saved <strong>per publication</strong>.'
          : 'Global defaults applied to every newsletter you create.'}</div>
      </div>
    </div>

    ${canUsePubs() ? `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;padding:12px 16px;border:1px solid var(--border-md);border-radius:var(--r-md);background:var(--bg-3)">
      <div style="font-size:13px;color:var(--text-2)">
        Editing settings for <span style="color:var(--accent);font-weight:700">📰 ${escHtml(currentPublicationName())}</span>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">Brand voice, audience avatar, tone &amp; section descriptions here apply only to this publication.</div>
      </div>
      <button class="btn btn-outline btn-sm" data-action="navigate" data-view="publications">Switch publication →</button>
    </div>` : ''}

    <div class="settings-tabs">
      <button class="settings-tab ${tab === 'content' ? 'active' : ''}" data-action="settings-tab" data-tab="content">Content</button>
      <button class="settings-tab ${tab === 'appearance' ? 'active' : ''}" data-action="settings-tab" data-tab="appearance">Appearance</button>
      <button class="settings-tab ${tab === 'api' ? 'active' : ''}" data-action="settings-tab" data-tab="api">API</button>
    </div>

    <div class="page-body" style="max-width:700px">

      ${tab === 'content' ? `

      <!-- ── BRAND VOICE ── -->
      <div class="settings-section">
        <div class="settings-section-title">Brand Voice</div>
        <div class="settings-section-sub">Type or paste your brand voice below — describe your tone, sentence rhythm, vocabulary, and what to always/never do. It applies to every AI generation. No publication or URL required.</div>

        <div style="margin-top:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:${state.brandVoice ? 'var(--green)' : 'var(--text-3)'}">🎙 Voice Profile${state.brandVoice ? ' — Active' : ''}</span>
            ${state.brandVoice ? `<button class="btn btn-ghost btn-sm" data-action="clear-brand-voice" style="color:var(--red)">Clear</button>` : ''}
          </div>
          <textarea id="brand-voice-edit" class="input" rows="8"
            style="width:100%;resize:vertical;font-size:13px;line-height:1.8;font-family:inherit"
            placeholder="e.g. Direct and authoritative with a dry wit. Short, punchy sentences — lead with the insight, then the evidence. Professional but never academic; no jargon without explanation. Always back claims with a number. Never use passive voice, exclamation marks, or 'it is worth noting.' Close with a forward-looking kicker, not a summary."
            oninput="state.brandVoice=this.value;scheduleSettingsSave();refreshVoiceBadge()"
          >${escHtml(state.brandVoice || '')}</textarea>
          <div style="font-size:11px;color:var(--text-3);margin-top:5px">Saves automatically as you type and applies to every AI generation.</div>
        </div>

        <!-- Optional: auto-generate from your published newsletter -->
        <details style="margin-top:16px">
          <summary style="cursor:pointer;font-size:12px;color:var(--text-2);font-weight:600">Or auto-generate it from your published newsletter (optional)</summary>
          <div style="margin-top:12px;padding:14px;border:1px solid var(--border-md);border-radius:var(--r-md)">
            <div style="display:flex;gap:8px">
              <input id="voice-pub-url" class="input" type="url"
                placeholder="https://yourname.substack.com  or  https://yourpub.beehiiv.com"
                style="flex:1" ${state.voiceUrlLoading ? 'disabled' : ''}>
              <button class="btn btn-primary" onclick="discoverVoice()" ${state.voiceUrlLoading ? 'disabled' : ''}>
                ${state.voiceUrlLoading ? '<span class="spinner"></span> Analyzing…' : '🎙 Analyze'}
              </button>
            </div>
            <div style="margin-top:5px;font-size:11px;color:var(--text-3)">Works with Substack, Beehiiv, Ghost, WordPress — reads up to 12 past issues and fills the box above (you can still edit it).</div>
            ${state.voiceUrls?.length ? `
            <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px">
              ${state.voiceUrls.map((u, i) => `
              <div style="display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:3px 9px;background:var(--green-soft);border:1px solid var(--green);border-radius:99px;color:var(--green)">
                ✓ ${escHtml(new URL(u).hostname)}
                <button style="background:none;border:none;cursor:pointer;color:var(--green);font-size:13px;line-height:1;padding:0;opacity:0.7" data-action="remove-voice-url" data-idx="${i}">×</button>
              </div>`).join('')}
            </div>` : ''}
          </div>
        </details>
      </div>

      <!-- ── AUDIENCE AVATAR ── -->
      <div class="settings-section">
        <div class="settings-section-title">Audience Avatar</div>
        <div class="settings-section-sub">Describe your average subscriber — who they are, what they do, and what they want from your newsletter. The AI uses this to shape what it emphasises, what context it provides, and how it frames every piece it writes.</div>
        <textarea id="audience-avatar" class="input" rows="6"
          style="width:100%;resize:vertical;font-size:13px;line-height:1.7;margin-top:14px;font-family:inherit"
          placeholder="e.g. Mid-level operators and founders in B2B SaaS — typically 30-45, based in the US. They have 5-10 years of experience and don't need basics explained. They read this newsletter first thing in the morning and want the sharpest take on what happened, not a summary of what they already saw on LinkedIn. They care about growth, efficiency, and competitive positioning. They're time-poor and sceptical of hype."
        >${escHtml(state.audienceAvatar || '')}</textarea>
        <div style="font-size:11px;color:var(--text-3);margin-top:5px">Saves automatically. The more specific you are, the better the writing.</div>
      </div>

      <!-- ── SECTION DEFAULTS ── -->
      ${(() => {
        const userSections = getUserSections();
        const hasBuilderSections = state.newsletter.sectionOrder?.length > 0;
        const typeOpts = [
          ['briefing', 'Today\'s Briefing (bulleted list)'],
          ['lead', 'Lead Story (long form)'],
          ['hits', 'Quick Hits (emoji bullets)'],
          ['cta', 'CTA / Sponsor'],
          ['generic', 'Generic'],
        ];
        return `<div class="settings-section">
        <div class="settings-section-title">Section Template${canUsePubs() ? ` <span style="font-size:11px;font-weight:600;color:var(--accent);background:var(--bg-3);padding:2px 8px;border-radius:99px;vertical-align:middle;margin-left:6px">📰 ${escHtml(currentPublicationName())}</span>` : ''}</div>
        <div class="settings-section-sub">These sections <strong>are</strong> your builder template — every new newsletter${canUsePubs() ? ' in <strong>' + escHtml(currentPublicationName()) + '</strong>' : ''} starts with exactly these sections, in this order, with these prompts pre-filled. Edit here and the builder follows.</div>
        ${userSections.length === 0 ? `
        <div style="padding:28px 24px;border:1px dashed var(--border-md);border-radius:var(--r-md);margin-top:16px;text-align:center">
          <div style="font-size:28px;margin-bottom:10px">📋</div>
          <div style="font-size:14px;font-weight:700;color:var(--text-1);margin-bottom:6px">Build your newsletter template</div>
          <div style="font-size:12px;color:var(--text-2);line-height:1.7;margin-bottom:20px;max-width:420px;margin-inline:auto">
            Enter your section names, one per line. We'll guess each section's style (you can change it after), and every new newsletter will start from this template.
          </div>
          <textarea id="sections-setup-input" class="input" rows="5"
            style="width:100%;max-width:400px;display:block;margin:0 auto 14px;text-align:left;font-size:13px;resize:vertical"
            placeholder="Today's Briefing&#10;Lead Story&#10;Quick Hits&#10;Sponsor / CTA"></textarea>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
            <button class="btn btn-primary" data-action="save-section-layout">Create template</button>
            ${hasBuilderSections ? `<button class="btn btn-outline" data-action="import-builder-sections">Use current builder sections</button>` : ''}
          </div>
        </div>
        ` : `
        <div style="display:flex;align-items:center;justify-content:space-between;margin:14px 0 16px">
          <div style="font-size:12px;color:var(--text-3)">${userSections.length} section${userSections.length === 1 ? '' : 's'} · new newsletters start here</div>
          <div style="display:flex;gap:6px">
            ${hasBuilderSections ? `<button class="btn btn-outline btn-sm" data-action="import-builder-sections">Sync from builder</button>` : ''}
            <button class="btn btn-ghost btn-sm" data-action="reset-section-layout" style="color:var(--red)">Reset</button>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:14px">
          ${userSections.map((s, i) => `
          <div style="border:1px solid var(--border-md);border-radius:var(--r-md);padding:12px 14px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
              <span style="font-size:11px;color:var(--text-3);width:18px">${i + 1}.</span>
              <span style="flex:1;font-size:13px;font-weight:600">${escHtml(s.name)}</span>
              <select class="input input-sm" onchange="setSectionDefaultType('${s.id}', this.value)" title="Content style" style="width:auto;font-size:11px;padding:3px 6px">
                ${typeOpts.map(([v, lbl]) => `<option value="${v}" ${s.type === v ? 'selected' : ''}>${lbl}</option>`).join('')}
              </select>
              <button class="btn-icon" data-action="remove-section-default" data-id="${s.id}" title="Remove from template" style="color:var(--red);font-size:14px">🗑</button>
            </div>
            <textarea class="input default-prompt-input" data-type="${s.id}" rows="2"
              style="width:100%;resize:vertical;font-size:12px"
              placeholder="Default AI instructions for this section (optional) — e.g. Lead with the hardest number, one sentence each."
            >${escHtml(state.defaultPrompts?.[s.id] || '')}</textarea>
          </div>`).join('')}
        </div>
        <button class="btn btn-outline btn-sm" data-action="add-section-default" style="margin-top:14px">+ Add a section</button>`}
      </div>`;
      })()}

      ` : tab === 'appearance' ? `

      <!-- ── DEFAULT TONE ── -->
      <div class="settings-section">
        <div class="settings-section-title">Default Tone</div>
        <div class="settings-section-sub">Applied to new newsletters. Can be changed per session in the builder.</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
          ${tones.map(t => `
          <button class="btn ${state.tone === t.id ? 'btn-primary' : 'btn-outline'}" data-action="select-tone" data-tone="${t.id}">
            ${t.label}
          </button>`).join('')}
        </div>
      </div>

      <!-- ── BRAND COLOR ── -->
      <div class="settings-section">
        <div class="settings-section-title">Brand Color</div>
        <div class="settings-section-sub">Used in email previews and exported HTML.</div>
        <div style="display:flex;align-items:center;gap:12px;margin-top:12px">
          <input type="color" id="color-picker" value="${state.design.primaryColor}" style="width:44px;height:36px;border:1px solid var(--border);border-radius:var(--r-sm);padding:2px;background:var(--bg-2);cursor:pointer">
          <span style="font-size:13px;color:var(--text-2);font-family:var(--font-mono)">${state.design.primaryColor}</span>
        </div>
      </div>

      ` : `

      <!-- ── API STATUS ── -->
      <div class="settings-section">
        <div class="settings-section-title">API Status</div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
          <div class="settings-api-row">
            <span>Anthropic (AI)</span>
            <span class="badge ${state.hasAI ? 'badge-green' : 'badge-default'}">${state.hasAI ? '✓ Connected' : 'Not configured'}</span>
          </div>
          <div class="settings-api-row">
            <span>Supabase (Database)</span>
            <span class="badge ${sb ? 'badge-green' : 'badge-default'}">${sb ? '✓ Connected' : 'Not configured'}</span>
          </div>
          <div class="settings-api-row">
            <span>Stripe (Payments)</span>
            <span class="badge ${state.hasStripe ? 'badge-green' : 'badge-default'}">${state.hasStripe ? '✓ Connected' : 'Not configured'}</span>
          </div>
          <div class="settings-api-row">
            <span>Beehiiv (Publish)</span>
            <span class="badge ${state.hasBeehiiv ? 'badge-green' : 'badge-default'}">${state.hasBeehiiv ? '✓ Connected' : 'Not configured'}</span>
          </div>
        </div>
        ${!state.hasBeehiiv ? `
        <div style="margin-top:14px;padding:14px 16px;background:var(--bg-3);border-radius:var(--r-md);font-size:12px;color:var(--text-2);line-height:1.7">
          To enable one-click Beehiiv publishing, add to your <code style="font-family:var(--font-mono);background:var(--bg-4);padding:1px 5px;border-radius:3px">.env</code> file:<br>
          <code style="font-family:var(--font-mono);font-size:11px;color:var(--text-1)">BEEHIIV_API_KEY=your-key</code><br>
          <code style="font-family:var(--font-mono);font-size:11px;color:var(--text-1)">BEEHIIV_PUBLICATION_ID=pub_xxx...</code><br>
          <span style="color:var(--text-3)">Find your API key at app.beehiiv.com → Settings → API. Your Publication ID appears in the URL when you open your publication.</span>
        </div>` : ''}
      </div>

      `}

    </div>
  </div>
</div>`;
}

function renderAppNav(active) {
  const email = state.user?.email || 'demo@example.com';
  const initial = email[0].toUpperCase();
  return `
<nav class="app-nav">
  <div class="app-nav-header">
    <div class="app-nav-logo">${logoSVG(26)}</div>
    ${canUsePubs() ? `
    <div class="nav-pub-chip" data-action="navigate" data-view="publications" title="Switch publication">
      📰 ${escHtml(currentPublicationName())}
    </div>` : ''}
  </div>
  <div class="nav-items">
    <div class="nav-item ${active === 'dashboard' ? 'active' : ''}" data-action="navigate" data-view="dashboard">
      <span class="icon">⊞</span> Dashboard
    </div>
    <div class="nav-item ${active === 'builder' ? 'active' : ''}" data-action="navigate" data-view="builder">
      <span class="icon">✎</span> Builder
    </div>
    <div class="nav-item ${active === 'sources' ? 'active' : ''}" data-action="navigate" data-view="sources">
      <span class="icon">📡</span> Sources
    </div>
    <div class="nav-item ${active === 'publications' ? 'active' : ''}" data-action="navigate" data-view="publications">
      <span class="icon">📰</span> Publications
    </div>
    <div class="nav-item ${active === 'subscription' ? 'active' : ''}" data-action="navigate" data-view="subscription">
      <span class="icon">✦</span> Subscription
    </div>
    <div class="nav-item ${active === 'settings' ? 'active' : ''}" data-action="navigate" data-view="settings">
      <span class="icon">⚙️</span> Settings
    </div>
    <div class="nav-item" style="color:var(--text-3);cursor:default;opacity:0.5" title="Coming soon — requires Beehiiv API">
      <span class="icon">📊</span> Analytics
    </div>
  </div>
  <div class="nav-bottom">
    <div class="theme-toggle-row" data-action="toggle-theme" title="${state.design.darkMode ? 'Switch to light mode' : 'Switch to dark mode'}">
      <span class="theme-toggle-icon">${state.design.darkMode ? '🌙' : '☀️'}</span>
      <span class="theme-toggle-label">${state.design.darkMode ? 'Dark mode' : 'Light mode'}</span>
      <div class="theme-toggle-pill">
        <div class="theme-toggle-knob ${state.design.darkMode ? '' : 'on'}"></div>
      </div>
    </div>
    <div class="user-row">
      <div class="user-avatar">${initial}</div>
      <div class="user-info">
        <div class="user-email">${email}</div>
        <div class="user-plan">${isSubscribed() ? '✦ Pro' : 'Free'}</div>
      </div>
    </div>
    <button class="logout-btn" data-action="logout">Sign out</button>
  </div>
</nav>`;
}

// ── BUILDER ───────────────────────────────────────────────────────────────────
function renderBuilder() {
  return `
<div class="builder-shell">
  <header class="builder-topbar">
    <div class="builder-topbar-left">
      <button class="btn btn-ghost btn-sm" data-action="navigate" data-view="dashboard">← Back</button>
      <input class="newsletter-title-input" value="${escHtml(state.newsletter.title)}" placeholder="Newsletter title..." spellcheck="false">
      <span class="save-pill">Auto-saved</span>
    </div>
    <div class="builder-topbar-center">
      ${canUsePubs() ? `<div class="nav-pub-chip" data-action="navigate" data-view="publications" title="Switch publication">📰 ${escHtml(currentPublicationName())}</div>` : ''}
      ${!state.hasAI ? `<div class="mock-badge">✦ Mock AI</div>` : `<div class="badge badge-green"><span class="dot dot-green"></span> AI Connected</div>`}
      <div id="voice-status-badge">${renderVoiceBadge()}</div>
    </div>
    <div class="builder-topbar-right">
      <button class="btn btn-ghost btn-sm" data-action="show-preview">⊙ Preview</button>
      <button class="btn btn-outline btn-sm" data-action="export-json">↓ JSON</button>
      <button class="btn btn-primary btn-sm" data-action="copy-html">⎘ Copy HTML</button>
    </div>
  </header>

  <div class="builder-body">
    <!-- Source Sidebar -->
    <aside class="source-sidebar" id="source-sidebar">
      <div class="source-sidebar-header">
        <span class="source-sidebar-title">Sources</span>
        <span class="text-xs text-dim">${state.sources.reduce((a,s)=>a+s.articles.length,0)} articles</span>
      </div>
      <form id="source-form" class="source-add-form">
        <input class="input input-sm" name="url" id="source-url-input" placeholder="RSS feed or article URL" autocomplete="off">
        <button type="submit" class="btn btn-sm btn-primary" id="source-add-btn">Add</button>
      </form>
      <div class="sources-list" id="sources-list">
        ${renderSourceSidebar()}
      </div>
    </aside>

    <!-- Editor -->
    <main class="editor-main" id="editor-main">
      <div class="newsletter-meta">
        <input id="subject-input" class="meta-input meta-subject" value="${escHtml(state.newsletter.subject)}" placeholder="Subject line — write something people can't ignore...">
        <input id="preview-input" class="meta-input meta-preview" value="${escHtml(state.newsletter.previewText)}" placeholder="Preview text — what shows in the inbox...">
      </div>
      <div id="editor-sections">
        ${renderEditorSections()}
      </div>
    </main>

    <!-- Right Panel -->
    <aside class="right-panel" id="right-panel">
      <div class="panel-tabs">
        <button class="panel-tab ${state.rightPanel === 'ai' ? 'active' : ''}" data-action="switch-panel" data-panel="ai">Generate</button>
        <button class="panel-tab ${state.rightPanel === 'design' ? 'active' : ''}" data-action="switch-panel" data-panel="design">Design</button>
        <button class="panel-tab ${state.rightPanel === 'team' ? 'active' : ''}" data-action="switch-panel" data-panel="team">Team</button>
      </div>
      <div class="panel-body" id="panel-body">
        ${renderPanelContent()}
      </div>
    </aside>
  </div>
</div>`;
}

// ── SOURCE SIDEBAR ────────────────────────────────────────────────────────────
function renderSourceSidebar() {
  if (state.sources.length === 0) {
    return `<div class="source-empty">
      <div class="source-empty-icon">📡</div>
      <strong style="color:var(--text-2);font-size:13px">No sources yet</strong>
      <p style="margin-top:6px">Paste an RSS feed URL or article link above to get started.</p>
      <div style="margin-top:14px;display:flex;flex-direction:column;gap:6px">
        <button class="btn btn-sm btn-outline" onclick="quickAddFeed('https://techcrunch.com/feed/')">Try TechCrunch</button>
        <button class="btn btn-sm btn-outline" onclick="quickAddFeed('https://feeds.bbci.co.uk/news/rss.xml')">Try BBC News</button>
      </div>
    </div>`;
  }

  const inSection = getAllSectionArticleIds();
  const allArticles = state.sources
    .flatMap(feed => feed.articles.map(a => ({ ...a, feedId: feed.id })))
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const totalFetching = state.sources.filter(s => s.articles.length === 0).length;

  return `
<div class="source-manager">
  ${state.sources.map(feed => `
  <div class="source-pill">
    <span class="dot dot-green" style="flex-shrink:0"></span>
    <span class="source-pill-name">${escHtml(feed.title)}</span>
    <span class="source-pill-count">${feed.articles.length}</span>
    <button class="feed-remove-btn" data-action="remove-feed" data-feed-id="${feed.id}" title="Remove">×</button>
  </div>`).join('')}
  ${totalFetching > 0 ? `<div style="font-size:11px;color:var(--text-3);padding:4px 2px">Fetching ${totalFetching} source${totalFetching > 1 ? 's' : ''}…</div>` : ''}
</div>
<div class="source-divider"></div>
${allArticles.length === 0
  ? `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12px">Fetching articles…</div>`
  : allArticles.map(a => renderArticleCard(a, a.feedId, inSection.has(a.id))).join('')
}`;
}

function renderFeedGroup(feed) {
  const inSection = getAllSectionArticleIds();
  return `
<div class="feed-group ${feed.collapsed ? 'collapsed' : ''}" id="feed-${feed.id}">
  <div class="feed-group-header" data-action="toggle-feed" data-feed-id="${feed.id}">
    <span class="feed-group-chevron">▾</span>
    <span class="dot dot-green"></span>
    <span class="feed-group-name">${escHtml(feed.title)}</span>
    <span class="feed-group-count">${feed.articles.length}</span>
    <button class="feed-remove-btn" data-action="remove-feed" data-feed-id="${feed.id}" title="Remove source">×</button>
  </div>
  <div class="feed-articles">
    ${feed.articles.map(a => renderArticleCard(a, feed.id, inSection.has(a.id))).join('')}
  </div>
</div>`;
}

function firstSectionOfType(type) {
  return state.newsletter.sectionOrder.find(id => state.newsletter.sectionMeta[id]?.type === type) || null;
}
window.firstSectionOfType = firstSectionOfType;

function renderArticleCard(article, feedId, isInSection) {
  // A picker for every section in the newsletter — including custom ones — so
  // articles can be added anywhere, not just the two built-in sections.
  const options = state.newsletter.sectionOrder.map(id => {
    const m = state.newsletter.sectionMeta[id] || { name: id };
    return `<option value="${id}">${escHtml(m.name)}</option>`;
  }).join('');
  const dblTarget = firstSectionOfType('lead') || 'leadStory';
  return `
<div class="article-card ${isInSection ? 'in-section' : ''}"
  draggable="true"
  data-article-id="${article.id}"
  data-feed-id="${feedId}"
  ondragstart="dragStart(event,'${article.id}')"
  ondragend="dragEnd(event)"
  ondblclick="addToSection('${article.id}','${dblTarget}')">
  <div class="article-card-title">${escHtml(article.title)}</div>
  <div class="article-card-meta">
    <span class="article-card-source">${escHtml(article.source || '')}</span>
    <span class="article-card-time">${article.timeAgo || ''}</span>
  </div>
  <div class="article-card-actions">
    <select class="article-card-btn" title="Add this article to a section"
      style="flex:1;min-width:0;cursor:pointer"
      onchange="if(this.value){addToSection('${article.id}',this.value);this.selectedIndex=0;}">
      <option value="">＋ Add to section…</option>
      ${options}
    </select>
    <button class="article-card-btn remove-btn" data-action="remove-article" data-feed-id="${feedId}" data-article-id="${article.id}" title="Remove article">×</button>
  </div>
</div>`;
}

async function submitAddSource(form) {
  const input = form.querySelector('#source-url-input');
  const btn = form.querySelector('#source-add-btn');
  const url = input.value.trim();
  if (!url) return;
  input.disabled = true;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch(`/api/ingest?url=${encodeURIComponent(url)}&quick=1`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed to fetch');
    const existing = state.sources.find(s => s.feedUrl === url);
    if (existing) { toast('Feed already added', 'warn'); return; }
    const newSource = {
      id: uid(),
      feedUrl: url,
      title: data.source || new URL(url).hostname,
      type: data.type,
      articles: data.articles || [],
      collapsed: false,
    };
    state.sources.push(newSource);
    saveSourcesLocally();
    await saveSourceToDB(newSource);
    input.value = '';
    toast(`Added ${data.articles?.length || 0} articles from "${data.source}"`, 'success');
    refreshSourceSidebar();
  } catch (e) {
    toast(`Error: ${e.message}`, 'error');
  } finally {
    input.disabled = false;
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

function quickAddFeed(url) {
  const input = document.getElementById('source-url-input');
  if (input) { input.value = url; }
  const form = document.getElementById('source-form');
  if (form) submitAddSource(form);
}
window.quickAddFeed = quickAddFeed;

function toggleFeed(feedId) {
  const feed = state.sources.find(s => s.id === feedId);
  if (feed) { feed.collapsed = !feed.collapsed; refreshSourceSidebar(); }
}

function removeFeed(feedId) {
  state.sources = state.sources.filter(s => s.id !== feedId);
  saveSourcesLocally();
  deleteSourceFromDB(feedId);
  refreshSourceSidebar();
  toast('Source removed', 'info');
}

function removeArticle(feedId, articleId) {
  const feed = state.sources.find(s => s.id === feedId);
  if (feed) { feed.articles = feed.articles.filter(a => a.id !== articleId); refreshSourceSidebar(); }
}

function refreshSourceSidebar() {
  const el = document.getElementById('sources-list');
  if (el) el.innerHTML = renderSourceSidebar();
}

// ── DRAG AND DROP ─────────────────────────────────────────────────────────────
function dragStart(e, articleId) {
  state.draggedArticleId = articleId;
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', articleId);
  setTimeout(() => { e.target.classList.add('dragging'); }, 0);
}
window.dragStart = dragStart;

function dragEnd(e) {
  e.target.classList.remove('dragging');
  state.draggedArticleId = null;
}
window.dragEnd = dragEnd;

function storyDragStart(e, articleId, sectionId) {
  state.draggedStory = { articleId, sectionId };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
  setTimeout(() => { e.target.classList.add('dragging'); }, 0);
}
window.storyDragStart = storyDragStart;

function storyDragEnd(e) {
  e.target.classList.remove('dragging');
  state.draggedStory = null;
}
window.storyDragEnd = storyDragEnd;

function setupDropZones() {
  document.querySelectorAll('.section-drop-zone').forEach(zone => {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const toSection = zone.dataset.section;

      if (state.draggedStory) {
        const { articleId, sectionId: fromSection } = state.draggedStory;
        const blocks = [...zone.querySelectorAll('.story-block')].filter(b => b.id !== `story-${articleId}`);
        let insertIdx = blocks.length;
        for (let i = 0; i < blocks.length; i++) {
          const rect = blocks[i].getBoundingClientRect();
          if (e.clientY < rect.top + rect.height / 2) { insertIdx = i; break; }
        }
        reorderStory(articleId, fromSection, toSection, insertIdx);
      } else {
        const articleId = state.draggedArticleId || e.dataTransfer.getData('text/plain');
        if (articleId && toSection) addToSection(articleId, toSection);
      }
    });
  });
}

function reorderStory(articleId, fromSection, toSection, insertIdx) {
  const fromArr = state.newsletter.sections[fromSection];
  const idx = fromArr.findIndex(a => a.id === articleId);
  if (idx === -1) return;
  const [article] = fromArr.splice(idx, 1);
  const toArr = state.newsletter.sections[toSection];
  toArr.splice(insertIdx, 0, article);
  if (fromSection !== toSection) refreshSectionContent(fromSection);
  refreshSectionContent(toSection);
  scheduleSave();
}

// ── SECTIONS ──────────────────────────────────────────────────────────────────
function renderEditorSections() {
  return state.newsletter.sectionOrder.map(id => {
    const meta = state.newsletter.sectionMeta[id] || { name: id, type: 'generic' };
    if (meta.type === 'briefing') return renderTopStoriesSection(id, meta.name);
    return renderSection(id, meta.name, meta.type);
  }).join('') + `<div style="padding:12px 0;text-align:center;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
    <button class="btn btn-ghost btn-sm" data-action="show-add-section">+ Add section</button>
    <button class="btn btn-ghost btn-sm" data-action="save-section-default" title="Use this section layout & prompts for every new newsletter${canUsePubs() ? ' in this publication' : ''}">★ Save as default layout</button>
    ${state.defaultPrompts?._layout ? `<button class="btn btn-ghost btn-sm" data-action="clear-section-default" title="Go back to the standard sections for new newsletters" style="color:var(--text-3)">Reset default</button>` : ''}
  </div>`;
}

function renderTopStoriesSection(sectionId = 'topStories', sectionName = "Today's Briefing") {
  const articles = state.newsletter.sections[sectionId] || [];
  const content  = state.newsletter.topStoriesContent;
  const canRemove = state.newsletter.sectionOrder.length > 1;
  const promptOpen = !!(state._expandedPrompts?.[sectionId]);
  const hasCustomPrompt = !!(state.newsletter.prompts[sectionId]);
  return `
<div class="editor-section" id="section-${sectionId}" draggable="true"
  ondragstart="sectionDragStart(event,'${sectionId}')"
  ondragend="sectionDragEnd(event)"
  ondragover="sectionDragOver(event,'${sectionId}')"
  ondrop="sectionDrop(event,'${sectionId}')">
  <div class="section-header">
    <span class="section-drag-handle" onmousedown="state._sectionDragReady='${sectionId}'" title="Drag to reorder">⠿</span>
    <span class="section-label" data-action="rename-section" data-section-id="${sectionId}" title="Click to rename" style="cursor:pointer">${escHtml(sectionName)}</span>
    <div class="section-prompt-wrap" style="gap:6px">
      ${promptOpen ? `
        <input class="section-prompt" data-section="${sectionId}" value="${escHtml(state.newsletter.prompts[sectionId] || '')}" placeholder="Optional style instructions…" style="font-size:11px">
        <button class="btn btn-sm btn-ghost" data-action="briefing-prompt-from-examples" title="Paste past briefings to generate a prompt">✨</button>
      ` : ''}
      <button class="btn btn-sm btn-ghost section-prompt-toggle ${promptOpen ? 'active' : ''} ${hasCustomPrompt && !promptOpen ? 'has-value' : ''}" data-action="toggle-section-prompt" data-section-id="${sectionId}" title="${promptOpen ? 'Hide custom prompt' : 'Customize prompt for this issue'}">✏</button>
      <button class="btn btn-sm btn-primary" data-action="generate-top-stories" ${articles.length === 0 ? 'disabled title="Drop articles first"' : ''}>▶ Generate</button>
      ${canRemove ? `<button class="btn btn-sm btn-ghost" data-action="remove-section" data-section-id="${sectionId}" title="Delete this section" style="color:var(--red);padding:2px 6px">🗑</button>` : ''}
    </div>
  </div>
  <div class="section-drop-zone" data-section="${sectionId}">
    <div class="section-content" id="section-content-${sectionId}">
      ${articles.length === 0 && !content ? `
      <div class="drop-placeholder">
        <div class="drop-placeholder-icon">⊕</div>
        <p>Drag 3–6 articles here</p>
        <small>One-click generates a bulleted briefing with sources</small>
      </div>` : `
      <div style="padding:10px 12px">
        ${articles.length > 0 ? `
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:${content ? '10px' : '0'}">
          ${articles.map(a => `
          <div style="display:flex;align-items:center;gap:5px;background:var(--bg-3);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-size:11px">
            <span style="color:var(--text-2)">${escHtml(a.source || a.title.slice(0,20))}</span>
            <button style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:13px;padding:0;line-height:1" data-action="remove-top-story" data-article-id="${a.id}">×</button>
          </div>`).join('')}
        </div>` : ''}
        ${content ? `
        <div class="top-stories-preview">${formatTopStories(content)}</div>
        <div class="story-actions" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <button class="story-action-btn" data-action="edit-top-stories">✎ Edit</button>
          <button class="story-action-btn" data-action="generate-top-stories" ${articles.length === 0 ? 'disabled' : ''}>↺ Regenerate</button>
          <button class="story-action-btn danger" data-action="clear-top-stories">× Clear</button>
        </div>` : ''}
      </div>`}
    </div>
  </div>
</div>`;
}

function formatTopStories(text) {
  if (!text) return '';
  return text.split('\n')
    .filter(line => line.trim())
    .map(line => {
      // Convert plain URLs to clickable links
      const linked = escHtml(line).replace(
        /https?:\/\/[^\s]+/g,
        url => `<a href="${url}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-size:11px">${url}</a>`
      );
      return `<div class="briefing-bullet">${linked}</div>`;
    })
    .join('');
}

// ── MULTI-SOURCE SYNTHESIS SECTIONS (lead story + quick hits) ──────────────────
function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Which section types stage multiple articles then generate one combined output.
function isSynthType(type) { return type === 'lead' || type === 'hits'; }

function synthConfig(sectionId) {
  const type = state.newsletter.sectionMeta[sectionId]?.type || 'generic';
  if (type === 'hits') {
    return { type, action: 'quick-hits', noun: 'quick hits', label: 'Quick hits',
      promptPlaceholder: 'Style instructions for the list…',
      sourcesLabel: 'staged — add more from the sidebar, then Generate',
      awaiting: n => `turn ${n} article${n === 1 ? '' : 's'} into a bulleted list with a sources footer` };
  }
  return { type, action: 'lead-story', noun: 'lead story', label: 'Lead story',
    promptPlaceholder: 'Angle / instructions for this story…',
    sourcesLabel: 'on this story — add more from the sidebar, then Generate',
    awaiting: n => `synthesize ${n} report${n === 1 ? '' : 's'} into one lead story with source links` };
}

function toLeadSource(a) {
  return {
    id: a.id || uid(),
    title: a.title || '',
    source: a.source || hostnameOf(a.url) || '',
    url: a.url || '',
    summary: a.summary || '',
    text: a.text ? a.text.slice(0, 6000) : '',
  };
}

// Returns the single synthesis entry for a section. Migrates any legacy
// per-article entries into one entry's _sources list. Pass create=true to make one.
function getLeadEntry(sectionId, create = false) {
  const arr = state.newsletter.sections[sectionId] || (state.newsletter.sections[sectionId] = []);
  let entry = arr.find(a => a._lead);
  if (!entry && arr.length) {
    const legacy = arr.splice(0, arr.length);
    const joiner = state.newsletter.sectionMeta[sectionId]?.type === 'hits' ? '\n' : '\n\n';
    const merged = legacy.filter(l => l.content).map(l => l.content).join(joiner);
    entry = {
      id: uid(), _lead: true,
      _sources: legacy.map(toLeadSource),
      content: merged || null,
    };
    arr.push(entry);
  }
  if (!entry && create) { entry = { id: uid(), _lead: true, _sources: [], content: null }; arr.push(entry); }
  return entry;
}

async function generateLeadStory(sectionId) {
  const { action, noun } = synthConfig(sectionId);
  const entry = getLeadEntry(sectionId, true);
  const sources = entry._sources || [];
  if (!sources.length) { toast('Add at least one article first', 'warn'); return; }
  entry.loading = true; entry.editing = false;
  refreshSectionContent(sectionId);
  const opts = { prompt: effectivePrompt(sectionId), contents: sources };
  try {
    await hydrateAll(sources); // ensure full source text before synthesizing

    // Live-render the text as it streams in. First token swaps the skeleton for
    // the story block; later tokens update just the content node (no full re-render).
    let first = true;
    const onDelta = (text) => {
      entry.content = text;
      if (first) { first = false; entry.loading = false; refreshSectionContent(sectionId); }
      else { const el = document.querySelector(`#story-${entry.id} .story-content`); if (el) el.innerHTML = formatContent(text); }
    };

    try {
      entry.content = await callAIStream(action, sources[0], opts, onDelta);
    } catch (streamErr) {
      if (['subscription_required', 'generation_limit'].includes(streamErr.message)) throw streamErr;
      // Streaming hiccup — fall back to the proven non-streaming path so generation never breaks
      console.warn('Streaming failed, falling back:', streamErr.message);
      entry.content = await callAI(action, sources[0], opts);
    }
    toast(`${noun.charAt(0).toUpperCase() + noun.slice(1)} generated from ${sources.length} article${sources.length === 1 ? '' : 's'}`, 'success');
  } catch (e) {
    if (!['subscription_required', 'generation_limit'].includes(e.message)) toast('Generation failed: ' + e.message, 'error');
  }
  entry.loading = false;
  refreshSectionContent(sectionId);
  scheduleSave();
}

function removeLeadSource(sectionId, articleId) {
  const entry = getLeadEntry(sectionId);
  if (!entry) return;
  entry._sources = entry._sources.filter(s => s.id !== articleId);
  if (!entry._sources.length && !entry.content) {
    state.newsletter.sections[sectionId] = state.newsletter.sections[sectionId].filter(a => a !== entry);
  }
  refreshSection(sectionId);
  refreshSourceSidebar();
  scheduleSave();
}

function renderLeadSection(sectionId, label) {
  const cfg = synthConfig(sectionId);
  const prompt = state.newsletter.prompts[sectionId] || '';
  const canRemove = state.newsletter.sectionOrder.length > 1;
  const promptOpen = !!(state._expandedPrompts?.[sectionId]);
  const hasCustomPrompt = !!prompt;
  const entry = getLeadEntry(sectionId);
  const n = entry?._sources?.length || 0;
  return `
<div class="editor-section" id="section-${sectionId}" draggable="true"
  ondragstart="sectionDragStart(event,'${sectionId}')"
  ondragend="sectionDragEnd(event)"
  ondragover="sectionDragOver(event,'${sectionId}')"
  ondrop="sectionDrop(event,'${sectionId}')">
  <div class="section-header">
    <span class="section-drag-handle" onmousedown="state._sectionDragReady='${sectionId}'" title="Drag to reorder">⠿</span>
    <span class="section-label" data-action="rename-section" data-section-id="${sectionId}" title="Click to rename" style="cursor:pointer">${escHtml(label)}</span>
    <div class="section-prompt-wrap">
      ${promptOpen ? `<input class="section-prompt" data-section="${sectionId}" value="${escHtml(prompt)}" placeholder="${cfg.promptPlaceholder}">` : ''}
      <button class="btn btn-sm btn-ghost section-prompt-toggle ${promptOpen ? 'active' : ''} ${hasCustomPrompt && !promptOpen ? 'has-value' : ''}" data-action="toggle-section-prompt" data-section-id="${sectionId}" title="${promptOpen ? 'Hide custom prompt' : 'Customize prompt for this issue'}">✏</button>
      <button class="btn btn-sm btn-primary" data-action="generate-lead-story" data-section="${sectionId}">✦ Generate${n > 1 ? ` (${n})` : ''}</button>
      ${canRemove ? `<button class="btn btn-sm btn-ghost" data-action="remove-section" data-section-id="${sectionId}" title="Delete this section" style="color:var(--red);padding:2px 6px">🗑</button>` : ''}
    </div>
  </div>
  <div class="section-drop-zone" data-section="${sectionId}">
    <div class="section-content" id="section-content-${sectionId}">
      ${renderLeadBody(sectionId)}
    </div>
  </div>
</div>`;
}

function renderLeadSourcesBlock(sectionId, sources) {
  const cfg = synthConfig(sectionId);
  const chips = sources.map(s => `
    <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:8px">
      <span style="font-size:11px;font-weight:700;color:var(--accent);white-space:nowrap">${escHtml(s.source || 'Source')}</span>
      <span style="flex:1;min-width:0;font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(s.title || '')}">${escHtml(s.title || '(untitled)')}</span>
      ${s.url ? `<a href="${escHtml(s.url)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--text-3);text-decoration:none" title="Open original">↗</a>` : ''}
      <button class="btn-ghost btn-sm" style="font-size:13px;padding:0 6px;color:var(--red)" data-action="remove-lead-source" data-section="${sectionId}" data-article-id="${s.id}" title="Remove source">×</button>
    </div>`).join('');
  return `
    <div style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:600;color:var(--text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em">
        ${sources.length} ${cfg.type === 'hits' ? 'article' : 'source'}${sources.length === 1 ? '' : 's'} ${cfg.sourcesLabel}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">${chips}</div>
    </div>`;
}

function renderLeadBody(sectionId) {
  const cfg = synthConfig(sectionId);
  const entry = getLeadEntry(sectionId);
  const sources = entry?._sources || [];
  if (!sources.length && !entry?.content) return renderDropPlaceholder(sectionId);

  const sourcesBlock = renderLeadSourcesBlock(sectionId, sources);

  if (entry?.loading) {
    return sourcesBlock + `<div class="story-block loading" id="story-${entry.id}">
      <div class="story-block-header"><span class="story-source">${cfg.label}</span>
        <span style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--accent)"><div class="spinner"></div> Generating…</span>
      </div>
      <div class="story-skeleton">
        <div class="skeleton-line h-10 w-full"></div><div class="skeleton-line h-10 w-80"></div>
        <div class="skeleton-line h-8 w-full"></div><div class="skeleton-line h-8 w-65"></div>
        <div class="skeleton-line h-8 w-80"></div><div class="skeleton-line h-8 w-45"></div>
      </div></div>`;
  }

  if (entry?.editing) {
    const content = entry.content || '';
    const rows = Math.max(6, (content.match(/\n/g) || []).length + 3);
    return sourcesBlock + `<div class="story-block editing" id="story-${entry.id}">
      <div class="story-block-header"><span class="story-source">${cfg.label}</span>
        <span style="margin-left:auto;font-size:10px;color:var(--accent);font-weight:600">EDITING</span></div>
      <textarea class="story-edit-textarea" data-article-id="${entry.id}" data-section="${sectionId}" rows="${rows}"
        style="width:100%;box-sizing:border-box;padding:12px;font-size:13px;line-height:1.7;font-family:var(--font-mono);border:none;background:var(--bg-1);color:var(--text-1);resize:vertical;outline:none;border-bottom:1px solid var(--border)">${escHtml(content)}</textarea>
      <div class="story-actions">
        <button class="story-action-btn primary" data-action="save-story-edit" data-article-id="${entry.id}" data-section="${sectionId}">✓ Done</button>
        <button class="story-action-btn" data-action="cancel-story-edit" data-article-id="${entry.id}" data-section="${sectionId}">✕ Cancel</button>
      </div></div>`;
  }

  if (!entry?.content) {
    return sourcesBlock + `<div style="padding:16px;text-align:center;border:1px dashed var(--border);border-radius:8px;color:var(--text-3);font-size:13px;line-height:1.6">
      Ready — click <strong style="color:var(--text-2)">✦ Generate</strong> to ${cfg.awaiting(sources.length)}.
    </div>`;
  }

  return sourcesBlock + `<div class="story-block" id="story-${entry.id}">
    <div class="story-block-header">
      <span class="story-source">${cfg.label}</span>
      <button class="btn-ghost btn-sm" style="margin-left:auto;font-size:11px;padding:2px 7px" data-action="edit-story" data-article-id="${entry.id}" data-section="${sectionId}">✎ Edit</button>
    </div>
    <div class="story-content">${formatContent(entry.content)}</div>
    <div class="story-actions">
      <button class="story-action-btn" data-action="generate-lead-story" data-section="${sectionId}">↺ Regenerate</button>
      <button class="story-action-btn" data-action="edit-story" data-article-id="${entry.id}" data-section="${sectionId}">✎ Edit</button>
      <button class="story-action-btn" data-action="insert-image" data-article-id="${entry.id}" data-section="${sectionId}">⊞ Image</button>
    </div>
  </div>`;
}

function renderSection(sectionId, label, type = 'hits') {
  if (isSynthType(type)) return renderLeadSection(sectionId, label);
  const articles = state.newsletter.sections[sectionId] || [];
  const prompt = state.newsletter.prompts[sectionId] || '';
  const isGrid = type === 'hits' || type === 'generic';
  const canRemove = state.newsletter.sectionOrder.length > 1;
  const promptOpen = !!(state._expandedPrompts?.[sectionId]);
  const hasCustomPrompt = !!prompt;
  return `
<div class="editor-section" id="section-${sectionId}" draggable="true"
  ondragstart="sectionDragStart(event,'${sectionId}')"
  ondragend="sectionDragEnd(event)"
  ondragover="sectionDragOver(event,'${sectionId}')"
  ondrop="sectionDrop(event,'${sectionId}')">
  <div class="section-header">
    <span class="section-drag-handle" onmousedown="state._sectionDragReady='${sectionId}'" title="Drag to reorder">⠿</span>
    <span class="section-label" data-action="rename-section" data-section-id="${sectionId}" title="Click to rename" style="cursor:pointer">${escHtml(label)}</span>
    <div class="section-prompt-wrap">
      ${promptOpen ? `<input class="section-prompt" data-section="${sectionId}" value="${escHtml(prompt)}" placeholder="Section prompt for this issue…">` : ''}
      <button class="btn btn-sm btn-ghost section-prompt-toggle ${promptOpen ? 'active' : ''} ${hasCustomPrompt && !promptOpen ? 'has-value' : ''}" data-action="toggle-section-prompt" data-section-id="${sectionId}" title="${promptOpen ? 'Hide custom prompt' : 'Customize prompt for this issue'}">✏</button>
      <button class="btn btn-sm btn-primary" data-action="apply-prompt" data-section="${sectionId}" title="Write each article in this section with AI">✦ Generate</button>
      ${canRemove ? `<button class="btn btn-sm btn-ghost" data-action="remove-section" data-section-id="${sectionId}" title="Delete this section" style="color:var(--red);padding:2px 6px">🗑</button>` : ''}
    </div>
  </div>
  <div class="section-drop-zone" data-section="${sectionId}">
    <div class="section-content ${isGrid && articles.length > 0 ? 'quick-hits-grid' : ''}" id="section-content-${sectionId}">
      ${articles.length === 0 ? renderDropPlaceholder(sectionId) : articles.map(a => renderStoryBlock(a, sectionId)).join('')}
    </div>
  </div>
</div>`;
}

function refreshTopStoriesSection() {
  // Find the briefing-type section id (may be custom)
  const briefingId = state.newsletter.sectionOrder.find(id => state.newsletter.sectionMeta[id]?.type === 'briefing') || 'topStories';
  const briefingName = state.newsletter.sectionMeta[briefingId]?.name || "Today's Briefing";
  const el = document.getElementById(`section-${briefingId}`);
  if (el) el.outerHTML = renderTopStoriesSection(briefingId, briefingName);
  else render();
  setupDropZones();
}

function removeTopStory(articleId) {
  const briefingId = state.newsletter.sectionOrder.find(id => state.newsletter.sectionMeta[id]?.type === 'briefing') || 'topStories';
  if (state.newsletter.sections[briefingId]) {
    state.newsletter.sections[briefingId] = state.newsletter.sections[briefingId].filter(a => a.id !== articleId);
  }
  refreshTopStoriesSection();
  scheduleSave();
}

async function generateTopStories() {
  const briefingId = state.newsletter.sectionOrder.find(id => state.newsletter.sectionMeta[id]?.type === 'briefing') || 'topStories';
  const articles = state.newsletter.sections[briefingId] || [];
  if (!articles.length) { toast('Drop articles into Today\'s Briefing first', 'warn'); return; }
  const generateBtn = document.querySelector('[data-action="generate-top-stories"]');
  if (generateBtn) { generateBtn.disabled = true; generateBtn.textContent = '…'; }
  try {
    await hydrateAll(articles); // ensure full text before generating the briefing
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'top-stories',
        contents: articles,
        tone: state.tone,
        prompt: state.newsletter.prompts[briefingId] || '',
        brandVoice: state.brandVoice,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    state.newsletter.topStoriesContent = data.result;
    scheduleSave();
    toast('Briefing generated', 'success');
  } catch (e) {
    toast('Generation failed: ' + e.message, 'error');
  } finally {
    const btn = document.querySelector('[data-action="generate-top-stories"]');
    if (btn) { btn.disabled = false; btn.textContent = '▶ Generate'; }
  }
  refreshTopStoriesSection();
}

function editTopStories() {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  const rows = Math.max(8, (state.newsletter.topStoriesContent.match(/\n/g) || []).length + 3);
  modal.innerHTML = `
  <div class="modal-overlay" id="ts-edit-overlay">
    <div class="modal" style="max-width:560px">
      <div class="modal-header">
        <div><div class="modal-title">Edit Today's Briefing</div></div>
        <button class="btn-icon" data-action="close-modal" style="font-size:18px;line-height:1">×</button>
      </div>
      <div class="modal-body" style="padding:16px 20px">
        <textarea id="ts-edit-textarea" class="input" rows="${rows}"
          style="width:100%;box-sizing:border-box;font-family:var(--font-mono);font-size:12px;line-height:1.7;resize:vertical;margin-bottom:12px"
        >${escHtml(state.newsletter.topStoriesContent)}</textarea>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" style="flex:1" onclick="saveTopStoriesEdit()">Save</button>
          <button class="btn btn-outline" data-action="close-modal">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
  modal.querySelector('#ts-edit-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  modal.querySelector('#ts-edit-textarea').focus();
}

function saveTopStoriesEdit() {
  const ta = document.getElementById('ts-edit-textarea');
  if (ta) { state.newsletter.topStoriesContent = ta.value; scheduleSave(); }
  closeModal();
  refreshTopStoriesSection();
}
window.saveTopStoriesEdit = saveTopStoriesEdit;

function showBriefingPromptModal() {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  modal.innerHTML = `
  <div class="modal-overlay" id="bp-modal-overlay">
    <div class="modal" style="max-width:560px">
      <div class="modal-header">
        <div>
          <div class="modal-title">Generate briefing prompt from examples</div>
          <div class="modal-sub">Paste URLs to past newsletters or briefing lines directly. Curanta will analyze the style and write a prompt that reproduces it.</div>
        </div>
        <button class="btn-icon" data-action="close-modal" style="font-size:18px;line-height:1">×</button>
      </div>
      <div class="modal-body" style="padding:16px 20px">
        <div style="margin-bottom:12px">
          <label style="font-size:12px;font-weight:600;color:var(--text-2);display:block;margin-bottom:6px">Past newsletter URLs (one per line)</label>
          <textarea id="briefing-url-input" class="input" rows="3"
            placeholder="https://example.com/newsletter-issue-47&#10;https://example.com/newsletter-issue-46"
            style="width:100%;box-sizing:border-box;font-size:12px;line-height:1.7;resize:vertical;margin-bottom:8px"></textarea>
          <button class="btn btn-outline btn-sm" data-action="fetch-briefing-examples" id="fetch-bp-btn">↓ Fetch content</button>
        </div>
        <div style="margin-bottom:12px">
          <label style="font-size:12px;font-weight:600;color:var(--text-2);display:block;margin-bottom:6px">Briefing examples (paste or auto-filled after fetch)</label>
          <textarea id="briefing-examples-input" class="input" rows="8"
            placeholder="Paste your past briefing lines here, e.g.:&#10;📉 83% of school districts' reading scores declined since 2015 https://…&#10;📈 Fed holds rates at 5.25% for third straight meeting https://…&#10;🏛️ Senate passes $1.2T infrastructure bill 69-30 https://…"
            style="width:100%;box-sizing:border-box;font-size:12px;line-height:1.7;resize:vertical"></textarea>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" style="flex:1" data-action="generate-briefing-prompt" id="gen-bp-btn">✨ Generate prompt</button>
          <button class="btn btn-outline" data-action="close-modal">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
  modal.querySelector('#bp-modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  modal.querySelector('#briefing-url-input').focus();
}

async function fetchBriefingExamples() {
  const urlInput = document.getElementById('briefing-url-input');
  const examplesInput = document.getElementById('briefing-examples-input');
  const fetchBtn = document.getElementById('fetch-bp-btn');
  const raw = urlInput?.value?.trim();
  if (!raw) { toast('Paste some newsletter URLs first', 'warn'); return; }

  const urls = raw.split(/[\n,]+/).map(u => u.trim()).filter(u => {
    try { new URL(u); return true; } catch { return false; }
  });
  if (!urls.length) { toast('No valid URLs found', 'warn'); return; }

  if (fetchBtn) { fetchBtn.disabled = true; fetchBtn.textContent = 'Fetching…'; }

  const results = await Promise.allSettled(
    urls.map(async url => {
      const res = await fetch(`/api/ingest?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Could not fetch');
      return data.articles?.map(a => [a.title, a.text || a.summary].filter(Boolean).join('\n\n')).join('\n\n---\n\n') || '';
    })
  );

  let added = 0, failed = 0;
  const texts = [];
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value.trim()) { texts.push(r.value); added++; }
    else failed++;
  });

  if (texts.length && examplesInput) {
    const existing = examplesInput.value.trim();
    examplesInput.value = [existing, ...texts].filter(Boolean).join('\n\n---\n\n');
  }

  if (fetchBtn) { fetchBtn.disabled = false; fetchBtn.textContent = '↓ Fetch content'; }
  if (added) toast(`${added} newsletter${added > 1 ? 's' : ''} fetched${failed ? `, ${failed} failed` : ''}`, 'success');
  else toast(`All URLs failed to fetch`, 'error');
}

async function generateBriefingPrompt() {
  const ta = document.getElementById('briefing-examples-input');
  const examples = ta?.value?.trim();
  if (!examples) { toast('Paste some example briefing lines first', 'warn'); return; }
  const btn = document.getElementById('gen-bp-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing…'; }
  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'briefing-prompt',
        content: { text: examples },
        tone: state.tone,
        brandVoice: state.brandVoice,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    const briefingId = state.newsletter.sectionOrder.find(id => state.newsletter.sectionMeta[id]?.type === 'briefing') || 'topStories';
    state.newsletter.prompts[briefingId] = data.result;
    closeModal();
    refreshTopStoriesSection();
    scheduleSave();
    toast('Briefing prompt generated — tweak it in the prompt field if needed', 'success');
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '✨ Generate prompt'; }
  }
}

function renderDropPlaceholder(sectionId) {
  const cfg = {
    leadStory: {
      icon: '📰',
      label: 'No lead story yet',
      hint: 'Add one or more articles about the same event — AI synthesizes one story with source links.',
      steps: [
        'Drag in every article covering this story (from any outlet)',
        'They stage as sources — nothing generates yet',
        'Click ✦ Generate — AI merges them into one story with hyperlinks',
      ],
    },
    quickHits: {
      icon: '⚡',
      label: 'No quick hits yet',
      hint: 'Add a few articles — each becomes one emoji bullet, with a shared sources footer.',
      steps: [
        'Drag in several articles (different stories)',
        'They stage as a list — nothing generates yet',
        'Click ✦ Generate — one emoji line per story + a Sources: footer',
      ],
    },
    cta: {
      icon: '📣',
      label: 'No CTA yet',
      hint: 'Add a sponsor blurb, link, or call to action.',
      steps: [
        'Paste your sponsor\'s page URL in Sources',
        'Add it here via the article\'s ＋ Add to section menu',
        'Click ✦ Generate — AI writes a native-feeling CTA',
      ],
    },
  };
  const c = cfg[sectionId] || { icon: '⊕', label: 'No articles yet', hint: 'Add articles with each card\'s ＋ Add to section menu, or drag them in from the Sources panel.', steps: [] };
  return `<div class="drop-placeholder">
    <div class="drop-placeholder-icon">${c.icon}</div>
    <p>${c.label}</p>
    <small>${c.hint}</small>
    ${c.steps.length ? `<div class="drop-placeholder-steps">
      ${c.steps.map((s, i) => `<div class="drop-step"><div class="drop-step-num">${i+1}</div><span>${s}</span></div>`).join('')}
    </div>` : ''}
  </div>`;
}

function renderStoryBlock(article, sectionId) {
  if (article.loading) {
    return `<div class="story-block loading" id="story-${article.id}">
      <div class="story-block-header">
        <span class="story-source">${escHtml(article.source || 'Article')}</span>
        <span style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--accent)">
          <div class="spinner"></div> Writing with AI…
        </span>
      </div>
      <div class="story-skeleton">
        <div class="skeleton-label"></div>
        <div class="skeleton-line h-10 w-full"></div>
        <div class="skeleton-line h-10 w-80"></div>
        <div class="skeleton-label" style="margin-top:4px"></div>
        <div class="skeleton-line h-8 w-full"></div>
        <div class="skeleton-line h-8 w-65"></div>
        <div class="skeleton-line h-8 w-80"></div>
        <div class="skeleton-label" style="margin-top:4px"></div>
        <div class="skeleton-line h-8 w-full"></div>
        <div class="skeleton-line h-8 w-45"></div>
      </div>
    </div>`;
  }
  const content = article.content || article.summary || article.text || '';

  if (article.editing) {
    const rows = Math.max(6, (content.match(/\n/g) || []).length + 3);
    return `<div class="story-block editing" id="story-${article.id}">
      <div class="story-block-header">
        <span class="story-drag-handle">⠿</span>
        <span class="story-source">${escHtml(article.source || 'Article')}</span>
        <span style="margin-left:auto;font-size:10px;color:var(--accent);font-weight:600">EDITING</span>
      </div>
      <textarea class="story-edit-textarea" data-article-id="${article.id}" data-section="${sectionId}"
        rows="${rows}"
        style="width:100%;box-sizing:border-box;padding:12px;font-size:13px;line-height:1.7;
               font-family:var(--font-mono);border:none;background:var(--bg-1);color:var(--text-1);
               resize:vertical;outline:none;border-bottom:1px solid var(--border)"
      >${escHtml(content)}</textarea>
      <div class="story-actions">
        <button class="story-action-btn primary" data-action="save-story-edit" data-article-id="${article.id}" data-section="${sectionId}">✓ Done</button>
        <button class="story-action-btn" data-action="cancel-story-edit" data-article-id="${article.id}" data-section="${sectionId}">✕ Cancel</button>
      </div>
    </div>`;
  }

  return `<div class="story-block" id="story-${article.id}" draggable="true"
    ondragstart="storyDragStart(event,'${article.id}','${sectionId}')"
    ondragend="storyDragEnd(event)">
    <div class="story-block-header">
      <span class="story-drag-handle" title="Drag to reorder">⠿</span>
      <span class="story-source">${escHtml(article.source || 'Article')}</span>
      <button class="btn-ghost btn-sm" style="margin-left:auto;font-size:11px;padding:2px 7px"
        data-action="edit-story" data-article-id="${article.id}" data-section="${sectionId}">✎ Edit</button>
    </div>
    <div class="story-content">${content ? formatContent(content) : '<span style="color:var(--text-3);font-style:italic">No content yet — click ✦ Generate or Edit</span>'}</div>
    <div class="story-actions">
      <button class="story-action-btn" data-action="rewrite-story" data-article-id="${article.id}" data-section="${sectionId}">↺ Rewrite</button>
      <button class="story-action-btn" data-action="shorten-story" data-article-id="${article.id}" data-section="${sectionId}">⟵ Shorten</button>
      <button class="story-action-btn" data-action="insert-image" data-article-id="${article.id}" data-section="${sectionId}">⊞ Image</button>
      <button class="story-action-btn" data-action="duplicate-story" data-article-id="${article.id}" data-section="${sectionId}">⊕ Duplicate</button>
      <button class="story-action-btn danger" data-action="remove-from-section" data-article-id="${article.id}" data-section="${sectionId}">× Remove</button>
    </div>
  </div>`;
}

function formatContent(text) {
  if (!text) return '';
  return escHtml(text)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;height:auto;border-radius:4px;margin:8px 0;display:block">')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^(The details:|Has this been done before\?|The difference:|Why it matters:|Real talk:)/gm, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// Re-render an entire section (header + body) so controls like the Generate
// button's count/state stay in sync after staging or removing articles.
function refreshSection(sectionId) {
  const el = document.getElementById(`section-${sectionId}`);
  const meta = state.newsletter.sectionMeta[sectionId] || { name: sectionId, type: 'generic' };
  if (!el) { refreshSectionContent(sectionId); return; }
  el.outerHTML = meta.type === 'briefing'
    ? renderTopStoriesSection(sectionId, meta.name)
    : renderSection(sectionId, meta.name, meta.type);
  setupDropZones();
}

function refreshSectionContent(sectionId) {
  const container = document.getElementById(`section-content-${sectionId}`);
  if (!container) return;
  const sectionType = state.newsletter.sectionMeta[sectionId]?.type || 'hits';
  if (isSynthType(sectionType)) {
    container.className = 'section-content';
    container.innerHTML = renderLeadBody(sectionId);
    setupDropZones();
    return;
  }
  const articles = state.newsletter.sections[sectionId] || [];
  const isGrid = sectionType === 'hits' || sectionType === 'generic';
  container.className = `section-content ${isGrid && articles.length > 0 ? 'quick-hits-grid' : ''}`;
  container.innerHTML = articles.length === 0
    ? renderDropPlaceholder(sectionId)
    : articles.map(a => renderStoryBlock(a, sectionId)).join('');
  setupDropZones();
}

function getAllSectionArticleIds() {
  const ids = new Set();
  Object.values(state.newsletter.sections).forEach(arr => arr.forEach(a => {
    ids.add(a.id);
    if (a._sources) a._sources.forEach(s => ids.add(s.id)); // lead-story source articles
  }));
  return ids;
}

function findArticle(articleId) {
  for (const feed of state.sources) {
    const a = feed.articles.find(a => a.id === articleId);
    if (a) return a;
  }
  // Also look in sections (for duplicates)
  for (const arr of Object.values(state.newsletter.sections)) {
    const a = arr.find(a => a.id === articleId);
    if (a) return a;
  }
  return null;
}

// Lazily fetch an article's full text (after quick ingest) so generation always
// has real source material. Dedupes in-flight fetches by URL; never throws.
const _hydratingByUrl = new Map();
async function hydrateArticleText(obj) {
  if (!obj || !obj.url || (obj.text && obj.text.length > 100)) return obj;
  let p = _hydratingByUrl.get(obj.url);
  if (!p) {
    p = fetch(`/api/hydrate?url=${encodeURIComponent(obj.url)}`).then(r => r.json()).catch(() => ({}));
    _hydratingByUrl.set(obj.url, p);
    p.finally(() => _hydratingByUrl.delete(obj.url));
  }
  const data = await p;
  if (data && data.text && (!obj.text || obj.text.length <= 100)) {
    obj.text = data.text;
    if (!obj.summary && data.summary) obj.summary = data.summary;
    if (data.images?.length && !(obj.images || []).length) { obj.images = data.images; obj.imageUrl = data.imageUrl || obj.imageUrl; }
  }
  return obj;
}
async function hydrateAll(arr) { await Promise.all((arr || []).map(hydrateArticleText)); }

async function addToSection(articleId, sectionId) {
  const article = findArticle(articleId);
  if (!article) { toast('Article not found', 'error'); return; }
  if (!state.newsletter.sections[sectionId]) state.newsletter.sections[sectionId] = [];
  if (state.newsletter.sections[sectionId].some(a => a.id === articleId)) {
    toast('Article already in this section', 'warn'); return;
  }
  const sectionType = state.newsletter.sectionMeta[sectionId]?.type || 'hits';
  if (sectionType === 'briefing') {
    const staged = { ...article };
    state.newsletter.sections[sectionId].push(staged);
    refreshTopStoriesSection();
    scheduleSave();
    hydrateArticleText(staged); // background: full text ready by generate time
    return;
  }
  if (isSynthType(sectionType)) {
    // Lead stories & quick hits stage multiple articles, then generate one
    // combined output on demand — no auto-generation per article.
    const entry = getLeadEntry(sectionId, true);
    if (entry._sources.some(s => (article.url && s.url === article.url) || s.id === articleId)) {
      toast('Already added to this section', 'warn'); return;
    }
    const src = toLeadSource(article);
    entry._sources.push(src);
    refreshSection(sectionId); // re-render header too so the Generate button updates
    refreshSourceSidebar();
    scheduleSave();
    hydrateArticleText(src); // background: full text ready by generate time
    return;
  }
  const typeToAction = { lead: 'lead-story', hits: 'quick-hit', cta: 'cta', generic: 'quick-hit' };
  const action = typeToAction[sectionType] || 'quick-hit';
  const entry = { ...article, content: null, loading: true };
  state.newsletter.sections[sectionId].push(entry);
  refreshSectionContent(sectionId);
  refreshSourceSidebar();
  try {
    await hydrateArticleText(entry); // ensure full text before writing
    const result = await callAI(action, entry, { prompt: state.newsletter.prompts[sectionId] });
    entry.content = result;
  } catch (e) {
    entry.content = article.summary || article.text || '(Failed to generate — click Rewrite to retry)';
    toast('AI generation failed: ' + e.message, 'error');
  }
  entry.loading = false;
  refreshSectionContent(sectionId);
  scheduleSave();
}
window.addToSection = addToSection;

function removeFromSection(articleId, sectionId) {
  state.newsletter.sections[sectionId] = state.newsletter.sections[sectionId].filter(a => a.id !== articleId);
  refreshSectionContent(sectionId);
  refreshSourceSidebar();
  scheduleSave();
}

function duplicateStory(articleId, sectionId) {
  const arr = state.newsletter.sections[sectionId];
  const idx = arr.findIndex(a => a.id === articleId);
  if (idx === -1) return;
  const clone = { ...arr[idx], id: uid() };
  arr.splice(idx + 1, 0, clone);
  refreshSectionContent(sectionId);
}

function startEditStory(articleId, sectionId) {
  const article = state.newsletter.sections[sectionId]?.find(a => a.id === articleId);
  if (!article) return;
  article._editBackup = article.content || article.summary || article.text || '';
  article._editDraft = article._editBackup;
  article.editing = true;
  refreshSectionContent(sectionId);
  // Focus the textarea after render
  requestAnimationFrame(() => {
    const ta = document.querySelector(`textarea[data-article-id="${articleId}"]`);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  });
}

function saveStoryEdit(articleId, sectionId) {
  const article = state.newsletter.sections[sectionId]?.find(a => a.id === articleId);
  if (!article) return;
  const ta = document.querySelector(`textarea[data-article-id="${articleId}"]`);
  article.content = (ta ? ta.value : article._editDraft) ?? article._editBackup;
  article.editing = false;
  delete article._editDraft;
  delete article._editBackup;
  refreshSectionContent(sectionId);
  scheduleSave();
}

function cancelStoryEdit(articleId, sectionId) {
  const article = state.newsletter.sections[sectionId]?.find(a => a.id === articleId);
  if (!article) return;
  article.content = article._editBackup;
  article.editing = false;
  delete article._editDraft;
  delete article._editBackup;
  refreshSectionContent(sectionId);
}

function buildImageGrid(images) {
  if (!images.length) return '';
  return `
    <div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:8px">Images from this article — click to select</div>
      <div id="img-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
        ${images.map(src => `
          <div class="img-pick-tile" onclick="selectImageTile(this,'${escHtml(src)}')" title="Click to select">
            <img src="${escHtml(src)}" loading="lazy"
              onerror="this.closest('.img-pick-tile').style.display='none'"
              style="width:100%;height:80px;object-fit:cover;border-radius:6px;display:block;cursor:pointer;border:2px solid transparent;transition:border-color 0.15s">
          </div>`).join('')}
      </div>
    </div>`;
}

function showImageModal(articleId, sectionId) {
  const modal = document.getElementById('modal-root');
  if (!modal) return;

  // Find the article (in sections or sources)
  const article = Object.values(state.newsletter.sections).flat().find(a => a.id === articleId)
    || state.sources.flatMap(s => s.articles || []).find(a => a.id === articleId);
  const preloaded = article?.images?.length ? article.images
    : article?.imageUrl ? [article.imageUrl] : [];

  const renderModal = (images) => {
    const hasImages = images.length > 0;
    modal.innerHTML = `
    <div class="modal-overlay" id="img-modal-overlay">
      <div class="modal" style="max-width:460px">
        <div class="modal-header">
          <div>
            <div class="modal-title">Insert Image</div>
            <div class="modal-sub">${hasImages ? 'Pick from article images or paste a URL' : 'Paste an image URL to embed it in this story'}</div>
          </div>
          <button class="btn-icon" data-action="close-modal" style="font-size:18px;line-height:1">×</button>
        </div>
        <div class="modal-body" style="padding:20px">
          ${hasImages ? buildImageGrid(images) : ''}
          <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:6px">${hasImages ? 'Or paste a custom URL' : 'Image URL'}</div>
          <input id="img-url-input" class="input" type="url" placeholder="https://example.com/image.jpg" style="width:100%;margin-bottom:12px">
          <div id="img-preview" style="display:none;margin-bottom:12px;text-align:center">
            <img id="img-preview-el" src="" style="max-width:100%;max-height:180px;border-radius:6px;border:1px solid var(--border)">
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary" style="flex:1" onclick="confirmInsertImage('${articleId}','${sectionId}')">Insert</button>
            <button class="btn btn-outline" data-action="close-modal">Cancel</button>
          </div>
        </div>
      </div>
    </div>`;
    modal.querySelector('#img-modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
    const input = modal.querySelector('#img-url-input');
    input.addEventListener('input', () => {
      const preview = modal.querySelector('#img-preview');
      const previewEl = modal.querySelector('#img-preview-el');
      modal.querySelectorAll('.img-pick-tile img').forEach(i => i.style.borderColor = 'transparent');
      if (input.value.trim()) { previewEl.src = input.value.trim(); preview.style.display = 'block'; }
      else { preview.style.display = 'none'; }
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') confirmInsertImage(articleId, sectionId); });
    if (hasImages) {
      input.value = images[0];
      setTimeout(() => {
        const firstTile = modal.querySelector('.img-pick-tile img');
        if (firstTile) firstTile.style.borderColor = 'var(--accent)';
      }, 50);
    } else {
      input.focus();
    }
  };

  // Synthesis entries (lead story / quick hits) have no single URL — pull images
  // from all the staged source articles instead.
  const sourceUrls = article?._sources?.map(s => s.url).filter(Boolean) || [];

  if (preloaded.length > 0) {
    // Already have images — render immediately
    renderModal(preloaded);
  } else if (!article?.url && sourceUrls.length) {
    modal.innerHTML = `
    <div class="modal-overlay" id="img-modal-overlay">
      <div class="modal" style="max-width:460px">
        <div class="modal-header">
          <div><div class="modal-title">Insert Image</div></div>
          <button class="btn-icon" data-action="close-modal" style="font-size:18px;line-height:1">×</button>
        </div>
        <div class="modal-body" style="padding:32px 20px;text-align:center">
          <div class="signup-spinner" style="margin:0 auto 16px"></div>
          <div style="font-size:13px;color:var(--text-2)">Pulling images from your sources…</div>
        </div>
      </div>
    </div>`;
    modal.querySelector('#img-modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
    Promise.all(sourceUrls.slice(0, 6).map(u =>
      fetch(`/api/extract-images?url=${encodeURIComponent(u)}`).then(r => r.json()).catch(() => ({}))
    )).then(results => {
      const imgs = [...new Set(results.flatMap(d => d.images || (d.imageUrl ? [d.imageUrl] : [])))];
      if (article) { article.images = imgs; article.imageUrl = imgs[0] || null; }
      renderModal(imgs);
    }).catch(() => renderModal([]));
  } else if (article?.url) {
    // Fetch images on demand, show loading state first
    modal.innerHTML = `
    <div class="modal-overlay" id="img-modal-overlay">
      <div class="modal" style="max-width:460px">
        <div class="modal-header">
          <div><div class="modal-title">Insert Image</div></div>
          <button class="btn-icon" data-action="close-modal" style="font-size:18px;line-height:1">×</button>
        </div>
        <div class="modal-body" style="padding:32px 20px;text-align:center">
          <div class="signup-spinner" style="margin:0 auto 16px"></div>
          <div style="font-size:13px;color:var(--text-2)">Pulling images from article…</div>
        </div>
      </div>
    </div>`;
    modal.querySelector('#img-modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
    fetch(`/api/extract-images?url=${encodeURIComponent(article.url)}`)
      .then(r => r.json())
      .then(data => {
        const imgs = data.images || (data.imageUrl ? [data.imageUrl] : []);
        // Cache on article for next time
        if (article) { article.images = imgs; article.imageUrl = imgs[0] || null; }
        renderModal(imgs);
      })
      .catch(() => renderModal([]));
  } else {
    renderModal([]);
  }
}

function selectImageTile(tile, src) {
  // Highlight selected tile, deselect others
  document.querySelectorAll('.img-pick-tile img').forEach(i => i.style.borderColor = 'transparent');
  tile.querySelector('img').style.borderColor = 'var(--accent)';
  // Put the URL in the input and show preview
  const input = document.getElementById('img-url-input');
  const preview = document.getElementById('img-preview');
  const previewEl = document.getElementById('img-preview-el');
  if (input) input.value = src;
  if (previewEl) previewEl.src = src;
  if (preview) preview.style.display = 'block';
}
window.selectImageTile = selectImageTile;

function confirmInsertImage(articleId, sectionId) {
  const input = document.getElementById('img-url-input');
  const url = input?.value.trim();
  if (!url) { toast('Enter an image URL', 'warn'); return; }
  const article = state.newsletter.sections[sectionId]?.find(a => a.id === articleId);
  if (!article) return;
  article.content = `![Image](${url})\n\n` + (article.content || article.summary || '');
  closeModal();
  refreshSectionContent(sectionId);
  scheduleSave();
}
window.confirmInsertImage = confirmInsertImage;

async function duplicateNewsletter(id) {
  const nl = state.dbNewsletters.find(n => n.id === id);
  if (!nl) { toast('Newsletter not found', 'error'); return; }
  if (!sb || !state.user) { toast('Connect Supabase to duplicate newsletters', 'warn'); return; }
  const { data: full, error } = await sb.from('newsletters').select('*').eq('id', id).single();
  if (error || !full) { toast('Could not load newsletter', 'error'); return; }
  const scoped = await ensureNewslettersCapability();
  const copyPayload = {
    user_id: state.user.id,
    title: (full.title || 'Untitled') + ' (Copy)',
    subject: full.subject || '',
    preview_text: full.preview_text || '',
    subject_lines: full.subject_lines || [],
    sections: full.sections,
    top_stories_content: full.top_stories_content || '',
    prompts: full.prompts,
    status: 'draft',
  };
  if (scoped) copyPayload.publication_id = full.publication_id || null; // keep the copy in the same publication
  const { data: copy, error: copyErr } = await sb.from('newsletters').insert(copyPayload).select('id').single();
  if (copyErr) { toast('Duplicate failed', 'error'); return; }
  toast('Newsletter duplicated', 'success');
  state.dbNewsletters = await loadNewslettersFromDB();
  render();
}

async function moveNewsletterToPublication(id, pubId) {
  if (pubId === '__cur' || !sb || !state.user) return; // no-op if they reselected the current pub
  const scoped = await ensureNewslettersCapability();
  if (!scoped) { toast('Run the newsletters migration in Supabase to move issues between publications', 'warn'); return; }
  const target = pubId || null; // '' = Default
  const { error } = await sb.from('newsletters').update({ publication_id: target }).eq('id', id).eq('user_id', state.user.id);
  if (error) { toast('Move failed: ' + error.message, 'error'); return; }
  state.dbNewsletters = await loadNewslettersFromDB(); // it leaves the current publication's list
  render();
  const name = (target ? state.publications.find(p => p.id === target)?.name : (state.defaultPublicationName || 'Default')) || 'publication';
  toast(`Moved to "${name}"`, 'success');
}
window.moveNewsletterToPublication = moveNewsletterToPublication;

async function deleteNewsletter(id) {
  const nl = state.dbNewsletters.find(n => n.id === id);
  const name = nl?.title || 'this newsletter';
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  if (!sb || !state.user) {
    // No Supabase — remove from local list only
    state.dbNewsletters = state.dbNewsletters.filter(n => n.id !== id);
    render();
    toast('Newsletter removed', 'info');
    return;
  }
  const { error } = await sb.from('newsletters').delete().eq('id', id).eq('user_id', state.user.id);
  if (error) { toast('Delete failed — ' + error.message, 'error'); return; }
  toast('Newsletter deleted', 'info');
  state.dbNewsletters = await loadNewslettersFromDB();
  render();
}

function effectivePrompt(sectionId) {
  // Per-issue prompt takes precedence; fall back to the matching section default
  const issuePrompt = state.newsletter.prompts[sectionId] || '';
  if (issuePrompt) return issuePrompt;
  // Try direct section ID match first (user-defined sections)
  if (state.defaultPrompts?.[sectionId]) return state.defaultPrompts[sectionId];
  // Fall back to type-based key (legacy / built-in sections)
  const type = state.newsletter.sectionMeta[sectionId]?.type || 'generic';
  const typeToKey = { briefing: 'briefing', lead: 'lead', hits: 'hits', cta: 'cta', generic: 'generic' };
  return state.defaultPrompts?.[typeToKey[type] || 'generic'] || '';
}

// The section-defaults "template": an ordered list of {id, name, type} plus a
// per-section prompt. Stored as defaultPrompts._layout — the SAME thing the
// builder consumes in resetNewsletter, so editing it here IS editing the builder
// template (new newsletters start from exactly these sections).
function getUserSections() {
  const dp = state.defaultPrompts || {};
  if (dp._layout?.order?.length) {
    return dp._layout.order.map(id => ({
      id,
      name: dp._layout.meta?.[id]?.name || id,
      type: dp._layout.meta?.[id]?.type || 'generic',
    }));
  }
  // Legacy list with no types — surface it so nothing is lost
  return (dp._sections || []).map(s => ({ id: s.id, name: s.name, type: 'generic' }));
}

// Best-guess a section's content type from its name so users don't have to set it.
function inferSectionType(name) {
  const n = (name || '').toLowerCase();
  if (/brief|today|top stor|digest|round-?up|headlines|the rundown/.test(n)) return 'briefing';
  if (/lead|feature|main story|deep ?dive|spotlight|cover/.test(n)) return 'lead';
  if (/quick|hits|bites|bullet|short|tl;?dr|rapid|in brief/.test(n)) return 'hits';
  if (/cta|sponsor|call to action|promo|\bad\b|advert|support us|subscribe|upgrade/.test(n)) return 'cta';
  return 'generic';
}

// Persist a template (list of {id,name,type}) as the builder default for this publication.
function setUserSections(sections) {
  if (!state.defaultPrompts) state.defaultPrompts = {};
  const order = sections.map(s => s.id);
  const meta = {};
  for (const s of sections) meta[s.id] = { name: s.name, type: s.type || 'generic' };
  const prevPrompts = state.defaultPrompts._layout?.prompts || {};
  const prompts = {};
  for (const s of sections) prompts[s.id] = state.defaultPrompts[s.id] || prevPrompts[s.id] || '';
  state.defaultPrompts._layout = { order, meta, prompts };
  state.defaultPrompts._sections = sections.map(s => ({ id: s.id, name: s.name })); // legacy mirror
  scheduleSettingsSave();
  render();
}

function setSectionDefaultType(id, type) {
  if (!state.defaultPrompts?._layout?.meta?.[id]) return;
  state.defaultPrompts._layout.meta[id].type = type;
  scheduleSettingsSave();
}
window.setSectionDefaultType = setSectionDefaultType;

function addSectionDefault() {
  const name = (window.prompt('New section name (e.g. "All Things Camden"):') || '').trim();
  if (!name) return;
  const sections = getUserSections();
  sections.push({ id: 'custom_' + uid(), name, type: inferSectionType(name) });
  setUserSections(sections);
}

function removeSectionDefault(id) {
  const sections = getUserSections().filter(s => s.id !== id);
  if (!sections.length) { toast('Keep at least one section in your template', 'warn'); return; }
  setUserSections(sections);
}

async function applyPrompt(sectionId) {
  const articles = state.newsletter.sections[sectionId];
  if (!articles.length) { toast('No articles in this section yet', 'warn'); return; }
  const typeToAction = { lead: 'lead-story', hits: 'quick-hit', cta: 'cta', generic: 'quick-hit' };
  const action = typeToAction[state.newsletter.sectionMeta[sectionId]?.type] || 'quick-hit';
  const prompt = effectivePrompt(sectionId);
  articles.forEach(a => { a.loading = true; });
  refreshSectionContent(sectionId);
  for (const article of articles) {
    try {
      await hydrateArticleText(article);
      article.content = await callAI(action, article, { prompt });
    } catch (e) { article.content = article.content || '(Failed)'; }
    article.loading = false;
    refreshSectionContent(sectionId);
  }
  toast('Section regenerated', 'success');
  scheduleSave();
}

async function rewriteStory(articleId, sectionId) {
  const article = state.newsletter.sections[sectionId].find(a => a.id === articleId);
  if (!article) return;
  article.loading = true;
  refreshSectionContent(sectionId);
  try {
    const typeToAction = { lead: 'lead-story', hits: 'quick-hit', cta: 'cta', generic: 'quick-hit' };
    const action = typeToAction[state.newsletter.sectionMeta[sectionId]?.type] || 'quick-hit';
    await hydrateArticleText(article);
    article.content = await callAI(action, article, { prompt: effectivePrompt(sectionId) });
  } catch (e) { toast('Rewrite failed: ' + e.message, 'error'); }
  article.loading = false;
  refreshSectionContent(sectionId);
  scheduleSave();
}

async function shortenStory(articleId, sectionId) {
  const article = state.newsletter.sections[sectionId].find(a => a.id === articleId);
  if (!article) return;
  article.loading = true;
  refreshSectionContent(sectionId);
  try {
    article.content = await callAI('summarize', article);
  } catch (e) { toast('Shorten failed', 'error'); }
  article.loading = false;
  refreshSectionContent(sectionId);
  scheduleSave();
}

// ── AI PANEL ──────────────────────────────────────────────────────────────────
function switchPanel(panel) {
  state.rightPanel = panel;
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === panel));
  const body = document.getElementById('panel-body');
  if (body) body.innerHTML = renderPanelContent();
}

function renderPanelContent() {
  if (state.rightPanel === 'ai') return renderAIPanel();
  if (state.rightPanel === 'design') return renderDesignPanel();
  if (state.rightPanel === 'team') return renderTeamPanel();
  return '';
}

function updateDesignPanel() {
  const body = document.getElementById('panel-body');
  if (body && state.rightPanel === 'design') body.innerHTML = renderDesignPanel();
}

function renderAIPanel() {
  const tones = [
    { id: 'punchy-executive', label: 'Punchy Executive' },
    { id: 'morning-brew', label: 'Morning Brew' },
    { id: 'neutral-newsroom', label: 'Neutral Newsroom' },
    { id: 'sharp-political', label: 'Sharp Political' },
  ];
  return `
<div class="panel-section">
  <div class="panel-section-title">Tone Preset ${!state.hasAI ? '<span class="mock-badge" style="float:right;margin-top:-1px">Mock</span>' : ''}</div>
  <div class="tone-grid">
    ${tones.map(t => `<div class="tone-chip ${state.tone === t.id ? 'active' : ''}" data-action="select-tone" data-tone="${t.id}">${t.label}</div>`).join('')}
  </div>
</div>

<div class="panel-section">
  <div class="panel-section-title">Actions</div>
  <div style="display:flex;flex-direction:column;gap:5px">
    <button class="ai-action-btn" data-action="ai-rewrite" ${state.aiLoading ? 'disabled' : ''}><span class="ai-action-icon">↺</span> Rewrite Selection</button>
    <button class="ai-action-btn" data-action="ai-summarize" ${state.aiLoading ? 'disabled' : ''}><span class="ai-action-icon">≡</span> Summarize in 3 sentences</button>
    <button class="ai-action-btn" data-action="ai-hooks" ${state.aiLoading ? 'disabled' : ''}><span class="ai-action-icon">◉</span> Create hooks</button>
    <button class="ai-action-btn" data-action="ai-cta" ${state.aiLoading ? 'disabled' : ''}><span class="ai-action-icon">→</span> Generate CTA</button>
  </div>
</div>

<div class="panel-section">
  <div class="panel-section-title">Subject Lines</div>
  <label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:4px">Base subject &amp; preview on:</label>
  <select class="input input-sm" onchange="state.subjectSourceSection=this.value" style="width:100%;margin-bottom:6px">
    <option value="" ${state.subjectSourceSection === '' ? 'selected' : ''}>Whole issue</option>
    ${state.newsletter.sectionOrder.map(id => {
      const meta = state.newsletter.sectionMeta[id] || { name: id };
      return `<option value="${id}" ${state.subjectSourceSection === id ? 'selected' : ''}>${escHtml(meta.name)}</option>`;
    }).join('')}
  </select>
  <label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:4px">Custom instructions (optional):</label>
  <textarea class="input input-sm" oninput="state.subjectPrompt=this.value" rows="2"
    placeholder="e.g. Lead with a number, no questions, keep it under 6 words…"
    style="width:100%;box-sizing:border-box;resize:vertical;font-size:12px;margin-bottom:6px">${escHtml(state.subjectPrompt || '')}</textarea>
  <button class="ai-action-btn" data-action="generate-subjects" ${state.aiLoading ? 'disabled' : ''}>
    ${state.aiLoading ? '<div class="spinner"></div>' : '<span class="ai-action-icon">✉</span>'} Generate subject lines
  </button>
  ${(state.newsletter.subjectLines || []).length > 0 ? `
  <div class="subject-history">
    ${state.newsletter.subjectLines.slice(0, 10).map((line, i) => `
    <div class="subject-history-item ${state.newsletter.subject === line ? 'active' : ''}">
      <div class="subject-history-text">${escHtml(line)}</div>
      <button class="subject-use-btn" data-action="use-subject" data-line="${escHtml(line)}" title="Use this subject line">
        ${state.newsletter.subject === line ? '✓' : 'Use'}
      </button>
    </div>`).join('')}
  </div>` : ''}
</div>

<div class="panel-section">
  <div class="panel-section-title">Preview Text</div>
  <button class="ai-action-btn" data-action="generate-preview" ${state.aiLoading ? 'disabled' : ''}>
    <span class="ai-action-icon">👁</span> Generate preview text
  </button>
</div>

${state.aiResult ? `
<div class="panel-section">
  <div class="panel-section-title">Result <button class="btn-ghost btn-sm" style="font-size:10px;padding:2px 6px;float:right" onclick="state.aiResult=null;refreshAIPanel()">Clear</button></div>
  <div class="ai-result-box">${escHtml(state.aiResult)}</div>
</div>` : ''}

<div class="panel-section">
  <div class="panel-section-title">Brand Voice</div>
  ${state.brandVoice
    ? `<div style="font-size:12px;color:var(--green);margin-bottom:6px">✓ Voice profile active</div>
       <div style="font-size:11px;color:var(--text-3);line-height:1.6;margin-bottom:8px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical">${escHtml(state.brandVoice)}</div>`
    : `<div style="font-size:12px;color:var(--text-3);margin-bottom:8px;line-height:1.6">No voice profile yet. Add past newsletters in Settings to generate one.</div>`}
  <button class="btn btn-outline btn-sm" style="width:100%" data-action="navigate" data-view="settings">⚙ Manage in Settings →</button>
</div>

${state.aiHistory.length > 0 ? `
<div class="panel-section">
  <div class="panel-section-title">Recent Generations</div>
  <div style="display:flex;flex-direction:column;gap:6px">
    ${state.aiHistory.slice(-4).reverse().map(h => `
    <div class="ai-history-item">
      <div class="ai-history-action">${h.action}</div>
      <div class="ai-history-text">${escHtml(h.result.slice(0, 120))}…</div>
    </div>`).join('')}
  </div>
</div>` : ''}
`;
}

function refreshAIPanel() {
  const body = document.getElementById('panel-body');
  if (body && state.rightPanel === 'ai') body.innerHTML = renderAIPanel();
}

function useSubjectLine(line) {
  state.newsletter.subject = line;
  const input = document.getElementById('subject-input');
  if (input) input.value = line;
  scheduleSave();
  refreshAIPanel();
  toast('Subject line applied', 'success');
}

function selectTone(tone) {
  state.tone = tone;
  scheduleSettingsSave();
  refreshAIPanel();
}


async function discoverVoice() {
  const input = document.getElementById('voice-pub-url');
  const url = input?.value.trim();
  if (!url) { toast('Paste your newsletter URL first', 'warn'); return; }
  try { new URL(url); } catch { toast('That doesn\'t look like a valid URL', 'warn'); return; }

  showVoiceWizard(url);
}
window.discoverVoice = discoverVoice;

function showVoiceWizard(url) {
  const modal = document.getElementById('modal-root');
  if (!modal) return;

  const setStep = (step, detail = '') => {
    const el = document.getElementById('voice-wizard-step');
    const sub = document.getElementById('voice-wizard-sub');
    if (el) el.textContent = step;
    if (sub && detail) sub.textContent = detail;
  };

  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal" style="max-width:520px;padding:44px 40px;text-align:center">
      <div style="font-size:48px;margin-bottom:20px">🧠</div>
      <div style="font-size:22px;font-weight:800;letter-spacing:-0.03em;margin-bottom:8px">Building your AI writer</div>
      <div id="voice-wizard-sub" style="font-size:14px;color:var(--text-2);margin-bottom:32px">Reading your past issues…</div>

      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:32px;text-align:left">
        <div class="voice-step" id="vstep-1" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:var(--r-md);background:var(--bg-3);border:1px solid var(--border)">
          <div class="voice-step-icon" style="font-size:18px">⏳</div>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text-1)">Fetching past issues</div>
            <div style="font-size:12px;color:var(--text-3)">Reading up to 15 of your newsletters</div>
          </div>
        </div>
        <div class="voice-step" id="vstep-2" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:var(--r-md);background:var(--bg-3);border:1px solid var(--border);opacity:0.4">
          <div class="voice-step-icon" style="font-size:18px">📖</div>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text-1)">Analyzing your writing</div>
            <div style="font-size:12px;color:var(--text-3)">Voice, rhythm, vocabulary, structure</div>
          </div>
        </div>
        <div class="voice-step" id="vstep-3" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:var(--r-md);background:var(--bg-3);border:1px solid var(--border);opacity:0.4">
          <div class="voice-step-icon" style="font-size:18px">✍️</div>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text-1)">Building your AI profile</div>
            <div style="font-size:12px;color:var(--text-3)">Voice profile + audience avatar + section suggestions</div>
          </div>
        </div>
      </div>

      <div style="height:4px;background:var(--bg-4);border-radius:99px;overflow:hidden">
        <div id="voice-progress-bar" style="height:100%;background:var(--accent);border-radius:99px;width:5%;transition:width 0.6s ease"></div>
      </div>
      <div style="font-size:11px;color:var(--text-3);margin-top:8px" id="voice-wizard-step">Starting…</div>
    </div>
  </div>`;

  const setProgress = pct => {
    const bar = document.getElementById('voice-progress-bar');
    if (bar) bar.style.width = pct + '%';
  };

  const activateStep = (n) => {
    for (let i = 1; i <= 3; i++) {
      const el = document.getElementById(`vstep-${i}`);
      if (!el) continue;
      if (i < n) {
        el.style.opacity = '1';
        el.style.background = 'var(--green-soft)';
        el.style.borderColor = 'var(--green)';
        el.querySelector('.voice-step-icon').textContent = '✓';
      } else if (i === n) {
        el.style.opacity = '1';
        el.style.background = 'var(--accent-soft)';
        el.style.borderColor = 'var(--accent)';
      } else {
        el.style.opacity = '0.4';
      }
    }
  };

  // Run the actual discovery
  (async () => {
    try {
      activateStep(1);
      setProgress(10);
      setStep('Fetching past issues…', 'Reading up to 15 of your newsletters');

      const res = await fetch(`/api/discover-voice?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Discovery failed');

      activateStep(2);
      setProgress(45);
      setStep(`Found ${data.count} issues`, 'Analyzing your writing style…');

      // Track the publication URL
      if (!state.voiceUrls.includes(url)) state.voiceUrls.push(url);
      state.brandVoiceSamples = data.text;

      activateStep(3);
      setProgress(75);
      setStep('Building your AI profile…', 'Voice profile + audience avatar + section suggestions');

      // If server already did AI analysis, use it directly
      if (data.voiceProfile) {
        state.brandVoice = data.voiceProfile;
        if (data.audienceAvatar && !state.audienceAvatar) state.audienceAvatar = data.audienceAvatar;
      } else {
        // Fall back to client-triggered AI call
        await generateBrandVoice();
      }
      // Save immediately before showing results — guarantees nothing is lost
      await saveUserSettings();

      setProgress(100);
      await new Promise(r => setTimeout(r, 400));

      // Show results screen
      showVoiceWizardResults(data, url);

    } catch (e) {
      closeModal();
      toast(`Error: ${e.message}`, 'error');
    }
  })();
}

function showVoiceWizardResults(data, url) {
  const modal = document.getElementById('modal-root');
  if (!modal) return;

  const sections = data.sectionSuggestions?.length
    ? data.sectionSuggestions.map(s => `<span style="display:inline-flex;align-items:center;background:var(--bg-4);border:1px solid var(--border-md);border-radius:var(--r-sm);padding:3px 10px;font-size:12px;font-weight:500">${escHtml(s)}</span>`).join('')
    : '';

  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal" style="max-width:580px;padding:40px;max-height:90vh;overflow-y:auto">

      <div style="text-align:center;margin-bottom:28px">
        <div style="display:inline-flex;align-items:center;gap:8px;background:var(--green-soft);border:1px solid var(--green);border-radius:99px;padding:6px 18px;font-size:13px;font-weight:700;color:var(--green);margin-bottom:16px">
          ✓ Your AI writer is ready
        </div>
        <div style="font-size:24px;font-weight:800;letter-spacing:-0.03em;margin-bottom:6px">${escHtml(data.source || 'Your Newsletter')}</div>
        ${data.topicFocus ? `<div style="font-size:14px;color:var(--text-2)">${escHtml(data.topicFocus)}</div>` : ''}
      </div>

      <!-- Voice Profile -->
      <div style="margin-bottom:20px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--accent);margin-bottom:8px">🎙 Voice Profile</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.75;background:var(--bg-3);border-radius:var(--r-md);padding:14px 16px;max-height:160px;overflow-y:auto">
          ${escHtml(state.brandVoice || data.voiceProfile || '').replace(/\n/g, '<br>')}
        </div>
      </div>

      <!-- Audience Avatar -->
      ${(state.audienceAvatar || data.audienceAvatar) ? `
      <div style="margin-bottom:20px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--accent);margin-bottom:8px">👤 Audience Avatar</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.75;background:var(--bg-3);border-radius:var(--r-md);padding:14px 16px;max-height:140px;overflow-y:auto">
          ${escHtml(state.audienceAvatar || data.audienceAvatar || '').replace(/\n/g, '<br>')}
        </div>
      </div>` : ''}

      <!-- Section Suggestions -->
      ${sections ? `
      <div style="margin-bottom:28px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--accent);margin-bottom:10px">📋 Suggested Sections</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${sections}</div>
        <div style="margin-top:8px;font-size:11px;color:var(--text-3)">You can set these as your section defaults in Settings → Section Defaults.</div>
      </div>` : ''}

      <div style="display:flex;gap:10px">
        <button class="btn btn-primary" style="flex:1;justify-content:center" onclick="closeModal();navigate('builder')">Start writing →</button>
        <button class="btn btn-outline" style="flex:1;justify-content:center" onclick="closeModal();navigate('settings')">Edit profile</button>
      </div>
      <div style="text-align:center;font-size:11px;color:var(--text-3);margin-top:12px">Everything is saved automatically. You can refine it anytime in Settings → Brand Voice.</div>
    </div>
  </div>`;
  modal.querySelector('#modal-overlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

  // Save IMMEDIATELY — don't debounce, this is a one-time setup
  saveUserSettings().then(() => {
    toast('✓ AI writer saved', 'success');
  }).catch(() => {
    toast('Saved locally — will sync when connection restores', 'warn');
  });
  refreshVoiceBadge();
  if (state.view === 'settings') render();
  if (state.view === 'dashboard') render();
}
window.showVoiceWizard = showVoiceWizard;

window.dashStartVoice = function() {
  const input = document.getElementById('dash-voice-url');
  let url = input?.value.trim();
  if (!url) { toast('Paste your newsletter URL first', 'warn'); return; }
  if (!url.startsWith('http')) url = 'https://' + url;
  try { new URL(url); } catch { toast('That doesn\'t look like a valid URL', 'warn'); return; }
  showVoiceWizard(url);
};
window.scheduleSettingsSave = scheduleSettingsSave;
window.refreshVoiceBadge = refreshVoiceBadge;

async function fetchVoiceURL(form) {
  const input = form.querySelector('#voice-url-input');
  const raw = input.value.trim();
  if (!raw) return;

  const urls = raw.split(/[\n,]+/).map(u => u.trim()).filter(u => {
    try { new URL(u); return true; } catch { return false; }
  });
  if (!urls.length) { toast('No valid URLs found', 'warn'); return; }

  const newUrls = urls.filter(u => !state.voiceUrls.includes(u));
  if (!newUrls.length) { toast('All URLs already added', 'warn'); return; }

  state.voiceUrlLoading = true;
  refreshAIPanel();
  refreshSettingsVoiceSection();

  const results = await Promise.allSettled(
    newUrls.map(async url => {
      const res = await fetch(`/api/ingest?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Could not fetch');
      const text = data.articles?.map(a => [a.title, a.text || a.summary].filter(Boolean).join('\n\n')).join('\n\n---\n\n') || '';
      if (!text.trim()) throw new Error('No readable content');
      return { url, text };
    })
  );

  let added = 0, failed = 0;
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      state.voiceUrls.push(r.value.url);
      state.brandVoiceSamples = [state.brandVoiceSamples, r.value.text].filter(Boolean).join('\n\n---\n\n');
      added++;
    } else { failed++; }
  });

  input.value = '';
  if (added) toast(`${added} newsletter${added > 1 ? 's' : ''} imported — generating voice profile…`, 'info');
  else toast(`All ${failed} URLs failed to fetch`, 'error');

  state.voiceUrlLoading = false;
  refreshAIPanel();
  refreshSettingsVoiceSection();

  // Auto-generate voice profile from the imported content
  if (added > 0) await generateBrandVoice();
}

function removeVoiceURL(idx) {
  state.voiceUrls.splice(idx, 1);
  scheduleSettingsSave();
  refreshAIPanel();
  refreshSettingsVoiceSection();
}

function refreshSettingsVoiceSection() {
  if (state.view === 'settings') render();
}

async function aiRewriteSelection() {
  const sel = window.getSelection()?.toString().trim();
  const content = sel ? { text: sel, title: 'Selection', source: '' } : getFirstSectionArticle();
  if (!content) { toast('No text selected and no articles in builder', 'warn'); return; }
  state.aiLoading = true; refreshAIPanel();
  try {
    state.aiResult = await callAI('rewrite', content);
    addToHistory('rewrite', state.aiResult);
  } catch (e) { toast(e.message, 'error'); }
  state.aiLoading = false; refreshAIPanel();
}

async function aiSummarize() {
  const content = getFirstSectionArticle();
  if (!content) { toast('Add an article to a section first', 'warn'); return; }
  state.aiLoading = true; refreshAIPanel();
  try {
    state.aiResult = await callAI('summarize', content);
    addToHistory('summarize', state.aiResult);
  } catch (e) { toast(e.message, 'error'); }
  state.aiLoading = false; refreshAIPanel();
}

async function aiHooks() {
  const content = getFirstSectionArticle();
  if (!content) { toast('Add an article to a section first', 'warn'); return; }
  state.aiLoading = true; refreshAIPanel();
  try {
    state.aiResult = await callAI('hooks', content);
    addToHistory('hooks', state.aiResult);
  } catch (e) { toast(e.message, 'error'); }
  state.aiLoading = false; refreshAIPanel();
}

async function aiCTA() {
  state.aiLoading = true; refreshAIPanel();
  try {
    state.aiResult = await callAI('cta', { title: state.newsletter.title });
    addToHistory('cta', state.aiResult);
  } catch (e) { toast(e.message, 'error'); }
  state.aiLoading = false; refreshAIPanel();
}

// Returns the text content of a single section by id (briefing sections use topStoriesContent).
function sectionTextById(id) {
  const meta = state.newsletter.sectionMeta[id];
  if (meta?.type === 'briefing' || id === 'topStories') {
    return state.newsletter.topStoriesContent?.trim() || '';
  }
  const articles = state.newsletter.sections[id] || [];
  return articles
    .map(a => (a.content || a.summary || '').trim())
    .filter(Boolean)
    .join('\n\n---\n\n')
    .slice(0, 3000);
}

function buildNewsletterContext() {
  // If the user picked a specific section to base subject/preview on, scope to it.
  const picked = state.subjectSourceSection;
  if (picked && state.newsletter.sectionOrder.includes(picked)) {
    const text = sectionTextById(picked);
    if (text) {
      const meta = state.newsletter.sectionMeta[picked] || { name: picked, type: 'generic' };
      const isBriefing = meta.type === 'briefing' || picked === 'topStories';
      return {
        title: state.newsletter.title,
        summary: `${meta.name}:\n${text}`.slice(0, 3000),
        // Surface the chosen section as the briefing highlight so server prompts pull from it
        topStoriesContent: text.slice(0, 1200),
        source: '',
      };
    }
  }

  // Otherwise: whole issue — collect all section content + top stories.
  const parts = [];
  if (state.newsletter.topStoriesContent?.trim()) {
    parts.push(`Today's Briefing:\n${state.newsletter.topStoriesContent.trim().slice(0, 1200)}`);
  }
  for (const id of state.newsletter.sectionOrder) {
    const articles = state.newsletter.sections[id] || [];
    for (const a of articles) {
      const text = (a.content || a.summary || '').trim().slice(0, 400);
      if (text) parts.push(text);
    }
  }
  return {
    title: state.newsletter.title,
    summary: parts.join('\n\n---\n\n').slice(0, 3000),
    topStoriesContent: state.newsletter.topStoriesContent?.trim() || '',
    source: '',
  };
}

async function generateSubjectLines() {
  const content = buildNewsletterContext();
  if (!content.summary && !content.topStoriesContent) {
    const fallback = getFirstSectionArticle();
    if (!fallback) { toast('Add some content to your newsletter first', 'warn'); return; }
    Object.assign(content, fallback);
  }
  state.aiLoading = true; refreshAIPanel();
  try {
    state.aiResult = await callAI('subject-line', content, { prompt: state.subjectPrompt || '' });
    addToHistory('subject-line', state.aiResult);
    // Parse numbered list into individual subject lines and prepend to history
    const parsed = state.aiResult
      .split('\n')
      .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter(l => l.length > 10);
    if (parsed.length) {
      if (!state.newsletter.subjectLines) state.newsletter.subjectLines = [];
      state.newsletter.subjectLines = [...parsed, ...state.newsletter.subjectLines].slice(0, 20);
      scheduleSave();
    }
  } catch (e) { toast(e.message, 'error'); }
  state.aiLoading = false; refreshAIPanel();
}

async function generatePreviewText() {
  const content = buildNewsletterContext();
  if (!content.summary && !content.topStoriesContent) {
    const fallback = getFirstSectionArticle();
    if (fallback) Object.assign(content, fallback);
  }
  state.aiLoading = true; refreshAIPanel();
  try {
    state.aiResult = await callAI('preview-text', content, { prompt: state.subjectPrompt || '' });
    addToHistory('preview-text', state.aiResult);
  } catch (e) { toast(e.message, 'error'); }
  state.aiLoading = false; refreshAIPanel();
}

function renderVoiceBadge() {
  if (!state.brandVoice) {
    return `<div class="badge badge-default" style="cursor:pointer" data-action="navigate" data-view="settings" title="No brand voice set — go to Settings to add one">🎙 No voice</div>`;
  }
  // Show first ~120 chars of the profile as a tooltip
  const preview = escHtml(state.brandVoice.slice(0, 160).replace(/\n/g, ' '));
  return `<div class="badge badge-green" style="cursor:pointer" data-action="navigate" data-view="settings" title="${preview}…">🎙 Voice active</div>`;
}

function refreshVoiceBadge() {
  const el = document.getElementById('voice-status-badge');
  if (el) el.innerHTML = renderVoiceBadge();
}

async function generateBrandVoice() {
  if (!state.brandVoiceSamples.trim()) { toast('Paste newsletter samples first', 'warn'); return; }
  state.aiLoading = true; refreshAIPanel();
  try {
    state.brandVoice = await callAI('brand-voice', { text: state.brandVoiceSamples });
    toast('✓ Voice profile generated', 'success');
    scheduleSettingsSave();
    refreshVoiceBadge();
    refreshSettingsVoiceSection();
  } catch (e) { toast(e.message, 'error'); }
  state.aiLoading = false; refreshAIPanel();
}

function getFirstSectionArticle() {
  for (const arr of Object.values(state.newsletter.sections)) {
    if (arr.length > 0) return arr[0];
  }
  return null;
}

function addToHistory(action, result) {
  state.aiHistory.push({ action, result, ts: Date.now() });
  if (state.aiHistory.length > 20) state.aiHistory.shift();
}

// ── AI API CALL ───────────────────────────────────────────────────────────────
async function callAI(action, content, options = {}) {
  const authToken = await getAuthToken();
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      content,
      contents: options.contents || [],
      tone: state.tone,
      prompt: options.prompt || '',
      brandVoice: state.brandVoice,
      audienceAvatar: state.audienceAvatar,
      userId: state.user?.id || '',
      authToken,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === 'subscription_required') { showSubscribeModal(); throw new Error('subscription_required'); }
    if (data.error === 'generation_limit') { toast(data.message || 'Monthly generation limit reached', 'error'); throw new Error('generation_limit'); }
    throw new Error(data.error || 'AI request failed');
  }
  return data.result;
}

// Streaming variant: invokes onDelta(fullTextSoFar) as text arrives and returns
// the final text. Falls back gracefully to a single JSON result in mock mode.
// Callers should catch errors and fall back to callAI() for robustness.
async function callAIStream(action, content, options = {}, onDelta) {
  const authToken = await getAuthToken();
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      content,
      contents: options.contents || [],
      tone: state.tone,
      prompt: options.prompt || '',
      brandVoice: state.brandVoice,
      audienceAvatar: state.audienceAvatar,
      userId: state.user?.id || '',
      authToken,
      stream: true,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (data.error === 'subscription_required') { showSubscribeModal(); throw new Error('subscription_required'); }
    if (data.error === 'generation_limit') { toast(data.message || 'Monthly generation limit reached', 'error'); throw new Error('generation_limit'); }
    throw new Error(data.error || 'AI request failed');
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream') || !res.body) {
    // Mock mode or a non-streaming response — single JSON result
    const data = await res.json();
    if (data.result && onDelta) onDelta(data.result);
    return data.result || '';
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() || '';
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      let data; try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (data.delta) { full += data.delta; onDelta && onDelta(full); }
      else if (data.error) { throw new Error(data.error); }
    }
  }
  return full;
}

// ── DESIGN PANEL ──────────────────────────────────────────────────────────────
function renderDesignPanel() {
  return `
<div class="panel-section">
  <div class="panel-section-title">Appearance</div>
  <div class="toggle-row">
    <span style="font-size:13px">Dark mode</span>
    <label class="toggle-switch">
      <input type="checkbox" ${state.design.darkMode ? 'checked' : ''} onchange="toggleTheme()">
      <div class="toggle-track"></div>
      <div class="toggle-thumb"></div>
    </label>
  </div>
</div>

<div class="panel-section">
  <div class="panel-section-title">Brand Color</div>
  <div class="flex items-center gap-3">
    <input type="color" id="color-picker" value="${state.design.primaryColor}">
    <span style="font-size:12px;color:var(--text-2)">${state.design.primaryColor}</span>
  </div>
</div>

<div class="panel-section">
  <div class="panel-section-title">Spacing</div>
  <div class="design-control">
    <div class="design-label">Density <span class="spacing-val">${state.design.spacing}</span></div>
    <input type="range" id="spacing-slider" min="1" max="4" value="${state.design.spacing}">
  </div>
</div>

<div class="panel-section">
  <div class="panel-section-title">Border Radius</div>
  <div class="design-control">
    <div class="design-label">Radius <span class="radius-val">${state.design.borderRadius}px</span></div>
    <input type="range" id="radius-slider" min="0" max="24" value="${state.design.borderRadius}">
  </div>
</div>

<div class="panel-section">
  <div class="panel-section-title">Preview Device</div>
  <div class="preview-device-row">
    <div class="device-btn ${state.design.device === 'desktop' ? 'active' : ''}" data-action="set-device" data-device="desktop">🖥 Desktop</div>
    <div class="device-btn ${state.design.device === 'mobile' ? 'active' : ''}" data-action="set-device" data-device="mobile">📱 Mobile</div>
  </div>
  <button class="btn btn-outline btn-sm" style="width:100%;margin-top:8px;justify-content:center" data-action="show-preview">Open preview →</button>
</div>

<div class="panel-section">
  <div class="panel-section-title">Export</div>
  <div style="display:flex;flex-direction:column;gap:5px">
    <button class="ai-action-btn" data-action="copy-html"><span class="ai-action-icon">⎘</span> Copy HTML</button>
    <button class="ai-action-btn" data-action="export-json"><span class="ai-action-icon">↓</span> Export JSON</button>
  </div>
</div>

<div class="panel-section">
  <div class="panel-section-title">Publish to</div>
  <div style="display:flex;flex-direction:column;gap:5px">
    <button class="integration-btn" data-action="beehiiv-paste-modal">🐝 Copy for Beehiiv</button>
    <button class="integration-btn" data-action="mock-sync" data-platform="beehiiv" style="font-size:11px;opacity:0.7">🐝 API: Push draft to Beehiiv</button>
    <button class="integration-btn" data-action="mock-sync" data-platform="mailchimp">📧 Sync to Mailchimp</button>
    <button class="integration-btn" data-action="mock-sync" data-platform="kit">💌 Sync to Kit</button>
  </div>
</div>
`;
}

function applyDesignSettings() {
  const d = state.design;
  document.documentElement.style.setProperty('--accent', d.primaryColor);
  document.documentElement.style.setProperty('--accent-hover', adjustColor(d.primaryColor, -20));
  document.documentElement.style.setProperty('--accent-soft', hexToRgba(d.primaryColor, 0.14));
  const basePad = 14 + (d.spacing - 1) * 4;
  document.documentElement.style.setProperty('--r-md', `${d.borderRadius}px`);
  document.documentElement.style.setProperty('--r-lg', `${d.borderRadius + 4}px`);
}

function toggleTheme() {
  state.design.darkMode = !state.design.darkMode;
  const theme = state.design.darkMode ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('lwai_theme', theme); } catch(e) {}
  // Re-render nav so sun/moon icon flips
  const nav = document.querySelector('.app-nav');
  if (nav) nav.outerHTML = renderAppNav(state.view);
  updateDesignPanel();
}

// ── TEAM PANEL ────────────────────────────────────────────────────────────────
function renderTeamPanel() {
  const statusColors = { draft: 'badge-default', review: 'badge-amber', approved: 'badge-green' };
  const statusLabels = { draft: 'Draft', review: 'In Review', approved: 'Approved' };
  return `
<div class="panel-section">
  <div class="panel-section-title">Review Status</div>
  <div class="approval-card">
    <div class="approval-status">
      <span class="badge ${statusColors[state.approvalStatus]}">${statusLabels[state.approvalStatus]}</span>
      <span style="font-size:12px;color:var(--text-3);margin-left:auto">${state.approvalStatus === 'draft' ? 'Not submitted' : state.approvalStatus === 'review' ? 'Awaiting approval' : '✓ Ready to publish'}</span>
    </div>
    <div class="team-actions">
      ${state.approvalStatus === 'draft' ? `<button class="btn btn-outline btn-sm" data-action="request-review" style="flex:1">Request Review</button>` : ''}
      ${state.approvalStatus === 'review' ? `<button class="btn btn-primary btn-sm" data-action="approve" style="flex:1">✓ Approve</button>` : ''}
      ${state.approvalStatus === 'approved' ? `<button class="btn btn-outline btn-sm" data-action="request-review" style="flex:1">Revise</button>` : ''}
    </div>
  </div>
</div>

<div class="panel-section">
  <div class="panel-section-title">Comments (${state.teamComments.length})</div>
  ${state.teamComments.map(c => `
  <div class="comment-item" style="margin-bottom:6px">
    <div class="flex items-center justify-between">
      <div class="comment-author">${escHtml(c.author)}</div>
      <div class="comment-time">${c.time}</div>
    </div>
    <div class="comment-text">${escHtml(c.text)}</div>
  </div>`).join('')}
  <form id="comment-form" class="comment-form" style="margin-top:8px">
    <textarea name="comment" class="input" style="min-height:60px;font-size:12px" placeholder="Add a comment…"></textarea>
    <button type="submit" class="btn btn-outline btn-sm" style="align-self:flex-end">Post</button>
  </form>
</div>

<div class="panel-section">
  <div class="panel-section-title">Version History</div>
  ${state.versions.map(v => `
  <div class="version-item">
    <span class="version-num">${v.num}</span>
    <span class="version-desc">${escHtml(v.desc)}</span>
    <span class="version-time">${v.time}</span>
  </div>`).join('')}
</div>
`;
}

function setApproval(status) {
  state.approvalStatus = status;
  const body = document.getElementById('panel-body');
  if (body && state.rightPanel === 'team') body.innerHTML = renderTeamPanel();
  toast(status === 'review' ? 'Review requested' : 'Newsletter approved!', 'success');
}

function submitComment(form) {
  const text = form.querySelector('[name="comment"]').value.trim();
  if (!text) return;
  state.teamComments.push({ author: state.user?.email?.split('@')[0] || 'You', text, time: 'just now' });
  state.versions.unshift({ num: `v${state.versions.length + 1}`, desc: 'Comment added', time: 'just now' });
  const body = document.getElementById('panel-body');
  if (body && state.rightPanel === 'team') body.innerHTML = renderTeamPanel();
}

function addComment() { submitComment(document.getElementById('comment-form')); }

// ── PREVIEW ───────────────────────────────────────────────────────────────────
function showPreview() {
  const overlay = document.createElement('div');
  overlay.className = 'preview-modal-overlay';
  overlay.id = 'preview-overlay';
  overlay.innerHTML = `
    <div class="preview-modal-toolbar">
      <div class="preview-modal-title">${escHtml(state.newsletter.title)}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline btn-sm" data-action="copy-html">⎘ Copy HTML</button>
        <button class="btn btn-ghost btn-sm" data-action="close-preview">✕ Close</button>
      </div>
    </div>
    <div class="email-preview-frame" style="max-width:${state.design.device === 'mobile' ? '375px' : '600px'}">
      ${buildEmailPreview()}
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePreview(); });
}

function closePreview() {
  document.getElementById('preview-overlay')?.remove();
}

function buildEmailPreview() {
  const nl = state.newsletter;
  const leads = nl.sections.leadStory;
  const hits = nl.sections.quickHits;
  const ctas = nl.sections.cta;
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return `
<div class="email-header">
  <div class="email-brand-name">${escHtml(nl.title || 'Newsletter')}</div>
  <div class="email-date">${date}</div>
  ${nl.subject ? `<div style="font-size:13px;margin-top:6px;font-family:-apple-system,sans-serif;color:#555">${escHtml(nl.subject)}</div>` : ''}
</div>
<div class="email-body">
  ${leads.length > 0 ? `
  <div class="email-lead-story">
    <div class="email-section-label">Lead Story</div>
    ${leads.map(a => `<div class="email-story-content">${formatContent(a.content || a.summary || '')}</div>`).join('<hr style="border:none;border-top:1px solid #eee;margin:20px 0">')}
  </div>` : ''}
  ${hits.length > 0 ? `
  <div>
    <div class="email-section-label">Quick Hits</div>
    ${hits.map(a => `<div class="email-quick-hit">${formatContent(a.content || a.summary || '')}</div>`).join('')}
  </div>` : ''}
  ${ctas.length > 0 ? `
  <div>
    ${ctas.map(a => `<div class="email-cta-block">${formatContent(a.content || a.summary || '')}</div>`).join('')}
  </div>` : ''}
  ${leads.length === 0 && hits.length === 0 && ctas.length === 0 ? `
  <div style="text-align:center;padding:40px;color:#888;font-family:-apple-system,sans-serif">
    <div style="font-size:24px;margin-bottom:12px">📬</div>
    <p>Add articles to your newsletter sections to see them here.</p>
  </div>` : ''}
</div>
<div class="email-footer">
  <p>You're receiving this because you subscribed to ${escHtml(nl.title || 'this newsletter')}.</p>
  <p style="margin-top:6px"><a href="#" style="color:#888">Unsubscribe</a> · <a href="#" style="color:#888">View in browser</a></p>
</div>`;
}

// ── EXPORT ────────────────────────────────────────────────────────────────────
function buildExportHTML() {
  const nl = state.newsletter;
  const accent = state.design.primaryColor || '#6366f1';
  const topStories = nl.topStoriesContent;
  const leads = nl.sections.leadStory;
  const hits  = nl.sections.quickHits;
  const ctas  = nl.sections.cta;

  const storyRows = leads.map(a => `
    <tr><td style="padding:0 0 24px">
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:16px;line-height:1.7;color:#1a1a1a">
        ${formatContent(a.content || a.summary || '')}
      </div>
    </td></tr>`).join('');

  const hitRows = hits.map(a => `
    <tr><td style="padding:0 0 16px;border-left:3px solid ${accent};padding-left:14px;margin-bottom:16px">
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">
        ${formatContent(a.content || a.summary || '')}
      </div>
    </td></tr>`).join('');

  const ctaRows = ctas.map(a => `
    <tr><td style="background:${accent}14;border-radius:8px;padding:20px 24px">
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">
        ${formatContent(a.content || a.summary || '')}
      </div>
    </td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(nl.title || 'Newsletter')}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px">
  <!-- Header -->
  <tr><td style="background:${accent};padding:28px 40px;text-align:center">
    <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px">${escHtml(nl.title || 'Newsletter')}</div>
    ${nl.subject ? `<div style="font-size:13px;color:rgba(255,255,255,0.8);margin-top:6px">${escHtml(nl.subject)}</div>` : ''}
  </td></tr>
  <!-- Body -->
  <tr><td style="padding:32px 40px">
    <table width="100%" cellpadding="0" cellspacing="0">
    ${topStories ? `
      <tr><td style="padding:0 0 8px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${accent}">Today's Briefing</div>
      </td></tr>
      <tr><td style="padding:0 0 24px;border-bottom:1px solid #eee">
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:2;color:#1a1a1a">
          ${topStories.split('\n').filter(l => l.trim()).map(line =>
            `<div style="padding:3px 0">${escHtml(line).replace(/https?:\/\/[^\s]+/g, url => `<a href="${url}" style="color:${accent};font-size:12px;text-decoration:none">${url}</a>`)}</div>`
          ).join('')}
        </div>
      </td></tr>` : ''}
    ${leads.length > 0 ? `
      <tr><td style="padding:${topStories ? '24px' : '0'} 0 8px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${accent}">Lead Story</div>
      </td></tr>
      ${storyRows}` : ''}
    ${hits.length > 0 ? `
      <tr><td style="padding:${leads.length > 0 ? '16px' : '0'} 0 8px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${accent}">Quick Hits</div>
      </td></tr>
      ${hitRows}` : ''}
    ${ctas.length > 0 ? `
      <tr><td style="padding:16px 0 0">
        ${ctaRows}
      </td></tr>` : ''}
    </table>
  </td></tr>
  <!-- Footer -->
  <tr><td style="background:#f9f9f9;padding:20px 40px;text-align:center;border-top:1px solid #eee">
    <p style="margin:0;font-size:12px;color:#888">You're receiving this because you subscribed to ${escHtml(nl.title || 'this newsletter')}.</p>
    <p style="margin:8px 0 0;font-size:12px"><a href="{{unsubscribe_url}}" style="color:#888">Unsubscribe</a> &middot; <a href="{{browser_url}}" style="color:#888">View in browser</a></p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function copyHTML() {
  navigator.clipboard.writeText(buildExportHTML())
    .then(() => toast('Email-safe HTML copied to clipboard', 'success'))
    .catch(() => toast('Copy failed', 'error'));
}

function exportJSON() {
  const data = JSON.stringify({ newsletter: state.newsletter, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${state.newsletter.title.replace(/\s+/g, '-').toLowerCase()}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast('JSON exported', 'success');
}

function mockSync(platform) {
  toast(`Syncing to ${platform}…`, 'info');
  setTimeout(() => toast(`✓ Synced to ${platform} successfully`, 'success'), 1800);
}


// ── SUBSCRIBE MODAL ───────────────────────────────────────────────────────────
function showSubscribeModal() {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  const used = state.generationsThisMonth || 0;
  modal.innerHTML = `
<div id="modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px">
  <div style="background:var(--bg-2);border:1px solid var(--border-md);border-radius:var(--r-xl);padding:36px;max-width:420px;width:100%;text-align:center;box-shadow:var(--shadow-xl)">
    <div style="font-size:36px;margin-bottom:12px">✦</div>
    <div style="font-size:20px;font-weight:700;margin-bottom:8px">Start your free trial</div>
    <div style="font-size:14px;color:var(--text-2);line-height:1.6;margin-bottom:24px">
      Try Curanta free for <strong>7 days</strong> — no charge until the trial ends.<br>
      Cancel anytime. 500 generations per month included.
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:24px">
      <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-2)"><span style="color:var(--green)">✓</span> Lead stories, quick hits, briefings</div>
      <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-2)"><span style="color:var(--green)">✓</span> Brand voice generation & matching</div>
      <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-2)"><span style="color:var(--green)">✓</span> Subject lines, rewrites, CTAs</div>
      <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-2)"><span style="color:var(--green)">✓</span> 500 generations / month</div>
    </div>
    <button class="btn btn-primary" style="width:100%;justify-content:center;font-size:15px;padding:12px" onclick="closeModal();startCheckout('pro')">Start free trial →</button>
    <button class="btn btn-ghost btn-sm" style="margin-top:10px;width:100%;justify-content:center" onclick="closeModal()">Maybe later</button>
  </div>
</div>`;
  modal.querySelector('#modal-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
}

// ── CUSTOM SECTIONS ───────────────────────────────────────────────────────────
function showAddSectionModal() {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  modal.innerHTML = `
  <div class="modal-overlay" id="add-section-overlay">
    <div class="modal" style="max-width:420px">
      <div class="modal-header">
        <div>
          <div class="modal-title">Add section</div>
          <div class="modal-sub">Give your new section a name and choose how AI will write content for it.</div>
        </div>
        <button class="btn-icon" data-action="close-modal" style="font-size:18px;line-height:1">×</button>
      </div>
      <div class="modal-body" style="padding:16px 20px">
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label" for="new-section-name">Section name</label>
          <input id="new-section-name" class="input" type="text" placeholder="e.g. Market Moves, Policy Watch…" style="width:100%;box-sizing:border-box">
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label class="form-label" for="new-section-type">Content style</label>
          <select id="new-section-type" class="input" style="width:100%;box-sizing:border-box">
            <option value="hits">Quick hits (short blurbs)</option>
            <option value="lead">Lead story (long form)</option>
            <option value="cta">CTA / Sponsor</option>
            <option value="generic">Generic (same as quick hits)</option>
          </select>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" style="flex:1" data-action="confirm-add-section">Add section</button>
          <button class="btn btn-outline" data-action="close-modal">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
  modal.querySelector('#add-section-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  modal.querySelector('#new-section-name').focus();
}

function confirmAddSection() {
  const name = document.getElementById('new-section-name')?.value.trim();
  const type = document.getElementById('new-section-type')?.value;
  if (!name) { toast('Enter a section name', 'warn'); return; }
  const id = 'custom_' + uid();
  state.newsletter.sectionOrder.push(id);
  state.newsletter.sectionMeta[id] = { name, type };
  state.newsletter.sections[id] = [];
  state.newsletter.prompts[id] = '';
  closeModal();
  render();
  scheduleSave();
}

function removeSection(sectionId) {
  if (state.newsletter.sectionOrder.length <= 1) { toast('A newsletter needs at least one section', 'warn'); return; }
  const meta = state.newsletter.sectionMeta[sectionId] || {};
  const name = meta.name || 'this section';
  const arr = state.newsletter.sections[sectionId] || [];

  // Does this section have content worth warning about?
  let hasContent = arr.length > 0;
  if (meta.type === 'briefing') hasContent = hasContent || !!(state.newsletter.topStoriesContent || '').trim();
  if (isSynthType(meta.type)) { const e = arr.find(a => a._lead); hasContent = !!(e && (e.content || e._sources?.length)); }

  const msg = hasContent
    ? `Delete the "${name}" section? Its content in this issue will be removed (this won't affect your saved default layout unless you re-save it).`
    : `Delete the "${name}" section?`;
  if (!confirm(msg)) return;

  state.newsletter.sectionOrder = state.newsletter.sectionOrder.filter(id => id !== sectionId);
  delete state.newsletter.sections[sectionId];
  delete state.newsletter.sectionMeta[sectionId];
  delete state.newsletter.prompts[sectionId];
  if (meta.type === 'briefing') state.newsletter.topStoriesContent = ''; // briefing output lives here
  render();
  scheduleSave();
  toast(`"${name}" section deleted`, 'info');
}

function inlineRenameSection(sectionId) {
  const current = state.newsletter.sectionMeta[sectionId]?.name || '';
  const newName = window.prompt('Rename section:', current);
  if (newName && newName.trim()) {
    state.newsletter.sectionMeta[sectionId].name = newName.trim();
    render();
    scheduleSave();
  }
}

// ── SECTION DRAG-TO-REORDER ───────────────────────────────────────────────────
function sectionDragStart(e, sectionId) {
  // Only allow drag when initiated from the drag handle
  if (state._sectionDragReady !== sectionId) { e.preventDefault(); return; }
  state._sectionDragReady = null;
  state.draggedSection = sectionId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', sectionId);
  setTimeout(() => { document.getElementById(`section-${sectionId}`)?.classList.add('section-dragging'); }, 0);
}
window.sectionDragStart = sectionDragStart;

function sectionDragEnd(e) {
  state.draggedSection = null;
  state._sectionDragReady = null;
  document.querySelectorAll('.editor-section').forEach(el => {
    el.classList.remove('section-dragging', 'section-drag-over-top', 'section-drag-over-bottom');
  });
}
window.sectionDragEnd = sectionDragEnd;

function sectionDragOver(e, sectionId) {
  if (!state.draggedSection || state.draggedSection === sectionId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const el = document.getElementById(`section-${sectionId}`);
  const rect = el.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  document.querySelectorAll('.editor-section').forEach(el => el.classList.remove('section-drag-over-top', 'section-drag-over-bottom'));
  el.classList.add(before ? 'section-drag-over-top' : 'section-drag-over-bottom');
}
window.sectionDragOver = sectionDragOver;

function sectionDrop(e, targetId) {
  if (!state.draggedSection || state.draggedSection === targetId) return;
  e.preventDefault();
  const order = [...state.newsletter.sectionOrder];
  const fromIdx = order.indexOf(state.draggedSection);
  const el = document.getElementById(`section-${targetId}`);
  const rect = el.getBoundingClientRect();
  const dropBefore = e.clientY < rect.top + rect.height / 2;
  // Remove dragged item
  order.splice(fromIdx, 1);
  // Recalculate target index after removal, then insert
  const newToIdx = order.indexOf(targetId);
  order.splice(dropBefore ? newToIdx : newToIdx + 1, 0, state.draggedSection);
  state.newsletter.sectionOrder = order;
  state.draggedSection = null;
  document.querySelectorAll('.editor-section').forEach(el => el.classList.remove('section-dragging', 'section-drag-over-top', 'section-drag-over-bottom'));
  // Re-render sections only (avoids full re-render)
  const sectionsEl = document.getElementById('editor-sections');
  if (sectionsEl) { sectionsEl.innerHTML = renderEditorSections(); setupDropZones(); }
  scheduleSave();
}
window.sectionDrop = sectionDrop;

// ── PERSISTENCE LAYER ─────────────────────────────────────────────────────────

// ── User settings (brand voice, tone, color) ──────────────────────────────────
let _settingsTimer = null;
function scheduleSettingsSave() {
  cacheSettingsLocally(); // mirror immediately so settings can never be lost to a DB hiccup
  if (!sb || !state.user) return;
  clearTimeout(_settingsTimer);
  _settingsTimer = setTimeout(saveUserSettings, 1500);
}

// Local backup of voice / audience / tone / section-default prompts, keyed per
// publication. This is a safety net: even if a DB write fails (e.g. a missing
// column rejects the whole upsert), your prompts survive a reload on this browser.
function settingsLSKey() { return `lwai_settings_${state.currentPublicationId || 'default'}`; }

function cacheSettingsLocally() {
  try {
    localStorage.setItem(settingsLSKey(), JSON.stringify({
      brandVoice: state.brandVoice || '',
      brandVoiceSamples: state.brandVoiceSamples || '',
      audienceAvatar: state.audienceAvatar || '',
      voiceUrls: state.voiceUrls || [],
      tone: state.tone || 'punchy-executive',
      brandColor: state.design.primaryColor || '#6366f1',
      defaultPrompts: state.defaultPrompts || {},
      ts: Date.now(),
    }));
  } catch (e) { /* storage full/unavailable */ }
}

// Backfill anything the DB didn't provide (recovers from a failed/partial save).
function restoreSettingsFromCache() {
  try {
    const raw = localStorage.getItem(settingsLSKey());
    if (!raw) return;
    const c = JSON.parse(raw);
    if (!state.brandVoice && c.brandVoice)               state.brandVoice        = c.brandVoice;
    if (!state.brandVoiceSamples && c.brandVoiceSamples) state.brandVoiceSamples = c.brandVoiceSamples;
    if (!state.audienceAvatar && c.audienceAvatar)       state.audienceAvatar    = c.audienceAvatar;
    if ((!state.voiceUrls || !state.voiceUrls.length) && c.voiceUrls?.length) state.voiceUrls = c.voiceUrls;
    if (c.tone && (!state.tone || state.tone === 'punchy-executive')) state.tone = c.tone;
    // DB-loaded prompts win; cache fills any keys the DB was missing
    if (c.defaultPrompts) state.defaultPrompts = { ...c.defaultPrompts, ...(state.defaultPrompts || {}) };
  } catch (e) { /* ignore */ }
}

async function saveUserSettings() {
  cacheSettingsLocally(); // always mirror first — DB write can never lose your prompts
  if (!sb || !state.user) return;

  if (state.currentPublicationId) {
    // A non-default publication is active. Persist the brand-voice/audience/tone/prompts
    // ONLY to that publication's row — never to user_settings (which is the Default's store).
    const pubFields = {
      brand_voice:     state.brandVoice      || '',
      audience_avatar: state.audienceAvatar  || '',
      tone:            state.tone            || 'punchy-executive',
      default_prompts: state.defaultPrompts  || {},
    };
    let { error } = await sb.from('publications').update(pubFields)
      .eq('id', state.currentPublicationId).eq('user_id', state.user.id);
    if (error) {
      // Retry with just the two most essential prompt fields in case a column is missing
      const { error: e2 } = await sb.from('publications')
        .update({ brand_voice: pubFields.brand_voice, default_prompts: pubFields.default_prompts })
        .eq('id', state.currentPublicationId).eq('user_id', state.user.id);
      if (e2) console.error('Publication settings save failed (cached locally):', e2.message);
    }
    const idx = state.publications.findIndex(p => p.id === state.currentPublicationId);
    if (idx >= 0) state.publications[idx] = { ...state.publications[idx], ...pubFields };

    // Account-level field — best effort, never blocks the prompt save above.
    await sb.from('user_settings').update({
      brand_color: state.design.primaryColor || '#6366f1',
      updated_at: new Date().toISOString(),
    }).eq('user_id', state.user.id).then(({ error: e }) => { if (e) console.warn('brand_color save skipped:', e.message); });
    return;
  }

  // Default publication active — its settings live in user_settings.
  const full = {
    user_id: state.user.id,
    brand_voice: state.brandVoice || '',
    brand_voice_samples: state.brandVoiceSamples || '',
    audience_avatar: state.audienceAvatar || '',
    voice_urls: state.voiceUrls || [],
    tone: state.tone || 'punchy-executive',
    brand_color: state.design.primaryColor || '#6366f1',
    default_prompts: state.defaultPrompts || {},
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from('user_settings').upsert(full, { onConflict: 'user_id' });
  if (error) {
    // A missing column rejects the WHOLE upsert (this is what wiped brand voice before).
    // Retry with only the long-standing essential columns so prompts always persist.
    console.warn('Full settings save failed, retrying essentials only:', error.message);
    const essential = {
      user_id: state.user.id,
      brand_voice: state.brandVoice || '',
      audience_avatar: state.audienceAvatar || '',
      tone: state.tone || 'punchy-executive',
      default_prompts: state.defaultPrompts || {},
      updated_at: new Date().toISOString(),
    };
    const { error: e2 } = await sb.from('user_settings').upsert(essential, { onConflict: 'user_id' });
    if (e2) console.error('Essential settings save also failed (cached locally):', e2.message);
  }
}

async function loadUserSettings() {
  if (!sb || !state.user) return;
  const { data, error } = await sb
    .from('user_settings')
    .select('*')
    .eq('user_id', state.user.id)
    .single();
  if (error || !data) { restoreSettingsFromCache(); return; } // recover from local backup if DB has nothing
  if (data.brand_voice)              state.brandVoice           = data.brand_voice;
  if (data.brand_voice_samples)      state.brandVoiceSamples    = data.brand_voice_samples;
  if (data.audience_avatar)          state.audienceAvatar       = data.audience_avatar;
  if (data.voice_urls?.length)       state.voiceUrls            = data.voice_urls;
  if (data.tone)                     state.tone                 = data.tone;
  if (data.brand_color)              state.design.primaryColor  = data.brand_color;
  if (data.default_prompts)          state.defaultPrompts       = { ...state.defaultPrompts, ...data.default_prompts };
  if (data.subscription_status)           state.subscriptionStatus   = data.subscription_status;
  if (data.subscription_plan)            state.subscriptionPlan     = data.subscription_plan;
  if (data.grandfathered)                state.grandfathered        = data.grandfathered;
  if (data.generations_this_month != null) state.generationsThisMonth = data.generations_this_month;
  if (data.trial_ends_at)                 state.trialEndsAt          = data.trial_ends_at;

  // Backfill anything the DB didn't return (recovers from a prior failed save)
  restoreSettingsFromCache();

  // Load publications for multi-pub-capable users, then restore + apply the last active publication
  if (data.grandfathered || (data.subscription_plan === 'multi')) {
    await loadPublications();
    try {
      const savedPub = localStorage.getItem('lwai_current_pub');
      if (savedPub && state.publications.some(p => p.id === savedPub)) {
        state.currentPublicationId = savedPub;
      }
    } catch (e) {}
    applyCurrentPublication();
  }
}

async function loadPublications() {
  if (!sb || !state.user) return;
  const { data } = await sb.from('publications')
    .select('*').eq('user_id', state.user.id).order('created_at');
  if (data) state.publications = data;
}

function applyCurrentPublication() {
  if (!state.currentPublicationId) return;
  const pub = state.publications.find(p => p.id === state.currentPublicationId);
  if (!pub) { state.currentPublicationId = null; return; }
  state.brandVoice      = pub.brand_voice      || '';
  state.audienceAvatar  = pub.audience_avatar  || '';
  state.tone            = pub.tone             || state.tone;
  state.defaultPrompts  = pub.default_prompts  || {};
  restoreSettingsFromCache(); // backfill this publication's prompts if the DB row was incomplete
}

function currentPublicationName() {
  if (!state.currentPublicationId) return state.defaultPublicationName || 'Default';
  return state.publications.find(p => p.id === state.currentPublicationId)?.name || 'Default';
}

// How many publications this account can have (Default + extras)
function pubLimit() {
  if (state.grandfathered) return Infinity;
  if (state.subscriptionPlan === 'multi' && isSubscribed()) return 3;
  return 1; // pro or free — default only
}

// Can the user see the real multi-pub UI?
function canUsePubs() {
  return state.grandfathered || (state.subscriptionPlan === 'multi' && isSubscribed());
}

async function _legacySubscribeMultiUnused() {
  // replaced by startCheckout('multi') — kept to avoid accidental deletion of closing braces
  if (!state.user) { toast('Sign in first', 'warn'); return; }
  toast('Opening checkout…', 'info');
  try {
    const authToken = await getAuthToken();
    const res = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.user.id, authToken, email: state.user.email, plan: 'multi' }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else throw new Error(data.error || 'Checkout failed');
  } catch (e) { toast('Checkout error: ' + e.message, 'error'); }
}

// ── Publication management ────────────────────────────────────────────────────
function showNewPublicationModal() {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  modal.innerHTML = `
  <div class="modal-overlay" id="pub-modal-overlay">
    <div class="modal">
      <div class="modal-header">
        <div>
          <div class="modal-title">New Publication</div>
          <div class="modal-sub">Each publication has its own brand voice, audience, and prompt defaults.</div>
        </div>
        <button class="btn-icon" data-action="close-modal" style="font-size:18px">×</button>
      </div>
      <div class="modal-body">
        <form id="new-pub-form" class="auth-form">
          <div id="new-pub-error" class="auth-error hidden"></div>
          <div class="form-group">
            <label class="form-label">Publication name</label>
            <input id="new-pub-name" type="text" class="input" placeholder="e.g. The Weekly Brief" required maxlength="80" autofocus>
          </div>
          <p style="font-size:12px;color:var(--text-3);line-height:1.6;margin-top:4px">
            Starting fresh — you can configure brand voice, audience avatar, and default prompts in Settings after switching.
          </p>
          <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:8px">Create publication →</button>
        </form>
      </div>
    </div>
  </div>`;
  modal.querySelector('#pub-modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  document.getElementById('new-pub-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('new-pub-name')?.value.trim();
    const errEl = document.getElementById('new-pub-error');
    const btn = e.target.querySelector('button[type="submit"]');
    if (!name) return;
    btn.disabled = true; btn.textContent = 'Creating…';
    await createPublication(name, errEl, btn);
  });
  document.getElementById('new-pub-name')?.focus();
}

async function createPublication(name, errEl, btn) {
  if (!sb || !state.user) return;
  // Save current publication settings before switching
  await saveUserSettings();
  const { data, error } = await sb.from('publications').insert({
    user_id:         state.user.id,
    name,
    brand_voice:     '',
    audience_avatar: '',
    tone:            'punchy-executive',
    default_prompts: {},
  }).select().single();
  if (error) {
    if (errEl) { errEl.classList.remove('hidden'); errEl.textContent = error.message; }
    if (btn) { btn.disabled = false; btn.textContent = 'Create publication →'; }
    return;
  }
  state.publications.push(data);
  closeModal();
  await switchPublication(data.id);
  toast(`✓ Switched to "${name}" — configure its settings below.`, 'success');
}

async function switchPublication(id) {
  // Save current before switching
  await saveUserSettings();
  state.currentPublicationId = id;
  try {
    if (id) localStorage.setItem('lwai_current_pub', id);
    else localStorage.removeItem('lwai_current_pub');
  } catch (e) {}
  if (id === null) {
    // Switch back to default — reload from user_settings
    const { data } = await sb.from('user_settings').select('*').eq('user_id', state.user.id).single();
    if (data) {
      state.brandVoice     = data.brand_voice      || '';
      state.audienceAvatar = data.audience_avatar  || '';
      state.tone           = data.tone             || 'punchy-executive';
      state.defaultPrompts = data.default_prompts  || {};
    } else {
      state.brandVoice = ''; state.audienceAvatar = ''; state.defaultPrompts = {};
    }
    restoreSettingsFromCache(); // backfill Default's prompts if the DB row was incomplete
  } else {
    applyCurrentPublication();
  }
  // Reload sources + newsletters scoped to the new publication
  state.sources = await loadSourcesFromDB();
  state.dbNewsletters = await loadNewslettersFromDB();
  // Fetch articles for the newly loaded sources in the background
  autoFetchSources();
  render();
  toast(`Switched to "${currentPublicationName()}"`, 'success');
}

async function deletePublication(id) {
  const pub = state.publications.find(p => p.id === id);
  if (!pub) return;
  if (!confirm(`Delete "${pub.name}"? This cannot be undone.`)) return;
  const { error } = await sb.from('publications').delete().eq('id', id).eq('user_id', state.user.id);
  if (error) { toast('Delete failed', 'error'); return; }
  state.publications = state.publications.filter(p => p.id !== id);
  if (state.currentPublicationId === id) {
    await switchPublication(null); // fall back to default
  } else {
    render();
  }
  toast(`"${pub.name}" deleted`, 'success');
}

async function renamePublication(id) {
  const pub = state.publications.find(p => p.id === id);
  if (!pub) return;
  const newName = window.prompt('Rename publication:', pub.name);
  if (!newName?.trim() || newName.trim() === pub.name) return;
  const { error } = await sb.from('publications').update({ name: newName.trim() }).eq('id', id).eq('user_id', state.user.id);
  if (error) { toast('Rename failed', 'error'); return; }
  pub.name = newName.trim();
  render();
}

function renameDefaultPublication() {
  const newName = window.prompt('Rename default publication:', state.defaultPublicationName || 'Default');
  if (!newName?.trim()) return;
  state.defaultPublicationName = newName.trim();
  try { localStorage.setItem('lwai_default_pub_name', newName.trim()); } catch(e) {}
  render();
}

// ── Stripe helpers ────────────────────────────────────────────────────────────
async function getAuthToken() {
  if (!sb) return '';
  try {
    const { data } = await sb.auth.getSession();
    return data.session?.access_token || '';
  } catch { return ''; }
}

// ── Checkout ──────────────────────────────────────────────────────────────────
// Call this from anywhere — handles both signed-in (goes straight to Stripe)
// and guest (stores intent, shows auth modal, then redirects after sign-in/up).
async function startCheckout(plan = 'pro') {
  if (!state.hasStripe) { navigate('subscription'); return; }
  if (!state.user) {
    setPendingPlan(plan);
    showAuthModal('signup');
    return;
  }
  await startCheckoutForUser(state.user, plan);
}

async function startCheckoutForUser(user, plan = 'pro') {
  toast('Opening checkout…', 'info');
  try {
    const authToken = await getAuthToken();
    const res = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user.id, authToken, email: user.email, plan }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else throw new Error(data.error || 'Checkout failed');
  } catch (e) { toast('Checkout error: ' + e.message, 'error'); }
}

async function subscribe()      { await startCheckout('pro'); }
async function subscribeMulti() { await startCheckout('multi'); }
window.subscribe      = subscribe;
window.startCheckout  = startCheckout;

async function manageBilling() {
  if (!state.user) return;
  toast('Opening billing portal…', 'info');
  try {
    const authToken = await getAuthToken();
    const res = await fetch('/api/stripe/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.user.id, authToken }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else throw new Error(data.error || 'Portal failed');
  } catch (e) { toast('Billing portal error: ' + e.message, 'error'); }
}
window.manageBilling = manageBilling;

function showContactPopup() {
  const existing = document.getElementById('contact-popup');
  if (existing) { existing.remove(); return; }
  const popup = document.createElement('div');
  popup.id = 'contact-popup';
  popup.style.cssText = `
    position:fixed;bottom:72px;left:50%;transform:translateX(-50%);
    background:var(--bg-2);border:1px solid var(--border-md);border-radius:var(--r-lg);
    box-shadow:var(--shadow-xl);padding:20px 24px;z-index:9000;
    text-align:center;min-width:280px;animation:fade-in 0.15s ease
  `;
  popup.innerHTML = `
    <div style="font-size:13px;font-weight:700;margin-bottom:6px">Get in touch</div>
    <div style="font-size:13px;color:var(--text-2);margin-bottom:14px">We'd love to hear from you.</div>
    <a href="mailto:noah@getcuranta.com" style="display:block;background:var(--accent);color:#fff;border-radius:var(--r-md);padding:9px 16px;font-size:13px;font-weight:600;text-decoration:none;margin-bottom:8px">
      ✉️ noah@getcuranta.com
    </a>
    <button onclick="navigator.clipboard.writeText('noah@getcuranta.com');this.textContent='✓ Copied!';setTimeout(()=>this.textContent='Copy email',1500)"
      style="background:var(--bg-3);border:1px solid var(--border-md);border-radius:var(--r-md);padding:7px 14px;font-size:12px;color:var(--text-2);cursor:pointer;width:100%">
      Copy email
    </button>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
      <button onclick="window.open('https://calendly.com/noahrin/60-minute-tutoring-clone','_blank')"
        style="background:none;border:none;color:var(--accent);font-size:12px;cursor:pointer;text-decoration:underline">
        Or book a 30-min call →
      </button>
    </div>
  `;
  document.body.appendChild(popup);
  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', handler); }
    });
  }, 50);
}
window.showContactPopup = showContactPopup;

function isSubscribed() {
  return state.grandfathered || ['active', 'trialing', 'past_due'].includes(state.subscriptionStatus);
}

function trialDaysLeft() {
  if (!state.trialEndsAt) return null;
  const ms = new Date(state.trialEndsAt) - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

function renderTrialBanner() {
  if (state.subscriptionStatus === 'past_due') {
    return `<div class="trial-banner" style="border-color:var(--red);color:var(--red);background:var(--red-soft)">
      <span>⚠️ <strong>Payment failed.</strong> Update your payment method to keep access.</span>
      <button class="btn btn-sm" style="background:var(--red);color:#fff;flex-shrink:0" data-action="manage-billing">Update payment →</button>
    </div>`;
  }
  if (state.subscriptionStatus !== 'trialing') return '';
  const days = trialDaysLeft();
  if (days === null || days > 3) return '';
  const urgency = days === 0 ? 'var(--red)' : days === 1 ? 'var(--amber)' : 'var(--accent)';
  const msg = days === 0 ? 'Your free trial ends <strong>today</strong>.'
    : `Your free trial ends in <strong>${days} day${days === 1 ? '' : 's'}</strong>.`;
  const planPrice = state.subscriptionPlan === 'multi' ? '$99/mo' : '$49/mo';
  return `<div class="trial-banner" style="border-color:${urgency};color:${urgency}">
    <span>⏳ ${msg} After that you'll be charged ${planPrice}.</span>
    <button class="btn btn-sm" style="background:${urgency};color:#fff;flex-shrink:0" data-action="navigate" data-view="subscription">Manage →</button>
  </div>`;
}

// Auto-save debounce
let _saveTimer = null;
// ── BUILDER DRAFT PERSISTENCE (survive refresh + autosave debounce window) ─────
function builderDraftKey(id) { return `lwai_draft_${id || state.newsletterId || 'new'}`; }

function cacheBuilderDraft() {
  try {
    const nl = state.newsletter;
    localStorage.setItem(builderDraftKey(), JSON.stringify({
      title: nl.title, subject: nl.subject, previewText: nl.previewText,
      subjectLines: nl.subjectLines, sections: nl.sections,
      sectionOrder: nl.sectionOrder, sectionMeta: nl.sectionMeta,
      prompts: nl.prompts, topStoriesContent: nl.topStoriesContent,
      ts: Date.now(),
    }));
    localStorage.setItem('lwai_open_view', 'builder');
    localStorage.setItem('lwai_open_nl', state.newsletterId || 'new');
  } catch (e) { /* storage full/unavailable */ }
}

function readBuilderDraft(id) {
  try { const raw = localStorage.getItem(builderDraftKey(id)); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}

function clearBuilderDraft(id) { try { localStorage.removeItem(builderDraftKey(id)); } catch (e) {} }

function applyBuilderDraft(draft) {
  if (!draft) return;
  const nl = state.newsletter;
  if (draft.title != null)            nl.title            = draft.title;
  if (draft.subject != null)          nl.subject          = draft.subject;
  if (draft.previewText != null)      nl.previewText      = draft.previewText;
  if (draft.subjectLines)             nl.subjectLines     = draft.subjectLines;
  if (draft.sections)                 nl.sections         = draft.sections;
  if (draft.sectionOrder)             nl.sectionOrder     = draft.sectionOrder;
  if (draft.sectionMeta)              nl.sectionMeta      = draft.sectionMeta;
  if (draft.prompts)                  nl.prompts          = draft.prompts;
  if (draft.topStoriesContent != null) nl.topStoriesContent = draft.topStoriesContent;
}

function scheduleSave() {
  cacheBuilderDraft(); // mirror immediately so a refresh never loses in-progress edits
  if (!sb || !state.user) return;
  setSaveIndicator('saving');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveNewsletter, 1800);
}

function setSaveIndicator(status) {
  const el = document.querySelector('.save-pill');
  if (!el) return;
  if (status === 'saving') { el.textContent = 'Saving…'; el.style.color = 'var(--amber)'; }
  else if (status === 'saved') { el.textContent = 'Saved'; el.style.color = 'var(--green)'; setTimeout(() => { const e = document.querySelector('.save-pill'); if (e) { e.textContent = 'Auto-saved'; e.style.color = ''; } }, 2000); }
  else if (status === 'error') { el.textContent = 'Save failed'; el.style.color = 'var(--red)'; }
}

async function saveNewsletter() {
  if (!sb || !state.user) return;
  state.saving = true;
  const payload = {
    user_id: state.user.id,
    title: state.newsletter.title,
    subject: state.newsletter.subject,
    preview_text: state.newsletter.previewText,
    subject_lines: state.newsletter.subjectLines || [],
    sections: {
      ...state.newsletter.sections,
      __order: state.newsletter.sectionOrder,
      __meta: state.newsletter.sectionMeta,
    },
    prompts: state.newsletter.prompts,
    top_stories_content: state.newsletter.topStoriesContent,
    status: state.approvalStatus,
    updated_at: new Date().toISOString(),
  };
  try {
    if (state.newsletterId) {
      // Update: never change which publication a newsletter belongs to.
      const { error } = await sb.from('newsletters').update(payload).eq('id', state.newsletterId);
      if (error) throw error;
    } else {
      // New newsletter: stamp it with the active publication so it stays separate.
      const scoped = await ensureNewslettersCapability();
      const insertPayload = scoped ? { ...payload, publication_id: state.currentPublicationId || null } : payload;
      const { data: row, error } = await sb.from('newsletters').insert(insertPayload).select('id').single();
      if (error) throw error;
      clearBuilderDraft('new'); // migrate the "new" draft to the freshly-minted id
      state.newsletterId = row.id;
      try { localStorage.setItem('lwai_open_nl', row.id); } catch (e) {}
    }
    clearBuilderDraft(); // DB is now authoritative — drop the local recovery draft
    setSaveIndicator('saved');
  } catch (e) {
    console.error('Save error:', e);
    setSaveIndicator('error');
  }
  state.saving = false;
}

// Detect once whether the newsletters table has the publication_id column.
async function ensureNewslettersCapability() {
  if (state.newslettersPubScoped !== null) return state.newslettersPubScoped;
  if (!sb || !state.user) { state.newslettersPubScoped = false; return false; }
  const { error } = await sb.from('newsletters')
    .select('id').eq('user_id', state.user.id).is('publication_id', null).limit(1);
  state.newslettersPubScoped = !error; // error => column missing
  return state.newslettersPubScoped;
}

async function loadNewslettersFromDB() {
  if (!sb || !state.user) return [];
  const pubId = state.currentPublicationId || null;
  const scoped = await ensureNewslettersCapability();
  let query = sb.from('newsletters')
    .select('id, title, subject, status, created_at, updated_at')
    .eq('user_id', state.user.id)
    .order('updated_at', { ascending: false })
    .limit(50);
  if (scoped) query = pubId ? query.eq('publication_id', pubId) : query.is('publication_id', null);
  const { data, error } = await query;
  if (error) { console.error('Load newsletters error:', error); return []; }
  return data.map(nl => ({
    id: nl.id,
    title: nl.title || 'Untitled',
    subject: nl.subject || '',
    status: nl.status || 'draft',
    updatedAt: nl.updated_at,
  }));
}

async function loadBuilderData(newsletterId) {
  if (!sb) return false;
  const { data: nl, error } = await sb.from('newsletters').select('*').eq('id', newsletterId).single();
  if (error || !nl) { console.error('Load newsletter error:', error); return false; }
  state.newsletterId = nl.id;
  state.newsletter.title        = nl.title        || 'Untitled Newsletter';
  state.newsletter.subject      = nl.subject       || '';
  state.newsletter.previewText  = nl.preview_text  || '';
  state.newsletter.subjectLines = nl.subject_lines || [];
  const raw = nl.sections || {};
  state.newsletter.sectionOrder = raw.__order || ['topStories', 'leadStory', 'quickHits', 'cta'];
  state.newsletter.sectionMeta  = raw.__meta  || {
    topStories: { name: "Today's Briefing", type: 'briefing' },
    leadStory:  { name: 'Lead Story',       type: 'lead' },
    quickHits:  { name: 'Quick Hits',       type: 'hits' },
    cta:        { name: 'Sponsor / CTA',    type: 'cta' },
  };
  const { __order, __meta, ...sectionData } = raw;
  state.newsletter.sections = { topStories: [], leadStory: [], quickHits: [], cta: [], ...sectionData };
  state.newsletter.topStoriesContent = nl.top_stories_content || '';
  state.newsletter.prompts           = nl.prompts            || state.newsletter.prompts;
  state.approvalStatus         = nl.status        || 'draft';
  // Recover any unsaved edits made just before a refresh (newer than the DB row)
  const draft = readBuilderDraft(newsletterId);
  if (draft && draft.ts > Date.parse(nl.updated_at || 0)) applyBuilderDraft(draft);
  state.sources = await loadSourcesFromDB();
  return true;
}

// Maps a section type to its default-prompt key in state.defaultPrompts.
function typeDefaultKey(type) {
  return ({ briefing: 'briefing', lead: 'lead', hits: 'hits', cta: 'cta' })[type] || 'generic';
}

// The active publication's saved section template. Falls back to the per-publication
// localStorage settings cache so a new newsletter uses it even if state was reset.
function getSectionLayout() {
  const dp = state.defaultPrompts || {};
  if (dp._layout?.order?.length) return dp._layout;
  try {
    const raw = localStorage.getItem(settingsLSKey());
    const c = raw ? JSON.parse(raw) : null;
    if (c?.defaultPrompts?._layout?.order?.length) return c.defaultPrompts._layout;
  } catch (e) {}
  return null;
}

function resetNewsletter() {
  const dp = state.defaultPrompts || {};
  state.newsletterId = null;
  const layout = getSectionLayout();

  if (layout && Array.isArray(layout.order) && layout.order.length) {
    // Start new newsletters from the user's saved section layout (per publication)
    const sections = {};
    const prompts = {};
    const meta = {};
    for (const id of layout.order) {
      const m = layout.meta?.[id] || { name: id, type: 'generic' };
      meta[id] = { name: m.name || id, type: m.type || 'generic' };
      sections[id] = [];
      // Prefer the live-edited prompt (dp[id], what the Settings textarea writes),
      // then the layout snapshot, then the type default.
      prompts[id] = dp[id] || layout.prompts?.[id] || dp[typeDefaultKey(meta[id].type)] || '';
    }
    state.newsletter = {
      title: 'Untitled Newsletter', subject: '', previewText: '', subjectLines: [],
      sections, topStoriesContent: '', prompts,
      sectionOrder: [...layout.order],
      sectionMeta: meta,
    };
  } else {
    // Default layout — map default prompts by section type onto the built-in section IDs
    state.newsletter = {
      title: 'Untitled Newsletter',
      subject: '',
      previewText: '',
      subjectLines: [],
      sections: { topStories: [], leadStory: [], quickHits: [], cta: [] },
      topStoriesContent: '',
      prompts: {
        topStories: dp.briefing || '',
        leadStory:  dp.lead     || '',
        quickHits:  dp.hits     || '',
        cta:        dp.cta      || '',
      },
      sectionOrder: ['topStories', 'leadStory', 'quickHits', 'cta'],
      sectionMeta: {
        topStories: { name: "Today's Briefing", type: 'briefing' },
        leadStory:  { name: 'Lead Story',       type: 'lead' },
        quickHits:  { name: 'Quick Hits',       type: 'hits' },
        cta:        { name: 'Sponsor / CTA',    type: 'cta' },
      },
    };
  }
  state.approvalStatus = 'draft';
  state.teamComments = [];
  state.versions = [{ num: 'v1', desc: 'Initial draft', time: 'just now' }];
}

// Capture the current newsletter's section layout + prompts as the per-publication
// default so every new newsletter starts with these sections.
function saveSectionLayoutAsDefault() {
  if (!state.defaultPrompts) state.defaultPrompts = {};
  state.defaultPrompts._layout = {
    order: [...state.newsletter.sectionOrder],
    meta: JSON.parse(JSON.stringify(state.newsletter.sectionMeta || {})),
    prompts: { ...state.newsletter.prompts },
  };
  // Keep the Settings → Section Defaults list in sync so both views agree
  state.defaultPrompts._sections = state.newsletter.sectionOrder.map(id => ({
    id, name: state.newsletter.sectionMeta[id]?.name || id,
  }));
  scheduleSettingsSave();
  toast('Saved — new newsletters will start with these sections & prompts', 'success');
}

function clearSectionLayoutDefault() {
  if (!state.defaultPrompts) return;
  delete state.defaultPrompts._layout;
  scheduleSettingsSave();
  toast('Reset — new newsletters will use the standard layout', 'info');
  render();
}

async function saveSourceToDB(source) {
  if (!sb || !state.user) return;
  const pubId = state.currentPublicationId || null;
  const base = { user_id: state.user.id, feed_url: source.feedUrl, title: source.title, type: source.type };

  // Look for an existing row scoped to THIS publication (NULL = Default).
  // Using select-then-insert/update avoids depending on a composite unique
  // constraint existing in the DB — only the publication_id column is required.
  let findQ = sb.from('sources').select('id')
    .eq('user_id', state.user.id).eq('feed_url', source.feedUrl);
  findQ = pubId ? findQ.eq('publication_id', pubId) : findQ.is('publication_id', null);
  const { data: existing, error: findErr } = await findQ.maybeSingle();

  if (findErr) {
    // publication_id column likely doesn't exist yet — degrade to unscoped upsert.
    const { data: fallback, error: fallbackErr } = await sb.from('sources').upsert(
      base, { onConflict: 'user_id,feed_url' }
    ).select('id').single();
    if (fallbackErr) { console.error('Source save error:', fallbackErr); return; }
    if (fallback?.id) source.id = fallback.id;
    return;
  }

  if (existing?.id) {
    // Same feed already in this publication — update metadata, keep the row.
    source.id = existing.id;
    await sb.from('sources').update({ title: source.title, type: source.type }).eq('id', existing.id);
    return;
  }

  // New source for this publication.
  const { data: inserted, error: insErr } = await sb.from('sources')
    .insert({ ...base, publication_id: pubId }).select('id').single();
  if (insErr) { console.error('Source save error:', insErr); return; }
  if (inserted?.id) source.id = inserted.id;
}

async function deleteSourceFromDB(sourceId) {
  if (!sb || !state.user) return;
  // When the DB can't scope by publication, the same feed_url is one shared row
  // across publications — deleting it would remove it everywhere. In that mode we
  // only drop local membership (handled by the caller via saveSourcesLocally) and
  // leave the row intact so other publications keep it.
  if (state.sourcesPubScoped === false) return;
  const { error } = await sb.from('sources').delete().eq('id', sourceId).eq('user_id', state.user.id);
  if (error) console.error('Source delete error:', error);
}

// Detect once whether the sources table has the publication_id column.
async function ensureSourcesCapability() {
  if (state.sourcesPubScoped !== null) return state.sourcesPubScoped;
  if (!sb || !state.user) { state.sourcesPubScoped = false; return false; }
  const { error } = await sb.from('sources')
    .select('id').eq('user_id', state.user.id).is('publication_id', null).limit(1);
  state.sourcesPubScoped = !error; // error => column missing
  return state.sourcesPubScoped;
}

function mapSourceRows(rows) {
  return (rows || []).map(s => ({
    id: s.id, feedUrl: s.feed_url, title: s.title || s.feed_url,
    type: s.type || 'feed', articles: [], collapsed: false,
  }));
}

async function loadSourcesFromDB() {
  if (!sb || !state.user) return [];
  const pubId = state.currentPublicationId || null;
  const scoped = await ensureSourcesCapability();

  if (scoped) {
    // Proper DB-level isolation by publication_id.
    let query = sb.from('sources').select('*').eq('user_id', state.user.id).order('created_at');
    query = pubId ? query.eq('publication_id', pubId) : query.is('publication_id', null);
    const { data, error } = await query;
    if (error) { console.error('Load sources error:', error); return []; }
    const rows = mapSourceRows(data);
    saveSourcesListLocally(rows); // keep the per-publication local cache in sync
    return rows;
  }

  // Fallback (no publication_id column): isolate per publication using the
  // publication-keyed localStorage membership list so sources never bleed.
  const { data, error } = await sb.from('sources').select('*').eq('user_id', state.user.id).order('created_at');
  if (error) { console.error('Load sources error:', error); return []; }
  const allRows = mapSourceRows(data);
  const local = loadSourcesLocally();

  if (!local.length && !pubId) {
    // First run on Default before any buckets exist — adopt all pre-existing
    // sources so nothing is lost; they become Default's set.
    saveSourcesListLocally(allRows);
    return allRows;
  }

  const allowed = new Set(local.map(s => s.feedUrl));
  return allRows.filter(r => allowed.has(r.feedUrl));
}

function autoFetchSources() {
  const unfetched = state.sources.filter(s => s.articles.length === 0);
  if (!unfetched.length) return;
  unfetched.forEach(source => {
    fetch(`/api/ingest?url=${encodeURIComponent(source.feedUrl)}&quick=1`)
      .then(r => r.json())
      .then(data => {
        if (data.articles?.length) {
          source.articles = data.articles;
          if (data.title) source.title = data.title;
          refreshSourceSidebar();
        }
      })
      .catch(() => {});
  });
}

// ── BEEHIIV PASTE MODAL ───────────────────────────────────────────────────────
function sectionPlainText(articles) {
  return articles
    .map(a => (a.content || a.summary || '').trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function showBeehiivPasteModal() {
  const nl = state.newsletter;
  const sectionOrder = nl.sectionOrder || ['topStories', 'leadStory', 'quickHits', 'cta'];
  const sectionMeta  = nl.sectionMeta  || {};

  const hasTopStories = nl.topStoriesContent?.trim();
  const sections = [];

  if (hasTopStories) {
    sections.push({ id: 'topStories', name: sectionMeta.topStories?.name || "Today's Briefing", text: nl.topStoriesContent.trim() });
  }

  for (const id of sectionOrder) {
    if (id === 'topStories') continue;
    const articles = nl.sections?.[id] ?? [];
    if (!articles.length) continue;
    const text = sectionPlainText(articles);
    if (!text) continue;
    sections.push({ id, name: sectionMeta[id]?.name || id, text });
  }

  if (!sections.length) {
    toast('Add some content to your newsletter first', 'warn');
    return;
  }

  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal" style="max-width:640px;padding:0;overflow:hidden">
      <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border-md);display:flex;align-items:center;justify-content:space-between">
        <div>
          <div class="modal-title" style="margin:0">Copy for Beehiiv</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">Copy each section and paste directly into Beehiiv's editor</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="close-modal" style="font-size:20px;padding:2px 8px">×</button>
      </div>
      <div style="padding:16px 24px;display:flex;flex-direction:column;gap:12px;max-height:70vh;overflow-y:auto">
        ${sections.map(s => `
        <div style="border:1px solid var(--border-md);border-radius:var(--r-md);overflow:hidden">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg-3);border-bottom:1px solid var(--border-md)">
            <span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-2)">${escHtml(s.name)}</span>
            <button class="btn btn-outline btn-sm" data-action="copy-beehiiv-section" data-section="${escHtml(s.id)}" style="font-size:11px;padding:4px 10px">⎘ Copy</button>
          </div>
          <textarea id="beehiiv-text-${escHtml(s.id)}" readonly
            style="width:100%;box-sizing:border-box;resize:none;border:none;background:var(--bg-2);color:var(--text-1);font-size:13px;line-height:1.7;padding:12px 14px;font-family:inherit;min-height:80px;outline:none"
            rows="4"
          >${escHtml(s.text)}</textarea>
        </div>`).join('')}
      </div>
    </div>
  </div>`;
  modal.querySelector('#modal-overlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
}

function copyBeehiivSection(sectionId) {
  const el = document.getElementById(`beehiiv-text-${sectionId}`);
  if (!el) return;
  navigator.clipboard.writeText(el.value)
    .then(() => {
      toast('Copied — paste into Beehiiv', 'success');
      // Flash the button
      const btn = document.querySelector(`[data-action="copy-beehiiv-section"][data-section="${sectionId}"]`);
      if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.innerHTML = '⎘ Copy'; }, 1800); }
    })
    .catch(() => toast('Copy failed', 'error'));
}

// ── BEEHIIV PUBLISH ───────────────────────────────────────────────────────────
async function publishToBeehiiv() {
  // Save current state first so we always publish the latest version
  if (sb && state.user) await saveNewsletter();

  if (!state.hasBeehiiv) {
    toast('Beehiiv not configured — add BEEHIIV_API_KEY and BEEHIIV_PUBLICATION_ID to your .env file', 'warn');
    return;
  }

  const hasContent = state.newsletter.sections.leadStory.length > 0 ||
                     state.newsletter.sections.quickHits.length > 0 ||
                     state.newsletter.sections.cta.length > 0;
  if (!hasContent) { toast('Add some content to your newsletter before publishing', 'warn'); return; }

  toast('Creating Beehiiv draft…', 'info');

  try {
    const res = await fetch('/api/publish/beehiiv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newsletter: state.newsletter }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Beehiiv publish failed');

    const url = data.webUrl || data.previewUrl;
    const msg = url
      ? `Draft created on Beehiiv — <a href="${url}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">Open in Beehiiv →</a>`
      : '✓ Draft created on Beehiiv';
    toastHTML(msg, 'success');
  } catch (e) {
    toast(`Beehiiv error: ${e.message}`, 'error');
  }
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { success: '✓', error: '✕', warn: '⚠', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${escHtml(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 3500);
}

function toastHTML(html, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { success: '✓', error: '✕', warn: '⚠', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${html}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 6000);
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function escHtml(str = '') {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 2)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)   return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5)   return `${w}w ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function adjustColor(hex, amount) {
  const num = parseInt(hex.replace('#',''), 16);
  const r = Math.max(0, Math.min(255, (num >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + amount));
  const b = Math.max(0, Math.min(255, (num & 0xff) + amount));
  return `#${(r << 16 | g << 8 | b).toString(16).padStart(6,'0')}`;
}

// ── START ─────────────────────────────────────────────────────────────────────
init();
