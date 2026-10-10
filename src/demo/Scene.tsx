import { useImperativeHandle, forwardRef, useRef, useEffect } from 'react';
import Box from '@mui/material/Box';

type Props = {
  // A demo's start function (see demos/index.js); resolves to its PhyZinc.
  start: (mount: HTMLElement, gravity: number) => Promise<any>;
  gravity: number;
  // Whether the PhyZinc frame rate counter runs; rates are reported through
  // onFrameRate (about twice a second).
  showFrameRate?: boolean;
  onFrameRate?: (framesPerSecond: number) => void;
};

export type SceneHandle = {
  restart: (gravity?: number) => void;
  pause: () => void;
};

const disposeInstance = (phyZinc: any) => {
  const domElement = phyZinc.renderer?.getThreeJSRenderer().domElement;
  phyZinc.dispose();
  domElement?.parentNode?.removeChild(domElement);
};

const Scene = forwardRef<SceneHandle, Props>(({ start, gravity, showFrameRate = false, onFrameRate }, ref) => {
  const mountRef = useRef<HTMLDivElement>(null);
  // A ref, not state: the effect cleanup below runs with the closure from the
  // first render, so it must read the current instance through a ref.
  const phyZincRef = useRef<any>(null);
  // Bumped on every initialise and on unmount, so a start() that resolves
  // after the scene was restarted or switched away is disposed, not kept.
  const generationRef = useRef(0);
  // Latest props, read from PhyZinc callbacks registered by an earlier render.
  const showFrameRateRef = useRef(showFrameRate);
  showFrameRateRef.current = showFrameRate;
  const onFrameRateRef = useRef(onFrameRate);
  onFrameRateRef.current = onFrameRate;

  const dispose = () => {
    if (phyZincRef.current) {
      disposeInstance(phyZincRef.current);
      phyZincRef.current = null;
    }
  };

  const initialise = async (sceneGravity: number) => {
    const generation = ++generationRef.current;
    const phyZinc = await start(mountRef.current!, sceneGravity);
    if (generation !== generationRef.current) {
      disposeInstance(phyZinc);
      return;
    }
    phyZincRef.current = phyZinc;
    // Each restart creates a new PhyZinc, so the counter is set up again here.
    phyZinc.addFrameRateCallback((rate: number) => onFrameRateRef.current?.(rate));
    phyZinc.setFrameRateCounterEnabled(showFrameRateRef.current);
  };

  // Toggling the counter on the current instance without restarting it.
  useEffect(() => {
    phyZincRef.current?.setFrameRateCounterEnabled(showFrameRate);
  }, [showFrameRate]);

  useImperativeHandle(ref, () => ({
    restart: (newGravity?: number) => {
      dispose();
      initialise(newGravity ?? gravity);
    },
    pause: () => {
      const phyZinc = phyZincRef.current;
      phyZinc?.pause(!phyZinc.isPaused());
    },
  }));

  useEffect(() => {
    initialise(gravity);
    return () => {
      generationRef.current++;
      dispose();
    };
  }, []);

  return <Box ref={mountRef} sx={{ top: "0px", position: "absolute", width: 1, height: 1 }} />;
});

export default Scene;
