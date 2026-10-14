import { getClient } from '@optimizely/cms-sdk';
import { cacheLife, cacheTag } from 'next/cache';
import { getPageTag } from '@/lib/cache/cache-keys';
import { PLACEHOLDER_SLUG_SEGMENT } from '@/lib/optimizely/all-pages';
// Ensures config() has run before getClient() (see graph-config.ts).
import '@/lib/optimizely/graph-config';

/**
 * Fetch a CMS page by slug, cached indefinitely and tagged for on-demand
 * revalidation by the Optimizely Graph webhook.
 *
 * The cache key is the slug array (Next.js memoizes by argument identity),
 * and the tag is shared with the webhook receiver so a publish event can
 * invalidate exactly this page.
 *
 * In production the entry lives until the webhook purges its tag. In local
 * dev the Graph webhook can't reach localhost, so the cache is given a short
 * lifetime instead — otherwise CMS edits (e.g. display-template settings)
 * never surface without manually clearing .next.
 *
 * Returns null when no content matches the path. Errors are swallowed
 * (returns null) so a transient Graph outage doesn't surface as a
 * HANGING_PROMISE_REJECTION during prerender — the caller decides whether
 * to render notFound() or something else. That null is cached only for
 * seconds, not indefinitely: otherwise one failed or timed-out Graph call
 * (see src/lib/fetch-timeout.ts) would serve a 404 for the page until its
 * next publish.
 *
 * Special case: the placeholder slug used by getAllPagesPaths to satisfy
 * Cache Components' "must return ≥1 entry" rule short-circuits without
 * a Graph call. This keeps `next build` fast and reliable even when the
 * DXP build container can't reach Graph.
 */
export async function getPageContent(slug: string[]) {
  'use cache';
  cacheTag(getPageTag(slug));

  if (slug.includes(PLACEHOLDER_SLUG_SEGMENT)) {
    cacheForSuccess();
    return null;
  }

  // Exactly one cacheLife() call per invocation, chosen by outcome.
  try {
    const client = getClient();
    const path = `/${slug.join('/')}/`;
    const items = await client.getContentByPath(path);
    cacheForSuccess();
    return items?.[0] ?? null;
  } catch (e) {
    cacheLife('seconds');
    console.error('[get-page] graph lookup failed:', e);
    return null;
  }
}

function cacheForSuccess() {
  if (process.env.NODE_ENV === 'production') {
    cacheLife('max');
  } else {
    cacheLife('minutes');
  }
}
