# Environment Variables Reference

Complete guide to environment variables for Optimizely Frontend Hosting.

## Overview

Environment variables in Optimizely Frontend Hosting are used at two different times:
1. **Build time**: Available during `npm run build` or `yarn build`
2. **Runtime**: Available when the Next.js application is running

## Deployment Credentials

These authenticate the opticloud CLI against the Optimizely Cloud Deployment API. They are
**not** application variables — they never reach the running app.

All three come from **PaaS Portal > Your Frontend Project > API tab > Add API Credentials**.

| Variable | Format | Notes |
|---|---|---|
| `OPTI_PROJECT_ID` | GUID, e.g. `2a561398-d517-4634-9bc4-aab5008a8e1a` | Identifies the project |
| `OPTI_CLIENT_KEY` | String, e.g. `dxp-abc123xyz456` | API key |
| `OPTI_CLIENT_SECRET` | String | Shown **once** at creation — regenerate if lost |
| `OPTI_API_ENDPOINT` | URL | Optional; defaults to `https://paasportal.episerver.net/api/v1.0/` |

### How opticloud resolves them

1. Explicit flags — `--client-key`, `--client-secret`, `--project-id`
2. Environment variables — the `OPTI_*` names above, read from the process environment
3. OS keychain — populated by `opticloud auth:login`

**opticloud does not read `.env` files.** There is no dotenv loading; the variables must
already be in the environment. A project `.env` containing `OPTI_*` does nothing on its own
— if deployment works anyway, the keychain is what's serving the credentials.

**Local development** — authenticate once, then forget about it:

```bash
opticloud auth:login     # stores in Windows Credential Manager / macOS Keychain / libsecret
opticloud auth:status    # verify
```

**CI** — no keychain exists on a build agent, so export from secrets:

```bash
export OPTI_PROJECT_ID="..."
export OPTI_CLIENT_KEY="..."
export OPTI_CLIENT_SECRET="..."
opticloud ship ./ --type=head --target=Production --skip-validation
```

**To use a `.env` file deliberately**, load it explicitly:

```bash
node --env-file=.env node_modules/.bin/opticloud ship ./ --type=head --target=Test2
```

Credentials are scoped to selected environments when created. If `--target` reports the
environment doesn't exist, the credentials likely lack access to it.

## Automatic Runtime Variables

These variables are automatically provided by Optimizely Frontend Hosting and are available during build and runtime. You don't set these - they're injected by the platform.

### OPTIMIZELY_CMS_URL

**Purpose**: URL of the Optimizely CMS backend

**Format**: `https://app-{environment}.cms.optimizely.com/`

**Example**: `https://app-test1-myproject.cms.optimizely.com/`

**Available**: Build time and runtime

**Usage in Next.js**:
```typescript
const cmsUrl = process.env.OPTIMIZELY_CMS_URL;
```

### OPTIMIZELY_GRAPH_GATEWAY

**Purpose**: Optimizely Graph API endpoint

**Format**: **Differs between local and hosted.** In the Frontend Hosting runtime this is
the bare hostname — `https://cg.optimizely.com` — with no path to the Graph API. Locally it
is typically set to the full path, `https://cg.optimizely.com/content/v2`.

**Available**: Build time and runtime

This inconsistency is the single most common source of "works locally, 404s in production"
on this platform. The Content JS SDK needs the full path, so never read the variable
directly — normalize it, appending the path when absent. `SKILL.md` carries a
`getGraphGatewayUrl()` implementation.

