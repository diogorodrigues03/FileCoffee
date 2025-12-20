import { useRef, useState } from "react";
import { FileUpload } from "@/components/FileUpload";
import { PasswordSetup } from "@/components/PasswordSetup";
import { ShareLinks } from "@/components/ShareLinks";
import { ViewType, ClientMessage, ServerMessage, ClientMessageType, ServerMessageType } from "@/constants/enums.ts";
import coffeeLogoImg from "@/assets/coffee-logo.png";

const Index = () => {
  const [currentView, setCurrentView] = useState<ViewType>(ViewType.UPLOAD);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [shareUrls, setShareUrls] = useState<{
    long: string;
    short: string;
  } | null>(null);
  const [transferProgress, setTransferProgress] = useState<number>(0);
  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const [progress, setProgress] = useState(0);

  const handleFileSelect = (file: File) => {
    setSelectedFile(file);
    setCurrentView(ViewType.PASSWORD);
  };

  const handleCancel = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setSelectedFile(null);
    setCurrentView(ViewType.UPLOAD);
  };

  const handleStart = async (password?: string) => {
    // Create the WebSocket connection
    const ws = new WebSocket("ws://localhost:3030/ws");
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("Connected to WebSocket");
      // Send CreateRoom message
      const msg: ClientMessage = { 
        type: ClientMessageType.CreateRoom,
        password: password,
      };
      ws.send(JSON.stringify(msg));
    };

    ws.onmessage = async (event) => {
      try {
        const message: ServerMessage = JSON.parse(event.data);
        console.log("WebSocket message received:", message);

        switch (message.type) {
          case ServerMessageType.RoomCreated: {
            const { room_id } = message;
            // Generate share URLs with the real room ID for now? Implement random URLs later?
            // Assuming the frontend is served on port 5173 (Vite default) or similar
            const baseUrl = window.location.origin;
            const longUrl = `${baseUrl}/download/${room_id}`;
            const shortUrl = `${baseUrl}/d/${room_id.substring(0, 6)}`; // Example short URL

            setShareUrls({
              long: longUrl,
              short: shortUrl,
            });
            setCurrentView(ViewType.SHARE);
            break;
          }
          case ServerMessageType.PeerJoined: {
            console.log("Peer joined! Starting WebRTC connection...");

            // First, create the RTCPeerConnection
            const peerConnection = new RTCPeerConnection({
              iceServers: [{ urls: "stun:stun.l.google.com:19302" }] // Google STUN Servers
            });
            peerConnectionRef.current = peerConnection;

            // Create the Data Channel
            const dataChannel = peerConnection.createDataChannel("fileTransfer");
            dataChannelRef.current = dataChannel;

            dataChannel.onopen = () => { 
              console.log("Data channel opened");

              if(!selectedFile) return;

              // 1. Send metadata first
              const metaData = JSON.stringify({
                type: "metadata",
                fileName: selectedFile.name,
                fileSize: selectedFile.size,
                fileType: selectedFile.type,
              });

              dataChannel.send(metaData);

              // 2. Read and Chunk the file
              const CHUNK_SIZE = 16 * 1024 // 16KB chunks
              const fileReader = new FileReader();

              fileReader.onload = (e) => {
                const buffer = e.target?.result as ArrayBuffer;
                let offset = 0;

                const sendChunk = () => {
                  while(offset < buffer.byteLength){
                    // If the buffer is full, we'll wait a bit
                    if(dataChannel.bufferedAmount > 10 * 1024 * 1024){
                      setTimeout(sendChunk, 100);
                      return;
                    }

                    const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
                    dataChannel.send(chunk);
                    offset += CHUNK_SIZE;

                    // Let's update the UI here later
                  }
                };

                sendChunk();
              };

              fileReader.readAsArrayBuffer(selectedFile);
            };
            dataChannel.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === "progress" && typeof msg.percent === "number") {
                        setTransferProgress(msg.percent);
                        console.log(`Receiver progress: ${msg.percent}%`);
                    }
                } catch (e) {
                    // Ignore binary data or other non-JSON messages
                }
            };
            dataChannel.onclose = () => { console.log("Data channel closed"); };

            peerConnection.onicecandidate = (event) => {
              if(event.candidate && wsRef.current){
                wsRef.current.send(JSON.stringify({
                  type: ClientMessageType.Signal,
                  data: { type: "candidate", candidate: event.candidate }
                }));
              }
            };

            try{
              const offer = await peerConnection.createOffer();
              await peerConnection.setLocalDescription(offer);

              if(wsRef.current){
                wsRef.current.send(JSON.stringify({
                  type: ClientMessageType.Signal,
                  data: offer
                }));
              }
            }catch(error){
              console.error("Failed to create offer:", error);
            }

            break;
          }
          case ServerMessageType.Signal: {
            if(!peerConnectionRef.current)
              return;

            const signal = message.data as any;

            // Handle Answer from Receiver
            if(signal.type === "answer"){
              await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(signal));
            }else if(signal.type === "candidate"){
              await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
            }
            
            break;
          }
          case ServerMessageType.Error:
            console.error("Server error:", message.message);
            break;
          default:
            break;
        }
      } catch (e) {
        console.error("Failed to parse message:", e);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    ws.onclose = () => {
      console.log("WebSocket connection closed");
      wsRef.current = null;
    };
  };

  return (
    <div className="min-h-screen bg-gradient-cream flex flex-col">
      {/* Header */}
      { currentView !== ViewType.SHARE && (
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
      )}

      {/* Main Content */}
      <main className="flex-1 flex justify-center mt-8">
        <div className="w-2/3 max-w-4xl">
          {currentView === ViewType.UPLOAD && (
            <FileUpload onFileSelect={handleFileSelect} />
          )}

          {currentView === ViewType.PASSWORD && selectedFile && (
            <PasswordSetup
              fileName={selectedFile.name}
              onCancel={handleCancel}
              onStart={handleStart}
            />
          )}

          {currentView === ViewType.SHARE && shareUrls && (
            <ShareLinks longUrl={shareUrls.long} shortUrl={shareUrls.short} progress={progress} />
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

export default Index;
