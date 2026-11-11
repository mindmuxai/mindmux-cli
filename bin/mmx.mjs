#!/usr/bin/env node
import { notifyUpdate } from '../src/update.mjs';
import { main } from '../src/cli.mjs';
await notifyUpdate();
await main().catch(error => {
  console.error(`mmx: ${error.message}`);
  process.exitCode = 1;
});
