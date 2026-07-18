/**
 * synctv WebSocket 客户端
 * 用于连接 synctv 服务器，通过 WebRTC 进行语音通信
 */

import {
  MessageType,
  Message,
  WebRTCData,
  encodeMessage,
  decodeMessage,
} from './synctv-proto';

export interface SynctvWSConfig {
  url: string;
  token: string;
  roomId: string; // synctv 需要 roomId
}

// WebRTC 事件处理器
export type WebRTCEventHandler = (data: WebRTCData, sender?: { userId: string; username: string }) => void;

export class SynctvWebSocketClient {
  private ws: WebSocket | null = null;
  private config: SynctvWSConfig | null = null;
  private connectionPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 2000;
  private isConnected = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  // WebRTC 事件处理器
  private webrtcHandlers: Map<MessageType, Set<WebRTCEventHandler>> = new Map();

  // 用户信息（从 synctv 获取）
  private userId: string = '';
  private username: string = '';
  private connId: string = '';

  // Socket ID（兼容 Socket.IO 的 id 属性）
  readonly id: string;

  constructor() {
    // 生成临时 ID
    this.id = Math.random().toString(36).substring(2, 15) + '-' + Math.random().toString(36).substring(2, 15);
    this.connId = this.id;
  }

  // 函数重载：支持带参数和不带参数两种调用方式
  connect(): Promise<void>;
  connect(config: SynctvWSConfig): Promise<void>;
  async connect(config?: SynctvWSConfig): Promise<void> {
    // 如果没有传入 config，使用之前保存的 config
    if (!config) {
      if (!this.config) {
        throw new Error('No config available for reconnection');
      }
      config = this.config;
    }

    // 此时 config 一定不是 undefined
    const finalConfig = config;

    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.config = finalConfig;

    this.connectionPromise = new Promise((resolve, reject) => {
      try {
        const wsUrl = this.buildWebSocketUrl(finalConfig);
        console.log('[synctv-ws] Connecting to:', wsUrl);

        // 创建 WebSocket 连接，使用 token 作为 subprotocol
        this.ws = new WebSocket(wsUrl, [finalConfig.token]);

        // 重要：设置 binaryType 为 arraybuffer
        this.ws.binaryType = 'arraybuffer';

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
    // synctv WebSocket 路径需要包含 roomId
    url.pathname = `/api/room/${config.roomId}/ws`;
    return url.toString();
  }

  private handleMessage(data: ArrayBuffer | string) {
    try {
      // synctv 发送的是二进制 protobuf 消息
      let uint8Array: Uint8Array;
      if (typeof data === 'string') {
        // 如果是字符串（不应该发生，但做保护）
        console.warn('[synctv-ws] Received string message, expected binary');
        uint8Array = new TextEncoder().encode(data);
      } else {
        uint8Array = new Uint8Array(data);
      }

      // 解码 protobuf 消息
      const msg: Message = decodeMessage(uint8Array);

      // 处理不同类型的消息
      this.handleMessageType(msg);
    } catch (error) {
      console.error('[synctv-ws] Error handling message:', error);
    }
  }

  private handleMessageType(msg: Message) {
    switch (msg.type) {
      case MessageType.ERROR:
        console.error('[synctv-ws] Server error:', msg.errorMessage);
        break;

      case MessageType.VIEWER_COUNT:
        // 观看人数更新
        console.log('[synctv-ws] Viewer count:', msg.viewerCount);
        break;

      case MessageType.WEBRTC_OFFER:
      case MessageType.WEBRTC_ANSWER:
      case MessageType.WEBRTC_ICE_CANDIDATE:
      case MessageType.WEBRTC_JOIN:
      case MessageType.WEBRTC_LEAVE:
        // WebRTC 相关事件
        if (msg.webrtcData) {
          this.triggerWebRTCHandlers(msg.type, msg.webrtcData, msg.sender);
        }
        break;

      default:
        // 忽略其他消息类型（播放同步等由 MoonTVPlus 自己处理）
        break;
    }
  }

  private triggerWebRTCHandlers(type: MessageType, data: WebRTCData, sender?: { userId: string; username: string }) {
    const handlers = this.webrtcHandlers.get(type);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(data, sender);
        } catch (error) {
          console.error(`[synctv-ws] Error in WebRTC handler for type ${type}:`, error);
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

    // synctv 不需要显式的心跳，但我们可以定期检查连接状态
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        console.warn('[synctv-ws] Connection lost');
      }
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ==================== WebRTC 方法 ====================

  /**
   * 加入 WebRTC 会话
   */
  joinWebRTC() {
    this.sendWebRTCMessage(MessageType.WEBRTC_JOIN, {
      data: '',
      to: '',
      from: `${this.userId}:${this.connId}`,
    });
  }

  /**
   * 离开 WebRTC 会话
   */
  leaveWebRTC() {
    this.sendWebRTCMessage(MessageType.WEBRTC_LEAVE, {
      data: '',
      to: '',
      from: `${this.userId}:${this.connId}`,
    });
  }

  /**
   * 发送 WebRTC Offer
   */
  sendOffer(targetUserId: string, targetConnId: string, offer: RTCSessionDescriptionInit) {
    this.sendWebRTCMessage(MessageType.WEBRTC_OFFER, {
      data: JSON.stringify(offer),
      to: `${targetUserId}:${targetConnId}`,
      from: `${this.userId}:${this.connId}`,
    });
  }

  /**
   * 发送 WebRTC Answer
   */
  sendAnswer(targetUserId: string, targetConnId: string, answer: RTCSessionDescriptionInit) {
    this.sendWebRTCMessage(MessageType.WEBRTC_ANSWER, {
      data: JSON.stringify(answer),
      to: `${targetUserId}:${targetConnId}`,
      from: `${this.userId}:${this.connId}`,
    });
  }

  /**
   * 发送 ICE Candidate
   */
  sendIceCandidate(targetUserId: string, targetConnId: string, candidate: RTCIceCandidateInit) {
    this.sendWebRTCMessage(MessageType.WEBRTC_ICE_CANDIDATE, {
      data: JSON.stringify(candidate),
      to: `${targetUserId}:${targetConnId}`,
      from: `${this.userId}:${this.connId}`,
    });
  }

  /**
   * 监听 WebRTC 事件
   */
  onWebRTC(type: MessageType, handler: WebRTCEventHandler) {
    if (!this.webrtcHandlers.has(type)) {
      this.webrtcHandlers.set(type, new Set());
    }
    this.webrtcHandlers.get(type)!.add(handler);
  }

  /**
   * 移除 WebRTC 事件监听
   */
  offWebRTC(type: MessageType, handler?: WebRTCEventHandler) {
    const handlers = this.webrtcHandlers.get(type);
    if (handlers) {
      if (handler) {
        handlers.delete(handler);
      } else {
        handlers.clear();
      }
    }
  }

  /**
   * 发送 WebRTC 消息（内部方法）
   */
  private sendWebRTCMessage(type: MessageType, webrtcData: WebRTCData) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[synctv-ws] WebSocket is not connected');
      return;
    }

    const msg: Message = {
      type,
      timestamp: Date.now(),
      webrtcData,
    };

    const encoded = encodeMessage(msg);
    this.ws.send(encoded);
  }

  // ==================== Socket.IO 兼容接口 ====================

  /**
   * 发送事件（兼容 Socket.IO，但 synctv 主要用于 WebRTC）
   */
  emit(event: string, data?: any, callback?: (response: any) => void) {
    // 对于 WebRTC 事件，使用专用方法
    if (event === 'voice:webrtc:join') {
      this.joinWebRTC();
      return;
    }
    if (event === 'voice:webrtc:leave') {
      this.leaveWebRTC();
      return;
    }

    // 其他事件暂不处理
    console.warn('[synctv-ws] emit() for non-WebRTC events is not supported:', event);
  }

  /**
   * 监听事件（兼容 Socket.IO）
   */
  on(event: string, handler: (data: any) => void) {
    // 将 Socket.IO 事件名转换为 synctv 的 WebRTC 类型
    const typeMap: Record<string, MessageType> = {
      'voice:webrtc:offer': MessageType.WEBRTC_OFFER,
      'voice:webrtc:answer': MessageType.WEBRTC_ANSWER,
      'voice:webrtc:ice': MessageType.WEBRTC_ICE_CANDIDATE,
      'voice:webrtc:join': MessageType.WEBRTC_JOIN,
      'voice:webrtc:leave': MessageType.WEBRTC_LEAVE,
    };

    const msgType = typeMap[event];
    if (msgType !== undefined) {
      this.onWebRTC(msgType, (data, sender) => {
        handler({ data, sender });
      });
    } else {
      console.warn('[synctv-ws] on() for non-WebRTC events is not supported:', event);
    }
  }

  /**
   * 移除事件监听（兼容 Socket.IO）
   */
  off(event: string, handler?: (data: any) => void) {
    const typeMap: Record<string, MessageType> = {
      'voice:webrtc:offer': MessageType.WEBRTC_OFFER,
      'voice:webrtc:answer': MessageType.WEBRTC_ANSWER,
      'voice:webrtc:ice': MessageType.WEBRTC_ICE_CANDIDATE,
      'voice:webrtc:join': MessageType.WEBRTC_JOIN,
      'voice:webrtc:leave': MessageType.WEBRTC_LEAVE,
    };

    const msgType = typeMap[event];
    if (msgType !== undefined) {
      this.offWebRTC(msgType);
    }
  }

  /**
   * 只监听一次事件（兼容 Socket.IO）
   */
  once(event: string, handler: (data: any) => void) {
    const wrappedHandler = (data: any) => {
      this.off(event, wrappedHandler);
      handler(data);
    };
    this.on(event, wrappedHandler);
  }

  // ==================== 连接管理 ====================

  /**
   * 断开连接
   */
  disconnect() {
    this.stopHeartbeat();

    // 离开 WebRTC
    if (this.isConnected) {
      this.leaveWebRTC();
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.connectionPromise = null;
  }

  /**
   * 获取连接状态
   */
  get connected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * 获取用户 ID
   */
  getUserId(): string {
    return this.userId;
  }

  /**
   * 设置用户信息
   */
  setUserInfo(userId: string, username: string) {
    this.userId = userId;
    this.username = username;
  }
}
