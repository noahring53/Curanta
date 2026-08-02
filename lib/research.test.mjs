// Exercises lib/research.mjs against a stubbed model — no API key needed.
import {
  runResearch, factCheck, buildWriterDossier, buildBriefDossier,
  parseJsonLoose, researchCacheStats, clearResearchCache,
  assessComplexity, reviewDraft, critiqueDraft, reviseDraft,
} from './research.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// ── parseJsonLoose ───────────────────────────────────────────────────────────
console.log('\nparseJsonLoose');
ok('plain json', parseJsonLoose('{"a":1}')?.a === 1);
ok('fenced json', parseJsonLoose('```json\n{"a":2}\n```')?.a === 2);
ok('prose-wrapped', parseJsonLoose('Here you go:\n{"a":3}\nHope that helps')?.a === 3);
ok('array', Array.isArray(parseJsonLoose('[{"x":1}]')));
ok('brace inside string', parseJsonLoose('{"a":"has } brace","b":4}')?.b === 4);
ok('garbage → null', parseJsonLoose('no json here') === null);
ok('empty → null', parseJsonLoose('') === null);

// ── Stub model ───────────────────────────────────────────────────────────────
const calls = [];
function makeCreate(overrides = {}) {
  return async (params) => {
    calls.push(params);
    const sys = params.system || '';
    let text;
    if (sys.includes('newsroom researcher')) {
      const body = params.messages[0].content;
      const headline = (body.match(/Headline: (.*)/) || [])[1] || '';
      text = JSON.stringify({
        thesis: `thesis for ${headline}`,
        newsworthiness: 'matters because reasons',
        facts: [{ claim: `${headline} happened`, figures: '$12M', attribution: 'City Hall' }],
        quotes: [{ speaker: 'Jane Doe', role: 'Mayor', text: 'We voted yes.' }],
        entities: { people: [{ name: 'Jane Doe', role: 'Mayor' }], orgs: ['Council'], places: ['Belleville'], dates: [{ date: '2026-05-14', 'what happened': 'vote' }], numbers: [{ value: '4-1', means: 'vote tally' }] },
        assumedContext: ['readers know the corridor'],
        uncertainty: [], opinion: [], unanswered: ['who pays'],
        bodyQuality: 'full',
      });
    } else if (sys.includes('reconciling multiple reports')) {
      text = '```json\n' + JSON.stringify({
        sameStory: true, storyInOneLine: 'council approved bond',
        timeline: [], agreements: [], disagreements: [], uniqueReporting: [],
        duplicated: [], causeEffect: [], themes: ['infrastructure'],
        missingContext: [], strongestQuotes: [],
        leadCandidate: 'the 4-1 vote', doNotClaim: ['that it is final'],
      }) + '\n```';
    } else if (sys.includes('assignment brief')) {
      text = 'LEDE: the 4-1 vote\nBEATS: 1. vote\nQUOTES: none\nCONFLICTS: none\nOMIT: nothing\nCLOSE: July start';
    } else if (sys.includes('fact-checker')) {
      text = JSON.stringify(overrides.factcheck ?? {
        issues: [{ quote: 'x', problem: 'drifted', detail: 'd', fix: 'f' }],
        correctedDraft: overrides.corrected ?? 'Corrected draft with [a](https://e.com) link.',
      });
    } else {
      text = 'unexpected prompt';
    }
    return { content: [{ text }] };
  };
}

const articles = [
  { title: 'Council approves bond', source: 'Gazette', url: 'https://g.com/1', text: 'x'.repeat(900) },
  { title: 'Bond passes 4-1', source: 'Scoop', url: 'https://s.com/2', text: 'y'.repeat(900) },
];

// ── runResearch ──────────────────────────────────────────────────────────────
console.log('\nrunResearch');
clearResearchCache();
calls.length = 0;
const phases = [];
const research = await runResearch(articles, {
  create: makeCreate(), model: 'stub',
  onProgress: p => phases.push(p.phase),
});
ok('returns research', !!research);
ok('one note per source', research.notes.length === 2);
ok('notes carry outlet/url', research.notes[0].outlet === 'Gazette' && research.notes[0].url === 'https://g.com/1');
ok('cross-ref parsed from fences', research.crossRef?.sameStory === true);
ok('outline built', research.outline.startsWith('LEDE:'));
ok('progress emitted for all phases',
  ['reading', 'cross-referencing', 'outlining'].every(p => phases.includes(p)), phases.join(','));
