/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Resolve the workspace package to source, so `npm test` needs no build step
  // and ts-jest type-checks the shared modules alongside their consumers.
  moduleNameMapper: {
    '^@pipeline-radar/shared/(.*)$': '<rootDir>/../shared/src/$1',
  },
};
