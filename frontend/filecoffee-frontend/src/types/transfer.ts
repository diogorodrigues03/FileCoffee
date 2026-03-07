export interface TransferStats {
    bytesTransferred: number;
    totalSize: number;
    startTime: number;
    lastUpdate: number;
    speedBps: number;
    etaSeconds: number;
    percent: number;
}

export interface FileMetadata {
    type: "metadata";
    fileName: string;
    fileSize: number;
    fileType: string;
    sha256: string;
}
