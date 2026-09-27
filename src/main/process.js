/**
 * Process Management Module
 * Handles Java process launch, log streaming, crash detection, and clean shutdown.
 */

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');

/**
 * Active process instances
 * @type {Map<string, {process: ChildProcess, emitter: EventEmitter, launchOptions: Object, startTime: number}>}
 */
const activeProcesses = new Map();

/**
 * Log level detection patterns
 * @constant {Array<{pattern: RegExp, level: 'info'|'warn'|'error'}>}
 */
const LOG_LEVEL_PATTERNS = [
  { pattern: /\[.+\/ERROR\]/, level: 'error' },
  { pattern: /\[.+\/FATAL\]/, level: 'error' },
  { pattern: /\[.+\/WARN\]/, level: 'warn' },
  { pattern: /\[.+\/WARNING\]/, level: 'warn' },
  { pattern: /Exception in thread/, level: 'error' },
  { pattern: /Caused by:/, level: 'error' },
  { pattern: /at .+\.java:\d+/, level: 'error' },
  { pattern: /^\[.+\/INFO\]/, level: 'info' },
  { pattern: /^\[.+\/DEBUG\]/, level: 'info' }
];

/**
 * Sensitive data patterns to mask in logs
 * @constant {Array<RegExp>}
 */
const SENSITIVE_PATTERNS = [
  /--accessToken\s+\S+/gi,
  /--authAccessToken\s+\S+/gi,
  /--clientToken\s+\S+/gi,
  /--uuid\s+\S+/gi,
  /--username\s+\S+/gi,
  /"accessToken"\s*:\s*"[^"]+"/gi,
  /"clientToken"\s*:\s*"[^"]+"/gi,
  /"access_token"\s*:\s*"[^"]+"/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g // JWT tokens
];

/**
 * Mask sensitive data in a log line
 * @param {string} line - Log line to sanitize
 * @returns {string} Sanitized log line
 */
function maskSensitiveData(line) {
  let sanitized = line;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      // Keep the parameter name but mask the value
      if (match.includes('=')) {
        const [key] = match.split('=');
        return `${key}=[MASKED]`;
      }
      if (match.includes(':')) {
        const [key] = match.split(':');
        return `${key}: "[MASKED]"`;
      }
      return '[MASKED]';
    });
  }
  return sanitized;
}

/**
 * Detect log level from a log line
 * @param {string} line - Log line
 * @returns {'info'|'warn'|'error'} Detected log level
 */
function detectLogLevel(line) {
  for (const { pattern, level } of LOG_LEVEL_PATTERNS) {
    if (pattern.test(line)) {
      return level;
    }
  }
  return 'info';
}

/**
 * Create a sanitized copy of launch options for logging
 * @param {Object} launchOptions - Original launch options
 * @returns {Object} Sanitized launch options
 */
function sanitizeLaunchOptions(launchOptions) {
  const sanitized = { ...launchOptions };

  // Mask JVM args that might contain tokens
  if (Array.isArray(sanitized.jvmArgs)) {
    sanitized.jvmArgs = sanitized.jvmArgs.map(arg => {
      for (const pattern of SENSITIVE_PATTERNS) {
        if (pattern.test(arg)) {
          return arg.replace(pattern, '[MASKED]');
        }
      }
      return arg;
    });
  }

  // Mask game args that might contain tokens
  if (Array.isArray(sanitized.gameArgs)) {
    sanitized.gameArgs = sanitized.gameArgs.map(arg => {
      for (const pattern of SENSITIVE_PATTERNS) {
        if (pattern.test(arg)) {
          return arg.replace(pattern, '[MASKED]');
        }
      }
      return arg;
    });
  }

  // Remove any explicit token fields
  delete sanitized.accessToken;
  delete sanitized.clientToken;
  delete sanitized.authAccessToken;
  delete sanitized.authClientToken;

  return sanitized;
}

/**
 * Generate a unique instance ID
 * @returns {string} Unique instance ID
 */
