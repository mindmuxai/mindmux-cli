import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { connect, CLI_BIN, managedBlock } from '../src/integrations.mjs';
import { setup } from '../src/setup.mjs';
import { clean } from '../src/clean.mjs';
import { diagnose } from '../src/doctor.mjs';
import { runHook } from '../src/hooks.mjs';
import { writeJson, readJson } from '../src/storage.mjs';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mmx-boundaries-'))), root = join(dir, 'project'); mkdirSync(root);
  const saved = Object.fromEntries(['MINDMUX_HOME', 'CLAUDE_CONFIG_DIR'].map(k => [k, process.env[k]]));
  process.env.MINDMUX_HOME = join(dir, 'home'); process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-home');
  t.after(() => { for (const [k,v] of Object.entries(saved)) { if(v===undefined) delete process.env[k]; else process.env[k]=v; } rmSync(dir,{recursive:true,force:true}); });
  return { dir, root };
}
const probe = async () => ({ recall: true });

test('known disabled or unsupported Codex aborts before altering legacy instructions or binding', async t => {
  const {root}=fixture(t); const text=managedBlock('Team\n','legacy'); writeFileSync(join(root,'AGENTS.md'),text);
  for(const capability of [{supported:true,enabled:false},{supported:false,enabled:false}]) {
    await assert.rejects(setup(root,{local:true,yes:true,json:true,agent:'codex'},{probe,codexHooks:()=>({...capability,message:'Hooks unavailable in fixture'})}),/Hooks unavailable/);
    assert.equal(readFileSync(join(root,'AGENTS.md'),'utf8'),text);
    assert.equal(existsSync(join(root,'.mindmux/preferences.json')),false);
  }
});

test('disabled Claude settings block setup and doctor reports existing integration unavailable', async t => {
  const {root}=fixture(t);
  await setup(root,{local:true,yes:true,json:true,agent:'claude-code'},{probe});
  const path=join(root,'.claude/settings.local.json'), config=readJson(path); writeJson(path,{...config,disableAllHooks:true});
  writeFileSync(join(root,'CLAUDE.md'),managedBlock('Team\n','legacy'));
  const report=await diagnose(root); assert.equal(report.healthy,false);
  assert.ok(report.checks.some(x=>x.state==='error' && /disableAllHooks/.test(x.message)));
  assert.ok(!report.checks.some(x=>/hook integration is ready/.test(x.message)));
  await assert.rejects(setup(root,{local:true,yes:true,json:true,agent:'claude-code'},{probe}),/disableAllHooks/);
  assert.match(readFileSync(join(root,'CLAUDE.md'),'utf8'),/legacy/);
  assert.equal(readJson(path).disableAllHooks,true);
});

test('cloned foreign MindMux handlers are diagnosed and rejected without changing either config', async t => {
  const {dir,root}=fixture(t); const alice=join(dir,'alice'); mkdirSync(alice); connect(alice,'claude-code');
  const path=join(root,'.claude/settings.json'); writeJson(path,readJson(join(alice,'.claude/settings.local.json')));
  const before=readFileSync(path,'utf8');
  await assert.rejects(setup(root,{local:true,yes:true,json:true,agent:'claude-code'},{probe}),/migration conflict/i);
  assert.equal(readFileSync(path,'utf8'),before); assert.equal(existsSync(join(root,'.claude/settings.local.json')),false);
  const report=await diagnose(root); assert.equal(report.healthy,false);
  assert.ok(report.checks.some(x=>/migration conflict/i.test(x.message)));
});

test('clean recovers current connect-only hooks after receipt loss, and refuses unidentified historical ones', async t => {
  const {dir,root}=fixture(t); connect(root,'codex'); rmSync(join(root,'.mindmux/cli/integrations.json'));
  await clean(root,{yes:true,'keep-login':true}); assert.equal(existsSync(join(root,'.codex/hooks.json')),false);
  const alice=join(dir,'alice'); mkdirSync(alice); connect(alice,'claude-code');
  writeJson(join(root,'.claude/settings.json'),readJson(join(alice,'.claude/settings.local.json')));
  await assert.rejects(clean(root,{yes:true,'keep-login':true}),/migration conflict/i);
  assert.equal(existsSync(join(root,'.claude/settings.json')),true);
});

