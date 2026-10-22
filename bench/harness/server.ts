import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export interface TargetServer {
  readonly url: string;
  stop(): Promise<void>;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => {
        resolve(port);
      });
    });
  });

/** Starts the compiled service (`dist/main.js`) on a free port and waits until it answers. */
export async function spawnServer(adminKeyHash: string): Promise<TargetServer> {
  if (!existsSync('dist/main.js')) {
    throw new Error('dist/main.js not found; run `pnpm build` first or pass --url');
  }
  const port = await freePort();
  const child: ChildProcess = spawn('node', ['dist/main.js'], {
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name !== 'BENCH_API_KEY'),
      ),
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      ADMIN_API_KEYS: adminKeyHash,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  const state = { exited: false };
  child.once('exit', () => {
    state.exited = true;
  });

  for (let attempt = 0; attempt < 100 && !state.exited; attempt++) {
    try {
      // Any HTTP answer (a 404 here) proves the server is up, without needing the key.
      if ((await fetch(`${url}/readiness-probe`)).status < 500) {
        return {
          url,
          stop: () =>
            new Promise<void>((resolve) => {
              if (state.exited) {
                resolve();
                return;
              }
              child.once('exit', () => {
                resolve();
              });
              child.kill('SIGTERM');
            }),
        };
      }
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('the spawned server did not become ready');
}
