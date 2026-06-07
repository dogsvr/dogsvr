import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { log as rootLog } from "./logger";

const log = rootLog.child({ module: "env_info" });

/**
 * Read this package's own package.json at runtime so we can log our version
 * without a TypeScript-level JSON import (keeps resolveJsonModule off).
 */
function readOwnPackageJson(): { name?: string; version?: string } {
    try {
        const pkgPath = path.join(__dirname, "..", "..", "package.json");
        return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
        return {};
    }
}

/**
 * Log a one-shot summary of the runtime environment. Intended to be called
 * once at server start-up so that operators can tell — from the log alone —
 * which Node.js / dogsvr version and which host the process was bound to.
 */
export function logEnvInfo(): void {
    const pkg = readOwnPackageJson();

    log.info({
        dogsvr: `${pkg.name ?? "@dogsvr/dogsvr"}@${pkg.version ?? "unknown"}`,
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        cpus: os.cpus().length,
        hostname: os.hostname(),
        os: `${os.type()} ${os.release()}`,
        cwd: process.cwd(),
        execPath: process.execPath,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, "env info");
}
