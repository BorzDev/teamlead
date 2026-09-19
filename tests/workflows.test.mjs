import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = process.env.TEAMLEAD_REPO
  ? path.resolve(process.env.TEAMLEAD_REPO)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const references = path.join(repoRoot, 'skills/teamlead/references/claude');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function template(name) {
  const markdown = readFileSync(path.join(references, name), 'utf8');
  const block = /```js\n([\s\S]*?)\n```/.exec(markdown)?.[1];
  assert.ok(block, `Executable template not found: ${name}`);
  return new AsyncFunction('args', 'agent', 'parallel', 'log', block.replace('export const meta', 'const meta'));
}
const dispatch = template('agents-workflow.md');
const review = template('review-workflow.md');
const parallel = jobs => Promise.all(jobs.map(job => Promise.resolve().then(job)));
const task = (role, id = role) => ({ id, role, brief: `Perform assigned ${id}; write the assigned report.` });
const baseReview = {
  repo: '/isolated/project with spaces', ws: '/isolated/reports', lenses: 'Correctness and data preservation',
  files: ['/isolated/project with spaces/feature flag.js'],
  mode: 'implement', writeFiles: ['/isolated/project with spaces/feature flag.js'],
  permissionScope: 'Implement the assigned feature and fix defects within its approved files. Do not publish or deploy.',
  firstRound: 1, maxRounds: 6, briefPath: '/isolated/skill with spaces/briefs.md',
};
const clean = (patch = {}) => ({
  findings: 0, fixed: 0, open: [], touched: [], scopeRequests: [], checksPassed: true, verdict: 'ready', ...patch,
});

// Exercise the schema boundary too: a conforming runtime rejects invalid structured
// output instead of returning it. Separate fault-injection cases test defensive guards.
function validateSchema(value, schema, location = 'result') {
  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), location);
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${location}.${key}`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validateSchema(value[key], child, `${location}.${key}`);
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value), location);
    value.forEach((item, index) => validateSchema(item, schema.items, `${location}[${index}]`));
  } else if (schema.type === 'integer') {
    assert.ok(Number.isInteger(value), location);
  } else if (schema.type) {
    assert.equal(typeof value, schema.type, location);
  }
  if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, location);
  if (schema.enum) assert.ok(schema.enum.includes(value), location);
}

function runtime(responder, { enforceSchema = true, parallelFn = parallel } = {}) {
  const calls = [], logs = [];
  const agent = async (brief, options) => {
    calls.push({ brief, options });
    const result = await responder(brief, options, calls.length);
    if (enforceSchema && options.schema && result != null) validateSchema(result, options.schema);
    return result;
  };
  return {
    calls, logs,
    dispatch: args => dispatch(args, agent, parallelFn, message => logs.push(message)),
    review: args => review({ ...baseReview, ...args }, agent, parallelFn, message => logs.push(message)),
  };
}

for (const [role, model, effort] of [
  ['lookup', 'opus', 'medium'], ['recon', 'opus', 'high'], ['implement', 'opus', 'high'],
  ['sensitive', 'opus', 'xhigh'], ['check', 'opus', 'low'], ['escalate', 'claude-fable-5-1', 'max'],
]) {
  test(`Worker ${role} sends the role's model and effort`, async () => {
    const rt = runtime(async () => 'DONE');
    const result = await rt.dispatch({ tasks: [task(role)] });
    assert.equal(rt.calls.length, 1);
    assert.equal(rt.calls[0].options.model, model);
    assert.equal(rt.calls[0].options.effort, effort);
    assert.equal(rt.calls[0].options.agentType, 'general-purpose');
    assert.equal(result.allReturned, true);
    assert.deepEqual(result.results[0].requested, { model, effort });
  });
}

test('All task inputs are validated before dispatch, including invalid late tasks', async () => {
  const invalidTasks = [null, {}, task('unknown'), task('__proto__'), task('constructor'),
    task(['implement']), { ...task('lookup'), id: ' ' }, { ...task('lookup'), id: 7 },
    { ...task('lookup'), brief: '' }, { ...task('lookup'), brief: 7 }];
  for (const invalid of invalidTasks) {
    const rt = runtime(async () => 'DONE');
    await assert.rejects(() => rt.dispatch({ tasks: [task('implement', 'first'), invalid], independent: true }));
    assert.equal(rt.calls.length, 0);
  }
  for (const tasks of [undefined, null, [], 'tasks', Array.from({ length: 17 }, (_, i) => task('lookup', String(i)))]) {
    const rt = runtime(async () => 'DONE');
    await assert.rejects(() => rt.dispatch({ tasks, independent: true }));
    assert.equal(rt.calls.length, 0);
  }
});

