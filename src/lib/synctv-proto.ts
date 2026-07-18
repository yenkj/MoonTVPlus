/**
 * synctv protobuf 消息编解码
 * 用于与 synctv WebSocket 通信
 */

// 消息类型枚举（与 synctv proto 定义一致）
export enum MessageType {
  UNKNOWN = 0,
  ERROR = 1,
  CHAT = 2,
  STATUS = 3,
  CHECK_STATUS = 4,
  EXPIRED = 5,
  CURRENT = 6,
  MOVIES = 7,
  VIEWER_COUNT = 8,
  SYNC = 9,
  MY_STATUS = 10,
  WEBRTC_OFFER = 11,
  WEBRTC_ANSWER = 12,
  WEBRTC_ICE_CANDIDATE = 13,
  WEBRTC_JOIN = 14,
  WEBRTC_LEAVE = 15,
}

export interface Sender {
  userId: string;
  username: string;
}

export interface WebRTCData {
  data: string;
  to: string;
  from: string;
}

export interface Status {
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
}

export interface Message {
  type: MessageType;
  timestamp: number;
  sender?: Sender;
  errorMessage?: string;
  chatContent?: string;
  playbackStatus?: Status;
  expirationId?: number;
  viewerCount?: number;
  webrtcData?: WebRTCData;
}

// 简化的 protobuf 编解码器
// 变长整数编码
function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return new Uint8Array(bytes);
}

function decodeVarint(reader: { pos: number; data: Uint8Array }): number {
  let result = 0;
  let shift = 0;
  while (true) {
    const byte = reader.data[reader.pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  return result;
}

// 字符串编码
function encodeString(value: string): Uint8Array {
  const strBytes = new TextEncoder().encode(value);
  const lenBytes = encodeVarint(strBytes.length);
  const result = new Uint8Array(lenBytes.length + strBytes.length);
  result.set(lenBytes, 0);
  result.set(strBytes, lenBytes.length);
  return result;
}

function decodeString(reader: { pos: number; data: Uint8Array }): string {
  const len = decodeVarint(reader);
  const bytes = reader.data.slice(reader.pos, reader.pos + len);
  reader.pos += len;
  return new TextDecoder().decode(bytes);
}

// 布尔值编码
function encodeBool(value: boolean): number {
  return value ? 1 : 0;
}

function decodeBool(reader: { pos: number; data: Uint8Array }): boolean {
  return reader.data[reader.pos++] !== 0;
}

// 双精度浮点数编码
function encodeDouble(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, true);
  return new Uint8Array(buffer);
}

function decodeDouble(reader: { pos: number; data: Uint8Array }): number {
  const bytes = reader.data.slice(reader.pos, reader.pos + 8);
  reader.pos += 8;
  return new DataView(bytes.buffer, bytes.byteOffset).getFloat64(0, true);
}

// sfixed64 编码 (用于 timestamp)
function encodeSFixed64(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  // 使用 BigInt 来处理 64 位整数
  view.setBigInt64(0, BigInt(Math.floor(value)), true);
  return new Uint8Array(buffer);
}

function decodeSFixed64(reader: { pos: number; data: Uint8Array }): number {
  const bytes = reader.data.slice(reader.pos, reader.pos + 8);
  reader.pos += 8;
  return Number(new DataView(bytes.buffer, bytes.byteOffset).getBigInt64(0, true));
}

// fixed64 编码
function encodeFixed64(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt(Math.floor(value)), true);
  return new Uint8Array(buffer);
}

function decodeFixed64(reader: { pos: number; data: Uint8Array }): number {
  const bytes = reader.data.slice(reader.pos, reader.pos + 8);
  reader.pos += 8;
  return Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, true));
}

