#!/bin/bash
# Resets the LOCAL database, seeds two made-up users, starts the local Worker and runs the browser test.
cd /home/claude/splittrip-api; export CI=1
pkill -f "wrangler dev" 2>/dev/null; sleep 1
rm -rf .wrangler
npx wrangler d1 migrations apply splittrip --local 2>&1 | grep -E "ERROR" 
npx wrangler d1 execute splittrip --local --file /tmp/seed-web.sql 2>&1 | grep -E "ERROR"
npx wrangler d1 execute splittrip --local --file /tmp/seed-web2.sql 2>&1 | grep -E "ERROR"
(nohup npx wrangler dev --local --port 8787 > /tmp/wrangler-dev.log 2>&1 &)
for i in $(seq 1 30); do curl -s localhost:8787/me >/dev/null && break; sleep 1; done
cd /home/claude && timeout 300 python3 scripts/web_test.py 2>&1 | grep -v '^"'
pkill -f "wrangler dev" 2>/dev/null
