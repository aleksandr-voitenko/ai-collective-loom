import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, lstatSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireRepositoryRuntime } from './check-runtime.mjs';
import { manifest, digest } from './lib/coverage/inputs.mjs';
import { comparisonBase } from './lib/coverage/policy.mjs';
import { combinedReport } from './lib/coverage/report.mjs';

requireRepositoryRuntime();
const repo = fileURLToPath(new URL('../', import.meta.url));
process.chdir(repo);
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--base')) throw new Error('Usage: npm run coverage -- [--base <commit-or-ref>]');
const root = join(repo, 'coverage'), output = join(root, 'approved');
for (const path of [root, output]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Coverage output must not be a symlink');
mkdirSync(root, { recursive: true });
rmSync(output, { recursive: true, force: true }); mkdirSync(output);
const runRoot = mkdtempSync(join(root, 'run-'));
let phase = 'prepare';
const record = { base: '', inputs: undefined, stages: [], expectedStages: [], assets: {}, probe: undefined };
const save = () => writeFileSync(join(runRoot, 'execution.json'), JSON.stringify(record, null, 2) + '\n');
async function command(executable, arguments_, environment = {}) {
  const env = { ...process.env }; delete env.NODE_V8_COVERAGE; delete env.LOOM_COVERAGE_OUTPUT;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { cwd: repo, env: { ...env, ...environment }, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt).on('SIGTERM', terminate);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.off('SIGINT', interrupt).off('SIGTERM', terminate);
      resolve(signal ? 1 : code ?? 1);
    });
  });
}
async function suite(name, script, browser = false) {
  phase = name; const raw = join(runRoot, 'raw', name); mkdirSync(raw, { recursive: true });
  const environment = { NODE_V8_COVERAGE: raw, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--enable-source-maps'].filter(Boolean).join(' ') };
  if (browser) environment.LOOM_COVERAGE_OUTPUT = join(runRoot, 'browser');
  const code = await command('npm', ['run', script], environment);
  record.stages.push({ name, script, raw, code }); save();
  if (code !== 0) throw new Error('Required coverage suite failed: ' + name);
}
try {
  record.base = comparisonBase(repo, args[1] ?? process.env.COVERAGE_BASE_SHA ?? 'origin/main');
  record.inputs = manifest(repo);
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const postgres = Object.keys(pkg.scripts).filter(name => /^test:[a-z-]+:postgres$/.test(name));
  if (!postgres.length) throw new Error('No PostgreSQL suites found');
  record.expectedStages = ['check', ...postgres, 'chromium']; save();
  phase = 'coverage-probes';
  const probeCode = await command('npm', ['run', 'test:coverage']);
  record.probe = { code: probeCode }; save();
  if (probeCode !== 0) throw new Error('Coverage measurement probes failed');
  await suite('check', 'check');
  for (const script of postgres) await suite(script, script);
  phase = 'browser-source-maps';
  const code = await command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--sourcemap', 'hidden']);
  if (code !== 0) throw new Error('Browser coverage build failed');
  const assetsRoot = join(repo, 'dist/web/assets');
  record.assets = Object.fromEntries(readdirSync(assetsRoot).filter(name => name.endsWith('.js')).map(name => [name, digest(readFileSync(join(assetsRoot, name)))]));
  mkdirSync(join(runRoot, 'browser')); save();
  await suite('chromium', 'test:e2e', true);
  phase = 'report';
  const summary = await combinedReport(repo, runRoot, record, output);
  const lines = ['| Scope | Lines | Branch ranges |', '|---|---:|---:|', ...Object.entries(summary.groups).map(([name,g]) => `| ${name} | ${g.lines.pct}% | ${g.branches.pct}% |`),
    '', ...summary.gates.map(g => `${g.passed ? 'PASS' : 'FAIL'} ${g.name}${g.applicable ? '' : ' (no changed reportable lines)'}`)];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  process.exitCode = summary.status === 'passed' ? 0 : 1;
} catch (error) {
  // Incomplete measurements cannot leave a stale or partial passing report.
  rmSync(output, { recursive: true, force: true }); mkdirSync(output);
  writeFileSync(join(output, 'status.json'), JSON.stringify({ schema: 'loom-coverage-status-1', status: 'incomplete', phase }) + '\n');
  console.error('Combined coverage did not complete at ' + phase + '.');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'ready=true\n');
  console.log('Coverage artifacts: coverage/approved');
}
