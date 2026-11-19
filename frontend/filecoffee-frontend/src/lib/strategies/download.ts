import {
    ServerMessage,
    ServerMessageType,
    ViewType,
    SignalLabelType,
    ClientMessageType,
} from "@/constants/enums";
import { IceServer } from "@/lib/utils";
import { FileReceiver, IncomingFile } from "@/lib/transfer/receiver";
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
    setIceServers: (servers: IceServer[] | undefined) => void;
    candidateQueueRef: React.MutableRefObject<RTCIceCandidate[]>;
    receiverRef: React.MutableRefObject<FileReceiver | null>;
    setIncomingFile: (file: IncomingFile | null) => void;
    setSavedToDisk: (saved: boolean) => void;
    initTransfer: (size: number) => void;
    updateTransfer: (bytes: number) => void;
    cancelTransfer: () => void;
}

class RoomJoinedStrategy extends BaseStrategy<DownloadHandlerContext> {
    handle(message: ServerMessage, context: DownloadHandlerContext) {
        if (message.type !== ServerMessageType.RoomJoined) return;

        context.setIceServers(message.ice_servers);

        context.toast.dismiss(context.toastId);
        context.toast.info("Connected. Waiting for the sender to accept...", {
            duration: Infinity,
            id: "awaiting-approval",
        });
        context.setCurrentView(ViewType.DOWNLOAD);
    }
}

class PeerLeftStrategy extends BaseStrategy<DownloadHandlerContext> {
    handle(message: ServerMessage, context: DownloadHandlerContext) {
        context.toast.info("Peer disconnected.");
        context.receiverRef.current?.cancel();
        context.receiverRef.current = null;
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
            context.toast.dismiss("awaiting-approval");
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

            this.startReceiver(dc, context);
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

    private startReceiver(dc: RTCDataChannel, context: DownloadHandlerContext) {
        context.receiverRef.current?.cancel();
        context.setIncomingFile(null);
        context.setDownloadUrl(null);
        context.setSavedToDisk(false);

        context.receiverRef.current = new FileReceiver(dc, {
            onOffer: (file) => {
                context.setFileName(file.name);
                context.setIncomingFile(file);
            },
            onStart: (file, kind) => {
                context.setIncomingFile(null);
                context.initTransfer(file.size);
                if (kind === "memory" && file.size > 1024 * 1024 * 1024) {
                    context.toast.warning(
                        "This browser can't write to disk while receiving, so a file this large may run out of memory."
                    );
                }
                context.toast.info(`Receiving ${file.name}...`);
            },
            onProgress: (bytes) => context.updateTransfer(bytes),
            onComplete: (file, url) => {
                context.setFileName(file.name);
                if (url) {
                    context.setDownloadUrl(url);
                } else {
                    context.setSavedToDisk(true);
                }
                context.toast.success("File transfer complete and verified!");
            },
            onError: (message) => {
                context.setIncomingFile(null);
                context.cancelTransfer();
                context.toast.error(message);
                context.setError(message);
            },
            onCanceledByPeer: () => {
                context.setIncomingFile(null);
                context.cancelTransfer();
                context.toast.error("Peer cancelled the transfer.");
            },
        });
    }
}

class ErrorStrategy extends BaseStrategy<DownloadHandlerContext> {
    handle(message: ServerMessage, context: DownloadHandlerContext) {
        if (message.type !== ServerMessageType.Error) return;

        context.toast.dismiss(context.toastId);
        context.toast.dismiss("awaiting-approval");
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
