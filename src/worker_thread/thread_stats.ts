import * as fs from 'node:fs';
import { parentPort, threadId } from 'node:worker_threads';
import type { DogsvrCtlMsg } from '../common/thread_stats_types';

export function getSelfOsTid(): number | null {
    if (process.platform !== 'linux') return null;
    try {
        const target = fs.readlinkSync('/proc/thread-self');
        const slash = target.lastIndexOf('/');
        const tid = Number(slash >= 0 ? target.slice(slash + 1) : target);
        return Number.isFinite(tid) ? tid : null;
    } catch {
        return null;
    }
}

export function reportSelfTidToMain(workerIndex: number): void {
    if (parentPort === null) return;
    const osTid = getSelfOsTid();
    if (osTid === null) return;
    const msg: DogsvrCtlMsg = {
        __dogsvrCtl: 'tidReport',
        workerIndex,
        nodeThreadId: threadId,
        osTid,
    };
    parentPort.postMessage(msg);
}
