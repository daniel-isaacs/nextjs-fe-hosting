import { Suspense } from 'react';
import { connection } from 'next/server';
// The shared cache handler at the repo root. This route gets its own copy of
// the module (and its own Redis connection); only its helpers are used here.
import { cacheSettings, getCluster } from '../../../../cache-handler.mjs';

export const metadata = {
  title: 'Redis cache',
};

// What the shared Redis cache holds: memory use and eviction policy per node,
// and how many keys each deployment's prefix has, with a TTL sample. Each
// deployment writes under its own prefix (nextjs:<OPTIMIZELY_DXP_DEPLOYMENT_ID>:),
// so prefixes other than the current one are leftovers waiting to expire.
//
// Scans at most SCAN_LIMIT keys per node and checks the TTL of at most
// TTL_SAMPLE keys per prefix, so it stays cheap on a large cache. Must render
// per request (connection()), like the other diagnostics pages.

const SCAN_LIMIT = 50_000;
const TTL_SAMPLE = 200;

type NodeInfo = { address: string; usedMemory: string; maxMemory: string; policy: string; keys: number };
type PrefixInfo = { prefix: string; keys: number; sampled: number; noTtl: number; avgTtlHours: number | null };
type Report =
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; nodes: NodeInfo[]; prefixes: PrefixInfo[]; scanned: number; truncated: boolean };

function infoField(info: string, field: string): string {
  return info.match(new RegExp(`^${field}:(.*)$`, 'm'))?.[1]?.trim() ?? '?';
}

// The deployment ID is masked like the other platform identifiers.
function maskPrefix(prefix: string): string {
  const match = prefix.match(/^nextjs:(.*):$/);
  if (!match || match[1].length <= 8) return prefix;
  return `nextjs:${match[1].slice(0, 4)}***${match[1].slice(-4)}:`;
}

async function buildReport(): Promise<Report> {
  if (!process.env.REDIS_URL) return { status: 'unavailable', reason: 'REDIS_URL is not set (local dev uses the in-memory cache)' };
  const cluster = await getCluster();
  if (!cluster) return { status: 'unavailable', reason: 'Could not connect to Redis (see the [cache] log lines)' };

  const nodes: NodeInfo[] = [];
  const keysByPrefix = new Map<string, string[]>();
  const counts = new Map<string, number>();
  let scanned = 0;
  let truncated = false;

  for (const master of cluster.masters) {
    const client = await cluster.nodeClient(master);
    const info: string = await client.info('memory');
    nodes.push({
      address: `${master.host}:${master.port}`,
      usedMemory: infoField(info, 'used_memory_human'),
      maxMemory: infoField(info, 'maxmemory_human'),
      policy: infoField(info, 'maxmemory_policy'),
      keys: await client.dbSize(),
    });

    let scannedOnNode = 0;
    for await (const batch of client.scanIterator({ MATCH: 'nextjs:*', COUNT: 1000 })) {
      for (const key of batch as string[]) {
        const prefix = key.match(/^nextjs:[^:]*:/)?.[0] ?? 'nextjs:(other)';
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
        const sample = keysByPrefix.get(prefix) ?? [];
        if (sample.length < TTL_SAMPLE) sample.push(key);
        keysByPrefix.set(prefix, sample);
      }
      scannedOnNode += (batch as string[]).length;
      if (scannedOnNode >= SCAN_LIMIT) {
        truncated = true;
        break;
      }
    }
    scanned += scannedOnNode;
  }

  const prefixes: PrefixInfo[] = [];
  for (const [prefix, keys] of counts) {
    const ttls: number[] = await Promise.all((keysByPrefix.get(prefix) ?? []).map((key) => cluster.ttl(key)));
    const withTtl = ttls.filter((ttl) => ttl > 0);
    prefixes.push({
      prefix,
      keys,
      sampled: ttls.length,
      noTtl: ttls.filter((ttl) => ttl === -1).length,
      avgTtlHours: withTtl.length ? withTtl.reduce((a, b) => a + b, 0) / withTtl.length / 3600 : null,
    });
  }
  prefixes.sort((a, b) => b.keys - a.keys);
  return { status: 'ok', nodes, prefixes, scanned, truncated };
}

async function RedisReport() {
  await connection();
  let report: Report;
  try {
    report = await buildReport();
  } catch (err) {
    report = { status: 'unavailable', reason: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (report.status === 'unavailable') {
    return <p className="text-sm text-gray-600">{report.reason}</p>;
  }

  return (
    <div className="space-y-8">
      <p className="text-sm text-gray-600">
        Rendered at <code>{new Date().toISOString()}</code>. Current prefix{' '}
        <code>{maskPrefix(cacheSettings.prefix)}</code>, TTL cap{' '}
        <code>{Math.round(cacheSettings.maxTtlSeconds / 3600)} h</code>.
      </p>

      <section>
        <h2 className="text-lg font-semibold mb-2">Nodes</h2>
        <table className="w-full text-sm border border-gray-200">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="p-2">Node</th>
              <th className="p-2">Memory used</th>
              <th className="p-2">Max memory</th>
              <th className="p-2">Eviction policy</th>
              <th className="p-2">Keys</th>
            </tr>
          </thead>
          <tbody>
            {report.nodes.map((node) => (
              <tr key={node.address} className="border-t border-gray-200 font-mono">
                <td className="p-2">{node.address}</td>
                <td className="p-2">{node.usedMemory}</td>
                <td className="p-2">{node.maxMemory}</td>
                <td className="p-2">{node.policy}</td>
                <td className="p-2">{node.keys}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Keys by deployment prefix</h2>
        <p className="text-sm text-gray-600 mb-2">
          Scanned {report.scanned} keys{report.truncated ? ` (stopped at ${SCAN_LIMIT} per node)` : ''}. TTLs from a
          sample of up to {TTL_SAMPLE} keys per prefix; &ldquo;no TTL&rdquo; keys never expire.
        </p>
        <table className="w-full text-sm border border-gray-200">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="p-2">Prefix</th>
              <th className="p-2">Keys</th>
              <th className="p-2">No TTL (of sample)</th>
              <th className="p-2">Avg TTL left</th>
            </tr>
          </thead>
          <tbody>
            {report.prefixes.map((p) => (
              <tr key={p.prefix} className="border-t border-gray-200 font-mono">
                <td className="p-2">
                  {maskPrefix(p.prefix)}
                  {p.prefix === cacheSettings.prefix && <span className="font-sans text-xs text-green-700"> current</span>}
                </td>
                <td className="p-2">{p.keys}</td>
                <td className="p-2">
                  {p.noTtl} / {p.sampled}
                </td>
                <td className="p-2">{p.avgTtlHours === null ? '–' : `${p.avgTtlHours.toFixed(1)} h`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default function RedisPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-10 space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Redis cache</h1>
        <p className="text-gray-600 mt-2 text-sm leading-relaxed">
          What the shared cache holds, per node and per deployment prefix. Prefixes other than the current one are
          leftovers from earlier deployments, waiting to expire.
        </p>
      </header>
      <Suspense fallback={<div className="text-sm text-gray-500">Scanning Redis…</div>}>
        <RedisReport />
      </Suspense>
    </div>
  );
}
