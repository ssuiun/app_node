const { spawn } = require('child_process');
const http = require('http');
const assert = require('assert');

const busyServer = http.createServer(() => {});

busyServer.listen(3000, () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: '3000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', data => {
    output += data.toString();
  });
  child.stderr.on('data', data => {
    output += data.toString();
  });

  setTimeout(() => {
    child.kill('SIGTERM');
    busyServer.close(() => {
      try {
        assert.match(output, /Server listening on http:\/\/0\.0\.0\.0:3001/);
        console.log('port fallback test: PASS');
      } catch (err) {
        console.error(output);
        console.error(err.message);
        process.exit(1);
      }
    });
  }, 2000);
});
