import { parentPort, workerData } from 'worker_threads';
import { log as rootLog } from "./logger";
import { getSpanSink } from "./tracing";
import { getWorkerMetricSink, safeCall } from "./metrics";
import { reportSelfTidToMain } from "./thread_stats";
import { Msg, MsgHeadType, MsgBodyType, HandlerError } from '../common/message';
import { TxnMgr } from "../common/transaction";
import type { SpanCtx, SpanHandle } from "../common/tracing_types";
import { WorkerMsgSabChannel } from "./msg_sab_channel";

const log = rootLog.child({ module: "worker_thread/index" });

export type HandlerRsp =
    | MsgBodyType                                          // body only
    | { body: MsgBodyType, head?: Partial<MsgHeadType> }   // body + head patch
    | void;                                                 // silent drop
export type HandlerType = (reqMsg: Msg) => Promise<HandlerRsp>;
type HandlerMapType = { [key: number]: HandlerType }
const handlerMap: HandlerMapType = {};
const txnMgr: TxnMgr = new TxnMgr(rootLog.child({ module: "worker_thread/txnMgr" }));

interface MsgChannelWorkerCfg {
    transport: 'sab' | 'postMessage';
    fallbackOnFull: boolean;
    waitOnFullMs: number;
}

let msgChannel: WorkerMsgSabChannel | null = null;
let msgChannelCfg: MsgChannelWorkerCfg = { transport: 'postMessage', fallbackOnFull: true, waitOnFullMs: 1 };

function sendToMain(msg: Msg): void {
    if (msgChannel === null) {
        parentPort!.postMessage(msg);
        return;
    }
    if (msgChannel.send(msg)) return;
    msgChannel.recordFallback();
    if (msgChannelCfg.fallbackOnFull) {
        parentPort!.postMessage(msg);
    } else {
        log.error({ cmdId: msg.head.cmdId, txnId: msg.head.txnId ?? 0 }, "SAB full, fallback disabled, msg dropped");
    }
}

export function getWorkerMsgChannelStats(): { sabHits: number; fallbackHits: number } | null {
    return msgChannel ? msgChannel.getStats() : null;
}

export function regCmdHandler(cmdId: number, handler: HandlerType) {
    if (handlerMap[cmdId]) {
        log.error({ cmdId }, "handler for cmdId already exists");
        return;
    }
    handlerMap[cmdId] = handler;
}

export async function workerReady(initFn: () => Promise<void>) {
    process.on('unhandledRejection', (err) => {
        log.error({ err }, "unhandledRejection");
    });
    process.on('uncaughtException', (err) => {
        log.error({ err }, "uncaughtException");
    });

    const workerIndex = typeof workerData?.workerIndex === 'number' ? workerData.workerIndex : -1;
    if (workerIndex >= 0) reportSelfTidToMain(workerIndex);

    const cfgRaw = workerData?.msgChannel as Partial<MsgChannelWorkerCfg> | undefined;
    msgChannelCfg = {
        transport: cfgRaw?.transport ?? 'postMessage',
        fallbackOnFull: cfgRaw?.fallbackOnFull ?? true,
        waitOnFullMs: cfgRaw?.waitOnFullMs ?? 1,
    };
    const sabIn = workerData?.msgSabIn as SharedArrayBuffer | undefined;
    const sabOut = workerData?.msgSabOut as SharedArrayBuffer | undefined;
    if (msgChannelCfg.transport === 'sab' && sabIn && sabOut) {
        msgChannel = new WorkerMsgSabChannel(sabIn, sabOut);
        msgChannel.setDispatch(handleIncoming);
        msgChannel.start();
    }

    await initFn();
    // Skip parentPort data-path listener when SAB is sole transport (no postMessage fallback path).
    if (msgChannelCfg.transport === 'postMessage' || msgChannelCfg.fallbackOnFull) {
        parentPort!.on('message', (msg: Msg) => {
            handleIncoming(msg);
        });
    }
}

