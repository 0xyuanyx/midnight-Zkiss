import process from 'process';
import { Buffer } from 'buffer';
// SCALE decoder dependency uses Node's Buffer global in its browser build.
(globalThis as typeof globalThis & {Buffer:typeof Buffer}).Buffer??=Buffer;

(globalThis as any).process??=process;
