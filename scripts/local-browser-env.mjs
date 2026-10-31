import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const local = fileURLToPath(new URL('../.browser-deps/usr/lib/x86_64-linux-gnu', import.meta.url));
if (existsSync(local)) process.env.LD_LIBRARY_PATH = [local, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