// 编码消息
export function encodeMessage(msg: Message): Uint8Array {
  const chunks: Uint8Array[] = [];

  // type (field 1, wire type 0)
  if (msg.type !== 0) {
    const tag = (1 << 3) | 0; // field 1, wire type 0 (varint)
    chunks.push(encodeVarint(tag));
    chunks.push(encodeVarint(msg.type));
  }

  // timestamp (field 2, wire type 5 - sfixed64)
  if (msg.timestamp !== 0) {
    const tag = (2 << 3) | 5;
    chunks.push(encodeVarint(tag));
    chunks.push(encodeSFixed64(msg.timestamp));
  }

  // sender (field 3, wire type 2 - length delimited)
  if (msg.sender) {
    const tag = (3 << 3) | 2;
    chunks.push(encodeVarint(tag));
    const senderData = encodeSender(msg.sender);
    chunks.push(encodeVarint(senderData.length));
    chunks.push(senderData);
  }

  // error_message (field 4, wire type 2)
  if (msg.errorMessage !== undefined) {
    const tag = (4 << 3) | 2;
    chunks.push(encodeVarint(tag));
    chunks.push(encodeString(msg.errorMessage));
  }

  // chat_content (field 5, wire type 2)
  if (msg.chatContent !== undefined) {
    const tag = (5 << 3) | 2;
    chunks.push(encodeVarint(tag));
    chunks.push(encodeString(msg.chatContent));
  }

  // playback_status (field 6, wire type 2)
  if (msg.playbackStatus) {
    const tag = (6 << 3) | 2;
    chunks.push(encodeVarint(tag));
    const statusData = encodeStatus(msg.playbackStatus);
    chunks.push(encodeVarint(statusData.length));
    chunks.push(statusData);
  }

  // expiration_id (field 7, wire type 1 - fixed64)
  if (msg.expirationId !== undefined) {
    const tag = (7 << 3) | 1;
    chunks.push(encodeVarint(tag));
    chunks.push(encodeFixed64(msg.expirationId));
  }

  // viewer_count (field 8, wire type 0)
  if (msg.viewerCount !== undefined) {
    const tag = (8 << 3) | 0;
    chunks.push(encodeVarint(tag));
    chunks.push(encodeVarint(msg.viewerCount));
  }

  // webrtc_data (field 9, wire type 2)
  if (msg.webrtcData) {
    const tag = (9 << 3) | 2;
    chunks.push(encodeVarint(tag));
    const webrtcData = encodeWebRTCData(msg.webrtcData);
    chunks.push(encodeVarint(webrtcData.length));
    chunks.push(webrtcData);
  }

  // 合并所有块
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function encodeSender(sender: Sender): Uint8Array {
  const chunks: Uint8Array[] = [];
  
  // user_id (field 1, wire type 2)
  if (sender.userId) {
    const tag = (1 << 3) | 2;
    chunks.push(encodeVarint(tag));
    chunks.push(encodeString(sender.userId));
  }
  
  // username (field 2, wire type 2)
  if (sender.username) {
    const tag = (2 << 3) | 2;
    chunks.push(encodeVarint(tag));
    chunks.push(encodeString(sender.username));
  }
  
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function encodeStatus(status: Status): Uint8Array {
  const chunks: Uint8Array[] = [];
  
  // is_playing (field 1, wire type 0)
  const tag1 = (1 << 3) | 0;
  chunks.push(encodeVarint(tag1));
  chunks.push(new Uint8Array([encodeBool(status.isPlaying)]));
  
  // current_time (field 2, wire type 1 - double)
  const tag2 = (2 << 3) | 1;
  chunks.push(encodeVarint(tag2));
  chunks.push(encodeDouble(status.currentTime));
  
  // playback_rate (field 3, wire type 1 - double)
  const tag3 = (3 << 3) | 1;
  chunks.push(encodeVarint(tag3));
  chunks.push(encodeDouble(status.playbackRate));
  
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function encodeWebRTCData(data: WebRTCData): Uint8Array {
  const chunks: Uint8Array[] = [];
  
  // data (field 1, wire type 2)
  if (data.data) {
    const tag = (1 << 3) | 2;
    chunks.push(encodeVarint(tag));
    chunks.push(encodeString(data.data));
  }
  
  // to (field 2, wire type 2)
  if (data.to) {
    const tag = (2 << 3) | 2;
    chunks.push(encodeVarint(tag));
    chunks.push(encodeString(data.to));
  }
  
  // from (field 3, wire type 2)
  if (data.from) {
    const tag = (3 << 3) | 2;
    chunks.push(encodeVarint(tag));
    chunks.push(encodeString(data.from));
  }
  
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// 解码消息
export function decodeMessage(data: Uint8Array): Message {
  const reader = { pos: 0, data };
  const msg: Message = {
    type: MessageType.UNKNOWN,
    timestamp: 0,
  };
  
  while (reader.pos < data.length) {
    const tag = decodeVarint(reader);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    
    switch (fieldNum) {
      case 1: // type
        msg.type = decodeVarint(reader);
        break;
      case 2: // timestamp
        msg.timestamp = decodeSFixed64(reader);
        break;
      case 3: // sender
        const senderLen = decodeVarint(reader);
        const senderData = data.slice(reader.pos, reader.pos + senderLen);
        msg.sender = decodeSender(senderData);
        reader.pos += senderLen;
        break;
      case 4: // error_message
        msg.errorMessage = decodeString(reader);
        break;
      case 5: // chat_content
        msg.chatContent = decodeString(reader);
        break;
      case 6: // playback_status
        const statusLen = decodeVarint(reader);
        const statusData = data.slice(reader.pos, reader.pos + statusLen);
        msg.playbackStatus = decodeStatus(statusData);
        reader.pos += statusLen;
        break;
      case 7: // expiration_id
        msg.expirationId = decodeFixed64(reader);
        break;
      case 8: // viewer_count
        msg.viewerCount = decodeVarint(reader);
        break;
      case 9: // webrtc_data
        const webrtcLen = decodeVarint(reader);
        const webrtcData = data.slice(reader.pos, reader.pos + webrtcLen);
        msg.webrtcData = decodeWebRTCData(webrtcData);
        reader.pos += webrtcLen;
        break;
      default:
        // 跳过未知字段
        if (wireType === 0) {
          decodeVarint(reader);
        } else if (wireType === 1) {
          reader.pos += 8;
        } else if (wireType === 2) {
          const len = decodeVarint(reader);
          reader.pos += len;
        } else if (wireType === 5) {
          reader.pos += 4;
        }
        break;
    }
  }
  
  return msg;
}

function decodeSender(data: Uint8Array): Sender {
  const reader = { pos: 0, data };
  const sender: Sender = { userId: '', username: '' };
  
  while (reader.pos < data.length) {
    const tag = decodeVarint(reader);
    const fieldNum = tag >>> 3;
    
    switch (fieldNum) {
      case 1:
        sender.userId = decodeString(reader);
        break;
      case 2:
        sender.username = decodeString(reader);
        break;
      default:
        // 跳过未知字段
        const wireType = tag & 0x7;
        if (wireType === 2) {
          const len = decodeVarint(reader);
          reader.pos += len;
        }
        break;
    }
  }
  
  return sender;
}

function decodeStatus(data: Uint8Array): Status {
  const reader = { pos: 0, data };
  const status: Status = { isPlaying: false, currentTime: 0, playbackRate: 1 };
  
  while (reader.pos < data.length) {
    const tag = decodeVarint(reader);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    
    switch (fieldNum) {
      case 1:
        status.isPlaying = decodeBool(reader);
        break;
      case 2:
        status.currentTime = decodeDouble(reader);
        break;
      case 3:
        status.playbackRate = decodeDouble(reader);
        break;
      default:
        // 跳过未知字段
        if (wireType === 0) {
          decodeVarint(reader);
        } else if (wireType === 1) {
          reader.pos += 8;
        }
        break;
    }
  }
  
  return status;
}

function decodeWebRTCData(data: Uint8Array): WebRTCData {
  const reader = { pos: 0, data };
  const webrtc: WebRTCData = { data: '', to: '', from: '' };
  
  while (reader.pos < data.length) {
    const tag = decodeVarint(reader);
    const fieldNum = tag >>> 3;
    
    switch (fieldNum) {
      case 1:
        webrtc.data = decodeString(reader);
        break;
      case 2:
        webrtc.to = decodeString(reader);
        break;
      case 3:
        webrtc.from = decodeString(reader);
        break;
      default:
        // 跳过未知字段
        const wireType = tag & 0x7;
        if (wireType === 2) {
          const len = decodeVarint(reader);
          reader.pos += len;
        }
        break;
    }
  }
  
  return webrtc;
}
