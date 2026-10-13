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

  // Der Eintrag fuer activeProcesses. Er wird VOR den Ereignisbehandlern
  // angelegt, weil die Behandler ueber die Variable darauf zugreifen. Ein
  // blosses `activeProcesses.get(instanceId)` waere nicht dasselbe: sobald
  // jemand stoppt, loescht der Aufrufer den Eintrag, und genau dann, wenn
  // die close-Behandlung gebraucht wird, ist er schon weg. Die Reihenfolge
  // der close-Handler zu bemuehen waere noch schlechter — sie haengt
  // davon ab, in welcher Reihenfolge sich jemand mal registriert hat.
  const eintrag = {
    process: childProcess,
    emitter,
    launchOptions: sanitizedOptions,
    startTime: Date.now(),
    // Wurde von aussen "beendet" verlangt? Dann ist der Exit-Code kein
    // Absturz, sondern die Antwort auf unsere eigene Anfrage. Ohne dieses
    // Merkmal meldet JEDES regulaere Beenden einen Absturz: Minecraft beendet
    // sich nicht mit 0, wenn man ihm ein Abschicktsignal gibt, also landet
    // jeder normale Feierabend unten im Zweig "abgestuerzt" — und die
    // Oberflaeche schreibt dann "Minecraft ist abgestuerzt" und darunter die
    // letzten 15 Log-Zeilen als Fehler, unter anderem, dass das Spiel noch
    // lief. Siehe die close-Behandlung weiter unten.
    stopRequested: false
  };

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

    // Ein von aussen verlangtes Beenden ist kein Absturz, gleichgueltig welchen
    // Exit-Code das Betriebssystem gerade fuer die Abschickung zurueckgibt.
    // Beide Zweige melden deshalb 'closed'; der Exit-Code wandert als Hinweis
    // mit, damit man ihn im Protokoll nachschlagen kann.
    //
    // Wichtig ist, dass hier NICHT allein der Exit-Code entscheidet. Wer das
    // Spiel ueber "Beenden" schliesst, bekommt unter Windows praktisch nie
    // die 0 zurueck — und sieht deshalb nach jedem normalen Feierabend ein
    // Absturzwindow, das die letzten Log-Zeilen als Fehlerliste ausgibt. In
    // diesem Protokoll steht dann unter anderem, dass das Spiel gerade
    // sauber lief: ein Absturz, den man selbst veranlasst hat.
    const gewollt = eintrag.stopRequested;

    if (exitCode === 0 || gewollt) {
      emitter.emit('closed', {
        instanceId,
        exitCode,
        // Ausdruecklich mitgeben, damit der Aufrufer unterscheiden kann, ob
        // das Spiel sich selbst beendet hat oder abgeraeumt wurde.
        gewollt,
        timestamp: new Date().toISOString()
      });
    } else {
      emitter.emit('crashed', {
        instanceId,
        exitCode,
        gewollt: false,
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
  activeProcesses.set(instanceId, eintrag);

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

  // VOR dem ersten Signal an den Prozess. Das close-Ereignis kann in
  // derselben Tick-Runde kommen, in der hier gesendet wird; ein Merkmal,
  // das erst danach gesetzt wuerde, käme zu spät.
  instance.stopRequested = true;

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

    // Der erste Versuch: dem Kind Prozess direkt ein SIGTERM geben. Das ist auf
    // BEIDEN Plattformen derselbe Aufruf — und es ist der einzige, der
    // tatsaechlich etwas bewirkt.
    //
    // Vorher stand hier unter Windows `process.kill(-pid, 'SIGTERM')` und der
    // funktionierende Aufruf im `else`, also ausserhalb von Windows. Das ist
    // auf Windows nie gelaufen: Windows kennt keine Prozessgruppen, die
    // negative PID findet dort nichts, und der Wurf (ESRCH) wurde
    // weggeschluckt. Gemessen: `process.kill(-pid)` wirft ESRCH, mit und ohne
    // `detached: true`. Es bliebe also gar kein erster Versuch uebrig — der
    // Aufruf wartete den ganzen Timeout ab und riss dann per `taskkill /F`
    // den Prozessbaum weg. Jedes "Beenden" kostete die vollen 10 Sekunden.
    //
    // Was "sanft" auf Windows bedeutet: gar nichts. SIGTERM kennt Windows
    // nicht, Node setzt dort ein TerminateProcess. Das Spiel speichert also
    // auch beim ersten Versuch nicht — es gibt schlicht keine Gelegenheit
    // dafür. Der Unterschied ist der: der erste Versuch beendet genau die JVM,
    // ohne auf die Sekunde zu warten, und `taskkill /T /F` bleibt als
    // Notloesung fuer die Kindprozesse stehen, die Windows sonst zurücklässt.
    try {
      childProcess.kill('SIGTERM');
    } catch (e) {
      // Prozess koennte schon weg sein. Dann ist nichts zu tun — der
      // close-Handler meldet es ohnehin gleich.
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