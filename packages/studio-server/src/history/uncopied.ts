import { extname } from "node:path";

const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
  ".mxf",
  ".mts",
  ".m2ts",
  ".ts",
  ".mp3",
  ".wav",
  ".aac",
  ".m4a",
  ".flac",
  ".ogg",
  ".opus",
]);
const COPY_NOTHING_ABOVE_BYTES = 64 * 1024 ** 2;

/** Video, audio and any file over 64 MiB are hashed in place, never copied into history: restoring one is not offered. */
export const isUncopied = (path: string, size: number): boolean =>
  size > COPY_NOTHING_ABOVE_BYTES || MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
