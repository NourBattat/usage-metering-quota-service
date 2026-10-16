import { readFile } from "node:fs/promises";

export type ClientConfig = {
  apiBaseUrl: string;
  apiKey: string;
};

export async function loadClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClientConfig> {
  const apiBaseUrl = (env.USAGE_API_BASE_URL ?? "http://localhost:3000").trim();
  if (!apiBaseUrl) {
    throw new Error("USAGE_API_BASE_URL must be a non-empty HTTP(S) URL.");
  }

  let apiKey = env.USAGE_API_KEY?.trim() ?? "";
  const keyFile = env.USAGE_API_KEY_FILE?.trim();
  if (keyFile) {
    try {
      apiKey = (await readFile(keyFile, "utf8")).trim();
    } catch {
      throw new Error("Could not read the account key file configured by USAGE_API_KEY_FILE.");
    }
  }
  if (!apiKey) {
    throw new Error("Set USAGE_API_KEY or USAGE_API_KEY_FILE before running the example client.");
  }

  return { apiBaseUrl, apiKey };
}
