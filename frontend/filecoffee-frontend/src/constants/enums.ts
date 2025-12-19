export enum ViewType {
    UPLOAD,
    DOWNLOAD,
    PASSWORD,
    SHARE
}

// Define types to match backend
export enum ClientMessageType {
    CreateRoom = "CreateRoom",
    JoinRoom = "JoinRoom",
    Signal = "Signal"
}

export type ClientMessage =
    | { type: ClientMessageType.CreateRoom, password?: string }
    | { type: ClientMessageType.JoinRoom; room_id: string, password?:string }
    | { type: ClientMessageType.Signal; data: JSON };

export enum ServerMessageType {
    RoomCreated = "RoomCreated",
    RoomJoined = "RoomJoined",
    PeerJoined = "PeerJoined",
    Signal = "Signal",
    Error = "Error"
}

export type ServerMessage =
    | { type: ServerMessageType.RoomCreated; room_id: string }
    | { type: ServerMessageType.RoomJoined }
    | { type: ServerMessageType.PeerJoined }
    | { type: ServerMessageType.Signal; data: JSON }
    | { type: ServerMessageType.Error; message: string };