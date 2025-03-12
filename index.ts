(() => {
  const { argv } = process;
  // Use dynamic import for better tree-shaking and lazy loading
  // Only import types statically for type checking
  const util = require("node:util") as typeof import("node:util");
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  
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
      } catch (error) {
        console.error("Failed to initialize Bun execution provider:", error);
      }
    }
    
    async execute(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      if (!this.execFn) {
        throw new Error("Bun execution function not available");
      }
      
      try {
        const cmdStr = `${command} ${args.join(" ")}`;
        const result = await this.execFn([cmdStr], { stdout: "pipe", stderr: "pipe" });
        return {
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
          exitCode: result.exitCode
        };
      } catch (error: any) {
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
    }
    
    async initialize(): Promise<void> {
      // Select the first available provider
      for (const provider of this.providers) {
        try {
          // Test provider with a simple command
          await provider.execute("echo", ["test"]);
          this.selectedProvider = provider;
          console.log(`Using ${provider.name} execution provider`);
          break;
        } catch (error) {
          console.log(`Provider ${provider.name} not available: ${error}`);
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
  
  // Define a type for the logger module to improve readability
  type LoggerModule = typeof import("./logger.ts");
  type WorkerModule = typeof import("./worker.ts");
  
  // Use a proper function name that indicates its purpose
  const importLogger = async (): Promise<LoggerModule> => {
    const loggerModule = await import("./logger.ts");
    return loggerModule;
  };
  
  // Only access the Logger when needed
  const getLogger = async (): Promise<LoggerModule["Logger"]> => {
    const module = await importLogger();
    return module.Logger;
  };
  
  // Import worker for batch processing
  const importWorker = async (): Promise<WorkerModule> => {
    const workerModule = await import("./worker.ts");
    return workerModule;
  };
  
  // Configuration manager
  class ConfigManager {
    private config: Record<string, any> = {
      concurrency: 2,
      timeout: 30000,
      retryAttempts: 3
    };
    
    async loadConfig(configPath?: string): Promise<void> {
      if (!configPath) return;
      
      try {
        const absolutePath = path.resolve(configPath);
        if (fs.existsSync(absolutePath)) {
          const configContent = fs.readFileSync(absolutePath, 'utf8');
          const userConfig = JSON.parse(configContent);
          this.config = { ...this.config, ...userConfig };
          const logger = await getLogger();
          logger.info(`Loaded configuration from ${absolutePath}`);
        }
      } catch (error) {
        const logger = await getLogger();
        logger.error(`Error loading configuration: ${error}`);
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
    
    constructor() {
      this.executionService = new ExecutionService();
      this.configManager = new ConfigManager();
    }
    
    async initialize(configPath?: string): Promise<void> {
      await this.executionService.initialize();
      await this.configManager.loadConfig(configPath);
    }
    
    // Execute a single script
    async executeScript(scriptPath: string): Promise<void> {
      try {
        const absolutePath = path.resolve(scriptPath);
        if (!fs.existsSync(absolutePath)) {
          const logger = await getLogger();
          logger.error(`Script not found: ${absolutePath}`);
          return;
        }
        
        const logger = await getLogger();
        logger.info(`Executing script: ${absolutePath}`);
        
        const timeout = this.configManager.get<number>('timeout', 30000);
        const result = await Promise.race([
          this.executionService.execute('node', [absolutePath]),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Execution timed out after ${timeout}ms`)), timeout);
          })
        ]);
        
        if (result.exitCode !== 0) {
          logger.error(`Script execution failed with code ${result.exitCode}: ${result.stderr}`);
        } else {
          logger.info(`Finished executing: ${absolutePath}`);
          if (result.stdout) {
            logger.debug(`Script output: ${result.stdout}`);
          }
        }
      } catch (error) {
        const logger = await getLogger();
        logger.error(`Error executing script: ${error}`);
      }
    }
    
    // Execute multiple scripts in batch using worker
    async executeBatch(scriptPaths: string[]): Promise<void> {
      const workerModule = await importWorker();
      const logger = await getLogger();
      
      const concurrency = this.configManager.get<number>('concurrency', 2);
      const retryAttempts = this.configManager.get<number>('retryAttempts', 3);
      
      logger.info(`Starting batch execution of ${scriptPaths.length} scripts with concurrency ${concurrency}`);
      
      // Pass configuration to worker
      await workerModule.executeBatch(scriptPaths, {
        concurrency,
        retryAttempts,
        timeout: this.configManager.get<number>('timeout', 30000)
      });
      
      logger.info("Batch execution completed");
    }
  }
  
  // Main function to handle script execution
  const main = async (): Promise<void> => {
    const executor = new ScriptExecutor();
    
    // Look for a config flag (--config=path/to/config.json)
    const configArg = argv.find(arg => arg.startsWith('--config='));
    const configPath = configArg ? configArg.split('=')[1] : undefined;
    
    // Filter out config argument from scripts list
    const scripts = argv.slice(2).filter(arg => !arg.startsWith('--config='));
    
    await executor.initialize(configPath);
    
    if (scripts.length === 0) {
      const logger = await getLogger();
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
  };
  
  // Start execution
  main().catch(async (error) => {
    const logger = await getLogger();
    logger.error(`Error in main execution: ${error}`);
    process.exit(1);
  });
})();