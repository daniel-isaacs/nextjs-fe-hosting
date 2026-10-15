import Link from "next/link";

export const metadata = {
  title: "Diagnostics",
};

export default function DiagnosticsIndex() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-10 space-y-8">
      <header>
        <h1 className="text-3xl font-bold">Diagnostics</h1>
        <p className="text-gray-600 mt-2 text-sm leading-relaxed">
          Server-rendered probes against Optimizely Graph and the running
          container. Used to verify integration assumptions before code
          relies on them.
        </p>
      </header>

      <ul className="space-y-2">
        <li>
          <Link
            href="/diagnostics/env"
            className="block rounded border border-gray-200 bg-white p-4 hover:border-blue-400 hover:bg-blue-50 transition"
          >
            <div className="font-semibold text-gray-900">Environment</div>
            <div className="text-sm text-gray-600 mt-1">
              Which environment variables the running instance has (secrets
              masked) — checks what the platform injected.
            </div>
          </Link>
        </li>
        <li>
          <Link
            href="/diagnostics/redis"
            className="block rounded border border-gray-200 bg-white p-4 hover:border-blue-400 hover:bg-blue-50 transition"
          >
            <div className="font-semibold text-gray-900">Redis cache</div>
            <div className="text-sm text-gray-600 mt-1">
              Memory and eviction policy per node, and keys per deployment
              prefix with a TTL sample — shows leftovers from earlier deploys.
            </div>
          </Link>
        </li>
        <li>
          <Link
            href="/diagnostics/cms-graph"
            className="block rounded border border-gray-200 bg-white p-4 hover:border-blue-400 hover:bg-blue-50 transition"
          >
            <div className="font-semibold text-gray-900">CMS Graph URL shape</div>
            <div className="text-sm text-gray-600 mt-1">
              Confirms <code>_metadata.url.default</code> is populated —
              required by <code>/hooks/graph</code>.
            </div>
          </Link>
        </li>
        <li>
          <Link
            href="/diagnostics/raw-content"
            className="block rounded border border-gray-200 bg-white p-4 hover:border-blue-400 hover:bg-blue-50 transition"
          >
            <div className="font-semibold text-gray-900">Raw content probe</div>
            <div className="text-sm text-gray-600 mt-1">
              Dumps the raw <code>getContentByPath</code> response for a
              given path — useful for inspecting DAM asset shape.
            </div>
          </Link>
        </li>
        <li>
          <Link
            href="/diagnostics/sdk-query"
            className="block rounded border border-gray-200 bg-white p-4 hover:border-blue-400 hover:bg-blue-50 transition"
          >
            <div className="font-semibold text-gray-900">SDK query capture</div>
            <div className="text-sm text-gray-600 mt-1">
              Captures the GraphQL queries the SDK fires for a given page —
              useful for comparing query shape across pages.
            </div>
          </Link>
        </li>
      </ul>
    </div>
  );
}
