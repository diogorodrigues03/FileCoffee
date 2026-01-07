import {
  ServerMessage,
  ServerMessageType,
  ViewType,
  SignalLabelType,
  ClientMessageType,
} from "@/constants/enums";
import { fetchIceServers, IceServer } from "@/lib/utils";

export interface DownloadHandlerContext {
  setCurrentView: (view: ViewType) => void;
  setError: (error: string | null) => void;
  setProgress: (progress: number) => void;
  setDownloadUrl: (url: string | null) => void;
  setFileName: (name: string) => void;
  toast: any;
  toastId: string | number;
  wsRef: React.MutableRefObject<WebSocket | null>;
  peerConnectionRef: React.MutableRefObject<RTCPeerConnection | null>;
  iceServersPromiseRef: React.MutableRefObject<Promise<IceServer[]> | null>;
  candidateQueueRef: React.MutableRefObject<RTCIceCandidate[]>;
  receivedChunksRef: React.MutableRefObject<ArrayBuffer[]>;
  receivedBytesRef: React.MutableRefObject<number>;
  fileMetadataRef: React.MutableRefObject<{
    name: string;
    size: number;
    type: string;
  } | null>;
  lastReportedProgress: React.MutableRefObject<number>;
}

export interface DownloadMessageStrategy {
  handle(
    message: ServerMessage,
    context: DownloadHandlerContext
  ): Promise<void> | void;
}

class RoomJoinedStrategy implements DownloadMessageStrategy {
  handle(message: ServerMessage, context: DownloadHandlerContext) {
    if (message.type !== ServerMessageType.RoomJoined) return;

    context.toast.dismiss(context.toastId);
    context.toast.success("Joined room successfully!");
    context.setCurrentView(ViewType.DOWNLOAD);
  }
}

class PeerLeftStrategy implements DownloadMessageStrategy {
  handle(message: ServerMessage, context: DownloadHandlerContext) {
    context.toast.info("Peer disconnected.");
    if (context.peerConnectionRef.current) {
      context.peerConnectionRef.current.close();
      context.peerConnectionRef.current = null;
    }
  }
}

class SignalStrategy implements DownloadMessageStrategy {
  async handle(message: ServerMessage, context: DownloadHandlerContext) {
    if (message.type !== ServerMessageType.Signal) return;

    const signal = message.data as any;

    if (signal.type === SignalLabelType.Offer) {
      await this.handleOffer(signal, context);
    } else if (signal.type === SignalLabelType.Candidate) {
      await this.handleCandidate(signal, context);
    }
  }

  private async handleOffer(signal: any, context: DownloadHandlerContext) {
    console.log("Received WebRTC Offer. Creating answer...");
    context.toast.info("Receiving file transfer offer...");

    const iceServers = await (context.iceServersPromiseRef.current ||
      fetchIceServers());

    const peerConnection = new RTCPeerConnection({
      iceServers: iceServers,
    });
    context.peerConnectionRef.current = peerConnection;

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

  private async handleCandidate(signal: any, context: DownloadHandlerContext) {
    const candidate = new RTCIceCandidate(signal.candidate);
    if (context.peerConnectionRef.current?.remoteDescription) {
      await context.peerConnectionRef.current.addIceCandidate(candidate);
    } else {
      console.log("Queueing candidate (PC not ready or RD null)");
      context.candidateQueueRef.current.push(candidate);
    }
  }

  private handleDataChannelMessage(
    e: MessageEvent,
    context: DownloadHandlerContext,
    dc: RTCDataChannel
  ) {
    const data = e.data;

    // 1. Handle Metadata (String)
    if (typeof data === "string") {
      try {
        const metadata = JSON.parse(data);
        if (metadata.type === "metadata") {
          context.fileMetadataRef.current = {
            name: metadata.fileName,
            size: metadata.fileSize,
            type: metadata.fileType,
          };
          context.receivedChunksRef.current = [];
          context.receivedBytesRef.current = 0;
          context.setProgress(0);
          context.setDownloadUrl(null);
          context.setFileName(metadata.fileName);
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

      if (
        context.fileMetadataRef.current &&
        context.fileMetadataRef.current.size > 0
      ) {
        const percent =
          (context.receivedBytesRef.current /
            context.fileMetadataRef.current.size) *
          100;
        context.setProgress(Math.round(percent));
      }

      const percent = Math.round(
        (context.receivedBytesRef.current /
          (context.fileMetadataRef.current?.size || 1)) *
          100
      );

      if (percent > context.lastReportedProgress.current) {
        dc.send(
          JSON.stringify({
            type: SignalLabelType.Progress,
            percent: percent,
          })
        );
      }

      context.lastReportedProgress.current = percent;

      // Check if finished
      if (
        context.fileMetadataRef.current &&
        context.receivedBytesRef.current >= context.fileMetadataRef.current.size
      ) {
        console.log("File transfer complete. Reassembling...");
        const blob = new Blob(context.receivedChunksRef.current, {
          type: context.fileMetadataRef.current.type,
        });
        const url = URL.createObjectURL(blob);
        context.setDownloadUrl(url);
        context.setFileName(context.fileMetadataRef.current.name);
        context.toast.success("File transfer complete!");
      }
    }
  }
}

class ErrorStrategy implements DownloadMessageStrategy {
  handle(message: ServerMessage, context: DownloadHandlerContext) {
    if (message.type !== ServerMessageType.Error) return;

    context.toast.dismiss(context.toastId);
    context.toast.error(message.message);
    context.setError(message.message);
  }
}

export class DownloadWebSocketStrategyManager {
  private strategies: Partial<
    Record<ServerMessageType, DownloadMessageStrategy>
  > = {};

  constructor() {
    this.register(ServerMessageType.RoomJoined, new RoomJoinedStrategy());
    this.register(ServerMessageType.PeerLeft, new PeerLeftStrategy());
    this.register(ServerMessageType.Signal, new SignalStrategy());
    this.register(ServerMessageType.Error, new ErrorStrategy());
  }

  register(type: ServerMessageType, strategy: DownloadMessageStrategy) {
    this.strategies[type] = strategy;
  }

  async handleMessage(message: ServerMessage, context: DownloadHandlerContext) {
    const strategy = this.strategies[message.type];
    if (strategy) {
      await strategy.handle(message, context);
    } else {
      console.warn(`No strategy found for message type: ${message.type}`);
    }
  }
}
