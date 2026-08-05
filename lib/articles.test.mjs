// Covers the cost-critical parts of the Articles pipeline: what reaches the
// model, how much of it, and how often the network is touched at all.
import {
  normalizeUrl, countWords, trimToWords, toSourcePayload, cleanByline,
  buildArticleMessages, getSourceArticle,
  cacheGet, cacheSet, cacheDelete, articleCacheStats, resolveMode,
  isRetryableStatus, parseRetryAfterMs, backoffDelayMs, withRetry, orderedUniqueUrls,
} from './articles.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

console.log('\nurl normalisation');
ok('strips utm parameters',
  normalizeUrl('https://apnews.com/article/x?utm_source=twitter&utm_medium=social') === 'https://apnews.com/article/x');
ok('keeps meaningful query params',
  normalizeUrl('https://site.com/story?id=44&utm_campaign=z') === 'https://site.com/story?id=44');
ok('strips fragment and www, lowercases host',
  normalizeUrl('https://WWW.Reuters.com/world/piece#section-2') === 'https://reuters.com/world/piece');
ok('drops a trailing slash but keeps a bare root',
  normalizeUrl('https://a.com/b/') === 'https://a.com/b' && normalizeUrl('https://a.com/') === 'https://a.com/');
ok('a non-URL passes through instead of throwing', normalizeUrl('not a url') === 'not a url');

console.log('\nword budget');
const para = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const doc = [para(400), para(400), para(400)].join('\n\n');
ok('counts words', countWords(para(120)) === 120);

const short = trimToWords(doc, 5000);
ok('leaves a short article untouched', short.trimmed === false && short.words === 1200);

const cut = trimToWords(doc, 850);
ok('trims to the budget', cut.words <= 850 && cut.trimmed === true, `got ${cut.words}`);
ok('drops whole paragraphs, never half of one',
  cut.text.split(/\n{2,}/).every(b => countWords(b) === 400), cut.text.split(/\n{2,}/).map(countWords).join(','));

const oneBlock = trimToWords(`${para(3000)}. ${para(3000)}.`, 100);
ok('a single giant block still gets cut', countWords(oneBlock.text) <= 100 && oneBlock.trimmed === true);

console.log('\nbyline cleanup');
ok('leaves a clean byline alone', cleanByline('Will Stone') === 'Will Stone');
ok('drops a glued dateline',
  cleanByline('August 3, 202610:05 AM ET Becky Sullivan') === 'Becky Sullivan',
  `got "${cleanByline('August 3, 202610:05 AM ET Becky Sullivan')}"`);
ok('drops a leading "By"', cleanByline('By Sarah Mendez') === 'Sarah Mendez');
ok('drops Updated/Published labels',
  cleanByline('Updated Jan 4, 2026 · Priya Raman') === 'Priya Raman',
  `got "${cleanByline('Updated Jan 4, 2026 · Priya Raman')}"`);
ok('an empty byline stays empty', cleanByline('') === '');

console.log('\nsource payload — only the five allowed fields (+ url) reach the model');
const scraped = {
  title: 'Council approves $12M bond',
  source: 'Belleville Gazette',
  byline: 'Sarah Mendez',
  publishedAt: '2026-05-14T11:04:00Z',
  url: 'https://gazette.com/bond',
  text: doc,
  wordCount: 1200,
  summary: 'a summary that must not be forwarded',
  images: ['https://gazette.com/a.jpg'],
  imageUrl: 'https://gazette.com/a.jpg',
  type: 'article',
  id: 'abc',
};
const payload = toSourcePayload(scraped, { maxWords: 900 });
ok('keeps the five fields', payload.title && payload.publication && payload.author && payload.publishedAt && payload.body);
ok('drops images/summary/ids', !('images' in payload) && !('summary' in payload) && !('id' in payload));
ok('applies the word budget', payload.wordCount <= 900 && payload.trimmed === true);
ok('records the untrimmed size', payload.sourceWordCount === 1200);

console.log('\nprompt assembly');
const msgs = buildArticleMessages({
  mode: 'news',
  masterPrompt: 'HOUSE STYLE: 700 words, no hype.',
  angle: 'What it means for small landlords',
  notes: 'Quote Ortiz if possible',
  source: payload,
});
ok('system carries the grounding rules', /UNTRUSTED DATA/.test(msgs.system) && /Invent nothing/.test(msgs.system));
ok('system does not repeat the master prompt', !msgs.system.includes('HOUSE STYLE'));
ok('order is master prompt → angle → notes → source',
  msgs.user.indexOf('HOUSE STYLE') < msgs.user.indexOf('ANGLE FOR THIS PIECE')
  && msgs.user.indexOf('ANGLE FOR THIS PIECE') < msgs.user.indexOf('ADDITIONAL NOTES')
  && msgs.user.indexOf('ADDITIONAL NOTES') < msgs.user.indexOf('SOURCE'));
