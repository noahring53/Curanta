import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { load } from 'cheerio';
import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import rateLimit from 'express-rate-limit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Rate limiting ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // 30 AI generations per 15 min per IP
  message: { error: 'AI rate limit reached. Please wait a few minutes.' },
});

const voiceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // voice discovery is expensive
  message: { error: 'Voice discovery limit reached. Please try again in an hour.' },
});

const ingestLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: { error: 'Too many feed requests. Please wait a few minutes.' },
});

const stripeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many billing requests. Please try again later.' },
});

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const rssParser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': BROWSER_UA,
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const SUPABASE_URL       = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY  = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SVC_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STRIPE_PRICE_ID       = process.env.STRIPE_PRICE_ID       || '';
const STRIPE_MULTI_PRICE_ID = process.env.STRIPE_MULTI_PRICE_ID || ''; // $99/mo multi-pub plan
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET  || '';
const APP_URL               = process.env.APP_URL || 'https://curanta-production.up.railway.app';
const GENERATION_LIMIT      = 500; // per month per paid user

// ── Supabase REST helpers ─────────────────────────────────────────────────────
async function sbGet(table, filter, authToken) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}&select=*`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${authToken}`,
    },
  });
  const data = await res.json();
  return Array.isArray(data) ? data[0] : null;
}

