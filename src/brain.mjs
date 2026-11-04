import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { requireBinding } from './storage.mjs';
import { withCloud } from './cloud.mjs';
import { pageSummary, renderIndex } from './brain-index.mjs';

const require = createRequire(import.meta.url);
export const brainPackage = dirname(require.resolve('@mindmux/brain-md/package.json'));
export const brainBin = join(brainPackage, 'skills/brain-page/bin/brain.mjs');
const lib = () => import(pathToFileURL(join(brainPackage, 'skills/brain-page/lib/brain.mjs')).href);
export function localCommand(root, args, input = '') {
  const result = spawnSync(process.execPath, [brainBin, ...args], { cwd: root, input, encoding: 'utf8', timeout: 6000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'Local Brain operation failed.');
  return result.stdout.trim();
}
const idCheck = id => { if (!/^[a-z0-9][a-z0-9-]*$/.test(id || '')) throw new Error('Page id must use lowercase letters, digits and hyphens.'); };
const rootCheck = slug => { if (!['background', 'architecture', 'flow', 'mindmap', 'stack', 'roadmap'].includes(slug)) throw new Error('Unknown root page slug.'); };
const version = raw => createHash('sha256').update(raw).digest('hex');

function localMutation(root, run) {
  const lock = join(root, '.mindmux/cli/write.lock');
  mkdirSync(dirname(lock), { recursive: true });
  try { mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another local write is active. If it crashed, remove ${lock}.`);
    throw error;
  }
  try { return run(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

export async function withBrain(root, run) {
  const target = requireBinding(root);
  if (target.kind === 'cloud') return withCloud(target.server, async call => {
    const resolved = await call('resolve_brain', { brainId: target.brainId });
    if (resolved.status !== 'resolved') throw new Error('Bound Cloud Brain is unavailable. Rebind explicitly; no local fallback was used.');
    const invoke = (name, args = {}) => call(name, { ...args, brainId: target.brainId });
    const index = async () => {
      const tools = (await call.listTools()).tools;
      if (tools.some(tool => tool.name === 'read_brain_index')) return invoke('read_brain_index');
      const pages = (await invoke('list_pages')).pages;
      const rootPages = (await invoke('list_root_pages')).rootPages;
      return { path: 'brain/index.md', body: renderIndex(pages, rootPages), pages, rootPages, count: pages.length, source: 'page-list-compatibility' };
    };
    return run({ target, invoke, index,
      reindex: () => invoke('reindex_brain'),
      list: async () => (await invoke('list_pages')).pages,
      read: id => invoke('read_page', { id }),
      roots: async () => (await invoke('list_root_pages')).rootPages,
      readRoot: slug => invoke('read_root_page', { slug }),
      search: async query => (await invoke('search_pages', { query, maxResults: 10 })).pages.filter(p => !p.status || p.status === 'active'),
      create: args => invoke('create_page', args),
      update: args => invoke('update_compiled_truth', args),
      append: args => invoke('append_timeline', args),
      archive: id => invoke('archive_page', { id }),
      updateRoot: async args => {
        if (args.expectedVersion === 'new') {
          const { rootPages } = await invoke('list_root_pages');
          if (rootPages.some(page => page.slug === args.slug)) throw new Error('Root already exists. Read its current version before updating.');
          const { expectedVersion, ...creation } = args;
          return invoke('update_root_page', creation);
        }
        return invoke('update_root_page', args);
      },
    });
  });
  if (process.cwd() !== root) throw new Error('Local adapter must run from the project root.');
  const api = await lib();
  const normalize = doc => ({ ...doc.frontmatter, id: doc.id, version: version(doc.raw),
    compiledTruth: api.extractSection(doc.body, 'compiled_truth'), raw: doc.raw,
    summary: pageSummary(api.extractSection(doc.body, 'compiled_truth'), doc.frontmatter.title) });
  const read = id => { idCheck(id); return normalize(api.loadDoc(join(target.directory, 'pages', `${id}.md`))); };
  const list = () => api.listPages().filter(p => p.frontmatter.status === 'active').map(normalize);
  const checkVersion = (current, expected) => {
    if (!expected || String(current.version) !== String(expected)) throw new Error('Version conflict or missing --expected-version. Read the current page before updating.');
  };
  const roots = () => api.listRootPages().map(doc => ({ slug: doc.id, title: doc.frontmatter.title, version: version(doc.raw), updated: doc.frontmatter.updated }));
  const index = () => {
    const pages = list(), rootPages = roots();
    return { path: join(target.directory, 'index.md'), body: renderIndex(pages, rootPages), storedIndexPresent: existsSync(join(target.directory, 'index.md')), pages: pages.map(({ raw, compiledTruth, ...p }) => p), rootPages, count: pages.length, source: 'current-pages' };
  };
  return run({ target, list, read, index,
    reindex: () => localMutation(root, () => {
      api.reindexBrain();
      return { ...index(), generated: true };
    }),
    roots,
    readRoot: slug => { rootCheck(slug); const doc = api.loadDoc(join(target.directory, `${slug}.md`)); return { slug, body: doc.body, version: version(doc.raw) }; },
    search: query => list().filter(p => `${p.title}\n${p.compiledTruth}`.toLowerCase().includes(query.toLowerCase())),
    create: args => localMutation(root, () => {
      localCommand(root, ['create-page', '--id', args.id, '--category', args.category, '--title', args.title, '--status', args.status || 'active', '--source', args.creationSummary || 'MindMux CLI']);
      localCommand(root, ['update-truth', '--id', args.id, '--summary', args.creationSummary || 'Capture settled knowledge'], args.compiledTruth);
      return read(args.id);
    }),
    update: args => localMutation(root, () => {
      checkVersion(read(args.id), args.expectedVersion);
      localCommand(root, ['update-truth', '--id', args.id, '--summary', args.timelineEntry.summary, '--source', args.timelineEntry.source || 'MindMux CLI'], args.compiledTruth);
      return read(args.id);
    }),
    append: args => localMutation(root, () => {
      idCheck(args.id);
      localCommand(root, ['append-timeline', '--id', args.id, '--kind', args.entry.kind, '--summary', args.entry.summary, '--source', args.entry.source || 'MindMux CLI']);
      return read(args.id);
    }),
    archive: id => localMutation(root, () => { idCheck(id); localCommand(root, ['archive-page', '--id', id]); return read(id); }),
    updateRoot: args => localMutation(root, () => {
      rootCheck(args.slug);
      const path = join(target.directory, `${args.slug}.md`);
      checkVersion({ version: existsSync(path) ? version(api.loadDoc(path).raw) : 'new' }, args.expectedVersion);
      localCommand(root, ['update-root', args.slug], args.body);
      return { slug: args.slug, version: version(api.loadDoc(path).raw) };
    }),
  });
}