test('Parallel guard and duplicate IDs stop all workers before any call', async () => {
  for (const independent of [undefined, false, 1, 'true']) {
    const rt = runtime(async () => 'DONE');
    await assert.rejects(() => rt.dispatch({ tasks: [task('lookup'), task('implement')], independent }));
    assert.equal(rt.calls.length, 0);
  }
  const rt = runtime(async () => 'DONE');
  await assert.rejects(() => rt.dispatch({ tasks: [task('lookup', 'same'), task('implement', 'same')], independent: true }));
  assert.equal(rt.calls.length, 0);
});

test('Allowed parallel batch preserves task order despite reverse completion order', async () => {
  let releaseFirst;
  const firstMayFinish = new Promise(resolve => { releaseFirst = resolve; });
  const rt = runtime(async (_, options) => {
    if (options.label === 'first') await firstMayFinish;
    else releaseFirst();
    return options.label;
  });
  const result = await rt.dispatch({ tasks: [task('lookup', 'first'), task('implement', 'second')], independent: true });
  assert.deepEqual(result.results.map(item => item.id), ['first', 'second']);
  assert.deepEqual(result.results.map(item => item.output), ['first', 'second']);
  assert.equal(result.allReturned, true);
});

for (const failure of ['null', 'undefined', 'throw']) {
  test(`A single ${failure} worker preserves its ID and failure`, async () => {
    const rt = runtime(async () => {
      if (failure === 'throw') throw new Error('worker crash');
      return failure === 'null' ? null : undefined;
    });
    const result = await rt.dispatch({ tasks: [task('escalate', 'failed-unique-id')] });
    assert.equal(result.allReturned, false);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].id, 'failed-unique-id');
    assert.equal(result.results[0].returned, false);
    assert.deepEqual(result.results[0].requested, { model: 'claude-fable-5-1', effort: 'max' });
    if (failure === 'throw') assert.ok(result.results[0].error);
  });
}

test('Mixed parallel null and thrown workers remain visible under their own IDs', async () => {
  const rt = runtime(async (_, options) => {
    if (options.label === 'lost') return null;
    if (options.label === 'crashed') throw new Error('runtime failure');
    return 'DONE';
  });
  const result = await rt.dispatch({ tasks: [task('lookup', 'ok'), task('implement', 'lost'), task('sensitive', 'crashed')], independent: true });
  assert.equal(result.allReturned, false);
  assert.deepEqual(result.results.map(({ id, returned }) => [id, returned]), [['ok', true], ['lost', false], ['crashed', false]]);
  assert.ok(result.results[2].error);
});

test('A missing parallel result keeps the unreturned task in the result list', async () => {
  const rt = runtime(async () => 'DONE', { parallelFn: async jobs => [await jobs[0]()] });
  const result = await rt.dispatch({ tasks: [task('lookup', 'ok'), task('escalate', 'lost')], independent: true });
  assert.equal(result.allReturned, false);
  assert.equal(result.results[1].id, 'lost');
  assert.equal(result.results[1].returned, false);
  assert.deepEqual(result.results[1].requested, { model: 'claude-fable-5-1', effort: 'max' });
});

for (const [effort, model] of [['high', 'opus'], ['xhigh', 'opus'], ['max', 'claude-fable-5-1']]) {
  test(`Review ${effort} calls exactly one reviewer using ${model}`, async () => {
    const rt = runtime(async () => clean());
    const result = await rt.review({ effort });
    assert.equal(rt.calls.length, 1);
    assert.equal(rt.calls[0].options.model, model);
    assert.equal(rt.calls[0].options.effort, effort);
    assert.equal(rt.calls[0].options.agentType, 'general-purpose');
    assert.deepEqual(result.requested, { model, effort });
    assert.equal(result.converged, true);
    assert.equal(result.nextRound, 2);
  });
}

test('Brief passes repository and filenames containing spaces as unambiguous structured data', async () => {
  const rt = runtime(async () => clean());
  const args = { ...baseReview, files: [...baseReview.files, '/isolated/project with spaces/$literal;quote\'file.js'] };
  await rt.review(args);
  const data = rt.calls[0].brief.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).find(value => value?.repo);
  assert.deepEqual(data, {
    repo: args.repo, ws: args.ws, r: 1, files: args.files, mode: args.mode,
    writeFiles: args.writeFiles, permissionScope: args.permissionScope, lenses: args.lenses,
  });
});

