#!/usr/bin/env node
/**
 * Claude Code Server API
 *
 * HTTP endpoint to trigger clone -> develop -> test -> commit -> push workflow
 */

const http = require('http');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.API_PORT || 3100;
const WORKSPACE = process.env.WORKSPACE || '/home/claude/workspace';
const LOG_DIR = path.join(WORKSPACE, '.logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Active tasks storage
const activeTasks = new Map();

/**
 * Generate unique task ID
 */
function generateTaskId() {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get repository name from URL
 */
function getRepoName(url) {
    return path.basename(url, '.git').toLowerCase();
}

/**
 * Execute command and return promise
 */
function execCommand(cmd, cwd, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', ['-c', cmd], {
            cwd,
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr, code });
            } else {
                reject({ stdout, stderr, code, message: `Command failed with code ${code}` });
            }
        });

        child.on('error', (err) => {
            reject({ message: err.message, stdout, stderr });
        });
    });
}

/**
 * Main workflow executor
 */
async function executeWorkflow(taskId, config) {
    const task = activeTasks.get(taskId);
    const logFile = path.join(LOG_DIR, `${taskId}.log`);
    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        fs.appendFileSync(logFile, line);
        task.logs.push(line.trim());
    };

    const repoName = getRepoName(config.repo);
    const repoDir = path.join(WORKSPACE, repoName);

    try {
        // Step 1: Clone or update repository
        task.status = 'cloning';
        task.step = 'Clone/Update Repository';
        log(`Step 1: Cloning/updating ${config.repo}`);

        if (fs.existsSync(path.join(repoDir, '.git'))) {
            log('Repository exists, fetching updates...');
            await execCommand('git fetch --all && git reset --hard origin/' + (config.branch || 'main'), repoDir);
            log('Repository updated');
        } else {
            log('Cloning repository...');
            await execCommand(`git clone ${config.repo} ${repoDir}`, WORKSPACE);
            log('Repository cloned');
        }

        // Step 2: Checkout branch
        task.status = 'checkout';
        task.step = 'Checkout Branch';
        const branch = config.branch || 'main';
        log(`Step 2: Checking out branch ${branch}`);

        if (config.createBranch) {
            try {
                await execCommand(`git checkout -b ${branch}`, repoDir);
                log(`Created and checked out new branch: ${branch}`);
            } catch (e) {
                await execCommand(`git checkout ${branch}`, repoDir);
                log(`Checked out existing branch: ${branch}`);
            }
        } else {
            await execCommand(`git checkout ${branch} 2>/dev/null || git checkout -b ${branch} origin/${branch}`, repoDir);
            log(`Checked out branch: ${branch}`);
        }

        // Step 3: Run Claude Code task
        task.status = 'developing';
        task.step = 'Running Claude Code';
        log(`Step 3: Running Claude Code with task: ${config.task}`);

        const claudeCmd = `cd ${repoDir} && echo "${config.task.replace(/"/g, '\\"')}" | claude --print --dangerously-skip-permissions`;
        const claudeResult = await execCommand(claudeCmd, repoDir);
        task.claudeOutput = claudeResult.stdout;
        log('Claude Code completed');
        log(`Output: ${claudeResult.stdout.substring(0, 500)}...`);

        // Step 4: Run tests (if specified)
        if (config.testCommand) {
            task.status = 'testing';
            task.step = 'Running Tests';
            log(`Step 4: Running tests: ${config.testCommand}`);

            try {
                const testResult = await execCommand(config.testCommand, repoDir);
                task.testOutput = testResult.stdout;
                log('Tests passed');
            } catch (testError) {
                task.testOutput = testError.stdout + '\n' + testError.stderr;
                log(`Tests failed: ${testError.message}`);
                if (!config.commitOnTestFailure) {
                    throw new Error('Tests failed, aborting commit');
                }
                log('Continuing despite test failure (commitOnTestFailure=true)');
            }
        } else {
            log('Step 4: No test command specified, skipping tests');
        }

        // Step 5: Check for changes
        task.status = 'committing';
        task.step = 'Committing Changes';
        log('Step 5: Checking for changes...');

        const statusResult = await execCommand('git status --porcelain', repoDir);
        if (!statusResult.stdout.trim()) {
            log('No changes to commit');
            task.status = 'completed';
            task.step = 'Completed (no changes)';
            task.result = {
                success: true,
                message: 'Task completed but no changes were made',
                commit: null
            };
            return;
        }

        // Step 6: Commit changes
        log('Changes detected, committing...');
        const commitMessage = config.commitMessage || `feat: ${config.task.substring(0, 50)}

Automated by Claude Code Server

Task: ${config.task}

🤖 Generated with Claude Code`;

        await execCommand('git add -A', repoDir);
        await execCommand(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, repoDir);

        const commitHash = execSync('git rev-parse --short HEAD', { cwd: repoDir }).toString().trim();
        log(`Committed: ${commitHash}`);

        // Step 7: Push changes
        task.status = 'pushing';
        task.step = 'Pushing to Remote';
        log(`Step 6: Pushing to origin/${branch}`);

        await execCommand(`git push -u origin ${branch}`, repoDir);
        log('Push successful');

        // Complete
        task.status = 'completed';
        task.step = 'Completed';
        task.result = {
            success: true,
            message: 'Workflow completed successfully',
            commit: commitHash,
            branch: branch,
            repo: repoName
        };
        log('Workflow completed successfully');

    } catch (error) {
        task.status = 'failed';
        task.step = 'Failed';
        task.error = error.message || String(error);
        log(`Error: ${task.error}`);
        task.result = {
            success: false,
            message: task.error,
            stdout: error.stdout,
            stderr: error.stderr
        };
    }
}