function handleIncoming(msg: Msg): void {
    if (msg.head.clcOptions) {
        let cb = txnMgr.onCallback(msg.head.txnId!);
        if (cb) {
            cb(msg.body);
        } else {
            log.error({ txnId: msg.head.txnId, cmdId: msg.head.cmdId }, "no callback for txnId");
        }
        return;
    }
    const handler = handlerMap[msg.head.cmdId];
    if (!handler) {
        log.error({ cmdId: msg.head.cmdId }, "no handler for cmdId");
        return;
    }
    const sink = getSpanSink();
    let parentCtx: SpanCtx | null = null;
    let span: SpanHandle | null = null;
    safeCall("SpanSink.extract", () => {
        parentCtx = msg.head._otel ? sink.extract(msg.head._otel) : null;
    });
    safeCall("SpanSink.start", () => {
        span = sink.start(`worker.${msg.head.cmdId}`, parentCtx, {
            'rpc.cmd_id': msg.head.cmdId,
        });
    });
    const metricSink = getWorkerMetricSink();
    const txnIdForMetric = msg.head.txnId ?? -1;
    safeCall("WorkerMetricSink.onCmdHdlStart", () =>
        metricSink.onCmdHdlStart(txnIdForMetric, msg.head.cmdId));
    let ok = false;
    const runHandler = () => handler(msg)
        .then((ret) => {
            ok = true;
            if (ret === undefined) return;
            if (typeof ret === 'string' || ret instanceof Uint8Array) {
                respondCmd(msg, ret);
            } else {
                if (ret.head) Object.assign(msg.head, ret.head);
                respondCmd(msg, ret.body);
            }
        })
        .catch((err) => {
            safeCall("SpanSink.recordException", () => span?.recordException(err));
            if (err instanceof HandlerError) {
                respondError(msg, err.code, err.msg);
                return;
            }
            log.error({
                err,
                cmdId: msg.head.cmdId,
                openId: msg.head.openId ?? '',
                gid: msg.head.gid ?? 0,
                txnId: msg.head.txnId ?? 0,
            }, "handler exception");
            respondError(msg, -1, `Handler exception: ${err}`);
        })
        .finally(() => {
            safeCall("SpanSink.end", () => span?.end(ok));
            safeCall("WorkerMetricSink.onCmdHdlEnd", () =>
                metricSink.onCmdHdlEnd(txnIdForMetric, msg.head.cmdId, ok));
        });
    if (span !== null) {
        try {
            sink.withActive(span, runHandler);
        } catch (err) {
            log.error({ err }, "SpanSink.withActive threw; running handler without active span");
            runHandler();
        }
    } else {
        runHandler();
    }
}

export function respondCmd(reqMsg: Msg, innerRes: MsgBodyType) {
    reqMsg.body = innerRes;
    sendToMain(reqMsg);
}

export function respondError(reqMsg: Msg, errCode: number, errMsg: string) {
    reqMsg.head.errCode = errCode;
    reqMsg.head.errMsg = errMsg;
    reqMsg.body = '';
    sendToMain(reqMsg);
}

export function callCmdByClc(clcName: string, msgHead: MsgHeadType, innerReq: MsgBodyType, noResponse?: boolean): Promise<MsgBodyType | null> | void {
    if (noResponse) {
        msgHead.clcOptions = { clcName: clcName, noResponse: true };
        let msg = new Msg(msgHead, innerReq);
        sendToMain(msg);
    }
    else {
        return new Promise((resolve, reject) => {
            msgHead.txnId = txnMgr.genNewTxnId();
            msgHead.clcOptions = { clcName: clcName };
            let msg = new Msg(msgHead, innerReq);
            sendToMain(msg);
            txnMgr.addTxn(msg.head.txnId!, resolve);
        });
    }
}

export function pushMsgByCl(clName: string, gids: number[], msgHead: MsgHeadType, innerReq: MsgBodyType) {
    msgHead.clOptions = { clName: clName, gids: gids };
    let msg = new Msg(msgHead, innerReq);
    sendToMain(msg);
}

export * from "../common/message"
export { loadWorkerThreadConfig, getThreadConfig, WorkerThreadBaseConfig } from "./config"
export { log, registerWorkerLogger } from "./logger";
export type { Log, LoggerImpl } from "../common/logger_types";
export { setSpanSink, getSpanSink } from "./tracing";
export type { SpanSink, SpanCtx, SpanHandle } from "../common/tracing_types";
export { setWorkerMetricSink, getWorkerMetricSink, type WorkerMetricSink } from "./metrics";
export { onShutdown } from "../common/shutdown";
