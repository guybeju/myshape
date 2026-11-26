// The line-delimited JSON spoken over the Unix socket: one request line in, one
// response line out, then the connection closes.
export const MAX_REQUEST_BYTES = 1024 * 1024;
/**
 * How long myshape.sh waits for the answer to a request it sent. The board's
 * lookups stop waiting for reads a margin before this (lookup.ts), so a slow
 * read still gets a defined answer to the client.
 */
export const REQUEST_TIMEOUT_MS = 12_000;
