import { useRef, useCallback, useEffect } from "react";
import { fetchIceServers, IceServer } from "@/lib/utils";

export function useWebRTC() {
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const dataChannelRef = useRef<RTCDataChannel | null>(null);
    const iceServersPromiseRef = useRef<Promise<IceServer[]> | null>(null);
    const candidateQueueRef = useRef<RTCIceCandidate[]>([]);

    const initIceServers = useCallback(() => {
        if (!iceServersPromiseRef.current) {
            iceServersPromiseRef.current = fetchIceServers();
        }
        return iceServersPromiseRef.current;
    }, []);

    const createConnection = useCallback(async () => {
        const iceServers = await initIceServers();
        const pc = new RTCPeerConnection({ iceServers });
        peerConnectionRef.current = pc;
        return pc;
    }, [initIceServers]);

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

    return { peerConnectionRef, dataChannelRef, iceServersPromiseRef, candidateQueueRef, initIceServers, createConnection, cleanup };
}
