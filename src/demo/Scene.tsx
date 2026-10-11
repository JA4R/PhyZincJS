import { useImperativeHandle, forwardRef, useRef, useEffect } from 'react';
import Box from '@mui/material/Box';
import type { DemoToggle, DemoEvents } from './demos/index.js';

type Props = {
  // A demo's start function (see demos/index.js); resolves to its PhyZinc.
  start: (mount: HTMLElement, gravity: number, events: DemoEvents) => Promise<any>;
  gravity: number;
  // Whether the PhyZinc frame rate counter runs; rates are reported through
  // onFrameRate (about twice a second).
  showFrameRate?: boolean;
  onFrameRate?: (framesPerSecond: number) => void;
  // The demo's own switches and their current values (by toggle key), applied
  // to each new instance and again whenever the values change.
  toggles?: DemoToggle[];
  toggleValues?: Record<string, boolean>;
  // Called when the demo dismisses its hint (see DemoEvents).
  onDismissHint?: () => void;
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

const Scene = forwardRef<SceneHandle, Props>(({ start, gravity, showFrameRate = false, onFrameRate, toggles = [], toggleValues = {}, onDismissHint }, ref) => {
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
  const togglesRef = useRef(toggles);
  togglesRef.current = toggles;
  const toggleValuesRef = useRef(toggleValues);
  toggleValuesRef.current = toggleValues;
  const onDismissHintRef = useRef(onDismissHint);
  onDismissHintRef.current = onDismissHint;
  // Read through the ref, so the demo always reaches the latest callback.
  const events: DemoEvents = { dismissHint: () => onDismissHintRef.current?.() };

  const applyToggles = (phyZinc: any) => {
    togglesRef.current.forEach((toggle) =>
      toggle.apply(phyZinc, toggleValuesRef.current[toggle.key] ?? toggle.defaultChecked));
  };

  const dispose = () => {
    if (phyZincRef.current) {
      disposeInstance(phyZincRef.current);
      phyZincRef.current = null;
    }
  };

  const initialise = async (sceneGravity: number) => {
    const generation = ++generationRef.current;
    const phyZinc = await start(mountRef.current!, sceneGravity, events);
    if (generation !== generationRef.current) {
      disposeInstance(phyZinc);
      return;
    }
    phyZincRef.current = phyZinc;
    // Each restart creates a new PhyZinc, so the counter is set up again here.
    phyZinc.addFrameRateCallback((rate: number) => onFrameRateRef.current?.(rate));
    phyZinc.setFrameRateCounterEnabled(showFrameRateRef.current);
    applyToggles(phyZinc);
  };

  // Toggling the counter on the current instance without restarting it.
  useEffect(() => {
    phyZincRef.current?.setFrameRateCounterEnabled(showFrameRate);
  }, [showFrameRate]);

  // Same for the demo's toggles: applied to the running instance, no restart.
  useEffect(() => {
    if (phyZincRef.current) applyToggles(phyZincRef.current);
  }, [toggleValues]);

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
