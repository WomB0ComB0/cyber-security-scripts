(() => {
  const { argv } = process;
  
  // Use dynamic import for better tree-shaking and lazy loading
  // Only import types statically for type checking
  const util = require("node:util") as typeof import("node:util");

  // Only import modules when needed using dynamic imports
  // These will be properly type-checked while being lazily loaded
  const importProcess = async (): Promise<typeof import("node:process")> =>
    import("node:process");
  const importNet = async (): Promise<typeof import("node:net")> =>
    import("node:net");

  // Properly type the Bun exec function
  let execFn: typeof import("bun").$ | undefined;
  import("bun")
    .then((bun) => {
      execFn = bun.$;
      return execFn;
    })
    .catch(console.error);
  
  // Define a type for the logger module to improve readability
  type LoggerModule = typeof import("./logger.ts");

  // Use a proper function name that indicates its purpose
  const importLogger = async (): Promise<LoggerModule> => {
    const loggerModule = await import("./logger.ts");
    return loggerModule;
  };

  // Only access the Logger when needed
  const getLogger = (): Promise<LoggerModule["Logger"]> => 
    importLogger().then(module => module.Logger);


  
})();
