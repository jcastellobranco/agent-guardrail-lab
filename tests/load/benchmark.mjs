import { cpus, totalmem, platform, release } from 'node:os';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setPolicy, token, waitPolicy } from '../../scripts/compose-demo.mjs';

const output = process.env.BENCHMARK_OUTPUT ?? 'benchmarks/results';
const budget = Number(process.env.BENCHMARK_BUDGET_MS ?? 50);
const vus = Number(process.env.VUS ?? 5);
const duration = process.env.DURATION ?? '30s';
await mkdir(output, { recursive: true });
const machine = {
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  memoryBytes: totalmem(),
  platform: platform(),
  kernel: release(),
  node: process.version,
  docker: execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).trim(),
  timestamp: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
};
await writeFile(`${output}/machine.json`, JSON.stringify(machine, null, 2));

const results = [];
try {
  for (const probes of [false, true]) {
    const version = await setPolicy({ probes, budget, failMode: 'closed' });
    const jwt = await token();
    await waitPolicy(jwt, version);
    const scenario = probes ? 'with-probes' : 'without-probes';
    const rawPath = `${output}/${scenario}.json`;
    const env = { ...process.env, AGENT_TOKEN: jwt, BENCHMARK_BUDGET_MS: String(budget) };
    execFileSync('k6', ['run', 'tests/load/check.js'], {
      env: { ...env, VUS: '1', DURATION: '5s' },
      stdio: 'inherit',
    });
    execFileSync('k6', ['run', '--summary-export', rawPath, 'tests/load/check.js'], {
      env,
      stdio: 'inherit',
    });
    const { metrics } = JSON.parse(await readFile(rawPath, 'utf8'));
    const latency = metrics.valid_check_latency_ms;
    if (!latency || !metrics.http_reqs?.count) throw new Error('No valid benchmark samples');
    results.push({
      scenario,
      p50: latency['p(50)'],
      p95: latency['p(95)'],
      p99: latency['p(99)'],
      requests: metrics.http_reqs.count,
      requestsPerSecond: metrics.http_reqs.rate,
      httpFailureRate: metrics.http_req_failed?.value,
      invalidEvaluationRate: 1 - metrics.checks.value,
      budgetViolationRate: metrics.budget_violation?.value,
      degradedRate: metrics.degraded_decisions?.value,
      probeScoredRate: metrics.probe_scored?.value,
    });
    await writeFile(`${output}/summary.json`, JSON.stringify({ machine, budget, vus, duration, results }, null, 2));
  }
} finally {
  await setPolicy({ probes: false, budget: 50 });
}
console.log('BENCHMARK_RESULT', JSON.stringify({ machine, budget, vus, duration, results }));