```typescript
const graphEndpoint = getGraphGatewayUrl(); // not process.env.OPTIMIZELY_GRAPH_GATEWAY

const response = await fetch(graphEndpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.OPTIMIZELY_GRAPH_SECRET}`
  },
  body: JSON.stringify({ query: graphqlQuery })
});
```

An optional `OPTIMIZELY_GRAPH_PATH` (default `/content/v2`) lets the path be configured
rather than hardcoded.

### OPTIMIZELY_GRAPH_SECRET

**Purpose**: Authentication token for Optimizely Graph API

**Format**: JWT token string

**Available**: Build time and runtime

**Security**: Never expose this in client-side code. Use only in:
- Server-side code
- API routes
- `getStaticProps` / `getServerSideProps`
- Server components (Next.js 13+ App Router)

**Usage**:
```typescript
// In API route or server component
const response = await fetch(process.env.OPTIMIZELY_GRAPH_GATEWAY, {
  headers: {
    'Authorization': `Bearer ${process.env.OPTIMIZELY_GRAPH_SECRET}`
  }
});
```

### OPTIMIZELY_GRAPH_SINGLE_KEY

**Purpose**: Single-use key for Optimizely Graph access

**Format**: String

**Available**: Build time and runtime

**Usage**: Typically used for anonymous or public access to Graph content.

### OPTIMIZELY_GRAPH_APP_KEY

**Purpose**: Application key for Optimizely Graph. Identifies your application when
querying, and pairs with `OPTIMIZELY_GRAPH_SECRET` as Basic auth credentials for webhook
registration against `<gateway>/api/webhooks`.

**Format**: String

**Available**: Build time and runtime

### ISR and infrastructure variables

Also provisioned automatically, and needed once you enable ISR with a shared cache handler
and webhook-driven invalidation. None of these exist locally — code that reads them must
degrade gracefully rather than throw (fall back to an in-memory cache, make CDN purge a
no-op) so local development works unchanged.

This table is the platform's side of the contract: what exists, and what it contains. For
how to consume it — `cache-handler.mjs`, `'use cache'` / `cacheTag`, the `/hooks/graph`
route — use the `optimizely-cms-nextjs` skill.

| Variable | Purpose |
|---|---|
| `REDIS_URL` | Azure Cache for Redis hostname and port, e.g. `myredis.redis.azure.net:10000`. Hostname and port only — no scheme, no credentials. TLS (`rediss://`) is required. |
| `AZURE_CLIENT_ID` | Managed identity client ID used to authenticate to Redis and the CDN purge API |
| `OPTIMIZELY_DXP_DEPLOYMENT_ID` | Deployment slot ID. Namespaces cache keys so slots sharing a Redis instance don't collide. |
| `OPTIMIZELY_SITE_HOSTNAME` | Public hostname of the site. Used to build the webhook callback URL and CDN purge targets. |
| `OPTIMIZELY_GRAPH_CALLBACK_APIKEY` | Shared secret for authenticating **incoming** webhook requests. Validate against this in the callback handler — it is a public endpoint. |
| `OPTIMIZELY_CLOUDPLATFORM_API_URL` | Cloud Platform Services API base URL, for edge cache purge |
| `OPTIMIZELY_CLOUDPLATFORM_API_RESOURCE_ID` | Resource ID forming the managed-identity token scope (`${RESOURCE_ID}/.default`) |

Authentication to Redis and the purge API is via Azure managed identity — there are no
connection strings or passwords to store anywhere.

## Custom Application Settings

You can add custom environment variables through the PaaS Portal that will be available during build and runtime.

### How to Add Custom Variables

1. Navigate to PaaS Portal
2. Select your frontend project
3. Go to **App Settings** tab
4. Click **Add Setting**
5. Enter:
   - **Name**: Variable name (e.g., `MY_API_KEY`)
   - **Value**: Variable value
   - **Environment**: Select which environment (Test1, Test2, Production)

### Common Custom Variables

```
# External API keys
NEXT_PUBLIC_ANALYTICS_ID=GA-XXXXXXXXX
STRIPE_SECRET_KEY=sk_test_xxxxx

# Feature flags
NEXT_PUBLIC_ENABLE_FEATURE_X=true
ENABLE_DEBUG_MODE=false

# Third-party services
SENDGRID_API_KEY=SG.xxxxx
AWS_BUCKET_NAME=my-bucket

# Custom configuration
MAX_ITEMS_PER_PAGE=20
CACHE_TTL_SECONDS=3600
```

### Naming Conventions

**For Next.js public variables** (exposed to browser):
- Prefix with `NEXT_PUBLIC_`
- Example: `NEXT_PUBLIC_API_URL`

**For server-only variables**:
- No prefix required
- Never accessible from browser
- Example: `DATABASE_URL`, `API_SECRET`

## Environment Variable Priority

Variables are loaded in this order (later sources override earlier ones):

1. System environment (Optimizely-provided)
2. PaaS Portal App Settings
3. `.env.production` file (if present in package)
4. Runtime environment

**Note**: `.env` files are usually excluded via `.zipignore`, so rely on PaaS Portal for production configuration.

## Build-Time vs Runtime

### Build-Time Variables

Used during `npm run build` or `yarn build`:
```typescript
// next.config.js
module.exports = {
  env: {
    API_URL: process.env.API_URL
  }
};
```

