export const DATA_CHANNEL_LABEL = "fileTransfer";

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
}

export type ClientMessage =
  | { type: ClientMessageType.CreateRoom; password?: string }
  | { type: ClientMessageType.JoinRoom; room_id: string; password?: string }
  | { type: ClientMessageType.Signal; data: JSON };

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
  | { type: ServerMessageType.RoomJoined }
  | { type: ServerMessageType.PeerJoined }
  | { type: ServerMessageType.PeerLeft }
  | { type: ServerMessageType.Signal; data: JSON }
  | { type: ServerMessageType.Error; message: string }
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
}
