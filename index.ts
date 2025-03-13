(() => {
  const { argv } = process;

  // Static imports for critical dependencies
  const path = require("node:path") as typeof import("node:path");
  const fs = require("node:fs") as typeof import("node:fs");

  // Import Logger directly
  const { Logger } = require("./logger") as typeof import("./logger");
  const logger = new Logger("Main");

  // Result type definition for command executions
  type ExecutionResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
  };

  // Interface for execution providers
  interface ExecutionProvider {
    execute(command: string, args: string[]): Promise<ExecutionResult>;
    name: string;
  }

  // Bun execution provider with optimized execution
  class BunExecutionProvider implements ExecutionProvider {
    private execFn: typeof import("bun").$ | null = null;
    name = "Bun";

    constructor() {
      this.initialize().catch((err) =>
        logger.warn(
          `Bun provider initialization failed silently: ${err.message}`,
        ),
      );
    }

    private async initialize(): Promise<void> {
      try {
        const bun = await import("bun");
        this.execFn = bun.$;
        logger.info("Bun execution provider initialized");
      } catch (error) {
        logger.error("Failed to initialize Bun execution provider:", error);
      }
    }

    async execute(command: string, args: string[]): Promise<ExecutionResult> {
      if (!this.execFn) {
        throw new Error("Bun execution function not available");
      }

      try {
        const cmdStr = `${command} ${args.join(" ")}`;
        logger.debug(`Executing with Bun: ${cmdStr}`);

        const result = await this.execFn`${cmdStr}`;
        return {
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
          exitCode: result.exitCode,
        };
      } catch (error) {
        logger.error(
          `Bun execution error: ${error instanceof Error ? error.message : "Unknown Error"}`,
          error,
        );
        return {
          stdout: "",
          stderr: error instanceof Error ? error.message : "Unknown error",
          exitCode: 1,
        };
      }
    }
  }

  // Node execution provider (fallback) with optimized buffer handling
  class NodeExecutionProvider implements ExecutionProvider {
    name = "Node";
    private childProcess: typeof import("node:child_process") | null = null;

    constructor() {
      // Preload child_process module to avoid latency during first execution
      import("node:child_process")
        .then((cp) => {
          this.childProcess = cp;
          logger.debug("Node child_process module preloaded");
        })
        .catch((err) => logger.warn("Failed to preload child_process:", err));
    }

    async execute(command: string, args: string[]): Promise<ExecutionResult> {
      logger.debug(`Executing with Node: ${command} ${args.join(" ")}`);

      // If preloaded module is not available, import it now
      const cp = this.childProcess || (await import("node:child_process"));

      return new Promise((resolve, reject) => {
        try {
          const proc = cp.spawn(command, args);
          const stdoutChunks: Buffer[] = [];
          const stderrChunks: Buffer[] = [];

          // Use Buffer arrays for more efficient memory management
          proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
          proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

          // Handle errors
          proc.on("error", (err) => {
            reject(new Error(`Failed to spawn process: ${err.message}`));
          });

          proc.on("close", (exitCode) => {
            resolve({
              stdout: Buffer.concat(stdoutChunks).toString(),
              stderr: Buffer.concat(stderrChunks).toString(),
              exitCode: exitCode ?? 1,
            });
          });
        } catch (error) {
          reject(error);
        }
      });
    }
  }

  // Execution service to manage providers with better provider selection
  class ExecutionService {
    private providers: ExecutionProvider[] = [];
    private selectedProvider: ExecutionProvider | null = null;
    private initialized = false;

    constructor() {
      // Register providers in order of preference
      this.providers.push(new BunExecutionProvider());
      this.providers.push(new NodeExecutionProvider());
      logger.debug(`Registered ${this.providers.length} execution providers`);
    }

    async initialize(): Promise<void> {
      if (this.initialized) return;

      // Select the first available provider
      const testResults = await Promise.allSettled(
        this.providers.map(async (provider) => {
          try {
            logger.debug(`Testing provider: ${provider.name}`);
            await provider.execute("echo", ["test"]);
            return provider;
          } catch (error) {
            logger.warn(`Provider ${provider.name} not available: ${error}`);
            throw error;
          }
        }),
      );

      // Find the first successful provider
      const successfulProvider = testResults.find(
        (result) => result.status === "fulfilled",
      ) as PromiseFulfilledResult<ExecutionProvider> | undefined;

      if (successfulProvider) {
        this.selectedProvider = successfulProvider.value;
        logger.info(`Using ${this.selectedProvider.name} execution provider`);
        this.initialized = true;
      } else {
        throw new Error("No execution provider available");
      }
    }

    async execute(command: string, args: string[]): Promise<ExecutionResult> {
      if (!this.selectedProvider) {
        throw new Error("Execution service not initialized");
      }

      return this.selectedProvider.execute(command, args);
    }
  }

  // Import ThreadPool for parallel task execution - lazy loaded when needed
  const importThreadPool = async (): Promise<
    typeof import("./worker").ThreadPool
  > => {
    const { ThreadPool } = await import("./worker");
    return ThreadPool;
  };

  // Configuration manager with validation and caching
  class ConfigManager {
    private config: Record<string, any> = {
      concurrency: 2,
      timeout: 30000,
      retryAttempts: 3,
      useThreadPool: false,
      maxWorkers: 4,
      retryBackoffMultiplier: 1.5, // New: exponential backoff for retries
      maxBuffer: 10 * 1024 * 1024, // New: 10MB buffer for command outputs
      abortOnError: false, // New: whether to stop batch on first error
    };
    private configLoaded = false;

    async loadConfig(configPath?: string): Promise<void> {
      if (this.configLoaded || !configPath) return;

      try {
        const absolutePath = path.resolve(configPath);
        if (fs.existsSync(absolutePath)) {
          const configContent = fs.readFileSync(absolutePath, "utf8");
          const userConfig = JSON.parse(configContent);

          // Validate critical config values
          if (
            userConfig.concurrency &&
            typeof userConfig.concurrency === "number"
          ) {
            userConfig.concurrency = Math.max(
              1,
              Math.min(32, userConfig.concurrency),
            );
          }

          if (userConfig.timeout && typeof userConfig.timeout === "number") {
            userConfig.timeout = Math.max(1000, userConfig.timeout);
          }

          this.config = { ...this.config, ...userConfig };
          this.configLoaded = true;
          logger.info(`Loaded configuration from ${absolutePath}`, {
            config: this.config,
          });
        }
      } catch (error) {
        logger.error(`Error loading configuration: ${error}`, error);
      }
    }

    get<T>(key: string, defaultValue?: T): T {
      return key in this.config ? this.config[key] : (defaultValue as T);
    }
  }

  // Script executor with enhanced features and performance optimizations
  class ScriptExecutor {
    private executionService: ExecutionService;
    private configManager: ConfigManager;
    private threadPool: import("./worker").ThreadPool | null = null;
    private scriptTypeCache: Map<string, string> = new Map(); // Cache for script types

    constructor() {
      this.executionService = new ExecutionService();
      this.configManager = new ConfigManager();
    }

    async initialize(configPath?: string): Promise<void> {
      await this.executionService.initialize();
      await this.configManager.loadConfig(configPath);

      // Initialize thread pool if enabled in config
      const useThreadPool = this.configManager.get<boolean>(
        "useThreadPool",
        false,
      );
      if (useThreadPool) {
        logger.info("Thread pool enabled, initializing...");
        try {
          const ThreadPoolClass = await importThreadPool();
          const maxWorkers = this.configManager.get<number>("maxWorkers", 4);
          const workerScript = this.configManager.get<string>(
            "workerScript",
            "./worker.js",
          );
          this.threadPool = new ThreadPoolClass(workerScript, maxWorkers);
          logger.info(`Thread pool initialized with max ${maxWorkers} workers`);
        } catch (error) {
          logger.error("Failed to initialize thread pool", error);
        }
      }
    }

    // Updated getExecutionCommand method with proper TypeScript handling
    private getExecutionCommand(scriptPath: string): {
      command: string;
      args: string[];
    } {
      const cachedType = this.scriptTypeCache.get(scriptPath);
      if (cachedType) {
        const commandParts = cachedType.split(" ");
        return {
          command: commandParts[0],
          args: [...commandParts.slice(1), scriptPath],
        };
      }

      const fileExtension = path.extname(scriptPath);
      let command = "node";
      let args: string[] = [];

      switch (fileExtension) {
        case ".js":
          // Default: Node.js execution
          break;
        case ".ts":
          // For TypeScript, check if ts-node is available, otherwise use npx
          try {
            // Check if ts-node is available in PATH
            const { exitCode } = require("node:child_process").spawnSync(
              "ts-node",
              ["--version"],
              {
                stdio: "ignore",
              },
            );

            if (exitCode === 0) {
              command = "ts-node";
              args = ["--esm"]; // Add --esm flag to support ES modules
            } else {
              // Fallback to npx if ts-node is not directly available
              command = "npx";
              args = ["ts-node", "--esm"]; // Add --esm flag here too
              logger.info("ts-node not found in PATH, using npx fallback");
            }
          } catch (error) {
            // If the check fails, use npx as fallback
            command = "npx";
            args = ["ts-node", "--esm"]; // Add --esm flag
            logger.info("Defaulting to npx ts-node for TypeScript execution");
          }
          break;
        case ".py":
          command = "python3";
          break;
        case ".sh":
          command = "bash";
          break;
        default:
          logger.warn(
            `Unknown file extension ${fileExtension}, attempting to execute with Node.js`,
          );
      }

      // Cache the result for future use (store full command including args)
      const commandString =
        args.length > 0 ? `${command} ${args.join(" ")}` : command;
      this.scriptTypeCache.set(scriptPath, commandString);

      return { command, args: [...args, scriptPath] };
    }

    // Updated execute method to better handle args
    async executeScript(scriptPath: string): Promise<void> {
      return await logger.time(`Execute ${scriptPath}`, async () => {
        try {
          const absolutePath = path.resolve(scriptPath);
          if (!fs.existsSync(absolutePath)) {
            logger.error(`Script not found: ${absolutePath}`);
            return;
          }

          logger.info(`Executing script: ${absolutePath}`);
          const { command, args } = this.getExecutionCommand(absolutePath);
          const timeout = this.configManager.get<number>("timeout", 30000);

          // Create an AbortController for timeout management
          const controller = new AbortController();
          const timeoutId = setTimeout(() => {
            controller.abort(`Execution timed out after ${timeout}ms`);
          }, timeout);

          try {
            // Note: args no longer includes the script path itself
            logger.debug(`Running command: ${command} ${args.join(" ")}`);
            const result = await this.executionService.execute(command, args);

            if (result.exitCode !== 0) {
              logger.error(
                `Script execution failed with code ${result.exitCode}`,
                {
                  stderr: result.stderr,
                  script: absolutePath,
                },
              );
            } else {
              logger.success(`Finished executing: ${absolutePath}`);
              if (result.stdout) {
                logger.debug("Script output:", { stdout: result.stdout });
              }
            }
          } finally {
            clearTimeout(timeoutId);
          }
        } catch (error) {
          logger.error(`Error executing script: ${error}`, {
            error,
            script: scriptPath,
          });
          throw error; // Rethrow for retry mechanism
        }
      });
    }

    // Execute a script using the thread pool if available with better error handling
    private async executeWithThreadPool(scriptPath: string): Promise<void> {
      if (!this.threadPool) {
        throw new Error("Thread pool not initialized");
      }

      const scriptContent = fs.readFileSync(scriptPath, "utf8");

      return await logger.time(
        `ThreadPool execution: ${scriptPath}`,
        async () => {
          try {
            logger.info(`Submitting script to thread pool: ${scriptPath}`);

            // Submit the script as a task to the thread pool
            const result = await this.threadPool?.submitTask("EXECUTE_SCRIPT", {
              scriptPath,
              scriptContent,
            });

            logger.success(`Thread pool execution complete: ${scriptPath}`);
            // @ts-ignore
            return result as unknown as void;
          } catch (error) {
            logger.error(
              `Thread pool execution failed for ${scriptPath}`,
              error,
            );
            // Fall back to regular execution
            logger.info(
              `Falling back to standard execution for: ${scriptPath}`,
            );
            await this.executeScript(scriptPath);
          }
        },
      );
    }

    // Execute multiple scripts in batch with improved concurrency management
    async executeBatch(scriptPaths: string[]): Promise<void> {
      return await logger.time("Batch execution", async () => {
        logger.group(
          `Starting batch execution of ${scriptPaths.length} scripts`,
        );

        const concurrency = this.configManager.get<number>("concurrency", 2);
        const retryAttempts = this.configManager.get<number>(
          "retryAttempts",
          3,
        );
        const backoffMultiplier = this.configManager.get<number>(
          "retryBackoffMultiplier",
          1.5,
        );
        const abortOnError = this.configManager.get<boolean>(
          "abortOnError",
          false,
        );
        const useThreadPool =
          this.configManager.get<boolean>("useThreadPool", false) &&
          this.threadPool !== null;

        logger.info("Execution parameters:", {
          concurrency,
          retryAttempts,
          backoffMultiplier,
          abortOnError,
          useThreadPool,
          totalScripts: scriptPaths.length,
        });

        // Enhanced retry functionality with exponential backoff
        const executeWithRetry = async (
          scriptPath: string,
          attempt = 1,
        ): Promise<void> => {
          try {
            if (useThreadPool) {
              await this.executeWithThreadPool(scriptPath);
            } else {
              await this.executeScript(scriptPath);
            }
          } catch (error) {
            if (attempt < retryAttempts) {
              const backoffTime = Math.floor(
                100 * backoffMultiplier ** (attempt - 1),
              );
              logger.warn(
                `Retry attempt ${attempt + 1} for script: ${scriptPath} (backoff: ${backoffTime}ms)`,
              );

              // Wait for backoff period before retrying
              await new Promise((resolve) => setTimeout(resolve, backoffTime));
              await executeWithRetry(scriptPath, attempt + 1);
            } else {
              const errorMsg = `Failed to execute script after ${retryAttempts} attempts: ${scriptPath}`;
              logger.error(errorMsg, { error });

              if (abortOnError) {
                throw new Error(errorMsg);
              }
            }
          }
        };

        // Improved batch processing with proper error handling
        const executionErrors: Error[] = [];
        let completedTasks = 0;

        // Process scripts in batches with efficient promise management
        const processBatch = async (batchScripts: string[]): Promise<void> => {
          const results = await Promise.allSettled(
            batchScripts.map((script) => executeWithRetry(script)),
          );

          completedTasks += batchScripts.length;
          logger.info(
            `Progress: ${completedTasks}/${scriptPaths.length} scripts processed`,
          );

          // Collect errors for reporting
          results.forEach((result, index) => {
            if (result.status === "rejected") {
              executionErrors.push(
                new Error(
                  `Failed to execute ${batchScripts[index]}: ${result.reason}`,
                ),
              );
            }
          });

          if (abortOnError && executionErrors.length > 0) {
            throw new Error(
              `Batch execution aborted due to errors: ${executionErrors.length} script(s) failed`,
            );
          }
        };

        // Process all scripts in batches of concurrency size
        try {
          for (let i = 0; i < scriptPaths.length; i += concurrency) {
            const batch = scriptPaths.slice(i, i + concurrency);
            await processBatch(batch);
          }

          if (executionErrors.length > 0) {
            logger.warn(
              `Batch execution completed with ${executionErrors.length} errors`,
            );
          } else {
            logger.success("Batch execution completed successfully");
          }
        } catch (error) {
          logger.error("Batch execution failed:", error);
          throw error;
        } finally {
          logger.groupEnd();
        }
      });
    }

    // Clean up resources before exiting
    async cleanup(): Promise<void> {
      if (this.threadPool) {
        logger.info("Shutting down thread pool");
        await this.threadPool.shutdown();
      }

      // Clear caches
      this.scriptTypeCache.clear();

      // Additional cleanup can be added here as needed
      logger.debug("Executor resources cleaned up");
    }
  }

  // Main function to handle script execution with enhanced CLI argument parsing
  const main = async (): Promise<void> => {
    logger.info("Starting cyber-security-scripts execution");

    // Parse arguments more efficiently
    const args = new Map<string, string>();
    const scripts: string[] = [];

    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i];
      if (arg.startsWith("--")) {
        // Handle key-value args (--key=value)
        const [key, value] = arg.slice(2).split("=");
        args.set(key, value || "true");
      } else {
        // Non-flag args are scripts
        scripts.push(arg);
      }
    }

    const configPath = args.get("config");
    const executor = new ScriptExecutor();

    try {
      // Performance: don't await these separately
      await Promise.all([
        executor.initialize(configPath),
        // Preload frequently used modules in parallel
        import("node:os"),
        import("node:events"),
      ]);

      if (scripts.length === 0) {
        logger.error(
          "No scripts specified. Usage: bun run script.ts [--config=config.json] script1.js [script2.js ...]",
        );
        return;
      }

      const startTime = performance.now();

      if (scripts.length === 1) {
        // Single script execution
        await executor.executeScript(scripts[0]);
      } else {
        // Multiple scripts in batch
        await executor.executeBatch(scripts);
      }

      const executionTime = ((performance.now() - startTime) / 1000).toFixed(2);

      // Clean up resources
      await executor.cleanup();
      logger.success(`Execution completed successfully in ${executionTime}s`);
    } catch (error) {
      logger.error(`Execution failed: ${error}`, error);
      process.exit(1);
    }
  };

  // Start execution with enhanced error handling
  main().catch((error) => {
    logger.error(`Unhandled error in main execution: ${error}`, {
      error,
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
})();
