'use client';

import { Monitor, MonitorPlay, Pause, Play, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import Toast, { ToastProps } from '@/components/Toast';
import { useWatchRoomContext } from '@/components/WatchRoomProvider';
import { screenShareQualityOptions, type ScreenShareQualityPreset, useScreenShare } from '@/hooks/useScreenShare';

const NEW_TAB_KEY_PREFIX = 'watch_room_screen_home_opened_';
const WATCH_ROOM_NO_CONNECT_KEY = 'watch_room_no_connect';
const WATCH_ROOM_NO_CONNECT_TIMESTAMP_KEY = 'watch_room_no_connect_timestamp';
const WATCH_ROOM_NO_CONNECT_TTL_MS = 10 * 60 * 1000;
const SCREEN_SHARE_QUALITY_KEY = 'watch_room_screen_quality';

function getScreenShareHostSupportError() {
  if (typeof window === 'undefined') return null;

  if (!window.isSecureContext) {
    return '当前环境不是安全上下文（HTTPS/localhost），不支持屏幕共享';
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    return '当前浏览器不支持屏幕共享';
  }

  if (typeof window.RTCPeerConnection === 'undefined') {
    return '当前浏览器不支持实时屏幕传输';
  }

  return null;
}

function getScreenShareViewerSupportError() {
  if (typeof window === 'undefined') return null;

  if (typeof window.RTCPeerConnection === 'undefined') {
    return '当前浏览器不支持实时屏幕传输';
  }

  return null;
}

export default function WatchRoomScreenPage() {
  const router = useRouter();
  const watchRoom = useWatchRoomContext();
  const { currentRoom, members, leaveRoom } = watchRoom;
  const [toast, setToast] = useState<ToastProps | null>(null);
  const [qualityPreset, setQualityPreset] = useState<ScreenShareQualityPreset>('smooth');
  const [isViewerFullscreen, setIsViewerFullscreen] = useState(false);
  const [isRemotePlaying, setIsRemotePlaying] = useState(true);
  const [isFullscreenChromeVisible, setIsFullscreenChromeVisible] = useState(true);
  const fullscreenChromeTimerRef = useRef<number | null>(null);
  const {
    currentRoom: screenRoom,
    isOwner,
    isSharing,
    isStarting,
    error,
    captureSettings,
    localVideoRef,
    remoteVideoRef,
    startSharing,
    stopSharing,
  } = useScreenShare(qualityPreset);

  const showToast = (message: string, type: ToastProps['type'] = 'info') => {
    setToast({
      message,
      type,
      duration: 3000,
      onClose: () => setToast(null),
    });
  };

  const openDetachedPage = useCallback(() => {
    window.open('/', '_blank', 'noopener,noreferrer');
  }, []);

  const closeViewerFullscreen = useCallback(() => {
    setIsViewerFullscreen(false);
  }, []);

  const toggleViewerFullscreen = useCallback(() => {
    setIsViewerFullscreen((value) => !value);
  }, []);

  const showFullscreenChrome = useCallback(() => {
    if (!isViewerFullscreen) return;

    setIsFullscreenChromeVisible(true);
    if (fullscreenChromeTimerRef.current) {
      window.clearTimeout(fullscreenChromeTimerRef.current);
    }
    fullscreenChromeTimerRef.current = window.setTimeout(() => {
      setIsFullscreenChromeVisible(false);
    }, 2500);
  }, [isViewerFullscreen]);

  const isIOS = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const saved = window.localStorage.getItem(SCREEN_SHARE_QUALITY_KEY);
    if (saved === 'smooth' || saved === 'hd' || saved === 'ultra') {
      setQualityPreset(saved);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SCREEN_SHARE_QUALITY_KEY, qualityPreset);
  }, [qualityPreset]);

  useEffect(() => {
    if (!currentRoom) {
      router.replace('/watch-room');
      return;
    }

    if (currentRoom.roomType !== 'screen') {
      router.replace('/watch-room');
    }
  }, [currentRoom, router]);

  useEffect(() => {
    if (!screenRoom || screenRoom.roomType !== 'screen') return;

    const supportError = isOwner
      ? getScreenShareHostSupportError()
      : getScreenShareViewerSupportError();
    if (supportError) {
      showToast(`当前设备无法使用屏幕共享房间：${supportError}`, 'error');
      leaveRoom();
      router.replace('/watch-room');
    }
  }, [isOwner, leaveRoom, router, screenRoom?.id, screenRoom?.roomType]);

  useEffect(() => {
    if (!screenRoom || !isOwner) return;

    localStorage.setItem(WATCH_ROOM_NO_CONNECT_KEY, '1');
    localStorage.setItem(WATCH_ROOM_NO_CONNECT_TIMESTAMP_KEY, String(Date.now()));
    const heartbeat = window.setInterval(() => {
      localStorage.setItem(WATCH_ROOM_NO_CONNECT_TIMESTAMP_KEY, String(Date.now()));
    }, 30_000);
    const key = `${NEW_TAB_KEY_PREFIX}${screenRoom.id}`;
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      openDetachedPage();
    }

    return () => {
      localStorage.removeItem(WATCH_ROOM_NO_CONNECT_KEY);
      localStorage.removeItem(WATCH_ROOM_NO_CONNECT_TIMESTAMP_KEY);
      window.clearInterval(heartbeat);
    };
  }, [isOwner, openDetachedPage, screenRoom?.id]);

  useEffect(() => {
    if (isOwner) return;

    const video = remoteVideoRef.current;
    if (!video) return;

    const syncPlaybackState = () => {
      setIsRemotePlaying(!video.paused);
    };

    syncPlaybackState();
    video.addEventListener('play', syncPlaybackState);
    video.addEventListener('playing', syncPlaybackState);
    video.addEventListener('pause', syncPlaybackState);
    video.addEventListener('ended', syncPlaybackState);

    return () => {
      video.removeEventListener('play', syncPlaybackState);
      video.removeEventListener('playing', syncPlaybackState);
      video.removeEventListener('pause', syncPlaybackState);
      video.removeEventListener('ended', syncPlaybackState);
    };
  }, [isOwner, isSharing, remoteVideoRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeViewerFullscreen();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeViewerFullscreen]);

  useEffect(() => {
    return () => {
      setIsViewerFullscreen(false);
    };
  }, []);

  useEffect(() => {
    if (!isViewerFullscreen) {
      setIsFullscreenChromeVisible(true);
      if (fullscreenChromeTimerRef.current) {
        window.clearTimeout(fullscreenChromeTimerRef.current);
        fullscreenChromeTimerRef.current = null;
      }
      return;
    }

    showFullscreenChrome();

    return () => {
      if (fullscreenChromeTimerRef.current) {
        window.clearTimeout(fullscreenChromeTimerRef.current);
        fullscreenChromeTimerRef.current = null;
      }
    };
  }, [isViewerFullscreen, showFullscreenChrome]);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    if (isViewerFullscreen) {
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    }

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [isViewerFullscreen]);

  useEffect(() => {
    if (!isViewerFullscreen || typeof window === 'undefined') return;

    const preventScroll = (event: Event) => {
      event.preventDefault();
    };

    window.addEventListener('touchmove', preventScroll, { passive: false });
    window.addEventListener('wheel', preventScroll, { passive: false });

    return () => {
      window.removeEventListener('touchmove', preventScroll);
      window.removeEventListener('wheel', preventScroll);
    };
  }, [isViewerFullscreen]);

  if (!screenRoom || screenRoom.roomType !== 'screen') {
    return null;
  }

  const handleLeave = () => {
    closeViewerFullscreen();
    if (isOwner && isSharing) {
      stopSharing(true);
    }
    leaveRoom();
    router.push('/watch-room');
  };

  const captureSettingsText = captureSettings
    ? [
        captureSettings.width && captureSettings.height
          ? `${captureSettings.width}x${captureSettings.height}`
          : '分辨率未知',
        captureSettings.frameRate ? `${Math.round(captureSettings.frameRate)} fps` : '帧率未知',
      ].join(' / ')
    : '未开始';

  const viewerForceInline = isIOS;
  const showViewerFullscreenControls = !isOwner && isSharing;
  const pageShellClass = isViewerFullscreen
    ? 'fixed inset-0 z-50 flex h-[100dvh] w-[100vw] touch-none overscroll-contain flex-col overflow-hidden bg-black text-white'
    : 'min-h-screen bg-white text-gray-900 dark:bg-black dark:text-gray-200';

  const handleToggleRemotePlayback = () => {
    const video = remoteVideoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  };

  const fullscreenIcon = (
    <svg width='22' height='22' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
      <path
        d='M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z'
        fill='currentColor'
      />
    </svg>
  );

  const handleFullscreenInteraction = useCallback(() => {
    showFullscreenChrome();
  }, [showFullscreenChrome]);

  return (
    <div className={pageShellClass}>
      <div className={isViewerFullscreen ? 'flex h-full w-full flex-col gap-0' : 'mx-auto flex min-h-screen max-w-7xl flex-col gap-4 px-4 py-4 lg:px-8'}>
        {!isViewerFullscreen && (
          <div className='flex items-center justify-between gap-4 rounded-2xl border border-gray-200 bg-white/90 px-5 py-4 shadow-sm dark:border-gray-800 dark:bg-gray-900/80'>
            <div>
              <h1 className='flex items-center gap-2 text-2xl font-semibold'>
                <Monitor className='h-6 w-6 text-blue-500' />
                屏幕共享观影室
              </h1>
              <p className='mt-1 text-sm text-gray-600 dark:text-gray-400'>
                房间：{screenRoom.name} · 房主：{screenRoom.ownerName}
              </p>
            </div>
            <div className='flex items-center gap-2'>
              {isOwner && (
                <Link
                  href='/'
                  target='_blank'
                  rel='noreferrer'
                  onClick={(event) => {
                    event.preventDefault();
                    openDetachedPage();
                  }}
                  className='rounded-lg bg-blue-500 px-4 py-2 text-white'
                >
                  新开主页
                </Link>
              )}
              <button
                onClick={handleLeave}
                className='rounded-lg bg-gray-200 px-4 py-2 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
              >
                离开房间
              </button>
            </div>
          </div>
        )}

        <div className={isViewerFullscreen ? 'flex-1 min-h-0' : 'grid flex-1 grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]'}>
          <div
            onMouseMove={isViewerFullscreen ? handleFullscreenInteraction : undefined}
            onMouseDown={isViewerFullscreen ? handleFullscreenInteraction : undefined}
            onTouchStart={isViewerFullscreen ? handleFullscreenInteraction : undefined}
            onTouchMove={isViewerFullscreen ? handleFullscreenInteraction : undefined}
            onKeyDown={isViewerFullscreen ? handleFullscreenInteraction : undefined}
            tabIndex={isViewerFullscreen ? 0 : -1}
            className={[
              'relative flex min-h-[420px] items-center justify-center overflow-hidden rounded-2xl border border-gray-200 bg-black transition-[border-radius,transform,opacity] duration-300 ease-out dark:border-gray-800',
              isViewerFullscreen ? 'min-h-0 h-full rounded-none border-0 opacity-100' : '',
            ].join(' ')}
          >
            {isOwner ? (
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className='h-full w-full bg-black object-contain'
              />
            ) : (
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline={viewerForceInline}
                controls={!viewerForceInline}
                controlsList='nofullscreen noplaybackrate nodownload'
                className='h-full w-full bg-black object-contain'
              />
            )}

            {showViewerFullscreenControls && !isViewerFullscreen && (
              <div className='absolute right-4 top-4 flex items-center gap-2'>
                <button
                  onClick={handleToggleRemotePlayback}
                  aria-label={isRemotePlaying ? '暂停播放' : '继续播放'}
                  title={isRemotePlaying ? '暂停播放' : '继续播放'}
                  className='inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white shadow-lg backdrop-blur transition duration-200 hover:bg-black/75 hover:border-white/25'
                >
                  {isRemotePlaying ? <Pause className='h-5 w-5' /> : <Play className='h-5 w-5 ml-0.5' />}
                </button>
                <button
                  onClick={toggleViewerFullscreen}
                  aria-label={isViewerFullscreen ? '退出网页全屏' : '进入网页全屏'}
                  title={isViewerFullscreen ? '退出网页全屏' : '进入网页全屏'}
                  className='ios-portrait-fullscreen inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white shadow-lg backdrop-blur transition duration-200 hover:bg-black/75 hover:border-white/25'
                >
                  {fullscreenIcon}
                </button>
              </div>
            )}

            {!isSharing && (
              <div className='absolute px-6 text-center text-white'>
                <MonitorPlay className='mx-auto mb-3 h-12 w-12 text-white/70' />
                <p className='text-lg font-medium'>
                  {isOwner ? '点击开始共享，向房员推送浏览器画面' : '等待房主开始共享屏幕'}
                </p>
                {isOwner && (
                  <p className='mt-2 text-sm text-white/70'>
                    本页不要关闭；已尝试为你新开一个主页标签页方便继续浏览。
                  </p>
                )}
              </div>
            )}

            {isViewerFullscreen && isFullscreenChromeVisible && (
              <>
                <div className='absolute left-4 top-4 flex items-center gap-2'>
                  <button
                    onClick={handleToggleRemotePlayback}
                    className='inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white shadow-lg backdrop-blur transition duration-200 hover:bg-black/75 hover:border-white/25'
                    aria-label={isRemotePlaying ? '暂停播放' : '继续播放'}
                    title={isRemotePlaying ? '暂停播放' : '继续播放'}
                  >
                    {isRemotePlaying ? <Pause className='h-5 w-5' /> : <Play className='h-5 w-5 ml-0.5' />}
                  </button>
                  <button
                    onClick={closeViewerFullscreen}
                    className='inline-flex items-center rounded-full border border-white/15 bg-black/55 px-3 py-2 text-xs font-medium text-white shadow-lg backdrop-blur transition duration-200 hover:bg-black/75 hover:border-white/25'
                  >
                    退出网页全屏
                  </button>
                </div>
              </>
            )}
          </div>

          {!isViewerFullscreen && (
            <div className='space-y-4'>
              <div className='rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900'>
                <h2 className='mb-3 font-semibold'>共享状态</h2>
                <div className='space-y-2 text-sm text-gray-600 dark:text-gray-400'>
                  <p>类型：屏幕共享</p>
                  <p>状态：{isSharing ? '共享中' : '未开始'}</p>
                  <p>成员：{members.length} 人</p>
                </div>

                {isOwner && (
                  <div className='mt-2 text-sm text-gray-600 dark:text-gray-400'>
                    实际采集：{captureSettingsText}
                  </div>
                )}

                {error && (
                  <div className='mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300'>
                    {error}
                  </div>
                )}

                {isOwner && (
                  <div className='mt-4'>
                    <label className='mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300'>
                      共享画质
                    </label>
                    <select
                      value={qualityPreset}
                      onChange={(event) => setQualityPreset(event.target.value as ScreenShareQualityPreset)}
                      disabled={isStarting || isSharing}
                      className='w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:disabled:bg-gray-900'
                    >
                      {screenShareQualityOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p className='mt-2 text-xs text-gray-500 dark:text-gray-400'>
                      画质越高越清晰，但更依赖网络和设备性能。共享开始后不可切换。
                    </p>
                  </div>
                )}

                <div className='mt-4 flex gap-3'>
                  {isOwner ? (
                    <>
                      <button
                        onClick={() => startSharing()}
                        disabled={isStarting || isSharing}
                        className='flex-1 rounded-lg bg-blue-500 px-4 py-2 text-white disabled:bg-gray-400'
                      >
                        {isStarting ? '启动中...' : isSharing ? '共享中' : '开始共享'}
                      </button>
                      <button
                        onClick={() => stopSharing(true)}
                        disabled={!isSharing}
                        className='rounded-lg bg-red-500 px-4 py-2 text-white disabled:bg-gray-400'
                      >
                        停止
                      </button>
                    </>
                  ) : (
                    <div className='rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:bg-blue-900/20 dark:text-blue-300'>
                      房员无需操作，房主开始共享后会自动显示画面。
                    </div>
                  )}
                </div>
              </div>

              <div className='rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900'>
                <h2 className='mb-3 flex items-center gap-2 font-semibold'>
                  <Users className='h-4 w-4' />
                  房间成员
                </h2>
                <div className='space-y-2'>
                  {members.map((member) => (
                    <div
                      key={member.id}
                      className='flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/70'
                    >
                      <span className='text-sm'>{member.name}</span>
                      {member.isOwner && (
                        <span className='rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300'>
                          房主
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className='rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200'>
                建议使用桌面版 Chrome / Edge，并优先共享标签页。
              </div>
            </div>
          )}
        </div>
      </div>
      {toast && <Toast {...toast} />}
    </div>
  );
}