test('A fix returns control after one call even when no report was written', async context => {
  const ws = mkdtempSync(path.join(tmpdir(), 'teamlead-review-contract-'));
  context.after(() => rmdirSync(ws));
  const rt = runtime(async () => clean({ findings: 1, fixed: 1, touched: [baseReview.files[0]], verdict: 'not_ready' }));
  const result = await rt.review({ ws });
  assert.equal(existsSync(path.join(ws, 'review-1.md')), false);
  assert.equal(rt.calls.length, 1);
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'needs_fresh_review');
  assert.equal(result.nextRound, 2);
});

test('Round six permits one clean review; round seven cannot spawn any reviewer', async () => {
  const rt = runtime(async () => clean());
  const sixth = await rt.review({ firstRound: 6 });
  assert.equal(rt.calls.length, 1);
  assert.equal(rt.calls[0].options.label, 'review:6');
  assert.equal(sixth.converged, true);
  assert.equal(sixth.nextRound, 7);
  const seventh = await rt.review({ firstRound: sixth.nextRound });
  assert.equal(rt.calls.length, 1);
  assert.equal(seventh.converged, false);
  assert.equal(seventh.reason, 'review_limit');
  assert.equal(seventh.nextRound, 7);
  assert.deepEqual(seventh.rounds, []);
});

test('A fix in the sixth round exhausts the budget without a seventh call', async () => {
  const rt = runtime(async () => clean({ findings: 1, fixed: 1, touched: ['/isolated/a.js'], verdict: 'not_ready' }));
  const result = await rt.review({ firstRound: 6 });
  assert.equal(rt.calls.length, 1);
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'review_limit');
  assert.equal(result.nextRound, 7);
});

for (const failure of ['null', 'undefined', 'throw']) {
  test(`A ${failure} reviewer consumes exactly its reserved round`, async () => {
    const rt = runtime(async () => {
      if (failure === 'throw') throw new Error('reviewer unavailable');
      return failure === 'null' ? null : undefined;
    });
    const result = await rt.review({ firstRound: 4 });
    assert.equal(rt.calls.length, 1);
    assert.equal(result.converged, false);
    assert.equal(result.nextRound, 5);
    assert.equal(result.reason, failure === 'throw' ? 'agent_error' : 'missing_result');
    assert.deepEqual(result.rounds, []);
  });
}

test('Invalid review input cannot start or consume a reviewer', async () => {
  const invalid = [
    { effort: 'ultra' }, { effort: 'low' }, { maxRounds: 0 }, { maxRounds: 7 }, { maxRounds: 1.5 },
    { firstRound: 0 }, { firstRound: 8 }, { firstRound: 1.5 }, { repo: '' }, { ws: ' ' },
    { briefPath: '' }, { lenses: 1 }, { files: 'a.js' }, { files: [''] }, { files: [1] },
  ];
  for (const patch of invalid) {
    const rt = runtime(async () => clean());
    await assert.rejects(() => rt.review(patch));
    assert.equal(rt.calls.length, 0);
  }
});

test('Schema-rejected negative and fractional counts become consumed failed rounds', async () => {
  for (const patch of [{ findings: -1 }, { findings: 0.5 }, { fixed: -1 }, { fixed: 0.5 }]) {
    const rt = runtime(async () => clean(patch));
    const result = await rt.review({ firstRound: 2 });
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'agent_error');
    assert.equal(result.nextRound, 3);
    assert.equal(rt.calls.length, 1);
  }
});

test('Runtime invariant rejects fixed count exceeding findings despite schema-valid output', async () => {
  const rt = runtime(async () => clean({ findings: 0, fixed: 1 }));
  const result = await rt.review();
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'invalid_result');
  assert.equal(result.nextRound, 2);
});

test('Defensive validation rejects malformed verdicts even if runtime schema validation is bypassed', async () => {
  for (const value of [
    clean({ findings: -1 }), clean({ findings: 0.5 }), clean({ fixed: -1 }), clean({ fixed: 0.5 }),
    clean({ open: [' '] }), clean({ touched: [7] }), clean({ scopeRequests: '' }), clean({ checksPassed: 1 }),
    clean({ verdict: 'unknown' }), {}, 'ready',
  ]) {
    const rt = runtime(async () => value, { enforceSchema: false });
    const result = await rt.review();
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'invalid_result');
    assert.equal(result.nextRound, 2);
    assert.equal(rt.calls.length, 1);
  }
});

test('Failed checks cannot produce convergence or start another agent', async () => {
  const rt = runtime(async () => clean({ checksPassed: false }));
  const result = await rt.review();
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'checks_failed');
  assert.equal(rt.calls.length, 1);
});

