#!/bin/bash
# Kill background jobs on exit
trap "exit" INT TERM
trap "kill 0" EXIT

echo "Starting API Server on port 3000..."
export AGENTIC_DB_PATH="/home/danielp/agefk/agentic-framework/.agentic/db.json"
node packages/server/dist/server.js > .agentic/api.log 2>&1 &
API_PID=$!

echo "Starting UI on port 5173..."
cd packages/ui && npm run dev > ../../.agentic/ui.log 2>&1 &
UI_PID=$!

echo "Services started."
echo "API: http://localhost:3000"
echo "UI:  http://localhost:5173"
echo "Database: $AGENTIC_DB_PATH"
echo "Logs are in .agentic/*.log"
echo "Press Ctrl+C to stop both services."

wait
