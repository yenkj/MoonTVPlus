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
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    const decodedUrl = decodeURIComponent(url);
    const initialCookies = cookieToken ? `token=${cookieToken}` : '';
    const result = await fetchWithCookies(decodedUrl, ua, 10, initialCookies);
    response = result.response;
    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch segment' }, { status: 500 });
    }

    const headers = new Headers();
    headers.set('Content-Type', 'video/mp2t');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Range, Origin, Accept');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

    // 使用流式传输，避免占用内存
    const stream = new ReadableStream({
      start(controller) {
        if (!response?.body) {
          controller.close();
          return;
        }

        reader = response.body.getReader();
        const isCancelled = false;

        function pump() {
          if (isCancelled || !reader) {
            return;
          }

          reader.read().then(({ done, value }) => {
            if (isCancelled) {
              return;
            }

            if (done) {
              controller.close();
              cleanup();
              return;
            }

            controller.enqueue(value);
            pump();
          }).catch((error) => {
            if (!isCancelled) {
              controller.error(error);
              cleanup();
            }
          });
        }

        function cleanup() {
          if (reader) {
            try {
              reader.releaseLock();
            } catch (e) {
              // reader 可能已经被释放，忽略错误
            }
            reader = null;
          }
        }

        pump();
      },
      cancel() {
        // 当流被取消时，确保释放所有资源
        if (reader) {
          try {
            reader.releaseLock();
          } catch (e) {
            // reader 可能已经被释放，忽略错误
          }
          reader = null;
        }

        if (response?.body) {
          try {
            response.body.cancel();
          } catch (e) {
            // 忽略取消时的错误
          }
        }
      }
    });

    return new Response(stream, { headers });
  } catch (error) {
    // 确保在错误情况下也释放资源
    if (reader) {
      try {
        (reader as ReadableStreamDefaultReader<Uint8Array>).releaseLock();
      } catch (e) {
        // 忽略错误
      }
    }

    if (response?.body) {
      try {
        response.body.cancel();
      } catch (e) {
        // 忽略错误
      }
    }

    return NextResponse.json({ error: 'Failed to fetch segment' }, { status: 500 });
  }
}
