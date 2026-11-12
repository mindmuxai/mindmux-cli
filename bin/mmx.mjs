#!/usr/bin/env node
import { notifyUpdate } from '../src/update.mjs';
import { main } from '../src/cli.mjs';
await notifyUpdate();
await main().catch(error => {
  if (process.argv.includes('--non-interactive')) console.log(JSON.stringify({ status: 'error', installed: false, error: error.message }));
  else console.error(`mmx: ${error.message}`);
  process.exitCode = 1;
});
