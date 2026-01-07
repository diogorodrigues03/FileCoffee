import {
  ServerMessage,
  ServerMessageType,
  ViewType,
  DATA_CHANNEL_LABEL,
  SignalLabelType,
  ClientMessageType,
} from "@/constants/enums";
import { fetchIceServers } from "@/lib/utils";

export interface HandlerContext {
  setShareUrls: (urls: { long: string } | null) => void;
  setCurrentView: (view: ViewType) => void;
  setIsConnected: (connected: boolean) => void;
  setTransferProgress: (progress: number) => void;
  toast: any;
  wsRef: React.MutableRefObject<WebSocket | null>;
  peerConnectionRef: React.MutableRefObject<RTCPeerConnection | null>;
  dataChannelRef: React.MutableRefObject<RTCDataChannel | null>;
  selectedFile: File | null;
  toastId: string | number;
}

export interface MessageStrategy {
  handle(message: ServerMessage, context: HandlerContext): Promise<void> | void;
}

class RoomCreatedStrategy implements MessageStrategy {
  handle(message: ServerMessage, context: HandlerContext) {
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

class PeerLeftStrategy implements MessageStrategy {
  handle(message: ServerMessage, context: HandlerContext) {
    context.toast.info("Peer disconnected.");
    context.setIsConnected(false);
    context.setTransferProgress(0);
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

class PeerJoinedStrategy implements MessageStrategy {
  async handle(message: ServerMessage, context: HandlerContext) {
    console.log("Peer joined! Starting WebRTC connection...");
    context.toast.info("A peer has joined! connecting...");
    context.setIsConnected(true);
    context.setTransferProgress(0);

    // Clean up existing connection if any
    if (context.peerConnectionRef.current) {
      context.peerConnectionRef.current.close();
    }
    if (context.dataChannelRef.current) {
      context.dataChannelRef.current.close();
    }

    // First, create the RTCPeerConnection
    const iceServers = await fetchIceServers();
    console.log("Using ICE servers:", iceServers);

    const peerConnection = new RTCPeerConnection({
      iceServers: iceServers,
    });
    context.peerConnectionRef.current = peerConnection;

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

  private setupDataChannel(dataChannel: RTCDataChannel, context: HandlerContext) {
    dataChannel.onopen = () => {
      console.log("Data channel opened");
      context.toast.success("Connected! Sending file...");

      if (!context.selectedFile) return;

      // 1. Send metadata first
      const metaData = JSON.stringify({
        type: "metadata",
        fileName: context.selectedFile.name,
        fileSize: context.selectedFile.size,
        fileType: context.selectedFile.type,
      });

      dataChannel.send(metaData);

      // 2. Read and Chunk the file
      // Note: This might consume more memory on low-end devices but significantly speeds up transfer.
      const CHUNK_SIZE = 256 * 1024;
      const MAX_BUFFERED_AMOUNT = 64 * 1024 * 1024;

      dataChannel.bufferedAmountLowThreshold = 0;

      let offset = 0;
      const fileReader = new FileReader();

      fileReader.onload = (e) => {
        const buffer = e.target?.result as ArrayBuffer;
        if (!buffer) return;

        try {
          dataChannel.send(buffer);
          offset += buffer.byteLength;
          sendNextChunk();
        } catch (error) {
          console.error("Error sending chunk:", error);
          context.toast.error("Error sending file data");
        }
      };

      const sendNextChunk = () => {
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
        if (
          msg.type === SignalLabelType.Progress &&
          typeof msg.percent === "number"
        ) {
          context.setTransferProgress(msg.percent);
          if (msg.percent === 100) {
            context.toast.success("File transfer completed successfully!");
          }
        }
      } catch (e) {
        // Ignore binary data or other non-JSON messages
      }
    };

    dataChannel.onclose = () => {
      console.log("Data channel closed");
    };
  }
}

class SignalStrategy implements MessageStrategy {
  async handle(message: ServerMessage, context: HandlerContext) {
    if (message.type !== ServerMessageType.Signal) return;
    if (!context.peerConnectionRef.current) return;

    const signal = message.data as any;

    // Handle Answer from Receiver
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

class ErrorStrategy implements MessageStrategy {
  handle(message: ServerMessage, context: HandlerContext) {
    if (message.type !== ServerMessageType.Error) return;

    context.toast.dismiss(context.toastId);
    console.error("Server error:", message.message);
    context.toast.error(message.message);
  }
}

export class WebSocketStrategyManager {
  private strategies: Partial<Record<ServerMessageType, MessageStrategy>> = {};

  constructor() {
    this.register(ServerMessageType.RoomCreated, new RoomCreatedStrategy());
    this.register(ServerMessageType.PeerLeft, new PeerLeftStrategy());
    this.register(ServerMessageType.PeerJoined, new PeerJoinedStrategy());
    this.register(ServerMessageType.Signal, new SignalStrategy());
    this.register(ServerMessageType.Error, new ErrorStrategy());
  }

  register(type: ServerMessageType, strategy: MessageStrategy) {
    this.strategies[type] = strategy;
  }

  async handleMessage(message: ServerMessage, context: HandlerContext) {
    const strategy = this.strategies[message.type];
    if (strategy) {
      await strategy.handle(message, context);
    } else {
      console.warn(`No strategy found for message type: ${message.type}`);
    }
  }
}
