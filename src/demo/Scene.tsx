import { useRef, useEffect } from 'react';
import { startScene } from './createApp.js';
import Box from '@mui/material/Box';

function Scene() {
  const mountRef = useRef(null);

  useEffect(() => {

    startScene(mountRef.current);

    return () => {
      //mountRef.current.removeChild(renderer.domElement);
    };
  }, []);

  return <Box ref={mountRef} sx={{ top:"0px", position: "absolute", width: 1, height: 1 }}/>;
}

export default Scene;
