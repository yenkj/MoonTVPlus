// Next.js 自定义服务器 + Socket.IO
const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { Server } = require('socket.io');
const {
  attachTVRemoteIO,
  cleanupTVRemoteDevices,
  clearTVRemoteHub,
  registerTVRemoteDevice,
  removeTVRemoteSocket,
  updateTVRemoteDevice,
} = require('./src/lib/tv-remote-hub.js');

// synctv 集成相关（支持 http 和 https）
const SYNCTV_URL = process.env.SYNCTV_URL; // 支持任意 URL，包括 https
const SYNCTV_ADMIN_USER = process.env.SYNCTV_ADMIN_USER; // 从环境变量读取，不设默认值
const SYNCTV_ADMIN_PASSWORD = process.env.SYNCTV_ADMIN_PASSWORD;

// synctv token 缓存
let cachedSynctvToken = null;
let synctvTokenExpiry = 0;

function shouldInitSQLite() {
  const isCloudflare = process.env.CF_PAGES === '1' || process.env.BUILD_TARGET === 'cloudflare';
  return process.env.NEXT_PUBLIC_STORAGE_TYPE === 'd1' && !isCloudflare && process.env.MOONTV_LITE !== 'true';
}

function isTVModeEnabled() {
  return process.env.ENABLE_TV_MODE !== 'false';
}

function ensureSQLiteReady() {
  if (!shouldInitSQLite()) {
    return;
  }

  try {
    const { initSQLiteDatabase } = require('./scripts/init-sqlite.js');
    initSQLiteDatabase();
  } catch (error) {
    console.error('❌ Error initializing SQLite database:', error);
    throw error;
  }
}

ensureSQLiteReady();

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// ==================== synctv 集成辅助函数 ====================

// 获取 synctv token（自动登录）
async function getSynctvToken() {
  // 如果没有配置 synctv，返回 null
  if (!SYNCTV_URL || !SYNCTV_ADMIN_USER || !SYNCTV_ADMIN_PASSWORD) {
    return null;
  }

  // 如果 token 还没过期（提前5分钟刷新）
  if (cachedSynctvToken && Date.now() < synctvTokenExpiry - 5 * 60 * 1000) {
    return cachedSynctvToken;
  }

  try {
    console.log('[synctv] Logging in to get token...');
    const response = await fetch(`${SYNCTV_URL}/api/user/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: SYNCTV_ADMIN_USER,
        password: SYNCTV_ADMIN_PASSWORD
      })
    });

    if (!response.ok) {
      throw new Error(`Login failed: ${response.status}`);
    }

    const data = await response.json();

    // synctv 登录响应可能是：
    // {data: {token: "..."}, time: ...} 或 {code: 200, data: {token: "..."}}
    const token = data.data?.token;
    if (!token) {
      throw new Error('Invalid login response: no token found');
    }

    cachedSynctvToken = token;

    // JWT token 通常有效期为 24 小时，设置过期时间
    synctvTokenExpiry = Date.now() + 24 * 60 * 60 * 1000;

    console.log('[synctv] Successfully logged in to synctv');
    return cachedSynctvToken;
  } catch (error) {
    console.error('[synctv] Failed to login to synctv:', error.message);
    return null;
  }
}

// 为 MoonTVPlus 用户创建临时 synctv 账号
async function createSynctvUser(username, password) {
  const token = await getSynctvToken();
  if (!token) {
    throw new Error('Failed to get synctv token');
  }

  try {
    console.log('[synctv] Creating user:', username);
    const response = await fetch(`${SYNCTV_URL}/api/admin/user/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        username: username,
        password: password,
        role: 3 // RoleUser = 3（普通用户角色）
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      // 如果用户已存在，忽略错误（可能是之前创建的）
      if (response.status === 400 && errorText.includes('already exists')) {
        console.log('[synctv] User already exists:', username);
      } else {
        throw new Error(`Failed to create user: ${response.status} ${errorText}`);
      }
    } else {
      console.log('[synctv] User created:', username);
    }

    // 登录该用户获取 token
    const loginResponse = await fetch(`${SYNCTV_URL}/api/user/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!loginResponse.ok) {
      throw new Error('Failed to login new user');
    }

    const data = await loginResponse.json();
    return data.data.token;
  } catch (error) {
    console.error('[synctv] Error creating user:', error.message);
    throw error;
  }
}

// 创建 synctv 房间
async function createSynctvRoom(roomData) {
  const token = await getSynctvToken();
  if (!token) {
    throw new Error('Failed to get synctv token');
  }

  try {
    console.log('[synctv] Creating room with data:', JSON.stringify({
      roomName: roomData.roomName || roomData.name,
      password: roomData.password ? '(set)' : '(empty)',
      settings: roomData.settings
    }));
    console.log('[synctv] API URL:', `${SYNCTV_URL}/api/room/create`);

    const response = await fetch(`${SYNCTV_URL}/api/room/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        roomName: roomData.roomName || roomData.name, // 使用 roomName，兼容 name
        password: roomData.password || '',
        settings: {
          hidden: roomData.settings?.hidden || false
        }
      })
    });

    console.log('[synctv] Response status:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[synctv] API error response:', errorText);
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    console.log('[synctv] API response:', JSON.stringify(data));

    // synctv 返回 HTTP 201，但 JSON 中可能没有 code 字段
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(data.message || `Unexpected HTTP status: ${response.status}`);
    }

    const roomId = data.data?.roomId || data.data?.id;
    if (!roomId) {
      throw new Error('No roomId in response: ' + JSON.stringify(data));
    }

    console.log(`[synctv] Room created: ${roomId}`);
    return { id: roomId };
  } catch (error) {
    console.error('[synctv] Failed to create room:', error.message);
    console.error('[synctv] Error stack:', error.stack);
    throw error;
  }
}

