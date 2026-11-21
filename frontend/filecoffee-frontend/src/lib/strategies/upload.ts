import {
    ServerMessage,
    ServerMessageType,
    ViewType,
    DATA_CHANNEL_LABEL,
    SignalLabelType,
    ClientMessageType,
    ErrorCode,
} from "@/constants/enums";
import { IceServer } from "@/lib/utils";
import { FileSender } from "@/lib/transfer/sender";
import { BaseStrategy, StrategyManager } from "./base";

export interface UploadHandlerContext {
    setShareUrls: (urls: { long: string } | null) => void;
    setCurrentView: (view: ViewType) => void;
    setIsConnected: (connected: boolean) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toast: any;
    wsRef: React.MutableRefObject<WebSocket | null>;
    peerConnectionRef: React.MutableRefObject<RTCPeerConnection | null>;
    dataChannelRef: React.MutableRefObject<RTCDataChannel | null>;
    createConnection: () => Promise<RTCPeerConnection>;
    setIceServers: (servers: IceServer[] | undefined) => void;
    selectedFile: File | null;
    toastId: string | number;
    initTransfer: (size: number) => void;
    updateTransfer: (bytes: number) => void;
    cancelTransfer: () => void;
    onTransferComplete?: () => void;
    isCanceledRef: React.MutableRefObject<boolean>;
}

class RoomCreatedStrategy extends BaseStrategy<UploadHandlerContext> {
    handle(message: ServerMessage, context: UploadHandlerContext) {
        if (message.type !== ServerMessageType.RoomCreated) return;

        context.toast.dismiss(context.toastId);
        context.toast.success("Room created! Ready to share.");
        const { room_id } = message;

        const baseUrl = window.location.origin;
        const longUrl = `${baseUrl}/download/${room_id}`;

        context.setShareUrls({
            long: longUrl,
        });
        context.setCurrentView(ViewType.SHARE);
    }
}

// Only one receiver can be in the room at a time, so a single toast id is enough.
export const APPROVAL_TOAST_ID = "peer-approval";
// Persistent "your link is dead" notices share one id, so a new one replaces
// the old and starting again can clear it.
export const LINK_LOST_TOAST_ID = "link-lost";

class PeerLeftStrategy extends BaseStrategy<UploadHandlerContext> {
    handle(message: ServerMessage, context: UploadHandlerContext) {
        context.toast.dismiss(APPROVAL_TOAST_ID);
        context.toast.info("Peer disconnected.");
        context.setIsConnected(false);
        context.cancelTransfer();

        if (context.peerConnectionRef.current) {
            context.peerConnectionRef.current.close();
            context.peerConnectionRef.current = null;
        }
        if (context.dataChannelRef.current) {
            context.dataChannelRef.current.close();
            context.dataChannelRef.current = null;
        }
    }
}

class PeerJoinedStrategy extends BaseStrategy<UploadHandlerContext> {
    handle(message: ServerMessage, context: UploadHandlerContext) {
        if (message.type !== ServerMessageType.PeerJoined) return;
        const { peer_id } = message;
        // Fresh TURN credentials for this connection attempt.
        context.setIceServers(message.ice_servers);

        // Nothing is sent until the sender explicitly approves the receiver.
        context.toast("Someone opened your link", {
            id: APPROVAL_TOAST_ID,
            description: "Only send the file if you're expecting them.",
            duration: Infinity,
            action: {
                label: "Send file",
                onClick: () => {
                    this.startTransfer(context).catch((error) => {
                        console.error("Failed to start transfer:", error);
                        context.toast.error("Failed to start the transfer.");
                    });
                },
            },
            cancel: {
                label: "Reject",
                onClick: () => {
                    context.wsRef.current?.send(
                        JSON.stringify({
                            type: ClientMessageType.RejectPeer,
                            peer_id,
                        })
                    );
                    context.toast.info("Receiver rejected. Your link is still active.");
                },
            },
        });
    }

