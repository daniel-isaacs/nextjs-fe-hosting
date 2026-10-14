# Project updates

A high-level history of this project: the Next.js frontend for
[test.contentgurus.no](https://test.contentgurus.no), built on Optimizely SaaS
CMS, Optimizely Graph and the Content JS SDK (`@optimizely/cms-sdk`), and
deployed to Optimizely Frontend Hosting. This is not a changelog. Each entry
summarises a milestone and, where there was one, the side effects and lessons
we think are useful to anyone building on the same stack. Newest first.

For the current state of things, see [caching](caching.md),
[performance](performance.md), [observability](observability.md),
[content model](content-model.md) and [GEO](geo.md).

---

## 2026-10 — Observability with OpenTelemetry and Application Insights

The site now sends OpenTelemetry traces, metrics and logs to Application
Insights on Frontend Hosting. The platform already provides
`APPLICATIONINSIGHTS_CONNECTION_STRING`, but nothing sends data to it until the
app does. Locally the same data goes to an Aspire Dashboard. We get Next.js's
spans, the Content JS SDK's built-in spans and metrics, and server-side
`console` output, each linked to its request. Within a day it explained an
outage we could not have diagnosed without it. See
[observability](observability.md).

Smaller changes around it:
- **`/diagnostics/env` lists every variable by name.** It now also shows
  every variable the platform injects, by name only. That's how we found the
  connection string.
- **`/diagnostics` is protected.** The old `/debug` page was merged into it,
  with HTTP Basic Auth (see [developer tools](../README.md#developer-tools)).
  It returns 404 until `DIAGNOSTICS_USER` and `DIAGNOSTICS_PASSWORD` are set.
- **Media assets preview again.** Assets aren't localized, so the CMS sends an
  empty `loc`, which made the SDK's preview lookup match nothing.

Lighthouse is unchanged with all of this switched on: Home 94 and Article 97
(mobile, median of 3).

**Side effects / lessons**

- **Telemetry that reads the clock during prerendering makes every page
  return 500.** Under Cache Components, Next.js rejects `Date.now()` while it
  prerenders the static shell. The OpenTelemetry SDK reads it for every span,
  metric and log record.
  - **Spans are fine:** Next.js deliberately starts them outside the prerender
    scope.
  - **Metrics and logs aren't handled by Next.js.** The SDK's component-lookup
    metrics are recorded on every `<OptimizelyComponent>` render, and
    forwarding `console` output does the same for any component that logs.
    Each, in turn, took every CMS page to 500.
  - **The fix:** we turned off the two component metrics (the component spans
    carry the same timing), and emit log records from the async context
    captured at startup, outside any render.
  - **We reported the metrics problem to the SDK team.**
- **None of it showed in `next dev` or `next build`.** Dev only logs a
  warning. The build passes because CMS pages aren't prerendered at build
  time. Only `next start` returned the 500s. Test telemetry changes with a
  production build before deploying.
- **One hung Graph call took Test2 down for five minutes.**
  - **What happened:** the CMS SDK makes one schema lookup per process (which
    content types are sections) and shares the pending request with every
    page fetch. On a fresh instance, that one request got no response for 301
    seconds; Graph calls sent at the same moment returned in 100 ms. Every
    uncached render waited on it, Next.js gave up filling `'use cache'` after
    about 54 s, and uncached pages returned 500 until Node's default 300 s
    timeout ended the request.
  - **How we found it:** Application Insights showed it directly, in the
    request's trace and in the one slow dependency call.
  - **The fix:** a global 10 s timeout on server-side `fetch`.
  - **We reported it to the SDK team.**
- **A timeout needs a short cache life for failures.** `getPageContent`
  caught Graph errors and cached the resulting `null` with `cacheLife('max')`.
  With a timeout in place, one hung call would have served a 404 until that
  page's next publish. Failures are now cached for seconds.
- **Startup code doesn't share modules with your routes.** We tried to run the
  SDK's lookup in `register()` before traffic arrived. It had no effect:
  Next.js bundles instrumentation separately, so it gets its own copy of the
  SDK. Global state set there must live on `globalThis`, which is why the
  fetch timeout (a global dispatcher) works and the warm-up didn't.
- **Use the Azure exporters, not `useAzureMonitor()`.** The distro registers
  its own metrics provider, which would bypass our metric filter.
  `NodeSDK` also adds default OTLP metric and log exporters (to
  `localhost:4318`) unless you pass empty lists. Locally that was hidden by
  Aspire listening on that port.

## 2026-10 — SDK 3.0, Next.js 16.3, and two silent cache-handler breakages

We upgraded `@optimizely/cms-sdk` and `@optimizely/cms-cli` from 2.0 to 3.0.2,
Next.js from 16.2 to 16.3, and React to 19.3. None of the SDK 3.0 breaking
changes applied to this codebase. The preview route moved to the SDK's
`NextPreviewComponent`, so a save in the CMS now does a soft
`router.refresh()` with an "Updating preview..." indicator instead of a full
iframe reload. We also added `npm run cms:diff`, a read-only check that
compares the content types in code with the ones in the CMS and lists every
difference in one pass.

**Side effects / lessons**

- **Display template literals widened to `string`.** Since SDK 2.2, a
  display template setting's `editor` is typed `'select' | 'checkbox' | string`,
  which collapses to `string`. Inferred props then treated every select value
  as `never`, so comparisons such as `alignment === 'center'` stopped
  compiling. A small wrapper around `displayTemplate()` with a `const` type
  parameter keeps the literal types.
- **CMS schema drift.** Content types are also edited in the CMS UI. Two types
  had changed there: a property had been made localized in the CMS, and
  another type had a CMS-only property. `cms:push-config` rejected our older
  definitions as breaking changes. The CLI stops at the first type it
  rejects, so we only found the drift one type per push. That is why
  `cms:diff` exists: run it before every push, and don't force-push over
  CMS-only properties until you know who added them and why.
- **Next 16.3 dev-only "instant navigation" checks** flagged two things: a
  locale switcher that read `usePathname()`/`useParams()` during render
  (blocking the header shell from prerendering), and the catch-all route,
  where `await params` is runtime data by design. The first was fixed; the
  second is opted out with `instant = false`.
- **Two breakages in the shared Redis cache handler (`cache-handler.mjs`)
  showed up only after deploying.** Local dev uses an in-memory fallback, so
  `next dev` showed neither of them.
  1. **Published content stopped appearing.** Next 16.3 started keying the
     route cache by source route (`/route-cache/APP_PAGE/<sha256>/$/en`
     instead of `/en`). The reference handler's `revalidateTag` turned the
     `_N_T_/en` tag into the key `/en` and deleted that key. After the
     upgrade that key no longer existed, so the delete did nothing and pages
     stayed stale until the next deploy. We switched to timestamp-based tag
     invalidation: revalidated tags and their times are stored in a Redis
     hash, and `get()` treats an entry as a miss if any of its tags was
     revalidated after the entry was written. A page's tags are read from
     its `x-next-cache-tags` header.
  2. **Every client segment prefetch of a cached page returned 500.**
     `APP_PAGE` entries now carry `segmentData` as a `Map<string, Buffer>`,
     and `JSON.stringify` turns a `Map` into `{}`. The handler now round-trips
     Maps, as it already did for Buffers (see the 2026-06 entry). Lighthouse
     Best Practices on `/en` dropped from 100 to 96 because of the console
     errors, then went back to 100 after the fix.
- After the fix, Lighthouse mobile on `/en` (median of 3) scored
  94 / 100 / 100 / 100 (Performance / Accessibility / Best Practices / SEO),
  with an LCP of 3.0 s and CLS 0.
- **FAQ items became translatable.** `AccordionBlock.items` was made
  localized (see the 2026-06 entry for the problem). The CMS treats changing
  localization on a property with content as breaking, so it needed
  `--force`. Existing items stayed in English; the other languages started
  with empty lists to be translated.
- **Lesson:** a custom `cacheHandler` relies on Next.js internals that change
  between minor versions. After any Next.js upgrade, recheck the handler's
  contract (key shape, value shape, tag handling) and test on a deployed
  environment that publishing in the CMS produces fresh content. A green
  local build proves neither.

## 2026-06 to 2026-08 — Deploying with opticloud

Deployment moved from a PowerShell script to the `opticloud` CLI
(`npm run deploy-test2`), with the CLI added as a dev dependency so a clean
checkout can deploy.

**Side effects / lessons**

- `opticloud` reads credentials from command-line flags, then `OPTI_*`
  environment variables (it loads `.env` on startup), then the OS keychain.
  A deploy that works locally from the keychain fails in CI, where there is
  no keychain, so CI needs the `OPTI_*` variables set as secrets.
- `ship` does not validate `--target`. The value is passed to the API as
  typed, so a typo only fails after the package has been built and uploaded.
- `.zipignore` is still required: `opticloud` reads it when it builds the
  deployment package. Its built-in exclusions are a convenience, not a
  security boundary, so list `.env` and other secrets explicitly.

## 2026-06 — Performance campaign and a Lighthouse harness

We added a scripted Lighthouse harness (`npm run lh`) that takes the median of
N runs against the deployed Test2 environment and appends each result to a
history file kept in git. It then drove a series of measured changes.
Details: [performance](performance.md),
[performance engineering story](performance-engineering-story.md) and
[mobile LCP analysis](perf-mobile-lcp-analysis.md).

- **The first harness run on `/en` (mobile) scored 72 for Performance and 77
  for Best Practices.** With the Optimizely Web Experimentation snippet
  switched off, the scores were 84 and 100, and FCP went from 2.7 s to 1.0 s.
  That snippet has to load parser-blocking in `<head>` for its anti-flicker
  guarantee, so its cost is real. The goal was never to remove it, only to
  load it where an experiment is actually running.
- **Changes that worked:** we dropped webfonts that were barely used (25
  `@font-face` rules down to 5), set accurate `sizes` on hero and card images,
  preconnected to the image CDNs, and fixed the contrast of brand orange on
  small text (an accessible variant for light surfaces). Home went from
  84 to 91 and LCP from 4.5 s to 3.5 s. The article page reached 95.

**Side effects / lessons**

- **Lighthouse is noisy.** Use the median and report a range. The SEO score
  swung between 92 and 100 because Lighthouse sometimes missed a meta
  description that was present.
- **Check what the LCP element actually is.** Chrome traces showed it was a
  text paragraph on both page types, not the hero image, and that real LCP
  was about 1.0–1.1 s against Lighthouse's simulated 3–4.5 s. Advice to
  preload or set `fetchpriority` on the hero image would have made things
  worse here.
- **Tried and reverted: `experimental.inlineCss`.** Inlining the ~79 KB
  Tailwind sheet made the article page worse (95 to 92, LCP 2.9 s to 3.4 s).
  HTML is not cached at the edge, so a larger document on every uncached
  response cost more than the CSS request it saved. Worth revisiting once
  HTML is edge-cached.
- **Tried and reverted: removing Next's legacy-JS polyfills.** A modern
  `browserslist` does not stop Next.js from shipping about 13 KiB of
  polyfills, and aliasing the module away had no effect on the deployed
  audit. This is an open upstream issue (vercel/next.js#86785). Check results
  against the deployed audit, not a local grep.
- **Why HTML is `no-store`.** We first suspected the i18n cookie and the
  middleware. The actual cause is render mode: the catch-all route is dynamic
  because `generateStaticParams` returns only a placeholder (see the 2026-04
  entry), and Next.js emits `no-store` for dynamic routes. Removing the
  `next-intl` locale cookie was still worthwhile, but it did not make pages
  cacheable on its own. See [caching](caching.md) and
  [CDN HTML caching](cdn-html-caching.md).

## 2026-06 — Images resized at the edge, not the origin

Until this point `next/image` sent every CMS and DAM image through the built-in
`/_next/image` optimizer, which runs on the single-region origin. A custom
image loader now builds URLs for the CDN that owns each host, so resizing and
format negotiation happen at the edge. Open Graph images get a fixed
1200x630 crop the same way.

**Side effects / lessons**

- The CMS asset CDN ignores `?width=`/`?height=` query parameters. The
  Cloudflare zone in front of it only transforms images through the path form
  `/cdn-cgi/image/<options>/<path>`.
- The DAM/CMP asset CDN behaves differently. It does not convert formats by
  default, and it does not clamp the requested width to the source:
  `width=3840` for a 48 px avatar returned the full 8.5 MB original. We clamp
  DAM widths to 1920 and force `format=auto`. A 12.8 KB PNG avatar now arrives
  as a 1.2 KB AVIF, and a 1.4 MB DAM OG image as a 43 KB WebP.
- With a custom loader, `images.formats` and `images.remotePatterns` in
  `next.config` no longer apply, because they only configure the built-in
  optimizer.

## 2026-06 — Experimentation snippet becomes a CMS setting

The Web Experimentation snippet ID moved from a build-time environment
variable to a field on the `SiteSettings` singleton, so editors can switch
experimentation on and off without a redeploy. Publishing `SiteSettings`
revalidates the root layout and purges the whole CDN, because the setting
affects every page.

**Side effects / lessons**

- At first the environment variable remained as a fallback. As a result,
  editors could not switch the snippet off while the variable was set. The
  CMS field is now the only source.
- The root layout can `await` a cached CMS read without breaking Partial
  Prerendering. A synchronous request read in the same place does break it
  (see the next entry).

## 2026-06 — Bugs that only appeared in production

Early June was mostly fixes for problems that `next dev` never showed.

**Side effects / lessons**

- **The Redis cache handler served `[object Object]`.** Next.js stores route
  handler bodies (`robots.txt`, the sitemap, `llms.txt`) as Buffers. A JSON
  round-trip turns a Buffer into `{type:"Buffer",data:[...]}` and never
  restores it. The in-memory dev fallback skips serialization, so the bug only
  happened against Redis. The handler now encodes Buffers on write and
  rebuilds them on read. (The same class of bug came back with `Map` values
  in 2026-10.)
- **Large CLS from the footer.** With Cache Components, the page body streams
  into a prerendered shell that already includes the footer. The page-body
  `<Suspense>` had no fallback, so the footer painted near the top and was
  then pushed about 3,000 px down: CLS 0.92, and the LCP candidate was reset.
  That `<Suspense>` is load-bearing for PPR. The fix was a fallback that
  reserves height, not removing the boundary.
- **Empty `llms.txt` and sitemap, from three separate Graph issues:**
  - Route handlers don't go through the root layout, so the SDK's Graph
    `config()` (run as a side effect of importing the registry) never ran for
    them. It now lives in a separate side-effect module that every data
    access module imports.
  - Graph's `limit` maximum is 100, not 1000. Higher values return
    `INVALID_ARG_ERROR`.
  - Graph's `Locales` enum only includes locales that the CMS has content in.
    Asking for a locale outside the enum (here `da` and `sv`, before any
    Danish or Swedish content existed) made the whole query fail with a 400,
    not just that locale.
- **Display settings lost in compositions.** `OptimizelyComposition` passes a
  component's display settings to its wrapper but not to the rendered child.
  A block placed directly in an experience (not inside a section) therefore
  never received its display template values. Our experience wrappers
  re-inject them. A similar gap affected top-level experiences, which have to
  read their own settings from `composition.displaySettings`.
- **Not every property is localized.** The FAQ items on the accordion block
  are not localized, so translated FAQ content does not exist per locale and
  FAQ structured data on non-default locales uses the default-locale text.

## 2026-05 — SEO, structured data and GEO

Every CMS page now emits typed JSON-LD built from content fields, with
overrides from the SEO block. Locale roots also get `Organization` and
`WebSite`, and pages get `BreadcrumbList` (and later `FAQPage` from accordion
blocks). A `SiteSettings` singleton holds site-wide inputs. New `/llms.txt` and
`/llms-full.txt` routes give LLM crawlers a markdown index of the site. The
sitemap, robots, canonical URLs and Open Graph/Twitter metadata were filled
in. See [GEO](geo.md).

**Side effects / lessons**

- **`<html lang>` is hard-coded to `en`.** Reading the locale in the root
  layout is an uncached request read, which breaks Partial Prerendering under
  Cache Components, and the deploy failed. The proper fix is route groups,
  each with its own `<html>`. Background:
  [html lang and cacheComponents](html-lang-and-cachecomponents.md).
- URL-typed properties come back as objects (`{ default: ... }`), not strings.
  `String(link.url)` rendered `[object Object]` as a social link.
- Some imported rich text stored Norwegian letters as named HTML entities. A
  small decoder walks the rich-text JSON and decodes text nodes.
- Content type `description` is accepted by the CMS API and shown to editors,
  but it was not in the SDK's types at the time, so a thin wrapper adds it.

## 2026-05 — Design system, localization and marketing blocks

A large feature push in mid-May:

- **UI:** shadcn/ui primitives with `cva` variants replaced ad-hoc Tailwind
  class strings. The Content Gurus brand colours were applied as tokens. The
  brand colour later moved from `--accent` to `--brand` so shadcn's own
  `--accent` semantics work.
- **Localization:** `next-intl` with locale-prefixed routes for en, no, sv
  and da, a locale switcher, and a mobile menu. The preview route stays
  outside the locale tree and takes the locale from the CMS's `loc` query
  parameter. The default locale later changed from `no` to `en`.
- **Content:** Eight marketing blocks were added: hero, stats, testimonial,
  process, callout, solutions, partner logos and an FAQ accordion. Also added
  were an article list block (a Graph `startsWith` query on the parent URL),
  a contact form (inline or as a modal using the native `<dialog>`), a
  richer article header (author, category, reading time), and an editor-
  curated icon dropdown in place of free-text icon names. See
  [content model](content-model.md).
- **Experimentation:** the Optimizely Web Experimentation snippet, loaded
  parser-blocking in `<head>` (the only way to keep its anti-flicker
  behaviour).

**Side effects / lessons**

- **Publishing one page affects more than that page.** A new article has to
  refresh the listings on its parent pages. The webhook now revalidates a tag
  for every parent prefix of the published URL. Revalidating a tag that was
  never written does nothing, so overshooting costs nothing. Lookups embedded
  in other pages (such as a person card) need tag-based revalidation;
  `revalidatePath` alone doesn't reach them.
- **DAM assets inside experiences resolved without a URL.** DAM assets
  referenced inside a Visual Builder composition came back from Graph with
  `__typename: "Data"` and no URL, while the same reference on a page type
  worked. A workaround (looking each asset up by key with a separate
  `cmp_Asset` query) was designed but never needed: the site's images in
  experiences come from the CMS asset library, not the DAM.
- **Local dev doesn't receive webhooks.** Cached CMS reads use
  `cacheLife('max')` and rely on the publish webhook to invalidate them. The
  webhook cannot reach localhost, so CMS edits (including display template
  changes) appeared frozen in dev. Outside production we use a short cache
  life.
- **Tooling on Windows.** Next.js 16.1's Turbopack crashed the dev server
  silently after a few minutes (a native access violation with no error
  message); 16.2.6 fixed it. Mixing pnpm installs into an npm-resolved tree
  corrupted the native SWC binary, so the package manager is now pinned to
  npm with a preinstall guard.
- The CMS editing iframe doesn't always reload after a save, so the preview
  route got a banner with a manual refresh link. In 2026-10,
  `NextPreviewComponent` made saves refresh the preview automatically; the
  banner stays as a fallback.

## 2026-05 — SDK 2.0

We moved to `@optimizely/cms-sdk` and `cms-cli` v2. The Graph client is now
configured once with `config()` and accessed with `getClient()`. The catch-all
and preview routes are wrapped in `withAppContext` so request context (locale,
preview token) is available throughout the tree. Schema keys were renamed
(`required` to `isRequired`, `localized` to `isLocalized`), and
`config push` now takes the config path as a positional argument.

**Side effects / lessons**

- Just before the upgrade, the CLI was pinned to v1 so `latest` moving to v2
  couldn't break the `cms:*` scripts unannounced. Pin the CLI version.

## 2026-04 — Caching and ISR on Frontend Hosting

This was the largest architectural change. We enabled `cacheComponents`,
wrapped every CMS read in `'use cache'` with `cacheLife('max')` and a page tag,
and added the shared Redis cache handler from Optimizely's reference
implementation. A `/hooks/graph` webhook revalidates on publish and purges the
CDN. Frontend Hosting runs multiple instances, so a shared cache handler is
required for them to agree. Measured on Test2, TTFB dropped from 256 ms to
127 ms. Plan and background: [caching](caching.md),
[caching and ISR plan](caching-and-isr-plan.md).

**Side effects / lessons**

- **Under Cache Components the build refuses** any uncached data access
  outside `<Suspense>`, even when the underlying call is `'use cache'`. Route
  segment exports (`dynamic`, `revalidate`, `runtime`) are forbidden, and so
  is `Date.now()` in render. A diagnostics suite we had built a few days
  earlier relied on all of that, so we retired most of it.
- **Unknown URLs returned 200**, with the not-found UI and a 30-day CDN cache
  header. With PPR, the status code is committed when the static shell starts
  streaming, so a `notFound()` thrown inside `<Suspense>` changes the body but
  not the status. Call `notFound()` above the Suspense boundary (in
  `generateMetadata` and at the top of the page).
- **`generateStaticParams` must return at least one entry** under Cache
  Components. When Graph returned nothing, the build failed.
- **The build container had intermittent ~50 s latency to Graph.** That
  exceeds Next's fixed timeout for filling a `'use cache'` entry, so any real
  page could fail the build. We stopped prerendering CMS pages at build time:
  `generateStaticParams` returns one placeholder per locale, and every page is
  rendered and cached on its first request. That is what makes the catch-all
  dynamic, which in turn is why HTML is `no-store` and not cached at the edge
  (see 2026-06). It is a deliberate trade-off: each page renders once on its
  first visit, instead of every deploy getting slower as content grows.
- **The first deploy showed Redis and managed-identity authentication
  errors.** Later deploys of the same commit were clean. Our working theory
  is that the supporting infrastructure takes a few minutes to provision.

## 2026-04 — Probing what the host actually supports

Before committing to a caching design, we built a set of diagnostic pages
that tested which Next.js 16 features work on Frontend Hosting: SSG, SSR, ISR,
PPR, on-demand revalidation, streaming, server actions, middleware, the edge
runtime, image optimisation and draft mode. One finding was that the edge
runtime is not a separate Cloudflare Workers tier; Frontend Hosting is a CDN
in front of a Node origin. A later probe confirmed that Graph populates
`_metadata.url.default` on this CMS instance, which the reference webhook
needs to map a published item to a URL.

**Side effects / lessons**

- Most of the suite was retired within days, because Cache Components forbids
  the segment config and `Date.now()` calls it relied on. Probes tied to
  framework internals have a short shelf life.

## 2026-02 to 2026-03 — First content types, Visual Builder and SDK 1.0

We built the first Visual Builder pieces: banner, call-to-action and image
elements with display templates, a landing-page experience with a full-bleed
background behind a transparent header, an SEO block, a `Person` type, and
row and column display templates. The SDK went to 1.0, which renamed core APIs
(`Infer` to `ContentProps`, `opti` to `content`, `OptimizelyExperience` to
`OptimizelyComposition`). The preview route got targeted error messages
for each SDK error class, and missing pages now return a real 404.

**Side effects / lessons**

- Display template choice keys must be at least two characters (`overlay0`,
  not `0`).
- The first push of a new content type that has display templates needed
  `--force`.
- Some names are reserved: the property group names `content` and `settings`,
  and the property name `pageLink`.
- Visual Builder pitfalls: `pa()` attributes on a background wrapper, and
  `min-h-screen` inside the editor iframe, which made the iframe keep growing.
- Preview can request a content version before Graph has indexed it. The
  preview route retries briefly on Graph errors, including the error's
  subclasses.
- DAM image references have `url.default` set to `null`. Existence checks
  have to use the SDK's `src()` helper rather than inspecting the URL
  directly.

## 2026-01 — Project start

The project started from a generated Next.js scaffold, with the SDK
registries (content types, display templates, React components) initialised
in one place, a catch-all route that fetches content by path from Graph, a
Visual Builder preview route, and a responsive header and footer.

**Side effects / lessons**

- On Frontend Hosting, the Graph gateway environment variable is set without
  the `/content/v2` path suffix, which gave 404s in production but not
  locally. A small helper now normalises it.
- Every new content type has to be registered in several places (the
  content type registry, the component registry, the resolver, and the CLI
  config). The checklist in `CLAUDE.md` tracks them.
