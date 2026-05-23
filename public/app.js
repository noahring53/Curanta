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
  teamComments: [],
  approvalStatus: 'draft', // 'draft' | 'review' | 'approved'
  versions: [],
  draggedArticleId: null,
  draggedStory: null,
  hasAI: false,
  hasStripe: false,
  subscriptionStatus: 'inactive', // 'inactive' | 'trialing' | 'active'
  grandfathered: false,
  generationsThisMonth: 0,
  trialEndsAt: null,
  voiceUrls: [],
  voiceUrlLoading: false,
  _expandedPrompts: {},     // transient: which section prompt boxes are open
  // Persistence
  newsletterId: null,       // UUID of the current newsletter in Supabase
  saving: false,
  dbNewsletters: [],        // loaded from Supabase for the dashboard
};

const mockNewsletters = [
  { id: 'n1', title: 'Weekly Tech Digest #47', status: 'sent', sentAt: new Date(Date.now()-2*864e5).toISOString(), openRate: 24.3, clickRate: 4.1, subscribers: 8420, subject: "Apple's AI gamble, the chip race heats up, and why your inbox is about to change" },
  { id: 'n2', title: 'AI Industry Brief — Week 23', status: 'scheduled', scheduledFor: new Date(Date.now()+864e5).toISOString(), openRate: null, subject: "OpenAI's new model, Anthropic raises again, and the regulation question" },
  { id: 'n3', title: 'The Policy Pulse: May Edition', status: 'draft', updatedAt: new Date(Date.now()-3600e3).toISOString(), subject: '' },
  { id: 'n4', title: 'Morning Briefing — May 12', status: 'sent', sentAt: new Date(Date.now()-7*864e5).toISOString(), openRate: 31.2, clickRate: 6.8, subscribers: 8312, subject: '3 things you need to know this morning' },
];

// ── CONFIG & AUTH ─────────────────────────────────────────────────────────────
let cfg = { supabaseUrl: '', supabaseAnonKey: '', hasAI: false };
let sb = null;

// ── LOCAL STORAGE HELPERS ─────────────────────────────────────────────────────
const LS_SOURCES_KEY = 'lwai_sources';

function saveSourcesLocally() {
  try {
    const slim = state.sources.map(s => ({ feedUrl: s.feedUrl, title: s.title, type: s.type }));
    localStorage.setItem(LS_SOURCES_KEY, JSON.stringify(slim));
  } catch (e) { /* storage full or unavailable */ }
}

function loadSourcesLocally() {
  try {
    const raw = localStorage.getItem(LS_SOURCES_KEY);
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
  } catch(e) {}

  try {
    const res = await fetch('/api/config');
    cfg = await res.json();
    state.hasAI = cfg.hasAI;
    state.hasStripe = cfg.hasStripe;
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
          navigate('dashboard');
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
          fetch(`/api/ingest?url=${encodeURIComponent(src.feedUrl)}`)
            .then(r => r.json())
            .then(data => { src.articles = data.articles || []; refreshSourceSidebar(); })
            .catch(() => {});
        });
      }
    }
  } catch (e) { console.warn('Init error:', e); }
  render();

  // Handle Stripe redirect params
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('checkout') === 'success') {
    history.replaceState(null, '', window.location.pathname);
    setTimeout(() => {
      toast('🎉 Trial started — 7 days free, cancel anytime from Subscription.', 'success');
      // Refresh subscription status
      if (sb && state.user) loadUserSettings().then(() => render());
    }, 500);
  } else if (urlParams.get('checkout') === 'cancelled') {
    history.replaceState(null, '', window.location.pathname);
    toast('Checkout cancelled — you can subscribe anytime from Settings.', 'info');
  }
}

