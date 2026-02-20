#!/usr/bin/env node
import fs from 'fs';
import { execSync } from 'child_process';
import axios from 'axios';

const commitMsgFile = process.argv[2];
if (!commitMsgFile) {
  process.exit(0);
}

const commitMsg = fs.readFileSync(commitMsgFile, 'utf8');
const API_URL = process.env.AGENTIC_API_URL || "http://localhost:3000";

// Pattern to find task ID (8 chars or more hex/uuid)
const idPattern = /[a-f0-9]{8,}/i;

async function run() {
  if (idPattern.test(commitMsg)) {
    console.log('✅ Found Task ID in commit message.');
    process.exit(0);
  }

  console.log('⚠️ No Task ID found in commit message. Attempting to auto-generate task...');

  try {
    // 1. Get changed files for context
    const diff = execSync('git diff --cached --name-only').toString().trim();
    
    // 2. Create an automatic task via the API
    const response = await axios.post(`${API_URL}/items`, {
      type: "TASK",
      title: `Auto-generated: Change in ${diff.split('\n')[0]}`,
      description: `Automatically created task for code changes in:\n${diff}`,
      status: "DONE" // Mark as done since the commit is happening
    });

    const taskId = response.data.id;
    const shortId = taskId.substring(0, 8);

    // 3. Append the ID to the commit message
    const newMsg = `${commitMsg}\n\nAGENTIC-TASK: ${taskId}`;
    fs.writeFileSync(commitMsgFile, newMsg);

    console.log(`✅ Auto-created Task ${shortId} and linked to commit.`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to link Agentic Task. Ensure the API server is running on port 3000.');
    console.error('Commit aborted to enforce workflow.');
    process.exit(1);
  }
}

run();
