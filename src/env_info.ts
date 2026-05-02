import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { infoLog } from "./logger";

/**
 * Read this package's own package.json at runtime so we can log our version
 * without a TypeScript-level JSON import (keeps resolveJsonModule off).
 *
 * When compiled, this file lives at `dist/env_info.js`, so `package.json`
 * is one directory up. During `ts-node` / source execution the file is
 * at `src/env_info.ts`, so the package.json is also one directory up.
 */
function readOwnPackageJson(): { name?: string; version?: string } {
    try {
        const pkgPath = path.join(__dirname, "..", "package.json");
        return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
        return {};
    }
}

/**
 * Log a one-shot summary of the runtime environment. Intended to be called
 * once at server start-up so that operators can tell — from the log alone —
 * which Node.js / dogsvr version and which host the process was bound to.
 *
 * Only invariants that hold for the entire process lifetime belong here.
 * Dynamic metrics (memory, load, connection count) are out of scope — those
 * should be sampled by a monitoring system, not dumped once at t=0.
 */
export function logEnvInfo(): void {
    const pkg = readOwnPackageJson();

    infoLog(
        `env info|dogsvr:${pkg.name ?? "@dogsvr/dogsvr"}@${pkg.version ?? "unknown"}`
        + `|node:${process.version}`
        + `|v8:${process.versions.v8}`
        + `|platform:${process.platform}`
        + `|arch:${process.arch}`
        + `|pid:${process.pid}`
        + `|cpus:${os.cpus().length}`
        + `|hostname:${os.hostname()}`
        + `|os:${os.type()} ${os.release()}`
        + `|cwd:${process.cwd()}`
        + `|execPath:${process.execPath}`
        + `|tz:${Intl.DateTimeFormat().resolvedOptions().timeZone}`
    );
}
