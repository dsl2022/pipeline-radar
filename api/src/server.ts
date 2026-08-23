import { createApp, servicePort } from './app';

const port = servicePort();

createApp().listen(port, () => {
  console.log(`pipeline-radar api proxy listening on :${port}`);
});
