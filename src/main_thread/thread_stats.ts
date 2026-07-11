import * as fs from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type {
    ThreadCpuMode,
    ThreadCpuSample,
    ThreadRole,
    ProcessSnapshot,
    ThreadStatsSnapshot,
} from '../common/thread_stats_types';

const PROC_ROOT = '/proc';
const NS_PER_SEC = 1_000_000_000;
// USER_HZ (unit of utime/stime in /proc); 100 on Linux x86_64/aarch64, independent of kernel CONFIG_HZ.
const CLK_TCK = 100;

interface PrevState {
    runNs: bigint;
    waitNs: bigint | null;
    wallNs: bigint;
}

interface WorkerIds {
    workerIndex: number;
    nodeThreadId: number;
}

type InternalKind = Exclude<ThreadRole, 'main' | 'worker' | 'internal'>;

interface InternalThreadInfo {
    kind: InternalKind;
    nodeThreadId: number | null;
}

const internalThreads = new Map<number, InternalThreadInfo>();

/** Register an internal (non-business-worker) thread so the sampler can classify it by kind. */
export function registerInternalThread(kind: InternalKind, osTid: number, nodeThreadId: number | null): void {
    internalThreads.set(osTid, { kind, nodeThreadId });
}

export function unregisterInternalThread(osTid: number): void {
    internalThreads.delete(osTid);
}

export class ThreadCpuSampler {
    private readonly pid: number = process.pid;
    private mode: ThreadCpuMode | null = null;
    private readonly workerToTid = new Map<number, number>();
    private readonly tidToIds = new Map<number, WorkerIds>();
    private readonly prev = new Map<number, PrevState>();
    private mainOsTid: number | null = null;
    private schedstatWarnEmitted = false;
    private cached: ThreadStatsSnapshot | null = null;
    private timer: NodeJS.Timeout | null = null;
    private inFlight: Promise<ThreadStatsSnapshot> | null = null;
    private onSampleError: ((err: unknown) => void) | null = null;

    /** Register a worker's OS tid. Overwrites any prior mapping (hot-update replace). */
    registerWorkerTid(workerIndex: number, nodeThreadId: number, osTid: number): void {
        const oldTid = this.workerToTid.get(workerIndex);
        if (oldTid !== undefined && oldTid !== osTid) {
            this.tidToIds.delete(oldTid);
            this.prev.delete(oldTid);
        }
        this.workerToTid.set(workerIndex, osTid);
        this.tidToIds.set(osTid, { workerIndex, nodeThreadId });
    }

    unregister(workerIndex: number): void {
        const tid = this.workerToTid.get(workerIndex);
        if (tid !== undefined) {
            this.tidToIds.delete(tid);
            this.prev.delete(tid);
        }
        this.workerToTid.delete(workerIndex);
    }

    getMode(): ThreadCpuMode {
        if (this.mode === null) this.mode = this.detectMode();
        return this.mode;
    }

    getSnapshot(): ThreadStatsSnapshot | null {
        return this.cached;
    }

