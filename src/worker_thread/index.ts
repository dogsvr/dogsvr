import { parentPort } from 'worker_threads';
import { log as rootLog } from "./logger";
import { Msg, MsgHeadType, MsgBodyType, HandlerError } from '../common/message';
import { TxnMgr } from "../common/transaction";

const log = rootLog.child({ module: "worker_thread/index" });

export type HandlerRsp =
    | MsgBodyType                                          // body only
    | { body: MsgBodyType, head?: Partial<MsgHeadType> }   // body + head patch
    | void;                                                 // silent drop
export type HandlerType = (reqMsg: Msg) => Promise<HandlerRsp>;
type HandlerMapType = { [key: number]: HandlerType }
const handlerMap: HandlerMapType = {};
const txnMgr: TxnMgr = new TxnMgr(rootLog.child({ module: "worker_thread/txnMgr" }));

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

    await initFn();
    parentPort!.on('message', (msg: Msg) => {
        if (msg.head.clcOptions) {
            let cb = txnMgr.onCallback(msg.head.txnId!);
            if (cb) {
                cb(msg.body);
            } else {
                log.error({ txnId: msg.head.txnId, cmdId: msg.head.cmdId }, "no callback for txnId");
            }
        } else {
            const handler = handlerMap[msg.head.cmdId];
            if (handler) {
                handler(msg)
                    .then((ret) => {
                        if (ret === undefined) return;   // strict undefined check; empty string is a valid body
                        if (typeof ret === 'string' || ret instanceof Uint8Array) {
                            respondCmd(msg, ret);
                        } else {
                            if (ret.head) Object.assign(msg.head, ret.head);
                            respondCmd(msg, ret.body);
                        }
                    })
                    .catch((err) => {
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
                    });
            } else {
                log.error({ cmdId: msg.head.cmdId }, "no handler for cmdId");
            }
        }
    });
}

export function respondCmd(reqMsg: Msg, innerRes: MsgBodyType) {
    reqMsg.body = innerRes;
    parentPort!.postMessage(reqMsg);
}

export function respondError(reqMsg: Msg, errCode: number, errMsg: string) {
    reqMsg.head.errCode = errCode;
    reqMsg.head.errMsg = errMsg;
    reqMsg.body = '';
    parentPort!.postMessage(reqMsg);
}

export function callCmdByClc(clcName: string, msgHead: MsgHeadType, innerReq: MsgBodyType, noResponse?: boolean): Promise<MsgBodyType | null> | void {
    if (noResponse) {
        msgHead.clcOptions = { clcName: clcName, noResponse: true };
        let msg = new Msg(msgHead, innerReq);
        parentPort!.postMessage(msg);
    }
    else {
        return new Promise((resolve, reject) => {
            msgHead.txnId = txnMgr.genNewTxnId();
            msgHead.clcOptions = { clcName: clcName };
            let msg = new Msg(msgHead, innerReq);
            parentPort!.postMessage(msg);
            txnMgr.addTxn(msg.head.txnId!, resolve);
        });
    }
}

export function pushMsgByCl(clName: string, gids: number[], msgHead: MsgHeadType, innerReq: MsgBodyType) {
    msgHead.clOptions = { clName: clName, gids: gids };
    let msg = new Msg(msgHead, innerReq);
    parentPort!.postMessage(msg);
}

export * from "../common/message"
export { loadWorkerThreadConfig, getThreadConfig, WorkerThreadBaseConfig } from "./config"
export { log, registerWorkerLogger } from "./logger";
export type { Log, LoggerImpl, Level } from "../common/logger_types";