async function sbPatch(table, filter, updates, useServiceRole = false) {
  const key = useServiceRole ? SUPABASE_SVC_KEY : SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[sbPatch] ${table} FAILED (${res.status}):`, text.slice(0, 300));
  }
}

// ── Stripe Webhook — MUST be before express.json() ───────────────────────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;
  try {
    if (event.type === 'checkout.session.completed') {
      const userId = obj.metadata?.user_id;
      if (userId && obj.subscription) {
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        // Detect which plan was purchased by comparing price IDs
        const priceId = sub.items?.data?.[0]?.price?.id || '';
        const plan = (STRIPE_MULTI_PRICE_ID && priceId === STRIPE_MULTI_PRICE_ID) ? 'multi' : 'pro';
        await sbPatch('user_settings', `user_id=eq.${encodeURIComponent(userId)}`, {
          subscription_status: sub.status,
          subscription_plan: plan,
          stripe_customer_id: obj.customer,
          trial_ends_at: sub.trial_end
            ? new Date(sub.trial_end * 1000).toISOString()
            : null,
        }, true);
      }
    } else if (event.type === 'customer.subscription.updated') {
      const validStatuses = ['active', 'trialing'];
      const status = validStatuses.includes(obj.status) ? obj.status : 'inactive';
      const priceId = obj.items?.data?.[0]?.price?.id || '';
      const plan = (STRIPE_MULTI_PRICE_ID && priceId === STRIPE_MULTI_PRICE_ID) ? 'multi' : 'pro';
      await sbPatch('user_settings', `stripe_customer_id=eq.${encodeURIComponent(obj.customer)}`, {
        subscription_status: status,
        subscription_plan: plan,
        trial_ends_at: obj.trial_end
          ? new Date(obj.trial_end * 1000).toISOString()
          : null,
      }, true);
    } else if (event.type === 'customer.subscription.deleted') {
      await sbPatch('user_settings', `stripe_customer_id=eq.${encodeURIComponent(obj.customer)}`, {
        subscription_status: 'inactive',
        trial_ends_at: null,
      }, true);
    } else if (event.type === 'customer.subscription.trial_will_end') {
      // Trial ends in 3 days — store a flag so the app can show an in-app banner.
      // For email notifications, enable "Upcoming renewal reminders" in Stripe Dashboard
      // → Settings → Billing → Subscriptions and emails.
      await sbPatch('user_settings', `stripe_customer_id=eq.${encodeURIComponent(obj.customer)}`, {
        trial_ends_at: obj.trial_end
          ? new Date(obj.trial_end * 1000).toISOString()
          : null,
      }, true);
    } else if (event.type === 'invoice.payment_failed') {
      // Payment failed — mark subscription as past_due so app can surface a warning.
      // Stripe's own dunning emails handle retry notifications automatically if enabled
      // in Dashboard → Settings → Billing → Subscriptions and emails.
      const customerId = obj.customer;
      if (customerId) {
        await sbPatch('user_settings', `stripe_customer_id=eq.${encodeURIComponent(customerId)}`, {
          subscription_status: 'past_due',
        }, true);
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, 'public')));
app.use(globalLimiter);

// ── /api/config ───────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
    hasAI: !!process.env.ANTHROPIC_API_KEY,
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
    hasStripe: !!process.env.STRIPE_SECRET_KEY,
    hasBeehiiv: !!(process.env.BEEHIIV_API_KEY && process.env.BEEHIIV_PUBLICATION_ID),
  });
});

// ── /api/stripe/checkout ──────────────────────────────────────────────────────
app.post('/api/stripe/checkout', stripeLimiter, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const { userId, authToken, email, plan } = req.body; // plan: 'pro' (default) | 'multi'
  if (!userId || !authToken) return res.status(400).json({ error: 'Missing auth' });

  let priceId;
  if (plan === 'multi') {
    if (!STRIPE_MULTI_PRICE_ID) return res.status(503).json({ error: 'Multi-publication plan not yet available. Please contact support.' });
    priceId = STRIPE_MULTI_PRICE_ID;
  } else {
    priceId = STRIPE_PRICE_ID;
  }
  if (!priceId) return res.status(503).json({ error: 'Stripe price not configured' });

  try {
    const settings = await sbGet('user_settings', `user_id=eq.${userId}`, authToken);
    let customerId = settings?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({ email, metadata: { user_id: userId } });
      customerId = customer.id;
      await sbPatch('user_settings', `user_id=eq.${userId}`, { stripe_customer_id: customerId }, false);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      subscription_data: {
        trial_period_days: 7,
        metadata: { plan: plan || 'pro' },
      },
      success_url: `${APP_URL}/?checkout=success`,
      cancel_url: `${APP_URL}/?checkout=cancelled`,
      metadata: { user_id: userId, plan: plan || 'pro' },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/stripe/portal ────────────────────────────────────────────────────────
app.post('/api/stripe/portal', stripeLimiter, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const { userId, authToken } = req.body;
  if (!userId || !authToken) return res.status(400).json({ error: 'Missing auth' });

  try {
    const settings = await sbGet('user_settings', `user_id=eq.${userId}`, authToken);
    if (!settings?.stripe_customer_id) return res.status(400).json({ error: 'No subscription found' });

    const session = await stripe.billingPortal.sessions.create({
      customer: settings.stripe_customer_id,
      return_url: APP_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function stripHtml(str = '') {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function fetchArticle(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Curanta/1.0)',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  // Strip junk
  $(
    'nav, header, footer, aside, .nav, .navbar, .header, .footer, .sidebar,' +
    'script, style, noscript, iframe, template,' +
    '.ad, .ads, .advertisement, .banner, .sponsored,' +
    '.social-share, .share-buttons, .share-bar, .sharing,' +
    '[class*="social-"], [class*="-share"], [class*="share-"],' +
    '[class*="subscribe"], [class*="newsletter-signup"], [class*="paywall"],' +
    'audio, video, .audio-player, [class*="audio-"], [class*="-audio"],' +
    '[class*="cookie"], [class*="consent"], [class*="gdpr"], [class*="popup"],' +
    'figure figcaption, [aria-hidden="true"],' +
    '[class*="related"], [class*="recommended"], [class*="more-stories"],' +
    '[class*="comment"], [class*="discussion"],' +
    '[class*="modal"], [class*="overlay"],' +
    '.byline-image, .author-image, .author-bio,' +
    '[class*="listen-to"], [class*="text-to-speech"]'
  ).remove();

  // Try canonical content selectors
  const candidates = [
    'article [class*="content"]',
    'article [class*="body"]',
    'article',
    '[role="main"] [class*="content"]',
    '[role="main"] [class*="body"]',
    '[role="main"]',
    'main [class*="article"]',
    'main [class*="story"]',
    'main [class*="content"]',
    '.article-body', '.article-content', '.article__body', '.article__content',
    '.post-body', '.post-content', '.post__content',
    '.entry-content', '.story-body', '.story-content',
    '.content-body', '#article-body', '#main-content',
    '.body-copy', '.body-text',
  ];

  let text = '';
  for (const sel of candidates) {
    const el = $(sel).first();
    const candidate = el.text().replace(/\s+/g, ' ').trim();
    if (candidate.length > 300) {
      text = candidate.slice(0, 5000);
      break;
    }
  }

  if (!text) {
    text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 5000);
  }

  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').text() ||
    'Untitled';

  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content') ||
    '';

  const publishedAt =
    $('meta[property="article:published_time"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    new Date().toISOString();

  const source =
    $('meta[property="og:site_name"]').attr('content') ||
    new URL(url).hostname.replace(/^www\./, '');

  // Extract images — og:image first, then prominent content images
  const pageBase = new URL(url);
  const seenImages = new Set();
  const images = [];

  const addImage = (src) => {
    if (!src) return;
    try {
      const abs = new URL(src, pageBase).href;
      if (seenImages.has(abs)) return;
      // Skip tiny icons, tracking pixels, SVGs, data URIs
      if (abs.startsWith('data:')) return;
      if (/\.(svg|ico|gif)(\?|$)/i.test(abs)) return;
      if (/\/(icon|logo|avatar|spinner|pixel|badge|emoji)/i.test(abs)) return;
      seenImages.add(abs);
      images.push(abs);
    } catch { /* bad URL */ }
  };

  // Priority 1: Open Graph / Twitter card (usually the hero image)
  addImage($('meta[property="og:image"]').attr('content'));
  addImage($('meta[name="twitter:image"]').attr('content'));
  addImage($('meta[name="twitter:image:src"]').attr('content'));

  // Priority 2: <img> tags inside article content — skip thumbnails < ~300px
  $('article img, [class*="content"] img, [class*="body"] img, main img').each((_, el) => {
    if (images.length >= 6) return false; // stop after 6
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
    const w = parseInt($(el).attr('width') || '0', 10);
    const h = parseInt($(el).attr('height') || '0', 10);
    if (w && w < 200) return; // skip small images
    if (h && h < 150) return;
    addImage(src);
  });

  return {
    id: crypto.randomUUID(),
    title: title.trim().slice(0, 200),
    url,
    summary: description.trim().slice(0, 400),
    text,
    source,
    publishedAt,
    timeAgo: timeAgo(publishedAt),
    type: 'article',
    images: images.slice(0, 6), // max 6 images
    imageUrl: images[0] || null, // primary image
  };
}

// ── /api/ingest ───────────────────────────────────────────────────────────────
app.get('/api/ingest', ingestLimiter, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  // Try RSS/Atom first
  try {
    const feed = await rssParser.parseURL(url);
    const rawItems = feed.items.slice(0, 16);

    const articles = await Promise.all(
      rawItems.map(async (item) => {
        const base = {
          id: crypto.randomUUID(),
          title: item.title?.trim() || 'Untitled',
          url: item.link || '',
          summary: stripHtml(item.contentSnippet || item.content || '').slice(0, 350),
          text: '',
          source: feed.title || new URL(url).hostname.replace(/^www\./, ''),
          publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
          timeAgo: timeAgo(item.pubDate || item.isoDate || new Date().toISOString()),
          type: 'rss',
        };
        // Best-effort: fetch full article text + images
        if (item.link) {
          try {
            const full = await fetchArticle(item.link);
            return {
              ...base,
              text: full.text,
              summary: base.summary || full.summary,
              images: full.images || [],
              imageUrl: full.imageUrl || null,
            };
          } catch {
            return base;
          }
        }
        return base;
      })
    );

    return res.json({
      type: 'feed',
      source: feed.title || new URL(url).hostname.replace(/^www\./, ''),
      feedUrl: url,
      articles,
    });
  } catch (_rssErr) {
    // Fall through to single-article attempt
  }

  // Try as a single article page
  try {
    const article = await fetchArticle(url);
    return res.json({
      type: 'article',
      source: article.source,
      feedUrl: url,
      articles: [article],
    });
  } catch (e) {
    return res.status(500).json({ error: `Could not parse URL: ${e.message}` });
  }
});

// ── /api/extract-images ───────────────────────────────────────────────────────
app.get('/api/extract-images', ingestLimiter, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const article = await fetchArticle(url);
    res.json({ images: article.images || [], imageUrl: article.imageUrl || null });
  } catch (e) {
    res.status(500).json({ error: e.message, images: [] });
  }
});

// ── /api/discover-voice ───────────────────────────────────────────────────────
app.get('/api/discover-voice', voiceLimiter, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  let base;
  try { base = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  // Always probe the origin, even if they pasted a specific post URL
  const origin = base.origin;

  // Ordered probe list — most likely first per platform
  // Beehiiv: /feed  Substack: /feed  Ghost: /rss/  WordPress: /feed
  const rssAttempts = [
    url,                        // maybe they pasted the feed URL itself
    `${origin}/feed`,
    `${origin}/rss`,
    `${origin}/feed.xml`,
    `${origin}/rss.xml`,
    `${origin}/rss/`,
    `${origin}/atom.xml`,
    `${origin}/index.xml`,
    `${origin}/?feed=rss2`,     // WordPress fallback
    `${origin}/feeds/posts/default`, // Blogger
  ];

  let feed = null;
  for (const attempt of rssAttempts) {
    try {
      feed = await rssParser.parseURL(attempt);
      if (feed?.items?.length) break;
    } catch { /* try next */ }
  }

  // Fallback 1: scrape <link rel="alternate"> from the page HTML
  if (!feed?.items?.length) {
    try {
      const html = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' },
        signal: AbortSignal.timeout(12000),
      }).then(r => r.text());
      const $ = load(html);
      const rssHref = $('link[type="application/rss+xml"], link[type="application/atom+xml"]').first().attr('href');
      if (rssHref) {
        const resolved = new URL(rssHref, url).href;
        feed = await rssParser.parseURL(resolved);
      }

      // Fallback 2: if still no RSS, scrape post links directly from the page
      if (!feed?.items?.length) {
        const postLinks = [];
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href');
          if (!href) return;
          try {
            const full = new URL(href, url).href;
            // Only keep links on the same domain that look like posts
            if (
              full.startsWith(origin) &&
              full !== origin && full !== origin + '/' &&
              !full.includes('#') &&
              (full.includes('/p/') || full.includes('/post/') || full.includes('/archive/') ||
               full.includes('/issues/') || full.includes('/newsletter/') ||
               /\/[a-z0-9-]{10,}$/.test(new URL(full).pathname))
            ) {
              if (!postLinks.includes(full)) postLinks.push(full);
            }
          } catch { /* bad href */ }
        });

        if (postLinks.length >= 2) {
          // Treat scraped links as synthetic feed items
          feed = {
            title: base.hostname,
            items: postLinks.slice(0, 10).map(link => ({ link, title: link })),
          };
        }
      }
    } catch { /* give up */ }
  }

  if (!feed?.items?.length) {
    return res.status(404).json({
      error: 'Could not find past issues at that URL. Try pasting your RSS feed URL directly — for Beehiiv it\'s yourpub.beehiiv.com/feed, for Substack it\'s yourname.substack.com/feed.',
    });
  }

  // Extract content from each issue — take up to 15, larger char budget
  const items = feed.items.slice(0, 15);
  const results = await Promise.allSettled(items.map(async item => {
    const rssBody = stripHtml(item['content:encoded'] || item.content || '').replace(/\s+/g, ' ').trim();
    if (rssBody.length > 600) {
      return { title: item.title || 'Untitled', text: rssBody.slice(0, 8000) };
    }
    if (item.link) {
      try {
        const art = await fetchArticle(item.link);
        if (art.text?.length > 200) return { title: item.title || art.title, text: art.text.slice(0, 8000) };
      } catch { /* use snippet */ }
    }
    return rssBody.length > 100 ? { title: item.title || 'Untitled', text: rssBody } : null;
  }));

  const issues = results
    .filter(r => r.status === 'fulfilled' && r.value?.text?.length > 100)
    .map(r => r.value);

  if (!issues.length) {
    return res.status(404).json({
      error: 'Found issues but could not extract content — the newsletter may be behind a paywall.',
    });
  }

  const combined = issues
    .map((iss, i) => `=== Issue ${i + 1}: ${iss.title} ===\n${iss.text}`)
    .join('\n\n');

  // Run deep AI analysis — generates voice profile, audience avatar, and section defaults
  try {
    const aiRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: `You are an expert writing analyst and brand strategist. You will analyze newsletter issues and produce a comprehensive AI writer profile. Your output must be valid JSON — no markdown, no commentary, just the JSON object.`,
      messages: [{
        role: 'user',
        content: `Analyze these ${issues.length} newsletter issues and produce a JSON object with EXACTLY these keys:

{
  "voiceProfile": "3-4 paragraph voice profile written as direct instructions to an AI that will ghost-write future issues. Be extremely specific: quote actual phrases from the samples, describe sentence rhythm (short punchy vs long flowing), vocabulary level, how they open each piece, how they close, their relationship with data vs opinion, use of humor or irony, what they NEVER do, and what makes their voice unmistakable. This should read like a style guide an editor gave a new writer.",
  "audienceAvatar": "2 paragraph description of the ideal subscriber. Infer from the content: what industry or topic they care about, their experience level, when and why they read this newsletter, what they want to feel after reading it, what they already know (so the writer doesn't over-explain), and what they value most. Write it in second person as if briefing the AI: 'Your reader is...'",
  "newsletterName": "Best guess at the newsletter's name or publication from the content",
  "topicFocus": "One sentence: what is this newsletter fundamentally about?",
  "sectionSuggestions": ["array of 4-6 section names that fit this newsletter's style, e.g. 'Today's Briefing', 'The Big Story', 'Quick Hits', 'What To Watch'"]
}

Newsletter content to analyze:

${combined.slice(0, 60000)}`,
      }],
    });

    let profile;
    try {
      const raw = aiRes.content[0].text.trim();
      const jsonStr = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      profile = JSON.parse(jsonStr);
    } catch {
      // If JSON parse fails, return raw text as voiceProfile only
      profile = { voiceProfile: aiRes.content[0].text, audienceAvatar: '', newsletterName: feed.title || base.hostname, topicFocus: '', sectionSuggestions: [] };
    }

    res.json({
      count: issues.length,
      source: profile.newsletterName || feed.title || base.hostname,
      text: combined,
      voiceProfile: profile.voiceProfile || '',
      audienceAvatar: profile.audienceAvatar || '',
      topicFocus: profile.topicFocus || '',
      sectionSuggestions: profile.sectionSuggestions || [],
    });
  } catch (e) {
    // If AI fails, return raw text so client can still generate voice
    res.json({ count: issues.length, source: feed.title || base.hostname, text: combined });
  }
});

// ── AI tone descriptions ──────────────────────────────────────────────────────
const TONES = {
  'punchy-executive': 'You write like a sharp, no-fluff executive newsletter. Direct, confident, data-informed. Short sentences. No padding.',
  'morning-brew': 'You write like Morning Brew: conversational, witty, and genuinely informative. Clever transitions, occasional dry humor. Friendly but never fluffy.',
  'neutral-newsroom': 'You write in neutral AP-style journalistic prose. Facts first, zero hype, clear attribution. No opinions unless labeled.',
  'sharp-political': 'You write with a sharp political newsletter voice. Punchy insider framing, urgency, strategic context. Readers feel they are getting the real story.',
};

// Mock responses for when no API key is configured
function extractKeyFact(text = '') {
  // Try patterns in priority order — most specific first
  const patterns = [
    // "214 seats", "3 districts", "12 states"
    /\b(\d[\d,]*\s+(?:seats?|votes?|districts?|states?|jobs?|companies|nations?|members?|people|patients?|cases?|bills?|laws?|counties|precincts?))\b/i,
    // "$2.4 billion", "$340 million"
    /(\$[\d,]+(?:\.\d+)?\s*(?:billion|million|trillion|thousand)?)/i,
    // "67% of homeowners", "5.2% unemployment"
    /(\d+(?:\.\d+)?%\s+of\s+[a-z\s]{3,25})/i,
    // "down 12 points", "up 340,000"
    /\b((?:up|down|fell?|rose?|gained?|lost?|added?|cut|raised?)\s+[\d,]+(?:\.\d+)?(?:\s*%|\s+(?:percent|points?|billion|million|jobs?|seats?))?)\b/i,
    // Standalone percentage: "67%", "12.4 percent"
    /\b(\d+(?:\.\d+)?(?:%|\s+percent))\b/i,
    // Large standalone number with context
    /\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?)\b/,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      // Grab up to 60 chars of surrounding context
      const idx = text.indexOf(m[0]);
      const start = Math.max(0, idx - 30);
      const end = Math.min(text.length, idx + m[0].length + 40);
      let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
      // Clean leading partial words
      snippet = snippet.replace(/^\S*\s/, '').replace(/\s\S*$/, '');
      if (snippet.length > 15) return snippet;
    }
  }
  return null;
}

function mockResponse(action, content, contents = []) {
  if (action === 'top-stories') {
    const items = contents.length ? contents : [content];
    const emojis = ['🔴','🤖','📅','🏠','💼','📈','🌍','⚖️'];
    const bullets = items.map((a, i) => {
      const text = a.text || a.summary || '';
      const fact = extractKeyFact(text) || a.title || 'Breaking development';
      return `• ${emojis[i % emojis.length]} ${fact}`;
    }).join('\n');
    const sources = items
      .filter(a => a.source && a.url)
      .map(a => `[${a.source}](${a.url})`)
      .join(', ');
    return bullets + (sources ? `\n\nSources: ${sources}` : '');
  }
  const title = content.title || 'Breaking Development';
  const source = content.source || 'Source';
  const url = content.url || '#';
  const summary = content.summary || content.text?.slice(0, 150) || 'Key developments are unfolding in this fast-moving story.';

  const mocks = {
    'lead-story': `${title} is reshaping expectations across the industry — and most coverage is missing the real story.

**The details:** ${summary} Officials and insiders confirmed the core elements of this story through independent channels. The timeline spans several months of behind-the-scenes maneuvering before becoming public.

**Has this been done before?** Similar situations have emerged in recent cycles, but the current circumstances carry institutional weight that sets this apart from historical precedents. Prior attempts lacked the structural alignment now in play.

**The difference:** What makes this moment distinct is the convergence of timing, scale, and the specific actors involved. The players here have resources and motivation that earlier iterations simply didn't have.

**Why it matters:** The downstream effects will ripple through the sector for months. Decision-makers are already adjusting their strategies in response, even if they won't say so publicly.

**Real talk:** This is bigger than it appears on the surface. The framing you'll see in mainstream coverage misses the deeper structural shift underway. Watch what happens next — the second-order effects are where the real story lives.

[Source: ${source}](${url})`,

    'quick-hit': `**${title}** — ${summary.slice(0, 110)} The implications are broader than the headline suggests, and this one is worth watching as details continue to emerge. [→ Read more](${url})`,

    'subject-line': `1. "${title.slice(0, 48)}"\n2. "What you're not hearing about ${source}"\n3. "The story behind the story (${source})"`,

    'preview-text': `Here's what's actually happening — and why it changes more than you think...`,

    'rewrite': `${title}: ${summary} Industry observers watching this space note the significance goes beyond the immediate headline. The structural implications will take time to fully materialize, but early signals suggest meaningful change is underway. What to watch: the next 30 days of follow-on decisions will reveal how deep this runs.`,

    'summarize': `**In three sentences:** ${title} represents a meaningful shift in how this space operates. ${summary.slice(0, 120)} The most important detail most outlets are underplaying is the timing — this didn't happen in isolation.`,

    'hooks': `→ "The news everyone got wrong this week"\n→ "Why this story changes everything for ${source} watchers"\n→ "What the headline buried"\n→ "The part nobody's talking about"`,

    'cta': `Want deeper coverage like this delivered every week? Our Pro readers get extended analysis, primary source documents, and early access to our research briefings. Join 12,000+ professionals who read us before the news breaks.`,

    'brand-voice': `**Voice profile:** Direct and authoritative with a slight editorial edge. Sentences run short to medium. Vocabulary is professional but accessible — no jargon without explanation. Data and sourcing are prioritized. Tone is confident without being arrogant. Light use of rhetorical questions to create momentum. Signature pattern: lead with the insight, then the supporting evidence. Avoids passive voice. Readers feel informed and slightly ahead of the curve.`,
  };

  if (action === 'briefing-prompt') {
    return `Lead each line with a single relevant emoji, then the hardest number or most specific fact from the article, followed by brief context. End each line with the source URL as plain text. Keep each line under 120 characters before the URL. No bullets, no intro text, no Sources line.`;
  }
  return mocks[action] || mocks['rewrite'];
}

