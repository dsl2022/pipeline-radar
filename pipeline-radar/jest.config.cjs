/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
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
          jsx: 'react-jsx',
          strict: true,
          types: ['jest', 'node'],
        },
      },
    ],
  },
};