ok('call count = 2 extract + 1 crossref + 1 outline', calls.length === 4, `got ${calls.length}`);
ok('extraction is deterministic (temp 0)', calls[0].temperature === 0);

// ── Caching ──────────────────────────────────────────────────────────────────
console.log('\ncaching');
calls.length = 0;
const again = await runResearch(articles, { create: makeCreate(), model: 'stub' });
ok('re-run skips extraction (cache hit)', calls.length === 2, `got ${calls.length} calls`);
ok('notes flagged as cached', again.notes.every(n => n._cached));
ok('cache reports size', researchCacheStats().size === 2);

const mutated = [{ ...articles[0], text: 'CHANGED'.repeat(200) }, articles[1]];
calls.length = 0;
await runResearch(mutated, { create: makeCreate(), model: 'stub' });
ok('changed body invalidates its cache entry', calls.length === 3, `got ${calls.length}`);

// ── withOutline=false (short-form path) ──────────────────────────────────────
console.log('\nshort-form path');
clearResearchCache();
calls.length = 0;
const brief = await runResearch(articles, { create: makeCreate(), model: 'stub', withOutline: false });
ok('no outline call', !brief.outline);
ok('still extracts + cross-refs', calls.length === 3, `got ${calls.length}`);

// ── maxSources cap ───────────────────────────────────────────────────────────
clearResearchCache();
const many = Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, source: 'S', url: `https://x.com/${i}`, text: 'z'.repeat(500) }));
const capped = await runResearch(many, { create: makeCreate(), model: 'stub', maxSources: 3, withOutline: false });
ok('maxSources caps fan-out', capped.notes.length === 3, `got ${capped.notes.length}`);

// ── Failure isolation ────────────────────────────────────────────────────────
console.log('\nfailure handling');
clearResearchCache();
const boom = await runResearch(articles, {
  create: async () => { throw new Error('api down'); }, model: 'stub',
});
ok('model failure → null (caller falls back)', boom === null);

clearResearchCache();
const badJson = await runResearch(articles, {
  create: async () => ({ content: [{ text: 'not json at all' }] }), model: 'stub', withOutline: false,
});
ok('unparseable extraction degrades to stub note', badJson?.notes?.[0]?._parseFailed === true);
ok('stub note keeps headline', badJson?.notes?.[0]?.headline === 'Council approves bond');

// ── Dossier building ─────────────────────────────────────────────────────────
console.log('\ndossiers');
const wd = buildWriterDossier(research);
ok('writer dossier has facts', wd.includes('Council approves bond happened'));
ok('writer dossier has verbatim quote', wd.includes('We voted yes.'));
ok('writer dossier has figures', wd.includes('$12M'));
ok('writer dossier includes outline', wd.includes('LEDE: the 4-1 vote'));
ok('writer dossier includes doNotClaim', wd.includes('doNotClaim'));
ok('writer dossier states research is complete', /do not caveat/i.test(wd));
const bd = buildBriefDossier(research);
ok('brief dossier has facts + url', bd.includes('$12M') && bd.includes('https://g.com/1'));
ok('brief dossier omits assignment brief', !bd.includes('LEDE:'));

// ── factCheck guards ─────────────────────────────────────────────────────────
console.log('\nfactCheck guards');
const draft = 'Original draft sentence with [a](https://e.com) link and more text to be long enough.';

const applied = await factCheck(draft, research, { create: makeCreate({ corrected: 'Corrected draft sentence with [a](https://e.com) link and more text here.' }), model: 'stub' });
ok('applies a valid correction', applied.applied && applied.draft.startsWith('Corrected'));
ok('reports issues', applied.issues.length === 1);

const dropped = await factCheck(draft, research, { create: makeCreate({ corrected: 'Corrected draft with no link at all but still reasonably long text.' }), model: 'stub' });
ok('rejects correction that drops a link', dropped.applied === false && dropped.draft === draft);

const gutted = await factCheck(draft, research, { create: makeCreate({ corrected: '[a](https://e.com)' }), model: 'stub' });
ok('rejects correction that guts the draft', gutted.applied === false && gutted.draft === draft);

const nojson = await factCheck(draft, research, { create: async () => ({ content: [{ text: 'sorry' }] }), model: 'stub' });
ok('unparseable factcheck → draft untouched', nojson.draft === draft && nojson.applied === false);

