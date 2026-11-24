// The page's calls to the board. The token arrives once in the URL fragment,
// moves to sessionStorage, and is sent as a header from then on.

const TOKEN_KEY = "myshape-token";

export interface Reply {
  status: number;
  data: Record<string, unknown>;
}

/** Takes the token out of `#t=<token>` so it does not linger in the address bar. */
export function takeToken(): string {
  const match = /^#t=([0-9a-f]+)$/.exec(location.hash);
  if (match !== null) {
    sessionStorage.setItem(TOKEN_KEY, match[1] as string);
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

async function call(token: string, path: string, init: RequestInit): Promise<Reply> {
  const response = await fetch(`/api/${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { status: response.status, data };
}

export function getJson(token: string, path: string): Promise<Reply> {
  return call(token, path, { method: "GET" });
}

export function postJson(
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Reply> {
  return call(token, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
