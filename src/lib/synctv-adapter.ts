/**
 * synctv 事件协议适配器
 * 用于适配 synctv 和 MoonTVPlus 之间的事件协议差异
 */

// 事件名称映射表
const EVENT_MAP: Record<string, string> = {
  // 房间管理（大部分相同）
  'room:create': 'room:create',
  'room:join': 'room:join',
  'room:leave': 'room:leave',
  'room:list': 'room:list',

  // 播放控制
  'play:update': 'play:update',
  'play:seek': 'play:seek',
  'play:play': 'play:play',
  'play:pause': 'play:pause',
  'play:change': 'play:change',

  // 直播和音乐
  'live:change': 'live:change',
  'music:change': 'music:change',
  'music:update': 'music:update',
  'music:queue': 'music:queue',
  'music:play': 'music:play',
  'music:pause': 'music:pause',
  'music:seek': 'music:seek',

  // 屏幕共享
  'screen:helper-register': 'screen:helper-register',
  'screen:start': 'screen:start',
  'screen:stop': 'screen:stop',
  'screen:viewer-ready': 'screen:viewer-ready',
  'screen:offer': 'screen:offer',
  'screen:answer': 'screen:answer',
  'screen:ice': 'screen:ice',

  // 聊天
  'chat:message': 'chat:message',

  // 语音（synctv 可能不支持所有语音事件）
  'voice:offer': 'voice:offer',
  'voice:answer': 'voice:answer',
  'voice:ice': 'voice:ice',
  'voice:audio-chunk': 'voice:audio-chunk', // MoonTVPlus 特有

  // 心跳
  'heartbeat': 'heartbeat',
};

/**
 * 将 MoonTVPlus 事件转换为 synctv 事件
 */
export function adaptEventToSynctv(event: string, data: any): { event: string; data: any } {
  const synctvEvent = EVENT_MAP[event] || event;

  // 数据格式适配（如果需要）
  let synctvData = { ...data };

  // 特殊处理：房间创建
  if (event === 'room:create') {
    synctvData = {
      ...data,
      // synctv 特定字段
      settings: {
        canSee: data.isPublic !== false,
        approval: false,
        chat: true,
      }
    };
  }

  return { event: synctvEvent, data: synctvData };
}

/**
 * 将 synctv 事件转换为 MoonTVPlus 事件
 */
export function adaptEventFromSynctv(event: string, data: any): { event: string; data: any } {
  // 反向查找事件名称
  let moontvEvent = event;
  for (const [key, value] of Object.entries(EVENT_MAP)) {
    if (value === event) {
      moontvEvent = key;
      break;
    }
  }

  // 数据格式适配（如果需要）
  let moontvData = { ...data };

  // 特殊处理：房间信息
  if (event === 'room:info' || event === 'room:joined') {
    moontvData = {
      ...data,
      // 转换 synctv 特定字段为 MoonTVPlus 格式
      isPublic: data.settings?.canSee !== false,
    };
  }

  return { event: moontvEvent, data: moontvData };
}

/**
 * 检查事件是否支持
 */
export function isEventSupported(event: string): boolean {
  return event in EVENT_MAP;
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