const clean = await factCheck(draft, research, { create: makeCreate({ factcheck: { issues: [], correctedDraft: draft } }), model: 'stub' });
ok('no issues → applied false, draft identical', clean.applied === false && clean.draft === draft);

// ── assessComplexity (deterministic, no model call) ──────────────────────────
console.log('\nassessComplexity');
const noteWith = (o = {}) => ({
  facts: [], quotes: [], uncertainty: [], opinion: [], bodyQuality: 'full',
  entities: { dates: [], numbers: [] }, ...o,
});
ok('single clean source → low', assessComplexity([noteWith()], null).tier === 'low');
ok('two sources, no conflict → low',
  assessComplexity([noteWith(), noteWith()], { disagreements: [] }).tier === 'low');
ok('four sources → medium',
  assessComplexity([noteWith(), noteWith(), noteWith(), noteWith()], { disagreements: [] }).tier === 'medium');
const conflicted = assessComplexity(
  [noteWith(), noteWith(), noteWith(), noteWith()],
  { disagreements: [{ point: 'a' }, { point: 'b' }] });
ok('many sources + disagreements → high', conflicted.tier === 'high', `got ${conflicted.tier}`);
ok('reports disagreement signal', conflicted.signals.some(s => /disagreement/.test(s)));
const timeline = assessComplexity([
  noteWith({ entities: { dates: [{ date: '1' }, { date: '2' }], numbers: [] } }),
  noteWith({ entities: { dates: [{ date: '3' }, { date: '4' }], numbers: [] } }),
], { disagreements: [] });
ok('complex timeline raises tier', timeline.tier !== 'low', `got ${timeline.tier}`);
ok('uncertainty counted',
  assessComplexity([noteWith({ uncertainty: ['a', 'b', 'c'] }), noteWith()], null).signals.some(s => /hedged/.test(s)));
ok('all-thin sources damp the score',
  assessComplexity([noteWith({ bodyQuality: 'headline-only' }), noteWith({ bodyQuality: 'thin' })], null)
    .signals.some(s => /thin/.test(s)));
ok('empty input does not throw', assessComplexity([], null).tier === 'low');

// ── Stub covering the new passes ─────────────────────────────────────────────
const REVISED_OK = 'REVISED lede leading on the vote. ' +
  'Filler that makes the draft long enough to be realistic. '.repeat(6) + '[a](https://e.com)';
const calls2 = [];
function makeCreate2(opts = {}) {
  return async (params) => {
    calls2.push(params);
    const sys = params.system || '';
    let text;
    if (sys.includes('newsroom researcher')) {
      text = JSON.stringify({
        thesis: 't', newsworthiness: 'n',
        facts: [{ claim: 'the vote was 4-1', figures: '4-1', attribution: 'City Hall', basis: 'document', strength: 'strong' },
                { claim: 'a rumour circulated', figures: '', attribution: '', basis: 'anonymous-source', strength: 'weak' }],
        quotes: [{ speaker: 'Jane Doe', role: 'Mayor', text: 'We voted yes.' }],
        entities: { people: [], orgs: [], places: [], dates: [{ date: 'd1' }, { date: 'd2' }], numbers: [] },
        assumedContext: [], uncertainty: ['x', 'y', 'z'], opinion: [], unanswered: [],
        bodyQuality: 'full',
      });
    } else if (sys.includes('reconciling multiple reports')) {
      text = JSON.stringify({
        sameStory: true, disagreements: [{ point: 'cost' }, { point: 'date' }],
        agreements: [], uniqueReporting: [], duplicated: [], causeEffect: [],
        themes: [], missingContext: [], strongestQuotes: [], timeline: [],
        leadCandidate: 'the vote', doNotClaim: [],
      });
    } else if (sys.includes('knowledge graph')) {
      text = JSON.stringify({
        entities: [{ id: 'e1', canonical: 'Jane Doe', type: 'person', aliases: ['the mayor'], role: 'cast deciding vote', sources: [1] }],
        relations: [{ from: 'e1', type: 'voted-for', to: 'e2', basis: 'source 1', confidence: 'high' }],
        timeline: [], keyNumbers: [],
      });
    } else if (sys.includes('morning news meeting')) {
      text = JSON.stringify({
        whatIsNew: [{ development: 'the vote', whyNew: 'first time', sources: [1], significance: 'high' }],
        whatIsEcho: ['background everyone has'],
        leadOptions: [], recommendedLead: { angle: 'the 4-1 vote', why: 'concrete' },
        claimAudit: [{ claim: 'a rumour circulated', verdict: 'too-weak-to-use', reason: 'single anonymous source' }],
        readerStakes: 'taxes', necessaryContext: [], openQuestions: [], omit: ['the rumour'],
        toneCaution: 'none',
      });
    } else if (sys.includes('assignment brief')) {
      text = 'LEDE: the 4-1 vote\nBEATS: 1. vote\nQUOTES: Jane Doe\nCONFLICTS: cost\nOMIT: rumour\nCLOSE: July';
    } else if (sys.includes('demanding senior editor')) {
      text = JSON.stringify(opts.critique ?? {
        verdict: 'needs-work',
        leadAssessment: { working: false, problem: 'buried', fix: 'lead on the vote' },
        issues: [{ quote: 'Some sentence.', type: 'weak-lead', problem: 'p', fix: 'f' }],
        missedOpportunities: [], strengths: ['the close'],
      });
    } else if (sys.includes('revising your own draft')) {
      // Must be length-comparable to the draft or the guards (correctly)
      // reject it as gutted, which would end the loop before fact-check.
      text = opts.revised ?? REVISED_OK;
    } else if (sys.includes('fact-checker')) {
      text = JSON.stringify({ issues: [], correctedDraft: opts.checked ?? REVISED_OK });
    } else {
      text = 'draft';
    }
    return { content: [{ text }] };
  };
}

