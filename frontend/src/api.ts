// Local dev runs the backend separately on :8000. Deployed (Vercel), the backend is served from
// the same site under /api, so requests just use relative paths.
export const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? "http://localhost:8000" : "");

// A fresh id on every page load: the playground is per-visit by design, so a refresh starts over.
const SESSION_ID = crypto.randomUUID();
const TOKEN_KEY = "coordinatorToken";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private window etc.) — the login just won't survive a refresh
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Session-Id": SESSION_ID };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail).catch(() => null);
    // Only a 401 on a request that carried a login means that login ended — a wrong password
    // at the login dialog is a 401 too, and shouldn't reset the playground the user is still in.
    if (res.status === 401 && token) {
      setToken(null);
      window.dispatchEvent(new Event("session-expired"));
    }
    throw new ApiError(typeof detail === "string" ? detail : `Something went wrong (${res.status}).`, res.status);
  }
  return res.json();
}
