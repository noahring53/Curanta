// Pure-function tests for the automation slice. No network, no DB.
// Run: node lib/automation/automation.test.mjs
import assert from 'node:assert/strict';
import { stripHouseStyle, hasStyleViolation } from './stripper.mjs';
import { normalizeTitle } from './normalize.mjs';
import { hashUrl, hashTitle } from './dedupe.mjs';
import { buildDigest } from './digest.mjs';
import { selectDraftPrompt, buildUserPrompt } from './prompts.mjs';
import * as eventPage from './handlers/event_page.mjs';
import { decodeEntities, mmss, extractBalancedJson, pickCaptionTrack, parseTimedText, formatTranscript } from './captions.mjs';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const atest = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

console.log('automation stripper:');

test('semicolon becomes a period and next word is capitalized', () => {
  assert.equal(stripHouseStyle('the vote passed; the mayor signed it'), 'the vote passed. The mayor signed it');
});

test('spaced em dash between clauses becomes a sentence break', () => {
  assert.equal(stripHouseStyle('it failed — nobody showed up'), 'it failed. Nobody showed up');
});

test('unspaced em dash becomes a comma', () => {
  assert.equal(stripHouseStyle('wait—there is more'), 'wait, there is more');
});

test('en dash is handled too', () => {
  assert.equal(stripHouseStyle('open 9 – 5 daily'), 'open 9. 5 daily'); // spaced → sentence break
  assert.equal(stripHouseStyle('score was 3–2'), 'score was 3, 2');     // unspaced → comma
});

test('em dashes and semicolons inside a verbatim quote are preserved', () => {
  const out = stripHouseStyle('She said "we won; it was close — barely" at the mic');
  assert.ok(out.includes('"we won; it was close — barely"'), out);
});

test('markdown link target is never touched', () => {
  const out = stripHouseStyle('Read more: [County Record](https://ex.com/a-b;c—d)');
  assert.ok(out.includes('(https://ex.com/a-b;c—d)'), out);
});

test('hasStyleViolation is false after stripping, true before', () => {
  const dirty = 'a — b; c';
  assert.equal(hasStyleViolation(dirty), true);
  assert.equal(hasStyleViolation(stripHouseStyle(dirty)), false);
});

test('plain digits in prose survive (sentinel is anchored, not bare digits)', () => {
  assert.equal(stripHouseStyle('the budget was 2500 dollars approved in 2026'), 'the budget was 2500 dollars approved in 2026');
  assert.equal(stripHouseStyle('3 items; 2 passed'), '3 items. 2 passed');
});

console.log('automation normalize + dedupe:');

test('normalizeTitle lowercases and strips punctuation', () => {
  assert.equal(normalizeTitle('  Council OKs $2.5M Plan! '), 'council oks 2 5m plan');
});

test('same story, cosmetic title differences → same title hash', () => {
  assert.equal(hashTitle('Council OKs Plan'), hashTitle('council oks plan!!!'));
});

test('tracking params do not change the url hash', () => {
  assert.equal(hashUrl('https://ex.com/story?utm_source=rss'), hashUrl('https://ex.com/story'));
});

test('different stories → different hashes', () => {
  assert.notEqual(hashUrl('https://ex.com/a'), hashUrl('https://ex.com/b'));
});

console.log('automation digest:');

test('buildDigest groups by market and reports the count', () => {
  const { subject, html } = buildDigest([
    { id: '1', market: 'Camden', source_name: 'County Record', title: 'A', url: 'https://x/a', body_markdown: '# A\n\nSummary.\n\nRead more: [County Record](https://x/a)', published_at: '2026-08-05T12:00:00Z' },
    { id: '2', market: 'Camden', source_name: 'County Record', title: 'B', url: 'https://x/b', body_markdown: '# B\n\nSummary two.', published_at: null },
  ]);
  assert.ok(subject.includes('2 new items'), subject);
  assert.ok(html.includes('Camden'), 'market heading present');
  assert.ok(html.includes('County Record'), 'source heading present');
  assert.ok(html.includes('href="https://x/a"'), 'markdown link rendered');
});

