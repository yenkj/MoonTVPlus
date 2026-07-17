/**
 * synctv WebSocket 客户端
 * 用于连接 synctv 服务器，提供稳定的实时通信
 */

import { adaptEventFromSynctv, adaptEventToSynctv, parseSynctvMessage } from './synctv-adapter';

export interface SynctvWSConfig {
  url: string;
  token: string;
  roomId?: string;
}

// 使用与 Socket.IO 兼容的事件处理器签名
export type SynctvEventHandler = (data: any) => void;

export class SynctvWebSocketClient {
  private ws: WebSocket | null = null;
  private config: SynctvWSConfig | null = null;
  private eventHandlers: Map<string, Set<SynctvEventHandler>> = new Map();
  private connectionPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 2000;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isConnected = false;

  // Socket ID（兼容 Socket.IO 的 id 属性）
  readonly id: string;

  constructor() {
    // 生成类似 Socket.IO 的 ID 格式（例如：TzgZ5-h8h8h8h8）
    this.id = Math.random().toString(36).substring(2, 15) + '-' + Math.random().toString(36).substring(2, 15);
  }

  async connect(config: SynctvWSConfig): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.config = config;

    this.connectionPromise = new Promise((resolve, reject) => {
      try {
        // 构建 WebSocket URL
        const wsUrl = this.buildWebSocketUrl(config);

        // 创建 WebSocket 连接
        this.ws = new WebSocket(wsUrl, [config.token]);

        this.ws.onopen = () => {
          console.log('[synctv-ws] Connected to synctv server');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (error) => {
          console.error('[synctv-ws] WebSocket error:', error);
          if (!this.isConnected) {
            reject(new Error('Connection failed'));
          }
        };

        this.ws.onclose = () => {
          console.log('[synctv-ws] Disconnected from synctv server');
          this.isConnected = false;
          this.stopHeartbeat();
          this.handleReconnect();
        };

      } catch (error) {
        console.error('[synctv-ws] Failed to create WebSocket:', error);
        reject(error);
      }
    });

    return this.connectionPromise;
  }

  private buildWebSocketUrl(config: SynctvWSConfig): string {
    const url = new URL(config.url);
    // 将 http/https 转换为 ws/wss
    if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    } else if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    }
    // synctv WebSocket 路径
    url.pathname = '/api/room/ws';
    return url.toString();
  }

  private handleMessage(message: string) {
    try {
      const parsed = parseSynctvMessage(message);
      if (!parsed) {
        console.warn('[synctv-ws] Failed to parse message:', message);
        return;
      }

      // 将 synctv 事件转换为 MoonTVPlus 事件
      const adapted = adaptEventFromSynctv(parsed.event, parsed.data);
      
      // 如果返回 null，表示该事件被忽略
      if (!adapted) {
        return;
      }

      const { event, data } = adapted;

      // 触发事件处理器
      this.triggerHandlers(event, data);
    } catch (error) {
      console.error('[synctv-ws] Error handling message:', error);
    }
  }

  // 触发内部事件处理器（私有方法）
  private triggerHandlers(event: string, data: any) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          // 只传递 data，与 Socket.IO 的签名一致
          handler(data);
        } catch (error) {
          console.error(`[synctv-ws] Error in event handler for ${event}:`, error);
        }
      });
    }
  }

  private async handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[synctv-ws] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;

    console.log(`[synctv-ws] Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    await new Promise(resolve => setTimeout(resolve, delay));

    if (this.config) {
      try {
        await this.connect(this.config);
      } catch (error) {
        console.error('[synctv-ws] Reconnect failed:', error);
      }
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send('heartbeat', {});
      }
    }, 10000); // 每10秒发送心跳
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // 发送事件（send 方法）
  send(event: string, data?: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[synctv-ws] WebSocket is not connected');
      return;
    }

    // 将 MoonTVPlus 事件转换为 synctv 事件
    const adapted = adaptEventToSynctv(event, data);

    // 如果返回 null，表示该事件不应转发到 synctv
    if (!adapted) {
      return;
    }

    const { event: synctvEvent, data: synctvData } = adapted;

    const message = JSON.stringify({
      type: synctvEvent,
      payload: synctvData,
    });

    this.ws.send(message);
  }

  // emit 方法（与 send 方法相同，用于兼容 Socket.IO 接口）
  emit(event: string, data?: any, callback?: (response: any) => void) {
    this.send(event, data);

    // 如果有回调，模拟 Socket.IO 的回调行为
    // 注意：synctv 是异步的，回调可能不会被调用
    if (callback) {
      console.warn('[synctv-ws] Callback parameter in emit() is not supported in synctv mode');
    }
  }

  // 监听事件
  on(event: string, handler: SynctvEventHandler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  // 移除事件监听（handler 可选，如果不提供则移除该事件的所有监听器）
  off(event: string, handler?: SynctvEventHandler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      if (handler) {
        handlers.delete(handler);
      } else {
        // 如果没有提供 handler，清除该事件的所有监听器
        handlers.clear();
      }
    }
  }

  // 断开连接
  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.connectionPromise = null;
  }

  // 获取连接状态
  getConnected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  // connected 属性（用于兼容 Socket.IO 接口）
  get connected(): boolean {
    return this.getConnected();
  }
}
