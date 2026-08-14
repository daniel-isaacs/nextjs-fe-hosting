# Troubleshooting Guide

Failure modes when deploying Next.js applications to Optimizely Frontend Hosting with
opticloud.

## First: get the actual error

Deployment failures are almost always platform-side (the build), not CLI-side. The CLI's
output tells you the deployment failed; the deployment logs tell you why.

```bash
# Find the deployment
opticloud deployment:list

# The real error
opticloud deployment:logs <deployment-id> --errors-only

# Full log — build output, warnings, progress
opticloud deployment:logs <deployment-id>
```

Also available in the PaaS Portal under the **Deployment** tab. Don't start changing
configuration before reading these.

## Handled automatically — no longer your problem

These were the classic manual-deployment failures. `opticloud package:create` and `ship`
handle all of them; if you hit one of these symptoms, something unusual is going on, not
the old known issue.

- **ZIP root structure** — `package.json` at the archive root, not nested in a folder
- **Package naming** — the `.head.app.` segment that distinguishes frontend from .NET packages
- **Special directory names** — route groups `(marketing)` and dynamic segments `[slug]`,
  `[...catchAll]` are packaged correctly
- **`node_modules` / `.next` exclusion** — excluded by default, keeping packages at ~5–20 MB
  instead of ~300–500 MB

## Build failures

### "Environment variable ... is not defined"

The deployment triggers a production build immediately. A build that reads a missing
variable fails, and the environment can stay locked.

1. **PaaS Portal > App Settings** for the target environment
2. Add the variable
3. Wait 2–3 minutes for settings to propagate
4. Redeploy

Set every variable the build needs *before* the first deployment. If the environment is
locked, `opticloud deployment:reset <id>`.

### "Module not found" / "Cannot find package"

The lock file is missing from the package, or a dependency is only installed locally.

- Confirm `package-lock.json` / `yarn.lock` is not excluded by `.zipignore`
- Confirm the dependency is in `dependencies`, not `devDependencies`, if it's needed at
  runtime — the platform may prune dev dependencies
- Reproduce locally with a clean install: `rm -rf node_modules && npm ci && npm run build`

### "Build script not found"

`package.json` needs both:

```json
{
  "scripts": {
    "build": "next build",
    "start": "next start"
  }
}
```

### Build timeout (>20 minutes)

Usually a build that hangs rather than one that's genuinely slow. Check for something
awaiting a network call that never resolves — a CMS or Graph fetch during static generation
pointed at an unreachable host is the common cause, especially if the variable it reads is
unset in that environment.

### Build succeeds locally, fails on the platform

Almost always an environment difference:

- Case-sensitive imports — the platform is Linux, Windows and macOS are not. `import Card
  from './card'` resolving to `Card.tsx` works locally and fails there.
- Node version mismatch — pin with `engines` in `package.json`
- A variable present in your local `.env` but never added to App Settings

## Authentication failures

```bash
# Is anything stored, and is it valid?
opticloud auth:status

# Re-authenticate
opticloud auth:logout
opticloud auth:login
```

### Works locally, fails in CI

The usual cause. opticloud reads credentials from flags, then `OPTI_*` environment
variables, then the OS keychain — **it never reads `.env` files**. Locally you're being
served by the keychain; a build agent has no keychain, and a `.env` in the repo does not
substitute for one.

Export the variables from CI secrets, or pass `--client-key` / `--client-secret` /
`--project-id` explicitly.

### "Target environment not found"

The credentials don't grant access to that environment. API credentials are scoped to
selected environments at creation time in **PaaS Portal > API tab** — regenerate with the
right environments selected. Also verify the name: `Test1`, `Test2`, `Production` for SaaS
Frontend Hosting.

## Deployment failures

### Environment is locked / a deployment is stuck

Usually a deployment genuinely in progress — wait for it. If it's wedged:

```bash
opticloud deployment:list                # find the deployment ID and state
opticloud deployment:reset <id>          # roll back to the previous state
```

Reset returns the environment to its prior state. Nothing is partially applied — a failed
deployment leaves the environment as it was.

### "Package already exists"

A package with that name exists with different content. Names are
`[prefix.]head.app.[version].zip`, and the default version is a timestamp, so this only
happens with an explicit `--version`. Bump it, or drop `--version` to get a fresh timestamp.

### Upload fails or stalls

Check package size — if it's over ~50 MB, something that should be excluded isn't:

```bash
opticloud package:create ./ --type=head --output=./packages
unzip -l ./packages/*.zip | tail -5
```

Look for `node_modules`, `.next`, media, or a stray `.git` directory, and add them to
`.zipignore`.

## Secrets in the package

opticloud excludes `.env` and `.env.local` by default but that is a convenience, not a
security boundary. It will happily package `.env.template` with real values filled in,
`certificates/`, `*.pem`, or a credential dump someone left in the repo root.

Audit the artifact rather than assuming:

```bash
opticloud package:create ./ --type=head --output=./packages
unzip -l ./packages/*.zip | grep -iE '\.env|secret|credential|\.pem|\.key|certificate'
```

If a secret has already shipped, rotate it — a deployed package is not retrievable but it
did reach the platform.

## Runtime issues

### Application doesn't start

1. **PaaS Portal > Troubleshoot > Application Logs**
2. Verify `"start": "next start"` in `package.json`
3. Check for a variable that's present at build but missing at runtime

### Environment variables undefined at runtime

1. Verify the variable is set for the *correct environment* in App Settings
2. Restart: **Troubleshoot > Restart Web App**
3. Check the exact spelling

`NEXT_PUBLIC_*` variables are a different case — they're inlined at **build** time, so
adding one after a build has no effect until you redeploy.

### Content is stale, or updates then reverts

An ISR configuration problem, not a deployment problem. The usual cause is ISR without a
shared cache handler, so each replica holds its own cache and you see whichever one the
load balancer picked. Confirm `REDIS_URL` is set in the environment and that the app is
actually connecting to it rather than silently falling back to in-memory.

For the fix, use the `optimizely-cms-nextjs` skill — cache handler and revalidation wiring
are application-layer concerns.

### CDN serving old content

**PaaS Portal > Troubleshoot > Purge Cache** for a manual purge. Automating it from the
publish webhook is covered by the `optimizely-cms-nextjs` skill.

To confirm the CDN is the layer at fault, request the page with a cache-busting query
string. Fresh content means the origin is fine and the edge is stale.

### Visual Builder shows nothing

The hostname mapping is missing:

1. **CMS > Settings > Applications** — select your application
2. **Hostnames** — add the hostname from the PaaS Portal
3. **Settings > Scheduled jobs** — reindex content

## Debugging opticloud itself

```bash
DEBUG=opticloud* opticloud ship ./ --type=head --target=Test2
```

opticloud is a community MIT project, not an Optimizely product. Platform issues go to
Optimizely Support; CLI bugs go to https://github.com/kunalshetye/opticloud/issues.

## Pre-deployment checklist

- [ ] `opticloud auth:status` succeeds
- [ ] All required variables set in App Settings for the target environment
- [ ] `package.json` has `build` and `start`
- [ ] Lock file present and not excluded by `.zipignore`
- [ ] `npm ci && npm run build` passes locally from a clean `node_modules`
- [ ] Package audited for secrets
- [ ] No other deployment in flight for this project

## Contacting support

For platform-side issues, gather: project ID, environment name, deployment ID, and the
output of `opticloud deployment:logs <id>`. Contact Optimizely Support through the PaaS
Portal.