console.log('automation prompts (Slice 2):');

test('link_roundup prompt is unchanged (still the copyright-safe two-sentence rule)', () => {
  const { system, maxTokens } = selectDraftPrompt('link_roundup', { market: 'Camden' });
  assert.ok(system.includes('NO MORE THAN TWO'), 'two-sentence cap present');
  assert.ok(system.includes('THIRD-PARTY'), 'copyright framing present');
  assert.equal(maxTokens, 400);
});

test('full_article prompt grounds hard, bans fabricated quotes, and forbids em dashes', () => {
  const { system, maxTokens } = selectDraftPrompt('full_article', { market: 'Camden' });
  assert.ok(/Invent nothing/i.test(system));
  assert.ok(/verbatim/i.test(system), 'verbatim-quote rule present');
  assert.ok(/EDITOR NOTE/.test(system), 'gap-handling escape hatch present');
  assert.ok(/do not use em dashes or semicolons/i.test(system), 'punctuation rule present');
  assert.ok(system.includes('Camden Angle'), 'market angle present');
  assert.ok(maxTokens >= 1000, 'room to write a full piece');
});

test('short_blurb prompt is a few sentences, one link, angle first, no em dashes', () => {
  const { system, maxTokens } = selectDraftPrompt('short_blurb', { market: 'Camden' });
  assert.ok(/2 to 4/.test(system));
  assert.ok(/one inline hyperlink/i.test(system));
  assert.ok(/do not use em dashes or semicolons/i.test(system));
  assert.ok(maxTokens <= 400, 'kept short');
});

test('unknown draft_type still throws', () => {
  assert.throws(() => selectDraftPrompt('mystery', {}), /Unknown draft_type/);
});

test('buildUserPrompt gives full_article a large source cap, others stay small', () => {
  const big = 'x'.repeat(5000);
  const full = buildUserPrompt({ draft_type: 'full_article', title: 'T', url: 'u', raw_text_or_transcript: big });
  const round = buildUserPrompt({ draft_type: 'link_roundup', title: 'T', url: 'u', raw_text_or_transcript: big });
  assert.ok(full.includes('SOURCE TEXT'), 'full_article uses the source-text label');
  assert.ok(full.length > round.length, 'full_article carries more source than link_roundup');
  assert.ok(round.includes('UNTRUSTED DATA'), 'link_roundup user prompt unchanged');
});

console.log('automation event_page hash-diff (Slice 3):');

const evSrc = { id: 'e1', feed_url: 'https://ex.gov/events', title: 'Civic Calendar', market: 'Camden', draft_type: 'short_blurb' };
const fakeDeps = (text, title = 'Events') => ({ assertSafeUrl: async () => {}, fetchArticle: async () => ({ text, title, publishedAt: null }) });

await atest('unchanged page → identical dedupe_key (no change detected)', async () => {
  const [a] = await eventPage.fetchNew(evSrc, { deps: fakeDeps('Council meeting Aug 12 at 6pm. Budget hearing Aug 20.') });
  const [b] = await eventPage.fetchNew(evSrc, { deps: fakeDeps('Council meeting Aug 12 at 6pm. Budget hearing Aug 20.') });
  assert.ok(a.dedupe_key && a.dedupe_key === b.dedupe_key, 'same content must key identically');
});

await atest('changed page → different dedupe_key (change detected)', async () => {
  const [a] = await eventPage.fetchNew(evSrc, { deps: fakeDeps('Council meeting Aug 12 at 6pm.') });
  const [b] = await eventPage.fetchNew(evSrc, { deps: fakeDeps('Council meeting Aug 12 at 6pm. NEW: road closed Aug 15.') });
  assert.notEqual(a.dedupe_key, b.dedupe_key);
});

await atest('whitespace-only reflow is NOT a change', async () => {
  const [a] = await eventPage.fetchNew(evSrc, { deps: fakeDeps('Meeting  Aug 12') });
  const [b] = await eventPage.fetchNew(evSrc, { deps: fakeDeps('Meeting Aug 12\n\n  ') });
  assert.equal(a.dedupe_key, b.dedupe_key);
});

