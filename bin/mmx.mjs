#!/usr/bin/env node
import { main } from '../src/cli.mjs';
await main().catch(error => {
  console.error(`mmx: ${error.message}`);
  process.exitCode = 1;
});
