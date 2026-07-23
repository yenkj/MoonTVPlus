
    }
  }, []);

  const muteLocalStream = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.enabled = false;
      });
    }
  }, []);

  const unmuteLocalStream = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.enabled = true;
      });
    }
  }, []);

  // 播放远程音频流（完全按照 synctv 原生实现）
  const playRemoteStream = useCallback((peerId: string, stream: MediaStream) => {
    console.log('[SynctvVoice] playRemoteStream called for peer:', peerId, 'streamId:', stream.id);
    console.log('[SynctvVoice] Created new audio element for peer:', peerId, 'total audio elements:', remoteAudioElementsRef.current.size);
  }, []);

  const addLocalTracksToPeer = useCallback((pc: RTCPeerConnection) => {
    if (!localStreamRef.current) return;

    const hasAudioSender = pc.getSenders().some((sender) => sender.track?.kind === 'audio');
    if (hasAudioSender) return;

    localStreamRef.current.getTracks().forEach((track) => {
      pc.addTrack(track, localStreamRef.current!);
    });
  }, []);

  // 创建 WebRTC 连接（完全按照 synctv 原生实现）
  const createPeerConnection = useCallback((peerId: string, client: SynctvWebSocketClient) => {
    // 停止旧的连接（如果存在）
      }
    };

    // 如果本地麦克风可用，把音频轨道挂到当前连接上
    addLocalTracksToPeer(pc);
    // 添加本地流
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        if (localStreamRef.current) {
          pc.addTrack(track, localStreamRef.current);
        }
      });
    }

    // 存储连接（直接覆盖旧的）
    peerConnectionsRef.current.set(peerId, pc);
    return pc;
  }, [addLocalTracksToPeer, isSpeakerEnabled, playRemoteStream]);
  }, [isSpeakerEnabled, playRemoteStream]);

  // 发起连接（创建 Offer）
  const initiateConnection = useCallback(async (peerId: string, client: SynctvWebSocketClient) => {
    if (!localStreamRef.current) return;

    const pc = createPeerConnection(peerId, client);

    try {
    setIsConnected(false);
    console.log('[SynctvVoice] Disconnected');
  }, [stopLocalStream]);

  const renegotiateExistingPeers = useCallback(async () => {
    const client = synctvClientRef.current;
    if (!client || !localStreamRef.current) return;

    await Promise.all(
      Array.from(peerConnectionsRef.current.entries()).map(async ([peerId, pc]) => {
        addLocalTracksToPeer(pc);

        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          const [userId, connId] = peerId.split(':');
          client.sendOffer(userId, connId, offer);
        } catch (err) {
          console.error('[SynctvVoice] Failed to renegotiate with peer:', peerId, err);
        }
      })
    );
  }, [addLocalTracksToPeer]);

  // 自动连接/断开
  useEffect(() => {
    if (!synctvConfig || !synctvConfig.roomId) return;
    };
  }, [disconnect]);
