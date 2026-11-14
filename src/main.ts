/**
 * Process entry point: config, then app, then listen.
 *
 * Exactly two things may stop startup, each with a clear message: an invalid config (naming
 * variables, never their values) and an invalid capability definition. An unreachable backend
 * never does; it makes /v1/ready answer 503.
 */
import { buildApp } from "./app.js";
import { RegistryError } from "./capabilities/registry.js";
import { ConfigError, loadConfig } from "./config.js";

function startOrExit() {
  try {
    const config = loadConfig();
    return { config, app: buildApp(config) };
  } catch (error) {
    if (error instanceof ConfigError || error instanceof RegistryError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const { config, app } = startOrExit();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutdown.requested");
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.http.host, port: config.http.port });
