import { VERSION } from './version.mjs';
import { usageError } from './errors.mjs';

export const OPTIONS = Object.fromEntries([
  ...['project', 'agent', 'brain-id', 'server', 'workspace-id', 'name', 'description', 'id', 'title', 'category', 'status', 'source', 'expected-version', 'change-kind', 'summary', 'kind', 'args', 'review-token', 'outcome', 'reason', 'manager'].map(key => [key, { type: 'string' }]),
  ...['local', 'online', 'no-open', 'confirm', 'help', 'version', 'skill', 'yes', 'migrate', 'json', 'keep-login', 'include-external-data', 'fix', 'check', 'refresh-integrations', 'all-projects', 'non-interactive'].map(key => [key, { type: 'boolean' }]),
]);
// Parse output intent even when parseArgs rejects another argument. Never mistake
// string option values or literal arguments after -- for an output flag.
export function jsonRequested(argv) {
  let command;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (['--json', '--non-interactive', '-agent'].includes(arg)) return true;
    if (arg.startsWith('--') && OPTIONS[arg.slice(2)]?.type === 'string') { i++; continue; }
    if (!arg.startsWith('-') && !command) { command = arg; if (command === 'schema') return true; }
  }
  return false;
}
const string = description => ({ type: 'string', minLength: 1, ...(description ? { description } : {}) });
const enumeration = values => ({ type: 'string', enum: values });
export const BRAIN_FIELDS = {
  id: { ...string(), pattern: '^[a-z0-9][a-z0-9-]*$' }, title: string(),
  category: enumeration(['project', 'concept', 'decision', 'person', 'reference']),
  status: enumeration(['active', 'draft', 'archived']), source: string(),
  expectedVersion: string('Use the version returned by read; Cloud uses a positive integer string, Local uses a content hash. Root creation uses new.'),
  changeKind: enumeration(['correction', 'substantive']), summary: string(),
  kind: enumeration(['decision', 'evidence', 'reversal', 'note']), query: string(),
  slug: enumeration(['background', 'architecture', 'flow', 'mindmap', 'stack', 'roadmap']),
  body: string('Complete plain Markdown content through stdin; do not JSON-escape it.'),
  reviewToken: { ...string(), pattern: '^[a-f0-9]{64}$' }, outcome: enumeration(['saved', 'no-changes', 'already-covered', 'deferred']), reason: { ...string(), maxLength: 1000 },
};
const read = (description, fields = [], required = [], positional) => ({ description, fields, required, positional, effect: 'read' });
const write = (description, fields, required, positional, stdin = false) => ({ description, fields, required, positional, stdin, effect: 'brain-write' });
export const BRAIN_OPERATIONS = {
  status: read('Return the selected project binding without contacting Cloud.'),
  index: read('Read the current index, summaries and root navigation.'),
  reindex: write('Regenerate the derived Brain index.', [], []),
  list: read('List active Pages with summaries.'),
  roots: read('List root Pages.'),
  read: read('Read a complete Page and its version.', ['id'], ['id'], 'id'),
  'read-root': read('Read a complete root Page and its version.', ['slug'], ['slug'], 'slug'),
  search: read('Search active Pages.', ['query'], ['query'], 'query'),
  recall: read('Retrieve task context and index navigation.', ['query'], [], 'query'),
  create: write('Create a Page with confirmed knowledge.', ['id', 'title', 'category', 'status', 'source', 'reviewToken', 'body'], ['id', 'title', 'category', 'body'], undefined, true),
  update: { ...write('Replace the complete current Page at its read version.', ['id', 'expectedVersion', 'changeKind', 'summary', 'source', 'reviewToken', 'body'], ['id', 'expectedVersion', 'body'], 'id', true),
    conditions: [
      { if: { properties: { changeKind: { const: 'correction' } }, required: ['changeKind'] }, then: { not: { anyOf: [{ required: ['summary'] }, { required: ['source'] }] } }, else: { required: ['summary'] } },
    ], notes: ['changeKind defaults to substantive. Timeline-free correction requires Cloud. Read the complete Page before updating.'] },
  append: write('Append evidence that does not replace current knowledge.', ['id', 'kind', 'summary', 'source', 'reviewToken'], ['id', 'summary'], 'id'),
  archive: write('Archive a Page.', ['id', 'reviewToken'], ['id'], 'id'),
  'update-root': write('Replace a complete root Page; expectedVersion=new creates it.', ['slug', 'expectedVersion', 'body', 'reviewToken'], ['slug', 'expectedVersion', 'body'], 'slug', true),
  review: { ...read('Register local Codex review metadata, not a Brain Page.', ['reviewToken', 'outcome', 'reason', 'id'], ['reviewToken', 'outcome', 'reason']), effect: 'local-write',
    conditions: [{ if: { properties: { outcome: { const: 'already-covered' } }, required: ['outcome'] }, then: { required: ['id'] } }] },
};
export const flagName = key => ({ expectedVersion: 'expected-version', changeKind: 'change-kind', reviewToken: 'review-token' })[key] || key;
export function brainInputSchema(operation) {
  const spec = Object.hasOwn(BRAIN_OPERATIONS, operation) ? BRAIN_OPERATIONS[operation] : null;
  if (!spec) throw usageError('Unknown Brain operation.');
  return { type: 'object', properties: Object.fromEntries(spec.fields.map(key => [key, BRAIN_FIELDS[key]])), required: spec.required, additionalProperties: false,
    ...(spec.conditions ? { allOf: spec.conditions } : {}) };
}
export function validateBrainArguments(operation, rest, flags) {
  const spec = Object.hasOwn(BRAIN_OPERATIONS, operation) ? BRAIN_OPERATIONS[operation] : null;
  if (!spec) throw usageError('Unknown brain command. Run mmx schema.');
  const allowed = new Set(['project', 'json', 'non-interactive', ...spec.fields.filter(key => key !== spec.positional && key !== 'body').map(flagName)]);
  for (const key of Object.keys(flags)) if (!allowed.has(key)) throw usageError(`--${key} is not supported by brain ${operation}.`);
  if ((!spec.positional && rest.length) || (spec.positional && spec.positional !== 'query' && rest.length > 1)) throw usageError(`Unexpected arguments for brain ${operation}.`);
  const values = {};
  for (const key of spec.fields) {
    if (key === 'body') continue;
    const value = key === spec.positional ? key === 'query' ? rest.join(' ') || undefined : rest[0] : flags[flagName(key)];
    if (spec.required.includes(key) && (typeof value !== 'string' || !value.trim())) throw usageError(`${key === spec.positional ? key : '--' + flagName(key)} is required.`);
    if (value === undefined) continue;
    const field = BRAIN_FIELDS[key];
    if (!value.trim() || (field.maxLength && value.length > field.maxLength) || (field.enum && !field.enum.includes(value)) || (field.pattern && !new RegExp(field.pattern).test(value))) throw usageError(`Invalid ${key}.`);
    if (['title', 'source', 'summary', 'reason'].includes(key) && /[\r\n\0]/.test(value)) throw usageError(`${key} must be a single line without NUL characters.`);
    values[key] = value;
  }
  if (operation === 'update') {
    if (values.changeKind === 'correction' && (values.summary !== undefined || values.source !== undefined)) throw usageError('A correction must omit --summary and --source.');
    if (values.changeKind !== 'correction' && !values.summary) throw usageError('--summary is required for substantive updates.');
  }
  if (operation === 'review' && values.outcome === 'already-covered' && !values.id) throw usageError('already-covered requires --id.');
}

