import { approve } from './lib/browser-diagnostics.mjs';
import { appendFileSync } from 'node:fs';
const accepted = approve();
console.log(accepted ? 'Browser diagnostic upload candidate validated.' : 'Browser diagnostic files withheld; safe capture-failure record only.');
// An unavailable validator cannot authorize upload, even with stale output.
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'ready=true\n');
// The safe refusal report can still be uploaded by the workflow's always step.
process.exitCode = accepted ? 0 : 1;
