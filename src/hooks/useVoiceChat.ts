// React Hook for Voice Chat in Watch Room
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WatchRoomSocket } from '@/lib/watch-room-socket';

import type { Member } from '@/types/watch-room';

interface UseVoiceChatOptions {
  socket: WatchRoomSocket | null;
  roomId: string | null;
  isMicEnabled: boolean;
  isSpeakerEnabled: boolean;
  members: Member[];
}

// 语音聊天策略类型
type VoiceStrategy = 'webrtc-fallback' | 'server-only';

// 获取语音聊天策略配置
function getVoiceStrategy(): VoiceStrategy {
  if (typeof window === 'undefined') return 'webrtc-fallback';
  const strategy = (window as any).RUNTIME_CONFIG?.VOICE_CHAT_STRATEGY || 'webrtc-fallback';
  return strategy as VoiceStrategy;
}

export function useVoiceChat({
  socket,
  roomId,
  isMicEnabled,
  isSpeakerEnabled,
  members,
}: UseVoiceChatOptions) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strategy] = useState<VoiceStrategy>(getVoiceStrategy());

  // WebRTC 相关
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const audioContextRef = useRef<AudioContext | null>(null);
  const remoteAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const disconnectionTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map()); // 跟踪连接断开的定时器

  // 音频播放队列管理 - 解决断断续续和重复播放问题
  const audioQueueManagerRef = useRef<Map<string, {
    sequenceNumber: number; // 当前期望的序列号
    queue: Array<{ sequence: number; audioData: number[]; sampleRate: number; timestamp: number }>;
    lastPlayTime: number;
    isPlaying: boolean;
  }>>(new Map());

  // 服务器中转相关
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const sendSequenceNumberRef = useRef<number>(0); // 发送序列号

  // 使用ref存储回退函数，避免循环依赖
  const switchToServerRelayRef = useRef<(() => void) | null>(null);
  const playRemoteStreamRef = useRef<((peerId: string, stream: MediaStream) => void) | null>(null);

  // ICE服务器配置（使用多个免费的STUN服务器作为备份）
  const iceServers = [
    // Cloudflare STUN 服务器（主选，全球 CDN）
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Numb/Viagenie（备选，老牌稳定服务）
    { urls: 'stun:stun.numb.viagenie.ca:3478' },
    // Annatel（备选）
    { urls: 'stun:stun.annatel.net:3478' },
    // Google STUN 服务器（最后备选）
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
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
      console.log('[VoiceChat] Got local stream');
      return stream;
    } catch (err) {
      console.error('[VoiceChat] Failed to get local stream:', err);
      setError('无法访问麦克风，请询问站长https网址并检查权限设置');
      throw err;
    }
  }, []);

  // 停止本地流（完全停止并释放麦克风）
  const stopLocalStream = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
      console.log('[VoiceChat] Stopped local stream');
    }
  }, []);

  // 禁用本地音频轨道（静音，但不释放麦克风）
  const muteLocalStream = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.enabled = false;
      });
      console.log('[VoiceChat] Muted local stream');
    }
  }, []);

  // 启用本地音频轨道（取消静音）
  const unmuteLocalStream = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.enabled = true;
      });
      console.log('[VoiceChat] Unmuted local stream');
    }
  }, []);

  // ==================== WebRTC P2P 逻辑 ====================

  // 创建 RTCPeerConnection
  const createPeerConnection = useCallback((peerId: string) => {
    const pc = new RTCPeerConnection({ iceServers });

    // ICE候选收集
    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('voice:ice', {
          targetUserId: peerId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // 接收远程音频流
    pc.ontrack = (event) => {
      console.log('[VoiceChat] Received remote track from', peerId);
      const remoteStream = event.streams[0];
      remoteStreamsRef.current.set(peerId, remoteStream);

      // 创建音频元素播放远程流
      if (isSpeakerEnabled) {
        playRemoteStreamRef.current?.(peerId, remoteStream);
      }
    };

    // ICE 连接状态变化 - 更准确地反映连接质量
    pc.oniceconnectionstatechange = () => {
      console.log('[VoiceChat] ICE connection state with', peerId, ':', pc.iceConnectionState);

      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        // 连接成功，清除断开定时器
        const timer = disconnectionTimersRef.current.get(peerId);
        if (timer) {
          clearTimeout(timer);
          disconnectionTimersRef.current.delete(peerId);
        }
        setIsConnected(true);
        setIsConnecting(false);
      } else if (pc.iceConnectionState === 'disconnected') {
        // 连接断开，但给它5秒恢复时间
        console.log('[VoiceChat] ICE disconnected for', peerId, ', waiting for recovery...');

        // 清除之前的定时器(如果有)
        const existingTimer = disconnectionTimersRef.current.get(peerId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        // 设置新的定时器
        const timer = setTimeout(() => {
          console.log('[VoiceChat] ICE connection recovery timeout for', peerId);
          // 5秒后仍未恢复，检查是否所有连接都断开了
          if (strategy === 'webrtc-fallback' && pc.iceConnectionState === 'disconnected') {
            // 检查是否还有其他活跃的连接
            let hasActiveConnection = false;
            peerConnectionsRef.current.forEach((otherPc, otherPeerId) => {
              if (otherPeerId !== peerId) {
                const state = otherPc.iceConnectionState;
                if (state === 'connected' || state === 'completed' || state === 'checking') {
                  hasActiveConnection = true;
                }
              }
            });

            // 只有当所有连接都断开时才切换到服务器中转
            if (!hasActiveConnection) {
              console.log('[VoiceChat] All ICE connections failed, switching to server relay');
              switchToServerRelayRef.current?.();
            } else {
              console.log('[VoiceChat] Other connections still active, not switching to server relay');
              // 只关闭这个失败的连接
              pc.close();
              peerConnectionsRef.current.delete(peerId);
            }
          }
          disconnectionTimersRef.current.delete(peerId);
        }, 5000); // 给5秒恢复时间

        disconnectionTimersRef.current.set(peerId, timer);
      } else if (pc.iceConnectionState === 'failed') {
        // ICE 连接彻底失败
        console.log('[VoiceChat] ICE connection failed for', peerId);
        if (strategy === 'webrtc-fallback') {
          // 检查是否还有其他活跃的连接
          let hasActiveConnection = false;
          peerConnectionsRef.current.forEach((otherPc, otherPeerId) => {
            if (otherPeerId !== peerId) {
              const state = otherPc.iceConnectionState;
              if (state === 'connected' || state === 'completed' || state === 'checking') {
                hasActiveConnection = true;
              }
            }
          });

          if (!hasActiveConnection) {
            console.log('[VoiceChat] All ICE connections failed, switching to server relay');
            switchToServerRelayRef.current?.();
          } else {
            console.log('[VoiceChat] Other connections still active, not switching to server relay');
            // 只关闭这个失败的连接
            pc.close();
            peerConnectionsRef.current.delete(peerId);
          }
        }
      }
    };

    // 连接状态变化 - 作为辅助监控
    pc.onconnectionstatechange = () => {
      console.log('[VoiceChat] Connection state with', peerId, ':', pc.connectionState);
      if (pc.connectionState === 'connected') {
        setIsConnected(true);
        setIsConnecting(false);
      } else if (pc.connectionState === 'failed') {
        // 只在 failed 状态时切换，不在 disconnected 时切换
        if (strategy === 'webrtc-fallback') {
          console.log('[VoiceChat] Connection failed, falling back to server relay');
          switchToServerRelayRef.current?.();
        }
      }
    };

    peerConnectionsRef.current.set(peerId, pc);
    return pc;
  }, [socket, isSpeakerEnabled, strategy]);

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

  // 将播放函数存储到ref中，供createPeerConnection使用
  useEffect(() => {
    playRemoteStreamRef.current = playRemoteStream;
  }, [playRemoteStream]);

  // 停止播放远程音频流
  const stopRemoteStream = useCallback((peerId: string) => {
    const audio = remoteAudioElementsRef.current.get(peerId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      remoteAudioElementsRef.current.delete(peerId);
    }
    remoteStreamsRef.current.delete(peerId);

    // 清除该用户的播放时间记录
    nextPlayTimeRef.current.delete(peerId);
  }, []);

  // 清理WebRTC连接
  const cleanupWebRTC = useCallback(() => {
    // 清除所有断开定时器
    disconnectionTimersRef.current.forEach((timer) => {
      clearTimeout(timer);
    });
    disconnectionTimersRef.current.clear();

    // 关闭所有peer connections
    peerConnectionsRef.current.forEach((pc, peerId) => {
      pc.close();
      stopRemoteStream(peerId);
    });
    peerConnectionsRef.current.clear();

    console.log('[VoiceChat] WebRTC cleaned up');
  }, [stopRemoteStream]);

  // 向对等端发起连接（创建offer）
  const initiateConnection = useCallback(async (peerId: string) => {
    if (!socket || !localStreamRef.current) return;

    console.log('[VoiceChat] Initiating connection to', peerId);
    const pc = createPeerConnection(peerId);

    // 添加本地流
    localStreamRef.current.getTracks().forEach(track => {
      if (localStreamRef.current) {
        pc.addTrack(track, localStreamRef.current);
      }
    });

    // 创建offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit('voice:offer', {
        targetUserId: peerId,
        offer: offer,
      });
      console.log('[VoiceChat] Sent offer to', peerId);
    } catch (err) {
      console.error('[VoiceChat] Failed to create offer:', err);
    }
  }, [socket, createPeerConnection]);

  // 处理接收到的offer
  const handleOffer = useCallback(async (data: { userId: string; offer: RTCSessionDescriptionInit }) => {
    if (!socket) return;

    console.log('[VoiceChat] Received offer from', data.userId);
    const pc = createPeerConnection(data.userId);

    // 如果有本地流，添加音频轨道
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        if (localStreamRef.current) {
          pc.addTrack(track, localStreamRef.current);
          console.log('[VoiceChat] Added local track to answer');
        }
      });
    } else {
      console.log('[VoiceChat] No local stream, creating answer without sending audio');
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('voice:answer', {
        targetUserId: data.userId,
        answer: answer,
      });
      console.log('[VoiceChat] Sent answer to', data.userId);
    } catch (err) {
      console.error('[VoiceChat] Failed to handle offer:', err);
    }
  }, [socket, createPeerConnection]);

  // 处理接收到的answer
  const handleAnswer = useCallback(async (data: { userId: string; answer: RTCSessionDescriptionInit }) => {
    console.log('[VoiceChat] Received answer from', data.userId);
    const pc = peerConnectionsRef.current.get(data.userId);
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    } catch (err) {
      console.error('[VoiceChat] Failed to handle answer:', err);
    }
  }, []);

  // 处理接收到的ICE候选
  const handleIceCandidate = useCallback(async (data: { userId: string; candidate: RTCIceCandidateInit }) => {
    const pc = peerConnectionsRef.current.get(data.userId);
    if (!pc) return;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.error('[VoiceChat] Failed to add ICE candidate:', err);
    }
  }, []);

  // ==================== 服务器中转逻辑 ====================

  // 音频数据发送队列和节流控制
  const audioQueueRef = useRef<{
    lastSendTime: number;
    queueSize: number;
    droppedPackets: number;
  }>({
    lastSendTime: 0,
    queueSize: 0,
    droppedPackets: 0
  });

  // 启动服务器中转
  const startServerRelay = useCallback(() => {
    if (!socket || !localStreamRef.current) {
      console.error('[VoiceChat] Cannot start server relay - missing socket or stream');
      return;
    }

    if (!roomId) {
      console.error('[VoiceChat] Cannot start server relay - missing roomId');
      return;
    }

    console.log('[VoiceChat] Starting server relay');

    try {
      // 创建AudioContext来处理音频
      const audioContext = new AudioContext({ sampleRate: 16000 }); // 降低采样率以减少数据量
      const source = audioContext.createMediaStreamSource(localStreamRef.current);

      // 使用ScriptProcessorNode处理音频数据
      const bufferSize = 4096;
      const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

      // 保存roomId的引用，避免闭包问题
      const currentRoomId = roomId;

      // 节流控制参数
      const MIN_SEND_INTERVAL = 50; // 最小发送间隔（毫秒）
      const MAX_QUEUE_SIZE = 10; // 最大队列大小
      const MAX_DROPPED_PACKETS = 100; // 最大丢包数，超过则重置

      processor.onaudioprocess = (e) => {
        if (!socket || !socket.connected) {
          return;
        }

        const now = Date.now();
        const queueState = audioQueueRef.current;

        // 节流控制：如果距离上次发送时间太短，跳过本次发送
        if (now - queueState.lastSendTime < MIN_SEND_INTERVAL) {
          return;
        }

        // 如果队列堆积太多，丢弃本次数据包
        if (queueState.queueSize >= MAX_QUEUE_SIZE) {
          queueState.droppedPackets++;
          if (queueState.droppedPackets > MAX_DROPPED_PACKETS) {
            // 重置队列状态
            queueState.queueSize = 0;
            queueState.droppedPackets = 0;
            console.warn('[VoiceChat] Audio queue overflow, resetting...');
          }
          return;
        }

        const inputData = e.inputBuffer.getChannelData(0);

        // 计算音频能量，判断是否为有效数据
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);

        // 如果音频能量低于阈值（静音或无效数据），则不发送
        // RMS阈值设为0.01，可以过滤掉大部分静音和无效数据
        const SILENCE_THRESHOLD = 0.01;
        if (rms < SILENCE_THRESHOLD) {
          return;
        }

        // 将Float32Array转换为Int16Array（PCM格式）以减少数据量
        const pcmData = new Int16Array(inputData.length);
        let zeroCount = 0;
        for (let i = 0; i < inputData.length; i++) {
          // 将-1到1的浮点数转换为-32768到32767的整数
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;

          // 统计接近0的样本数量（阈值为256，约为1%的最大值）
          if (Math.abs(pcmData[i]) < 256) {
            zeroCount++;
          }
        }

        // 如果超过95%的数据接近0，则认为是无效数据包，不发送
        const zeroRatio = zeroCount / pcmData.length;
        if (zeroRatio > 0.95) {
          return;
        }

        // 更新发送状态
        queueState.lastSendTime = now;
        queueState.queueSize++;

        // 增加序列号
        sendSequenceNumberRef.current++;

        // 发送PCM数据到服务器，包含序列号
        try {
          socket.emit('voice:audio-chunk', {
            roomId: currentRoomId,
            audioData: Array.from(new Uint8Array(pcmData.buffer)),
            sampleRate: 16000,
            sequence: sendSequenceNumberRef.current, // 添加序列号
            timestamp: Date.now(), // 添加时间戳
          });

          // 发送成功后减少队列计数
          queueState.queueSize = Math.max(0, queueState.queueSize - 1);
        } catch (err) {
          console.error('[VoiceChat] Failed to send audio chunk:', err);
          queueState.queueSize = Math.max(0, queueState.queueSize - 1);
        }
      };

      source.connect(processor);

      // ScriptProcessorNode需要连接到某个节点才能触发onaudioprocess
      // 但连接到destination会产生本地回声，所以创建一个静音的GainNode
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 0; // 静音，不输出到喇叭
      processor.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // 保存引用以便清理
      audioContextRef.current = audioContext;
      mediaRecorderRef.current = processor as any; // 存储processor用于清理

      console.log('[VoiceChat] Server relay started');
    } catch (err) {
      console.error('[VoiceChat] Failed to start server relay:', err);
      setError('服务器中转启动失败');
    }
  }, [socket, roomId]);

  // 停止服务器中转
  const stopServerRelay = useCallback(() => {
    if (mediaRecorderRef.current) {
      // ScriptProcessorNode没有stop方法，需要断开连接
      const processor = mediaRecorderRef.current as any;
      if (processor.disconnect) {
        processor.disconnect();
      }
      mediaRecorderRef.current = null;
      console.log('[VoiceChat] Server relay stopped');
    }
  }, []);

  // 切换到服务器中转模式
  const switchToServerRelay = useCallback(async () => {
    console.log('[VoiceChat] Switching to server relay mode');
    setError('P2P连接失败，切换到服务器中转模式');

    // 清理WebRTC连接
    cleanupWebRTC();

    // 启动服务器中转
    if (isMicEnabled && localStreamRef.current) {
      // 确保音频轨道是启用的
      const tracks = localStreamRef.current.getTracks();
      const hasEnabledTrack = tracks.some(track => track.enabled && track.readyState === 'live');

      if (hasEnabledTrack) {
        startServerRelay();
      } else {
        console.error('[VoiceChat] Cannot start server relay - no enabled audio tracks');
        setError('服务器中转启动失败：麦克风未启用');
      }
    } else {
      console.error('[VoiceChat] Cannot start server relay - mic disabled or no stream');
      setError('服务器中转启动失败：麦克风未开启');
    }
  }, [isMicEnabled, cleanupWebRTC, startServerRelay]);

  // 将回退函数存储到ref中，供createPeerConnection使用
  useEffect(() => {
    switchToServerRelayRef.current = switchToServerRelay;
  }, [switchToServerRelay]);

  // 播放服务器中转的音频 - 重构版，解决断断续续和重复播放问题
  const playServerRelayAudio = useCallback(async (
    userId: string,
    audioData: number[],
    sampleRate = 16000,
    sequence?: number,
    timestamp?: number
  ) => {
    if (!isSpeakerEnabled) return;

    try {
      // 创建AudioContext（如果不存在）
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      }

      const audioContext = audioContextRef.current;

      // 如果 AudioContext 被暂停，恢复它
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      // 初始化该用户的队列管理器
      if (!audioQueueManagerRef.current.has(userId)) {
        audioQueueManagerRef.current.set(userId, {
          sequenceNumber: 0,
          queue: [],
          lastPlayTime: 0,
          isPlaying: false,
        });
      }

      const queueManager = audioQueueManagerRef.current.get(userId)!;

      // 如果有序列号，进行去重和排序处理
      if (sequence !== undefined) {
        // 去重：如果已经处理过这个序列号，直接返回
        if (sequence <= queueManager.sequenceNumber) {
          console.warn(`[VoiceChat] Duplicate or old sequence ${sequence} from ${userId}, current is ${queueManager.sequenceNumber}`);
          return;
        }

        // 如果序列号跳跃太大（超过100），说明有大量丢包，重置队列
        if (sequence - queueManager.sequenceNumber > 100) {
          console.warn(`[VoiceChat] Sequence jump detected for ${userId}, resetting queue`);
          queueManager.sequenceNumber = sequence;
          queueManager.queue = [];
        }

        // 添加到队列
        queueManager.queue.push({
          sequence,
          audioData,
          sampleRate,
          timestamp: timestamp || Date.now(),
        });

        // 按序列号排序
        queueManager.queue.sort((a, b) => a.sequence - b.sequence);

        // 限制队列大小，防止内存泄漏
        const MAX_QUEUE_SIZE = 20;
        if (queueManager.queue.length > MAX_QUEUE_SIZE) {
          queueManager.queue = queueManager.queue.slice(-MAX_QUEUE_SIZE);
        }
      } else {
        // 如果没有序列号，直接播放（向后兼容）
        queueManager.queue.push({
          sequence: queueManager.sequenceNumber++,
          audioData,
          sampleRate,
          timestamp: timestamp || Date.now(),
        });
      }

      // 处理队列中的音频包
      await processAudioQueue(userId, audioContext);

    } catch (err) {
      console.error('[VoiceChat] Failed to play audio:', err);
    }
  }, [isSpeakerEnabled]);

  // 处理音频队列
  const processAudioQueue = async (userId: string, audioContext: AudioContext) => {
    const queueManager = audioQueueManagerRef.current.get(userId);
    if (!queueManager || queueManager.isPlaying || queueManager.queue.length === 0) {
      return;
    }

    queueManager.isPlaying = true;

    try {
      // 获取下一个要播放的音频包
      const nextPacket = queueManager.queue[0];

      // 检查是否是期望的下一个序列号
      if (nextPacket.sequence !== queueManager.sequenceNumber + 1) {
        // 如果不是下一个期望的序列号，可能是有丢包或乱序
        // 为了保持流畅性，跳过丢失的包，继续播放
        if (nextPacket.sequence > queueManager.sequenceNumber + 1) {
          console.warn(`[VoiceChat] Skipping ${nextPacket.sequence - queueManager.sequenceNumber - 1} packets for ${userId}`);
        }
        queueManager.sequenceNumber = nextPacket.sequence;
      } else {
        queueManager.sequenceNumber++;
      }

      // 从队列中移除
      queueManager.queue.shift();

      // 播放音频
      await playAudioPacket(userId, nextPacket.audioData, nextPacket.sampleRate, audioContext);

    } finally {
      queueManager.isPlaying = false;

      // 如果队列中还有音频，继续处理
      if (queueManager.queue.length > 0) {
        setTimeout(() => processAudioQueue(userId, audioContext), 5);
      }
    }
  };

  // 播放单个音频包
  const playAudioPacket = async (
    userId: string,
    audioData: number[],
    sampleRate: number,
    audioContext: AudioContext
  ) => {
    // 将Uint8Array转换回Int16Array (PCM数据)
    const uint8Array = new Uint8Array(audioData);
    const int16Array = new Int16Array(uint8Array.buffer);

    // 将Int16Array转换为Float32Array（AudioBuffer需要的格式）
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      // 将-32768到32767的整数转换回-1到1的浮点数
      float32Array[i] = int16Array[i] / (int16Array[i] < 0 ? 0x8000 : 0x7FFF);
    }

    // 创建AudioBuffer
    const audioBuffer = audioContext.createBuffer(1, float32Array.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32Array);

    // 计算音频块的持续时间
    const duration = float32Array.length / sampleRate;

    // 创建AudioBufferSourceNode并立即播放
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;

    // 添加增益节点
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0.8; // 稍微降低音量，避免爆音

    source.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // 立即播放，不使用调度，避免累积延迟
    source.start(0);
  };

  // ==================== 清理函数 ====================

  // 清理所有连接
  const cleanup = useCallback(() => {
    stopLocalStream();
    cleanupWebRTC();
    stopServerRelay();

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // 清除音频队列管理器
    audioQueueManagerRef.current.clear();

    // 重置发送序列号
    sendSequenceNumberRef.current = 0;

    setIsConnected(false);
    setIsConnecting(false);
    setError(null);

    console.log('[VoiceChat] All cleaned up');
  }, [stopLocalStream, cleanupWebRTC, stopServerRelay]);

  // ==================== 主要控制逻辑 ====================

  // 监听麦克风状态变化
  useEffect(() => {
    if (!socket || !roomId) return;

    if (isMicEnabled) {
      // 开启麦克风
      // 检查是否已经有本地流（可能只是被静音了）
      if (localStreamRef.current) {
        // 已有本地流，只需取消静音
        console.log('[VoiceChat] Unmuting existing local stream');
        unmuteLocalStream();
        // 重新启动服务器中转（如果需要）
        if (strategy === 'server-only' || peerConnectionsRef.current.size === 0) {
          startServerRelay();
        }
        return;
      }

      // 没有本地流，需要重新获取
      setIsConnecting(true);
      setError(null);

      getLocalStream()
        .then(() => {
          console.log('[VoiceChat] Local stream ready');

          if (strategy === 'server-only') {
            // 仅使用服务器中转
            startServerRelay();
          } else {
            // 使用WebRTC P2P连接
            console.log('[VoiceChat] WebRTC mode - initiating peer connections');

            // 向房间内的其他成员发起连接
            const otherMembers = members.filter(m => m.id !== socket.id);
            console.log('[VoiceChat] Found', otherMembers.length, 'other members, initiating connections');

            if (otherMembers.length > 0) {
              otherMembers.forEach(member => {
                console.log('[VoiceChat] Initiating connection to', member.name, member.id);
                initiateConnection(member.id);
              });
            } else {
              // 如果没有其他成员，先启动服务器中转作为后备
              console.log('[VoiceChat] No other members, using server relay as fallback');
              startServerRelay();
            }
          }

          setIsConnecting(false);
        })
        .catch(() => {
          setIsConnecting(false);
        });
    } else {
      // 关闭麦克风 - 只静音，不断开连接
      muteLocalStream();
      // 停止服务器中转（因为不需要发送音频了）
      stopServerRelay();
    }

    // 不需要 cleanup，因为我们希望保持连接
    // cleanup 只在房间变化时调用
  }, [isMicEnabled, socket, roomId, strategy, members, getLocalStream, muteLocalStream, unmuteLocalStream, stopServerRelay, startServerRelay, initiateConnection]);

  // 监听喇叭状态变化
  useEffect(() => {
    if (isSpeakerEnabled) {
      // 开启喇叭 - 播放所有远程流
      remoteStreamsRef.current.forEach((stream, peerId) => {
        playRemoteStream(peerId, stream);
      });
    } else {
      // 关闭喇叭 - 静音所有远程流
      remoteAudioElementsRef.current.forEach(audio => {
        audio.muted = true;
      });
    }

    // 恢复音量
    return () => {
      if (isSpeakerEnabled) {
        remoteAudioElementsRef.current.forEach(audio => {
          audio.muted = false;
        });
      }
    };
  }, [isSpeakerEnabled, playRemoteStream]);

  // 监听Socket.IO事件
  useEffect(() => {
    if (!socket) return;

    // WebRTC信令事件
    socket.on('voice:offer', handleOffer);
    socket.on('voice:answer', handleAnswer);
    socket.on('voice:ice', handleIceCandidate);

    // 监听其他用户开启麦克风的通知
    socket.on('voice:mic-enabled', (data: { userId: string }) => {
      console.log('[VoiceChat] User', data.userId, 'enabled microphone');
      // 其他用户开启了麦克风，我们不需要做任何事，等待接收他们的offer即可
    });

    // 服务器中转事件
    const handleAudioChunk = (data: { userId: string; audioData: number[]; sampleRate?: number }) => {
      // 过滤掉自己发送的音频，避免回声
      if (data.userId === socket.id) {
        return;
      }

      if (strategy === 'server-only' || !peerConnectionsRef.current.has(data.userId)) {
        // 只有在服务器中转模式或WebRTC连接失败时才播放服务器中转的音频
        playServerRelayAudio(data.userId, data.audioData, data.sampleRate || 16000);
      }
    };

    socket.on('voice:audio-chunk', handleAudioChunk);

    return () => {
      socket.off('voice:offer', handleOffer);
      socket.off('voice:answer', handleAnswer);
      socket.off('voice:ice', handleIceCandidate);
      socket.off('voice:mic-enabled');
      socket.off('voice:audio-chunk', handleAudioChunk);
    };
  }, [socket, strategy, handleOffer, handleAnswer, handleIceCandidate, playServerRelayAudio]);

  // 监听房间成员变化 - 处理新成员加入的情况
  useEffect(() => {
    // 只在WebRTC模式、麦克风开启、有本地流的情况下才处理
    if (strategy !== 'webrtc-fallback' || !isMicEnabled || !localStreamRef.current || !socket) {
      return;
    }

    // 检查是否有新成员加入
    const currentPeerIds = Array.from(peerConnectionsRef.current.keys());
    const memberIds = members.filter(m => m.id !== socket.id).map(m => m.id);

    // 找出新加入的成员（在memberIds中但不在currentPeerIds中）
    const newMemberIds = memberIds.filter(id => !currentPeerIds.includes(id));

    if (newMemberIds.length > 0) {
      console.log('[VoiceChat] New members joined, initiating connections:', newMemberIds);
      newMemberIds.forEach(memberId => {
        const member = members.find(m => m.id === memberId);
        if (member) {
          console.log('[VoiceChat] Initiating connection to new member:', member.name, member.id);
          initiateConnection(member.id);
        }
      });
    }
  }, [members, strategy, isMicEnabled, socket, initiateConnection]);

  // 房间变化时清理
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [roomId, cleanup]);

  return {
    isConnecting,
    isConnected,
    error,
    strategy,
    initiateConnection, // 暴露给外部使用，用于向新加入的成员发起连接
  };
}
