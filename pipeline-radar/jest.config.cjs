/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // Resolve the workspace package to source, so `npm test` needs no build step
  // and ts-jest type-checks the shared modules alongside their consumers.
  moduleNameMapper: {
    '^@pipeline-radar/shared/(.*)$': '<rootDir>/../shared/src/$1',
  },
  testMatch: ['**/src/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Vite's tsconfig is bundler-mode/ESM; override just enough for Jest's CJS runtime.
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          target: 'es2022',
          verbatimModuleSyntax: false,
          esModuleInterop: true,
          resolveJsonModule: true,
          // Mirrors tsconfig.app.json + the Vite alias: the shared workspace
          // package resolves to its TypeScript source, so ts-jest type-checks
          // against the same files Vite bundles.
          baseUrl: '.',
          paths: { '@pipeline-radar/shared/*': ['../shared/src/*'] },
          jsx: 'react-jsx',
          strict: true,
          types: ['jest', 'node'],
        },
      },
    ],
  },
};