These are **baked into the build** and cannot be changed without rebuilding.

### Runtime Variables

Available when the application is running:
```typescript
// pages/api/data.ts
export default function handler(req, res) {
  const apiKey = process.env.API_KEY; // Read at runtime
  // ...
}
```

These can be changed by updating App Settings and restarting the application.

## Best Practices

### Security

1. **Never commit secrets** to version control
2. **Use App Settings** for production secrets
3. **Prefix public variables** with `NEXT_PUBLIC_`
4. **Rotate secrets** regularly
5. **Limit API credential access** to required environments only

### Configuration Management

1. **Document all variables** your application needs
2. **Set variables BEFORE deployment** to avoid build failures
3. **Use consistent naming** across environments
4. **Validate variables** in your application startup code

### Environment-Specific Values

Different values per environment:

```
# Test1
NEXT_PUBLIC_API_URL=https://api-test.example.com

# Test2
NEXT_PUBLIC_API_URL=https://api-stage.example.com

# Production
NEXT_PUBLIC_API_URL=https://api.example.com
```

## Troubleshooting

### Variable not available during build

**Symptom**: Build fails with "undefined" error

**Solution**:
1. Add variable in PaaS Portal > App Settings
2. Wait 2-3 minutes for changes to apply
3. Start new deployment

### Variable not available at runtime

**Symptom**: Application runs but variable is undefined

**Solution**:
1. Verify variable is set in App Settings for the correct environment
2. Restart application: Troubleshoot tab > Restart Web App
3. Check variable name spelling matches exactly

### NEXT_PUBLIC_ variable not working in browser

**Symptom**: Variable is undefined in browser console

**Common causes**:
1. Variable was added after build (must rebuild)
2. Typo in variable name
3. Missing `NEXT_PUBLIC_` prefix

**Solution**: These variables must be set BEFORE build. They're embedded during build time.

### Security warning: Secret exposed in browser

**Symptom**: Seeing secrets in browser DevTools

**Cause**: Used `NEXT_PUBLIC_` prefix on a secret variable

**Solution**:
1. Remove `NEXT_PUBLIC_` prefix
2. Move secret usage to server-side code
3. Redeploy with corrected configuration
4. Rotate the exposed secret immediately

## Next.js Specific Considerations

### App Router (Next.js 13+)

Server Components can access all environment variables:
```typescript
// app/page.tsx (Server Component)
export default async function Page() {
  const secret = process.env.API_SECRET; // ✓ Works
  // ...
}
```

Client Components can only access `NEXT_PUBLIC_` variables:
```typescript
'use client';
// app/component.tsx (Client Component)
export default function Component() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL; // ✓ Works
  const secret = process.env.API_SECRET; // ✗ Undefined
}
```

### Pages Router (Next.js 12 and earlier)

Server-side functions can access all variables:
```typescript
// pages/index.tsx
export async function getServerSideProps() {
  const secret = process.env.API_SECRET; // ✓ Works
  // ...
}
```

Client-side code needs `NEXT_PUBLIC_` prefix:
```typescript
// pages/index.tsx
export default function Page() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL; // ✓ Works
}
```

## Example Configuration

### Minimal Setup

Deployment credentials: `opticloud auth:login` once. Nothing per project, nothing in `.env`.

PaaS Portal App Settings: none required — the Optimizely variables are injected
automatically.

### Full Production Setup

Local deployment credentials (same as above)

PaaS Portal App Settings (Test1):
```
NEXT_PUBLIC_ANALYTICS_ID=GA-TEST-123
NEXT_PUBLIC_API_URL=https://api-test.example.com
SENDGRID_API_KEY=SG.test_xxxxx
ENABLE_DEBUG_MODE=true
```

PaaS Portal App Settings (Production):
```
NEXT_PUBLIC_ANALYTICS_ID=GA-PROD-456
NEXT_PUBLIC_API_URL=https://api.example.com
SENDGRID_API_KEY=SG.live_xxxxx
ENABLE_DEBUG_MODE=false
```

## Reference Links

- [Next.js Environment Variables](https://nextjs.org/docs/basic-features/environment-variables)
- [Azure App Service Environment Variables](https://learn.microsoft.com/en-us/azure/app-service/reference-app-settings)
- Optimizely PaaS Portal: https://paasportal.episerver.net/
