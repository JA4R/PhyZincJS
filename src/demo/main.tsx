import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@emotion/react';
import { CssBaseline } from '@mui/material';
import { styled } from '@mui/system';
import Button from '@mui/material/Button';
import Input from '@mui/material/Input';
import theme from './theme.tsx';
import Scene from './Scene.tsx';

let gravity = 9.81;
const sceneRef = React.createRef();

const restart = () => {
  sceneRef.current.restart()
}

const pause = () => {
  sceneRef.current.pause()
}

const createRandomString = () => {
  return (Math.random() + 1).toString(36).substring(7);
}

let sceneKey = createRandomString();

const GravityInput = styled(Input)(
  ({ theme }) => ({
    position: "relative",
    zIndex: 1,
    color: theme.palette.secondary.main,
    width: "auto"
  })
);

const setGravity = (value: String) => {
  gravity = Number(value);
}

const gravityChange = (e: Event) => {
  setGravity(e.target.value);
}

const gravityPress = (e) => {
  if(e.keyCode == 13){
    gravityPress(e);
     // put the login here
  }
}


const ConfirmButton = styled(Button)(
  ({ theme }) => ({
    backgroundColor: theme.palette.primary.main,
    position: "relative",
    zIndex: 1,
  })
);


ReactDOM.createRoot(document.getElementById('root')!).render(
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <div style={{position: "absolute",}}>
        <GravityInput
          defaultValue="9.81"
          onKeyDown={gravityPress}
          onChange={gravityChange}
        />
        <ConfirmButton onClick={restart}>Restart</ConfirmButton>
        <ConfirmButton onClick={pause}>Pause</ConfirmButton>
      </div>
      <Scene gravity={-(9.81) * 0.1} key={sceneKey} ref={sceneRef}/>
    </ThemeProvider>,
);
