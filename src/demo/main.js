import './index.css';
import { createApp } from './createApp';

let renderer = null;

document.addEventListener('DOMContentLoaded', async () => {
  renderer = await createApp()
});

// Handle hot reloading of the engine.
if (import.meta.hot) {
  import.meta.hot.accept('./createApp', async module => {
    if (renderer) {
      renderer.dispose();
      renderer = undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderer = await createApp();
  });
}
