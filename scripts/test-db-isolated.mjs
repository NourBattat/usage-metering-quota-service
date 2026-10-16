import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectDirectory = process.cwd();
const DATABASE_NAME_PATTERN = /^usage_metering_test_[1-9][0-9]*_[a-f0-9]{32}$/;

function isSafeDatabaseName(name) {
  // PostgreSQL truncates identifiers longer than 63 bytes; never allow that here.
  return typeof name === "string" && name.length <= 63 && DATABASE_NAME_PATTERN.test(name);
}

export function createIsolatedDatabaseName() {
  return `usage_metering_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
}

function runDocker(args, options = {}) {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: projectDirectory,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error || result.status !== 0) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`Docker Compose command failed with exit code ${result.status ?? "unknown"}.`);
  }
  return options.capture ? result.stdout : "";
}

function createDatabase(databaseName) {
  if (!isSafeDatabaseName(databaseName)) {
    throw new Error("Refusing to create a database with an invalid generated name.");
  }
  runDocker([
    "exec", "-T", "postgres", "sh", "-c",
    'createdb -U "$POSTGRES_USER" "$1"',
    "sh", databaseName,
  ]);
}

function dropDatabase(databaseName) {
  if (!isSafeDatabaseName(databaseName)) {
    throw new Error("Refusing to drop a database with an invalid generated name.");
  }
  runDocker([
    "exec", "-T", "postgres", "sh", "-c",
    'dropdb --if-exists --force -U "$POSTGRES_USER" "$1"',
    "sh", databaseName,
  ]);
}

function runDatabaseCommand(databaseName, command, args = []) {
  if (!isSafeDatabaseName(databaseName)) {
    throw new Error("Refusing to run database tests with an invalid database name.");
  }
  runDocker([
    "exec", "-T", "-e", `PGDATABASE=${databaseName}`,
    "backend", command, ...args,
  ]);
}

export async function runIsolatedDatabaseTests({ name = createIsolatedDatabaseName() } = {}) {
  if (!isSafeDatabaseName(name)) {
    throw new Error("The isolated test database name is invalid.");
  }

  let databaseCreated = false;
  let testFailed = false;
  console.log("Running backend database tests against a new temporary database; the application database will not be used.");
  try {
    const applicationDatabase = runDocker([
      "exec", "-T", "postgres", "printenv", "POSTGRES_DB",
    ], { capture: true }).trim();
    if (!applicationDatabase || name === applicationDatabase) {
      throw new Error("Refusing to target the application database or an unknown application database.");
    }
    createDatabase(name);
    databaseCreated = true;
    console.log("Temporary test database created.");

    runDatabaseCommand(name, "node", ["scripts/migrate.mjs"]);
    runDatabaseCommand(name, "npm", ["run", "seed"]);
    runDatabaseCommand(name, "npm", ["run", "test:db"]);
    console.log("All backend database integration tests passed on the isolated database.");
  } catch (error) {
    testFailed = true;
    const message = error instanceof Error ? error.message : "Unexpected test-database failure.";
    console.error(`Isolated database tests failed: ${message}`);
  } finally {
    if (databaseCreated) {
      try {
        dropDatabase(name);
        console.log("The temporary test database created by this command was removed.");
      } catch {
        console.error("Could not remove the temporary test database created by this command.");
        testFailed = true;
      }
    }
  }

  if (testFailed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runIsolatedDatabaseTests();
}
