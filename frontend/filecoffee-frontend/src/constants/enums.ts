import type { IceServer } from "@/lib/utils";

export const DATA_CHANNEL_LABEL = "fileTransfer";

// Must not exceed the backend's PASSWORD_MAX_LEN (default 256).
export const PASSWORD_MAX_LENGTH = 256;

// Error codes sent by the backend (backend/src/models/message.rs `error_codes`)
export const ErrorCode = {
  RoomNotFound: "ROOM_NOT_FOUND",
  InvalidPassword: "INVALID_PASSWORD",
  RoomFull: "ROOM_FULL",
  Rejected: "REJECTED",
  TooManyAttempts: "TOO_MANY_ATTEMPTS",
  PasswordTooLong: "PASSWORD_TOO_LONG",
  RateLimited: "RATE_LIMITED",
  ServerBusy: "SERVER_BUSY",
} as const;

export enum ViewType {
  UPLOAD,
  DOWNLOAD,
  PASSWORD,
  SHARE,
}

// Define types to match backend
export enum ClientMessageType {
  CreateRoom = "CreateRoom",
  JoinRoom = "JoinRoom",
  Signal = "Signal",
  RejectPeer = "RejectPeer",
}

export type ClientMessage =
  | { type: ClientMessageType.CreateRoom; password?: string }
  | { type: ClientMessageType.JoinRoom; room_id: string; password?: string }
  | { type: ClientMessageType.Signal; data: JSON }
  | { type: ClientMessageType.RejectPeer; peer_id: string };

export enum ServerMessageType {
  RoomCreated = "RoomCreated",
  RoomJoined = "RoomJoined",
  PeerJoined = "PeerJoined",
  PeerLeft = "PeerLeft",
  Signal = "Signal",
  Error = "Error",
  RoomExists = "RoomExists",
}

export type ServerMessage =
  | { type: ServerMessageType.RoomCreated; room_id: string }
  | { type: ServerMessageType.RoomJoined; ice_servers: IceServer[] }
  | {
    type: ServerMessageType.PeerJoined;
    peer_id: string;
    peer_count: number;
    ice_servers: IceServer[];
  }
  | { type: ServerMessageType.PeerLeft }
  | { type: ServerMessageType.Signal; data: JSON }
  | { type: ServerMessageType.Error; code: string; message: string }
  | {
    type: ServerMessageType.RoomExists;
    exists: boolean;
    has_password: boolean;
  };

export enum SignalLabelType {
  Offer = "offer",
  Answer = "answer",
  Candidate = "candidate",
  Progress = "progress",
  Cancel = "cancel",
}