const object = { type: 'object', additionalProperties: true };
const versionValue = { type: ['string', 'integer'] };
const page = { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, status: { type: 'string' }, category: { type: 'string' }, version: versionValue, compiledTruth: { type: 'string' } }, additionalProperties: true };
const rootPage = { type: 'object', properties: { slug: { type: 'string' }, title: { type: 'string' }, version: versionValue, body: { type: 'string' } }, additionalProperties: true };
const pages = { type: 'array', items: page };
const rootPages = { type: 'array', items: rootPage };
const strings = { type: 'array', items: { type: 'string' } };
const resultObject = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: true });
function brainOutputSchema(operation) {
  switch (operation) {
    case 'status': return resultObject({ kind: enumeration(['local', 'cloud', 'unbound']), brainId: { type: 'string' }, directory: { type: 'string' }, name: { type: 'string' }, server: { type: 'string' }, automation: resultObject({ paused: { type: 'boolean' }, revision: { type: 'string' } }, ['paused', 'revision']) }, ['kind', 'automation']);
    case 'list': case 'search': return resultObject({ pages }, ['pages']);
    case 'roots': return resultObject({ rootPages }, ['rootPages']);
    case 'index': case 'reindex': return resultObject({ body: { type: 'string' }, pages, rootPages, count: { type: 'integer' }, source: { type: 'string' }, generated: { type: 'boolean' } });
    case 'recall': return resultObject({ context: { type: 'string' }, indexSource: { type: 'string' }, pageIds: strings, retrievedPageIds: strings, rootSlugs: strings, count: { type: 'integer' } }, ['context', 'pageIds', 'count']);
    case 'review': return resultObject({ reviewed: { type: 'boolean' }, outcome: BRAIN_FIELDS.outcome, retryable: { type: 'boolean' } }, ['reviewed', 'outcome']);
    case 'read-root': case 'update-root': return resultObject({ ...rootPage.properties, rootPage });
    default: return resultObject({ ...page.properties, page, raw: { type: 'string' } });
  }
}
const setupProperties = Object.fromEntries(['agent', 'brain-id', 'server', 'workspace-id', 'name', 'description', 'local', 'yes', 'confirm', 'non-interactive', 'migrate', 'no-open', 'json'].map(key => [key, { type: OPTIONS[key].type }]));
const otherCommands = {
  setup: { description: 'Login, select a Brain and install project integrations. -agent aliases --non-interactive --json.', effect: 'configuration-and-cloud-write', inputSchema: { type: 'object', properties: setupProperties, additionalProperties: false }, notes: ['Use -agent for resumable Agent setup. input_required is a successful intermediate state. Never guess user selections.', 'Project creation requires explicit confirmation. --local excludes Cloud selection flags. --brain-id excludes --workspace-id/--name. --name requires --workspace-id.'] },
  status: { description: 'Inspect configuration and observed activity.', flags: ['online', 'json'], effect: 'read' },
  doctor: { description: 'Diagnose connectivity; --fix explicitly repairs configuration.', flags: ['online', 'json', 'fix', 'yes'], effect: 'configuration-write-with-fix' },
  update: { description: 'Upgrade with the owning installer and refresh managed connections.', flags: ['check', 'yes', 'json', 'manager', 'refresh-integrations', 'all-projects'], effect: 'installation-write-unless-check' },
  login: { description: 'Authorize Cloud access; use --non-interactive --json for resumable browser authorization.', flags: ['server', 'no-open', 'non-interactive', 'json', 'status'], effect: 'credentials-write' },
  logout: { description: 'Remove saved CLI credentials.', flags: ['server'], effect: 'credentials-write' },
  init: { description: 'Initialize a local Brain; --local is required.', flags: ['local'], effect: 'brain-write' },
  connect: { description: 'Install project integration for --agent.', flags: ['agent'], effect: 'configuration-write' },
  disconnect: { description: 'Remove owned integration for --agent.', flags: ['agent'], effect: 'configuration-write' },
  remove: { description: 'Remove setup connections, keeping data and login.', flags: ['agent', 'json'], effect: 'configuration-write' },
  switch: { description: 'Choose a different explicit Brain binding.', flags: ['agent', 'local', 'brain-id', 'server', 'workspace-id', 'name', 'confirm', 'yes', 'json', 'non-interactive'], effect: 'configuration-and-cloud-write' },
  clean: { description: 'Reset local setup and data; preserve Cloud data.', flags: ['keep-login', 'yes', 'json', 'include-external-data'], effect: 'local-data-delete' },
  'brain bind': { description: 'Explicitly select --local or --brain-id.', flags: ['local', 'brain-id', 'server'], effect: 'configuration-write' },
  'brain discover': { description: 'List available Cloud Brains.', flags: ['server', 'workspace-id'], effect: 'read' },
  'workspace list': { description: 'List accessible Workspaces.', flags: ['server'], effect: 'read' },
  'project list': { description: 'List accessible Projects, optionally scoped to a Workspace.', flags: ['server', 'workspace-id'], effect: 'read' },
  'project create': { description: 'Create a shared Project using --workspace-id --name --confirm.', flags: ['server', 'workspace-id', 'name', 'description', 'confirm'], effect: 'cloud-write' },
  'mcp tools': { description: 'Discover upstream Cloud tools and their schemas.', flags: ['server'], effect: 'read' },
  'mcp call': { description: 'Invoke TOOL with --args JSON using explicit arguments; no implicit Brain binding.', flags: ['server', 'args'], effect: 'tool-dependent', positional: 'TOOL' },
  'mcp serve': { description: 'Serve the project-bound MCP over stdio; stdout is MCP protocol only.', flags: [], effect: 'tool-dependent', outputSchema: undefined },
};
function commandSchema(command) {
  const operation = command.startsWith('brain ') ? command.slice(6) : null;
  const spec = Object.hasOwn(BRAIN_OPERATIONS, operation) ? BRAIN_OPERATIONS[operation] : null;
  if (spec) return { command, description: spec.description, effect: spec.effect, inputSchema: brainInputSchema(operation),
    cli: { positional: spec.positional || null, flags: Object.fromEntries(spec.fields.filter(key => key !== spec.positional && key !== 'body').map(key => [flagName(key), key])), stdin: spec.stdin ? { required: true, format: 'markdown', maxBytes: 1048576 } : null },
    notes: spec.notes || [], outputSchema: brainOutputSchema(operation), outputDescription: 'Existing success payload is unchanged. Local and Cloud adapters may return different fields; read returns complete content and a version.' };
  const other = Object.hasOwn(otherCommands, command) ? otherCommands[command] : null;
  if (!other) throw usageError(`Unknown command schema: ${command}. Run mmx schema to list supported commands.`);
  const { flags = [], ...details } = other;
  return { command, outputSchema: object, ...details, inputSchema: details.inputSchema || { type: 'object', properties: Object.fromEntries(flags.map(key => [key, { type: OPTIONS[key].type }])), additionalProperties: false } };
}
export function schema(parts = []) {
  const base = { schemaVersion: 1, cliVersion: VERSION };
  if (parts.length) return { ...base, ...commandSchema(parts.join(' ')) };
  return { ...base, commands: [...Object.keys(BRAIN_OPERATIONS).map(op => `brain ${op}`), ...Object.keys(otherCommands)].map(command => { const spec = commandSchema(command); return { command, description: spec.description, effect: spec.effect }; }),
    globalOptions: { project: { type: 'string' }, json: { type: 'boolean' } },
    errors: { type: 'object', required: ['status', 'error', 'code', 'retryable', 'outcome', 'next'], properties: { status: { const: 'error' }, error: { type: 'string' }, code: { type: 'string' }, retryable: { type: 'boolean' }, outcome: enumeration(['not-started', 'unknown']), next: { type: 'string' } } },
    notes: ['Inspect a command with mmx schema <command>. Brain input field names map to CLI flags via cli.flags; body goes through stdin.', 'Machine errors use --json; --non-interactive and -agent imply --json. Success payloads remain compatible.', 'Unknown mutation outcomes must be verified by reading before retrying. Never automatically replay a mutation.'] };
}
