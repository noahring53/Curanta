// Verifies structured article extraction against messy real-world-shaped HTML.
import { load } from 'cheerio';
import { extractStructuredArticle } from './extract.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

const HTML = `<!doctype html><html><head>
<title>Council approves $12M bond | Belleville Gazette</title>
<meta property="article:published_time" content="2026-05-14T11:04:00Z">
<meta name="author" content="Sarah Mendez">
</head><body>
<nav><a href="/">Home</a><a href="/sports">Sports</a></nav>
<div class="cookie-banner">We use cookies. Accept all?</div>
<header class="site-header">Belleville Gazette</header>
<article>
  <h1>Council approves $12M bond for South Walnut reconstruction</h1>
  <div class="byline">By Sarah Mendez</div>
  <div class="ad">Advertisement</div>
  <p>The council voted 4-1 Tuesday to approve a $12 million bond for the reconstruction of South Walnut Street, ending two years of debate over drainage and bike lanes.</p>
  <p>Work is scheduled to begin in July and finish by late 2027, according to city engineer Raul Ortiz.</p>
  <h2>What the vote means</h2>
  <blockquote>This corridor has flooded every spring since I was a kid. Tonight we fixed it.</blockquote>
  <p>Council member Dana Whitfield cast the lone dissenting vote, citing the debt service schedule.</p>
  <ul><li>Drainage replacement along 1.2 miles</li><li>Protected bike lanes on both sides</li><li>New signals at Cedar and Main</li></ul>
  <figure><img src="/photos/hall.jpg" width="800" height="500"><figcaption>Belleville City Hall, where the vote was held Tuesday night.</figcaption></figure>
  <p>Sign up for our newsletter</p>
  <p>Read more</p>
  <div class="related"><h3>Related stories</h3><p>Council delays vote on park funding</p></div>
  <table><tr><th>Item</th><th>Cost</th></tr><tr><td>Drainage</td><td>$7.1M</td></tr></table>
</article>
<div class="taboola">You may also like</div>
<footer>Copyright 2026 Belleville Gazette. All rights reserved.</footer>
</body></html>`;

const r = extractStructuredArticle(load(HTML), 'https://gazette.com/bond');

console.log('\n--- extracted markdown ---');
console.log(r.markdown);
console.log('--- end ---\n');

console.log('structure');
ok('detects structure', r.structured === true);
ok('keeps headings', r.markdown.includes('# What the vote means'));
ok('keeps body prose', r.markdown.includes('voted 4-1 Tuesday'));
ok('marks blockquote with >', /^> This corridor has flooded/m.test(r.markdown));
ok('keeps list items as list', r.markdown.includes('- Protected bike lanes on both sides'));
ok('keeps caption, typed', r.markdown.includes('[caption] Belleville City Hall'));
ok('keeps table row', r.markdown.includes('| Drainage | $7.1M |'));
ok('table rows stay on separate lines', /\| Item \| Cost \|\n\| Drainage \| \$7\.1M \|/.test(r.markdown));

console.log('\njunk removal');
ok('drops nav', !r.markdown.includes('Sports'));
ok('drops cookie banner', !/We use cookies/i.test(r.markdown));
ok('drops advertisement block', !/^Advertisement$/im.test(r.markdown));
ok('drops "Sign up for our newsletter"', !/Sign up for our newsletter/i.test(r.markdown));
ok('drops "Read more"', !/^Read more$/im.test(r.markdown));
ok('drops related stories', !/Council delays vote on park funding/.test(r.markdown));
ok('drops taboola', !/You may also like/i.test(r.markdown));
ok('drops footer copyright', !/All rights reserved/i.test(r.markdown));
ok('drops standalone byline from body', !/^By Sarah Mendez$/im.test(r.markdown));

console.log('\nmetadata');
ok('captures byline separately', r.byline === 'Sarah Mendez', `got "${r.byline}"`);
ok('captures publishedAt', r.publishedAt === '2026-05-14T11:04:00Z');
ok('counts words', r.wordCount > 40, `got ${r.wordCount}`);
ok('reports block counts', r.counts.para >= 3 && r.counts.quote === 1);

console.log('\nno-date page → null (never "now")');
const undated = extractStructuredArticle(load('<html><body><article><p>' + 'x '.repeat(200) + '</p></article></body></html>'), 'https://e.com/a');
ok('publishedAt null when absent', undated.publishedAt === null, `got ${undated.publishedAt}`);

console.log('\ndeduplication');
const dupe = extractStructuredArticle(load(
  '<html><body><article>' +
  '<p>The council voted four to one on Tuesday evening in a packed chamber.</p>'.repeat(3) +
  '<p>A genuinely different sentence about the drainage project timeline.</p>' +
  '</article></body></html>'), 'https://e.com/b');
ok('repeated identical paragraphs collapse to one',
  (dupe.markdown.match(/packed chamber/g) || []).length === 1,
  `got ${(dupe.markdown.match(/packed chamber/g) || []).length}`);

console.log('\nfallbacks');
const bare = extractStructuredArticle(load('<html><body><p>' + 'Only loose text here. '.repeat(30) + '</p></body></html>'), 'https://e.com/c');
ok('bare body still extracts', bare.markdown.length > 100);
const empty = extractStructuredArticle(load('<html><body></body></html>'), 'https://e.com/d');
ok('empty page does not throw', empty.markdown === '' && empty.wordCount === 0);

console.log('\nlimit');
const long = extractStructuredArticle(
  load('<html><body><article>' + '<p>Sentence number filler here.</p>'.repeat(500) + '</article></body></html>'),
  'https://e.com/e', { limit: 500 });
ok('respects char limit', long.markdown.length <= 520, `got ${long.markdown.length}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
