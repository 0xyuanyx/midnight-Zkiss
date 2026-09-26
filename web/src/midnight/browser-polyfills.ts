import process from 'process';
import { Buffer } from 'buffer';
// Browser-only compatibility objects. No server environment is injected.
const globals = globalThis as unknown as Record<string, unknown>;
globals.process ??= process;
globals.Buffer ??= Buffer;