    /** Idempotent; second call replaces the timer. onErr swallows sample() rejections. */
    start(intervalMs: number, onErr?: (err: unknown) => void): void {
        this.stop();
        this.onSampleError = onErr ?? null;
        this.tick();
        this.timer = setInterval(() => this.tick(), intervalMs);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private tick(): void {
        this.sample()
            .then((snap) => { this.cached = snap; })
            .catch((err) => { this.onSampleError?.(err); });
    }

    async sample(): Promise<ThreadStatsSnapshot> {
        // Coalesce concurrent callers to avoid prev-map read-modify-write races.
        if (this.inFlight !== null) return this.inFlight;
        const p = this.doSample();
        this.inFlight = p;
        try {
            return await p;
        } finally {
            this.inFlight = null;
        }
    }

    private async doSample(): Promise<ThreadStatsSnapshot> {
        if (this.getMode() === 'disabled') {
            return { samples: [], process: { threadCount: 0, rssBytes: 0, vszBytes: 0 }, sampledAtMs: nowMs() };
        }
        const [tids, proc] = await Promise.all([
            this.listTids(),
            this.readProcStatus(),
        ]);
        // Reap prev state for exited tids to avoid negative deltas on tid reuse.
        const alive = new Set(tids);
        for (const tid of this.prev.keys()) {
            if (!alive.has(tid)) this.prev.delete(tid);
        }
        for (const tid of internalThreads.keys()) {
            if (!alive.has(tid)) internalThreads.delete(tid);
        }
        const nowNs = process.hrtime.bigint();
        const results = await Promise.all(tids.map(t => this.readOneTid(t, nowNs).catch(() => null)));
        const samples: ThreadCpuSample[] = [];
        for (const s of results) if (s) samples.push(s);
        return { samples, process: proc, sampledAtMs: nowMs() };
    }

    private detectMode(): ThreadCpuMode {
        if (process.platform !== 'linux') return 'disabled';
        try {
            if (!fs.existsSync(path.join(PROC_ROOT, 'self', 'task'))) return 'disabled';
        } catch { return 'disabled'; }
        try {
            const raw = fs.readFileSync('/proc/sys/kernel/sched_schedstats', 'utf8').trim();
            if (raw === '1') return 'schedstat';
        } catch { /* fallthrough to stat */ }
        if (!this.schedstatWarnEmitted) {
            this.schedstatWarnEmitted = true;
            process.emitWarning(
                'sched_schedstats disabled: falling back to /proc/[tid]/stat (10ms precision, no wait time). ' +
                'Enable with: sysctl -w kernel.sched_schedstats=1',
                'DogsvrThreadStatsWarning',
            );
        }
        return 'stat';
    }

    private async listTids(): Promise<number[]> {
        try {
            const entries = await readdir(path.join(PROC_ROOT, String(this.pid), 'task'));
            const out: number[] = [];
            for (const e of entries) {
                const n = Number(e);
                if (Number.isFinite(n)) out.push(n);
            }
            return out;
        } catch {
            return [];
        }
    }

    private async readProcStatus(): Promise<ProcessSnapshot> {
        try {
            const raw = await readFile(path.join(PROC_ROOT, String(this.pid), 'status'), 'utf8');
            let threadCount = 0;
            let rssKb = 0;
            let vszKb = 0;
            for (const line of raw.split('\n')) {
                if (line.startsWith('Threads:')) threadCount = Number(line.slice(8).trim()) | 0;
                else if (line.startsWith('VmRSS:')) rssKb = parseKvKb(line);
                else if (line.startsWith('VmSize:')) vszKb = parseKvKb(line);
            }
            return { threadCount, rssBytes: rssKb * 1024, vszBytes: vszKb * 1024 };
        } catch {
            return { threadCount: 0, rssBytes: 0, vszBytes: 0 };
        }
    }

    private async readOneTid(tid: number, nowNs: bigint): Promise<ThreadCpuSample | null> {
        const mode = this.mode!;
        let runNs: bigint;
        let waitNs: bigint | null;
        if (mode === 'schedstat') {
            const raw = await readFile(path.join(PROC_ROOT, String(this.pid), 'task', String(tid), 'schedstat'), 'utf8');
            const parts = raw.trim().split(/\s+/);
            if (parts.length < 2) return null;
            runNs = BigInt(parts[0]);
            waitNs = BigInt(parts[1]);
        } else {
            const raw = await readFile(path.join(PROC_ROOT, String(this.pid), 'task', String(tid), 'stat'), 'utf8');
            const rp = parseStatUtimeStime(raw);
            if (rp === null) return null;
            const clkTicks = rp.utime + rp.stime;
            runNs = (BigInt(clkTicks) * BigInt(NS_PER_SEC)) / BigInt(CLK_TCK);
            waitNs = null;
        }
        const prev = this.prev.get(tid);
        this.prev.set(tid, { runNs, waitNs, wallNs: nowNs });
        let utilization: number | null = null;
        if (prev) {
            const dRun = Number(runNs - prev.runNs);
            const dWall = Number(nowNs - prev.wallNs);
            if (dWall > 0) utilization = Math.max(0, dRun) / dWall;
        }
        const ids = this.tidToIds.get(tid);
        const internal = ids ? undefined : internalThreads.get(tid);
        const workerIndex = ids?.workerIndex ?? null;
        const nodeThreadId = ids?.nodeThreadId ?? internal?.nodeThreadId ?? null;
        const role = this.classifyRole(tid, workerIndex, internal);
        const sample: ThreadCpuSample = {
            osTid: tid,
            workerIndex,
            nodeThreadId,
            role,
            cpuTimeSec: Number(runNs) / NS_PER_SEC,
            cpuUtilization: utilization,
        };
        if (waitNs !== null) sample.cpuWaitSec = Number(waitNs) / NS_PER_SEC;
        return sample;
    }

    private classifyRole(tid: number, workerIndex: number | null, internal: InternalThreadInfo | undefined): ThreadRole {
        if (workerIndex !== null) return 'worker';
        if (internal) return internal.kind;
        // First unregistered tid we see is the main thread (tgid == pid on Linux).
        if (this.mainOsTid === null && tid === this.pid) this.mainOsTid = tid;
        if (tid === this.mainOsTid || tid === this.pid) return 'main';
        return 'internal';
    }
}

function parseKvKb(line: string): number {
    const m = line.match(/(\d+)\s*kB/);
    return m ? Number(m[1]) : 0;
}

function nowMs(): number {
    return Date.now();
}

function parseStatUtimeStime(raw: string): { utime: number; stime: number } | null {
    // Format: pid (comm) state ppid ...; comm may contain spaces & parens, so skip past the last ')'.
    const rp = raw.lastIndexOf(')');
    if (rp < 0) return null;
    const rest = raw.slice(rp + 1).trim().split(/\s+/);
    if (rest.length < 13) return null;
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return { utime, stime };
}
