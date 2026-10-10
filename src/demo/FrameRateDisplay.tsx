import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

type Props = {
  // null while waiting for the first measurement.
  framesPerSecond: number | null;
};

// Small read-only overlay in the top-right corner of the scene.
const FrameRateDisplay = ({ framesPerSecond }: Props) => (
  <Paper
    elevation={4}
    sx={{
      position: 'absolute',
      top: 16,
      right: 16,
      zIndex: 10,
      paddingX: 1.5,
      paddingY: 0.5,
      borderRadius: 2,
      backgroundColor: 'rgba(255, 255, 255, 0.92)',
      backdropFilter: 'blur(4px)',
      pointerEvents: 'none',
    }}
  >
    <Typography variant="body2" fontFamily="monospace">
      {framesPerSecond === null ? '-- FPS' : `${framesPerSecond.toFixed(0)} FPS`}
    </Typography>
  </Paper>
);

export default FrameRateDisplay;
