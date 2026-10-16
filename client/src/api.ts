import type { ClientConfig } from "./config.js";

export type ApiResult<T> = {
  status: number;
  headers: Headers;
  body: T;
};

export type RequestOptions = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  allowedStatuses?: number[];
};

export class QuotaApiClient {
  private readonly baseUrl: URL;

  constructor(
    private readonly config: ClientConfig,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch,
  ) {
    try {
      this.baseUrl = new URL(config.apiBaseUrl);
    } catch {
      throw new Error("USAGE_API_BASE_URL must be a valid HTTP(S) URL.");
    }
    if (
      !["http:", "https:"].includes(this.baseUrl.protocol)
      || this.baseUrl.username.length > 0
      || this.baseUrl.password.length > 0
      || this.baseUrl.search.length > 0
      || this.baseUrl.hash.length > 0
    ) {
      throw new Error("USAGE_API_BASE_URL must be an HTTP(S) URL without embedded credentials or query values.");
    }
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const method = options.method ?? "GET";
    const headers = new Headers({ "x-api-key": this.config.apiKey });
    if (options.body !== undefined) headers.set("content-type", "application/json");

    let response: Response;
    try {
      const requestBase = this.baseUrl.href.endsWith("/")
        ? this.baseUrl
        : new URL(`${this.baseUrl.href}/`);
      const requestUrl = new URL(path.replace(/^\//, ""), requestBase);
      response = await this.fetchImplementation(requestUrl, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      throw new Error(`Could not connect to the backend at ${this.baseUrl.origin}. Check that it is running and USAGE_API_BASE_URL is correct.`);
    }

    const allowedStatuses = options.allowedStatuses ?? [200];
    if (!allowedStatuses.includes(response.status)) {
      throw new Error(`Backend returned unexpected HTTP ${response.status} for ${method} ${path}.`);
    }

    let body: T;
    try {
      body = await response.json() as T;
    } catch {
      throw new Error(`Backend returned an invalid JSON response for ${method} ${path}.`);
    }

    return { status: response.status, headers: response.headers, body };
  }
}