function generateInstanceId() {
  return `mc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Build the Java command arguments array
 * @param {Object} launchOptions - Launch options
 * @returns {Array<string>} Command arguments
 */
function buildJavaArgs(launchOptions) {
  const args = [];

  // JVM args
  if (launchOptions.jvmArgs && Array.isArray(launchOptions.jvmArgs)) {
    args.push(...launchOptions.jvmArgs);
  }

  // Memory settings
  if (launchOptions.ramMin) {
    args.push(`-Xms${launchOptions.ramMin}`);
  }
  if (launchOptions.ramMax) {
    args.push(`-Xmx${launchOptions.ramMax}`);
  }

  // Classpath
  if (launchOptions.classpath) {
    args.push('-cp', launchOptions.classpath);
  }

  // Main class
  if (launchOptions.mainClass) {
    args.push(launchOptions.mainClass);
  }

  // Game args
  if (launchOptions.gameArgs && Array.isArray(launchOptions.gameArgs)) {
    args.push(...launchOptions.gameArgs);
  }

  return args;
}

/**
 * Launch a Minecraft Java process
 * @param {Object} launchOptions - Launch options
 * @param {string} launchOptions.javaPath - Path to java executable
 * @param {string} launchOptions.classpath - Classpath string
 * @param {string[]} launchOptions.jvmArgs - JVM arguments
 * @param {string[]} launchOptions.gameArgs - Game arguments
 * @param {string} launchOptions.mainClass - Main class to launch
 * @param {string} launchOptions.cwd - Working directory
 * @param {string} launchOptions.ramMin - Minimum RAM (e.g., "512M")
 * @param {string} launchOptions.ramMax - Maximum RAM (e.g., "2G")
 * @returns {EventEmitter} Event emitter for process events
 */
function launchProcess(launchOptions) {
  const emitter = new EventEmitter();
  const instanceId = generateInstanceId();

  // Validate required options
  if (!launchOptions.javaPath || !launchOptions.mainClass) {
    process.nextTick(() => {
      emitter.emit('crashed', {
        exitCode: -1,
        lastLogLines: ['Missing required launch options: javaPath and mainClass are required'],
        error: 'Invalid launch options'
      });
    });
    return emitter;
  }

  // Build command arguments (using array to prevent shell injection)
  const javaArgs = buildJavaArgs(launchOptions);

  // Sanitize for logging
  const sanitizedOptions = sanitizeLaunchOptions(launchOptions);

  console.log('[Process] Starting Minecraft instance:', {
    instanceId,
    javaPath: launchOptions.javaPath,
    mainClass: launchOptions.mainClass,
    cwd: launchOptions.cwd,
    ramMin: launchOptions.ramMin,
    ramMax: launchOptions.ramMax,
    jvmArgsCount: launchOptions.jvmArgs?.length || 0,
    gameArgsCount: launchOptions.gameArgs?.length || 0
  });

  // Emit starting event
  emitter.emit('starting', {
    instanceId,
    javaPath: launchOptions.javaPath,
    mainClass: launchOptions.mainClass,
    cwd: launchOptions.cwd,
    timestamp: new Date().toISOString()
  });

  // Spawn the Java process (NO shell, array args for security)
  const childProcess = spawn(launchOptions.javaPath, javaArgs, {
    cwd: launchOptions.cwd || process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored, stdout/stderr piped
    env: {
      ...process.env,
      // Ensure consistent encoding
      JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8'
    }
  });

  let hasEmittedRunning = false;
  let lastLogLines = [];
  const MAX_LOG_LINES = 50;

  // Track stdout
  let stdoutBuffer = '';
  childProcess.stdout.on('data', (data) => {
    stdoutBuffer += data.toString('utf8');

    // Process complete lines
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      // Skip empty lines
      if (!line.trim()) continue;

      // Sanitize sensitive data
      const sanitizedLine = maskSensitiveData(line);

      // Detect log level
      const level = detectLogLevel(sanitizedLine);

      // Keep last N lines for crash reporting
      lastLogLines.push({ line: sanitizedLine, level, timestamp: new Date().toISOString() });
      if (lastLogLines.length > MAX_LOG_LINES) {
        lastLogLines.shift();
      }

      // Emit log event (MVP requirement: EVERY line goes to UI)
      emitter.emit('log', {
        line: sanitizedLine,
        level,
        timestamp: new Date().toISOString(),
        instanceId
      });

      // Emit 'running' on first meaningful log output
      if (!hasEmittedRunning && sanitizedLine.trim().length > 0) {
        hasEmittedRunning = true;
        emitter.emit('running', {
          instanceId,
          timestamp: new Date().toISOString()
        });
      }
    }
  });

  // Track stderr
  let stderrBuffer = '';
  childProcess.stderr.on('data', (data) => {
    stderrBuffer += data.toString('utf8');

    let newlineIndex;
    while ((newlineIndex = stderrBuffer.indexOf('\n')) !== -1) {
      const line = stderrBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      stderrBuffer = stderrBuffer.slice(newlineIndex + 1);

      if (!line.trim()) continue;

      const sanitizedLine = maskSensitiveData(line);
      const level = detectLogLevel(sanitizedLine);

      lastLogLines.push({ line: sanitizedLine, level, timestamp: new Date().toISOString() });
      if (lastLogLines.length > MAX_LOG_LINES) {
        lastLogLines.shift();
      }

      emitter.emit('log', {
        line: sanitizedLine,
        level,
        timestamp: new Date().toISOString(),
        instanceId
      });

      if (!hasEmittedRunning && sanitizedLine.trim().length > 0) {
        hasEmittedRunning = true;
        emitter.emit('running', {
          instanceId,
          timestamp: new Date().toISOString()
        });
      }
    }
  });

  // Process exit handling
  childProcess.on('close', (exitCode) => {
    console.log(`[Process] Instance ${instanceId} exited with code ${exitCode}`);

    // Process any remaining buffered output
    if (stdoutBuffer.trim()) {
      const sanitizedLine = maskSensitiveData(stdoutBuffer.trim());
      const level = detectLogLevel(sanitizedLine);
      lastLogLines.push({ line: sanitizedLine, level, timestamp: new Date().toISOString() });
      emitter.emit('log', { line: sanitizedLine, level, timestamp: new Date().toISOString(), instanceId });
    }
    if (stderrBuffer.trim()) {
      const sanitizedLine = maskSensitiveData(stderrBuffer.trim());
      const level = detectLogLevel(sanitizedLine);
      lastLogLines.push({ line: sanitizedLine, level, timestamp: new Date().toISOString() });
      emitter.emit('log', { line: sanitizedLine, level, timestamp: new Date().toISOString(), instanceId });
    }

    if (exitCode === 0) {
      emitter.emit('closed', {
        instanceId,
        exitCode,
        timestamp: new Date().toISOString()
      });
    } else {
      emitter.emit('crashed', {
        instanceId,
        exitCode,
        lastLogLines: lastLogLines.map(l => l.line),
        timestamp: new Date().toISOString()
      });
    }

    // Clean up
    activeProcesses.delete(instanceId);
  });

  // Error handling (spawn errors)
  childProcess.on('error', (error) => {
    console.error(`[Process] Instance ${instanceId} spawn error:`, error.message);

    emitter.emit('crashed', {
      instanceId,
      exitCode: -1,
      lastLogLines: [`Spawn error: ${error.message}`],
      error: error.message,
      timestamp: new Date().toISOString()
    });

    activeProcesses.delete(instanceId);
  });

  // Attach instance ID to emitter for reference
  emitter.instanceId = instanceId;

  // Store process reference
  activeProcesses.set(instanceId, {
    process: childProcess,
    emitter,
    launchOptions: sanitizedOptions,
    startTime: Date.now()
  });

  return emitter;
}

/**
 * Stop a running Minecraft process gracefully
 * @param {string} instanceId - Instance ID to stop
 * @param {number} [timeoutMs=10000] - Timeout before force kill
 * @returns {Promise<boolean>} True if stopped successfully
 */
function stopProcess(instanceId, timeoutMs = 10000) {
  const instance = activeProcesses.get(instanceId);

  if (!instance) {
    console.warn(`[Process] Instance ${instanceId} not found`);
    return Promise.resolve(false);
  }

  const { process: childProcess, emitter } = instance;

  console.log(`[Process] Stopping instance ${instanceId}...`);

  return new Promise((resolve) => {
    let forceKilled = false;
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        activeProcesses.delete(instanceId);
        resolve(!forceKilled);
      }
    };

    // Try graceful shutdown first (SIGTERM equivalent on Windows)
    if (process.platform === 'win32') {
      // On Windows, use taskkill /T to kill process tree
      try {
        // First try Ctrl-Break equivalent for graceful shutdown
        // Send CTRL_BREAK_EVENT to the process group
        process.kill(-childProcess.pid, 'SIGTERM');
      } catch (e) {
        // Process might already be dead
      }
    } else {
      childProcess.kill('SIGTERM');
    }

    // Set timeout for force kill
    const forceKillTimeout = setTimeout(() => {
      if (!childProcess.killed) {
        console.log(`[Process] Force killing instance ${instanceId} after ${timeoutMs}ms`);
        forceKilled = true;

        if (process.platform === 'win32') {
          // Use taskkill to ensure child processes are also killed.
          // execFile statt execSync mit Template-String: die PID kommt so als
          // eigenes Argument und nicht als Teil eines Shell-Befehls daher.
          execFile('taskkill', ['/PID', String(childProcess.pid), '/T', '/F'], { windowsHide: true },
            () => { /* egal ob geklappt — der Timeout-Pfad ist nur die Notlösung */ });
        } else {
          childProcess.kill('SIGKILL');
        }
      }
    }, timeoutMs);

    // Wait for process to exit
    childProcess.on('close', () => {
      clearTimeout(forceKillTimeout);
      cleanup();
    });

    // Also handle case where process already exited
    if (childProcess.killed || childProcess.exitCode !== null) {
      clearTimeout(forceKillTimeout);
      cleanup();
    }
  });
}

/**
 * Get list of active process instances
 * @returns {Array<Object>} List of active instances
 */
function getActiveProcesses() {
  const instances = [];
  for (const [id, { launchOptions, startTime }] of activeProcesses) {
    instances.push({
      instanceId: id,
      mainClass: launchOptions.mainClass,
      cwd: launchOptions.cwd,
      ramMin: launchOptions.ramMin,
      ramMax: launchOptions.ramMax,
      startTime,
      uptime: Date.now() - startTime
    });
  }
  return instances;
}

/**
 * Stop all active processes
 * @returns {Promise<void>}
 */
async function stopAllProcesses() {
  const instanceIds = Array.from(activeProcesses.keys());
  await Promise.all(instanceIds.map(id => stopProcess(id)));
}

module.exports = {
  launchProcess,
  stopProcess,
  stopAllProcesses,
  getActiveProcesses,
  maskSensitiveData,
  detectLogLevel,
  sanitizeLaunchOptions
};