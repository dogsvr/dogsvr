export type ThreadCpuMode = 'schedstat' | 'stat' | 'disabled';

export type ThreadRole = 'main' | 'worker' | 'internal' | 'logger_central';

export interface ThreadCpuSample {
    osTid: number;
    /** Non-null only when role === 'worker'. */
    workerIndex: number | null;
    /** Node.js worker_threads.threadId; matches `thread` in log records. Non-null for 'worker' and registered internal-kind threads. */
    nodeThreadId: number | null;
    role: ThreadRole;
    cpuTimeSec: number;
    /** undefined in stat fallback. */
    cpuWaitSec?: number;
    /** Δrun / Δwall; null on first sample of a tid. */
    cpuUtilization: number | null;
}

export interface ProcessSnapshot {
    threadCount: number;
    rssBytes: number;
    vszBytes: number;
}

export interface ThreadStatsSnapshot {
    samples: readonly ThreadCpuSample[];
    process: ProcessSnapshot;
    readonly sampledAtMs: number;
}

/** Worker → main control message; kept off the business Msg envelope. */
export interface DogsvrCtlMsg {
    __dogsvrCtl: 'tidReport';
    workerIndex: number;
    nodeThreadId: number;
    osTid: number;
}
