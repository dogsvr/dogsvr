import { hotUpdate } from './index';
import { log as rootLog } from "./logger";

const log = rootLog.child({ module: "main_thread/pm2" });

// Expose `hotUpdate` as a pm2 action (pm2 trigger <name> hotUpdate).
//
// Wire protocol (undocumented but stable pm2 axm convention):
//  - Announce: { type: 'axm:action', data: { action_name, arity } } via IPC on startup.
//  - pm2 delivers the plain string action_name as an IPC message on trigger.
//  - Reply: { type: 'axm:reply', data: { action_name, return } } to unblock the CLI.
//
// Uses native IPC (process.send / process.on('message')) instead of tx2 — tx2 1.0.5
// is incompatible with TypeScript 6's __importStar expansion of its singleton default export.

const HOT_UPDATE_ACTION = 'hotUpdate';

if (process.send) {
    process.send({
        type: 'axm:action',
        data: { action_name: HOT_UPDATE_ACTION, arity: 0 },
    });
    log.info({ action: HOT_UPDATE_ACTION }, "pm2 action registered");
}

process.on('message', async (msg: unknown) => {
    if (msg !== HOT_UPDATE_ACTION) {
        return;
    }
    try {
        await hotUpdate();
        process.send?.({
            type: 'axm:reply',
            data: { action_name: HOT_UPDATE_ACTION, return: 'hotUpdate done' },
        });
    } catch (e: unknown) {
        log.error({ err: e }, "hotUpdate failed");
        const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
        process.send?.({
            type: 'axm:reply',
            data: {
                action_name: HOT_UPDATE_ACTION,
                return: `hotUpdate failed: ${detail}`,
            },
        });
    }
});
