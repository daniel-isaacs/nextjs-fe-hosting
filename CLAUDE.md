# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Next.js 16 frontend for Optimizely SaaS CMS using the Content JS SDK (`@optimizely/cms-sdk` v2). Deployed to Optimizely Frontend Hosting. Uses the App Router, React 19, Tailwind CSS 4, and TypeScript 5.

## Commands

```bash
npm run dev                  # Dev server with HTTPS (uses certificates/ dir)
npm run build                # Production build
npm run lint                 # ESLint (flat config, core-web-vitals + typescript)
npm run cms:login            # Authenticate with Optimizely CMS CLI
npm run cms:diff             # Read-only: diff code vs CMS content types/templates (run before pushing)
npm run cms:push-config      # Push content type definitions to CMS
npm run cms:push-config-force  # Force push (overwrites existing types)
npm run deploy-test2         # Deploy to Test2 (opticloud ship; credentials from OPTI_* in .env/env or the `opticloud auth:login` keychain)
npm run lh                   # Lighthouse on Test2 (test.contentgurus.no/en), median of 3, stores result
npm run lh:trim              # Agent-friendly markdown summary of the latest Lighthouse report
npm run lh:history           # Score trend across runs (▲/▼ deltas)
```

## Performance testing (Lighthouse harness)

`scripts/lighthouse/` runs the global `lighthouse` CLI against the **Test2
environment** (`https://test.contentgurus.no` — the Test2 deploy's public host;
note `test2.contentgurus.no` does **not** resolve) and stores results so scores
can be tracked over time. Measure against Test2, not localhost — only the
deployed environment has the production-like caching that yields representative
numbers.

- `npm run lh [-- --url … --runs N --label … --desktop]` — median-of-N run;
  saves `report.json` to a timestamped folder and appends a row to
  `scripts/lighthouse/results/history.jsonl`.
- `npm run lh:trim [path]` — extracts the sub-0.9 audits + ranked offenders from
  a report (defaults to the latest); paste to Claude for a fix plan.
- `npm run lh:history` — prints the trend table.

`history.jsonl` is tracked in git (the trend persists); per-run report folders
are gitignored. Lighthouse is noisy — trust the median and report a range, not a
point. The Chrome DevTools MCP ([`.mcp.json`](.mcp.json)) is the interactive
complement for deeper traces (LCP phase breakdown, render-blocking). Full
details: [`scripts/lighthouse/README.md`](scripts/lighthouse/README.md).

## Architecture

### SDK Initialization Flow

`src/optimizely.ts` is imported in the root layout and initializes three registries:
1. **Content Type Registry** — all content type definitions from `src/content-types/`
2. **Display Template Registry** — visual display options from `src/display-templates/`
3. **React Component Registry** — maps content type keys to React components

Every new content type requires registration in all three places plus `optimizely.config.mjs`.

### Content Routing

- `src/app/[locale]/[[...slug]]/page.tsx` — Localized catch-all (en/no/sv/da) that reads CMS content via the cached `getPageContent()` (`src/lib/optimizely/get-page.ts`) and renders with `<OptimizelyComponent>`
- `src/app/preview/page.tsx` — Visual Builder preview route for in-context editing (uncached, outside the locale tree)
- `src/proxy.ts` — next-intl middleware; handles locale routing, including `/` → the default locale
- `src/app/hooks/graph/route.ts` — publish webhook (revalidation + CDN purge); see `docs/caching.md`

### Content Type Definitions (`src/content-types/`)

Each file exports a `contentType()` call with a `CT` suffix (e.g., `CardBlockCT`). Base types:
- `_page` — Page types (e.g., `ArticlePage`)
- `_experience` — Visual Builder pages (`LandingPageExperience`)
- `_component` — Blocks/elements with composition behaviors:
  - `sectionEnabled` — Can be placed in Visual Builder sections
  - `elementEnabled` — Can be placed as inline elements (restricted property types: no arrays with content, no component/json properties)

Content types are also registered as file paths (strings) in `optimizely.config.mjs` for the CMS CLI.

### Component Structure (`src/components/`)

Components are organized by their CMS role:
- `pages/` — Page type components
- `blocks/` — Reusable block components
- `elements/` — Atomic element components
- `experiences/` — Visual Builder wrappers (`BlankExperience`, `BlankSection`)
- `layout/` — Header, Footer, Logo

Barrel exports in `src/components/index.ts` must match content type keys used in `optimizely.ts` resolver.

### Component Pattern

```typescript
import { ContentProps } from '@optimizely/cms-sdk';
import { getPreviewUtils } from '@optimizely/cms-sdk/react/server';

type Props = {
  content: ContentProps<typeof SomeContentTypeCT>;
  displaySettings?: ContentProps<typeof SomeDisplayTemplate>;
};

export default function MyComponent({ content, displaySettings }: Props) {
  const { pa, src } = getPreviewUtils(content);
  // pa('propertyName') — adds preview attributes for Visual Builder editing
  // src(content.image) — returns the image URL (also resolves DAM assets, whose url.default is null)
  return <div {...pa('title')}>{content.title}</div>;
}
```

Define content types with `contentType` from `@/lib/content-type` and display
templates with `displayTemplate` from `@/lib/display-template`, not the SDK
imports directly: the wrappers add `description` support and keep display
template choices as literal types (otherwise select settings infer as `never`).

### Display Templates vs Content Type Properties

Display templates (`src/display-templates/`) define **visual styling options** (alignment, heading level) shown in the CMS sidebar. Semantic data belongs in content type properties, not display templates.

## Adding a New Content Type (Checklist)

1. Create `src/content-types/NewType.ts` — define with `contentType()`, export as `NewTypeCT`
2. Export from `src/content-types/index.ts`
3. Create component in `src/components/{pages,blocks,elements}/NewType.tsx`
4. Export from `src/components/index.ts`
5. Add to resolver map in `src/optimizely.ts`
6. Add file path to `optimizely.config.mjs` components array
7. Run `npm run cms:diff`, then `npm run cms:push-config` to sync to CMS. Types are also edited in the CMS UI, so a push can be rejected as a "breaking change" when the CMS has properties the code lacks; never `--force` over CMS-only properties without checking who added them and why.

## Environment Variables

Copy `.env.template` to `.env`. Key variables:
- `OPTIMIZELY_GRAPH_SINGLE_KEY` — Required for content fetching
- `OPTIMIZELY_CMS_URL` — CMS instance URL
- `OPTIMIZELY_GRAPH_GATEWAY` — Graph endpoint (defaults to `https://cg.optimizely.com`); handled by `src/lib/config.ts` `getGraphGatewayUrl()` which accounts for differences between local dev and Frontend Hosting runtime
- `DIAGNOSTICS_USER` / `DIAGNOSTICS_PASSWORD` — Basic Auth for `/diagnostics/*` (checked in `src/proxy.ts`); if unset, `/diagnostics` 404s. `/diagnostics/env` replaces the old `/debug` route

## Path Alias

`@/*` maps to `./src/*` (configured in tsconfig.json).

## Image Domains

Remote images allowed from `*.cms.optimizely.com` and `cdn.optimizely.com` (configured in `next.config.ts`).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
