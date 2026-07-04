/**
 * Standalone API entry — compiled by build-api.mjs into dist/server/api-entry.js
 * Imported by server.mjs to handle API routes before the SSR handler.
 */
export { handleGenerate, handleAsk, handleStatus, handleDownload, handleCron, handlePatchMissing, handlePatchTTS, handleStop, handleTrack, handleAnalytics, handleLogs, handlePushSubscribe, handlePushUnsubscribe, handlePushSend } from "./lib/api/handlers";
