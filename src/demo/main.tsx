import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@emotion/react';
import CssBaseline from '@mui/material/CssBaseline';
import theme from './theme.tsx';
import Scene, { SceneHandle } from './Scene.tsx';
import ControlPanel from './ControlPanel.tsx';
import { DEMOS } from './demos/index.js';

const DEFAULT_GRAVITY = 9.81;
const GRAVITY_SCALE = 0.1;

const DEFAULT_DEMO = 'cloth-collision';

const App = () => {
  const sceneRef = React.useRef<SceneHandle>(null);
  const [demoKey, setDemoKey] = React.useState(DEFAULT_DEMO);
  const demo = DEMOS.find((d) => d.key === demoKey) ?? DEMOS[0];
  const [paused, setPaused] = React.useState(true);
  const gravityRef = React.useRef(DEFAULT_GRAVITY);

  const handleGravityChange = (value: string) => {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      gravityRef.current = parsed;
    }
  };

  const handleRestart = () => {
    sceneRef.current?.restart(-gravityRef.current * GRAVITY_SCALE);
    setPaused(true);
  };

  // Scene is keyed by demoKey, so changing it unmounts (and disposes) the old
  // scene and mounts the new one. Every demo starts paused.
  const handleDemoChange = (value: string) => {
    setDemoKey(value);
    setPaused(true);
  };

  const handlePauseToggle = () => {
    sceneRef.current?.pause();
    setPaused((prev) => !prev);
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ControlPanel
        title="Simulation"
        selects={[
          {
            key: 'demo',
            label: 'Demo',
            value: demo.key,
            options: DEMOS.map((d) => ({ value: d.key, label: d.label })),
            onChange: handleDemoChange,
          },
        ]}
        fields={[
          {
            key: 'gravity',
            label: 'Gravity',
            defaultValue: String(DEFAULT_GRAVITY),
            helperText: 'Applies on Restart',
            onChange: handleGravityChange,
          },
        ]}
        actions={[
          { key: 'restart', label: 'Restart', onClick: handleRestart },
          {
            key: 'pause',
            label: paused ? 'Resume' : 'Pause',
            onClick: handlePauseToggle,
            variant: 'outlined',
          },
        ]}
      />
      <Scene
        key={demo.key}
        ref={sceneRef}
        start={demo.start}
        gravity={-gravityRef.current * GRAVITY_SCALE}
      />
    </ThemeProvider>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
