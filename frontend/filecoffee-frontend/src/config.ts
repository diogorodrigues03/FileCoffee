export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

const getWsBaseUrl = () => {
    if (import.meta.env.VITE_WS_BASE_URL) {
        return import.meta.env.VITE_WS_BASE_URL;
    }
    // Default for development (if not set)
    if (import.meta.env.DEV) {
        return "ws://localhost:3030";
    }
    // Default for production (relative to window)
    // Note: This assumes the app is served from the same domain as the websocket server
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}`;
};

export const WS_BASE_URL = getWsBaseUrl();