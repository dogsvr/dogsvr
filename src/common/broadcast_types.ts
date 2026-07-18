/**
 * Main → worker broadcast envelope.
 * `type` uses `feature.action` namespacing (e.g. `profile.start`, `profile.stop`).
 */
export interface DogsvrBroadcastMsg {
    __dogsvrBroadcast: true;
    type: string;
    payload?: unknown;
}