await atest('empty extraction emits nothing (no phantom change)', async () => {
  const items = await eventPage.fetchNew(evSrc, { deps: fakeDeps('') });
  assert.equal(items.length, 0);
});

await atest('event_page item carries the page url for the link and its draft_type', async () => {
  const [a] = await eventPage.fetchNew(evSrc, { deps: fakeDeps('Farmers market Saturday 9am.') });
  assert.equal(a.url, 'https://ex.gov/events');
  assert.equal(a.draft_type, 'short_blurb');
  assert.ok(a.raw_text_or_transcript.includes('Farmers market'));
});

console.log('automation captions (Slice 4):');

test('mmss formats minutes and hours', () => {
  assert.equal(mmss(75), '1:15');
  assert.equal(mmss(3725), '1:02:05');
});

test('decodeEntities handles named and numeric entities', () => {
  assert.equal(decodeEntities('Ben &amp; Jerry&#39;s &#x2014; open'), "Ben & Jerry's — open");
});

test('parseTimedText reads srv1 <text start dur> with timestamps', () => {
  const xml = '<transcript><text start="0.5" dur="2.1">The council voted</text><text start="3.0" dur="2.0">four to one</text></transcript>';
  const lines = parseTimedText(xml);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].t, 0.5);
  assert.equal(lines[1].txt, 'four to one');
});

test('parseTimedText falls back to srv3 <p t d> shape', () => {
  const xml = '<timedtext><body><p t="1200" d="900"><s>budget</s> <s>hearing</s></p></body></timedtext>';
  const lines = parseTimedText(xml);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].t, 1.2);
  assert.ok(lines[0].txt.includes('budget'));
});

test('parseTimedText returns null when there are no cues', () => {
  assert.equal(parseTimedText('<transcript></transcript>'), null);
});

test('formatTranscript prefixes [mm:ss] timestamps', () => {
  assert.equal(formatTranscript([{ t: 75, txt: 'motion carries' }]), '[1:15] motion carries');
});

test('extractBalancedJson pulls the player object despite nested braces', () => {
  const html = 'var x=1; ytInitialPlayerResponse = {"a":{"b":"}"},"c":2}; more';
  const obj = JSON.parse(extractBalancedJson(html, 'ytInitialPlayerResponse'));
  assert.equal(obj.c, 2);
  assert.equal(obj.a.b, '}');
});

test('pickCaptionTrack prefers a human English track over asr', () => {
  const pr = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { languageCode: 'en', kind: 'asr', baseUrl: 'ASR' },
    { languageCode: 'en', baseUrl: 'HUMAN' },
  ] } } };
  assert.equal(pickCaptionTrack(pr).baseUrl, 'HUMAN');
});

test('pickCaptionTrack falls back to asr when that is all there is', () => {
  const pr = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { languageCode: 'en', kind: 'asr', baseUrl: 'ASR' },
  ] } } };
  assert.equal(pickCaptionTrack(pr).baseUrl, 'ASR');
});

test('pickCaptionTrack returns null when a video has no captions', () => {
  assert.equal(pickCaptionTrack({}), null);
});

console.log('automation low-fidelity prompt (Slice 4):');

test('full_article WITH lowFidelity adds the caption-fidelity guardrails', () => {
  const { system } = selectDraftPrompt('full_article', { market: 'Camden', lowFidelity: true });
  assert.ok(/machine transcription/i.test(system));
  assert.ok(/Never put quotation marks around caption-derived text/i.test(system));
  assert.ok(/do not guess/i.test(system));
});

test('full_article WITHOUT lowFidelity does NOT mention captions (unchanged behavior)', () => {
  const { system } = selectDraftPrompt('full_article', { market: 'Camden' });
  assert.ok(!/machine transcription/i.test(system));
  assert.ok(/Invent nothing/i.test(system)); // still fully grounded
});

console.log(`\n${passed} passed`);
