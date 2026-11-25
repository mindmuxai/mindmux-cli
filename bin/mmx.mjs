#!/usr/bin/env node
import { notifyUpdate } from '../src/update.mjs';
import { main } from '../src/cli.mjs';
import { jsonRequested } from '../src/command-schema.mjs';
import { errorResult } from '../src/errors.mjs';
await notifyUpdate();
await main().catch(error => {
  if (jsonRequested(process.argv.slice(2))) console.log(JSON.stringify({ ...errorResult(error), installed: false }));
  else console.error(`mmx: ${error.message}`);
  process.exitCode = 1;
});