/**
 * Parse JSON body from request
 */
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Send JSON response
 */
function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
}

/**
 * HTTP Request Handler
 */
async function handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        // Health check
        if (path === '/health' && method === 'GET') {
            sendJson(res, 200, {
                status: 'healthy',
                version: '1.0.0',
                timestamp: new Date().toISOString(),
                activeTasks: activeTasks.size
            });
            return;
        }

        // Start new task
        if (path === '/task' && method === 'POST') {
            const body = await parseBody(req);

            // Validate required fields
            if (!body.repo) {
                sendJson(res, 400, { error: 'Missing required field: repo' });
                return;
            }
            if (!body.task) {
                sendJson(res, 400, { error: 'Missing required field: task' });
                return;
            }

            const taskId = generateTaskId();
            const task = {
                id: taskId,
                status: 'queued',
                step: 'Initializing',
                config: body,
                logs: [],
                createdAt: new Date().toISOString(),
                claudeOutput: null,
                testOutput: null,
                result: null,
                error: null
            };

            activeTasks.set(taskId, task);

            // Start workflow asynchronously
            executeWorkflow(taskId, body);

            sendJson(res, 202, {
                taskId,
                status: 'queued',
                message: 'Task started',
                statusUrl: `/task/${taskId}`
            });
            return;
        }

        // Get task status
        if (path.startsWith('/task/') && method === 'GET') {
            const taskId = path.split('/')[2];
            const task = activeTasks.get(taskId);

            if (!task) {
                sendJson(res, 404, { error: 'Task not found' });
                return;
            }

            sendJson(res, 200, {
                id: task.id,
                status: task.status,
                step: task.step,
                createdAt: task.createdAt,
                logs: task.logs,
                claudeOutput: task.claudeOutput,
                testOutput: task.testOutput,
                result: task.result,
                error: task.error
            });
            return;
        }

        // List all tasks
        if (path === '/tasks' && method === 'GET') {
            const tasks = Array.from(activeTasks.values()).map(t => ({
                id: t.id,
                status: t.status,
                step: t.step,
                repo: getRepoName(t.config.repo),
                createdAt: t.createdAt
            }));
            sendJson(res, 200, { tasks });
            return;
        }

        // API documentation
        if (path === '/' && method === 'GET') {
            sendJson(res, 200, {
                name: 'Claude Code Server API',
                version: '1.0.0',
                endpoints: {
                    'GET /': 'This documentation',
                    'GET /health': 'Health check',
                    'POST /task': 'Start new task',
                    'GET /task/:id': 'Get task status',
                    'GET /tasks': 'List all tasks'
                },
                taskSchema: {
                    repo: '(required) Git repository URL',
                    task: '(required) Task description for Claude Code',
                    branch: '(optional) Branch name, default: main',
                    createBranch: '(optional) Create new branch if true',
                    testCommand: '(optional) Command to run tests',
                    commitMessage: '(optional) Custom commit message',
                    commitOnTestFailure: '(optional) Commit even if tests fail'
                },
                example: {
                    repo: 'https://github.com/user/repo.git',
                    task: 'Add a README.md file with project documentation',
                    branch: 'feature/readme',
                    createBranch: true,
                    testCommand: 'npm test'
                }
            });
            return;
        }

        // 404 for unknown routes
        sendJson(res, 404, { error: 'Not found' });

    } catch (error) {
        console.error('Request error:', error);
        sendJson(res, 500, { error: error.message });
    }
}

// Create and start server
const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           Claude Code Server API                           ║
╠════════════════════════════════════════════════════════════╣
║  Server running on http://0.0.0.0:${PORT}                    ║
║                                                            ║
║  Endpoints:                                                ║
║    GET  /          - API documentation                     ║
║    GET  /health    - Health check                          ║
║    POST /task      - Start new task                        ║
║    GET  /task/:id  - Get task status                       ║
║    GET  /tasks     - List all tasks                        ║
╚════════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down...');
    server.close(() => {
        process.exit(0);
    });
});
