(() => {
  // Use dynamic import for better tree-shaking and lazy loading
  // Only import types statically for type checking
  const util = require("node:util") as typeof import("node:util");

  // Only import modules when needed using dynamic imports
  // These will be properly type-checked while being lazily loaded
  const importProcess = async (): Promise<typeof import("node:process")> =>
    import("node:process");
  const importWorker = async (): Promise<
    typeof import("node:worker_threads")
  > => import("node:worker_threads");
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
})();