ok('metadata is one line per field, not a JSON blob',
  msgs.user.includes('Publication: Belleville Gazette') && !msgs.user.includes('"publication"'));
ok('no HTML reaches the model', !/<\/?(div|p|span|script|nav)\b/i.test(msgs.user));

const bare = buildArticleMessages({ source: payload, angle: 'x' });
ok('omits empty sections entirely',
  !bare.user.includes('EDITOR\'S STANDING INSTRUCTIONS') && !bare.user.includes('ADDITIONAL NOTES'));
ok('unknown mode falls back to news', resolveMode('does-not-exist') === resolveMode('news'));

console.log('\ncache');
const CACHE_URL = 'https://gazette.com/cached-story';
cacheDelete(CACHE_URL);
cacheSet(CACHE_URL, { title: 'cached', body: 'x', wordCount: 1 });
ok('reads back what it stored', cacheGet(CACHE_URL).title === 'cached');
ok('tracking params hit the same entry',
  cacheGet(`${CACHE_URL}?utm_source=x`)?.title === 'cached');
ok('reports stats', articleCacheStats().max > 0);
cacheDelete(CACHE_URL);
ok('delete removes the entry', cacheGet(CACHE_URL) === null);

console.log('\ngetSourceArticle');
let fetches = 0;
const fakeFetch = async (url) => { fetches++; return { ...scraped, url }; };
const FRESH = 'https://gazette.com/fresh-story';
cacheDelete(FRESH);

const first = await getSourceArticle(FRESH, { fetchArticle: fakeFetch });
ok('first read scrapes', fetches === 1 && first.cached === false);

const second = await getSourceArticle(`${FRESH}?utm_medium=email`, { fetchArticle: fakeFetch });
ok('second read is a cache hit, even from a tracked link', fetches === 1 && second.cached === true);

await getSourceArticle(FRESH, { fetchArticle: fakeFetch, refresh: true });
ok('refresh forces a refetch', fetches === 2);

let thin = null;
try {
  await getSourceArticle('https://gazette.com/paywalled', {
    fetchArticle: async () => ({ ...scraped, url: 'https://gazette.com/paywalled', text: 'Subscribe to continue reading.' }),
  });
} catch (e) { thin = e; }
ok('a paywall/stub page fails cleanly instead of billing for fiction',
  thin !== null && thin.status === 422 && /paywalled|JavaScript/i.test(thin.message));

console.log('\nmulti-source prompt assembly (drag-and-drop ordering)');
const srcA = { title: 'A leads', publication: 'Wire A', url: 'https://a.com/x', body: 'Body A.' };
const srcB = { title: 'B second', publication: 'Wire B', url: 'https://b.com/y', body: 'Body B.' };
const multi = buildArticleMessages({ angle: 'the angle', sources: [srcA, srcB] });
ok('renders one numbered block per source',
  multi.user.includes('SOURCE 1 OF 2') && multi.user.includes('SOURCE 2 OF 2'));
ok('preserves the workspace order (A before B)',
  multi.user.indexOf('A leads') < multi.user.indexOf('B second'));
ok('tells the model the first source leads',
  /priority order|SOURCE 1 leads/i.test(multi.user));
ok('includes every source body',
  multi.user.includes('Body A.') && multi.user.includes('Body B.'));
const single = buildArticleMessages({ angle: 'x', sources: [srcA] });
ok('a single source uses the bare SOURCE label, no numbering',
  single.user.includes('SOURCE\n') && !single.user.includes('SOURCE 1 OF'));
ok('back-compat: legacy single `source` still works',
  buildArticleMessages({ angle: 'x', source: srcA }).user.includes('Body A.'));

console.log('\nrequest URL dedup + ordering (one click = one bounded job)');
ok('preserves display order', JSON.stringify(orderedUniqueUrls(['https://a/1', 'https://b/2', 'https://c/3']))
  === JSON.stringify(['https://a/1', 'https://b/2', 'https://c/3']));
ok('dedupes while keeping first-seen order',
  JSON.stringify(orderedUniqueUrls(['https://a/1', 'https://b/2', 'https://a/1']))
  === JSON.stringify(['https://a/1', 'https://b/2']));
ok('trims blanks and whitespace-only entries',
  JSON.stringify(orderedUniqueUrls([' https://a/1 ', '', '   '])) === JSON.stringify(['https://a/1']));
