# src/shared

Types (and the few constants their unions derive from) that describe the HTTP
API between `src/server` and `src/client`. Both TypeScript projects include this
folder, so a field renamed here fails the build on whichever side forgot it.

Rules:

- Types and `as const` arrays only. No imports from `src/server` or `src/client`,
  and nothing that needs Node or the DOM.
- Name things for the domain, not the side: `JobRow` is the SQLite row,
  `Job` is what the API returns. `src/client/types.ts` keeps a few aliases for
  names the client has used for a long time.
