import EnterPassword from "@/components/EnterPassword";
import { useEffect, useRef, useState } from "react";
import coffeeLogoImg from "@/assets/coffee-logo.png";
import FileDownload from "@/components/FileDownload";
import {
  ViewType,
  ClientMessage,
  ClientMessageType,
  ServerMessage,
  ServerMessageType,
  SignalLabelType,
} from "@/constants/enums.ts";
import { useParams } from "react-router-dom";
import { useRoomValidation } from "@/hooks/useRoomValidation.ts";
import { fetchIceServers } from "@/lib/utils";
import { toast } from "sonner";
import { WS_BASE_URL } from "@/config";

const Download = () => {
  const [currentView, setCurrentView] = useState<ViewType>(ViewType.PASSWORD);
  const [error, setError] = useState<string | null>(null);

  // Room handling
  const { action, room_id } = useParams<{ action: string; room_id: string }>();
  const {
    isValidating,
    roomExists,
    error: validationError,
  } = useRoomValidation(action, room_id);

  // WebSocket Refs
  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);

  // File Transfer State
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const lastReportedProgress = useRef(0);
  const receivedChunksRef = useRef<ArrayBuffer[]>([]);
  const receivedBytesRef = useRef<number>(0);
  const fileMetadataRef = useRef<{
    name: string;
    size: number;
    type: string;
  } | null>(null);
  
  // Store ICE servers promise so we can await it without delay later
  const iceServersPromiseRef = useRef<Promise<import("@/lib/utils").IceServer[]> | null>(null);
  const candidateQueueRef = useRef<RTCIceCandidate[]>([]);

  useEffect(() => {
    // Cleanup unmount
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  function handlePasswordSubmit(password: string) {
    if (!room_id) return;

    // Reset everything for a fresh attempt
    if (wsRef.current) wsRef.current.close();
    if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
    }
    candidateQueueRef.current = [];
    receivedChunksRef.current = [];
    receivedBytesRef.current = 0;
    setProgress(0);
    setDownloadUrl(null);
    setError(null);

    const toastId = toast.loading("Connecting to room...");

    // Start fetching ICE servers immediately when we start connecting
    iceServersPromiseRef.current = fetchIceServers();

    // Create the WebSocket connection
    const ws = new WebSocket(`${WS_BASE_URL}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("Connected to WebSocket");
      const msg: ClientMessage = {
        type: ClientMessageType.JoinRoom,
        room_id,
        password: password || undefined,
      };
      ws.send(JSON.stringify(msg));
    };

    ws.onmessage = async (event) => {
      try {
        const message: ServerMessage = JSON.parse(event.data);
        console.log("WebSocket message received:", message);

        switch (message.type) {
          case ServerMessageType.RoomJoined:
            toast.dismiss(toastId);
            toast.success("Joined room successfully!");
            setCurrentView(ViewType.DOWNLOAD);
            break;
          case ServerMessageType.PeerLeft:
            toast.info("Peer disconnected.");
            if (peerConnectionRef.current) {
                peerConnectionRef.current.close();
                peerConnectionRef.current = null;
            }
            break;
          case ServerMessageType.Signal: {
            const signal = message.data as any;

            if (signal.type === SignalLabelType.Offer) {
              console.log("Received WebRTC Offer. Creating answer...");
              toast.info("Receiving file transfer offer...");

              // Use pre-fetched servers or fetch now if missing
              const iceServers = await (iceServersPromiseRef.current || fetchIceServers());
              
              const peerConnection = new RTCPeerConnection({
                iceServers: iceServers,
              });
              peerConnectionRef.current = peerConnection;

              // 2. Catch the Data Channel (Receiver waits for it)
              peerConnection.ondatachannel = (event) => {
                const dc = event.channel;
                console.log("Data Channel Received:", dc.label);

                dc.onopen = () => {
                    console.log("Data Channel OPEN!");
                    toast.success("Connected to peer! Waiting for data...");
                };

                dc.onmessage = (e) => {
                  const data = e.data;

                  // 1. Handle Metadata (String)
                  if (typeof data === "string") {
                    try {
                      const metadata = JSON.parse(data);
                      if (metadata.type === "metadata") {
                        fileMetadataRef.current = {
                          name: metadata.fileName,
                          size: metadata.fileSize,
                          type: metadata.fileType,
                        };
                        receivedChunksRef.current = [];
                        receivedBytesRef.current = 0;
                        setProgress(0); // Reset progress
                        setDownloadUrl(null); // Reset download URL
                        setFileName(metadata.fileName); // Set the file name
                        toast.info(`Receiving ${metadata.fileName}...`);
                      }
                    } catch (err) {
                      console.error("Error parsing metadata:", err);
                    }
                  }
                  // 2. Handle Binary Chunk
                  else if (data instanceof ArrayBuffer) {
                    receivedChunksRef.current.push(data);
                    receivedBytesRef.current += data.byteLength;

                    // Update Progress UI (throttling could be added here if needed)
                    if (
                      fileMetadataRef.current &&
                      fileMetadataRef.current.size > 0
                    ) {
                      const percent =
                        (receivedBytesRef.current /
                          fileMetadataRef.current.size) *
                        100;
                      setProgress(Math.round(percent));
                    }

                    const percent = Math.round(
                      (receivedBytesRef.current /
                        fileMetadataRef.current.size) *
                        100,
                    );

                    if (percent > lastReportedProgress.current) {
                      dc.send(
                        JSON.stringify({
                          type: SignalLabelType.Progress,
                          percent: percent,
                        }),
                      );
                    }

                    lastReportedProgress.current = percent;

                    // Check if finished
                    if (
                      fileMetadataRef.current &&
                      receivedBytesRef.current >= fileMetadataRef.current.size
                    ) {
                      console.log("File transfer complete. Reassembling...");
                      const blob = new Blob(receivedChunksRef.current, {
                        type: fileMetadataRef.current.type,
                      });
                      const url = URL.createObjectURL(blob);
                      setDownloadUrl(url);
                      setFileName(fileMetadataRef.current.name);
                      toast.success("File transfer complete!");
                    }
                  }
                };
              };

              peerConnection.onicecandidate = (event) => {
                if (event.candidate && wsRef.current) {
                  wsRef.current.send(
                    JSON.stringify({
                      type: ClientMessageType.Signal,
                      data: {
                        type: SignalLabelType.Candidate,
                        candidate: event.candidate,
                      },
                    }),
                  );
                }
              };

              await peerConnection.setRemoteDescription(
                new RTCSessionDescription(signal),
              );

              // Process queued candidates AFTER remote description is set
              while (candidateQueueRef.current.length > 0) {
                  const candidate = candidateQueueRef.current.shift();
                  if (candidate) {
                      console.log("Adding queued candidate");
                      await peerConnection.addIceCandidate(candidate);
                  }
              }

              const answer = await peerConnection.createAnswer();
              await peerConnection.setLocalDescription(answer);

              if (wsRef.current) {
                wsRef.current.send(
                  JSON.stringify({
                    type: ClientMessageType.Signal,
                    data: answer,
                  }),
                );
              }
            } else if (
              signal.type === SignalLabelType.Candidate
            ) {
              const candidate = new RTCIceCandidate(signal.candidate);
              if (peerConnectionRef.current?.remoteDescription) {
                  await peerConnectionRef.current.addIceCandidate(candidate);
              } else {
                  console.log("Queueing candidate (PC not ready or RD null)");
                  candidateQueueRef.current.push(candidate);
              }
            }
            break;
          }
          case ServerMessageType.Error:
            toast.dismiss(toastId);
            toast.error(message.message);
            setError(message.message);
            break;
          default:
            break;
        }
      } catch (e) {
        console.error("Failed to parse message:", e);
        toast.dismiss(toastId);
        toast.error("An unexpected error occurred.");
        setError("An unexpected error occurred.");
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      toast.dismiss(toastId);
      toast.error("Failed to connect to the server.");
      setError("Failed to connect to the server.");
    };


    ws.onclose = () => {
      console.log("WebSocket connection closed");
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  }

  // Early return for Loading/Error states
  if (isValidating) {
    return (
      <div className="min-h-screen b-gradient-cream flex items-center justify-center">
        <p className="text-muted-foreground animate-pulse">
          Checking brew status...
        </p>
      </div>
    );
  }

  if (!roomExists) {
    return (
      <div className="min-h-screen bg-gradient-cream flex flex-col items-center justify-center gap-4">
        <h2 className="text-2xl font-bold text-red-500">
          404 - Brew Not Found!
        </h2>
        <p className="text-muted-foreground">{validationError}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-cream flex flex-col">
      {/* Header */}
      <header className="pt-12 pb-8 px-4">
        <div className="max-w-4xl mx-auto flex flex-col items-center gap-4">
          <img
            src={coffeeLogoImg}
            alt="Coffee Transfer"
            className="h-auto w-auto"
          />
          <div className="text-center">
            <h1 className="text-4xl font-bold bg-gradient-coffee bg-clip-text text-transparent mb-2">
              Coffee Transfer
            </h1>
            <p className="text-muted-foreground">
              Share files securely, smooth as your morning brew
            </p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center mt-8">
        <div className="w-full max-w-4xl mx-auto">
          {currentView === ViewType.DOWNLOAD && (
            <FileDownload
              progress={progress}
              fileName={fileName}
              downloadUrl={downloadUrl}
            />
          )}

          {currentView === ViewType.PASSWORD && (
              <EnterPassword handlePasswordSubmit={handlePasswordSubmit} />
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="py-6 px-4 border-t border-border/50">
        <p className="text-center text-sm text-muted-foreground">
          Powered by WebSockets · End-to-end transfer
        </p>
      </footer>
    </div>
  );
};

export default Download;
