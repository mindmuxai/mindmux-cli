import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,mkdirSync,cpSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
// Opt-in smoke test: installs synthetic old/new tarballs only in temporary global roots.
// Uses network for public dependencies; never modifies the user's global CLI or project.
const exec=promisify(execFile),source=fileURLToPath(new URL('..', import.meta.url));
const managers=process.argv.slice(2);
if (!managers.length) managers.push('npm', 'pnpm');
if (managers.some(name => !['npm', 'pnpm'].includes(name))) throw new Error('Usage: node scripts/verify-update.mjs [npm] [pnpm]');
const dir=realpathSync(mkdtempSync(join(tmpdir(), 'mmx-self-update-installs-'))),cache=dir+'/cache';const reports=[];
async function command(bin,args,env=process.env,cwd=dir){try{return (await exec(bin,args,{cwd,env,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024})).stdout.trim();}catch(e){throw new Error(`${bin} ${args.join(' ')}: ${e.stderr||e.stdout||e.message}`);}}
const packs={};
for(const [label,version] of [['old','0.1.0'],['new','0.1.2']]){
 const root=join(dir,label);mkdirSync(root);
 for(const file of ['bin','src','docs','README.md','LICENSE','package.json'])cpSync(join(source,file),join(root,file),{recursive:true});
 const pkg=JSON.parse(readFileSync(root+'/package.json'));pkg.version=version;writeFileSync(root+'/package.json',JSON.stringify(pkg,null,2));
 const packed=JSON.parse(await command('npm',['pack','--json','--pack-destination',dir],{...process.env,npm_config_cache:cache},root));packs[label]=join(dir,packed[0].filename);
}
const pnpmBin=managers.includes('pnpm') ? await command('/usr/bin/which',['pnpm']) : undefined;
for(const manager of managers){
 const prefix=join(dir,manager),binDir=prefix+'/bin';mkdirSync(binDir,{recursive:true});
 const env={...process.env,MINDMUX_HOME:prefix+'/mmx-home',npm_config_cache:cache,PATH:binDir+':'+process.env.PATH};
 delete env.npm_config_prefix;delete env.NPM_CONFIG_PREFIX;
 if(manager==='npm')env.npm_config_prefix=prefix;
 else {env.npm_config_global_dir=prefix+'/global';env.npm_config_global_bin_dir=binDir;env.npm_config_store_dir=prefix+'/store';}
 const run=async (name,args,options={})=>{
  if(name==='npm'&&manager==='pnpm'&&args[0]==='root')throw new Error('npm does not own this isolated installation');
  if(name==='pnpm'&&manager==='npm')throw new Error('pnpm does not own this isolated installation');
  const actual=[...args];const spec=actual.indexOf('@mindmux/cli@0.1.2');if(spec>=0)actual[spec]=packs.new;
  return command(name==='pnpm'?pnpmBin:name,actual,env,dir);
 };
 await run(manager,[manager==='npm'?'install':'add','-g',packs.old,'--registry=https://registry.npmjs.org']);
 const globalRoot=await run(manager,['root','-g']);const oldPackage=realpathSync(join(globalRoot,'@mindmux/cli'));
 // Import from the installed old package so detection sees that exact installation.
 const api=await import(pathToFileURL(oldPackage+'/src/update.mjs').href);
 const project=prefix+'/project';mkdirSync(project);
 await command(process.execPath,[oldPackage+'/bin/mmx.mjs','--project',project,'setup','--local','--agent','claude-code','--yes','--json'],env);
 const prefs=readFileSync(project+'/.mindmux/preferences.json','utf8');
 const report=await api.update(project,{yes:true,json:true},{run,current:'0.1.0',home:env.MINDMUX_HOME,check:async()=>({current:'0.1.0',latest:'0.1.2',node:'>=22',available:true})});
 assert.equal(report.status,'updated');assert.equal(report.installedVersion,'0.1.2');assert.equal(report.refresh.refreshed,true);assert.deepEqual(report.warnings,[]);
 const newPackage=realpathSync(join(await run(manager,['root','-g']),'@mindmux/cli'));
 assert.equal(readFileSync(project+'/.mindmux/preferences.json','utf8'),prefs);
 const hooks=JSON.parse(readFileSync(project+'/.claude/settings.json'));
 assert.ok(hooks.hooks.SessionStart.some(h=>h.hooks.some(x=>x.command.includes(newPackage+'/bin/mmx.mjs'))));
 assert.equal(await command(join(binDir,'mmx'),['--version'],env),'0.1.2');
 reports.push({manager,oldPackage,newPackage,moved:oldPackage!==newPackage,report});console.log('PASS '+manager+' real isolated global update and configuration refresh');
}
writeFileSync(dir+'/results.json',JSON.stringify({directory:dir,reports},null,2));console.log(JSON.stringify({directory:dir,reports},null,2));
