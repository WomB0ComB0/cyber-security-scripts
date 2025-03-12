import { Logger } from "./logger";

/**
 * # Web Worker Thread Pool for TypeScript
 *
 * A TypeScript implementation of a thread pool using Web Workers for efficient parallel processing
 * of CPU-intensive tasks in the browser. This library allows you to distribute work across multiple
 * worker threads, maximizing performance while managing thread creation and task scheduling.
 */

/**
 * Type definitions for task types and their corresponding data and result types
 */
type TaskTypeToDataMap = {
  [key: string]: unknown;
  COMPUTE_INTENSIVE: { iterations: number };
  DEFAULT: unknown;
};

type TaskTypeToResultMap = {
  [key: string]: unknown;
  COMPUTE_INTENSIVE: number;
  DEFAULT: unknown;
};

/**
 * Represents message types exchanged between threads
 */
type MessageType = "TASK" | "RESULT" | "ERROR" | "STATUS";

/**
 * Represents a message exchanged between the main thread and worker threads.
 */
interface WorkerMessage<T extends MessageType, P> {
  id: string;
  type: T;
  payload: P;
  timestamp: number;
}

/**
 * Task-specific worker message
 */
interface TaskMessage
  extends WorkerMessage<"TASK", WorkerTask<keyof TaskTypeToDataMap>> {}

/**
 * Result-specific worker message
 */
interface ResultMessage
  extends WorkerMessage<"RESULT", WorkerResult<unknown>> {}

/**
 * Error-specific worker message
 */
interface ErrorMessage
  extends WorkerMessage<"ERROR", { taskId: string; error: string }> {}

/**
 * Status-specific worker message
 */
interface StatusMessage extends WorkerMessage<"STATUS", { status: string }> {}

/**
 * Union type of all worker message types
 */
type AllWorkerMessages =
  | TaskMessage
  | ResultMessage
  | ErrorMessage
  | StatusMessage;

/**
 * Represents a task to be executed by a worker thread.
 */
interface WorkerTask<T extends keyof TaskTypeToDataMap> {
  id: string;
  type: T;
  data: TaskTypeToDataMap[T];
}

/**
 * Represents the result of a worker thread's execution.
 */
interface WorkerResult<T> {
  taskId: string;
  result: T;
  error?: string;
  executionTime?: number;
}

/**
 * Task handler function type
 */
type TaskHandler<T extends keyof TaskTypeToDataMap> = (
  data: TaskTypeToDataMap[T],
) => Promise<TaskTypeToResultMap[T]>;

/**
 * Worker thread class that runs in the web worker context and processes tasks.
 *
 * This class handles incoming task messages, routes them to appropriate handlers,
 * and returns the results back to the main thread.
 */
class WorkerThread {
  /**
   * Logger instance for worker-side logging
   * @private
   */
  private logger = new Logger("WorkerThread");

  /**
   * Map of task type names to their handler functions
   * @private
   */
  private taskHandlers = new Map<string, (data: unknown) => Promise<unknown>>();

  /**
   * Initialize a new worker thread and register default handlers
   */
  constructor() {
    this.logger.info("Initializing worker thread");
    // Register message handler
    self.onmessage = this.handleMessage.bind(this);

    // Register default task handler
    this.registerTaskHandler("DEFAULT", async (data: unknown) => data);
    this.logger.debug("Default task handler registered");
  }

