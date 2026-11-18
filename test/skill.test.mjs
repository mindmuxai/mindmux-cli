import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { notifyUpdate } from '../src/update.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const bin = join(root, 'bin/mmx.mjs');
const skill = readFileSync(join(root, 'skills/mindmux-cli/SKILL.md'), 'utf8');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mmx skill 'quoted' "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, 'project'), home = join(dir, 'cli-home');
  mkdirSync(join(project, '.mindmux'), { recursive: true });
  mkdirSync(home);
  // A read-only Skill request must not parse either configuration.
  writeFileSync(join(project, '.mindmux/preferences.json'), '{broken project');
  writeFileSync(join(home, 'config.json'), '{broken home');
  return { dir, project, home, env: { ...process.env, MINDMUX_HOME: home } };
}

test('--skill prints only the bundled Markdown without project/login discovery or writes', async t => {
  const f = fixture(t);
  for (const args of [['--skill'], ['--project', join(f.dir, 'absent'), '--skill']]) {
    const result = await run(process.execPath, [bin, ...args], { cwd: f.project, env: f.env });
    assert.equal(result.stdout, skill);
    assert.equal(result.stderr, '');
  }
  assert.match(skill, /^---\nname: mindmux-cli\ndescription: [^\n]+\n---\n/);
  assert.equal(readFileSync(join(f.project, '.mindmux/preferences.json'), 'utf8'), '{broken project');
  assert.deepEqual(readdirSync(f.project), ['.mindmux']);
  assert.deepEqual(readdirSync(join(f.project, '.mindmux')), ['preferences.json']);
  assert.deepEqual(readdirSync(f.home), ['config.json']);
  assert.doesNotMatch(skill, /\/Users\/|MINDMUX_HOME=|file:\/\/|\.\.\/docs\//);
});

test('--skill rejects commands and incompatible flags before any mutation', async t => {
  const f = fixture(t);
  for (const args of [['setup', '--skill'], ['clean', '--yes', '--skill'], ['--skill', '--json'], ['--skill', '-agent']]) {
    await assert.rejects(run(process.execPath, [bin, ...args], { cwd: f.project, env: f.env }), error => {
      if (args.includes('-agent')) {
        assert.equal(JSON.parse(error.stdout).status, 'error');
        assert.match(JSON.parse(error.stdout).error, /Run mmx --skill by itself/);
      } else {
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /Run mmx --skill by itself/);
      }
      return true;
    });
  }
  assert.deepEqual(readdirSync(f.project), ['.mindmux']);
  assert.deepEqual(readdirSync(f.home), ['config.json']);
});

test('--skill never runs the passive update check, including rejected command combinations', async () => {
  for (const argv of [['--skill'], ['setup', '--skill'], ['--project', '/absent', 'setup', '--skill']]) {
    await notifyUpdate({ argv, stdin: { isTTY: true }, stderr: { isTTY: true, write: () => assert.fail('Unexpected notice') },
      env: {}, check: () => assert.fail('Unexpected registry access') });
  }
});

test('npm package includes the Skill and its reader works after relocation', async t => {
  const f = fixture(t);
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root });
  const paths = new Set(JSON.parse(stdout)[0].files.map(file => file.path));
  assert.ok(paths.has('skills/mindmux-cli/SKILL.md'));
  assert.ok(paths.has('src/skill.mjs'));
  const relocated = join(f.dir, 'relocated-package');
  for (const path of ['src/skill.mjs', 'skills/mindmux-cli/SKILL.md']) {
    cpSync(join(root, path), join(relocated, path), { recursive: true });
  }
  const { readSkill } = await import(pathToFileURL(join(relocated, 'src/skill.mjs')).href);
  assert.equal(readSkill(), skill);
});
