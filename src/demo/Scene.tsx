import { useImperativeHandle, forwardRef, useState, useRef, useEffect, Ref } from 'react';
import { startScene } from './createApp.js';
import Box from '@mui/material/Box';

type Props = {
  gravity: number;
};

const Scene = forwardRef((props: Props, ref: Ref) => {
  const mountRef = useRef(null);
  const [phyZinc, setPhyZinc] = useState<any>(null);

  useImperativeHandle(ref, () => ({
    restart,
    pause,
  }));

  const restart = () => {
    dispose();
    initialise(mountRef, props);
  }

  const pause = () => {
    phyZinc.pause(!phyZinc.isPaused());
  }

  const dispose = () => {
    const renderer = phyZinc.renderer.getThreeJSRenderer();
    mountRef.current.removeChild(renderer.domElement);  
  }

  const initialise = async (mountRef, props) => {
    const obj = await startScene(mountRef.current, props.gravity);
    setPhyZinc(obj);
  };

  useEffect(() => {

    initialise(mountRef, props);

    console.log(mountRef)

    return () => {
      dispose();
    };
  }, []);

  return <Box ref={mountRef} sx={{ top:"0px", position: "absolute", width: 1, height: 1 }}/>;
})

export default Scene;