const arts = [
  { title: 'A', source: 'S1', url: 'https://a.com', text: 'a'.repeat(900) },
  { title: 'B', source: 'S2', url: 'https://b.com', text: 'b'.repeat(900) },
  { title: 'C', source: 'S3', url: 'https://c.com', text: 'c'.repeat(900) },
  { title: 'D', source: 'S4', url: 'https://d.com', text: 'd'.repeat(900) },
];

// ── Adaptive depth ───────────────────────────────────────────────────────────
console.log('\nadaptive depth');
clearResearchCache(); calls2.length = 0;
const deep = await runResearch(arts, { create: makeCreate2(), model: 'stub' });
const kinds = calls2.map(c => c.system.includes('newsroom researcher') ? 'EXTRACT'
  : c.system.includes('reconciling') ? 'CROSSREF'
  : c.system.includes('knowledge graph') ? 'ENTITIES'
  : c.system.includes('morning news meeting') ? 'JUDGMENT'
  : c.system.includes('assignment brief') ? 'OUTLINE' : '?');
ok('high complexity runs entity resolution', kinds.includes('ENTITIES'), kinds.join(','));
ok('high complexity runs editorial judgment', kinds.includes('JUDGMENT'));
ok('judgment runs after cross-ref', kinds.indexOf('JUDGMENT') > kinds.indexOf('CROSSREF'));
ok('outline runs last', kinds[kinds.length - 1] === 'OUTLINE');
ok('complexity attached to result', deep.complexity?.tier === 'high', `got ${deep.complexity?.tier}`);
ok('entities returned', !!deep.entities);
ok('judgment returned', !!deep.judgment);

clearResearchCache(); calls2.length = 0;
const simpleCreate = async (params) => {
  const sys = params.system || '';
  if (sys.includes('newsroom researcher')) {
    return { content: [{ text: JSON.stringify({
      thesis: 't', newsworthiness: 'n', facts: [], quotes: [],
      entities: { people: [], orgs: [], places: [], dates: [], numbers: [] },
      assumedContext: [], uncertainty: [], opinion: [], unanswered: [], bodyQuality: 'full',
    }) }] };
  }
  return { content: [{ text: 'LEDE: x\nBEATS: 1' }] };
};
const simple = await runResearch([arts[0]], { create: simpleCreate, model: 'stub' });
ok('single simple source → low tier', simple.complexity.tier === 'low');
ok('low tier skips entity resolution', !simple.entities);
ok('low tier skips judgment pass', !simple.judgment);
ok('low tier still produces an outline', !!simple.outline);

// ── Writer dossier carries the new reasoning ─────────────────────────────────
console.log('\ndossier propagation');
const wd2 = buildWriterDossier(deep);
ok('dossier includes knowledge graph', wd2.includes('KNOWLEDGE GRAPH'));
ok('dossier includes editorial judgment', wd2.includes('EDITORIAL JUDGMENT'));
ok('dossier carries evidence grades', wd2.includes('[strong · document]'));
ok('dossier carries weak grade too', wd2.includes('[weak · anonymous-source]'));
ok('dossier warns about too-weak claims', /too-weak-to-use/.test(wd2));
ok('dossier instructs lead-on-new', /genuinely NEW/.test(wd2));