// ── /api/ai ───────────────────────────────────────────────────────────────────
app.post('/api/ai', aiLimiter, async (req, res) => {
  const {
    action,
    content = {},
    contents = [],   // array of articles for multi-article actions
    tone = 'punchy-executive',
    prompt: customPrompt = '',
    brandVoice = '',
    audienceAvatar = '',
    userId = '',
    authToken = '',
  } = req.body;

  if (!anthropic) {
    return res.json({ result: mockResponse(action, content, contents), mock: true });
  }

  // ── Subscription + usage check ─────────────────────────────────────────────
  if (userId && authToken && SUPABASE_URL) {
    try {
      const settings = await sbGet('user_settings', `user_id=eq.${userId}`, authToken);
      if (settings) {
        const allowed = settings.grandfathered || ['active', 'trialing', 'past_due'].includes(settings.subscription_status);
        if (!allowed) {
          return res.status(402).json({ error: 'subscription_required' });
        }
        if (!settings.grandfathered) {
          // Reset counter if it's been > 30 days
          const resetAt = new Date(settings.generations_reset_at || 0);
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          if (resetAt < thirtyDaysAgo) {
            sbPatch('user_settings', `user_id=eq.${userId}`,
              { generations_this_month: 1, generations_reset_at: new Date().toISOString() },
              false); // fire-and-forget — resets counter and stamps new 30-day window
          } else if ((settings.generations_this_month || 0) >= GENERATION_LIMIT) {
            return res.status(429).json({
              error: 'generation_limit',
              message: `Monthly limit of ${GENERATION_LIMIT} generations reached. Resets in ${Math.ceil((resetAt.getTime() + 30*24*60*60*1000 - Date.now()) / 86400000)} days.`,
            });
          } else {
            sbPatch('user_settings', `user_id=eq.${userId}`,
              { generations_this_month: (settings.generations_this_month || 0) + 1 },
              false); // fire-and-forget
          }
        }
      }
    } catch (err) {
      console.error('Subscription check error:', err.message);
      // Don't block generation on subscription check failure
    }
  }

  const toneDesc = TONES[tone] || TONES['punchy-executive'];
  const voiceNote = brandVoice
    ? `\n\nCRITICAL — Brand voice to match exactly:\n${brandVoice}\nThis voice profile overrides default style. Write as if you ARE this writer.`
    : '';
  const audienceNote = audienceAvatar
    ? `\n\nTarget reader profile:\n${audienceAvatar}\nWrite for this specific person. Let their background shape what you emphasise, what you explain, and what you leave out.`
    : '';

  // Give lead stories more source material
  const articleContext = [
    content.title ? `Title: ${content.title}` : '',
    content.summary ? `Summary: ${content.summary}` : '',
    content.text ? `Full text:\n${content.text.slice(0, 6000)}` : '',
    content.url ? `URL: ${content.url}` : '',
    content.source ? `Source: ${content.source}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const prompts = {
    'lead-story': (() => {
      const items = contents.length ? contents : [content];
      const multi = items.length > 1;
      const sourceList = items.map((a, i) =>
        `Source ${i + 1} — ${a.source || 'Unknown outlet'}\nURL: ${a.url || '(no url)'}\nTitle: ${a.title || ''}\nReport:\n${(a.text || a.summary || '').slice(0, 4000)}`
      ).join('\n\n---\n\n');

      const hyperlinkRules = `
HYPERLINKS — required, this is important:
- Attribute specific facts inline using markdown links to the outlet that reported them, e.g. "...the deal closed at $2.4B [per Bloomberg](URL)...". Use the REAL URLs given above — never invent or use "#".
- Use ${multi ? '2–4' : '1–2'} inline hyperlinks woven naturally into the prose. Anchor text should be the outlet name or a short natural phrase, never a bare URL.${multi ? '\n- Spread the inline links across DIFFERENT sources where the facts come from.' : ''}
- End with a separate final line: "Sources: " followed by every outlet as markdown links separated by " · ", e.g. Sources: [Reuters](URL) · [Bloomberg](URL).`;

      if (multi) {
        return {
          system: `${toneDesc}${voiceNote}${audienceNote}

You write ONE newsletter lead story that SYNTHESIZES several reports about the SAME event into a single authoritative piece — 320–420 words, 5–6 paragraphs.

You are given multiple articles from different outlets covering the same story. Merge them into one cohesive narrative: corroborate facts that appear across sources, fold in unique details each outlet adds, and note where accounts meaningfully differ. Do NOT write a separate summary per outlet and do NOT repeat the same fact twice.

Structure:
- Opening (2 sentences max): the sharpest specific insight or number — not a headline restatement.
- The details: the key facts and timeline, drawn from across the sources.
- Context: one or two sentences on why this moment is different from before.
- The angle: your take — what's being underplayed or misframed. A specific, defensible claim.
- Why it matters: concrete downstream effects for readers — who, and how.
- Closing line: one punchy prediction or the thing to watch next.
${hyperlinkRules}

Writing rules:
- Specific beats vague. Numbers, names, and dates beat "many" and "some."
- Sentences under 20 words hit harder. Active voice only. No hedging, no "it is worth noting," no "in a sign of."
- The brand voice profile — if set — overrides everything else.`,
          user: `Write ONE synthesized lead story from these ${items.length} reports about the same event.${customPrompt ? `\nEditor's instructions: ${customPrompt}` : ''}\n\n${sourceList}`,
        };
      }

      return {
        system: `${toneDesc}${voiceNote}${audienceNote}

You write newsletter lead stories — 300–380 words, 5–6 paragraphs.

Structure:
- **Opening (2 sentences max):** Don't restate the headline. Lead with the sharpest specific insight, number, or angle that most coverage is missing.
- **The details:** Key facts, timeline, specifics. What actually happened and who it involves.
- **Context:** One or two sentences of relevant history or landscape — why this moment is different from before.
- **The angle:** Your take. What's being underplayed or misframed. Make a specific, defensible claim.
- **Why it matters:** Concrete downstream effects for readers. Be specific about who and how.
- **Closing line:** One punchy sentence — a prediction, a question, or the thing to watch next.
${hyperlinkRules}

Writing rules:
- Specific beats vague. Numbers, names, and dates beat "many" and "some."
- Sentences under 20 words hit harder than long ones.
- No passive voice. No "it is worth noting." No "in a sign of."
- Don't hedge. If you have a take, state it.
- The brand voice profile — if set — overrides everything else. Write in that voice above all.`,
        user: `Write a lead story for this article.\n${customPrompt ? `Editor's instructions: ${customPrompt}\n` : ''}\n${articleContext}`,
      };
    })(),
    'quick-hit': {
      system: `${toneDesc}${voiceNote}${audienceNote}

You write newsletter quick hits — tight 80–110 word blurbs that give the reader the one thing they need to know and why it matters.

Structure: **[Bold title]** — [The single sharpest fact or number, 1 sentence]. [What's surprising, significant, or underplayed — 1–2 sentences]. [→ Read more](URL)

Rules:
- Lead with the most concrete detail from the article, not the general topic.
- Second sentence must add genuine insight — not just restate the first in different words.
- If there's a stat, percentage, or dollar figure, use it.
- Never open with "In a sign of..." or "According to..." or "As..."
- End every blurb with a → link.`,
      user: `Write a Quick Hit blurb.\n${customPrompt ? `Editor's instructions: ${customPrompt}\n` : ''}\n${articleContext}`,
    },
    'subject-line': {
      system: `You are a newsletter growth expert who has studied thousands of high-performing subject lines. You write subject lines that get opened.

Rules:
- Under 52 characters each (most email clients truncate beyond this)
- Create curiosity or convey clear value — not both, pick one
- Be specific: numbers, names, and concrete claims outperform vague promises
- Never use: "You won't believe", "This will change", "Game-changer", or clickbait questions
- No emojis unless the newsletter's voice explicitly uses them
- Avoid colons — they read as corporate

Generate 3 options. Number them. No explanations.${customPrompt ? `\n\nThe editor has given specific instructions for these subject lines — follow them above all other rules:\n${customPrompt}` : ''}`,
      user: `Write 3 subject lines for this newsletter issue.${customPrompt ? `\n\nEditor's instructions (follow these): ${customPrompt}` : ''}\n\nNewsletter title: ${content.title || 'Newsletter'}${content.topStoriesContent ? `\n\nToday's Briefing:\n${content.topStoriesContent.slice(0, 800)}` : ''}\n\nContent summary:\n${content.summary || articleContext || ''}`,
    },
    'preview-text': {
      system: `You write email preview text — the 60–90 character snippet shown in the inbox beside the subject line. It must complement, not repeat, the subject line. Be specific — pull the sharpest detail or stat from the content. Drive the open. No emojis.${customPrompt ? `\n\nThe editor has given specific instructions — follow them above all other rules:\n${customPrompt}` : ''}`,
      user: `Write preview text for this newsletter issue.${customPrompt ? `\nEditor's instructions (follow these): ${customPrompt}` : ''}\nNewsletter: ${content.title || 'Newsletter'}${content.topStoriesContent ? `\nBriefing highlights:\n${content.topStoriesContent.slice(0, 600)}` : ''}\nContent:\n${content.summary || content.text?.slice(0, 400) || ''}`,
    },
    rewrite: {
      system: `${toneDesc}${voiceNote}${audienceNote}

You rewrite source material into polished newsletter copy. Preserve all key facts. Cut everything else. Match the specified tone exactly. Improve clarity, momentum, and rhythm.

Rules:
- Shorter sentences > longer ones
- Active voice only
- Open with the strongest fact or claim, not background
- If the source has a number, keep it
- No filler phrases: "It is important to note," "In conclusion," "Moving forward"`,
      user: `Rewrite this for a newsletter:\n${customPrompt ? `Instructions: ${customPrompt}\n` : ''}\n${articleContext || content.text || content.summary}`,
    },
    summarize: {
      system: `You summarize content in exactly 3 concise sentences for newsletter readers. Sentence 1: the most important specific fact (bold the key number or claim). Sentence 2: the most important context or implication. Sentence 3: what to watch or do next. No padding, no hedging.`,
      user: `Summarize in 3 sentences:\n${articleContext}`,
    },
    hooks: {
      system: `${toneDesc}${audienceNote}

You write newsletter hooks — single punchy lines that make readers stop scrolling and want to read on. Each starts with →. No questions. Specific beats vague. Create intrigue by implying there's something most people don't know yet.`,
      user: `Write 4 hooks for this content:\n${articleContext}`,
    },
    cta: {
      system: `${toneDesc}${voiceNote}${audienceNote}

You write newsletter calls-to-action that convert. 2–3 sentences. Make it feel like a natural extension of the newsletter's voice — not a sales pitch bolted on at the end. Be specific about what the reader gets. One clear action.`,
      user: customPrompt
        ? `Write a CTA. Instructions: ${customPrompt}\nContext: ${articleContext}`
        : `Write a CTA encouraging newsletter readers to share this issue with a colleague or upgrade to a paid tier.`,
    },
    'briefing-prompt': {
      system: `You analyze newsletter briefing examples and write a concise instruction prompt (2-4 sentences max) that captures the style so an AI can reproduce it. Focus on: format pattern, what comes first (stat, emoji, context), tone, URL placement, line length, and any distinctive patterns. Return ONLY the prompt text — no explanation, no preamble, no quotes around it.`,
      user: `Analyze these briefing examples and write a prompt that would reproduce this exact style:\n\n${content.text || content.summary}`,
    },
    'brand-voice': {
      system: `You are an expert writing analyst and brand strategist. You analyze newsletter content to produce a detailed AI ghost-writer profile — specific enough that an AI can reproduce the author's voice with high fidelity.

Write a voice profile of 200-300 words structured as direct instructions to an AI writer. Cover ALL of the following:
- Overall tone and personality (e.g. "authoritative but not pompous, dry wit, never cheerful")
- Sentence rhythm and length patterns (e.g. "leads with short punchy sentences, expands in the middle, closes short")
- Vocabulary level and register (e.g. "professional but never academic, avoids jargon unless it's industry-standard")
- How they use data vs opinion (e.g. "always leads with a number, then editorialises")
- Opening pattern for each piece (e.g. "never wastes the first line, always a hard fact or provocative claim")
- Closing pattern (e.g. "ends with a forward-looking question or one-line kicker, no summary")
- What they NEVER do (e.g. "never uses passive voice, never writes 'it is worth noting', never uses exclamation marks")
- Signature phrases, transitions, or structural patterns
- What makes their voice unmistakably theirs

Quote actual short phrases or patterns from the samples to make the profile concrete. Write it as a style guide, not a critique.`,
      user: `Analyze these newsletter issues and write the AI voice profile:\n\n${content.text || content.summary}`,
    },
    'top-stories': (() => {
      const items = contents.length ? contents : [content];
      const articleList = items.map((a, i) =>
        `Article ${i + 1}:\nTitle: ${a.title || 'Untitled'}\nSource: ${a.source || ''}\nURL: ${a.url || ''}\nSummary: ${(a.summary || a.text || '').slice(0, 400)}`
      ).join('\n\n');
      return {
        system: `You write a "Today's Briefing" section for a newsletter. Format: one line per article, no bullet points.

Each line: [emoji] [stat or sharpest fact] [brief context] [source URL]

Rules:
- Pick one relevant emoji based on topic (📉📈🔴🤖💼🏥🔬🎭🏆🏠📅🌱🌍⚖️📺💰🗳️🏛️)
- Lead with the single hardest number, percentage, or dollar figure from the article. If no number exists, use the sharpest specific fact.
- Keep the whole line under 120 characters before the URL
- End each line with the article's source URL as plain text (not markdown)
- No intro, no explanation, no Sources line — just the lines

Examples:
📉 83% of school districts' reading scores declined since 2015 https://example.com/article
📈 $2.4B raised — Anthropic now valued at $18.4B https://example.com/article
🗳️ GOP projected to hold 214 seats after redistricting https://example.com/article`,
        user: `Generate a Today's Briefing block for these ${items.length} articles${customPrompt ? `. Additional instructions: ${customPrompt}` : ''}:\n\n${articleList}`,
      };
    })(),
  };

  const p = prompts[action] || prompts.rewrite;

  // Allow more tokens for long-form pieces; quick hits need far less
  const maxTokens = action === 'brand-voice' ? 3000 : ['lead-story', 'rewrite'].includes(action) ? 2000 : 1200;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: p.system,
      messages: [{ role: 'user', content: p.user }],
    });
    return res.json({ result: message.content[0].text });
  } catch (e) {
    console.error('Anthropic error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── /api/publish/beehiiv ─────────────────────────────────────────────────────
app.post('/api/publish/beehiiv', async (req, res) => {
  const apiKey = process.env.BEEHIIV_API_KEY;
  const publicationId = process.env.BEEHIIV_PUBLICATION_ID;

  if (!apiKey || !publicationId) {
    return res.status(400).json({
      error: 'Add BEEHIIV_API_KEY and BEEHIIV_PUBLICATION_ID to your .env file.',
    });
  }

  const { newsletter } = req.body;
  if (!newsletter) return res.status(400).json({ error: 'newsletter payload required' });

  const html = buildBeehiivHTML(newsletter);

  try {
    const beehiivRes = await fetch(
      `https://api.beehiiv.com/v2/publications/${publicationId}/posts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: newsletter.title || 'Untitled Newsletter',
          subtitle: newsletter.previewText || '',
          body_content: html,
          status: 'draft',
          content_tags: [],
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    const data = await beehiivRes.json();

    if (!beehiivRes.ok) {
      const msg = data?.errors?.[0]?.message || data?.message || `Beehiiv ${beehiivRes.status}`;
      throw new Error(msg);
    }

    return res.json({
      success: true,
      postId: data.data?.id,
      webUrl: data.data?.web_url,
      previewUrl: data.data?.preview_url,
    });
  } catch (e) {
    console.error('Beehiiv error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Build table-based email HTML for Beehiiv
function buildBeehiivHTML(newsletter) {
  const leads = newsletter.sections?.leadStory ?? [];
  const hits  = newsletter.sections?.quickHits  ?? [];
  const ctas  = newsletter.sections?.cta        ?? [];

  const fmt = (text = '') =>
    String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#6366f1;text-decoration:underline">$1</a>')
      .replace(/^(\*\*The details:|Has this been done before\?|The difference:|Why it matters:|Real talk:\*\*)/gm, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');

  const sectionLabel = (label) =>
    `<tr><td style="padding:0 32px 8px"><div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.12em;color:#888;border-bottom:2px solid #e0e0e0;padding-bottom:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${label}</div></td></tr>`;

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${newsletter.title || 'Newsletter'}</title></head>
<body style="margin:0;padding:0;background-color:#f7f7f7;font-family:Georgia,'Times New Roman',serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f7f7">
<tr><td align="center" style="padding:24px 16px">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">

  <!-- Header -->
  <tr><td style="background-color:#f0f0f0;padding:28px 32px;text-align:center;border-bottom:2px solid #e0e0e0">
    <div style="font-size:22px;font-weight:800;letter-spacing:-0.02em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${newsletter.title || 'Newsletter'}</div>
    <div style="font-size:12px;color:#888;margin-top:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${date}</div>
    ${newsletter.subject ? `<div style="font-size:13px;color:#555;margin-top:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-style:italic">${newsletter.subject}</div>` : ''}
  </td></tr>

  <!-- Lead Story -->
  ${leads.length > 0 ? `
  <tr><td style="padding:28px 32px 8px">
    ${sectionLabel('Lead Story').replace(/<tr><td[^>]*>/, '').replace('</td></tr>', '')}
  </td></tr>
  ${leads.map(a => `<tr><td style="padding:0 32px 24px"><div style="font-size:16px;line-height:1.85;color:#1a1a1a">${fmt(a.content || a.summary || '')}</div></td></tr>`).join('<tr><td style="padding:0 32px"><hr style="border:none;border-top:1px solid #eee;margin:0 0 20px"></td></tr>')}
  ` : ''}

  <!-- Quick Hits -->
  ${hits.length > 0 ? `
  <tr><td style="padding:${leads.length ? '8' : '28'}px 32px 8px">
    ${sectionLabel('Quick Hits').replace(/<tr><td[^>]*>/, '').replace('</td></tr>', '')}
  </td></tr>
  ${hits.map(a => `<tr><td style="padding:0 32px 16px;border-bottom:1px solid #f0f0f0"><div style="font-size:15px;line-height:1.7;color:#1a1a1a">${fmt(a.content || a.summary || '')}</div></td></tr>`).join('')}
  ` : ''}

  <!-- CTA -->
  ${ctas.length > 0 ? `
  <tr><td style="padding:20px 32px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0f0ff;border:1px solid #d0d0f0;border-radius:8px">
    <tr><td style="padding:20px 24px">
      ${ctas.map(a => `<div style="font-size:15px;line-height:1.7;color:#2a2a4a">${fmt(a.content || a.summary || '')}</div>`).join('')}
    </td></tr>
    </table>
  </td></tr>
  ` : ''}

  <!-- Footer -->
  <tr><td style="background-color:#f7f7f7;padding:20px 32px;text-align:center;border-top:1px solid #e0e0e0">
    <p style="font-size:11px;color:#aaa;margin:0;line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      You're receiving this because you subscribed to <strong>${newsletter.title || 'this newsletter'}</strong>.<br>
      <a href="{{unsubscribe_url}}" style="color:#aaa;text-decoration:underline">Unsubscribe</a> &nbsp;·&nbsp;
      <a href="{{browser_url}}"    style="color:#aaa;text-decoration:underline">View in browser</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// Legal pages (standalone HTML, not the SPA)
app.get('/privacy', (_req, res) => res.sendFile(join(__dirname, 'public', 'privacy.html')));
app.get('/terms',   (_req, res) => res.sendFile(join(__dirname, 'public', 'terms.html')));

// Catch-all SPA route
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Curanta → http://localhost:${PORT}`);
  console.log(`  AI: ${process.env.ANTHROPIC_API_KEY ? '✓ Anthropic connected' : '○ Mock mode (no ANTHROPIC_API_KEY)'}`);
  console.log(`  Auth: ${process.env.SUPABASE_URL ? '✓ Supabase connected' : '○ Not configured (no SUPABASE_URL)'}\n`);
});
