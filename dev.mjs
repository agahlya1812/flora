import { spawn } from 'node:child_process';

const apiUrl = 'http://localhost:3001/api/todos';
const processes = [];

async function isApiAlreadyRunning() {
  try {
    const response = await fetch(apiUrl);
    return response.ok;
  } catch {
    return false;
  }
}

if (await isApiAlreadyRunning()) {
  console.log('JSON API already running on http://localhost:3001');
} else {
  processes.push(spawn('node', ['--no-warnings', 'server.mjs'], { stdio: 'inherit' }));
}

processes.push(
  spawn(process.platform === 'win32' ? 'vite.cmd' : 'vite', ['--host', '0.0.0.0'], {
    stdio: 'inherit',
  }),
);

function stopAll(signal) {
  for (const child of processes) {
    child.kill(signal);
  }
}

for (const child of processes) {
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      stopAll('SIGTERM');
      process.exit(code);
    }
  });
}

process.on('SIGINT', () => {
  stopAll('SIGINT');
});

process.on('SIGTERM', () => {
  stopAll('SIGTERM');
});
