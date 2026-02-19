/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextResponse } from "next/server";

import { getConfig } from "@/lib/config";
import { getBaseUrl, resolveUrl } from "@/lib/live";

export const runtime = 'nodejs';

async function fetchWithCookies(url: string, ua: string, maxRedirects = 10): Promise<{ response: Response; finalUrl: string }> {
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

    return { response, finalUrl: currentUrl };
  }

  throw new Error('Too many redirects');
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const allowCORS = searchParams.get('allowCORS') === 'true';
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

  let response: Response | null = null;
  let responseUsed = false;

  try {
    const decodedUrl = decodeURIComponent(url);
    const result = await fetchWithCookies(decodedUrl, ua);
    response = result.response;
    const finalUrl = result.finalUrl;
    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch m3u8' }, { status: 500 });
    }

    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.toLowerCase().includes('mpegurl') || contentType.toLowerCase().includes('octet-stream')) {
      const m3u8Content = await response.text();
      responseUsed = true;

      const baseUrl = getBaseUrl(finalUrl);
      const originalUrl = decodeURIComponent(url || '');
      const tokenMatch = originalUrl.match(/[?&]token=([^&]+)/);
      const cookieToken = tokenMatch ? tokenMatch[1] : '';
      const modifiedContent = rewriteM3U8Content(m3u8Content, baseUrl, request, allowCORS, cookieToken);

      const headers = new Headers();
      headers.set('Content-Type', contentType);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Range, Origin, Accept');
      headers.set('Cache-Control', 'no-cache');
      headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
      return new Response(modifiedContent, { headers });
    }

    const headers = new Headers();
    headers.set('Content-Type', response.headers.get('Content-Type') || 'application/vnd.apple.mpegurl');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Range, Origin, Accept');
    headers.set('Cache-Control', 'no-cache');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

    return new Response(response.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch m3u8' }, { status: 500 });
  } finally {
    if (response && !responseUsed) {
      try {
        response.body?.cancel();
      } catch (error) {
        console.warn('Failed to close response body:', error);
      }
    }
  }
}

function rewriteM3U8Content(content: string, baseUrl: string, req: Request, allowCORS: boolean, cookieToken = '') {
  const referer = req.headers.get('referer');
  let protocol = 'http';
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      protocol = refererUrl.protocol.replace(':', '');
    } catch (error) {
      // ignore
    }
  }

  const host = req.headers.get('host');
  const proxyBase = `${protocol}://${host}/api/proxy`;
  const tokenParam = cookieToken ? `&cookieToken=${cookieToken}` : '';

  const lines = content.split('\n');
  const rewrittenLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    if (line && !line.startsWith('#')) {
      const resolvedUrl = resolveUrl(baseUrl, line);
      const proxyUrl = allowCORS ? resolvedUrl : `${proxyBase}/segment?url=${encodeURIComponent(resolvedUrl)}${tokenParam}`;
      rewrittenLines.push(proxyUrl);
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      line = rewriteMapUri(line, baseUrl, proxyBase, tokenParam);
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      line = rewriteKeyUri(line, baseUrl, proxyBase, tokenParam);
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      rewrittenLines.push(line);
      if (i + 1 < lines.length) {
        i++;
        const nextLine = lines[i].trim();
        if (nextLine && !nextLine.startsWith('#')) {
          const resolvedUrl = resolveUrl(baseUrl, nextLine);
          const proxyUrl = `${proxyBase}/m3u8?url=${encodeURIComponent(resolvedUrl)}`;
          rewrittenLines.push(proxyUrl);
        } else {
          rewrittenLines.push(nextLine);
        }
      }
      continue;
    }

    rewrittenLines.push(line);
  }

  return rewrittenLines.join('\n');
}

function rewriteMapUri(line: string, baseUrl: string, proxyBase: string, tokenParam = '') {
  const uriMatch = line.match(/URI="([^"]+)"/);
  if (uriMatch) {
    const originalUri = uriMatch[1];
    const resolvedUrl = resolveUrl(baseUrl, originalUri);
    const proxyUrl = `${proxyBase}/segment?url=${encodeURIComponent(resolvedUrl)}${tokenParam}`;
    return line.replace(uriMatch[0], `URI="${proxyUrl}"`);
  }
  return line;
}

function rewriteKeyUri(line: string, baseUrl: string, proxyBase: string, tokenParam = '') {
  const uriMatch = line.match(/URI="([^"]+)"/);
  if (uriMatch) {
    const originalUri = uriMatch[1];
    const resolvedUrl = resolveUrl(baseUrl, originalUri);
    const proxyUrl = `${proxyBase}/key?url=${encodeURIComponent(resolvedUrl)}${tokenParam}`;
    return line.replace(uriMatch[0], `URI="${proxyUrl}"`);
  }
  return line;
}
