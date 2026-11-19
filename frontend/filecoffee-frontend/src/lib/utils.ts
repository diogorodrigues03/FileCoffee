import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { TransferStats } from "@/types/transfer";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export interface IceServer {
    urls: string;
    username?: string;
    credential?: string;
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

export async function calculateSHA256(data: File | Blob): Promise<string> {
    const buffer = await data.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return hashHex;
}

export function updateStats(stats: TransferStats, newBytes: number, totalSize: number): TransferStats {
    const now = Date.now();
    const elapsedMs = now - stats.lastUpdate;

    const speedBps = elapsedMs > 0 ? (newBytes / elapsedMs) * 1000 : stats.speedBps;

    const bytesTransferred = stats.bytesTransferred + newBytes;
    const remainingBytes = Math.max(0, totalSize - bytesTransferred);

    const etaSeconds = speedBps > 0 ? remainingBytes / speedBps : Infinity;
    const percent = totalSize > 0 ? (bytesTransferred / totalSize) * 100 : 0;

    return {
        bytesTransferred,
        totalSize,
        startTime: stats.startTime,
        lastUpdate: now,
        speedBps,
        etaSeconds,
        percent: Math.min(100, percent)
    };
}

export function formatSpeed(bps: number): string {
    if (bps === 0) return "0 B/s";
    const k = 1024;
    const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
    const i = Math.floor(Math.log(bps) / Math.log(k));
    return parseFloat((bps / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatTime(seconds: number): string {
    if (seconds === Infinity || isNaN(seconds)) return "--:--";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}