import Fade from '@mui/material/Fade';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

type Props = {
  text: string;
  // Fades the message out (over a second) when it becomes false.
  visible: boolean;
};

// Read-only message centred at the bottom of the scene, e.g. a demo's controls.
const HintMessage = ({ text, visible }: Props) => (
  <Fade in={visible} timeout={{ enter: 0, exit: 1000 }} unmountOnExit>
    <Paper
      elevation={4}
      sx={{
        position: 'absolute',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10,
        paddingX: 2,
        paddingY: 1,
        borderRadius: 2,
        backgroundColor: 'rgba(255, 255, 255, 0.92)',
        backdropFilter: 'blur(4px)',
        pointerEvents: 'none',
      }}
    >
      <Typography variant="body2">{text}</Typography>
    </Paper>
  </Fade>
);

export default HintMessage;