ok('falls back to the legacy single url', JSON.stringify(orderedUniqueUrls(null, 'https://only/1')) === JSON.stringify(['https://only/1']));
ok('caps the fan-out', orderedUniqueUrls(Array.from({ length: 20 }, (_, i) => `https://x/${i}`)).length === 8);
ok('empty input yields empty (route then 400s)', orderedUniqueUrls([], '').length === 0);

console.log('\nretry classification — transient vs permanent');
ok('429 is retryable', isRetryableStatus(429));
ok('503 is retryable', isRetryableStatus(503));
ok('529 (overloaded) is retryable', isRetryableStatus(529));
ok('500/502/504 are retryable', [500, 502, 504].every(isRetryableStatus));
ok('401 auth is NOT retryable', !isRetryableStatus(401));
ok('403 auth is NOT retryable', !isRetryableStatus(403));
ok('400 validation is NOT retryable', !isRetryableStatus(400));
ok('404 is NOT retryable', !isRetryableStatus(404));

console.log('\nRetry-After parsing');
ok('reads a seconds value', parseRetryAfterMs('2') === 2000);
ok('reads an HTTP date', parseRetryAfterMs(new Date(Date.now() + 3000).toUTCString()) >= 2000);
ok('a missing header yields null (fall back to backoff)', parseRetryAfterMs(null) === null);
ok('garbage yields null', parseRetryAfterMs('soon') === null);
ok('clamps absurd values to 60s', parseRetryAfterMs('99999') === 60000);

console.log('\nbackoff — bounded, jittered, honors Retry-After');
ok('full jitter stays within [0, ceiling]', (() => {
  for (let a = 0; a < 5; a++) {
    const hi = backoffDelayMs(a, { baseMs: 500, capMs: 8000, rand: () => 1 });
    const lo = backoffDelayMs(a, { baseMs: 500, capMs: 8000, rand: () => 0 });
    if (lo !== 0 || hi > 8000) return false;
  }
  return true;
})());
ok('grows with the attempt number', backoffDelayMs(0, { rand: () => 1 }) < backoffDelayMs(3, { rand: () => 1 }));
ok('never exceeds the cap', backoffDelayMs(20, { capMs: 8000, rand: () => 1 }) === 8000);
ok('Retry-After overrides computed backoff', backoffDelayMs(0, { retryAfterMs: 1500, rand: () => 1 }) === 1500);

console.log('\nwithRetry — bounded attempts, no retry on permanent errors');
{
  let calls = 0;
  const res = await withRetry(async () => { calls++; if (calls < 3) { const e = new Error('busy'); e.status = 429; throw e; } return 'ok'; },
    { attempts: 5, sleep: async () => {} });
  ok('retries a transient 429 then succeeds', res === 'ok' && calls === 3, `calls=${calls}`);
}
{
  let calls = 0;
  let caught = null;
  try {
    await withRetry(async () => { calls++; const e = new Error('nope'); e.status = 401; throw e; }, { attempts: 5, sleep: async () => {} });
  } catch (e) { caught = e; }
  ok('does NOT retry a 401 — fails immediately', caught && calls === 1, `calls=${calls}`);
}
{
  let calls = 0;
  let caught = null;
  try {
    await withRetry(async () => { calls++; const e = new Error('busy'); e.status = 503; throw e; }, { attempts: 3, sleep: async () => {} });
  } catch (e) { caught = e; }
  ok('gives up after the attempt cap and rethrows', caught?.status === 503 && calls === 3, `calls=${calls}`);
}
{
  let calls = 0;
  const res = await withRetry(async () => { calls++; if (calls < 2) { const e = new Error('mid'); e.status = 500; throw e; } return 'done'; },
    { attempts: 3, shouldRetry: () => false, sleep: async () => {} }).catch(e => e);
  ok('shouldRetry:false refuses the retry (mid-stream guard)', res instanceof Error && calls === 1);
}

console.log('\nmid-stream error carries a status (so the client can classify it)');
// Mirrors the SSE error frame the generate route writes on a mid-stream failure.
function streamErrorFrame(err) {
  return { error: err.message, status: err.status || err.statusCode || 500 };
}
{
  const e = new Error('overloaded'); e.status = 529;
  const frame = streamErrorFrame(e);
  ok('a mid-stream 529 frame keeps its status', frame.status === 529 && isRetryableStatus(frame.status));
}
{
  const frame = streamErrorFrame(new Error('boom'));
  ok('an unclassified mid-stream error defaults to 500 (retryable, surfaced)', frame.status === 500 && isRetryableStatus(500));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
