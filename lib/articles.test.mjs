// Covers the cost-critical parts of the Articles pipeline: what reaches the
// model, how much of it, and how often the network is touched at all.
import {
  normalizeUrl, countWords, trimToWords, toSourcePayload, cleanByline,
  buildArticleMessages, getSourceArticle,
  cacheGet, cacheSet, cacheDelete, articleCacheStats, resolveMode,
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
