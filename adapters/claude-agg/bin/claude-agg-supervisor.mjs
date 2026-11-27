#!/usr/bin/env node
// The supervisor's entry point, started by hand in a terminal:
//   pnpm --dir adapters/claude-agg run supervisor <settings.json>
// which builds src/ into dist/ first. The board never runs this file.
import { runFromProcess } from "#agg-built/supervisor/main.js";

process.exitCode = await runFromProcess();
