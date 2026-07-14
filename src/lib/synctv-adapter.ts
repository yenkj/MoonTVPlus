/**
 * synctv 事件协议适配器
 * 只使用语音功能，播放同步由 MoonTVPlus 自身处理
 */

// 只转发语音和基础房间管理事件
const ENABLED_EVENTS: Record<string, string> = {
  // 房间管理（基础功能）
  'room:create': 'room:create',
  'room:join': 'room:join',
  'room:leave': 'room:leave',
  'room:info': 'room:info',
  'room:joined': 'room:joined',
  'room:member-joined': 'room:member-joined',
  'room:member-left': 'room:member-left',

  // 语音聊天（核心功能）
  'voice:audio-chunk': 'voice:audio-chunk',

  // 心跳（保持连接）
  'heartbeat': 'heartbeat',
};

/**
 * 将 MoonTVPlus 事件转换为 synctv 事件
 * 只转发语音和房间管理事件，播放同步由 MoonTVPlus 自身处理
 */
export function adaptEventToSynctv(event: string, data: any): { event: string; data: any } | null {
  // 只转发启用的事件
  const synctvEvent = ENABLED_EVENTS[event];
  if (!synctvEvent) {
    // 播放控制、聊天、屏幕共享等事件不转发
    return null;
  }

  return { event: synctvEvent, data };
}

/**
 * 将 synctv 事件转换为 MoonTVPlus 事件
 * 只接收语音和房间管理事件
 */
export function adaptEventFromSynctv(event: string, data: any): { event: string; data: any } | null {
  // 只接收启用的事件
  let moontvEvent: string | null = null;
  for (const [key, value] of Object.entries(ENABLED_EVENTS)) {
    if (value === event) {
      moontvEvent = key;
      break;
    }
  }

  if (!moontvEvent) {
    // 忽略其他事件
    return null;
  }

  return { event: moontvEvent, data };
}

/**
 * 检查事件是否支持
 */
export function isEventSupported(event: string): boolean {
  return event in ENABLED_EVENTS;
}

/**
 * 获取 synctv WebSocket 消息格式
 */
export function formatSynctvMessage(event: string, data: any): string {
  return JSON.stringify({
    type: event,
    payload: data,
  });
}

/**
 * 解析 synctv WebSocket 消息
 */
export function parseSynctvMessage(message: string): { event: string; data: any } | null {
  try {
    const parsed = JSON.parse(message);

    // synctv 消息格式: { type: string, payload: any }
    if (parsed.type && parsed.payload) {
      return {
        event: parsed.type,
        data: parsed.payload,
      };
    }

    return null;
  } catch (error) {
    console.error('[synctv-adapter] Failed to parse message:', error);
    return null;
  }
}
