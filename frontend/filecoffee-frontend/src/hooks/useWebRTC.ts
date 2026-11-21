import { useRef, useCallback, useEffect } from "react";
import { IceServer } from "@/lib/utils";

// Used only if the server hasn't sent any ICE servers yet.
const FALLBACK_ICE_SERVERS: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export function useWebRTC() {
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const dataChannelRef = useRef<RTCDataChannel | null>(null);
    // Delivered over the WebSocket (RoomJoined / PeerJoined) once this peer is
    // admitted to a room; TURN credentials are never fetched anonymously.
    const iceServersRef = useRef<IceServer[] | null>(null);
    const candidateQueueRef = useRef<RTCIceCandidate[]>([]);

    const setIceServers = useCallback((servers: IceServer[] | undefined) => {
        if (servers && servers.length > 0) {
            iceServersRef.current = servers;
        }
    }, []);

    const createConnection = useCallback(async () => {
        const iceServers = iceServersRef.current ?? FALLBACK_ICE_SERVERS;
        const pc = new RTCPeerConnection({ iceServers });
        peerConnectionRef.current = pc;
        return pc;
    }, []);

    const cleanup = useCallback(() => {
        if (dataChannelRef.current) {
            dataChannelRef.current.close();
            dataChannelRef.current = null;
        }
        if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
            peerConnectionRef.current = null;
        }
    }, []);

    useEffect(() => cleanup, [cleanup]);

    return { peerConnectionRef, dataChannelRef, candidateQueueRef, setIceServers, createConnection, cleanup };
}
