#!/bin/sh
# Boot the server in a throwaway HOME, wait for it, run the driver, and exit
# with the driver's verdict. Everything lives under /work, gone with the container.
set -eu
export HOME=/work/home
export AGENFK_DB_PATH=/work/agenfk.sqlite
mkdir -p "$HOME/.agenfk"
# git reads its identity from HOME, which is the throwaway one now.
git config --global user.email harness@agenfk.test
git config --global user.name "AgEnFK harness"
git config --global init.defaultBranch main
# No outbound telemetry from a test run.
echo '{"telemetry":false}' > "$HOME/.agenfk/config.json"
# The token the server and the CLI share for verify (the installer writes it on a real machine).
node -e "process.stdout.write(require('crypto').randomUUID())" > "$HOME/.agenfk/verify-token"
node /agenfk/packages/server/dist/server.js > /work/server.log 2>&1 &
SERVER=$!
i=0
until [ -s "$HOME/.agenfk/server-port" ] && node -e "fetch('http://127.0.0.1:'+require('fs').readFileSync(process.env.HOME+'/.agenfk/server-port','utf8').trim()+'/projects').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; do
  i=$((i+1))
  if [ "$i" -gt 60 ] || ! kill -0 "$SERVER" 2>/dev/null; then
    echo "The server did not come up. Its log:" >&2
    cat /work/server.log >&2
    exit 2
  fi
  sleep 0.5
done
status=0
node /agenfk/e2e/tdd-harness/driver/run.mjs "$@" || status=$?
if [ "$status" -ne 0 ]; then echo "--- server log (tail) ---" >&2; tail -40 /work/server.log >&2; fi
kill "$SERVER" 2>/dev/null || true
exit "$status"
