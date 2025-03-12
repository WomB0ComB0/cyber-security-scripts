(() => {
  const { argv } = process;
  // Use dynamic import for better tree-shaking and lazy loading
  // Only import types statically for type checking
  const util = require("node:util") as typeof import("node:util");
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  
  // Import Logger class directly at the top level
  // This is a simple import we can do statically without dynamic imports
  const { Logger } = require("./logger") as typeof import("./logger");
  const logger = new Logger("Main");
  
  // Only import modules when needed using dynamic imports
  // These will be properly type-checked while being lazily loaded
  const importProcess = async (): Promise<typeof import("node:process")> =>
    import("node:process");
  const importNet = async (): Promise<typeof import("node:net")> =>
    import("node:net");
  
  // Interface for execution providers
  interface ExecutionProvider {
    execute(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    name: string;
  }
  
  // Bun execution provider
  class BunExecutionProvider implements ExecutionProvider {
    private execFn: typeof import("bun").$ | null = null;
    name = "Bun";
    
    constructor() {
      this.initialize();
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
    
    async execute(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      if (!this.execFn) {
        throw new Error("Bun execution function not available");
      }
      
      try {
        logger.debug(`Executing with Bun: ${command} ${args.join(" ")}`);
        const cmdStr = `${command} ${args.join(" ")}`;
        const result = await this.execFn`${cmdStr}`;
        return {
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
          exitCode: result.exitCode
        };
      } catch (error: any) {
        logger.error(`Bun execution error: ${error.message}`, error);
        return {
          stdout: "",
          stderr: error.message || "Unknown error",
          exitCode: 1
        };
      }
    }
  }
  
  // Node execution provider (fallback)
  class NodeExecutionProvider implements ExecutionProvider {
    name = "Node";
    
    async execute(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      logger.debug(`Executing with Node: ${command} ${args.join(" ")}`);
      const childProcess = await import("node:child_process");
      return new Promise((resolve) => {
        const proc = childProcess.spawn(command, args);
        let stdout = "";
        let stderr = "";
        
        proc.stdout.on("data", (data) => {
          stdout += data.toString();
        });
        
        proc.stderr.on("data", (data) => {
          stderr += data.toString();
        });
        
        proc.on("close", (exitCode) => {
          resolve({
            stdout,
            stderr,
            exitCode: exitCode ?? 1
          });
        });
      });
    }
  }
  
  // Execution service to manage providers
  class ExecutionService {
    private providers: ExecutionProvider[] = [];
    private selectedProvider: ExecutionProvider | null = null;
    
    constructor() {
      // Register providers in order of preference
      this.providers.push(new BunExecutionProvider());
      this.providers.push(new NodeExecutionProvider());
      logger.debug(`Registered ${this.providers.length} execution providers`);
    }
    
    async initialize(): Promise<void> {
      // Select the first available provider
      for (const provider of this.providers) {
        try {
          // Test provider with a simple command
          logger.debug(`Testing provider: ${provider.name}`);
          await provider.execute("echo", ["test"]);
          this.selectedProvider = provider;
          logger.info(`Using ${provider.name} execution provider`);
          break;
        } catch (error) {
          logger.warn(`Provider ${provider.name} not available: ${error}`);
          continue;
        }
      }
      
      if (!this.selectedProvider) {
        throw new Error("No execution provider available");
      }
    }
    
    async execute(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      if (!this.selectedProvider) {
        throw new Error("Execution service not initialized");
      }
      
      return this.selectedProvider.execute(command, args);
    }
  }
  
  // Import ThreadPool for parallel task execution
  const importThreadPool = async (): Promise<typeof import("./worker").ThreadPool> => {
    const { ThreadPool } = await import("./worker");
    return ThreadPool;
  };
  
  // Configuration manager
  class ConfigManager {
    private config: Record<string, any> = {
      concurrency: 2,
      timeout: 30000,
      retryAttempts: 3,
      useThreadPool: false
    };
    
    async loadConfig(configPath?: string): Promise<void> {
      if (!configPath) return;
      
      try {
        const absolutePath = path.resolve(configPath);
        if (fs.existsSync(absolutePath)) {
          const configContent = fs.readFileSync(absolutePath, 'utf8');
          const userConfig = JSON.parse(configContent);
          this.config = { ...this.config, ...userConfig };
          logger.info(`Loaded configuration from ${absolutePath}`, { config: this.config });
        }
      } catch (error) {
        logger.error(`Error loading configuration: ${error}`, error);
      }
    }
    
    get<T>(key: string, defaultValue?: T): T {
      return key in this.config ? this.config[key] : (defaultValue as T);
    }
  }
  
  // Script executor with enhanced features
  class ScriptExecutor {
    private executionService: ExecutionService;
    private configManager: ConfigManager;
    private threadPool: import("./worker").ThreadPool | null = null;
    
    constructor() {
      this.executionService = new ExecutionService();
      this.configManager = new ConfigManager();
    }
    
    async initialize(configPath?: string): Promise<void> {
      await this.executionService.initialize();
      await this.configManager.loadConfig(configPath);
      
      // Initialize thread pool if enabled in config
      const useThreadPool = this.configManager.get<boolean>('useThreadPool', false);
      if (useThreadPool) {
        logger.info("Thread pool enabled, initializing...");
        try {
          const ThreadPoolClass = await importThreadPool();
          const maxWorkers = this.configManager.get<number>('maxWorkers', 4);
          const workerScript = this.configManager.get<string>('workerScript', './worker.js');
          this.threadPool = new ThreadPoolClass(workerScript, maxWorkers);
          logger.info(`Thread pool initialized with max ${maxWorkers} workers`);
        } catch (error) {
          logger.error("Failed to initialize thread pool", error);
        }
      }
    }
    
    // Execute a single script
    async executeScript(scriptPath: string): Promise<void> {
      return await logger.time(`Execute ${scriptPath}`, async () => {
        try {
          const absolutePath = path.resolve(scriptPath);
          if (!fs.existsSync(absolutePath)) {
            logger.error(`Script not found: ${absolutePath}`);
            return;
          }
          
          logger.info(`Executing script: ${absolutePath}`);
          
          const timeout = this.configManager.get<number>('timeout', 30000);
          const result = await Promise.race([
            this.executionService.execute('node', [absolutePath]),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error(`Execution timed out after ${timeout}ms`)), timeout);
            })
          ]);
          
          if (result.exitCode !== 0) {
            logger.error(`Script execution failed with code ${result.exitCode}`, { 
              stderr: result.stderr,
              script: absolutePath
            });
          } else {
            logger.success(`Finished executing: ${absolutePath}`);
            if (result.stdout) {
              logger.debug(`Script output:`, { stdout: result.stdout });
            }
          }
        } catch (error) {
          logger.error(`Error executing script: ${error}`, { 
            error,
            script: scriptPath
          });
        }
      });
    }
    
    /**
     * Execute a script using the thread pool if available
     * This is an optimized execution path for compatible scripts
     */
    private async executeWithThreadPool(scriptPath: string): Promise<void> {
      if (!this.threadPool) {
        throw new Error("Thread pool not initialized");
      }
      
      const scriptContent = fs.readFileSync(scriptPath, 'utf8');
      
      return await logger.time(`ThreadPool execution: ${scriptPath}`, async () => {
        try {
          logger.info(`Submitting script to thread pool: ${scriptPath}`);
          
          // Submit the script as a task to the thread pool
          // This assumes we have a EXECUTE_SCRIPT task type registered in worker.ts
          const result = await this.threadPool!.submitTask("EXECUTE_SCRIPT", {
            scriptPath,
            scriptContent
          });
          
          logger.success(`Thread pool execution complete: ${scriptPath}`);
          return result as void;
        } catch (error) {
          logger.error(`Thread pool execution failed for ${scriptPath}`, error);
          // Fall back to regular execution
          logger.info(`Falling back to standard execution for: ${scriptPath}`);
          await this.executeScript(scriptPath);
        }
      });
    }
    
    // Execute multiple scripts in batch
    async executeBatch(scriptPaths: string[]): Promise<void> {
      return await logger.time("Batch execution", async () => {
        logger.group(`Starting batch execution of ${scriptPaths.length} scripts`);
        
        const concurrency = this.configManager.get<number>('concurrency', 2);
        const retryAttempts = this.configManager.get<number>('retryAttempts', 3);
        const useThreadPool = this.configManager.get<boolean>('useThreadPool', false) && this.threadPool !== null;
        
        logger.info(`Execution parameters:`, {
          concurrency, 
          retryAttempts,
          useThreadPool
        });
        
        // Custom implementation to execute scripts in batches with concurrency control
        const executeWithRetry = async (scriptPath: string, attempt = 1): Promise<void> => {
          try {
            if (useThreadPool) {
              await this.executeWithThreadPool(scriptPath);
            } else {
              await this.executeScript(scriptPath);
            }
          } catch (error) {
            if (attempt < retryAttempts) {
              logger.warn(`Retry attempt ${attempt + 1} for script: ${scriptPath}`);
              await executeWithRetry(scriptPath, attempt + 1);
            } else {
              logger.error(`Failed to execute script after ${retryAttempts} attempts: ${scriptPath}`, { error });
            }
          }
        };
        
        // Process scripts in batches according to concurrency setting
        let activePromises: Promise<void>[] = [];
        let index = 0;
        
        while (index < scriptPaths.length) {
          // If active promises are less than concurrency, add more
          while (activePromises.length < concurrency && index < scriptPaths.length) {
            const scriptPath = scriptPaths[index++];
            activePromises.push(executeWithRetry(scriptPath));
          }
          
          if (activePromises.length > 0) {
            // Wait for at least one promise to complete
            await Promise.race(activePromises);
            // Filter out completed promises
            activePromises = activePromises.filter(p => p.then(() => false, () => false).catch(() => false));
          }
        }
        
        // Wait for any remaining promises
        if (activePromises.length > 0) {
          await Promise.all(activePromises);
        }
        
        logger.groupEnd();
        logger.success("Batch execution completed");
      });
    }
    
    /**
     * Clean up resources before exiting
     */
    async cleanup(): Promise<void> {
      if (this.threadPool) {
        logger.info("Shutting down thread pool");
        this.threadPool.shutdown();
      }
    }
  }
  
  // Main function to handle script execution
  const main = async (): Promise<void> => {
    logger.info("Starting cyber-security-scripts execution");
    
    const executor = new ScriptExecutor();
    
    // Look for a config flag (--config=path/to/config.json)
    const configArg = argv.find(arg => arg.startsWith('--config='));
    const configPath = configArg ? configArg.split('=')[1] : undefined;
    
    // Filter out config argument from scripts list
    const scripts = argv.slice(2).filter(arg => !arg.startsWith('--config='));
    
    try {
      await executor.initialize(configPath);
      
      if (scripts.length === 0) {
        logger.error("No scripts specified. Usage: bun run script.ts [--config=config.json] script1.js [script2.js ...]");
        return;
      }
      
      if (scripts.length === 1) {
        // Single script execution
        await executor.executeScript(scripts[0]);
      } else {
        // Multiple scripts in batch
        await executor.executeBatch(scripts);
      }
      
      // Clean up resources
      await executor.cleanup();
      logger.success("Execution completed successfully");
    } catch (error) {
      logger.error(`Execution failed: ${error}`, error);
      process.exit(1);
    }
  };
  
  // Start execution
  main().catch(error => {
    logger.error(`Unhandled error in main execution: ${error}`, { error });
    process.exit(1);
  });
})();