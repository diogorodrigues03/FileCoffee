import { useState, useCallback, useRef } from "react";

/**
 * One signaling WebSocket.
 *
 * There is deliberately no auto-reconnect: room membership lives on the
 * server and is dropped with the socket (the sender's room is deleted once
 * it's empty), so a fresh socket would be in no room and the share link would
 * silently stop working. Instead `onUnexpectedClose` fires for any close we
 * didn't ask for, and the page decides what to tell the user.
 */
export function useWebSocket() {
    const wsRef = useRef<WebSocket | null>(null);
    const [isConnected, setIsConnected] = useState(false);

    const connect = useCallback(
        (url: string, onUnexpectedClose?: (event: CloseEvent) => void) => {
            return new Promise<WebSocket>((resolve, reject) => {
                const ws = new WebSocket(url);
                wsRef.current = ws;
                let opened = false;

                ws.onopen = () => {
                    opened = true;
                    setIsConnected(true);
                    resolve(ws);
                };

                ws.onerror = (err) => {
                    console.error("WebSocket error:", err);
                };

                ws.onclose = (event) => {
                    if (!opened) {
                        reject(new Error(`WebSocket closed before opening (code ${event.code})`));
                    }
                    // A socket we replaced or closed ourselves: nothing to report.
                    if (wsRef.current !== ws) return;
                    wsRef.current = null;
                    setIsConnected(false);
                    if (opened) onUnexpectedClose?.(event);
                };
            });
        },
        []
    );

    const disconnect = useCallback(() => {
        const ws = wsRef.current;
        // Clear first so onclose knows this close was intentional.
        wsRef.current = null;
        ws?.close();
        setIsConnected(false);
    }, []);

    return { wsRef, isConnected, connect, disconnect };
}
