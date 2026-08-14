# Deployment Guide

Deploying a Next.js application to Optimizely Frontend Hosting with the
[`@kunalshetye/opticloud`](https://github.com/kunalshetye/opticloud) CLI.

## Prerequisites

1. **Next.js application** with `build` and `start` scripts in `package.json`
2. **API credentials** — Project ID, Client Key, Client Secret from the PaaS Portal
3. **Node.js 18+** — opticloud is a Node CLI and runs on Windows, macOS, and Linux

No PowerShell, no EpiCloud module.

### Installing opticloud

| Approach | Command | When |
|---|---|---|
| Project devDependency | `npm i -D @kunalshetye/opticloud` | **Preferred.** Pins the version, so the CLI can't change under you between deploys. Wrap it in an npm script. |
| npx, no install | `npx @kunalshetye/opticloud <cmd>` | CI, or a one-off deployment |
| Global | `npm i -g @kunalshetye/opticloud` | Convenience across many projects; version drifts silently |

As a devDependency it costs a little install time on the platform build unless dev
dependencies are pruned — a fair trade for a pinned deployment tool. Note that opticloud is
pre-1.0, so `^0.0.x` resolves to an exact version under npm's semver rules; upgrades are
deliberate.

## Step 1: Obtain API credentials

1. Log into your Optimizely CMS
2. Navigate to **Product Access** > **Developer Portal (frontend)** > **Details** tab
3. Confirm **Opti ID Enabled** is selected
4. Go to **Admin Center** > **Users** > {your user} > **Add Product Access**
5. Ensure you have **Power User** access to the **Developer portal (front end)** product
6. Click **Developer Portal** from the top navigation, or go to https://paasportal.episerver.net/
7. Navigate to the **API** tab
8. Click **Add API Credentials**
9. Select the environments you want to deploy to (Test1, Test2, Production)
10. Copy the Project ID, Client Key, and Client Secret

The Client Secret is displayed **once**. If you lose it, generate new credentials.

## Step 2: Authenticate

```bash
opticloud auth:login
```

Prompts for Client Key, Client Secret, and Project ID, then stores them in the OS keychain
(Credential Manager on Windows, Keychain on macOS, libsecret on Linux). One-time setup —
it is not per project.

```bash
# Verify
opticloud auth:status

# Replace credentials
opticloud auth:logout && opticloud auth:login
```

### Credential resolution order

1. Explicit flags — `--client-key`, `--client-secret`, `--project-id`
2. Environment variables — `OPTI_CLIENT_KEY`, `OPTI_CLIENT_SECRET`, `OPTI_PROJECT_ID`
3. OS keychain

**opticloud does not load `.env` files.** The `OPTI_*` variables are read from the process
environment. Putting them in a project `.env` does nothing on its own — if deployment still
works, it is falling through to the keychain. That distinction stays invisible until the
same command runs somewhere without a keychain, such as CI.

To use a `.env` file deliberately, load it explicitly:

```bash
node --env-file=.env node_modules/.bin/opticloud ship ./ --type=head --target=Test2
```

## Step 3: Prepare the project

### Required scripts

```json
{
  "scripts": {
    "build": "next build",
    "start": "next start"
  }
}
```

The platform runs `npm install` then `build` during deployment, and `start` to serve.

### Create `.zipignore`

Controls what goes into the package. Same syntax as `.gitignore`, including negation
(`!keep-this.json`). See `assets/.zipignore.template`.

opticloud already excludes `node_modules/`, `.git/`, `.env`, `.env.local`, and `.DS_Store`
by default (it keeps `.env.example`). **Do not treat that as your secret-exclusion
strategy** — the built-in list is a convenience, not a security boundary, and misses things
like a `.env.template` with real values filled in, `certificates/`, or local credential
dumps. Write them into `.zipignore` explicitly.

Verify before shipping:

```bash
# Create the package without deploying, then inspect it
opticloud package:create ./ --type=head --prefix=mysite --output=./packages
unzip -l ./packages/mysite.head.app.*.zip | grep -iE '\.env|secret|credential|\.pem|\.key'
```

### Lock file

Include `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` in the package. Without one,
the platform resolves dependencies fresh at build time and you lose build reproducibility.

## Step 4: Set environment variables in the portal

Before the first deploy, populate **PaaS Portal > App Settings** for the target
environment. The deployment triggers a production build immediately, and a build that
references a missing variable fails — sometimes leaving the environment locked.

Optimizely's own variables (`OPTIMIZELY_GRAPH_*`, `OPTIMIZELY_CMS_URL`, `REDIS_URL`, and
friends) are injected automatically. You only add your own.

Settings take a few minutes to apply. See `references/environment-variables.md`.

## Step 5: Ship

```bash
opticloud ship ./ --type=head --prefix=mysite --target=Test2
```

`ship` runs the whole workflow: creates the package, uploads it, starts the deployment,
polls for progress, and completes it when ready.

### Required parameters

| Parameter | Description |
|---|---|
| `<directory>` | Source directory to package (positional) |
| `--target` / `-t` | Target environment: `Test1`, `Test2`, `Production` |
| `--type` | Package type — `head` for frontend applications |

`--type` also accepts `cms`, `commerce`, and `sqldb`; those are PaaS/CMS 12 concerns. A
Next.js frontend is always `head`.

### Useful options

