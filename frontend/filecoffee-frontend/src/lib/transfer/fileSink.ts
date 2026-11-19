/**
 * Where a received file is written while it streams in, so memory use does
 * not grow with the file size.
 *
 * 1. `showSaveFilePicker` (Chromium): straight to the place the user picked.
 * 2. Origin Private File System (Firefox, Safari): a disk-backed temp file,
 *    offered as a download link at the end.
 * 3. Memory: last resort for browsers with neither.
 *
 * Every download URL handed out is `application/octet-stream`, never the
 * sender's MIME type: a `blob:` URL has this app's origin, so an HTML or SVG
 * file opened in a tab would otherwise run as part of FileCoffee.
 */

export const SAFE_MIME_TYPE = "application/octet-stream";

export type FileSinkKind = "disk" | "opfs" | "memory";

export interface FileSink {
    readonly kind: FileSinkKind;
    write(chunk: ArrayBuffer): Promise<void>;
    /** Commits the file. Returns a download URL, or null if it is already saved where the user chose. */
    close(): Promise<string | null>;
    /** Discards whatever was written. Safe to call more than once. */
    abort(): Promise<void>;
}

/** The user dismissed the save dialog. */
export class SaveCancelledError extends Error {
    constructor() {
        super("Save cancelled");
    }
}

// Not in TypeScript's DOM lib yet.
type ShowSaveFilePicker = (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
interface WritableFileHandle extends FileSystemFileHandle {
    createWritable(): Promise<FileSystemWritableFileStream>;
}

const OPFS_PREFIX = "filecoffee-transfer-";
const OPFS_STALE_MS = 60 * 60 * 1000;

/**
 * Must be called straight from a click handler, before any other `await`:
 * the save picker needs the click's user activation.
 */
export async function openFileSink(fileName: string): Promise<FileSink> {
    const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker })
        .showSaveFilePicker;
    if (picker) {
        let handle: FileSystemFileHandle | null = null;
        try {
            handle = await picker({ suggestedName: fileName });
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                throw new SaveCancelledError();
            }
            // e.g. SecurityError inside a cross-origin iframe: use the next option.
            console.warn("Save picker unavailable, falling back:", error);
        }
        if (handle) {
            return new DiskSink(await (handle as WritableFileHandle).createWritable());
        }
    }

    try {
        return await OpfsSink.open();
    } catch (error) {
        console.warn("OPFS unavailable, buffering the file in memory:", error);
        return new MemorySink();
    }
}

class DiskSink implements FileSink {
    readonly kind = "disk";
    private closed = false;

    constructor(private readonly writable: FileSystemWritableFileStream) {}

    write(chunk: ArrayBuffer) {
        return this.writable.write(chunk);
    }

    async close() {
        this.closed = true;
        await this.writable.close();
        return null;
    }

    async abort() {
        if (this.closed) return;
        this.closed = true;
        // Chromium writes to a swap file and only replaces the target on
        // close(), so aborting leaves nothing half-written behind.
        await this.writable.abort().catch(() => {});
    }
}

class OpfsSink implements FileSink {
    readonly kind = "opfs";
    private closed = false;

    private constructor(
        private readonly root: FileSystemDirectoryHandle,
        private readonly name: string,
        private readonly handle: FileSystemFileHandle,
        private readonly writable: FileSystemWritableFileStream
    ) {}

    static async open() {
        const root = await navigator.storage.getDirectory();
        await removeStaleOpfsFiles(root);
        const name = `${OPFS_PREFIX}${crypto.randomUUID()}`;
        const handle = await root.getFileHandle(name, { create: true });
        try {
            const writable = await (handle as WritableFileHandle).createWritable();
            return new OpfsSink(root, name, handle, writable);
        } catch (error) {
            await root.removeEntry(name).catch(() => {});
            throw error;
        }
    }

    write(chunk: ArrayBuffer) {
        return this.writable.write(chunk);
    }

    async close() {
        this.closed = true;
        await this.writable.close();
        const file = await this.handle.getFile();
        // slice() keeps the result disk-backed and lets us override the type.
        return URL.createObjectURL(file.slice(0, file.size, SAFE_MIME_TYPE));
    }

    async abort() {
        if (this.closed) return;
        this.closed = true;
        await this.writable.abort().catch(() => {});
        await this.root.removeEntry(this.name).catch(() => {});
    }
}

/**
 * OPFS files outlive the page, so finished transfers from earlier visits are
 * removed here. Recent files are kept in case another tab still links to one;
 * files another tab is still writing are locked and fail to delete, which is fine.
 */
async function removeStaleOpfsFiles(root: FileSystemDirectoryHandle) {
    const entries = (root as unknown as { keys(): AsyncIterable<string> }).keys();
    for await (const name of entries) {
        if (!name.startsWith(OPFS_PREFIX)) continue;
        try {
            const file = await (await root.getFileHandle(name)).getFile();
            if (Date.now() - file.lastModified > OPFS_STALE_MS) {
                await root.removeEntry(name);
            }
        } catch {
            // In use or already gone.
        }
    }
}

class MemorySink implements FileSink {
    readonly kind = "memory";
    private chunks: ArrayBuffer[] = [];

    async write(chunk: ArrayBuffer) {
        this.chunks.push(chunk);
    }

    async close() {
        const blob = new Blob(this.chunks, { type: SAFE_MIME_TYPE });
        this.chunks = [];
        return URL.createObjectURL(blob);
    }

    async abort() {
        this.chunks = [];
    }
}

const MAX_FILE_NAME_LENGTH = 200;

/**
 * The file name comes from the other peer, so treat it as hostile: keep only
 * the last path component, drop control and bidi characters (which can
 * disguise an extension, e.g. "invoice\u202Efdp.exe"), replace characters
 * Windows rejects, and cap the length while keeping a short extension.
 */
export function sanitizeFileName(raw: unknown): string {
    let name = typeof raw === "string" ? raw.normalize("NFC") : "";
    name = name.split(/[/\\]/).pop() ?? "";
    // eslint-disable-next-line no-control-regex
    name = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
    name = name.replace(/[<>:"|?*]/g, "_");
    // No leading dots (hidden files, "..") and no trailing dots/spaces (Windows).
    name = name.trim().replace(/^\.+/, "").replace(/[. ]+$/, "");

    const chars = Array.from(name); // code points, so we never split a surrogate pair
    if (chars.length > MAX_FILE_NAME_LENGTH) {
        const dot = name.lastIndexOf(".");
        const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
        const extLength = Array.from(ext).length;
        name = chars.slice(0, MAX_FILE_NAME_LENGTH - extLength).join("") + ext;
    }

    return name || "download";
}
