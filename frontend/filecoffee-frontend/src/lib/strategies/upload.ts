import {
    ServerMessage,
    ServerMessageType,
    ViewType,
    DATA_CHANNEL_LABEL,
    SignalLabelType,
    ClientMessageType,
} from "@/constants/enums";
import { calculateSHA256 } from "@/lib/utils";
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

class PeerLeftStrategy extends BaseStrategy<UploadHandlerContext> {
    handle(message: ServerMessage, context: UploadHandlerContext) {
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
    async handle(message: ServerMessage, context: UploadHandlerContext) {
        console.log("Peer joined! Starting WebRTC connection...");
        context.toast.info("A peer has joined! connecting...");
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

    private async setupDataChannel(dataChannel: RTCDataChannel, context: UploadHandlerContext) {
        dataChannel.onopen = async () => {
            console.log("Data channel opened");
            context.toast.success("Connected! Preparing file... (Computing SHA-256)");

            if (!context.selectedFile) return;

            const sha256 = await calculateSHA256(context.selectedFile);

            context.toast.success("File verified! Sending...");
            context.initTransfer(context.selectedFile.size);

            // 1. Send metadata first
            const metaData = JSON.stringify({
                type: "metadata",
                fileName: context.selectedFile.name,
                fileSize: context.selectedFile.size,
                fileType: context.selectedFile.type,
                sha256: sha256,
            });

            dataChannel.send(metaData);

            // 2. Read and Chunk the file
            const CHUNK_SIZE = 256 * 1024;
            const MAX_BUFFERED_AMOUNT = 64 * 1024 * 1024;

            dataChannel.bufferedAmountLowThreshold = 0;

            let offset = 0;
            const fileReader = new FileReader();

            fileReader.onload = (e) => {
                if (context.isCanceledRef.current) return;

                const buffer = e.target?.result as ArrayBuffer;
                if (!buffer) return;

                try {
                    dataChannel.send(buffer);
                    context.updateTransfer(buffer.byteLength);
                    offset += buffer.byteLength;
                    sendNextChunk();
                } catch (error) {
                    console.error("Error sending chunk:", error);
                    context.toast.error("Error sending file data");
                }
            };

            const sendNextChunk = () => {
                if (context.isCanceledRef.current) return;

                if (!context.selectedFile || offset >= context.selectedFile.size) {
                    return;
                }

                // If the buffer is full, wait for it to drain
                if (dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                    return;
                }

                const slice = context.selectedFile.slice(offset, offset + CHUNK_SIZE);
                fileReader.readAsArrayBuffer(slice);
            };

            dataChannel.onbufferedamountlow = () => {
                sendNextChunk();
            };

            sendNextChunk();
        };

        dataChannel.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === SignalLabelType.Cancel) {
                    context.toast.error("Peer cancelled the transfer.");
                    context.isCanceledRef.current = true;
                    context.cancelTransfer();
                } else if (msg.type === SignalLabelType.Progress) {
                    if (msg.percent === 100) {
                        context.toast.success("File transfer completed successfully!");
                        if (context.onTransferComplete) context.onTransferComplete();
                    }
                }
            } catch (e) {
                // Ignore binary data
            }
        };

        dataChannel.onclose = () => {
            console.log("Data channel closed");
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
