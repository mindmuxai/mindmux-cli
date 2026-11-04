// Index entries are navigation, never substitutes for reading a page before updating it.
export function pageSummary(text = '', fallback = '') {
  const first = text.trim().split(/\r?\n/).find(line => line.trim()) || fallback;
  return [...first.replace(/\s+/g, ' ').trim()].slice(0, 240).join('');
}
const line = value => String(value ?? '').replace(/[\r\n]+/g, ' ');
export function renderIndex(pages, roots = []) {
  return ['# MindMux Brain Index', '', '_Auto-generated from current Brain pages. Read pages for full, current details._', '',
    ...pages.map(p => `- [${line(p.id)}](pages/${line(p.id)}.md) — ${line(p.title)} | category: ${line(p.category || '?')} | status: ${line(p.status || 'active')}${p.tags?.length ? ` | tags: [${p.tags.map(line).join(', ')}]` : ''} | version: ${line(p.version || '?')} | updated: ${line(p.updated || '?')} | ${pageSummary(p.summary, p.title)}`),
    ...(!pages.length ? ['_(no active Pages yet)_'] : []),
    ...(roots.length ? ['', '## Root pages', '', ...roots.map(p => `- [${line(p.slug)}](${line(p.slug)}.md) — ${line(p.title || p.slug)} | version: ${line(p.version || '?')} | updated: ${line(p.updated || '?')}`)] : []), ''].join('\n');
}
export async function indexSnapshot(brain) {
  if (brain.index) return brain.index();
  // Compatibility for Cloud servers not yet upgraded. Keep Cloud as the source.
  const [pages, rootPages] = await Promise.all([brain.list(), brain.roots()]);
  return { path: 'brain/index.md', body: renderIndex(pages, rootPages), pages, rootPages, count: pages.length, source: 'page-list-compatibility' };
}

// Preserve complete index rows and tell the model how to fetch omitted entries.
export function indexContext(index, maxBytes = 3500) {
  const notice = '\n[Index preview truncated. Run brain index for the complete index.]';
  if (Buffer.byteLength(index.body) <= maxBytes) return index.body;
  const lines = []; let bytes = Buffer.byteLength(notice);
  for (const row of index.body.split('\n')) {
    const size = Buffer.byteLength(row) + 1;
    if (bytes + size > maxBytes) break;
    lines.push(row); bytes += size;
  }
  return lines.join('\n') + notice;
}
