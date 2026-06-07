import { Worker } from "worker_threads";
import { Msg } from "../common/message";
import { log as rootLog } from "./logger";
import { ServerCore, HotUpdateStrategyConfig } from "./server_core";

const log = rootLog.child({ module: "main_thread/hot_update" });

// ---- Strategy interface ----

export interface IHotUpdateStrategy {
    execute(core: ServerCore): Promise<void>;
}

// ---- Shared drain logic ----

function drainOldWorker(
    oldWorker: Worker, oldIndex: number, timeout: number,
    core: ServerCore
): Promise<void> {
    return new Promise<void>((resolve) => {
        let done = false;

        const finish = (reason: string) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            oldWorker.terminate();
            core.workerPendingTxns.delete(oldWorker);
            log.info({ workerIndex: oldIndex, reason }, "old worker stopped");
            resolve();
        };

        const checkDrained = () => {
            const pending = core.workerPendingTxns.get(oldWorker);
            if (!pending || pending.size === 0) {
                finish("drained gracefully");
            }
        };

        const timer = setTimeout(() => {
            const pending = core.workerPendingTxns.get(oldWorker);
            log.warn(
                { workerIndex: oldIndex, remaining: pending?.size ?? 0 },
                "old worker drain timeout, force terminating"
            );
            finish("timeout");
        }, timeout);

        // Drain-mode handler skips loadBalancer.onMessageResolved to avoid
        // corrupting LB state for new workers at this index.
        oldWorker.removeAllListeners("message");
        oldWorker.on("message", (msg: Msg) => {
            if (msg.head.clcOptions) {
                core.svrCfg.clcMap[msg.head.clcOptions.clcName].callCmd(
                    msg, msg.head.clcOptions.noResponse ? undefined : oldWorker
                );
            } else if (msg.head.clOptions) {
                core.svrCfg.clMap[msg.head.clOptions.clName].pushMsg(msg);
            } else {
                core.workerPendingTxns.get(oldWorker)?.delete(msg.head.txnId!);
                const cb = core.txnMgr.onCallback(msg.head.txnId!);
                if (cb) {
                    cb(msg);
                }
                checkDrained();
            }
        });

        // Maybe already drained
        checkDrained();
    });
}

// ---- Rolling strategy (default) ----

class RollingStrategy implements IHotUpdateStrategy {
    async execute(core: ServerCore): Promise<void> {
        const timeout = core.svrCfg.hotUpdateTimeout ?? 30000;
        const workerCount = core.svrCfg.workerThreadNum;

        for (let i = 0; i < workerCount; i++) {
            const oldWorker = core.workerThreads[i];
            const newWorker = core.createWorker(i);
            core.workerThreads[i] = newWorker;
            core.loadBalancer!.resetIndex(i);

            await drainOldWorker(oldWorker, i, timeout, core);

            log.info({ workerIndex: i, total: workerCount }, "rolling hot update: worker replaced");
        }

        log.info("rolling hot update complete: all workers replaced");
    }
}

// ---- AllAtOnce strategy ----

class AllAtOnceStrategy implements IHotUpdateStrategy {
    async execute(core: ServerCore): Promise<void> {
        const timeout = core.svrCfg.hotUpdateTimeout ?? 30000;
        const oldWorkers = [...core.workerThreads];

        // Create all new workers and replace array
        const newWorkers: Worker[] = [];
        for (let i = 0; i < core.svrCfg.workerThreadNum; i++) {
            newWorkers.push(core.createWorker(i));
        }
        core.workerThreads = newWorkers;
        core.resetLoadBalancer();

        log.info("hot update: new workers serving traffic, old workers draining");

        // Drain old workers in background
        const drainPromises = oldWorkers.map(
            (w, i) => drainOldWorker(w, i, timeout, core)
        );
        Promise.all(drainPromises).then(() => {
            log.info("hot update complete: all old workers terminated");
        });
    }
}

// ---- Factory ----

export function createHotUpdateStrategy(cfg?: HotUpdateStrategyConfig): IHotUpdateStrategy {
    switch (cfg?.strategy) {
        case 'allAtOnce': return new AllAtOnceStrategy();
        case 'rolling':   return new RollingStrategy();
        default:          return new RollingStrategy();
    }
}
