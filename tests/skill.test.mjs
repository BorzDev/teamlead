import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.join(root, 'skills/teamlead');
const read = file => readFileSync(file, 'utf8');
const markdown = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? markdown(file) : entry.name.endsWith('.md') ? [file] : [];
});

function checkLinks(file, boundary) {
  const content = read(file).replace(/```[\s\S]*?```/g, '');
  const links = [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)|(?:src|href)="([^"]+)"/g)];
  for (const match of links) {
    const target = match[1] ?? match[2];
    if (/^https?:\/\//.test(target)) continue;
    const [relative, fragment] = target.split('#');
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(relative));
    assert.ok(resolved === boundary || resolved.startsWith(`${boundary}${path.sep}`), `${file}: link escapes bundle: ${target}`);
    assert.ok(existsSync(resolved), `${file}: missing ${target}`);
    if (fragment && resolved.endsWith('.md')) {
      const anchors = [...read(resolved).matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) =>
        heading.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-'));
      assert.ok(anchors.includes(decodeURIComponent(fragment)), `${file}: missing heading ${target}`);
    }
  }
}

test('Skill links resolve after copying or symlinking an isolated installation with spaces', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'teamlead installation '));
  try {
    const copy = path.join(dir, 'project skills', 'teamlead');
    cpSync(skill, copy, { recursive: true });
    const link = path.join(dir, 'global skill');
    symlinkSync(copy, link, 'dir');
    for (const installed of [copy, link]) {
      for (const file of markdown(installed)) checkLinks(file, installed);
      for (const profile of ['codex', 'claude']) {
        assert.ok(existsSync(path.join(installed, `references/${profile}/workflow.md`)));
        assert.ok(existsSync(path.join(installed, `references/${profile}/briefs.md`)));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('README links and image paths resolve inside the repository', () => {
  for (const name of ['README.md', 'README.ru.md']) checkLinks(path.join(root, name), root);
});

test('Release metadata is a semantic version with corresponding release notes', () => {
  const entry = read(path.join(skill, 'SKILL.md'));
  const version = /^  version: "(\d+\.\d+\.\d+)"$/m.exec(entry)?.[1];
  assert.ok(version, 'Missing semantic version in skill metadata');
  assert.ok(read(path.join(root, 'CHANGELOG.md')).includes(`## ${version} — `));
  for (const name of ['README.md', 'README.ru.md']) assert.ok(read(path.join(root, name)).includes(`**${version}**`));
});

test('Published invocation examples parse and specify native model controls', () => {
  for (const profile of ['codex', 'claude']) {
    const doc = read(path.join(skill, `references/${profile}/workflow.md`));
    const examples = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, block]) => JSON.parse(block));
    assert.ok(examples.length > 0, `${profile}: no invocation example`);
    for (const call of examples) {
      if (profile === 'codex') {
        assert.equal(call.fork_turns, 'none', 'Model overrides require an unforked agent');
        assert.ok(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].includes(call.model));
        assert.ok(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(call.reasoning_effort));
        assert.equal(typeof call.message, 'string');
      } else {
        assert.equal(call.subagent_type, 'general-purpose', 'Bundle must not depend on uninstalled agent types');
        assert.ok(['haiku', 'sonnet', 'opus', 'fable'].includes(call.model));
        assert.equal(call.effort, 'high');
        assert.equal(call.run_in_background, false);
        assert.equal(typeof call.prompt, 'string');
      }
    }
  }
});
