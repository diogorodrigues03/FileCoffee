import {
    ServerMessage,
    ServerMessageType,
    ViewType,
    SignalLabelType,
    ClientMessageType,
} from "@/constants/enums";
import { fetchIceServers, IceServer, calculateSHA256 } from "@/lib/utils";
import { BaseStrategy, StrategyManager } from "./base";

export interface DownloadHandlerContext {
    setCurrentView: (view: ViewType) => void;
    setError: (error: string | null) => void;
    setDownloadUrl: (url: string | null) => void;
    setFileName: (name: string) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toast: any;
    toastId: string | number;
    wsRef: React.MutableRefObject<WebSocket | null>;
    peerConnectionRef: React.MutableRefObject<RTCPeerConnection | null>;
    createConnection: () => Promise<RTCPeerConnection>;
    candidateQueueRef: React.MutableRefObject<RTCIceCandidate[]>;
    receivedChunksRef: React.MutableRefObject<ArrayBuffer[]>;
    receivedBytesRef: React.MutableRefObject<number>;
    fileMetadataRef: React.MutableRefObject<{
        name: string;
        size: number;
        type: string;
        sha256: string;
    } | null>;
    initTransfer: (size: number) => void;
    updateTransfer: (bytes: number) => void;
    cancelTransfer: () => void;
    isCanceledRef: React.MutableRefObject<boolean>;
}

class RoomJoinedStrategy extends BaseStrategy<DownloadHandlerContext> {
    handle(message: ServerMessage, context: DownloadHandlerContext) {
        if (message.type !== ServerMessageType.RoomJoined) return;

        context.toast.dismiss(context.toastId);
        context.toast.success("Joined room successfully!");
        context.setCurrentView(ViewType.DOWNLOAD);
    }
}

class PeerLeftStrategy extends BaseStrategy<DownloadHandlerContext> {
    handle(message: ServerMessage, context: DownloadHandlerContext) {
        context.toast.info("Peer disconnected.");
        context.cancelTransfer();
        if (context.peerConnectionRef.current) {
            context.peerConnectionRef.current.close();
            context.peerConnectionRef.current = null;
        }
    }
}

class SignalStrategy extends BaseStrategy<DownloadHandlerContext> {
    async handle(message: ServerMessage, context: DownloadHandlerContext) {
        if (message.type !== ServerMessageType.Signal) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const signal = message.data as any;

        if (signal.type === SignalLabelType.Offer) {
            context.isCanceledRef.current = false;
            await this.handleOffer(signal, context);
        } else if (signal.type === SignalLabelType.Candidate) {
            await this.handleCandidate(signal, context);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async handleOffer(signal: any, context: DownloadHandlerContext) {
        console.log("Received WebRTC Offer. Creating answer...");
        context.toast.info("Receiving file transfer offer...");

        const peerConnection = await context.createConnection();

        // Catch the Data Channel (Receiver waits for it)
        peerConnection.ondatachannel = (event) => {
            const dc = event.channel;
            console.log("Data Channel Received:", dc.label);

            dc.onopen = () => {
                console.log("Data Channel OPEN!");
                context.toast.success("Connected to peer! Waiting for data...");
            };

            dc.onmessage = (e) => this.handleDataChannelMessage(e, context, dc);
        };

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

        await peerConnection.setRemoteDescription(
            new RTCSessionDescription(signal)
        );

        // Process queued candidates AFTER remote description is set
        while (context.candidateQueueRef.current.length > 0) {
            const candidate = context.candidateQueueRef.current.shift();
            if (candidate) {
                console.log("Adding queued candidate");
                await peerConnection.addIceCandidate(candidate);
            }
        }

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        if (context.wsRef.current) {
            context.wsRef.current.send(
                JSON.stringify({
                    type: ClientMessageType.Signal,
                    data: answer,
                })
            );
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async handleCandidate(signal: any, context: DownloadHandlerContext) {
        const candidate = new RTCIceCandidate(signal.candidate);
        if (context.peerConnectionRef.current?.remoteDescription) {
            await context.peerConnectionRef.current.addIceCandidate(candidate);
        } else {
            console.log("Queueing candidate (PC not ready or RD null)");
            context.candidateQueueRef.current.push(candidate);
        }
    }

    private async handleDataChannelMessage(
        e: MessageEvent,
        context: DownloadHandlerContext,
        dc: RTCDataChannel
    ) {
        const data = e.data;
        if (context.isCanceledRef.current) return;

        // 1. Handle Metadata (String)
        if (typeof data === "string") {
            try {
                const metadata = JSON.parse(data);
                if (metadata.type === SignalLabelType.Cancel) {
                    context.toast.error("Peer cancelled the transfer.");
                    context.isCanceledRef.current = true;
                    context.cancelTransfer();
                    return;
                }

                if (metadata.type === "metadata") {
                    context.fileMetadataRef.current = {
                        name: metadata.fileName,
                        size: metadata.fileSize,
                        type: metadata.fileType,
                        sha256: metadata.sha256,
                    };
                    context.receivedChunksRef.current = [];
                    context.receivedBytesRef.current = 0;
                    context.setDownloadUrl(null);
                    context.setFileName(metadata.fileName);

                    context.initTransfer(metadata.fileSize);
                    context.toast.info(`Receiving ${metadata.fileName}...`);
                }
            } catch (err) {
                console.error("Error parsing metadata:", err);
            }
        }
        // 2. Handle Binary Chunk
        else if (data instanceof ArrayBuffer) {
            context.receivedChunksRef.current.push(data);
            context.receivedBytesRef.current += data.byteLength;

            context.updateTransfer(data.byteLength);

            // Check if finished
            if (
                context.fileMetadataRef.current &&
                context.receivedBytesRef.current >= context.fileMetadataRef.current.size
            ) {
                console.log("File transfer complete. Reassembling...");
                context.toast.info("Reassembling and verifying file...");

                const blob = new Blob(context.receivedChunksRef.current, {
                    type: context.fileMetadataRef.current.type,
                });

                const expectedHash = context.fileMetadataRef.current.sha256;
                if (expectedHash) {
                    const actualHash = await calculateSHA256(blob);
                    if (expectedHash !== actualHash) {
                        context.toast.error("File integrity check failed. The file may be corrupted.");
                        context.setError("File integrity check failed (SHA-256 mismatch).");
                        return;
                    }
                }

                const url = URL.createObjectURL(blob);
                context.setDownloadUrl(url);
                context.setFileName(context.fileMetadataRef.current.name);
                context.toast.success("File transfer complete and verified!");

                // Notify sender we got it completely
                dc.send(
                    JSON.stringify({
                        type: SignalLabelType.Progress,
                        percent: 100,
                    })
                );
            }
        }
    }
}

class ErrorStrategy extends BaseStrategy<DownloadHandlerContext> {
    handle(message: ServerMessage, context: DownloadHandlerContext) {
        if (message.type !== ServerMessageType.Error) return;

        context.toast.dismiss(context.toastId);
        context.toast.error(message.message);
        context.setError(message.message);
    }
}

export class DownloadStrategyManager extends StrategyManager<DownloadHandlerContext> {
    constructor() {
        super();
        this.register(ServerMessageType.RoomJoined, new RoomJoinedStrategy());
        this.register(ServerMessageType.PeerLeft, new PeerLeftStrategy());
        this.register(ServerMessageType.Signal, new SignalStrategy());
        this.register(ServerMessageType.Error, new ErrorStrategy());
    }
}
