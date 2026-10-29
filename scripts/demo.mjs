import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const base = join(packageRoot, '.demo'); mkdirSync(base, { recursive: true });
const project = mkdtempSync(join(base, 'project-'));
const bin = join(packageRoot, 'bin/mmx.mjs');
const run = (args, input = '') => {
  const result = spawnSync(process.execPath, [bin, '--project', project, ...args], { input, encoding: 'utf8', env: { ...process.env, MINDMUX_HOME: join(base, 'home') } });
  if (result.status !== 0) throw new Error(result.stderr || 'Demo command failed');
  return JSON.parse(result.stdout);
};
run(['init', '--local']);
run(['brain', 'create', '--id', 'auth-pkce', '--title', 'Use OAuth PKCE for authentication', '--category', 'decision', '--source', 'Confirmed by the user'], 'Authentication uses OAuth Authorization Code + PKCE. Store login tokens in the user directory; never commit them.');
run(['brain', 'create', '--id', 'storage-markdown', '--title', 'Use Markdown for project knowledge', '--category', 'decision'], 'Store project knowledge in Markdown files for reviewable diffs.');
run(['brain', 'create', '--id', 'possible-sso', '--title', 'Candidate SSO authentication approach', '--category', 'decision', '--status', 'draft'], 'Unconfirmed: enterprise SSO may be added later.');
run(['brain', 'update-root', 'architecture', '--expected-version', 'new'], '# Architecture\nAuthorization happens in the browser. The CLI uses its own OAuth credentials for Cloud MCP.');
run(['connect', '--agent', 'cursor']);
const startup = run(['hook', 'session-start', '--agent', 'cursor'], JSON.stringify({ conversation_id: 'demo-session' }));
const prompt = 'Implement authentication using our previous decisions.';
const input = JSON.stringify({ conversation_id: 'demo-session', prompt });
const submitted = run(['hook', 'prompt', '--agent', 'cursor'], input);
const delivered = run(['hook', 'pre-tool', '--agent', 'cursor'], input);
const repeated = run(['hook', 'pre-tool', '--agent', 'cursor'], input);
const stop = run(['hook', 'stop', '--agent', 'cursor'], input);
const stopAgain = run(['hook', 'stop', '--agent', 'cursor'], input);
const doctor = run(['doctor', '--online']);
const page = run(['brain', 'read', 'auth-pkce']);
run(['brain', 'update', 'auth-pkce', '--expected-version', page.version, '--summary', 'Restrict the callback to loopback', '--source', 'Confirmed demo decision'], `${page.compiledTruth}\nThe OAuth callback listens only on 127.0.0.1.`);
const updated = run(['brain', 'read', 'auth-pkce']);
const report = { project, prompt, startup, submitted, delivered, repeated, stop, stopAgain, doctor, updated };
writeFileSync(join(base, 'latest.json'), JSON.stringify(report, null, 2));
const markdown = `# MindMux CLI demo

Run: \`npm run demo\`

Project: \`${project}\`

User request: ${prompt}

The request does not mention a Brain. The prompt hook returns \`${JSON.stringify(submitted)}\`. The first preToolUse delivers:

\`\`\`text
${delivered.additional_context}
\`\`\`

Repeated preToolUse: \`${JSON.stringify(repeated)}\`.

The stop hook requests one review. A repeated stop returns \`${JSON.stringify(stopAgain)}\`.

The write demonstration reads the current version, updates the authentication decision with a loopback restriction, and preserves timeline provenance.

This demo checks CLI and hook output, not context adoption by a real Cursor model.
`;
writeFileSync(join(base, 'report.md'), markdown);
console.log(`Demo complete. Project: ${project}\nReport: ${join(base, 'report.md')}\nJSON: ${join(base, 'latest.json')}\nAuthentication decision recalled: ${delivered.additional_context.includes('[[auth-pkce]]')}\nDraft excluded: ${!delivered.additional_context.includes('possible-sso')}\nReview requested only once: ${Object.keys(stopAgain).length === 0}`);
