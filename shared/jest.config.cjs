/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // The DOM-free half of the app. These modules are pure functions over plain
  // data, which is why both the browser bundle and the server-side agent can
  // share them verbatim.
};
