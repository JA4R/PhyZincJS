import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@emotion/react';
import CssBaseline from '@mui/material/CssBaseline';
import theme from './theme.tsx';
import Scene, { SceneHandle } from './Scene.tsx';
import ControlPanel from './ControlPanel.tsx';

const DEFAULT_GRAVITY = 9.81;
const GRAVITY_SCALE = 0.1;

const createRandomString = () => (Math.random() + 1).toString(36).substring(7);

const App = () => {
  const sceneRef = React.useRef<SceneHandle>(null);
  const [sceneKey] = React.useState(createRandomString);
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

  const handlePauseToggle = () => {
    sceneRef.current?.pause();
    setPaused((prev) => !prev);
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ControlPanel
        title="Simulation"
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
      <Scene gravity={-DEFAULT_GRAVITY * GRAVITY_SCALE} key={sceneKey} ref={sceneRef} />
    </ThemeProvider>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
