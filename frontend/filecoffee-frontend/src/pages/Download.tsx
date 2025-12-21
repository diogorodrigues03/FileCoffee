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

    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close();
    }

    setError(null);

    // Create the WebSocket connection
    const ws = new WebSocket("ws://localhost:3030/ws");
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
            setCurrentView(ViewType.DOWNLOAD);
            break;
          case ServerMessageType.Signal: {
            const signal = message.data as any;

            if (signal.type === SignalLabelType.Offer) {
              console.log("Received WebRTC Offer. Creating answer...");

              const peerConnection = new RTCPeerConnection({
                iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
              });
              peerConnectionRef.current = peerConnection;

              // 2. Catch the Data Channel (Receiver waits for it)
              peerConnection.ondatachannel = (event) => {
                const dc = event.channel;
                console.log("Data Channel Received:", dc.label);

                dc.onopen = () => console.log("Data Channel OPEN!");

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
              signal.type === SignalLabelType.Candidate &&
              peerConnectionRef.current
            ) {
              await peerConnectionRef.current.addIceCandidate(
                new RTCIceCandidate(signal.candidate),
              );
            }
            break;
          }
          case ServerMessageType.Error:
            setError(message.message);
            break;
          default:
            break;
        }
      } catch (e) {
        console.error("Failed to parse message:", e);
        setError("An unexpected error occurred.");
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setError("Failed to connect to the server.");
    };

    ws.onclose = () => {
      console.log("WebSocket connection closed");
      wsRef.current = null;
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
            <>
              <EnterPassword handlePasswordSubmit={handlePasswordSubmit} />
              {error && (
                <p className="text-red-500 text-center mt-4">{error}</p>
              )}
            </>
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
