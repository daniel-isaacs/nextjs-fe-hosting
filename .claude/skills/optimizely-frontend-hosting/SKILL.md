---
name: optimizely-frontend-hosting
description: Configure and deploy Next.js applications to Optimizely Frontend Hosting for CMS (SaaS) using the opticloud CLI. Use this skill when the user needs to (1) Deploy a Next.js app to Frontend Hosting, (2) Set up or troubleshoot opticloud (ship, auth, deployment, logs, package contents), (3) Manage deployment credentials and the build-time/runtime variables the platform injects, or (4) Diagnose failed, stuck, or stale deployments. Covers the hosting-level constraints on ISR (multi-instance architecture, why a shared cache handler is mandatory, which variables the platform provisions) but NOT its implementation — defer cache-handler.mjs, 'use cache'/cacheTag, revalidation webhooks, and CDN purge wiring to the optimizely-cms-nextjs skill. This skill is specifically for Optimizely SaaS CMS, not CMS 12 (PaaS).
---

# Optimizely Frontend Hosting

Deploy and manage Next.js applications on Optimizely Frontend Hosting for CMS (SaaS).

## Overview

Optimizely Frontend Hosting runs headless Next.js applications against an Optimizely CMS (SaaS) backend. It provides managed environments (Test1, Test2, Production) on Azure, with CDN and WAF powered by Cloudflare.

**Key characteristics:**
- Next.js only — SSG, SSR, **and ISR** (see below)
- Managed environments integrated with CMS (SaaS)
- Automatic CDN and WAF configuration
- Deployment is source-based: you ship source, the platform runs `npm install` + `npm run build`

**ISR is supported.** Earlier platform versions did not support it; guidance saying
otherwise is out of date.

One hosting-level constraint shapes everything downstream: Frontend Hosting runs **multiple
application instances behind a load balancer**, and Next.js's default ISR cache lives on the
local filesystem — per instance. Revalidating on one replica leaves the others stale, and
which replica a visitor hits is arbitrary. The symptom is content that updates, then reverts
on refresh.

ISR therefore requires a **shared cache handler**. The platform provisions Redis for this,
along with `REDIS_URL`, `AZURE_CLIENT_ID`, and `OPTIMIZELY_DXP_DEPLOYMENT_ID` — see
`references/environment-variables.md`.

**Implementing it belongs to the `optimizely-cms-nextjs` skill, not this one.**
`cache-handler.mjs`, `'use cache'` / `cacheLife` / `cacheTag`, the `/hooks/graph`
revalidation webhook, and CDN purge wiring are application-layer concerns. Invoke that
skill for them. This skill's scope is the platform constraint above and the variables the
platform injects.

## Deploying: use the opticloud CLI

