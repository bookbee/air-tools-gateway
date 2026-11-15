/**
 * Load test against a running air-tools-gateway (fixture data, dev keys), with
 * `make load [BASE_URL=…] [N=50] [READS=500] [CONCURRENCY=20] [P95_MS=…]`.
 *
 * 1. Contention, different keys: N concurrent executes of one proposal (brightcart 70011),
 *    each with its own Idempotency-Key. Exactly one `done`, N−1 `409 already_executed`, and
 *    the order is cancelled once.
 * 2. Contention, one key: N concurrent executes with the same key (othershop's 55120). Every
 *    response byte-identical, and brightcart's colliding 55120 untouched.
 * 3. Throughput: READS lookups at CONCURRENCY in flight. No 5xx; p50/p95/p99 reported, and
 *    checked against P95_MS when given.
 *
 * It cancels 70011 and othershop's 55120, so restart the service before running it again.
 * Exit code 0 only when every invariant held.
 */
import { randomBytes } from "node:crypto";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8084";
const N = Number(process.env.N ?? 50);
const READS = Number(process.env.READS ?? 500);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const P95_MS = process.env.P95_MS === undefined ? null : Number(process.env.P95_MS);

const KEYS = {
  brightcart: { read: "airtg_read_local_dev", execute: "airtg_exec_local_dev" },
  othershop: { read: "airtg_read_othershop_dev", execute: "airtg_exec_othershop_dev" },
} as const;
type Tenant = keyof typeof KEYS;

const run = `load-${Date.now()}-${randomBytes(3).toString("hex")}`;
let failures = 0;

function say(line: string) {
  process.stdout.write(`${line}\n`);
}

function check(label: string, ok: boolean, detail = "") {
  say(
    `  ${ok ? "\u001b[32mok\u001b[0m  " : "\u001b[31mFAIL\u001b[0m"} ${label}${detail ? `: ${detail}` : ""}`,
  );
  if (!ok) failures += 1;
}

interface Answer {
  status: number;
  body: string;
  ms: number;
}

async function post(
  path: string,
  key: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const started = performance.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "x-request-id": run,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text(), ms: performance.now() - started };
}

async function getOrder(tenant: Tenant, subject: string, orderId: string): Promise<string | null> {
  const res = await post("/v1/tools/orders.get", KEYS[tenant].read, {
    arguments: { order_id: orderId },
    subject,
  });
  if (res.status !== 200) return null;
  return (JSON.parse(res.body) as { data: { status: string } }).data.status;
}

async function propose(tenant: Tenant, subject: string, orderId: string): Promise<string> {
  const res = await post("/v1/actions/orders.cancel/propose", KEYS[tenant].read, {
    arguments: { order_id: orderId, reason: "changed_mind" },
    subject,
  });
  if (res.status !== 200) {
    throw new Error(
      `propose ${tenant}/${orderId} answered ${res.status} (already cancelled? restart the service): ${res.body.slice(0, 200)}`,
    );
  }
  return (JSON.parse(res.body) as { proposal_id: string }).proposal_id;
}

function execute(tenant: Tenant, subject: string, proposalId: string, idempotencyKey: string) {
  return post(
    "/v1/actions/orders.cancel/execute",
    KEYS[tenant].execute,
    { proposal_id: proposalId, subject },
    { "idempotency-key": idempotencyKey },
  );
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function pool<T>(
  count: number,
  width: number,
  task: (i: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array<T>(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, count) }, async () => {
      while (next < count) {
        const i = next++;
        results[i] = await task(i);
      }
    }),
  );
  return results;
}

async function contentionDifferentKeys() {
  say(`1. ${N} concurrent executes of one proposal, ${N} different keys (brightcart 70011)`);
  const id = await propose("brightcart", "cust_1002", "70011");
  const answers = await Promise.all(
    Array.from({ length: N }, (_, i) => execute("brightcart", "cust_1002", id, `${run}-k${i}`)),
  );
  const done = answers.filter((a) => a.status === 200 && a.body.includes('"status":"done"'));
  const refused = answers.filter((a) => a.status === 409 && a.body.includes('"already_executed"'));
  const other = answers.filter((a) => !done.includes(a) && !refused.includes(a));
  check("exactly one done", done.length === 1, `${done.length}`);
  check(
    `the other ${N - 1} are 409 already_executed`,
    refused.length === N - 1,
    `${refused.length}`,
  );
  check("no other answers", other.length === 0, other.map((a) => a.status).join(","));
  check("70011 is cancelled", (await getOrder("brightcart", "cust_1002", "70011")) === "cancelled");
}

async function contentionOneKey() {
  say(`2. ${N} concurrent executes with one key (othershop 55120)`);
  const id = await propose("othershop", "cust_2001", "55120");
  const answers = await Promise.all(
    Array.from({ length: N }, () => execute("othershop", "cust_2001", id, `${run}-one`)),
  );
  const bodies = new Set(answers.map((a) => `${a.status} ${a.body}`));
  check("every response is byte-identical", bodies.size === 1, `${bodies.size} distinct`);
  check("and it is done", answers[0]!.status === 200 && answers[0]!.body.includes('"done"'));
  check(
    "othershop 55120 is cancelled",
    (await getOrder("othershop", "cust_2001", "55120")) === "cancelled",
  );
  const brightcart = await getOrder("brightcart", "cust_1001", "55120");
  check("brightcart's colliding 55120 is untouched", brightcart !== "cancelled", `${brightcart}`);
}

async function throughput() {
  say(`3. ${READS} lookups, ${CONCURRENCY} in flight`);
  const started = performance.now();
  const answers = await pool(READS, CONCURRENCY, (i) =>
    i % 2 === 0
      ? post("/v1/tools/orders.list_recent", KEYS.brightcart.read, {
          arguments: { limit: 5 },
          subject: "cust_1001",
        })
      : post("/v1/tools/orders.get", KEYS.brightcart.read, {
          arguments: { order_id: "48213" },
          subject: "cust_1001",
        }),
  );
  const seconds = (performance.now() - started) / 1000;
  const latencies = answers.map((a) => a.ms).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const errors = answers.filter((a) => a.status !== 200);
  say(
    `     ${(READS / seconds).toFixed(0)} req/s · p50 ${p50.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms · p99 ${p99.toFixed(1)} ms`,
  );
  check(
    "every lookup answered 200",
    errors.length === 0,
    errors.length ? `${errors.length} failed (first ${errors[0]!.status})` : "",
  );
  if (P95_MS !== null) check(`p95 under ${P95_MS} ms`, p95 <= P95_MS, `${p95.toFixed(1)} ms`);
}

say(`air-tools-gateway load test against ${BASE_URL} (request id ${run})`);
try {
  const health = await fetch(`${BASE_URL}/v1/ready`);
  if (health.status !== 200) throw new Error(`/v1/ready answered ${health.status}`);
  await contentionDifferentKeys();
  await contentionOneKey();
  await throughput();
} catch (error) {
  check("ran to the end", false, error instanceof Error ? error.message : String(error));
}
say(
  failures === 0
    ? "\n\u001b[32mall invariants held\u001b[0m"
    : `\n\u001b[31m${failures} failed\u001b[0m`,
);
process.exit(failures === 0 ? 0 : 1);
