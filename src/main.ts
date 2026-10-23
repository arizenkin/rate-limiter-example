import { startApp } from './bootstrap/app';

startApp(process.env).then(
  (app) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => void app.stop().then(() => process.exit(0)));
    }
  },
  (error: unknown) => {
    console.error(`Startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
