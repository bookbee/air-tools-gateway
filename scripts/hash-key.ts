/**
 * Print a raw API key and its digest for a salt.
 *
 *   make key RAW=airtg_read_local_dev            # digest of a known key, dev salt
 *   make key SALT=<prod salt>                    # generate a new key
 *
 * The digest goes into AIR_TOOLS_GATEWAY__SECURITY__API_KEYS; the raw key goes only to the
 * caller (air-orchestrator-service's settings).
 */
import { parseArgs } from "node:util";

import { generateKey, hashKey } from "../src/security/apiKeys.js";

const { values } = parseArgs({
  options: {
    raw: { type: "string" },
    salt: { type: "string" },
  },
  strict: true,
});

const salt = values.salt ?? process.env.AIR_TOOLS_GATEWAY__SECURITY__HASH_SALT;
if (salt === undefined || salt.length === 0) {
  console.error("No salt: pass --salt or set AIR_TOOLS_GATEWAY__SECURITY__HASH_SALT.");
  process.exit(2);
}

const raw = values.raw ?? generateKey();
console.log(`raw:    ${raw}`);
console.log(`digest: ${hashKey(raw, salt)}`);