Deployments go through [`@kunalshetye/opticloud`](https://github.com/kunalshetye/opticloud),
a cross-platform Node CLI for the DXP Cloud deployment API. Its `ship` command collapses
the whole workflow — package, upload, deploy, monitor, complete — into one command, and
handles the details that used to be manual footguns: package naming, ZIP root structure,
`.zipignore` handling, and deployment polling.

```bash
npx @kunalshetye/opticloud ship ./ --type=head --prefix=mysite --target=Test2
```

**Prefer `ship` over the individual commands.** Reach for `package:create` /
`package:upload` / `deployment:start` only when a step needs to be inspected or retried
in isolation.

> opticloud is a community project under MIT license, not an Optimizely product.
> Optimizely Support will not troubleshoot it — platform-side issues (build failures,
> environment locks) are supported; CLI bugs go to its GitHub issues.

The legacy path was the PowerShell `EpiCloud` module (`Connect-EpiCloud`,
`Start-EpiDeployment`). It still works and the two are API-compatible, but it is
Windows-centric and requires hand-rolling package creation. Only fall back to it if
opticloud itself is broken; `references/deployment-guide.md` carries the command mapping.

## Workflow Decision Tree

**User says "Deploy" / "Ship to Test2":**
1. Confirm credentials are available — `opticloud auth:status`
2. Confirm the target env's app settings are populated (a missing variable fails the build)
3. Run `opticloud ship <dir> --type=head --prefix=<name> --target=<env>`
4. Read `references/deployment-guide.md` if any step needs detail

**User says "Set up frontend hosting":**
1. Obtain API credentials — PaaS Portal > API tab (`references/deployment-guide.md` step 1)
2. `opticloud auth:login` to store them in the OS keychain
3. Ensure `package.json` has `build` and `start` scripts (`assets/package.json.template`)
4. Create `.zipignore` from `assets/.zipignore.template`
5. Set runtime variables in PaaS Portal > App Settings (`references/environment-variables.md`)

**User asks about ISR / caching / stale content:**
1. Check a shared cache handler is configured — without one, ISR is per-replica (see above)
2. For implementation, hand off to the `optimizely-cms-nextjs` skill
3. `references/troubleshooting.md` covers the deployment-side symptoms

**User encounters deployment errors:**
1. Read `references/troubleshooting.md`
2. `opticloud deployment:logs <id>` for the platform-side failure
3. `opticloud deployment:reset <id>` if an environment is stuck

## Credentials

opticloud resolves credentials in this order:

1. Explicit flags — `--client-key`, `--client-secret`, `--project-id`
2. Environment variables — `OPTI_CLIENT_KEY`, `OPTI_CLIENT_SECRET`, `OPTI_PROJECT_ID`
3. OS keychain — populated by `opticloud auth:login`

**opticloud does not read `.env` files.** It has no dotenv loading; the `OPTI_*` variables
must already be in the process environment. Storing them in a project `.env` and expecting
`opticloud ship` to pick them up silently falls through to the keychain — which usually
works, and so hides the misconception until it runs somewhere without a keychain (CI).

- **Local development**: `opticloud auth:login` once. Nothing to configure per project.
- **CI**: export `OPTI_*` from secrets, and add `--skip-validation` to avoid a needless
  credential round-trip on every run.

Credentials come from **PaaS Portal > API tab** for your frontend project. See
`references/environment-variables.md` for the full variable reference.

## Project Configuration

**`package.json`** must have `build` and `start` — the platform runs them during deployment:

```json
{
  "scripts": {
    "build": "next build",
    "start": "next start"
  }
}
```

**`.zipignore`** controls what gets packaged. opticloud excludes some things by default
(`node_modules/`, `.git/`, `.env`, `.DS_Store`), but **do not rely on that for secrets** —
the built-in list does not cover every shape a secret takes (`.env.template` with real
values filled in, `certificates/`, local credential dumps). Keep an explicit `.zipignore`
and verify it. Syntax is identical to `.gitignore`, including negation.

See `assets/.zipignore.template`.

## Target Environments

For **SaaS Frontend Hosting**: `Test1`, `Test2`, `Production`

For **PaaS hosting** (CMS 12): `Integration`, `Preproduction`, `Production`

`ship` does not validate `--target` — the string is forwarded to the deployment API as
typed. A wrong or misspelled environment surfaces as an API error partway through, after
the package has already been built and uploaded, so use the exact name.

## Runtime Environment Variables

These are injected by the platform and available at build time and runtime:

- `OPTIMIZELY_CMS_URL` — CMS backend URL
- `OPTIMIZELY_GRAPH_GATEWAY` — Optimizely Graph endpoint
- `OPTIMIZELY_GRAPH_SECRET` — Graph authentication secret
- `OPTIMIZELY_GRAPH_SINGLE_KEY` — Graph single key
- `OPTIMIZELY_GRAPH_APP_KEY` — Graph app key

**Gotcha — `OPTIMIZELY_GRAPH_GATEWAY` differs between local and hosted.** In the Frontend
Hosting runtime it is the bare hostname (`https://cg.optimizely.com`), with no path to the
Graph API. Locally it typically includes the full path (`https://cg.optimizely.com/content/v2`).
The Content JS SDK needs the full path, so normalize it rather than reading the variable
directly:

```typescript
const DEFAULT_GRAPH_PATH = "/content/v2";

/**
 * Returns the Optimizely Graph gateway URL with the full path.
 *
 * In production (Frontend Hosting), the env var may be set to just the base URL:
 *   "https://cg.optimizely.com"
 *
 * Locally it includes the full path:
 *   "https://cg.optimizely.com/content/v2"
 *
 * This function ensures the full path is always present.
 * The path can be configured via OPTIMIZELY_GRAPH_PATH env var.
 */
export function getGraphGatewayUrl(): string {
  const gateway = process.env.OPTIMIZELY_GRAPH_GATEWAY;
  const graphPath = process.env.OPTIMIZELY_GRAPH_PATH || DEFAULT_GRAPH_PATH;

  if (!gateway) {
    throw new Error("OPTIMIZELY_GRAPH_GATEWAY environment variable is not set");
  }

  // If the gateway already ends with the path, return as-is
  if (gateway.endsWith(graphPath)) {
    return gateway;
  }

  // Remove trailing slash if present, then append the path
  const baseUrl = gateway.replace(/\/+$/, "");
  return `${baseUrl}${graphPath}`;
}
```

Used as:

```typescript
const client = new GraphClient(process.env.OPTIMIZELY_GRAPH_SINGLE_KEY!, {
  graphUrl: getGraphGatewayUrl(),
});
```

Additional app settings are configured through the Management Portal UI.

## Common Tasks

```bash
# Who am I / are credentials valid
opticloud auth:status

# Deploy
opticloud ship ./ --type=head --prefix=mysite --target=Test2

# Preserve the package instead of using a temp dir (auditing, rollback, debugging)
opticloud ship ./ --type=head --prefix=mysite --target=Test2 --output=./packages

# Watch deployments
opticloud deployment:list --watch

# Diagnose a failure
opticloud deployment:logs <deployment-id> --errors-only

# Unstick an environment
opticloud deployment:reset <deployment-id>

# Machine-readable output for scripting
opticloud ship ./ --type=head --target=Test2 --json
```

## Additional Resources

- **references/deployment-guide.md**: Credentials, the ship workflow, CI/CD, EpiCloud mapping
- **references/troubleshooting.md**: Failure modes and how to diagnose them
- **references/environment-variables.md**: Full variable reference, build-time vs runtime
- **assets/.zipignore.template**: Starting point for package exclusions
- **assets/package.json.template**: Minimal Next.js package.json for Frontend Hosting