| Option | Effect |
|---|---|
| `--prefix` / `-p` | Package name prefix, for organizing packages |
| `--version` / `-v` | Package version (defaults to a `YYYYMMDDHHMMSS` timestamp) |
| `--output` / `-o` | Keep the package in a directory instead of a temp dir |
| `--poll-interval` | Seconds between status checks (default 10, range 5–300) |
| `--skip-validation` | Skip the credential pre-check — faster startup, good for CI |
| `--continue-on-errors` | Keep watching after errors are reported |
| `--json` | Machine-readable output |

### Package naming

opticloud generates `[prefix.]head.app.[version].zip` automatically — for example
`mysite.head.app.20250713092332.zip`. The `.head.app.` segment is what tells the platform
this is a frontend package rather than a .NET one; getting it wrong used to be a common
manual-deployment failure, and is now handled for you.

### Package storage

By default packages go to the system temp directory and are deleted after a successful
deployment. Pass `--output=./packages` to keep them — worth doing for production
deployments, so you have an exact artifact to redeploy for a rollback.

You cannot upload two packages with the same name and different content. Since the default
version is a timestamp, this only bites when you pass an explicit `--version`.

## Step 6: Monitor

`ship` streams status automatically: `InProgress` → `AwaitingVerification` → `Succeeded`.

```bash
# All deployments
opticloud deployment:list

# Live
opticloud deployment:list --watch --poll-interval=15

# One deployment
opticloud deployment:list --deployment-id=<id>

# Platform-side logs — the build output lives here
opticloud deployment:logs <id>
opticloud deployment:logs <id> --errors-only

# Attach to a deployment already in flight
opticloud deployment:watch <id>
```

Deployments typically take 5–10 minutes, depending on package size, dependency count, and
build complexity.

## Step 7: Post-deployment configuration

After the first deployment:

1. **CMS > Settings > Import Data** — import the content model
2. **CMS > Settings > Applications** — create an application
3. **Settings > Applications > {your app} > Hostnames** — add the hostname from the PaaS
   Portal (e.g. `test1-myapp.cms.optimizely.com`)
4. **Settings > Scheduled jobs** — reindex content into Optimizely Graph

Without the hostname mapping, Visual Builder cannot resolve the frontend and renders
nothing.

## CI/CD

Credentials come from environment variables; there is no keychain on a build agent.

```yaml
- name: Deploy to Frontend Hosting
  env:
    OPTI_PROJECT_ID: ${{ secrets.DXP_PROJECT_ID }}
    OPTI_CLIENT_KEY: ${{ secrets.DXP_CLIENT_KEY }}
    OPTI_CLIENT_SECRET: ${{ secrets.DXP_CLIENT_SECRET }}
  run: |
    npx @kunalshetye/opticloud ship ./ \
      --type=head \
      --prefix=mysite \
      --version=${{ github.sha }} \
      --target=Production \
      --skip-validation \
      --json
```

Or pass them as flags (`--client-key=$DXP_CLIENT_KEY`) if your CI system prefers that.

`--json` emits `{ success, deploymentId, packagePath }` for downstream steps. The CLI works
on any platform with Node — GitLab CI, Azure DevOps, Jenkins, CircleCI.

### Multi-environment with a consistent version

```bash
VERSION=$(date +%Y%m%d)
opticloud ship ./ --type=head --prefix=mysite --version=$VERSION --target=Test1
opticloud ship ./ --type=head --prefix=mysite --version=$VERSION --target=Test2
opticloud ship ./ --type=head --prefix=mysite --version=$VERSION --target=Production
```

Deploy to one environment at a time and let each finish — concurrent deployments to the
same project contend for the same lock.

## Individual commands

`ship` is the recommended path. Use the discrete commands when a step needs isolating —
inspecting a package before upload, or retrying a deployment against an already-uploaded
package.

```bash
opticloud package:create ./ --type=head --prefix=mysite --version=1.0.0
opticloud package:upload ./mysite.head.app.1.0.0.zip
opticloud package:list

opticloud deployment:start --target=Test2 --packages=mysite.head.app.1.0.0.zip --watch
opticloud deployment:complete <id>
opticloud deployment:reset <id>
```

## Legacy: EpiCloud PowerShell module

The predecessor was the `EpiCloud` PowerShell module. It still works and hits the same API,
so packages and deployments are interchangeable. It requires Windows PowerShell in
practice, and package creation is manual — which is where most of the historical failure
modes came from.

| EpiCloud | opticloud |
|---|---|
| `Connect-EpiCloud` | `auth:login` |
| `Get-EpiDeployment` | `deployment:list` |
| `Start-EpiDeployment` | `deployment:start` |
| `Complete-EpiDeployment` | `deployment:complete` |
| `Reset-EpiDeployment` | `deployment:reset` |
| `Add-EpiDeploymentPackage` | `package:upload` |
| *(manual ZIP creation)* | `package:create` |
| *(the whole sequence)* | **`ship`** |
| `Start-EpiDatabaseExport` | `database:export` |
| `Get-EpiEdgeLogLocation` | `logs:edge` |

Only fall back to EpiCloud if opticloud itself is broken.

## Next steps

- `references/troubleshooting.md` — failure modes and diagnosis
- `references/environment-variables.md` — full variable reference
- The `optimizely-cms-nextjs` skill — ISR implementation, cache handler, revalidation webhook
