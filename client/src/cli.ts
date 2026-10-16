import { QuotaApiClient } from "./api.js";
import { loadClientConfig } from "./config.js";
import { runExampleDemo } from "./demo.js";

try {
  const config = await loadClientConfig();
  const api = new QuotaApiClient(config);
  await runExampleDemo({ api });
} catch (error) {
  const message = error instanceof Error ? error.message : "An unexpected error occurred.";
  console.error(`Example client failed: ${message}`);
  process.exitCode = 1;
}
