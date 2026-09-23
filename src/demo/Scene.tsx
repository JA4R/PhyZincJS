import { useImperativeHandle, forwardRef, useState, useRef, useEffect } from 'react';
import { startScene, startClothScene } from './createApp.js';
import Box from '@mui/material/Box';

type Props = {
  gravity: number;
};

export type SceneHandle = {
  restart: (gravity?: number) => void;
  pause: () => void;
};

const Scene = forwardRef<SceneHandle, Props>((props, ref) => {
  const mountRef = useRef(null);
  const [phyZinc, setPhyZinc] = useState<any>(null);

  useImperativeHandle(ref, () => ({
    restart,
    pause,
  }));

  const restart = (gravity?: number) => {
    dispose();
    initialise(mountRef, gravity === undefined ? props : { ...props, gravity });
  }

  const pause = () => {
    phyZinc.pause(!phyZinc.isPaused());
  }

  const dispose = () => {
    const domElement = phyZinc.renderer.getThreeJSRenderer().domElement;
    phyZinc.dispose();
    mountRef.current.removeChild(domElement);
  }

  const initialise = async (mountRef, props) => {
    //const obj = await startScene(mountRef.current, props.gravity);
    const obj = await startClothScene(mountRef.current);
    setPhyZinc(obj);
  };

  useEffect(() => {

    initialise(mountRef, props);

    return () => {
      dispose();
    };
  }, []);

  return <Box ref={mountRef} sx={{ top:"0px", position: "absolute", width: 1, height: 1 }}/>;
})

export default Scene;
