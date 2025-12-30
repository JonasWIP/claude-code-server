#!/usr/bin/env node
/**
 * Claude Code Server API
 *
 * HTTP endpoint to trigger clone -> develop -> test -> commit -> push workflow
 * Protected by JonasHub Supabase authentication (admin-only)
 */

const http = require('http');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.API_PORT || 3100;
const WORKSPACE = process.env.WORKSPACE || '/home/claude/workspace';
const LOG_DIR = path.join(WORKSPACE, '.logs');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Supabase Configuration (JonasHub shared instance)
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://supabase.jonashub.jonasreitz.de';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * Verify JWT token and check if user is admin
 * Returns { valid: boolean, user: object|null, isAdmin: boolean, error: string|null }
 */
async function verifyAuthToken(token) {
    if (!token) {
        return { valid: false, user: null, isAdmin: false, error: 'No token provided' };
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        console.warn('Supabase not configured - authentication disabled');
        return { valid: true, user: null, isAdmin: true, error: null }; // Allow access if not configured
    }

    try {
        // Verify token by getting user from Supabase
        const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'apikey': SUPABASE_SERVICE_KEY
            }
        });

        if (!userResponse.ok) {
            return { valid: false, user: null, isAdmin: false, error: 'Invalid token' };
        }

        const user = await userResponse.json();

        if (!user || !user.id) {
            return { valid: false, user: null, isAdmin: false, error: 'User not found' };
        }

        // Check if user is admin using the is_admin RPC function
        const adminCheckResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_admin`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'apikey': SUPABASE_SERVICE_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ check_user_id: user.id })
        });

        if (!adminCheckResponse.ok) {
            console.error('Admin check failed:', await adminCheckResponse.text());
            return { valid: true, user, isAdmin: false, error: 'Admin check failed' };
        }

        const isAdmin = await adminCheckResponse.json();

        return { valid: true, user, isAdmin: isAdmin === true, error: null };
    } catch (error) {
        console.error('Auth verification error:', error);
        return { valid: false, user: null, isAdmin: false, error: error.message };
    }
}

/**
 * Extract Bearer token from Authorization header
 */
function extractToken(req) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }
    return null;
}

// MIME types for static files
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

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
 * Serve static file
 */
function serveStaticFile(res, filePath) {
    const ext = path.extname(filePath);
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
    });
}

/**
 * Fetch GitHub repositories
 */
async function fetchGitHubRepos() {
    try {
        const result = await execCommand('gh repo list --json name,url,description,updatedAt,isPrivate --limit 100', process.cwd());
        return JSON.parse(result.stdout);
    } catch (error) {
        console.error('Failed to fetch repos:', error.message);
        return [];
    }
}

/**
 * HTTP Request Handler
 */
async function handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const urlPath = url.pathname;
    const method = req.method;

    // CORS headers - allow credentials for auth
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        // Health check - public endpoint
        if (urlPath === '/health' && method === 'GET') {
            sendJson(res, 200, {
                status: 'healthy',
                version: '1.1.0',
                timestamp: new Date().toISOString(),
                activeTasks: activeTasks.size,
                authEnabled: !!(SUPABASE_URL && SUPABASE_SERVICE_KEY)
            });
            return;
        }

        // Auth endpoint - for login
        if (urlPath === '/auth/login' && method === 'POST') {
            const body = await parseBody(req);

            if (!body.email || !body.password) {
                sendJson(res, 400, { error: 'Email and password required' });
                return;
            }

            try {
                const loginResponse = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                    method: 'POST',
                    headers: {
                        'apikey': SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        email: body.email,
                        password: body.password
                    })
                });

                const loginData = await loginResponse.json();

                if (!loginResponse.ok) {
                    sendJson(res, 401, { error: loginData.error_description || loginData.msg || 'Login failed' });
                    return;
                }

                // Check if user is admin
                const authResult = await verifyAuthToken(loginData.access_token);

                if (!authResult.isAdmin) {
                    sendJson(res, 403, { error: 'Admin access required' });
                    return;
                }

                sendJson(res, 200, {
                    access_token: loginData.access_token,
                    refresh_token: loginData.refresh_token,
                    expires_in: loginData.expires_in,
                    user: authResult.user
                });
                return;
            } catch (error) {
                console.error('Login error:', error);
                sendJson(res, 500, { error: 'Login failed' });
                return;
            }
        }

        // Auth check endpoint - verify current session
        if (urlPath === '/auth/check' && method === 'GET') {
            const token = extractToken(req);
            const authResult = await verifyAuthToken(token);

            if (!authResult.valid || !authResult.isAdmin) {
                sendJson(res, 401, { authenticated: false, isAdmin: false });
                return;
            }

            sendJson(res, 200, {
                authenticated: true,
                isAdmin: authResult.isAdmin,
                user: authResult.user
            });
            return;
        }

        // Logout endpoint
        if (urlPath === '/auth/logout' && method === 'POST') {
            const token = extractToken(req);
            if (token) {
                try {
                    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'apikey': SUPABASE_SERVICE_KEY
                        }
                    });
                } catch (e) {
                    // Ignore logout errors
                }
            }
            sendJson(res, 200, { success: true });
            return;
        }

        // Protected endpoints - require admin authentication
        const protectedPaths = ['/repos', '/task', '/tasks', '/api'];
        const isProtectedPath = protectedPaths.some(p => urlPath === p || urlPath.startsWith('/task/'));

        if (isProtectedPath) {
            const token = extractToken(req);
            const authResult = await verifyAuthToken(token);

            if (!authResult.valid) {
                sendJson(res, 401, { error: 'Authentication required', code: 'AUTH_REQUIRED' });
                return;
            }

            if (!authResult.isAdmin) {
                sendJson(res, 403, { error: 'Admin access required', code: 'ADMIN_REQUIRED' });
                return;
            }
        }

        // GitHub repositories list (now protected)
        if (urlPath === '/repos' && method === 'GET') {
            const repos = await fetchGitHubRepos();
            sendJson(res, 200, { repos });
            return;
        }

        // Start new task (now protected)
        if (urlPath === '/task' && method === 'POST') {
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
        if (urlPath.startsWith('/task/') && method === 'GET') {
            const taskId = urlPath.split('/')[2];
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
        if (urlPath === '/tasks' && method === 'GET') {
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
        if (urlPath === '/api' && method === 'GET') {
            sendJson(res, 200, {
                name: 'Claude Code Server API',
                version: '1.0.0',
                endpoints: {
                    'GET /': 'Web Interface',
                    'GET /api': 'This documentation',
                    'GET /health': 'Health check',
                    'GET /repos': 'List GitHub repositories',
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

        // Serve static files (Web Interface)
        if (method === 'GET') {
            let filePath = urlPath === '/' ? '/index.html' : urlPath;
            const fullPath = path.join(PUBLIC_DIR, filePath);

            // Security: prevent directory traversal
            if (!fullPath.startsWith(PUBLIC_DIR)) {
                sendJson(res, 403, { error: 'Forbidden' });
                return;
            }

            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                serveStaticFile(res, fullPath);
                return;
            }
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