  /**
   * Process incoming messages from the main thread
   *
   * @private
   * @param event The message event from the main thread
   */
  private async handleMessage(event: MessageEvent<AllWorkerMessages>) {
    const { id, type, payload } = event.data;
    this.logger.debug(`Received message: ${type} (ID: ${id})`);

    if (type === "TASK") {
      const task = payload as WorkerTask<keyof TaskTypeToDataMap>;
      this.logger.info(`Processing task ${task.id} of type ${String(task.type)}`);

      try {
        const startTime = performance.now();
        const handler =
          this.taskHandlers.get(String(task.type)) ||
          this.taskHandlers.get("DEFAULT");

        if (!handler) {
          this.logger.error(`No handler registered for task type: ${task.type}`);
          throw new Error(`No handler registered for task type: ${task.type}`);
        }

        this.logger.debug(`Executing handler for task ${task.id}`);
        const result = await handler(task.data);
        const executionTime = performance.now() - startTime;
        this.logger.info(`Task ${task.id} completed in ${executionTime.toFixed(2)}ms`);

        const response: ResultMessage = {
          id,
          type: "RESULT",
          payload: {
            taskId: task.id,
            result,
            executionTime,
          },
          timestamp: Date.now(),
        };

        self.postMessage(response);
        this.logger.debug(`Posted result for task ${task.id}`);
      } catch (error) {
        this.logger.error(`Error in task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);

        const errorResponse: ErrorMessage = {
          id,
          type: "ERROR",
          payload: {
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error),
          },
          timestamp: Date.now(),
        };

        self.postMessage(errorResponse);
        this.logger.debug(`Posted error for task ${task.id}`);
      }
    }
  }

  /**
   * Register a handler function for a specific task type
   *
   * @param type The task type identifier
   * @param handler The async function to handle this task type
   */
  public registerTaskHandler<T extends keyof TaskTypeToDataMap>(
    type: T,
    handler: TaskHandler<T>,
  ): void {
    this.logger.info(`Registering handler for task type: ${String(type)}`);
    this.taskHandlers.set(
      String(type),
      handler as (data: unknown) => Promise<unknown>,
    );
  }
}

// Initialize worker
const worker = new WorkerThread();

// Register task handlers with proper typing
worker.registerTaskHandler(
  "COMPUTE_INTENSIVE",
  async (data: { iterations: number }) => {
    let result = 0;
    for (let i = 0; i < data.iterations; i++) {
      result += Math.sqrt(i);
    }
    return result;
  },
);

/**
 * ThreadPool manages a pool of Web Workers to efficiently distribute tasks
 * across multiple threads.
 *
 * Features:
 * - Automatic worker scaling based on system capabilities
 * - Task queuing and distribution
 * - Promise-based API for task submission
 * - Error handling and recovery
 * - Performance tracking
 */
export class ThreadPool {
  /** Logger instance */
  private logger: Logger;

  /** Array of worker instances */
  private workers: Worker[] = [];
  /** Queue of pending tasks */
  private taskQueue: Array<WorkerTask<keyof TaskTypeToDataMap>> = [];
  /** Set of workers currently processing tasks */
  private activeWorkers: Set<Worker> = new Set();
  /** Map of task results keyed by task ID */
  private results: Map<string, WorkerResult<unknown>> = new Map();
  /** Map of promise callbacks for tasks keyed by task ID */
  private callbacks: Map<
    string,
    [resolve: (result: unknown) => void, reject: (error: unknown) => void]
  > = new Map();
  /** The path to the worker script */
  private workerScript: string;
  /** Maximum number of workers to create */
  private maxWorkers: number;

  /**
   * Creates a new ThreadPool instance
   *
   * @param workerScript The URL or path to the worker script
   * @param maxWorkers Maximum number of workers to create (defaults to CPU core count)
   */
  constructor(
    workerScript: string,
    maxWorkers = navigator.hardwareConcurrency || 4,
  ) {
    this.logger = new Logger("ThreadPool");
    this.workerScript = workerScript;
    this.maxWorkers = maxWorkers;
    this.logger.info(`Initialized ThreadPool with ${maxWorkers} max workers`);
  }

  /**
   * Creates a new worker and sets up message handlers
   *
   * @private
   * @returns A new worker instance
   */
  private createWorker(): Worker {
    this.logger.debug(`Creating new worker with script: ${this.workerScript}`);
    const worker = new Worker(this.workerScript, { type: "module" });

    worker.onmessage = (event: MessageEvent<AllWorkerMessages>) => {
      const { id, type, payload } = event.data;
      this.logger.debug(`Received message from worker: ${type} (ID: ${id})`);

      if (type === "RESULT") {
        this.handleWorkerComplete(worker, id, payload as WorkerResult<unknown>);
      } else if (type === "ERROR") {
        const errorPayload = payload as { taskId: string; error: string };
        this.logger.warn(`Worker reported error: ${errorPayload.error}`);
        this.handleWorkerComplete(worker, id, {
          taskId: errorPayload.taskId,
          result: null,
          error: errorPayload.error,
        });
      }
    };

    worker.onerror = (errorEvent: ErrorEvent) => {
      this.logger.error(`Worker error: ${errorEvent.message}`, errorEvent);
      this.handleWorkerError(worker, errorEvent);
    };

    return worker;
  }

  /**
   * Handles a completed task from a worker
   *
   * @private
   * @param worker The worker that completed the task
   * @param messageId The ID of the message
   * @param result The result data
   */
  private handleWorkerComplete(
    worker: Worker,
    messageId: string,
    result: WorkerResult<unknown>,
  ): void {
    this.logger.debug(`Worker completed task ${result.taskId}`);
    this.activeWorkers.delete(worker);
    this.results.set(result.taskId, result);

    const callbacks = this.callbacks.get(result.taskId);
    if (callbacks) {
      const [resolve, reject] = callbacks;
      if (result.error) {
        this.logger.warn(`Task ${result.taskId} failed: ${result.error}`);
        reject(new Error(result.error));
      } else {
        this.logger.info(`Task ${result.taskId} succeeded in ${result.executionTime?.toFixed(2)}ms`);
        resolve(result.result);
      }
      this.callbacks.delete(result.taskId);
    } else {
      this.logger.warn(`No callbacks found for task ${result.taskId}`);
    }

    this.processNextTask();
  }

  /**
   * Handles worker errors by terminating the problematic worker
   *
   * @private
   * @param worker The worker that encountered an error
   * @param errorEvent The error event
   */
  private handleWorkerError(worker: Worker, errorEvent: ErrorEvent): void {
    this.logger.error(`Terminating worker due to error: ${errorEvent.message}`);
    this.activeWorkers.delete(worker);
    worker.terminate();
    const index = this.workers.indexOf(worker);
    if (index !== -1) {
      this.workers.splice(index, 1);
      this.logger.info(`Worker removed from pool, ${this.workers.length} workers remaining`);
    }
    this.processNextTask();
  }

  /**
   * Processes the next task in the queue if workers are available
   *
   * @private
   */
  private processNextTask(): void {
    if (this.taskQueue.length === 0) {
      this.logger.debug("No tasks in queue to process");
      return;
    }

    let worker: Worker | undefined;

    // Reuse existing idle worker
    for (const w of this.workers) {
      if (!this.activeWorkers.has(w)) {
        worker = w;
        this.logger.debug("Reusing existing idle worker");
        break;
      }
    }

    // Create new worker if needed and possible
    if (!worker && this.workers.length < this.maxWorkers) {
      this.logger.info(`Creating new worker (${this.workers.length + 1}/${this.maxWorkers})`);
      worker = this.createWorker();
      this.workers.push(worker);
    }

    if (worker) {
      const task = this.taskQueue.shift();
      if (task) {
        this.logger.info(`Assigning task ${task.id} of type ${String(task.type)} to worker`);
        this.activeWorkers.add(worker);
        const message: TaskMessage = {
          id: task.id,
          type: "TASK",
          payload: task,
          timestamp: Date.now(),
        };
        worker.postMessage(message);
      }
    } else {
      this.logger.debug(`All workers busy (${this.workers.length}/${this.maxWorkers}), task queued`);
    }
  }

  /**
   * Submit a task for execution by a worker
   *
   * @template T The task type from TaskTypeToDataMap
   * @template R The result type from TaskTypeToResultMap
   * @param type The task type that will be routed to the appropriate handler
   * @param data The data needed for task execution
   * @returns A promise that resolves with the task result or rejects with an error
   */
  public submitTask<
    T extends keyof TaskTypeToDataMap,
    R = TaskTypeToResultMap[T],
  >(type: T, data: TaskTypeToDataMap[T]): Promise<R> {
    const taskId = crypto.randomUUID();
    this.logger.info(`Submitting task ${taskId} of type ${String(type)}`);

    const task: WorkerTask<T> = {
      id: taskId,
      type,
      data,
    };

    return new Promise<R>((resolve, reject) => {
      this.logger.debug(`Registering callbacks for task ${taskId}`);
      this.callbacks.set(task.id, [
        (result) => {
          this.logger.debug(`Resolving task ${taskId}`);
          resolve(result as R);
        }, 
        (error) => {
          this.logger.debug(`Rejecting task ${taskId}: ${error}`);
          reject(error);
        }
      ]);
      this.taskQueue.push(task);
      this.logger.debug(`Task ${taskId} added to queue, queue length: ${this.taskQueue.length}`);
      this.processNextTask();
    });
  }

  /**
   * Terminates all workers and clears all internal state
   */
  public shutdown(): void {
    this.logger.info(`Shutting down thread pool with ${this.workers.length} workers`);
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.activeWorkers.clear();
    this.taskQueue = [];
    this.callbacks.clear();
    this.results.clear();
    this.logger.info("Thread pool shutdown complete");
  }

  /**
   * Gets the count of currently executing tasks
   *
   * @returns Number of active tasks
   */
  public getActiveTaskCount(): number {
    return this.activeWorkers.size;
  }

  /**
   * Gets the count of tasks waiting in the queue
   *
   * @returns Number of queued tasks
   */
  public getQueuedTaskCount(): number {
    return this.taskQueue.length;
  }

  /**
   * Gets a copy of all task results
   *
   * @returns Map of task results by task ID
   */
  public getAllResults(): Map<string, WorkerResult<unknown>> {
    return new Map(this.results);
  }
}

/**
 * Example usage of the ThreadPool
 *
 * This example shows how to create a pool, submit multiple tasks,
 * and work with the results.
 */
async function example(): Promise<void> {
  const logger = new Logger("Example");
  logger.info("Starting thread pool example");

  // Initialize thread pool
  const threadPool = new ThreadPool("worker.js");

  try {
    // Submit multiple tasks with proper typing
    const tasks: Promise<number>[] = [];
    logger.info("Submitting 10 compute-intensive tasks");
    for (let i = 0; i < 10; i++) {
      const task = threadPool.submitTask("COMPUTE_INTENSIVE", {
        iterations: 1000000,
      });
      tasks.push(task);
    }

    // Wait for all tasks to complete
    const results = await Promise.all(tasks);
    logger.info("All tasks completed successfully");
    logger.debug("Results:", results);

    // Get execution statistics
    const allResults = threadPool.getAllResults();
    const totalExecutionTime = Array.from(allResults.values()).reduce(
      (sum, result) => sum + (result.executionTime || 0),
      0,
    );

    logger.info(`Total execution time: ${totalExecutionTime.toFixed(2)}ms`);
  } catch (error) {
    logger.error("Error executing tasks:", error);
  } finally {
    // Clean up
    logger.info("Cleaning up resources");
    threadPool.shutdown();
  }
}

// Start the example
if (require.main === module) {
  example().catch((error) => {
    const logger = new Logger("Main");
    logger.error("Unhandled error in example:", error);
  });
}
