import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { load } from 'cheerio';
import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const rssParser = new Parser({
  timeout: 12000,
  headers: { 'User-Agent': 'LetterWriterAI/1.0 RSS Reader' },
});

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, 'public')));

// ── /api/config ───────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
    hasAI: !!process.env.ANTHROPIC_API_KEY,
  });
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
      'User-Agent': 'Mozilla/5.0 (compatible; LetterWriterAI/1.0)',
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
  };
}

// ── /api/ingest ───────────────────────────────────────────────────────────────
app.get('/api/ingest', async (req, res) => {
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
        // Best-effort: fetch full article text
        if (item.link) {
          try {
            const full = await fetchArticle(item.link);
            return { ...base, text: full.text, summary: base.summary || full.summary };
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

  return mocks[action] || mocks['rewrite'];
}

// ── /api/ai ───────────────────────────────────────────────────────────────────
app.post('/api/ai', async (req, res) => {
  const {
    action,
    content = {},
    contents = [],   // array of articles for multi-article actions
    tone = 'punchy-executive',
    prompt: customPrompt = '',
    brandVoice = '',
  } = req.body;

  if (!anthropic) {
    return res.json({ result: mockResponse(action, content, contents), mock: true });
  }

  const toneDesc = TONES[tone] || TONES['punchy-executive'];
  const voiceNote = brandVoice
    ? `\n\nBrand voice profile to match:\n${brandVoice}`
    : '';

  const articleContext = [
    content.title ? `Title: ${content.title}` : '',
    content.summary ? `Summary: ${content.summary}` : '',
    content.text ? `Full text:\n${content.text.slice(0, 3000)}` : '',
    content.url ? `URL: ${content.url}` : '',
    content.source ? `Source: ${content.source}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const prompts = {
    'lead-story': {
      system: `${toneDesc}${voiceNote}\n\nYou write newsletter lead stories. Always use this exact structure with these bold labels:\n[Opening paragraph — punchy, max 3 sentences]\n\n**The details:** [key facts]\n\n**Has this been done before?** [historical context]\n\n**The difference:** [what makes this unique]\n\n**Why it matters:** [significance for readers]\n\n**Real talk:** [honest unvarnished take]\n\n[Source: NAME](URL)\n\nTarget 320–400 words total.`,
      user: `Write a lead story for this article.\n${customPrompt ? `Additional instructions: ${customPrompt}\n` : ''}\n${articleContext}`,
    },
    'quick-hit': {
      system: `${toneDesc}${voiceNote}\n\nYou write 60-90 word newsletter blurbs. Bold the article title on first reference. Be punchy and informative. End with a → link if URL provided.`,
      user: `Write a Quick Hit blurb.\n${customPrompt ? `Additional instructions: ${customPrompt}\n` : ''}\n${articleContext}`,
    },
    'subject-line': {
      system: `You are a newsletter growth expert. You write subject lines with high open rates. Under 52 characters each. Create curiosity without clickbait. No emojis unless asked.`,
      user: `Generate 3 numbered email subject lines for this newsletter content:\n${articleContext || customPrompt}`,
    },
    'preview-text': {
      system: `You write email preview text (the snippet shown in inbox next to subject line). Under 90 characters. Complements the subject line. Drives the open.`,
      user: `Write preview text for:\nSubject: ${content.title || 'Newsletter'}\nContent: ${content.summary || content.text?.slice(0, 200) || customPrompt}`,
    },
    rewrite: {
      system: `${toneDesc}${voiceNote}\n\nYou rewrite content for newsletter audiences. Keep key facts. Improve voice, clarity, and momentum. Match the specified tone exactly.`,
      user: `Rewrite this for a newsletter:\n${customPrompt ? `Instructions: ${customPrompt}\n` : ''}\n${articleContext || content.text || content.summary}`,
    },
    summarize: {
      system: `You summarize content in exactly 3 concise sentences for newsletter readers. Bold the single most important fact. Be direct.`,
      user: `Summarize in 3 sentences:\n${articleContext}`,
    },
    hooks: {
      system: `${toneDesc}\n\nYou write newsletter hooks and teasers. Each is one punchy line that makes readers want to read on. Start each with →.`,
      user: `Write 4 hooks or teasers for this content:\n${articleContext}`,
    },
    cta: {
      system: `${toneDesc}${voiceNote}\n\nYou write newsletter calls-to-action. 2-3 sentences max. Drive upgrades, shares, or engagement. Specific and action-oriented.`,
      user: customPrompt || `Write a CTA for newsletter readers to upgrade to Pro or share with a colleague.`,
    },
    'brand-voice': {
      system: `You are a brand strategist and writing coach. Analyze newsletter writing samples and produce a concise brand voice profile (under 200 words). Describe: tone, sentence structure, vocabulary level, use of humor/data/opinion, and signature patterns.`,
      user: `Analyze these newsletter samples and create a brand voice profile:\n\n${content.text || content.summary}`,
    },
    'top-stories': (() => {
      const items = contents.length ? contents : [content];
      const articleList = items.map((a, i) =>
        `Article ${i + 1}:\nTitle: ${a.title || 'Untitled'}\nSource: ${a.source || ''}\nURL: ${a.url || ''}\nSummary: ${(a.summary || a.text || '').slice(0, 300)}`
      ).join('\n\n');
      return {
        system: `You write a "Today's Briefing" section for a newsletter. Format: one bullet per article using • symbol, each on its own line. Pick a single relevant emoji per bullet based on topic (politics 🔴, tech/AI 🤖, business 💼, finance 📈, health 🏥, science 🔬, culture 🎭, sports 🏆, real estate 🏠, history 📅, environment 🌱, world 🌍, law ⚖️, media 📺).

Each bullet must lead with the single most important number, percentage, dollar figure, or concrete data point from the article — if no hard number exists, use the sharpest specific fact. Pattern: "[Stat or fact] — [one-sentence context]". Examples: "67% of homeowners don't plan to move — highest reading since 2019." or "$2.4B raised — Anthropic's largest round yet, valuing the company at $18.4B." or "8.2M jobs added — beating forecasts by 340K for the third straight month."

Never lead with vague statements like "A new report shows" or "Officials announced". Always lead with the number or the sharpest fact. End with a Sources line listing each publication as a markdown link. No intro text, no explanation — just bullets and Sources line.`,
        user: `Generate a Today's Briefing block for these ${items.length} articles${customPrompt ? `. Additional instructions: ${customPrompt}` : ''}:\n\n${articleList}`,
      };
    })(),
  };

  const p = prompts[action] || prompts.rewrite;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
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

// Catch-all SPA route
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  LetterWriterAI → http://localhost:${PORT}`);
  console.log(`  AI: ${process.env.ANTHROPIC_API_KEY ? '✓ Anthropic connected' : '○ Mock mode (no ANTHROPIC_API_KEY)'}`);
  console.log(`  Auth: ${process.env.SUPABASE_URL ? '✓ Supabase connected' : '○ Not configured (no SUPABASE_URL)'}\n`);
});
