import { ContentProps, getClient } from '@optimizely/cms-sdk';
import { cacheLife, cacheTag } from 'next/cache';
import { PersonPageCT } from '@/content-types/PersonPage';
import { getPageTag } from '@/lib/cache/cache-keys';
// Ensures config() has run before getClient() (see graph-config.ts).
import '@/lib/optimizely/graph-config';

export type PersonData = ContentProps<typeof PersonPageCT>;

export async function getPerson(path: string, host?: string): Promise<PersonData | null> {
  'use cache';
  cacheTag(getPageTag(path.split('/').filter(Boolean)));

  // Cache a failure for seconds only, so one failed Graph call doesn't hide the
  // person until the next publish (same as getPageContent).
  try {
    const client = getClient();
    const results = await client.getContentByPath(path, { host: host ?? undefined });
    cacheLife('max');
    return results?.[0] ?? null;
  } catch (e) {
    cacheLife('seconds');
    console.error('[get-person] graph lookup failed:', e);
    return null;
  }
}
