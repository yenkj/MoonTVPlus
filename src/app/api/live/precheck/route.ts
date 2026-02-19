/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';

async function fetchWithCookies(url: string, ua: string, maxRedirects = 10): Promise<{ ok: boolean; status: number; contentType: string | null }> {
  let currentUrl = url;
  let cookies = '';
  
  for (let i = 0; i < maxRedirects; i++) {
    const response = await fetch(currentUrl, {
      cache: 'no-cache',
      redirect: 'manual',
      headers: {
        'User-Agent': ua,
        ...(cookies ? { 'Cookie': cookies } : {}),
      },
    });

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const cookieParts = setCookie.split(',').map(c => c.split(';')[0].trim()).filter(Boolean);
      if (cookieParts.length > 0) {
        cookies = cookieParts.join('; ');
      }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
    }

    const contentType = response.headers.get('Content-Type');
    if (response.body) {
      response.body.cancel();
    }

    return {
      ok: response.ok,
      status: response.status,
      contentType,
    };
  }

  return { ok: false, status: 310, contentType: null };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const source = searchParams.get('moontv-source');

  if (!url) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }
  const config = await getConfig();
  const liveSource = config.LiveConfig?.find((s: any) => s.key === source);
  if (!liveSource) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }
  const ua = liveSource.ua || 'AptvPlayer/1.4.10';

  try {
    const decodedUrl = decodeURIComponent(url);
    const result = await fetchWithCookies(decodedUrl, ua);

    if (!result.ok) {
      return NextResponse.json({ error: 'Failed to fetch', message: `Status: ${result.status}` }, { status: 500 });
    }

    if (result.contentType?.includes('video/mp4')) {
      return NextResponse.json({ success: true, type: 'mp4' }, { status: 200 });
    }
    if (result.contentType?.includes('video/x-flv')) {
      return NextResponse.json({ success: true, type: 'flv' }, { status: 200 });
    }
    return NextResponse.json({ success: true, type: 'm3u8' }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch', message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
