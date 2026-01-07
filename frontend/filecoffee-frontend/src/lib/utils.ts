import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { API_BASE_URL } from "../config";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export interface IceServer {
    urls: string;
    username?: string;
    credential?: string;
}

export interface IceConfig {
    iceServers: IceServer[];
}

export async function fetchIceServers(): Promise<IceServer[]> {
    try {
        const response = await fetch(`${API_BASE_URL}/api/ice-servers`);
        if (!response.ok) {
            throw new Error("Failed to fetch ICE servers");
        }
        const config: IceConfig = await response.json();
        return config.iceServers;
    } catch (error) {
        console.error("Error fetching ICE servers:", error);
        // Fallback to Google STUN if fetch fails
        return [{ urls: "stun:stun.l.google.com:19302" }];
    }
}

export function getFileSize(file: { size: number }): string {
    const bytes = file.size;
    if (bytes === 0) return "0 KB";

    const KB = 1024;
    const MB = KB * 1024;
    const GB = MB * 1024;

    if (bytes >= GB) {
        return (bytes / GB).toFixed(2) + " GB";
    } else if (bytes >= MB) {
        return (bytes / MB).toFixed(2) + " MB";
    } else if (bytes >= KB) {
        return (bytes / KB).toFixed(2) + " KB";
    } else {
        return bytes + " B";
    }
}