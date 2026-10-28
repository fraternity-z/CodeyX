import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { parseArguments, runBenchmark, runConcurrent, summarize, summarizeRuns } from "../scripts/benchmark-fastctx-native.mjs";

test("benchmark statistics retain outliers", () => {
  assert.deepEqual(summarize([1, 2, 3, 4, 100]), {
    count: 5, minMs: 1, p50Ms: 3, p95Ms: 100, p99Ms: 100, maxMs: 100, meanMs: 22, serialCallsPerSecond: 1000 / 22,
  });
  assert.throws(() => summarize([]));
  assert.throws(() => summarize([Number.NaN]));
});

test("benchmark rejects missing or invalid measurement arguments", () => {
  assert.equal(parseArguments(["--samples", "100", "--rounds", "3"]).samples, 100);
  assert.deepEqual(parseArguments(["--concurrencies", "1,4,16,32,64"]).concurrencies, [1, 4, 16, 32, 64]);
  assert.throws(() => parseArguments(["--mcp-bin", "old-mcp.exe"]));
  for (const args of [["--samples"], ["--samples", "0"], ["--rounds", "1.5"], ["--unknown", "value"], ["--concurrencies", "0"], ["--concurrencies", "1,1"], ["--concurrencies", "1,,4"], ["--concurrencies", "257"], ["--concurrencies", "1.5"]]) {
    assert.throws(() => parseArguments(args));
  }
});

test("benchmark executes real bounded concurrency without losing or duplicating calls", async () => {
  let active = 0;
  let maximum = 0;
  const seen = new Set();
  const expected = { content: [{ type: "text", text: "same result" }], isError: false };
  const run = await runConcurrent(17, 4, async iteration => {
    assert.equal(seen.has(iteration), false);
    seen.add(iteration);
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    return expected;
  }, expected);
  assert.equal(maximum, 4);
  assert.equal(seen.size, 17);
  assert.equal(run.samples.length, 17);
  assert.equal(run.successCount, 17);
  assert.equal(run.errorCount, 0);
  assert.ok(run.callsPerSecond > 0);
  assert.deepEqual(run.samples.map(sample => sample.iteration), Array.from({ length: 17 }, (_, index) => index));
  assert.equal(active, 0);
  await assert.rejects(runConcurrent(0, 1, async () => expected, expected));
  await assert.rejects(runConcurrent(1, 0, async () => expected, expected));
});

test("benchmark retains protocol, tool, timeout and equivalence failures in the denominator", async () => {
  const expected = { content: [], isError: false };
  const run = await runConcurrent(5, 16, async iteration => {
    if (iteration === 1) return { content: [], isError: true };
    if (iteration === 2) throw Object.assign(new Error("timeout"), { code: "BENCHMARK_TIMEOUT" });
    if (iteration === 3) return { content: [{ type: "text", text: "changed" }], isError: false };
    if (iteration === 4) throw new Error("worker exited");
    return expected;
  }, expected);
  assert.deepEqual(run.samples.map(sample => sample.errorKind), [null, "tool", "timeout", "equivalence", "protocol"]);
  assert.equal(run.successCount, 1);
  assert.equal(run.errorCount, 4);
  assert.equal(run.timeoutCount, 1);
  assert.equal(run.equivalenceErrorCount, 1);
  assert.ok(Math.abs(run.attemptedCallsPerSecond / run.callsPerSecond - 5) < 1e-12);
  const summary = summarizeRuns([run, run]);
  assert.equal(summary.count, 10);
  assert.equal(summary.errorCount, 8);
  assert.equal(summary.timeoutCount, 2);
  assert.equal(summary.equivalenceErrorCount, 2);
  assert.equal(summary.successCount, 2);
  assert.ok(Math.abs(summary.callsPerSecond / run.callsPerSecond - 1) < 1e-12);
  assert.ok(summary.p99Ms >= summary.p95Ms);
});

test("benchmark checks native results under concurrency and writes bounded-run evidence", {
  skip: !process.env.CODEY_TEST_FASTCTX_BINARY,
  timeout: 120_000,
}, async t => {
  const output = await mkdtemp(join(tmpdir(), "fastctx-benchmark-test-"));
  t.after(() => {
    assert.equal(dirname(output), resolve(tmpdir()));
    assert.ok(basename(output).startsWith("fastctx-benchmark-test-"));
    return rm(output, { recursive: true, force: true });
  });
  const report = await runBenchmark({ binary: process.env.CODEY_TEST_FASTCTX_BINARY, output, samples: 4, rounds: 1, warmup: 1, coldSamples: 1, concurrencies: [1, 4] });
  assert.equal(report.samples.length, 32);
  assert.equal(report.valid, true);
  assert.equal(report.equality.length, 4);
  assert.ok(report.equality.find(value => value.scenario === "read-large").responseBytes > 32768);
  assert.equal(report.cold.samples.native.length, 1);
  assert.ok(report.summary.every(value => value.native.count === 4 && value.native.errorCount === 0));
  assert.deepEqual([...new Set(report.summary.map(value => value.concurrency))], [1, 4]);
  assert.equal(report.environment.binaries.native.sha256, report.environment.binarySha256);
  assert.equal(JSON.parse(await readFile(join(output, "results.json"), "utf8")).samples.length, 32);
  assert.match(await readFile(join(output, "report.md"), "utf8"), /excludes Desktop dispatch/);
});
