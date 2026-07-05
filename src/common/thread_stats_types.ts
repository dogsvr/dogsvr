export type ThreadCpuMode = 'schedstat' | 'stat' | 'disabled';

export type ThreadRole = 'main' | 'worker' | 'internal';

export interface ThreadCpuSample {
    osTid: number;
    /** null for main/internal. */
    workerIndex: number | null;
    /** Node.js worker_threads.threadId; matches `thread` in log records. null for main/internal. */
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
