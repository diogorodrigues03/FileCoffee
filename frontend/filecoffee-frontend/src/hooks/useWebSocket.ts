import { useState, useCallback, useRef } from "react";

export function useWebSocket() {
    const wsRef = useRef<WebSocket | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const reconnectAttempt = useRef(0);
    const maxRetries = 5;

    const connect = useCallback((url: string) => {
        return new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(url);
            wsRef.current = ws;

            ws.onopen = () => {
                setIsConnected(true);
                reconnectAttempt.current = 0;
                resolve(ws);
            };

            ws.onclose = () => {
                setIsConnected(false);
                if (reconnectAttempt.current < maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 30000);
                    setTimeout(() => {
                        reconnectAttempt.current++;
                        connect(url).catch(() => { });
                    }, delay);
                }
            };

            ws.onerror = (err) => {
                console.error("WebSocket error:", err);
                if (!isConnected) {
                    reject(err);
                }
            };
        });
    }, [isConnected]);

    const disconnect = useCallback(() => {
        reconnectAttempt.current = maxRetries; // Prevent auto-reconnect
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        setIsConnected(false);
    }, []);

    return { wsRef, isConnected, connect, disconnect };
}
