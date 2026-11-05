import { revalidatePath, revalidateTag } from 'next/cache';
import { ATLAS_SOURCE_CACHE_TAG, refreshAtlasSourceNow } from '@/app/server/atlas/load-atlas-tree-from-github';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    // Verify the revalidation secret to prevent unauthorized cache purging
    const secret = request.nextUrl.searchParams.get('secret');
    const expectedSecret = process.env.REVALIDATE_SECRET;

    if (!expectedSecret || secret !== expectedSecret) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { path } = body;

    if (!path || typeof path !== 'string') {
      return NextResponse.json({ success: false, error: 'Missing parameter' }, { status: 400 });
    }

    // Atlas content sits behind its own caches (the data-cache entry for the
    // latest-commit lookup and the in-memory compose cache), so revalidatePath
    // alone re-renders pages from stale content. Refresh the source first.
    revalidateTag(ATLAS_SOURCE_CACHE_TAG, { expire: 0 });
    const atlasCommitSha = await refreshAtlasSourceNow();

    // Call revalidatePath in proper Next.js context
    revalidatePath(path);

    return NextResponse.json({
      success: true,
      message: `Successfully revalidated path: ${path}`,
      atlasCommitSha,
      revalidatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Revalidation error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to revalidate path',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
