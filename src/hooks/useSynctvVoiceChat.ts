// React Hook for Voice Chat using synctv WebRTC
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { SynctvWebSocketClient, SynctvWSConfig } from '@/lib/synctv-ws-client';
import { MessageType } from '@/lib/synctv-proto';

import type { Member } from '@/types/watch-room';

interface UseSynctvVoiceChatOptions {
  synctvConfig: SynctvWSConfig | null;
  roomId: string | null;
  isMicEnabled: boolean;
  isSpeakerEnabled: boolean;
  members: Member[];
}

export function useSynctvVoiceChat({
  synctvConfig,
  roomId,
  isMicEnabled,
  isSpeakerEnabled,
  members,
}: UseSynctvVoiceChatOptions) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // synctv WebSocket 客户端
  const synctvClientRef = useRef<SynctvWebSocketClient | null>(null);

  // WebRTC 相关
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // ICE 服务器配置
  const iceServers = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ];

  // 获取本地麦克风流
  const getLocalStream = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      localStreamRef.current = stream;
      console.log('[SynctvVoice] Got local stream');
      return stream;
    } catch (err) {
      console.error('[SynctvVoice] Failed to get local stream:', err);
      setError('无法访问麦克风');
      throw err;
    }
  }, []);

  // 停止本地流
  const stopLocalStream = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
  }, []);

  // 播放远程音频流
  const playRemoteStream = useCallback((peerId: string, stream: MediaStream) => {
    let audio = remoteAudioElementsRef.current.get(peerId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      remoteAudioElementsRef.current.set(peerId, audio);
    }
    audio.srcObject = stream;
  }, []);

  // 创建 WebRTC 连接
  const createPeerConnection = useCallback((peerId: string, client: SynctvWebSocketClient) => {
    const pc = new RTCPeerConnection({ iceServers });

    // ICE 候选收集
    pc.onicecandidate = (event) => {
      if (event.candidate && client.connected) {
        const [userId, connId] = peerId.split(':');
        client.sendIceCandidate(userId, connId, event.candidate.toJSON());
      }
    };

    // 接收远程音频流
    pc.ontrack = (event) => {
      console.log('[SynctvVoice] Received remote track from', peerId);
      const remoteStream = event.streams[0];
      if (isSpeakerEnabled) {
        playRemoteStream(peerId, remoteStream);
      }
    };

    peerConnectionsRef.current.set(peerId, pc);
    return pc;
  }, [isSpeakerEnabled, playRemoteStream]);

  // 发起连接（创建 Offer）
  const initiateConnection = useCallback(async (peerId: string, client: SynctvWebSocketClient) => {
    if (!localStreamRef.current) return;

    const pc = createPeerConnection(peerId, client);

    // 添加本地流
    localStreamRef.current.getTracks().forEach(track => {
      if (localStreamRef.current) {
        pc.addTrack(track, localStreamRef.current);
      }
    });

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const [userId, connId] = peerId.split(':');
      client.sendOffer(userId, connId, offer);
      console.log('[SynctvVoice] Sent offer to', peerId);
    } catch (err) {
      console.error('[SynctvVoice] Failed to create offer:', err);
    }
  }, [createPeerConnection]);

  // 处理 WebRTC 事件
  const setupWebRTCEventHandlers = useCallback((client: SynctvWebSocketClient) => {
    // 监听有人加入 WebRTC
    client.onWebRTC(MessageType.WEBRTC_JOIN, (data, sender) => {
      if (!sender) return;

      const peerId = `${sender.userId}:${data.from.split(':')[1]}`;
      console.log('[SynctvVoice] Peer joined:', peerId);

      // 发起连接
      if (localStreamRef.current) {
        initiateConnection(peerId, client);
      }
    });

    // 监听 Offer
    client.onWebRTC(MessageType.WEBRTC_OFFER, async (data, sender) => {
      if (!sender || !localStreamRef.current) return;

      const peerId = `${sender.userId}:${data.from.split(':')[1]}`;
      console.log('[SynctvVoice] Received offer from', peerId);

      const pc = createPeerConnection(peerId, client);

      // 添加本地流
      localStreamRef.current.getTracks().forEach(track => {
        if (localStreamRef.current) {
          pc.addTrack(track, localStreamRef.current);
        }
      });

      try {
        await pc.setRemoteDescription(JSON.parse(data.data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const [userId, connId] = peerId.split(':');
        client.sendAnswer(userId, connId, answer);
        console.log('[SynctvVoice] Sent answer to', peerId);
      } catch (err) {
        console.error('[SynctvVoice] Failed to handle offer:', err);
      }
    });

    // 监听 Answer
    client.onWebRTC(MessageType.WEBRTC_ANSWER, async (data, sender) => {
      if (!sender) return;

      const peerId = `${sender.userId}:${data.from.split(':')[1]}`;
      console.log('[SynctvVoice] Received answer from', peerId);

      const pc = peerConnectionsRef.current.get(peerId);
      if (!pc) return;

      try {
        await pc.setRemoteDescription(JSON.parse(data.data));
      } catch (err) {
        console.error('[SynctvVoice] Failed to handle answer:', err);
      }
    });

    // 监听 ICE Candidate
    client.onWebRTC(MessageType.WEBRTC_ICE_CANDIDATE, async (data, sender) => {
      if (!sender) return;

      const peerId = `${sender.userId}:${data.from.split(':')[1]}`;
      console.log('[SynctvVoice] Received ICE candidate from', peerId);

      const pc = peerConnectionsRef.current.get(peerId);
      if (!pc) return;

      try {
        await pc.addIceCandidate(JSON.parse(data.data));
      } catch (err) {
        console.error('[SynctvVoice] Failed to add ICE candidate:', err);
      }
    });

    // 监听有人离开
    client.onWebRTC(MessageType.WEBRTC_LEAVE, (data, sender) => {
      if (!sender) return;

      const peerId = `${sender.userId}:${data.from.split(':')[1]}`;
      console.log('[SynctvVoice] Peer left:', peerId);

      const pc = peerConnectionsRef.current.get(peerId);
      if (pc) {
        pc.close();
        peerConnectionsRef.current.delete(peerId);
      }

      // 停止播放音频
      const audio = remoteAudioElementsRef.current.get(peerId);
      if (audio) {
        audio.pause();
        audio.srcObject = null;
        remoteAudioElementsRef.current.delete(peerId);
      }
    });
  }, [createPeerConnection, initiateConnection]);

  // 连接到 synctv
  const connect = useCallback(async () => {
    if (!synctvConfig || !roomId) {
      console.error('[SynctvVoice] Missing config or roomId');
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      // 获取麦克风流
      await getLocalStream();

      // 创建 synctv 客户端
      const client = new SynctvWebSocketClient();
      synctvClientRef.current = client;

      // 连接到 synctv
      await client.connect({
        ...synctvConfig,
        roomId,
      });

      // 设置用户信息
      client.setUserInfo(client.id, 'user');

      // 设置 WebRTC 事件处理器
      setupWebRTCEventHandlers(client);

      // 加入 WebRTC
      client.joinWebRTC();

      setIsConnected(true);
      console.log('[SynctvVoice] Connected to synctv');
    } catch (err) {
      console.error('[SynctvVoice] Failed to connect:', err);
      setError('连接失败');
    } finally {
      setIsConnecting(false);
    }
  }, [synctvConfig, roomId, getLocalStream, setupWebRTCEventHandlers]);

  // 断开连接
  const disconnect = useCallback(() => {
    if (synctvClientRef.current) {
      synctvClientRef.current.disconnect();
      synctvClientRef.current = null;
    }

    // 关闭所有 peer connections
    peerConnectionsRef.current.forEach(pc => pc.close());
    peerConnectionsRef.current.clear();

    // 停止本地流
    stopLocalStream();

    // 停止所有音频
    remoteAudioElementsRef.current.forEach(audio => {
      audio.pause();
      audio.srcObject = null;
    });
    remoteAudioElementsRef.current.clear();

    setIsConnected(false);
    console.log('[SynctvVoice] Disconnected');
  }, [stopLocalStream]);

  // 自动连接/断开
  useEffect(() => {
    if (isMicEnabled && synctvConfig && roomId) {
      connect();
    } else if (!isMicEnabled) {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [isMicEnabled, synctvConfig, roomId, connect, disconnect]);

  // 静音/取消静音
  useEffect(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.enabled = isMicEnabled;
      });
    }
  }, [isMicEnabled]);

  return {
    isConnecting,
    isConnected,
    error,
    connect,
    disconnect,
  };
}