test('Scope requests return to the lead without an automatic retry', async () => {
  const requestedPath = '/isolated/project with spaces/new-helper.js';
  const rt = runtime(async () => clean({ findings: 1, scopeRequests: [requestedPath], open: ['Need scope approval'], verdict: 'not_ready' }));
  const result = await rt.review();
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'scope_required');
  assert.deepEqual(result.rounds[0].scopeRequests, [requestedPath]);
  assert.equal(rt.calls.length, 1);
});

test('Open issues block a ready claim', async () => {
  const rt = runtime(async () => clean({ open: ['Could not verify contract'] }));
  const result = await rt.review();
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'open_issues');
  assert.equal(rt.calls.length, 1);
});

test('Touched files require fresh review even with zero findings and a ready claim', async () => {
  const rt = runtime(async () => clean({ touched: [baseReview.files[0]] }));
  const result = await rt.review();
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'needs_fresh_review');
  assert.equal(rt.calls.length, 1);
});

test('A not_ready claim cannot converge even with zero findings and passing checks', async () => {
  const rt = runtime(async () => clean({ verdict: 'not_ready' }));
  const result = await rt.review();
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'needs_fresh_review');
});

test('Missing or invalid authorization fields reject before any reviewer runs', async () => {
  const invalid = [
    { mode: undefined }, { mode: null }, { mode: '' }, { mode: 'read-only' },
    { permissionScope: undefined }, { permissionScope: null }, { permissionScope: '' }, { permissionScope: ' ' }, { permissionScope: 1 },
    { writeFiles: undefined }, { writeFiles: null }, { writeFiles: '' }, { writeFiles: [1] },
    { writeFiles: ['/unassigned/foreign.js'] },
  ];
  for (const patch of invalid) {
    const rt = runtime(async () => clean());
    await assert.rejects(() => rt.review(patch));
    assert.equal(rt.calls.length, 0);
  }
});

test('Read-only mode rejects nonempty writable scope before dispatch', async () => {
  const rt = runtime(async () => clean());
  await assert.rejects(() => rt.review({ mode: 'read_only', writeFiles: [baseReview.files[0]] }));
  assert.equal(rt.calls.length, 0);
});

test('Read-only brief carries exact mode, empty writable scope and authorized actions', async () => {
  const permissionScope = 'Review the existing changes only; do not modify files, send messages or deploy.';
  const rt = runtime(async () => clean());
  const result = await rt.review({ mode: 'read_only', writeFiles: [], permissionScope });
  const data = rt.calls[0].brief.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).find(value => value?.repo);
  assert.equal(data.mode, 'read_only');
  assert.deepEqual(data.writeFiles, []);
  assert.deepEqual(data.files, baseReview.files);
  assert.equal(data.permissionScope, permissionScope);
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'read_only_complete');
  assert.equal(rt.calls.length, 1);
});

test('Read-only findings return to the lead without starting a fix loop', async () => {
  const rt = runtime(async () => clean({ findings: 2, open: ['Defect A', 'Defect B'], verdict: 'not_ready' }));
  const result = await rt.review({ mode: 'read_only', writeFiles: [], firstRound: 3 });
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'read_only_complete');
  assert.equal(result.nextRound, 4);
  assert.equal(result.rounds[0].findings, 2);
  assert.deepEqual(result.rounds[0].open, ['Defect A', 'Defect B']);
  assert.equal(rt.calls.length, 1);
});

test('Read-only failed checks and scope requests remain visible rather than becoming a ready claim', async () => {
  const rt = runtime(async () => clean({
    findings: 1, open: ['Check unavailable'], checksPassed: false,
    scopeRequests: ['/isolated/project with spaces/additional.js'], verdict: 'not_ready',
  }));
  const result = await rt.review({ mode: 'read_only', writeFiles: [] });
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'read_only_complete');
  assert.equal(result.rounds[0].checksPassed, false);
  assert.equal(result.rounds[0].scopeRequests.length, 1);
  assert.equal(rt.calls.length, 1);
});

test('Any touched file or reported fix in read-only mode is an explicit violation', async () => {
  for (const patch of [
    { touched: [baseReview.files[0]] },
    { findings: 1, fixed: 1, verdict: 'not_ready' },
    { findings: 1, fixed: 1, touched: [baseReview.files[0]], verdict: 'not_ready' },
  ]) {
    const rt = runtime(async () => clean(patch));
    const result = await rt.review({ mode: 'read_only', writeFiles: [] });
    assert.equal(result.converged, false);
    assert.equal(result.reason, 'read_only_violation');
    assert.equal(rt.calls.length, 1);
  }
});
