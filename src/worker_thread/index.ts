import { parentPort } from 'worker_threads';
import { errorLog } from '../logger';
import { Msg, MsgHeadType, MsgBodyType } from '../message';
import { TxnMgr } from "../transaction";

export type HandlerType = (reqMsg: Msg, innerReq: MsgBodyType) => Promise<void>;
type HandlerMapType = { [key: number]: HandlerType }
const handlerMap: HandlerMapType = {};
const txnMgr: TxnMgr = new TxnMgr();

export function regCmdHandler(cmdId: number, handler: HandlerType) {
    if (handlerMap[cmdId]) {
        errorLog(`Handler for cmdId ${cmdId} already exists`);
        return;
    }
    handlerMap[cmdId] = handler;
}

export async function workerReady(initFn: () => Promise<void>) {
    process.on('unhandledRejection', (err) => {
        errorLog('unhandledRejection|err:', err);
    });
    process.on('uncaughtException', (err) => {
        errorLog('uncaughtException|err:', err);
    });

    await initFn();
    parentPort!.on('message', (msg: Msg) => {
        if (msg.head.clcOptions) {
            let cb = txnMgr.onCallback(msg.head.txnId!);
            if (cb) {
                cb(msg.body);
            } else {
                errorLog(`No callback for txnId ${msg.head.txnId}|${msg.head.cmdId}`);
            }
        } else {
            const handler = handlerMap[msg.head.cmdId];
            if (handler) {
                handler(msg, msg.body).catch((err) => {
                    errorLog(`Handler exception|cmdId:${msg.head.cmdId}|openId:${msg.head.openId ?? ''}|gid:${msg.head.gid ?? 0}|txnId:${msg.head.txnId ?? 0}|err:`, err);
                    respondError(msg, -1, `Handler exception: ${err}`);
                });
            } else {
                errorLog(`No handler for cmdId ${msg.head.cmdId}`);
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

export * from "../message"
export * from "../logger"
