import type { ErrorCode } from "@waitless/shared";

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(body: ApiErrorBody, status: number) {
    super(body.error.message);
    this.name = "ApiError";
    this.code = body.error.code;
    this.status = status;
    this.details = body.error.details;
    this.requestId = body.error.requestId;
  }
}

const BASE_URL = import.meta.env.VITE_API_URL ?? "/api/v1";

let accessToken: string | null = null;
let refreshHandler: (() => Promise<string | null>) | null = null;
let refreshPromise: Promise<string | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

/** Absolute path for authenticated non-JSON downloads (CSV exports). */
export function apiUrl(path: string) {
  return `${BASE_URL}${path}`;
}

export function setRefreshHandler(handler: (() => Promise<string | null>) | null) {
  refreshHandler = handler;
}

async function singleFlightRefresh(): Promise<string | null> {
  if (!refreshHandler) return null;
  if (!refreshPromise) {
    refreshPromise = refreshHandler().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  token?: string | null;
  skipAuth?: boolean;
  _retry?: boolean;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, token, headers, skipAuth, _retry, ...rest } = options;
  const authToken = token ?? (skipAuth ? null : accessToken);

  const response = await fetch(`${BASE_URL}${path}`, {
    ...rest,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 401 && !skipAuth && !_retry) {
    const nextToken = await singleFlightRefresh();
    if (nextToken) {
      return request<T>(path, { ...options, token: nextToken, _retry: true });
    }
  }

  if (response.status === 204) return undefined as T;

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    if (payload && typeof payload === "object" && "error" in payload) {
      throw new ApiError(payload as ApiErrorBody, response.status);
    }
    throw new ApiError(
      {
        error: {
          code: "INTERNAL",
          message: `Request failed with status ${response.status}`,
        },
      },
      response.status,
    );
  }

  return payload as T;
}

const IDEMPOTENT_PATH = /^\/(appointments|swaps)(?:\?|$)/;

/**
 * Booking and swap POSTs require a stable key so a retry after a timeout (or
 * after a 401 refresh) cannot create a second appointment/request. The key is
 * generated once per call and preserved through the refresh retry.
 */
function withIdempotencyKey(path: string, options?: RequestOptions): RequestOptions {
  if (!IDEMPOTENT_PATH.test(path)) return { ...options, method: "POST" };
  const headers: Record<string, string> = {};
  new Headers(options?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "idempotency-key")) {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    headers["Idempotency-Key"] = random;
  }
  return { ...options, method: "POST", headers };
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, withIdempotencyKey(path, { ...options, body })),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PUT", body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PATCH", body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "DELETE" }),
};

export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadyResponse {
  status: "ready" | "degraded";
  checks: { db: "up" | "down"; redis: "up" | "down" };
  timestamp: string;
}

export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadyResponse {
  status: "ready" | "degraded";
  checks: { db: "up" | "down"; redis: "up" | "down" };
  timestamp: string;
}
