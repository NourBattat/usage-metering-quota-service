import { randomUUID } from "node:crypto";
import { chmod, chown, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SECRET_FILE_NAME = "account-api-key";
const TEMP_FILE_PREFIX = ".account-api-key.";

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

function validateBaseUrl(value) {
  let baseUrl;
  try {
    baseUrl = new URL(value);
  } catch {
    throw new Error("DEMO_API_BASE_URL must be a valid HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error("DEMO_API_BASE_URL must be an HTTP(S) URL without embedded credentials.");
  }
  return baseUrl;
}

async function clearSecretDirectory(secretDirectory) {
  const existing = await readdir(secretDirectory, { withFileTypes: true });
  for (const entry of existing) {
    if (entry.name === SECRET_FILE_NAME || entry.name.startsWith(TEMP_FILE_PREFIX)) {
      await rm(join(secretDirectory, entry.name), { recursive: true, force: true });
    }
  }
}

async function prepareSecretDirectory(secretDirectory, clientUid, clientGid) {
  try {
    await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error("Could not access the dedicated demo secret volume.");
  }
  const directoryInfo = await lstat(secretDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("The demo secret mount must be a real directory.");
  }

  try {
    await chmod(secretDirectory, 0o700);
  } catch {
    throw new Error("Could not set secure permissions on the demo secret volume.");
  }
  if (typeof process.getuid !== "function") {
    throw new Error("The demo bootstrap requires a POSIX container runtime.");
  }
  if (process.getuid() === 0) {
    try {
      await chown(secretDirectory, clientUid, clientGid);
    } catch {
      throw new Error("Could not set secure ownership on the demo secret volume.");
    }
  } else if (directoryInfo.uid !== clientUid || directoryInfo.gid !== clientGid) {
    throw new Error("The demo secret directory is not owned by the configured CLI user.");
  }

  // Remove any prior run's key before attempting provisioning; a failed run cannot reuse it.
  try {
    await clearSecretDirectory(secretDirectory);
  } catch {
    throw new Error("Could not clear the previous demo key from the secret volume.");
  }
}

async function writeSecretAtomically(secretDirectory, apiKey) {
  const temporaryPath = join(secretDirectory, `${TEMP_FILE_PREFIX}${randomUUID()}.tmp`);
  const finalPath = join(secretDirectory, SECRET_FILE_NAME);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${apiKey}\n`, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o400);
    await rename(temporaryPath, finalPath);
  } catch {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error("Could not securely write the new demo account key.");
  }
}

function dropPrivileges(clientUid, clientGid) {
  if (typeof process.getuid !== "function" || typeof process.setuid !== "function" || typeof process.setgid !== "function") {
    throw new Error("The demo bootstrap requires a POSIX container runtime.");
  }
  if (process.getuid() === 0) {
    process.setgid(clientGid);
    process.setuid(clientUid);
  }
  if (process.getuid() !== clientUid) {
    throw new Error("The demo bootstrap could not drop privileges to the CLI user.");
  }
}

export async function runDemoBootstrap({
  env = process.env,
  fetchImplementation = globalThis.fetch,
  dropPrivilegesAfterSetup = true,
  writeLine = console.log,
} = {}) {
  const secretDirectory = resolve(env.DEMO_SECRET_DIR ?? "/run/demo-secrets");
  const clientUid = parsePositiveInteger(env.DEMO_CLIENT_UID ?? "1000", "DEMO_CLIENT_UID");
  const clientGid = parsePositiveInteger(env.DEMO_CLIENT_GID ?? "1000", "DEMO_CLIENT_GID");
  await prepareSecretDirectory(secretDirectory, clientUid, clientGid);

  const provisioningToken = env.PROVISIONING_TOKEN;
  if (typeof provisioningToken !== "string" || provisioningToken.length < 32) {
    throw new Error("Set a valid server-side PROVISIONING_TOKEN for the demo bootstrap service.");
  }

  const baseUrl = validateBaseUrl(env.DEMO_API_BASE_URL ?? "http://backend:3000");
  if (dropPrivilegesAfterSetup) dropPrivileges(clientUid, clientGid);

  let response;
  try {
    response = await fetchImplementation(new URL("/v1/accounts", baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-provisioning-token": provisioningToken,
      },
      body: JSON.stringify({ name: `Compose Demo ${randomUUID()}` }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not reach the backend account-provisioning endpoint.");
  }

  if (response.status !== 201) {
    throw new Error(`Backend account provisioning failed with HTTP ${response.status}.`);
  }

  let created;
  try {
    created = await response.json();
  } catch {
    throw new Error("Backend provisioning response was not valid JSON.");
  }
  if (
    !created
    || typeof created !== "object"
    || typeof created.api_key !== "string"
    || created.api_key.length < 40
    || typeof created.account?.id !== "string"
  ) {
    throw new Error("Backend provisioning response did not contain a usable new account key.");
  }

  await writeSecretAtomically(secretDirectory, created.api_key);
  writeLine("A fresh demo account was provisioned; its key was handed off through the protected secret volume.");
}

async function main() {
  if (process.argv.includes("--clear-only")) {
    const secretDirectory = resolve(process.env.DEMO_SECRET_DIR ?? "/run/demo-secrets");
    await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
    await chmod(secretDirectory, 0o700);
    await clearSecretDirectory(secretDirectory);
    console.log("Demo account key cleared from the dedicated secret volume.");
    return;
  }
  await runDemoBootstrap();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected bootstrap failure.";
    console.error(`Demo bootstrap failed: ${message}`);
    process.exitCode = 1;
  }
}
