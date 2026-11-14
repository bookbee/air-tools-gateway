/**
 * Test harness: a config with the dev keys, and an app whose log lines are captured.
 */
import { Writable } from "node:stream";

import { buildApp, type AppDeps } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import { hashKey } from "../../src/security/apiKeys.js";

export const SALT = "test-salt";

export const KEYS = {
  brightcartRead: "airtg_read_local_dev",
  brightcartExec: "airtg_exec_local_dev",
  othershopRead: "airtg_read_othershop_dev",
  othershopExec: "airtg_exec_othershop_dev",
} as const;

export const RAW_KEYS: readonly string[] = Object.values(KEYS);

export function testConfig(overrides: Record<string, string> = {}): Config {
  const P = "AIR_TOOLS_GATEWAY__";
  return loadConfig({
    [`${P}APP__ENV`]: "test",
    [`${P}SECURITY__HASH_SALT`]: SALT,
    [`${P}SECURITY__API_KEYS`]: JSON.stringify([
      {
        id: "brightcart-read",
        tenant: "brightcart",
        scope: "read",
        key_hash: hashKey(KEYS.brightcartRead, SALT),
      },
      {
        id: "brightcart-exec",
        tenant: "brightcart",
        scope: "execute",
        key_hash: hashKey(KEYS.brightcartExec, SALT),
      },
      {
        id: "othershop-read",
        tenant: "othershop",
        scope: "read",
        key_hash: hashKey(KEYS.othershopRead, SALT),
      },
      {
        id: "othershop-exec",
        tenant: "othershop",
        scope: "execute",
        key_hash: hashKey(KEYS.othershopExec, SALT),
      },
    ]),
    [`${P}LOG__LEVEL`]: "debug",
    ...overrides,
  });
}

export interface CapturedLogs {
  readonly lines: string[];
  records(): Record<string, unknown>[];
  text(): string;
}

export function captureLogs(): { stream: Writable; logs: CapturedLogs } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      callback();
    },
  });
  return {
    stream,
    logs: {
      lines,
      records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
      text: () => lines.join("\n"),
    },
  };
}

export function buildTestApp(deps: AppDeps = {}, config: Config = testConfig()) {
  const { stream, logs } = captureLogs();
  const app = buildApp(config, { logDestination: stream, ...deps });
  return { app, logs, config };
}
