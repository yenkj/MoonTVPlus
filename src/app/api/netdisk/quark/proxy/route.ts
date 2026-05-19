import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { ensureQuarkPlayFolder, getQuarkPlayHeaders, getQuarkPlayUrls, saveQuarkShareFile } from '@/lib/netdisk/quark.client';
import { refreshQuarkNetdiskSession } from '@/lib/netdisk/quark-session-cache';
import { resolveQuarkSession } from '@/lib/netdisk/quark-session-resolver';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo?.username) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const episodeIndexRaw = searchParams.get('episodeIndex');
    const quality = searchParams.get('quality') || '';
    if (!id || episodeIndexRaw == null) {
      return NextResponse.json({ error: '缺少参数' }, { status: 400 });
    }

    const episodeIndex = Number.parseInt(episodeIndexRaw, 10);
    if (!Number.isInteger(episodeIndex) || episodeIndex < 0) {
      return NextResponse.json({ error: '无效的 episodeIndex' }, { status: 400 });
    }

    const { session, cookie, savePath } = await resolveQuarkSession(id);
    const file = session.files[episodeIndex];
    if (!file) {
      return NextResponse.json({ error: '播放文件不存在' }, { status: 404 });
    }

    if (!session.playFolderFid || !session.playFolderPath) {
      const folder = await ensureQuarkPlayFolder(cookie, savePath, session.shareId, session.title);
      session.playFolderFid = folder.folderFid;
      session.playFolderPath = folder.folderPath;
    }

    let savedFileId = session.savedFileIds[file.fid];
    if (!savedFileId) {
      savedFileId = await saveQuarkShareFile(cookie, {
        shareId: session.shareId,
        shareToken: session.shareToken,
        fileId: file.fid,
        shareFileToken: file.shareFidToken,
        playFolderFid: session.playFolderFid,
      });
      session.savedFileIds[file.fid] = savedFileId;
    }
    refreshQuarkNetdiskSession(id);

    const config = await getConfig();
    const tvOptions = {
      refreshToken: config.NetDiskConfig?.Quark?.TvRefreshToken,
      deviceId: config.NetDiskConfig?.Quark?.TvDeviceId,
    };
    const playUrls = await getQuarkPlayUrls(cookie, savedFileId, tvOptions);
    const selected = playUrls.find((item) => item.name === quality) || playUrls[0];
    const candidates = [
      ...(selected ? [selected] : []),
      ...playUrls.filter((item) => item.url !== selected?.url),
    ];
    if (candidates.length === 0) {
      return NextResponse.json({ error: '未获取到夸克播放地址' }, { status: 500 });
    }

    const range = request.headers.get('range');
    const hasNoRange = !range;
    const upstreamRange = range || 'bytes=0-1048575';
    let lastUpstreamStatus = 0;

    for (const candidate of candidates) {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 300000);

      try {
        const upstream = await fetch(candidate.url, {
          headers: {
            ...getQuarkPlayHeaders(cookie),
            Range: upstreamRange,
          },
          cache: 'no-store',
          signal: abortController.signal,
        });

        clearTimeout(timeoutId);
        lastUpstreamStatus = upstream.status;

        if (!upstream.ok || !upstream.body) {
          try {
            await upstream.body?.cancel();
          } catch {
            void 0;
          }
          continue;
        }

        const responseHeaders = new Headers();
        const copyHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
        copyHeaders.forEach((name) => {
          const value = upstream.headers.get(name);
          if (value) responseHeaders.set(name, value);
        });
        responseHeaders.set('Cache-Control', 'private, no-store');

        const { readable, writable } = new TransformStream();
        const reader = upstream.body.getReader();

        void (async () => {
          const writer = writable.getWriter();
          try {
            let streamDone = false;
            while (!streamDone) {
              const { done, value } = await reader.read();
              if (done) {
                streamDone = true;
              } else {
                await writer.write(value);
              }
            }
          } catch {
            try {
              await reader.cancel();
            } catch {
              void 0;
            }
          } finally {
            try {
              reader.releaseLock();
            } catch {
              void 0;
            }
            try {
              await writer.close();
            } catch {
              void 0;
            }
          }
        })();

        return new Response(readable, {
          status: hasNoRange ? 206 : (upstream.headers.get('content-range') ? 206 : upstream.status),
          headers: responseHeaders,
        });
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
          lastUpstreamStatus = 504;
          continue;
        }
      }
    }

    return NextResponse.json(
      { error: `夸克视频代理失败 (${lastUpstreamStatus || 500})` },
      { status: lastUpstreamStatus || 500 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '夸克网盘代理失败' },
      { status: 500 }
    );
  }
}
