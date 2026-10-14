// Programmatic Optimizely Graph webhook registration.
//
// Verbatim port of the reference implementation from
// docs/isr-documentation.md §3.1. Runs once per container start (via
// Next.js's instrumentation hook). Idempotent: if a webhook already
// exists pointing at our /hooks/graph URL, do nothing. If multiple
// duplicates exist (race condition during parallel container start),
// keep the highest-id one and delete the rest. Otherwise register a
// fresh webhook.
//
// All env reads are guarded so missing config short-circuits silently
// — local dev runs without these env vars and should not error.

export async function register() {
  // Telemetry first, so the webhook registration below is traced too. Loaded
  // dynamically and only on Node, keeping the OTel SDK out of the edge bundle.
  // Off unless there's somewhere to send it: App Insights on Frontend Hosting,
  // or an OTLP endpoint locally.
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
  ) {
    const { startTelemetry } = await import("./instrumentation.node");
    startTelemetry();
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Before anything calls fetch(): caps every server-side request at 10 s.
    const { setFetchTimeout } = await import("./lib/fetch-timeout");
    setFetchTimeout();
    // One line per process start, so restarts show up in Application Insights
    // (a restart doesn't change the instance ID).
    console.log(
      `[startup] pid ${process.pid}, node ${process.version}, ` +
        `env ${process.env.OPTIMIZELY_ENVIRONMENT ?? "local"}, ` +
        `instance ${process.env.WEBSITE_INSTANCE_ID?.slice(0, 8) ?? "local"}`,
    );
  }

  const gateway = (process.env.OPTIMIZELY_GRAPH_GATEWAY ?? "https://cg.optimizely.com").replace(/\/+$/, "");
  const appKey = process.env.OPTIMIZELY_GRAPH_APP_KEY;
  const secret = process.env.OPTIMIZELY_GRAPH_SECRET;
  const callbackApiKey = process.env.OPTIMIZELY_GRAPH_CALLBACK_APIKEY;
  const hostname = process.env.OPTIMIZELY_SITE_HOSTNAME;
  if (!appKey || !secret || !callbackApiKey || !hostname) return;

  const baseUrl = hostname.includes("://") ? hostname : `https://${hostname}`;
  const webhookUrl = `${baseUrl.replace(/\/+$/, "")}/hooks/graph`;
  const webhooksEndpoint = `${gateway}/api/webhooks`;
  const auth = `Basic ${Buffer.from(`${appKey}:${secret}`).toString("base64")}`;

  try {
    // List existing webhooks
    const listRes = await fetch(webhooksEndpoint, { headers: { Authorization: auth } });
    if (!listRes.ok) throw new Error(`List webhooks failed (${listRes.status})`);
    const existing = await listRes.json();
    const matching = existing.filter((w: { request?: { url?: string } }) => w.request?.url === webhookUrl);

    // Deduplicate: if multiple webhooks exist for our URL,
    // keep the one with the highest ID and remove the rest
    if (matching.length > 1) {
      const sorted = [...matching].sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
      for (const hook of sorted.slice(0, -1)) {
        await fetch(`${webhooksEndpoint}/${hook.id}`, {
          method: "DELETE",
          headers: { Authorization: auth },
        });
      }
      return;
    }
    if (matching.length === 1) return; // already registered

    // Register new webhook
    await fetch(webhooksEndpoint, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        disabled: false,
        request: {
          url: webhookUrl,
          method: "post",
          headers: { "x-api-key": callbackApiKey },
        },
        topic: ["*.*"],
        filters: [{ status: { eq: "Published" } }],
      }),
    });
  } catch {
    // Non-fatal — the Graph API may be temporarily unavailable
  }
}
