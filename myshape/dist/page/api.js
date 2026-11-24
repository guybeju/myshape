// The page's calls to the board. The token arrives once in the URL fragment,
// moves to sessionStorage, and is sent as a header from then on.
const TOKEN_KEY = "myshape-token";
/** Takes the token out of `#t=<token>` so it does not linger in the address bar. */
export function takeToken() {
    const match = /^#t=([0-9a-f]+)$/.exec(location.hash);
    if (match !== null) {
        sessionStorage.setItem(TOKEN_KEY, match[1]);
        history.replaceState(null, "", location.pathname);
    }
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
}
async function call(token, path, init) {
    const response = await fetch(`/api/${path}`, {
        ...init,
        headers: {
            ...init.headers,
            Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
    });
    let data = {};
    try {
        data = (await response.json());
    }
    catch {
        data = {};
    }
    return { status: response.status, data };
}
export function getJson(token, path) {
    return call(token, path, { method: "GET" });
}
export function postJson(token, path, body) {
    return call(token, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}