// ── Review loop ──────────────────────────────────────────────────────────────
console.log('\nreview loop');
const longDraft = 'Some sentence. ' + 'Filler that makes the draft long enough to be realistic. '.repeat(6) + '[a](https://e.com)';

calls2.length = 0;
const reviewed = await reviewDraft(longDraft, deep, { create: makeCreate2(), model: 'stub', maxRounds: 1 });
const rKinds = calls2.map(c => c.system.includes('demanding senior editor') ? 'CRITIQUE'
  : c.system.includes('revising your own draft') ? 'REVISE'
  : c.system.includes('fact-checker') ? 'FACTCHECK' : '?');
ok('runs critique → revise → factcheck', rKinds.join(',') === 'CRITIQUE,REVISE,FACTCHECK', rKinds.join(','));
ok('draft changed', reviewed.changed);
ok('logs the round', reviewed.log[0].verdict === 'needs-work' && reviewed.log[0].issues === 1);

calls2.length = 0;
const cleanReview = await reviewDraft(longDraft, deep, {
  create: makeCreate2({ critique: { verdict: 'ready', issues: [], strengths: [], missedOpportunities: [], leadAssessment: { working: true } } }),
  model: 'stub', maxRounds: 2,
});
ok('clean draft stops after one critique', calls2.length === 1, `made ${calls2.length} calls`);
ok('clean draft unchanged', !cleanReview.changed && cleanReview.draft === longDraft);

calls2.length = 0;
await reviewDraft(longDraft, deep, {
  create: makeCreate2({ critique: {
    verdict: 'structural-problem',
    leadAssessment: { working: false, problem: 'p', fix: 'f' },
    issues: [{ quote: 'Some sentence.', type: 'weak-lead', problem: 'p', fix: 'f' }],
    missedOpportunities: [], strengths: [],
  } }),
  model: 'stub', maxRounds: 2,
});
const rounds = calls2.filter(c => c.system.includes('demanding senior editor')).length;
ok('structural problem earns a second round', rounds === 2, `got ${rounds} critique calls`);

// ── Revision guards ──────────────────────────────────────────────────────────
console.log('\nrevision guards');
const critiqueObj = { verdict: 'needs-work', issues: [{ quote: 'x', type: 'filler', problem: 'p', fix: 'f' }], strengths: [] };
const dropLinks = await reviseDraft(longDraft, critiqueObj, deep, {
  create: makeCreate2({ revised: 'A revision of adequate length that silently dropped the citation entirely.' }), model: 'stub' });
ok('rejects revision that drops links', !dropLinks.applied && dropLinks.rejected === 'dropped-links');
const tooShort = await reviseDraft(longDraft, critiqueObj, deep, {
  create: makeCreate2({ revised: '[a](https://e.com)' }), model: 'stub' });
ok('rejects gutted revision', !tooShort.applied && tooShort.rejected === 'too-short');
const padded = await reviseDraft(longDraft, critiqueObj, deep, {
  create: makeCreate2({ revised: 'padding '.repeat(400) + '[a](https://e.com)' }), model: 'stub' });
ok('rejects padded revision', !padded.applied && padded.rejected === 'padded');

// ── Review-loop failure isolation ────────────────────────────────────────────
console.log('\nreview failure handling');
const critFail = await reviewDraft(longDraft, deep, {
  create: async (p) => { if (p.system.includes('demanding')) throw new Error('down'); return { content: [{ text: 'x' }] }; },
  model: 'stub',
});
ok('critique failure keeps original draft', critFail.draft === longDraft && !critFail.changed);
const revFail = await reviewDraft(longDraft, deep, {
  create: async (p) => {
    if (p.system.includes('revising')) throw new Error('down');
    return makeCreate2()(p);
  }, model: 'stub',
});
ok('revision failure keeps original draft', revFail.draft === longDraft);
const badCritique = await reviewDraft(longDraft, deep, {
  create: async (p) => p.system.includes('demanding') ? { content: [{ text: 'not json' }] } : makeCreate2()(p),
  model: 'stub',
});
ok('unparseable critique keeps draft', badCritique.draft === longDraft);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
