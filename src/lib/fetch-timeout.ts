// Caps how long any server-side fetch() can wait, by giving Node's built-in
// fetch a global undici dispatcher with timeouts. Called once from register()
// in instrumentation.ts.
//
// Without it a request that never gets a response waits for undici's default
// of 300 s. On Test2 one hung Graph call did exactly that (2026-10-14): the CMS
// SDK shares a one-time section-types lookup between all requests, so every
// uncached render waited on it, Next.js timed out filling 'use cache' after
// ~54 s, and uncached pages returned 500 for five minutes. Graph normally
// answers in well under a second; with a 10 s cap a hung call fails fast, the
// SDK drops it and the next request retries.
//
// Covers Graph, webhook registration and the CDN purge API. Not Redis (its own
// client) or the telemetry exporters (node:http). The dispatcher is global
// (a globalThis symbol), so setting it here reaches page code too, even though
// instrumentation is bundled separately from the routes.
//
// Warming the SDK lookup from register() instead does NOT work: that bundle
// gets its own copy of @optimizely/cms-sdk, so the routes never see the result.

import { Agent, setGlobalDispatcher } from 'undici';

const TIMEOUT_MS = 10_000;

export function setFetchTimeout() {
  setGlobalDispatcher(
    new Agent({
      // Time to connect, to receive the response headers, and between body chunks.
      connectTimeout: TIMEOUT_MS,
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    }),
  );
}
