import { Suspense } from 'react';
import { connection } from 'next/server';
import { getGraphGatewayUrl } from '@/lib/config';

export const metadata = {
  title: 'Environment',
};

// Shows which environment variables the running instance actually has —
// useful on Frontend Hosting, where most of them are injected by the
// platform. Values are classified per variable: public ones are shown as-is,
// secrets are masked to their first and last four characters, and tenant
// identifiers only show whether they're set. Variables not listed below are
// shown by name only. Don't promote a variable to a
// less-masked group without checking what its value contains.
//
// Must render per request: without `connection()` the page would be
// prerendered and show the build container's environment, not the runtime's.

type Kind = 'public' | 'masked' | 'presence';
type Row = { name: string; kind: Kind; note?: string };
type Group = { title: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: 'Optimizely Graph (content delivery)',
    rows: [
      { name: 'OPTIMIZELY_GRAPH_GATEWAY', kind: 'public' },
      { name: 'OPTIMIZELY_GRAPH_PATH', kind: 'public' },
      { name: 'OPTIMIZELY_GRAPH_SINGLE_KEY', kind: 'masked' },
    ],
  },
  {
    title: 'Graph webhook (registration and receiver)',
    rows: [
      { name: 'OPTIMIZELY_GRAPH_APP_KEY', kind: 'masked' },
      { name: 'OPTIMIZELY_GRAPH_SECRET', kind: 'masked' },
      { name: 'OPTIMIZELY_GRAPH_CALLBACK_APIKEY', kind: 'masked' },
      { name: 'OPTIMIZELY_SITE_HOSTNAME', kind: 'public', note: 'The webhook URL and CDN purges are built from this' },
    ],
  },
  {
    title: 'CMS',
    rows: [
      { name: 'OPTIMIZELY_CMS_URL', kind: 'public' },
      { name: 'OPTIMIZELY_CMS_CLIENT_ID', kind: 'masked' },
      { name: 'OPTIMIZELY_CMS_CLIENT_SECRET', kind: 'masked' },
    ],
  },
  {
    title: 'Site',
    rows: [
      { name: 'NEXT_PUBLIC_SITE_URL', kind: 'public' },
      { name: 'NEXT_PUBLIC_SITE_NAME', kind: 'public' },
    ],
  },
  {
    title: 'Frontend Hosting runtime (cache handler, CDN purge)',
    rows: [
      { name: 'OPTIMIZELY_DXP_DEPLOYMENT_ID', kind: 'masked', note: 'Namespaces the Redis cache keys' },
      { name: 'AZURE_CLIENT_ID', kind: 'masked', note: 'Managed identity for Redis and the purge API' },
      { name: 'REDIS_URL', kind: 'masked' },
      { name: 'OPTIMIZELY_CLOUDPLATFORM_API_URL', kind: 'public' },
      { name: 'OPTIMIZELY_CLOUDPLATFORM_API_RESOURCE_ID', kind: 'masked' },
    ],
  },
  {
    title: 'Observability',
    rows: [
      { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', kind: 'masked' },
      { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', kind: 'public' },
    ],
  },
  {
    title: 'Diagnostics access',
    rows: [
      { name: 'DIAGNOSTICS_USER', kind: 'presence' },
      { name: 'DIAGNOSTICS_PASSWORD', kind: 'presence' },
    ],
  },
  {
    title: 'Process',
    rows: [
      { name: 'NODE_ENV', kind: 'public' },
      { name: 'NEXT_RUNTIME', kind: 'public' },
    ],
  },
];

function display(value: string | undefined, kind: Kind): string {
  if (!value) return '(not set)';
  if (kind === 'public') return value;
  if (kind === 'presence') return '(set)';
  if (value.length <= 8) return '***' + value.slice(-2);
  return value.slice(0, 4) + '***' + value.slice(-4);
}

async function EnvTable() {
  await connection();

  let resolvedGateway: string;
  try {
    resolvedGateway = getGraphGatewayUrl();
  } catch (err) {
    resolvedGateway = `(error: ${err instanceof Error ? err.message : String(err)})`;
  }

  return (
    <div className="space-y-8">
      <p className="text-sm text-gray-600">
        Rendered at <code>{new Date().toISOString()}</code>. Resolved Graph endpoint:{' '}
        <code>{resolvedGateway}</code>
      </p>
      {GROUPS.map((group) => (
        <section key={group.title}>
          <h2 className="text-lg font-semibold mb-2">{group.title}</h2>
          <table className="w-full text-sm border border-gray-200">
            <tbody>
              {group.rows.map((row) => {
                const value = process.env[row.name];
                return (
                  <tr key={row.name} className="border-t border-gray-200 align-top">
                    <td className="p-2 font-mono w-1/2">
                      {row.name}
                      {row.note && <div className="font-sans text-xs text-gray-500 mt-1">{row.note}</div>}
                    </td>
                    <td className={`p-2 font-mono break-all ${value ? '' : 'text-gray-400'}`}>
                      {display(value, row.kind)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
      <OtherVariables />
    </div>
  );
}

// Everything the instance has that isn't in GROUPS, by name only — values are
// never shown, since nothing is known about what they contain. Use it to spot
// variables the platform injects; promote one into GROUPS to see its value.
function OtherVariables() {
  const known = new Set(GROUPS.flatMap((group) => group.rows.map((row) => row.name)));
  const names = Object.keys(process.env)
    .filter((name) => !known.has(name))
    .sort();

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Other variables (names only)</h2>
      <p className="font-mono text-sm break-all">{names.join(', ')}</p>
    </section>
  );
}

export default function EnvPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-10 space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Environment</h1>
        <p className="text-gray-600 mt-2 text-sm leading-relaxed">
          Environment variables as seen by this running instance. Secrets are masked.
        </p>
      </header>
      <Suspense fallback={<div className="text-sm text-gray-500">Reading environment…</div>}>
        <EnvTable />
      </Suspense>
    </div>
  );
}
