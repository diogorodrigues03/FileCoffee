import { useState, useCallback, useRef } from "react";
import { TransferStats } from "@/types/transfer";
import { updateStats } from "@/lib/utils";

export function useFileTransfer(onCancel?: () => void) {
    const [stats, setStats] = useState<TransferStats | null>(null);
    const statsRef = useRef<TransferStats | null>(null);

    const initTransfer = useCallback((size: number) => {
        const initialStats: TransferStats = {
            bytesTransferred: 0,
            totalSize: size,
            startTime: Date.now(),
            lastUpdate: Date.now(),
            speedBps: 0,
            etaSeconds: Infinity,
            percent: 0,
        };
        statsRef.current = initialStats;
        setStats(initialStats);
    }, []);

    const updateTransfer = useCallback((newBytes: number) => {
        if (!statsRef.current) return;
        const updated = updateStats(statsRef.current, newBytes, statsRef.current.totalSize);
        statsRef.current = updated;
        setStats({ ...updated });
    }, []);

    const cancelTransfer = useCallback(() => {
        if (onCancel) {
            onCancel();
        }
        statsRef.current = null;
        setStats(null);
    }, [onCancel]);

    return { stats, statsRef, initTransfer, updateTransfer, cancelTransfer };
}
