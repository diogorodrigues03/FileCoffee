export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

const getWsBaseUrl = () => {
    if (import.meta.env.VITE_WS_BASE_URL) {
        return import.meta.env.VITE_WS_BASE_URL;
    }

    if (import.meta.env.DEV) {
        return "ws://localhost:3030";
    }
    
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}`;
};

export const WS_BASE_URL = getWsBaseUrl();