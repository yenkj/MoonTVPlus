/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";

export const runtime = 'nodejs';

async function fetchWithCookies(url: string, ua: string, maxRedirects = 10, initialCookies = ''): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = url;
  let cookies = initialCookies;
  
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

    return { response, finalUrl: currentUrl };
  }

  throw new Error('Too many redirects');
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const source = searchParams.get('moontv-source');
  const cookieToken = searchParams.get('cookieToken');
  if (!url) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }

  const config = await getConfig();
  const liveSource = config.LiveConfig?.find((s: any) => s.key === source);
  if (!liveSource) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }
  const ua = liveSource.ua || 'AptvPlayer/1.4.10';

  let response: Response | null = null;

  try {
    const decodedUrl = decodeURIComponent(url);
    const initialCookies = cookieToken ? `token=${cookieToken}` : '';
    const result = await fetchWithCookies(decodedUrl, ua, 10, initialCookies);
    response = result.response;
    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch key' }, { status: 500 });
    }
    const keyData = await response.arrayBuffer();
    return new Response(keyData, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Cache-Control': 'public, max-age=3600'
      },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch key' }, { status: 500 });
  }
}
