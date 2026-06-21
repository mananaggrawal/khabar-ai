/**
 * Shared abort flag — lets the admin stop endpoint interrupt
 * in-progress generation/TTS without killing the process.
 */

let _abortRequested = false;

export function requestAbort(): void {
  _abortRequested = true;
}

export function resetAbort(): void {
  _abortRequested = false;
}

export function isAbortRequested(): boolean {
  return _abortRequested;
}