// 删除 synctv 房间
async function deleteSynctvRoom(roomId) {
  const token = await getSynctvToken();
  if (!token) {
    console.error('[synctv] Cannot delete room: no token');
    return false;
  }

  try {
    console.log('[synctv] Deleting room:', roomId);
    const response = await fetch(`${SYNCTV_URL}/api/admin/room/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ id: roomId })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[synctv] Failed to delete room:', response.status, errorText);
      return false;
    }

    console.log('[synctv] Room deleted successfully:', roomId);
    return true;
  } catch (error) {
    console.error('[synctv] Error deleting room:', error.message);
    return false;
  }
}

// ==================== 结束 synctv 集成辅助函数 ====================

// 读取观影室配置的辅助函数
async function getWatchRoomConfig() {
  // 观影室配置现在统一从环境变量读取
  const config = {
    enabled: process.env.WATCH_ROOM_ENABLED === 'true',
    serverType: (process.env.WATCH_ROOM_SERVER_TYPE || 'internal'),
    externalServerUrl: process.env.WATCH_ROOM_EXTERNAL_SERVER_URL,
    externalServerAuth: process.env.WATCH_ROOM_EXTERNAL_SERVER_AUTH,
  };

  console.log(`[WatchRoom] Watch room ${config.enabled ? 'enabled' : 'disabled'} via environment variable.`);
  return config;
}

// 观影室服务器类
class WatchRoomServer {
  constructor(io, config = {}) {
    this.io = io;
    this.config = config; // 保存配置
    this.rooms = new Map();
    this.members = new Map();
    this.socketToRoom = new Map();
    this.screenHelpers = new Map();
    this.helperToRoom = new Map();
    this.roomDeletionTimers = new Map(); // 房间延迟删除定时器
    this.cleanupInterval = null;
    this.setupEventHandlers();
    this.startCleanupTimer();
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`[WatchRoom] Client connected: ${socket.id}`);

      // 创建房间
      socket.on('room:create', async (data, callback) => {
        try {
          const roomId = this.generateRoomId();
          const userId = socket.id;
          const ownerToken = this.generateRoomId(); // 生成房主令牌

          const room = {
            id: roomId,
            name: data.name,
            description: data.description,
            password: data.password,
            isPublic: data.isPublic,
            roomType: data.roomType || 'sync',
            ownerId: userId,
            ownerName: data.userName,
            ownerToken: ownerToken, // 保存房主令牌
            memberCount: 1,
            currentState: null,
            createdAt: Date.now(),
            lastOwnerHeartbeat: Date.now(),
          };

          // 如果配置为 synctv 模式，创建 synctv 房间
          console.log('[WatchRoom] Checking serverType:', this.config.serverType);
          if (this.config.serverType === 'synctv') {
            console.log('[WatchRoom] Creating synctv room...');
            try {
              const synctvRoom = await createSynctvRoom({
                roomName: data.name,
                password: data.password,
                settings: { hidden: false }
              });
              room.synctvRoomId = synctvRoom.id;
              console.log(`[synctv] Room created in synctv: ${synctvRoom.id}`);
            } catch (error) {
              console.error('[synctv] Failed to create room in synctv:', error);
              // synctv 创建失败不影响 MoonTVPlus 房间创建
            }
          }

          const member = {
            id: userId,
            name: data.userName,
            isOwner: true,
            lastHeartbeat: Date.now(),
          };

          this.rooms.set(roomId, room);
          this.members.set(roomId, new Map([[userId, member]]));
          this.socketToRoom.set(socket.id, {
            roomId,
            userId,
            userName: data.userName,
            isOwner: true,
          });

          socket.join(roomId);

          console.log(`[WatchRoom] Room created: ${roomId} by ${data.userName}`);
          callback({ success: true, room });
        } catch (error) {
          console.error('[WatchRoom] Error creating room:', error);
          callback({ success: false, error: '创建房间失败' });
        }
      });

      // 加入房间
      socket.on('room:join', (data, callback) => {
        try {
          const room = this.rooms.get(data.roomId);
          if (!room) {
            return callback({ success: false, error: '房间不存在' });
          }

          if (room.password && room.password !== data.password) {
            return callback({ success: false, error: '密码错误' });
          }

          const userId = socket.id;
          let isOwner = false;

          // 检查是否是房主重连（通过 ownerToken 验证）
          if (data.ownerToken && data.ownerToken === room.ownerToken) {
            isOwner = true;
            // 更新房主的 socket.id
            room.ownerId = userId;
            room.lastOwnerHeartbeat = Date.now();
            this.rooms.set(data.roomId, room);
            console.log(`[WatchRoom] Owner ${data.userName} reconnected to room ${data.roomId}`);
          }

          // 取消房间的删除定时器（如果有人重连）
          if (this.roomDeletionTimers.has(data.roomId)) {
            console.log(`[WatchRoom] Cancelling deletion timer for room ${data.roomId}`);
            clearTimeout(this.roomDeletionTimers.get(data.roomId));
            this.roomDeletionTimers.delete(data.roomId);
          }

          const member = {
            id: userId,
            name: data.userName,
            isOwner: isOwner,
            lastHeartbeat: Date.now(),
          };

          const roomMembers = this.members.get(data.roomId);
          if (roomMembers) {
            if (isOwner) {
              Array.from(roomMembers.entries()).forEach(([memberId, existingMember]) => {
                if (existingMember.isOwner && memberId !== userId) {
                  roomMembers.delete(memberId);
                }
              });
            }

            roomMembers.set(userId, member);
            room.memberCount = roomMembers.size;
            this.rooms.set(data.roomId, room);
          }

          this.socketToRoom.set(socket.id, {
            roomId: data.roomId,
            userId,
            userName: data.userName,
            isOwner: isOwner,
          });

          socket.join(data.roomId);
          socket.to(data.roomId).emit('room:member-joined', member);

          console.log(`[WatchRoom] User ${data.userName} joined room ${data.roomId}${isOwner ? ' (as owner)' : ''}`);

          const members = Array.from(roomMembers?.values() || []);
          callback({ success: true, room, members });
        } catch (error) {
          console.error('[WatchRoom] Error joining room:', error);
          callback({ success: false, error: '加入房间失败' });
        }
      });

      // 离开房间
      socket.on('room:leave', () => {
        this.handleLeaveRoom(socket);
      });

      // 获取房间列表
      socket.on('room:list', (callback) => {
        const publicRooms = Array.from(this.rooms.values()).filter((room) => room.isPublic);
        callback(publicRooms);
      });

      // 播放状态更新（任何成员都可以触发同步）
      socket.on('play:update', (state) => {
        console.log(`[WatchRoom] Received play:update from ${socket.id}:`, state);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          console.log('[WatchRoom] No room info for socket, ignoring play:update');
          return;
        }

        const room = this.rooms.get(roomInfo.roomId);
        if (room) {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          console.log(`[WatchRoom] Broadcasting play:update to room ${roomInfo.roomId} from ${roomInfo.userName}`);
          socket.to(roomInfo.roomId).emit('play:update', state);
        } else {
          console.log('[WatchRoom] Room not found for play:update');
        }
      });

      // 播放进度跳转
      socket.on('play:seek', (currentTime) => {
        console.log(`[WatchRoom] Received play:seek from ${socket.id}:`, currentTime);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          console.log('[WatchRoom] No room info for socket, ignoring play:seek');
          return;
        }
        console.log(`[WatchRoom] Broadcasting play:seek to room ${roomInfo.roomId}`);
        socket.to(roomInfo.roomId).emit('play:seek', currentTime);
      });

      // 播放
      socket.on('play:play', () => {
        console.log(`[WatchRoom] Received play:play from ${socket.id}`);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          console.log('[WatchRoom] No room info for socket, ignoring play:play');
          return;
        }
        console.log(`[WatchRoom] Broadcasting play:play to room ${roomInfo.roomId}`);
        socket.to(roomInfo.roomId).emit('play:play');
      });

      // 暂停
      socket.on('play:pause', () => {
        console.log(`[WatchRoom] Received play:pause from ${socket.id}`);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          console.log('[WatchRoom] No room info for socket, ignoring play:pause');
          return;
        }
        console.log(`[WatchRoom] Broadcasting play:pause to room ${roomInfo.roomId}`);
        socket.to(roomInfo.roomId).emit('play:pause');
      });

      // 切换视频/集数
      socket.on('play:change', (state) => {
        console.log(`[WatchRoom] Received play:change from ${socket.id}:`, state);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) {
          console.log('[WatchRoom] No room info for socket, ignoring play:change');
          return;
        }
        if (!roomInfo.isOwner) {
          console.log('[WatchRoom] User is not owner, ignoring play:change');
          return;
        }

        const room = this.rooms.get(roomInfo.roomId);
        if (room) {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          console.log(`[WatchRoom] Broadcasting play:change to room ${roomInfo.roomId}`);
          socket.to(roomInfo.roomId).emit('play:change', state);
        } else {
          console.log('[WatchRoom] Room not found for play:change');
        }
      });

      // 切换直播频道
      socket.on('live:change', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room) {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('live:change', state);
        }
      });

      socket.on('music:change', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:change', state);
        }
      });

      socket.on('music:update', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:update', state);
        }
      });

      socket.on('music:queue', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:queue', state);
        }
      });

      socket.on('music:play', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = { ...state, isPlaying: true };
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:play', state);
        }
      });

      socket.on('music:pause', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = { ...state, isPlaying: false };
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:pause', state);
        }
      });

      socket.on('music:seek', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = { ...state };
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:seek', state);
        }
      });

      socket.on('screen:helper-register', (data, callback) => {
        try {
          const room = this.rooms.get(data.roomId);
          if (!room) {
            callback({ success: false, error: '房间不存在' });
            return;
          }

          if (room.ownerToken !== data.ownerToken) {
            callback({ success: false, error: '房主身份验证失败' });
            return;
          }

          const oldHelperSocketId = this.screenHelpers.get(data.roomId);
          if (oldHelperSocketId && oldHelperSocketId !== socket.id) {
            this.helperToRoom.delete(oldHelperSocketId);
          }

          this.screenHelpers.set(data.roomId, socket.id);
          this.helperToRoom.set(socket.id, data.roomId);
          callback({ success: true });
        } catch (error) {
          console.error('[WatchRoom] Error registering screen helper:', error);
          callback({ success: false, error: '注册共享控制窗口失败' });
        }
      });

      // 开始屏幕共享
      socket.on('screen:start', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        const roomId = roomInfo?.roomId || helperRoomId;
        if (!roomId) return;
        if (helperRoomId && this.screenHelpers.get(helperRoomId) !== socket.id) return;
        if (roomInfo && !roomInfo.isOwner) return;

        const room = this.rooms.get(roomId);
        if (room) {
          room.currentState = state;
          this.rooms.set(roomId, room);
          this.io.to(roomId).emit('screen:start', state);
        }
      });

      // 停止屏幕共享
      socket.on('screen:stop', () => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        const roomId = roomInfo?.roomId || helperRoomId;
        if (!roomId) return;
        if (helperRoomId && this.screenHelpers.get(helperRoomId) !== socket.id) return;
        if (roomInfo && !roomInfo.isOwner) return;

        const room = this.rooms.get(roomId);
        if (room) {
          room.currentState = null;
          this.rooms.set(roomId, room);
          this.io.to(roomId).emit('screen:stop');
        }
      });

      socket.on('screen:viewer-ready', () => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (!room || roomInfo.isOwner || room.currentState?.type !== 'screen') return;

        const targetSocketId = this.screenHelpers.get(roomInfo.roomId) || room.ownerId;
        this.io.to(targetSocketId).emit('screen:viewer-ready', {
          userId: socket.id,
        });
      });

      // 屏幕共享 WebRTC 信令
      socket.on('screen:offer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (!roomInfo && !helperRoomId) return;

        this.io.to(data.targetUserId).emit('screen:offer', {
          userId: socket.id,
          offer: data.offer,
        });
      });

      socket.on('screen:answer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (!roomInfo && !helperRoomId) return;

        this.io.to(data.targetUserId).emit('screen:answer', {
          userId: socket.id,
          answer: data.answer,
        });
      });

      socket.on('screen:ice', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (!roomInfo && !helperRoomId) return;

        this.io.to(data.targetUserId).emit('screen:ice', {
          userId: socket.id,
          candidate: data.candidate,
        });
      });

      // 聊天消息
      socket.on('chat:message', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;

        const message = {
          id: this.generateMessageId(),
          userId: roomInfo.userId,
          userName: roomInfo.userName,
          content: data.content,
          type: data.type,
          timestamp: Date.now(),
        };

        this.io.to(roomInfo.roomId).emit('chat:message', message);
      });

      // WebRTC 信令
      socket.on('voice:offer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;
        this.io.to(data.targetUserId).emit('voice:offer', {
          userId: socket.id,
          offer: data.offer,
        });
      });

      socket.on('voice:answer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;
        this.io.to(data.targetUserId).emit('voice:answer', {
          userId: socket.id,
          answer: data.answer,
        });
      });

      socket.on('voice:ice', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;
        this.io.to(data.targetUserId).emit('voice:ice', {
          userId: socket.id,
          candidate: data.candidate,
        });
      });

      // 语音聊天 - 服务器中转音频数据
      socket.on('voice:audio-chunk', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;

        // 将音频数据转发给房间内的其他成员
        socket.to(roomInfo.roomId).emit('voice:audio-chunk', {
          userId: socket.id,
          audioData: data.audioData,
          sampleRate: data.sampleRate || 16000,
        });
      });

      // 心跳
      socket.on('heartbeat', () => {
        const roomInfo = this.socketToRoom.get(socket.id);

        // 如果用户在房间中，更新心跳时间
        if (roomInfo) {
          const roomMembers = this.members.get(roomInfo.roomId);
          const member = roomMembers?.get(roomInfo.userId);
          if (member) {
            member.lastHeartbeat = Date.now();
            roomMembers?.set(roomInfo.userId, member);
          }

          if (roomInfo.isOwner) {
            const room = this.rooms.get(roomInfo.roomId);
            if (room) {
              room.lastOwnerHeartbeat = Date.now();
              this.rooms.set(roomInfo.roomId, room);
            }
          }
        }

        // 无论是否在房间中，都响应心跳包（pong）
        socket.emit('heartbeat:pong', { timestamp: Date.now() });
      });

      // 断开连接
      socket.on('disconnect', () => {
        console.log(`[WatchRoom] Client disconnected: ${socket.id}`);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (helperRoomId) {
          this.helperToRoom.delete(socket.id);
          if (this.screenHelpers.get(helperRoomId) === socket.id) {
            this.screenHelpers.delete(helperRoomId);
            const room = this.rooms.get(helperRoomId);
            if (room && room.currentState?.type === 'screen') {
              room.currentState = null;
              this.rooms.set(helperRoomId, room);
              this.io.to(helperRoomId).emit('screen:stop');
            }
          }
        }
        this.handleLeaveRoom(socket);
      });
    });
  }

  async handleLeaveRoom(socket) {
    const roomInfo = this.socketToRoom.get(socket.id);
    if (!roomInfo) return;

    const { roomId, userId, isOwner } = roomInfo;
    const room = this.rooms.get(roomId);
    const roomMembers = this.members.get(roomId);

    if (roomMembers) {
      roomMembers.delete(userId);

      if (room) {
        room.memberCount = roomMembers.size;
        this.rooms.set(roomId, room);
      }

      socket.to(roomId).emit('room:member-left', userId);

      // 如果是房主主动离开，解散房间并踢出所有成员
      if (isOwner) {
        console.log(`[WatchRoom] Owner actively left room ${roomId}, disbanding room`);

        // 通知所有成员房间被解散
        socket.to(roomId).emit('room:deleted', { reason: 'owner_left' });

        // 强制所有成员离开房间
        const members = Array.from(roomMembers.keys());
        members.forEach(memberId => {
          this.socketToRoom.delete(memberId);
        });

        // 立即删除房间（跳过通知，因为上面已经发送了）
        await this.deleteRoom(roomId, true);

        // 清除可能存在的删除定时器
        if (this.roomDeletionTimers.has(roomId)) {
          clearTimeout(this.roomDeletionTimers.get(roomId));
          this.roomDeletionTimers.delete(roomId);
        }
      } else {
        // 普通成员离开，房间为空时延迟删除
        if (roomMembers.size === 0) {
          console.log(`[WatchRoom] Room ${roomId} is now empty, will delete in 30 seconds if no one rejoins`);

          const deletionTimer = setTimeout(async () => {
            // 再次检查房间是否仍然为空
            const currentRoomMembers = this.members.get(roomId);
            if (currentRoomMembers && currentRoomMembers.size === 0) {
              console.log(`[WatchRoom] Room ${roomId} deletion timer expired, deleting room`);
              await this.deleteRoom(roomId);
              this.roomDeletionTimers.delete(roomId);
            }
          }, 30000); // 30秒后删除

          this.roomDeletionTimers.set(roomId, deletionTimer);
        }
      }
    }

    socket.leave(roomId);
    this.socketToRoom.delete(socket.id);
  }

  async deleteRoom(roomId, skipNotify = false) {
    console.log(`[WatchRoom] Deleting room ${roomId}`);

    const room = this.rooms.get(roomId);

    // 如果有 synctv 房间，同步删除
    if (room && room.synctvRoomId) {
      console.log(`[WatchRoom] Deleting synctv room: ${room.synctvRoomId}`);
      await deleteSynctvRoom(room.synctvRoomId);
    }

    // 如果不跳过通知，则发送 room:deleted 事件
    if (!skipNotify) {
      this.io.to(roomId).emit('room:deleted');
    }

    this.rooms.delete(roomId);
    this.members.delete(roomId);
    const helperSocketId = this.screenHelpers.get(roomId);
    if (helperSocketId) {
      this.helperToRoom.delete(helperSocketId);
      this.screenHelpers.delete(roomId);
    }
  }

  startCleanupTimer() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const deleteTimeout = 5 * 60 * 1000; // 5分钟 - 删除房间
      const clearStateTimeout = 30 * 1000; // 30秒 - 清除播放状态

      for (const [roomId, room] of this.rooms.entries()) {
        const timeSinceHeartbeat = now - room.lastOwnerHeartbeat;

        // 如果房主心跳超过30秒，清除播放状态
        if (timeSinceHeartbeat > clearStateTimeout && room.currentState !== null) {
          console.log(`[WatchRoom] Room ${roomId} owner inactive for 30s, clearing play state`);
          room.currentState = null;
          this.rooms.set(roomId, room);
          // 通知房间内所有成员状态已清除
          this.io.to(roomId).emit('state:cleared');
        }

        // 检查房主是否超时5分钟 - 删除房间
        if (timeSinceHeartbeat > deleteTimeout) {
          console.log(`[WatchRoom] Room ${roomId} owner timeout, deleting...`);
          this.deleteRoom(roomId);
        }
      }
    }, 10000); // 每10秒检查一次，确保更及时的清理
  }

  generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  generateMessageId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // 清理所有房间删除定时器
    for (const timer of this.roomDeletionTimers.values()) {
      clearTimeout(timer);
    }
    this.roomDeletionTimers.clear();
  }
}

function parseCookieHeader(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index <= 0) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) acc[key] = value;
    return acc;
  }, {});
}

function parseSocketAuth(socket) {
  const cookies = parseCookieHeader(socket.handshake.headers.cookie || '');
  const raw = cookies.auth || socket.handshake.auth?.token || '';
  if (!raw) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}

  if (decoded.includes('%')) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {}
  }

  try {
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

class TVRemoteServer {
  constructor(io) {
    this.io = io;
    this.cleanupInterval = null;
    attachTVRemoteIO(io);
    this.setupEventHandlers();
    this.startCleanupTimer();
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      socket.on('tv-remote:register-tv', (data, callback) => {
        const auth = parseSocketAuth(socket);
        if (!auth?.username) {
          callback?.({ success: false, error: '未登录' });
          return;
        }

        const deviceId = String(data?.deviceId || '').slice(0, 128);
        if (!deviceId) {
          callback?.({ success: false, error: '缺少设备 ID' });
          return;
        }

        callback?.(registerTVRemoteDevice(socket.id, auth.username, data));
      });

      socket.on('tv-remote:tv-state', (data) => {
        const auth = parseSocketAuth(socket);
        if (!auth?.username) return;
        updateTVRemoteDevice(socket.id, auth.username, data);
      });

      socket.on('disconnect', () => {
        removeTVRemoteSocket(socket.id);
      });
    });
  }

  startCleanupTimer() {
    this.cleanupInterval = setInterval(() => {
      cleanupTVRemoteDevices();
    }, 30_000);
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    clearTVRemoteHub();
  }
}

app.prepare().then(async () => {
  const httpServer = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);

      // ==================== synctv API 路由 ====================
      // 获取 synctv token（为用户创建临时账号）
      if (parsedUrl.pathname === '/api/synctv/token' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json');
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
          }
          const { username } = JSON.parse(body);

          console.log('[synctv] Token request for username:', username);

          if (!username) {
            res.statusCode = 400;
            res.end(JSON.stringify({ code: 400, error: 'Username is required' }));
            return;
          }

          // 为用户创建/获取 synctv 账号并返回 token
          // 用户名使用 moontv_ 前缀避免冲突
          const synctvUsername = `moontv_${username}`;
          const password = `moontv_${username}_${Date.now()}`; // 简单密码

          console.log('[synctv] Creating synctv user:', synctvUsername);
          const token = await createSynctvUser(synctvUsername, password);
          console.log('[synctv] Successfully got token for user:', synctvUsername);
          res.end(JSON.stringify({ code: 200, data: { token } }));
        } catch (error) {
          console.error('[synctv] Failed to create user token:', error.message);
          console.error('[synctv] Error stack:', error.stack);

          // 如果创建用户失败，尝试使用管理员 token
          try {
            console.log('[synctv] Fallback to admin token');
            const adminToken = await getSynctvToken();
            if (adminToken) {
              res.end(JSON.stringify({ code: 200, data: { token: adminToken } }));
              return;
            }
          } catch (fallbackError) {
            console.error('[synctv] Fallback also failed:', fallbackError.message);
          }

          res.statusCode = 500;
          res.end(JSON.stringify({ code: 500, error: error.message }));
        }
        return;
      }

      // 创建 synctv 房间
      if (parsedUrl.pathname === '/api/synctv/room/create' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json');
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
          }
          const roomData = JSON.parse(body);
          const room = await createSynctvRoom(roomData);
          res.end(JSON.stringify({ code: 200, data: room }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 500, error: error.message }));
        }
        return;
      }

      // 获取 synctv 配置信息
      if (parsedUrl.pathname === '/api/synctv/config' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          code: 200,
          data: {
            enabled: !!(SYNCTV_URL && SYNCTV_ADMIN_USER && SYNCTV_ADMIN_PASSWORD),
            url: SYNCTV_URL
          }
        }));
        return;
      }
      // ==================== 结束 synctv API 路由 ====================

      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  // 读取观影室配置
  const watchRoomConfig = await getWatchRoomConfig();
  console.log('[WatchRoom] Config:', watchRoomConfig);

  let watchRoomServer = null;
  let tvRemoteServer = null;
  let io = null;

  const tvModeEnabled = isTVModeEnabled();
  // 当配置为 synctv 时，仍然启动内置服务器来处理播放同步、聊天等功能
  // 只是语音聊天通过 synctv 进行
  const shouldStartInternalWatchRoom =
    watchRoomConfig.enabled && watchRoomConfig.serverType !== 'external';

  if (tvModeEnabled || shouldStartInternalWatchRoom) {
    io = new Server(httpServer, {
      path: '/socket.io',
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });
  }

  if (tvModeEnabled && io) {
    tvRemoteServer = new TVRemoteServer(io);
    console.log('[TVRemote] Socket.IO remote server initialized');
  } else {
    console.log('[TVRemote] TV mode disabled, remote server not initialized');
  }

  if (shouldStartInternalWatchRoom && io) {
    // 初始化观影室服务器
    watchRoomServer = new WatchRoomServer(io, watchRoomConfig);
    console.log('[WatchRoom] Socket.IO server initialized');

    if (watchRoomConfig.serverType === 'synctv') {
      console.log('[WatchRoom] Voice chat will use synctv server for better stability');
    }
  } else {
    if (!watchRoomConfig.enabled) {
      console.log('[WatchRoom] Watch room is disabled');
    } else if (watchRoomConfig.serverType === 'external') {
      console.log('[WatchRoom] Using external watch room server');
    }
  }

  httpServer
    .once('error', (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(`> Ready on http://${hostname}:${port}`);
      if (io) {
        console.log(`> Socket.IO ready on ws://${hostname}:${port}`);
      } else {
        console.log('> Socket.IO disabled');
      }
    });

  const forceExit = (signal) => {
    console.log(`\n[Server] Received ${signal}, force exiting...`);
    process.exit(0);
  };

  process.on('SIGINT', () => forceExit('SIGINT'));
  process.on('SIGTERM', () => forceExit('SIGTERM'));
});