    private async startTransfer(context: UploadHandlerContext) {
        console.log("Peer approved! Starting WebRTC connection...");
        context.toast.info("Receiver approved. Connecting...");
        context.setIsConnected(true);
        context.isCanceledRef.current = false;

        // Clean up existing connection if any
        if (context.peerConnectionRef.current) {
            context.peerConnectionRef.current.close();
        }
        if (context.dataChannelRef.current) {
            context.dataChannelRef.current.close();
        }

        const peerConnection = await context.createConnection();

        // Create the Data Channel
        const dataChannel = peerConnection.createDataChannel(DATA_CHANNEL_LABEL);
        context.dataChannelRef.current = dataChannel;

        this.setupDataChannel(dataChannel, context);

        peerConnection.onicecandidate = (event) => {
            if (event.candidate && context.wsRef.current) {
                context.wsRef.current.send(
                    JSON.stringify({
                        type: ClientMessageType.Signal,
                        data: {
                            type: SignalLabelType.Candidate,
                            candidate: event.candidate,
                        },
                    })
                );
            }
        };

        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);

            if (context.wsRef.current) {
                context.wsRef.current.send(
                    JSON.stringify({
                        type: ClientMessageType.Signal,
                        data: offer,
                    })
                );
            }
        } catch (error) {
            console.error("Failed to create offer:", error);
            context.toast.error("Failed to create connection offer.");
        }
    }

    private setupDataChannel(dataChannel: RTCDataChannel, context: UploadHandlerContext) {
        const file = context.selectedFile;
        if (!file) return;

        const sender = new FileSender(dataChannel, file, {
            onStart: (size) => {
                context.toast.success("Receiver accepted. Sending...");
                context.initTransfer(size);
            },
            onProgress: (bytes) => context.updateTransfer(bytes),
            onComplete: () => {
                context.toast.success("File transfer completed successfully!");
                context.onTransferComplete?.();
            },
            onCanceledByPeer: () => {
                context.toast.error("The receiver cancelled the transfer.");
                context.isCanceledRef.current = true;
                context.cancelTransfer();
            },
            onError: (message) => {
                context.toast.error(message);
                context.cancelTransfer();
            },
        });

        dataChannel.onopen = () => {
            console.log("Data channel opened");
            context.toast.info("Connected. Waiting for the receiver to choose where to save...");
            sender.offer();
        };
    }
}

class SignalStrategy extends BaseStrategy<UploadHandlerContext> {
    async handle(message: ServerMessage, context: UploadHandlerContext) {
        if (message.type !== ServerMessageType.Signal) return;
        if (!context.peerConnectionRef.current) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const signal = message.data as any;

        if (signal.type === SignalLabelType.Answer) {
            await context.peerConnectionRef.current.setRemoteDescription(
                new RTCSessionDescription(signal)
            );
        } else if (signal.type === SignalLabelType.Candidate) {
            await context.peerConnectionRef.current.addIceCandidate(
                new RTCIceCandidate(signal.candidate)
            );
        }
    }
}

class ErrorStrategy extends BaseStrategy<UploadHandlerContext> {
    handle(message: ServerMessage, context: UploadHandlerContext) {
        if (message.type !== ServerMessageType.Error) return;

        context.toast.dismiss(context.toastId);
        console.error("Server error:", message.message);

        if (message.code === ErrorCode.TooManyAttempts || message.code === ErrorCode.RoomExpired) {
            // The server closed the room (someone kept guessing the password,
            // or nobody joined for too long). The link is dead; let the sender
            // start over with the same file.
            context.toast.dismiss(APPROVAL_TOAST_ID);
            context.toast.error(message.message, { duration: Infinity, id: LINK_LOST_TOAST_ID });
            context.setShareUrls(null);
            context.setCurrentView(ViewType.PASSWORD);
            return;
        }

        context.toast.error(message.message);
    }
}

export class UploadStrategyManager extends StrategyManager<UploadHandlerContext> {
    constructor() {
        super();
        this.register(ServerMessageType.RoomCreated, new RoomCreatedStrategy());
        this.register(ServerMessageType.PeerLeft, new PeerLeftStrategy());
        this.register(ServerMessageType.PeerJoined, new PeerJoinedStrategy());
        this.register(ServerMessageType.Signal, new SignalStrategy());
        this.register(ServerMessageType.Error, new ErrorStrategy());
    }
}