// ── ROUTER ────────────────────────────────────────────────────────────────────
async function navigate(view, params = {}) {
  state.view = view;

  if (view === 'dashboard' && sb && state.user) {
    state.dbNewsletters = await loadNewslettersFromDB();
  }
  if (view === 'sources' && sb && state.user && state.sources.length === 0) {
    state.sources = await loadSourcesFromDB();
    autoFetchSources();
  }

  if (view === 'builder') {
    if (params.id && params.id !== state.newsletterId) {
      await loadBuilderData(params.id);
    } else if (!params.id) {
      resetNewsletter();
      if (sb && state.user) state.sources = await loadSourcesFromDB();
    }
    autoFetchSources();
  }

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
    case 'open-builder':    navigate('builder'); break;
    case 'open-newsletter': navigate('builder', { id: d.id }); break;
    case 'show-auth':       showAuthModal(d.tab || 'login'); break;
    case 'close-modal':     closeModal(); break;
    case 'auth-tab':        switchAuthTab(d.tab); break;
    case 'logout':          handleLogout(); break;
    case 'toggle-feed':     toggleFeed(d.feedId); break;
    case 'remove-feed':     removeFeed(d.feedId); break;
    case 'remove-article':  removeArticle(d.feedId, d.articleId); break;
    case 'add-to-section':  addToSection(d.articleId, d.section || 'leadStory'); break;
    case 'remove-from-section': removeFromSection(d.articleId, d.section); break;
    case 'apply-prompt':      applyPrompt(d.section); break;
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
    case 'mock-sync':       d.platform === 'beehiiv' ? publishToBeehiiv() : mockSync(d.platform); break;
    case 'request-review':  setApproval('review'); break;
    case 'approve':         setApproval('approved'); break;
    case 'add-comment':     addComment(); break;
    case 'toggle-voice-panel': toggleVoicePanel(); break;
    case 'remove-voice-url':  removeVoiceURL(parseInt(d.idx)); break;
    case 'clear-brand-voice': state.brandVoice = ''; state.brandVoiceSamples = ''; state.voiceUrls = []; scheduleSettingsSave(); render(); break;
    case 'show-add-section':  showAddSectionModal(); break;
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
  if (form.id === 'auth-form') { e.preventDefault(); submitAuth(form); }
  else if (form.id === 'magic-link-form') { e.preventDefault(); submitMagicLink(form); }
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

// ── LANDING PAGE ──────────────────────────────────────────────────────────────
function renderLanding() {
  return `
<div class="landing-page">
  <nav class="landing-nav">
    <div class="nav-logo">
      <div class="nav-logo-icon">L</div>
      Curanta
    </div>
    <div class="nav-links">
      <a class="nav-link" href="#features">Features</a>
      <a class="nav-link" href="#how">How it works</a>
      <a class="nav-link" href="#pricing">Pricing</a>
      <a class="nav-link" href="#integrations">Integrations</a>
    </div>
    <div class="nav-actions">
      <button class="btn btn-ghost" data-action="show-auth" data-tab="login">Log in</button>
      <button class="btn btn-primary" data-action="show-auth" data-tab="signup">Start free →</button>
    </div>
  </nav>

  <section class="hero">
    <div class="hero-eyebrow">✦ AI-Powered Newsletter Production</div>
    <h1>Create publish-ready newsletters<br>in <span>minutes</span>, not hours.</h1>
    <p class="hero-sub">Feed any RSS feed or article URL. AI writes it in your voice. You hit publish.</p>
    <div class="hero-actions">
      <button class="btn btn-primary" data-action="show-auth" data-tab="signup">Start free → <span style="opacity:0.7;font-size:12px;margin-left:2px"></span></button>
      <button class="btn btn-outline" onclick="document.getElementById('how').scrollIntoView({behavior:'smooth'})">Watch how it works</button>
    </div>
    <p class="hero-note">No credit card required · Free plan includes 3 newsletters/month</p>

    <div class="hero-visual-wrap">
      <div class="demo-browser">
        <div class="demo-chrome">
          <div class="demo-dots"><span></span><span></span><span></span></div>
          <div class="demo-url-bar">letterwriterai.app/builder</div>
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
    <div class="social-item"><strong>10,000+</strong> newsletters created</div>
    <div class="social-item"><strong>500+</strong> publishers & media brands</div>
    <div class="social-item"><strong>15 min</strong> avg. time to publish</div>
    <div class="social-item"><strong>28%</strong> avg. open rate</div>
  </div>

  <section class="features-section" id="features">
    <div class="section-eyebrow">Features</div>
    <h2 class="section-title">Everything a modern<br>newsletter team needs</h2>
    <p class="section-sub">Built for publishers, media brands, political newsletters, agencies, and solo creators who take their content seriously.</p>
    <div class="features-grid">
      <div class="feature-card">
        <div class="feature-icon">📡</div>
        <div class="feature-title">RSS & URL Ingestion</div>
        <div class="feature-desc">Paste any RSS feed or article URL. We fetch, parse, and clean the content instantly — stripping ads, nav, and noise.</div>
      </div>
      <div class="feature-card">
        <div class="feature-icon">✍️</div>
        <div class="feature-title">AI-Powered Writing</div>
        <div class="feature-desc">From raw article to punchy newsletter prose in seconds. Lead stories, quick hits, CTAs, and subject lines — all AI-generated.</div>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🎙️</div>
        <div class="feature-title">Brand Voice System</div>
        <div class="feature-desc">Paste 3–10 past newsletters. We generate a reusable voice profile so every story sounds unmistakably like you.</div>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🎛️</div>
        <div class="feature-title">Drag-and-Drop Builder</div>
        <div class="feature-desc">Drag article cards into sections: Lead Story, Quick Hits, or Sponsor CTA. Each section has its own editable AI prompt.</div>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🎨</div>
        <div class="feature-title">Design Customization</div>
        <div class="feature-desc">Dark/light mode, brand colors, spacing, border radius. Live desktop and mobile preview before you hit publish.</div>
      </div>
      <div class="feature-card">
        <div class="feature-icon">👥</div>
        <div class="feature-title">Team Review</div>
        <div class="feature-desc">Comments, approval flows, and version history built in. Request review, approve, and publish — all in one place.</div>
      </div>
    </div>
  </section>

  <section class="how-section" id="how">
    <div class="how-inner">
      <div class="section-eyebrow">How it works</div>
      <h2 class="section-title">From feeds to publish-ready<br>in three steps</h2>
      <div class="how-steps">
        <div class="how-step">
          <div class="how-number">1</div>
          <h3>Paste your sources</h3>
          <p>Add RSS feeds or individual article URLs. We fetch the full text and clean out all the junk — ads, nav, share buttons, audio widgets.</p>
        </div>
        <div class="how-step">
          <div class="how-number">2</div>
          <h3>Drag, drop, generate</h3>
          <p>Drag article cards into your newsletter sections. Hit "Apply" and AI writes the full story in your chosen tone and brand voice.</p>
        </div>
        <div class="how-step">
          <div class="how-number">3</div>
          <h3>Export & publish</h3>
          <p>Copy the HTML, export JSON, or sync directly to Beehiiv, Mailchimp, or Kit. Your newsletter goes out exactly as designed.</p>
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
    <h2 class="section-title">Simple, transparent pricing</h2>
    <p class="section-sub" style="margin:0 auto 0">Start free. Scale when you're ready.</p>
    <div class="pricing-grid">
      <div class="pricing-card">
        <div>
          <div class="pricing-tier">Starter</div>
          <div class="pricing-price"><span class="amount">$0</span><span class="period">/mo</span></div>
          <div class="pricing-desc">Perfect for solo creators and early-stage newsletters.</div>
        </div>
        <div class="pricing-features">
          <div class="pricing-feature">3 newsletters per month</div>
          <div class="pricing-feature">50 AI generations</div>
          <div class="pricing-feature">2 RSS feed sources</div>
          <div class="pricing-feature">Copy HTML export</div>
          <div class="pricing-feature dim">Brand voice system</div>
          <div class="pricing-feature dim">Team collaboration</div>
        </div>
        <button class="btn btn-outline" style="width:100%" data-action="show-auth" data-tab="signup">Get started free</button>
      </div>
      <div class="pricing-card featured">
        <div>
          <div class="pricing-tier">Pro</div>
          <div class="pricing-price"><span class="amount">$49</span><span class="period">/mo</span></div>
          <div class="pricing-desc">For serious publishers, media brands, and growing newsletters.</div>
        </div>
        <div class="pricing-features">
          <div class="pricing-feature">Unlimited newsletters</div>
          <div class="pricing-feature">Unlimited AI generations</div>
          <div class="pricing-feature">Unlimited RSS sources</div>
          <div class="pricing-feature">Brand voice system</div>
          <div class="pricing-feature">Team collaboration & approvals</div>
          <div class="pricing-feature">Beehiiv, Mailchimp, Kit sync</div>
          <div class="pricing-feature">Priority support</div>
        </div>
        <button class="btn btn-primary" style="width:100%" data-action="show-auth" data-tab="signup">Start Pro trial →</button>
      </div>
      <div class="pricing-card">
        <div>
          <div class="pricing-tier">Enterprise</div>
          <div class="pricing-price"><span class="amount" style="font-size:30px">Custom</span></div>
          <div class="pricing-desc">For agencies, media companies, and political operations.</div>
        </div>
        <div class="pricing-features">
          <div class="pricing-feature">Everything in Pro</div>
          <div class="pricing-feature">White-label interface</div>
          <div class="pricing-feature">API access</div>
          <div class="pricing-feature">Dedicated support + SLA</div>
          <div class="pricing-feature">Custom integrations</div>
          <div class="pricing-feature">Multi-brand management</div>
        </div>
        <button class="btn btn-outline" style="width:100%">Book a demo</button>
      </div>
    </div>
  </section>

  <section class="cta-section">
    <h2>Ready to publish faster?</h2>
    <p>Join 10,000+ newsletter creators who ship in minutes, not hours.</p>
    <div class="hero-actions">
      <button class="btn btn-primary" data-action="show-auth" data-tab="signup">Start free — no card required →</button>
      <button class="btn btn-outline">Book a demo</button>
    </div>
  </section>

  <footer class="landing-footer">
    <div class="nav-logo">
      <div class="nav-logo-icon">L</div>
      Curanta
    </div>
    <div class="footer-links">
      <a href="#">Privacy</a>
      <a href="#">Terms</a>
      <a href="#">Status</a>
      <a href="#">Docs</a>
    </div>
    <div style="color:var(--text-3);font-size:12px">© 2025 Curanta. All rights reserved.</div>
  </footer>
</div>`;
}

// ── AUTH MODAL ────────────────────────────────────────────────────────────────
function showAuthModal(tab = 'login') {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  modal.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <div class="modal-header">
        <div>
          <div class="modal-title">Welcome to Curanta</div>
          <div class="modal-sub">Sign in to access the newsletter builder</div>
        </div>
        <button class="btn-icon" data-action="close-modal" style="font-size:18px;line-height:1">×</button>
      </div>
      ${!configured ? `<div class="modal-body"><div class="auth-error">⚠️ Supabase is not configured. Add SUPABASE_URL and SUPABASE_ANON_KEY to your .env file. For demo purposes, <button style="color:var(--accent);text-decoration:underline;background:none;border:none;cursor:pointer;font-size:inherit;" onclick="state.user={email:'demo@example.com',id:'demo'};closeModal();navigate('dashboard')">continue as demo user</button>.</div></div>` : `
      <div class="auth-tabs">
        <div class="auth-tab ${tab === 'login' ? 'active' : ''}" data-action="auth-tab" data-tab="login">Sign in</div>
        <div class="auth-tab ${tab === 'signup' ? 'active' : ''}" data-action="auth-tab" data-tab="signup">Create account</div>
      </div>
      <div class="modal-body">
        <div id="auth-panel-login" style="display:${tab === 'login' ? 'block' : 'none'}">
          <form id="auth-form" data-mode="login" class="auth-form">
            <div id="auth-login-error" class="auth-error hidden"></div>
            <div class="form-group">
              <label class="form-label" for="login-email">Email</label>
              <input id="login-email" name="email" type="email" class="input" placeholder="you@example.com" required autocomplete="email">
            </div>
            <div class="form-group">
              <label class="form-label" for="login-password">Password</label>
              <input id="login-password" name="password" type="password" class="input" placeholder="••••••••" required autocomplete="current-password">
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">Sign in →</button>
          </form>
          <div style="margin:14px 0">
            <div class="auth-divider">or</div>
          </div>
          <form id="magic-link-form" class="auth-form">
            <input id="magic-email" name="email" type="email" class="input" placeholder="Email for magic link" required>
            <button type="submit" class="btn btn-outline" style="width:100%;justify-content:center">✉️ Send magic link</button>
          </form>
        </div>
        <div id="auth-panel-signup" style="display:${tab === 'signup' ? 'block' : 'none'}">
          <form id="auth-form" data-mode="signup" class="auth-form">
            <div id="auth-signup-error" class="auth-error hidden"></div>
            <div class="form-group">
              <label class="form-label" for="signup-email">Email</label>
              <input id="signup-email" name="email" type="email" class="input" placeholder="you@example.com" required autocomplete="email">
            </div>
            <div class="form-group">
              <label class="form-label" for="signup-password">Password</label>
              <input id="signup-password" name="password" type="password" class="input" placeholder="Min. 8 characters" required minlength="8" autocomplete="new-password">
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">Create account →</button>
            <p class="auth-note">By signing up you agree to our Terms of Service and Privacy Policy.</p>
          </form>
        </div>
      </div>`}
    </div>
  </div>`;
  modal.querySelector('#modal-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
}

function closeModal() {
  const m = document.getElementById('modal-root');
  if (m) m.innerHTML = '';
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('auth-panel-login').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('auth-panel-signup').style.display = tab === 'signup' ? 'block' : 'none';
}

async function submitAuth(form) {
  const mode = form.dataset.mode;
  const emailEl = form.querySelector('[name="email"]');
  const passEl = form.querySelector('[name="password"]');
  const errEl = form.querySelector('.auth-error');
  if (!sb) return;
  const email = emailEl.value.trim();
  const password = passEl?.value;
  try {
    let result;
    if (mode === 'signup') result = await sb.auth.signUp({ email, password });
    else result = await sb.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    if (mode === 'signup' && result.data?.user && !result.data?.session) {
      if (errEl) { errEl.classList.remove('hidden'); errEl.textContent = '✓ Check your email to confirm your account.'; errEl.style.color = 'var(--green)'; }
    } else {
      closeModal();
      toast('Signed in successfully', 'success');
    }
  } catch (e) {
    if (errEl) { errEl.classList.remove('hidden'); errEl.textContent = e.message; }
  }
}

async function submitMagicLink(form) {
  const email = form.querySelector('[name="email"]').value.trim();
  if (!sb || !email) return;
  try {
    const { error } = await sb.auth.signInWithOtp({ email });
    if (error) throw error;
    toast('Magic link sent! Check your inbox.', 'success');
  } catch (e) { toast(e.message, 'error'); }
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
    <div class="app-topbar">
      <div class="page-title">Dashboard</div>
      <div class="flex items-center gap-2">
        <button class="btn btn-primary" data-action="open-builder">+ New Newsletter</button>
      </div>
    </div>
    <div class="dashboard-content">
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">Newsletters</div>
          <div class="stat-value">${state.dbNewsletters.length || 0}</div>
          <div class="stat-change">total created</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Drafts</div>
          <div class="stat-value">${state.dbNewsletters.filter(n => n.status === 'draft').length || 0}</div>
          <div class="stat-change">in progress</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Sources</div>
          <div class="stat-value">${state.sources.length || 0}</div>
          <div class="stat-change">RSS feeds connected</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">AI</div>
          <div class="stat-value">${state.hasAI ? '✓' : '—'}</div>
          <div class="stat-change">${state.hasAI ? 'Connected' : 'Not configured'}</div>
        </div>
      </div>

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
          ${(state.dbNewsletters.length ? state.dbNewsletters : mockNewsletters).map(nl => `
          <div class="newsletter-card" data-action="open-newsletter" data-id="${nl.id}">
            <div>
              <div class="newsletter-card-title">${nl.title}</div>
              ${nl.subject ? `<div class="newsletter-card-subject">${nl.subject}</div>` : ''}
            </div>
            <div class="newsletter-card-meta">
              <span class="badge ${nl.status === 'sent' ? 'badge-green' : nl.status === 'scheduled' ? 'badge-blue' : 'badge-default'}">
                <span class="dot ${nl.status === 'sent' ? 'dot-green' : nl.status === 'scheduled' ? 'dot-blue' : 'dot-dim'}"></span>
                ${nl.status}
              </span>
              <div class="newsletter-card-stats">
                ${nl.openRate ? `<div class="newsletter-stat"><strong>${nl.openRate}%</strong> open</div>` : ''}
                ${nl.clickRate ? `<div class="newsletter-stat"><strong>${nl.clickRate}%</strong> click</div>` : ''}
                ${nl.scheduledFor ? `<div class="newsletter-stat">Sends ${new Date(nl.scheduledFor).toLocaleDateString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>` : ''}
                <button class="btn-ghost btn-sm" style="font-size:11px;padding:2px 6px;margin-left:4px" data-action="duplicate-newsletter" data-id="${nl.id}" title="Duplicate">⊕</button>
                <button class="btn-ghost btn-sm" style="font-size:11px;padding:2px 6px;color:var(--red)" data-action="delete-newsletter" data-id="${nl.id}" title="Delete">🗑</button>
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
    <div class="app-topbar">
      <div>
        <div class="page-title">Sources</div>
        <div class="page-sub">RSS feeds and URLs you pull articles from. Shared across all newsletters.</div>
      </div>
    </div>
    <div class="page-body">
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
            ['Politico', 'https://www.politico.com/rss/politics08.xml'],
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
    <div class="app-topbar">
      <div>
        <div class="page-title">Subscription</div>
        <div class="page-sub">Manage your plan and billing.</div>
      </div>
    </div>
    <div class="page-body" style="max-width:560px">

      ${isSubscribed() ? `
      <div class="settings-section">
        <div style="padding:24px;background:var(--green-soft);border:1px solid var(--green);border-radius:var(--r-lg)">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:${state.grandfathered ? '0' : '20px'}">
            <div style="font-size:28px">✦</div>
            <div>
              <div style="font-size:16px;font-weight:700;color:var(--green)">
                ${state.grandfathered ? 'Grandfathered — Full Access' : state.subscriptionStatus === 'trialing' ? `Free Trial — ${trialDaysLeft()} day${trialDaysLeft() === 1 ? '' : 's'} left` : 'Curanta Pro — Active'}
              </div>
              <div style="font-size:12px;color:var(--text-2);margin-top:2px">
                ${state.grandfathered ? 'Your account has permanent full access.' : state.subscriptionStatus === 'trialing' ? 'Your card will be charged when the trial ends. Cancel anytime before then.' : 'Your subscription is active.'}
              </div>
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
          <button class="btn btn-outline" onclick="manageBilling()">${state.subscriptionStatus === 'trialing' ? 'Cancel trial →' : 'Manage billing →'}</button>
          ` : ''}
        </div>
      </div>
      ` : `
      <div class="settings-section">
        <div style="padding:32px;border:1px dashed var(--border-md);border-radius:var(--r-lg);text-align:center">
          <div style="font-size:36px;margin-bottom:12px">✦</div>
          <div style="font-size:18px;font-weight:700;margin-bottom:8px">Get Curanta Pro</div>
          <div style="font-size:13px;color:var(--text-2);line-height:1.7;margin-bottom:24px;max-width:360px;margin-left:auto;margin-right:auto">
            Everything you need to produce a polished newsletter, fast.
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;text-align:left;max-width:300px;margin:0 auto 28px">
            <div style="display:flex;align-items:center;gap:10px;font-size:13px"><span style="color:var(--green);font-size:15px">✓</span> Lead stories, quick hits & briefings</div>
            <div style="display:flex;align-items:center;gap:10px;font-size:13px"><span style="color:var(--green);font-size:15px">✓</span> Brand voice generation & matching</div>
            <div style="display:flex;align-items:center;gap:10px;font-size:13px"><span style="color:var(--green);font-size:15px">✓</span> Subject lines, rewrites & CTAs</div>
            <div style="display:flex;align-items:center;gap:10px;font-size:13px"><span style="color:var(--green);font-size:15px">✓</span> 500 AI generations per month</div>
          </div>
          <button class="btn btn-primary" style="font-size:15px;padding:12px 32px" onclick="subscribe()">Start 7-day free trial →</button>
        </div>
      </div>
      `}

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
  const sectionTypes = [
    { key: 'briefing', label: "Today's Briefing", desc: 'The opening section — a quick stat-first bulleted rundown of top stories with source links.', placeholder: 'e.g. Lead each bullet with the sharpest number from the article. Keep each line under 100 chars. End with the source URL.' },
    { key: 'lead',     label: 'Lead Story',       desc: 'The main story — a full write-up with context, analysis, and your take.', placeholder: 'e.g. Open with the key insight, not the headline. Include a "Why it matters" paragraph. Keep to 150-200 words.' },
    { key: 'hits',     label: 'Quick Hits',       desc: 'Short 1-2 sentence summaries of secondary stories.', placeholder: 'e.g. One bold sentence with the key fact, then one sentence of context. End with a link.' },
    { key: 'cta',      label: 'Sponsor / CTA',    desc: 'Call-to-action or sponsor message.', placeholder: 'e.g. Write a 2-sentence sponsor read that feels native, not salesy. Include a clear action.' },
    { key: 'generic',  label: 'Custom Sections',  desc: 'Default prompt for any custom sections you create.', placeholder: 'e.g. Write in a punchy, informative style. Lead with the most surprising fact.' },
  ];

  return `
<div class="app-shell">
  ${renderAppNav('settings')}
  <div class="app-main">
    <div class="app-topbar">
      <div>
        <div class="page-title">Settings</div>
        <div class="page-sub">Global defaults applied to every newsletter you create.</div>
      </div>
    </div>

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
        <div class="settings-section-sub">Paste your newsletter's homepage — Curanta reads your past issues and builds a voice profile you can edit.</div>
        <div style="margin-top:16px;display:flex;gap:8px">
          <input id="voice-pub-url" class="input" type="url"
            placeholder="https://yourname.substack.com  or  https://yourpub.beehiiv.com"
            style="flex:1" ${state.voiceUrlLoading ? 'disabled' : ''}>
          <button class="btn btn-primary" onclick="discoverVoice()" ${state.voiceUrlLoading ? 'disabled' : ''}>
            ${state.voiceUrlLoading ? '<span class="spinner"></span> Analyzing…' : '🎙 Analyze'}
          </button>
        </div>
        <div style="margin-top:5px;font-size:11px;color:var(--text-3)">Works with Substack, Beehiiv, Ghost, WordPress — reads up to 12 past issues.</div>

        ${state.voiceUrls?.length ? `
        <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px">
          ${state.voiceUrls.map((u, i) => `
          <div style="display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:3px 9px;background:var(--green-soft);border:1px solid var(--green);border-radius:99px;color:var(--green)">
            ✓ ${escHtml(new URL(u).hostname)}
            <button style="background:none;border:none;cursor:pointer;color:var(--green);font-size:13px;line-height:1;padding:0;opacity:0.7" data-action="remove-voice-url" data-idx="${i}">×</button>
          </div>`).join('')}
        </div>` : ''}

        ${state.brandVoice ? `
        <div style="margin-top:20px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--green)">🎙 Voice Profile — Active</span>
            <div style="display:flex;gap:8px">
              <button class="btn btn-outline btn-sm" data-action="generate-brand-voice">↺ Regenerate</button>
              <button class="btn btn-ghost btn-sm" data-action="clear-brand-voice" style="color:var(--red)">Clear</button>
            </div>
          </div>
          <textarea id="brand-voice-edit" class="input" rows="8"
            style="width:100%;resize:vertical;font-size:13px;line-height:1.8;font-family:inherit"
            oninput="state.brandVoice=this.value;scheduleSettingsSave();refreshVoiceBadge()"
          >${escHtml(state.brandVoice)}</textarea>
          <div style="font-size:11px;color:var(--text-3);margin-top:5px">Edit freely — saves automatically and applies to every AI generation.</div>
        </div>` : `
        <div style="margin-top:16px;padding:24px;border:1px dashed var(--border-md);border-radius:var(--r-md);text-align:center">
          <div style="font-size:28px;margin-bottom:8px">🎙</div>
          <div style="font-size:13px;font-weight:600;color:var(--text-2);margin-bottom:4px">No voice profile yet</div>
          <div style="font-size:12px;color:var(--text-3)">Paste your newsletter URL above and click Analyze.</div>
        </div>`}
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
      <div class="settings-section">
        <div class="settings-section-title">Section Defaults</div>
        <div class="settings-section-sub">Default AI instructions for each section type. Pre-filled on every new newsletter so you never start from scratch.</div>
        <div style="display:flex;flex-direction:column;gap:20px;margin-top:16px">
          ${sectionTypes.map(s => `
          <div>
            <div style="font-size:13px;font-weight:600;margin-bottom:2px">${s.label}</div>
            <div style="font-size:11px;color:var(--text-3);margin-bottom:6px">${s.desc}</div>
            <textarea class="input default-prompt-input" data-type="${s.key}" rows="2"
              style="width:100%;resize:vertical;font-size:12px"
              placeholder="${escHtml(s.placeholder)}"
            >${escHtml(state.defaultPrompts?.[s.key] || '')}</textarea>
          </div>`).join('')}
        </div>
      </div>

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
        </div>
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
    <div class="app-nav-logo">
      <div class="app-nav-logo-icon">L</div>
      Curanta
    </div>
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
      <button class="btn-icon" data-action="logout" title="Sign out" style="font-size:15px">↩</button>
    </div>
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
        <button class="btn btn-sm btn-outline" onclick="quickAddFeed('https://feeds.feedburner.com/TechCrunch')">Try TechCrunch RSS</button>
        <button class="btn btn-sm btn-outline" onclick="quickAddFeed('https://feeds.reuters.com/reuters/technologyNews')">Try Reuters Tech</button>
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

function renderArticleCard(article, feedId, isInSection) {
  return `
<div class="article-card ${isInSection ? 'in-section' : ''}"
  draggable="true"
  data-article-id="${article.id}"
  data-feed-id="${feedId}"
  ondragstart="dragStart(event,'${article.id}')"
  ondragend="dragEnd(event)"
  ondblclick="addToSection('${article.id}','leadStory')">
  <div class="article-card-title">${escHtml(article.title)}</div>
  <div class="article-card-meta">
    <span class="article-card-source">${escHtml(article.source || '')}</span>
    <span class="article-card-time">${article.timeAgo || ''}</span>
  </div>
  <div class="article-card-actions">
    <button class="article-card-btn" data-action="add-to-section" data-article-id="${article.id}" data-section="leadStory" title="Add to Lead Story">Lead</button>
    <button class="article-card-btn" data-action="add-to-section" data-article-id="${article.id}" data-section="quickHits" title="Add to Quick Hits">Hit</button>
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
    const res = await fetch(`/api/ingest?url=${encodeURIComponent(url)}`);
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
  }).join('') + `<div style="padding:12px 0;text-align:center">
    <button class="btn btn-ghost btn-sm" data-action="show-add-section">+ Add section</button>
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
      ${canRemove ? `<button class="btn btn-sm btn-ghost" data-action="remove-section" data-section-id="${sectionId}" title="Remove section" style="color:var(--red);padding:2px 6px">×</button>` : ''}
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

function renderSection(sectionId, label, type = 'hits') {
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
      <button class="btn btn-sm btn-primary" data-action="apply-prompt" data-section="${sectionId}">▶ Apply</button>
      ${canRemove ? `<button class="btn btn-sm btn-ghost" data-action="remove-section" data-section-id="${sectionId}" title="Remove section" style="color:var(--red);padding:2px 6px">×</button>` : ''}
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
  const hints = {
    leadStory: 'Drag article cards here',
    quickHits: 'Drag 2–5 articles for quick hits',
    cta: 'Add a sponsor or CTA article',
  };
  return `<div class="drop-placeholder">
    <div class="drop-placeholder-icon">⊕</div>
    <p>${hints[sectionId] || 'Drop articles here'}</p>
    <small>or double-click an article card in Sources</small>
  </div>`;
}

function renderStoryBlock(article, sectionId) {
  if (article.loading) {
    return `<div class="story-block loading" id="story-${article.id}">
      <div class="story-block-loading"><div class="spinner"></div> Generating with AI…</div>
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
    <div class="story-content">${content ? formatContent(content) : '<span style="color:var(--text-3);font-style:italic">No content yet — click Apply or Edit</span>'}</div>
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

function refreshSectionContent(sectionId) {
  const container = document.getElementById(`section-content-${sectionId}`);
  if (!container) return;
  const articles = state.newsletter.sections[sectionId] || [];
  const sectionType = state.newsletter.sectionMeta[sectionId]?.type || 'hits';
  const isGrid = sectionType === 'hits' || sectionType === 'generic';
  container.className = `section-content ${isGrid && articles.length > 0 ? 'quick-hits-grid' : ''}`;
  container.innerHTML = articles.length === 0
    ? renderDropPlaceholder(sectionId)
    : articles.map(a => renderStoryBlock(a, sectionId)).join('');
  setupDropZones();
}

function getAllSectionArticleIds() {
  const ids = new Set();
  Object.values(state.newsletter.sections).forEach(arr => arr.forEach(a => ids.add(a.id)));
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

async function addToSection(articleId, sectionId) {
  const article = findArticle(articleId);
  if (!article) { toast('Article not found', 'error'); return; }
  if (!state.newsletter.sections[sectionId]) state.newsletter.sections[sectionId] = [];
  if (state.newsletter.sections[sectionId].some(a => a.id === articleId)) {
    toast('Article already in this section', 'warn'); return;
  }
  const sectionType = state.newsletter.sectionMeta[sectionId]?.type || 'hits';
  if (sectionType === 'briefing') {
    state.newsletter.sections[sectionId].push({ ...article });
    refreshTopStoriesSection();
    scheduleSave();
    return;
  }
  const typeToAction = { lead: 'lead-story', hits: 'quick-hit', cta: 'cta', generic: 'quick-hit' };
  const action = typeToAction[sectionType] || 'quick-hit';
  const entry = { ...article, content: null, loading: true };
  state.newsletter.sections[sectionId].push(entry);
  refreshSectionContent(sectionId);
  refreshSourceSidebar();
  try {
    const result = await callAI(action, article, { prompt: state.newsletter.prompts[sectionId] });
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

function showImageModal(articleId, sectionId) {
  const modal = document.getElementById('modal-root');
  if (!modal) return;
  modal.innerHTML = `
  <div class="modal-overlay" id="img-modal-overlay">
    <div class="modal" style="max-width:420px">
      <div class="modal-header">
        <div>
          <div class="modal-title">Insert Image</div>
          <div class="modal-sub">Paste an image URL to embed it in this story</div>
        </div>
        <button class="btn-icon" data-action="close-modal" style="font-size:18px;line-height:1">×</button>
      </div>
      <div class="modal-body" style="padding:20px">
        <input id="img-url-input" class="input" type="url" placeholder="https://example.com/image.jpg" style="width:100%;margin-bottom:12px">
        <div id="img-preview" style="display:none;margin-bottom:12px;text-align:center">
          <img id="img-preview-el" src="" style="max-width:100%;max-height:200px;border-radius:6px;border:1px solid var(--border)">
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
  input.focus();
  input.addEventListener('input', () => {
    const preview = modal.querySelector('#img-preview');
    const img = modal.querySelector('#img-preview-el');
    if (input.value.trim()) { img.src = input.value.trim(); preview.style.display = 'block'; }
    else { preview.style.display = 'none'; }
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') confirmInsertImage(articleId, sectionId); });
}

function confirmInsertImage(articleId, sectionId) {
  const input = document.getElementById('img-url-input');
  const url = input?.value.trim();
  if (!url) { toast('Enter an image URL', 'warn'); return; }
  const article = state.newsletter.sections[sectionId]?.find(a => a.id === articleId);
  if (!article) return;
  article.content = (article.content || article.summary || '') + `\n\n![Image](${url})`;
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
  const { data: copy, error: copyErr } = await sb.from('newsletters').insert({
    user_id: state.user.id,
    title: (full.title || 'Untitled') + ' (Copy)',
    subject: full.subject || '',
    preview_text: full.preview_text || '',
    sections: full.sections,
    prompts: full.prompts,
    status: 'draft',
  }).select('id').single();
  if (copyErr) { toast('Duplicate failed', 'error'); return; }
  toast('Newsletter duplicated', 'success');
  state.dbNewsletters = await loadNewslettersFromDB();
  render();
}

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
  const type = state.newsletter.sectionMeta[sectionId]?.type || 'generic';
  const typeToKey = { briefing: 'briefing', lead: 'lead', hits: 'hits', cta: 'cta', generic: 'generic' };
  return state.defaultPrompts?.[typeToKey[type] || 'generic'] || '';
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
  <button class="ai-action-btn" data-action="generate-subjects" ${state.aiLoading ? 'disabled' : ''}>
    ${state.aiLoading ? '<div class="spinner"></div>' : '<span class="ai-action-icon">✉</span>'} Generate subject lines
  </button>
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

  state.voiceUrlLoading = true;
  refreshSettingsVoiceSection();
  toast('Fetching your past issues…', 'info');

  try {
    const res = await fetch(`/api/discover-voice?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Discovery failed');

    toast(`Found ${data.count} issues from "${data.source}" — generating voice profile…`, 'info');

    // Track the publication URL
    if (!state.voiceUrls.includes(url)) state.voiceUrls.push(url);
    state.brandVoiceSamples = data.text;

    state.voiceUrlLoading = false;
    await generateBrandVoice();
    if (input) input.value = '';
  } catch (e) {
    toast(`Error: ${e.message}`, 'error');
    state.voiceUrlLoading = false;
    refreshSettingsVoiceSection();
  }
}
window.discoverVoice = discoverVoice;
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

async function generateSubjectLines() {
  const content = getFirstSectionArticle() || { title: state.newsletter.title, summary: '', source: '' };
  state.aiLoading = true; refreshAIPanel();
  try {
    state.aiResult = await callAI('subject-line', content);
    addToHistory('subject-line', state.aiResult);
  } catch (e) { toast(e.message, 'error'); }
  state.aiLoading = false; refreshAIPanel();
}

async function generatePreviewText() {
  const content = getFirstSectionArticle() || { title: state.newsletter.title, summary: '' };
  state.aiLoading = true; refreshAIPanel();
  try {
    state.aiResult = await callAI('preview-text', content);
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
    <button class="integration-btn" data-action="mock-sync" data-platform="beehiiv">🐝 Sync to Beehiiv</button>
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
    <button class="btn btn-primary" style="width:100%;justify-content:center;font-size:15px;padding:12px" onclick="closeModal();subscribe()">Start free trial →</button>
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
  if (state.newsletter.sectionOrder.length <= 1) { toast('Must have at least one section', 'warn'); return; }
  state.newsletter.sectionOrder = state.newsletter.sectionOrder.filter(id => id !== sectionId);
  delete state.newsletter.sections[sectionId];
  delete state.newsletter.sectionMeta[sectionId];
  delete state.newsletter.prompts[sectionId];
  render();
  scheduleSave();
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
  if (!sb || !state.user) return;
  clearTimeout(_settingsTimer);
  _settingsTimer = setTimeout(saveUserSettings, 1500);
}

async function saveUserSettings() {
  if (!sb || !state.user) return;
  const { error } = await sb.from('user_settings').upsert({
    user_id: state.user.id,
    brand_voice: state.brandVoice || '',
    brand_voice_samples: state.brandVoiceSamples || '',
    audience_avatar: state.audienceAvatar || '',
    voice_urls: state.voiceUrls || [],
    tone: state.tone || 'punchy-executive',
    brand_color: state.design.primaryColor || '#6366f1',
    default_prompts: state.defaultPrompts || {},
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) console.error('Settings save error:', error);
}

async function loadUserSettings() {
  if (!sb || !state.user) return;
  const { data, error } = await sb
    .from('user_settings')
    .select('*')
    .eq('user_id', state.user.id)
    .single();
  if (error || !data) return;
  if (data.brand_voice)              state.brandVoice           = data.brand_voice;
  if (data.brand_voice_samples)      state.brandVoiceSamples    = data.brand_voice_samples;
  if (data.audience_avatar)          state.audienceAvatar       = data.audience_avatar;
  if (data.voice_urls?.length)       state.voiceUrls            = data.voice_urls;
  if (data.tone)                     state.tone                 = data.tone;
  if (data.brand_color)              state.design.primaryColor  = data.brand_color;
  if (data.default_prompts)          state.defaultPrompts       = { ...state.defaultPrompts, ...data.default_prompts };
  if (data.subscription_status)           state.subscriptionStatus   = data.subscription_status;
  if (data.grandfathered)                 state.grandfathered        = data.grandfathered;
  if (data.generations_this_month != null) state.generationsThisMonth = data.generations_this_month;
  if (data.trial_ends_at)                 state.trialEndsAt          = data.trial_ends_at;
}

// ── Stripe helpers ────────────────────────────────────────────────────────────
async function getAuthToken() {
  if (!sb) return '';
  try {
    const { data } = await sb.auth.getSession();
    return data.session?.access_token || '';
  } catch { return ''; }
}

async function subscribe() {
  if (!state.user) { toast('Sign in first', 'warn'); return; }
  toast('Opening checkout…', 'info');
  try {
    const authToken = await getAuthToken();
    const res = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.user.id, authToken, email: state.user.email }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else throw new Error(data.error || 'Checkout failed');
  } catch (e) { toast('Checkout error: ' + e.message, 'error'); }
}
window.subscribe = subscribe;

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

function isSubscribed() {
  return state.grandfathered || state.subscriptionStatus === 'active' || state.subscriptionStatus === 'trialing';
}

function trialDaysLeft() {
  if (!state.trialEndsAt) return null;
  const ms = new Date(state.trialEndsAt) - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

// Auto-save debounce
let _saveTimer = null;
function scheduleSave() {
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
      const { error } = await sb.from('newsletters').update(payload).eq('id', state.newsletterId);
      if (error) throw error;
    } else {
      const { data: row, error } = await sb.from('newsletters').insert(payload).select('id').single();
      if (error) throw error;
      state.newsletterId = row.id;
    }
    setSaveIndicator('saved');
  } catch (e) {
    console.error('Save error:', e);
    setSaveIndicator('error');
  }
  state.saving = false;
}

async function loadNewslettersFromDB() {
  if (!sb || !state.user) return [];
  const { data, error } = await sb
    .from('newsletters')
    .select('id, title, subject, status, created_at, updated_at')
    .eq('user_id', state.user.id)
    .order('updated_at', { ascending: false })
    .limit(30);
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
  if (!sb) return;
  const { data: nl, error } = await sb.from('newsletters').select('*').eq('id', newsletterId).single();
  if (error || !nl) { console.error('Load newsletter error:', error); return; }
  state.newsletterId = nl.id;
  state.newsletter.title       = nl.title        || 'Untitled Newsletter';
  state.newsletter.subject     = nl.subject       || '';
  state.newsletter.previewText = nl.preview_text  || '';
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
  state.sources = await loadSourcesFromDB();
}

function resetNewsletter() {
  const dp = state.defaultPrompts || {};
  // Map default prompts by section type onto the default section IDs
  state.newsletterId = null;
  state.newsletter = {
    title: 'Untitled Newsletter',
    subject: '',
    previewText: '',
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
  state.approvalStatus = 'draft';
  state.teamComments = [];
  state.versions = [{ num: 'v1', desc: 'Initial draft', time: 'just now' }];
}

async function saveSourceToDB(source) {
  if (!sb || !state.user) return;
  const { data, error } = await sb.from('sources').upsert({
    user_id: state.user.id,
    feed_url: source.feedUrl,
    title: source.title,
    type: source.type,
  }, { onConflict: 'user_id,feed_url' }).select('id').single();
  if (error) { console.error('Source save error:', error); return; }
  if (data?.id) source.id = data.id;
}

async function deleteSourceFromDB(sourceId) {
  if (!sb || !state.user) return;
  const { error } = await sb.from('sources').delete().eq('id', sourceId).eq('user_id', state.user.id);
  if (error) console.error('Source delete error:', error);
}

async function loadSourcesFromDB() {
  if (!sb || !state.user) return [];
  const { data, error } = await sb.from('sources').select('*').eq('user_id', state.user.id).order('created_at');
  if (error) { console.error('Load sources error:', error); return []; }
  return data.map(s => ({
    id: s.id,
    feedUrl: s.feed_url,
    title: s.title || s.feed_url,
    type: s.type || 'feed',
    articles: [],
    collapsed: false,
  }));
}

function autoFetchSources() {
  const unfetched = state.sources.filter(s => s.articles.length === 0);
  if (!unfetched.length) return;
  unfetched.forEach(source => {
    fetch(`/api/ingest?url=${encodeURIComponent(source.feedUrl)}`)
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

// ── BEEHIIV PUBLISH ───────────────────────────────────────────────────────────
async function publishToBeehiiv() {
  // Save current state first so we always publish the latest version
  if (sb && state.user) await saveNewsletter();

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
