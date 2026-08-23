/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Resolve the workspace package to source, so `npm test` needs no build step
  // and ts-jest type-checks the shared modules alongside their consumers.
  moduleNameMapper: {
    '^@pipeline-radar/shared/(.*)$': '<rootDir>/../shared/src/$1',
  },
  // Bounded rather than left to the default (cpus - 1).
  //
  // Several suites now load the Anthropic SDK and zod, which raised per-worker
  // memory enough that seven parallel ts-jest workers get OOM-killed on a
  // memory-constrained machine. The symptom is not a failing assertion - it is
  // "A jest worker process was terminated by another process: signal=SIGKILL"
  // and a whole suite silently missing from the totals, which reads like a
  // flaky test rather than a resource limit. ubuntu-latest has 4 cores, so its
  // effective worker count is unchanged by this.
  maxWorkers: 3,
};
