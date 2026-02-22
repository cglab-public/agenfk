#!/usr/bin/env node
import http from 'http';

const API_URL = process.env.AGENFK_API_URL || 'http://127.0.0.1:3000';

// Drain stdin
process.stdin.on('data', () => {});

async function checkInProgress() {
    return new Promise((resolve) => {
        const req = http.get(`${API_URL}/items?status=IN_PROGRESS`, { timeout: 2000 }, (res) => {
            if (res.statusCode !== 200) {
                resolve(true); // Graceful skip
                return;
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const items = JSON.parse(data);
                    if (Array.isArray(items) && items.length > 0) {
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                } catch (e) {
                    resolve(true); // Graceful skip on parse error
                }
            });
        });

        req.on('error', () => resolve(true)); // Graceful skip on connection error
        req.on('timeout', () => {
            req.destroy();
            resolve(true);
        });
    });
}

const hasInProgress = await checkInProgress();

if (!hasInProgress) {
    process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: 'AgenFK WORKFLOW VIOLATION: No task is IN_PROGRESS.\n\nBefore modifying files you must:\n  1. Create a task:  agenfk create task "<title>"\n  2. Start it:       agenfk update <id> --status IN_PROGRESS\n\nThen retry your change.'
    }));
}

process.exit(0);
