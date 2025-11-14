import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
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