test('inherited main-checkout and nested-parent hooks are inert outside their bound project', async t => {
  const {root,dir}=fixture(t); execFileSync('git',['init','-q',root]); connect(root,'claude-code');
  const wt=join(dir,'worktree'); execFileSync('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','fixture']);
  execFileSync('git',['-C',root,'worktree','add','-q','-b','fixture',wt]); connect(wt,'claude-code');
  const nested=join(root,'nested'); mkdirSync(nested); connect(nested,'codex');
  for(const agent of ['claude-code','codex']) for(const event of ['session-start','prompt','stop','interrupt']) {
    for(const cwd of [wt,nested,dir]) assert.deepEqual(await runHook(root,agent,event,{cwd,session_id:'isolation',turn_id:'t'}),{});
    assert.deepEqual(await runHook(root,agent,event,{}),{});
  }
  assert.equal(existsSync(join(root,'.mindmux/cli/last-claude-code-session-start.json')),false);
  const sub=join(wt,'src');mkdirSync(sub);
  assert.match((await runHook(wt,'claude-code','session-start',{cwd:sub})).hookSpecificOutput.additionalContext,/no selected Brain/);
});

test('large indexes preserve an exact-match body and honest delivery receipts', async t => {
  const {root}=fixture(t);
  const invoke=(args,input='')=>JSON.parse(execFileSync(process.execPath,[CLI_BIN,'--project',root,...args],{input,encoding:'utf8'}));
  invoke(['init','--local']);
  // Minimal valid fixture Pages avoid a slow CLI subprocess per filler.
  for(let n=0;n<14;n++) {
    const id=`filler-${String(n).padStart(2,'0')}`;
    writeFileSync(join(root,'brain/pages',id+'.md'),`---\nid: ${id}\ntitle: "Filler ${n}"\ncategory: reference\nstatus: active\n---\n\n<!-- compiled_truth -->\n${'Long background summary. '.repeat(20)}\n\n## Timeline\n`);
  }
  invoke(['brain','create','--id','zz-needlekey','--title','Needlekey decision','--category','decision'],'Unique confirmed NEEDLE-EVIDENCE-7931.');
  const output=invoke(['hook','--agent','codex','prompt'],JSON.stringify({cwd:root,session_id:'large',turn_id:'one',prompt:'needlekey'}));
  const context=output.hookSpecificOutput.additionalContext;
  assert.match(context,/zz-needlekey/); assert.match(context,/NEEDLE-EVIDENCE-7931/); assert.match(context,/Run brain index/);
  assert.ok(Buffer.byteLength(context)<=9500);
  const receipt=readJson(join(root,'.mindmux/cli/last-codex-prompt.json'));
  assert.deepEqual(receipt.pageIds,['zz-needlekey']); assert.equal(receipt.bytes,Buffer.byteLength(context));
  assert.deepEqual(receipt.retrievedPageIds,['zz-needlekey']);
});

test('Claude disabling settings respect personal overrides and main-checkout policy in worktrees', async t => {
  const {root,dir}=fixture(t);
  const {inspectHookAvailability}=await import('../src/hook-availability.mjs');
  writeJson(join(process.env.CLAUDE_CONFIG_DIR,'settings.json'),{disableAllHooks:true});
  assert.equal(inspectHookAvailability(root,'claude-code').enabled,false);
  writeJson(join(root,'.claude/settings.local.json'),{disableAllHooks:false});
  assert.equal(inspectHookAvailability(root,'claude-code').enabled,true);
  execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','fixture']);
  const wt=join(dir,'wt');execFileSync('git',['-C',root,'worktree','add','-q','-b','policy',wt]);
  writeJson(join(root,'.claude/settings.local.json'),{disableAllHooks:true});
  writeJson(join(wt,'.claude/settings.local.json'),{disableAllHooks:false});
  assert.equal(inspectHookAvailability(wt,'claude-code').enabled,false);
});

test('refresh preserves disabled Claude integration and its legacy guidance', async t => {
  const {root}=fixture(t);connect(root,'claude-code');
  const path=join(root,'.claude/settings.local.json');writeJson(path,{...readJson(path),disableAllHooks:true});
  const text=managedBlock('Team\n','legacy');writeFileSync(join(root,'CLAUDE.md'),text);
  const {refreshIntegrations}=await import('../src/setup.mjs');
  await assert.rejects(refreshIntegrations(root),/disableAllHooks/);
  assert.equal(readFileSync(join(root,'CLAUDE.md'),'utf8'),text);
  assert.equal(readJson(path).disableAllHooks,true);
});

test('clean also recovers Claude local hooks without any instruction blocks or installation receipt', async t => {
  const {root}=fixture(t);connect(root,'claude-code');rmSync(join(root,'.mindmux/cli/integrations.json'));
  await clean(root,{yes:true,'keep-login':true});
  assert.equal(existsSync(join(root,'.claude/settings.local.json')),false);
});
