import { useState } from 'react';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';

export type ControlAction = {
  key: string;
  label: string;
  onClick: () => void;
  variant?: 'contained' | 'outlined' | 'text';
};

export type ControlField = {
  key: string;
  label: string;
  defaultValue: string;
  helperText?: string;
  onChange: (value: string) => void;
};

type Props = {
  title?: string;
  actions: ControlAction[];
  fields?: ControlField[];
};

// Actions/fields are plain config arrays rather than hardcoded markup, so adding
// another button or numeric input later is a one-line addition at the call site.
const ControlPanel = ({ title = 'Controls', actions, fields = [] }: Props) => {
  const [open, setOpen] = useState(true);

  return (
    <Paper
      elevation={4}
      sx={{
        position: 'absolute',
        top: 16,
        left: 16,
        zIndex: 10,
        padding: 2,
        minWidth: 220,
        borderRadius: 2,
        backgroundColor: 'rgba(255, 255, 255, 0.92)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Typography variant="subtitle1" fontWeight={600}>
            {title}
          </Typography>
          <IconButton
            size="small"
            onClick={() => setOpen((prev) => !prev)}
            aria-label={open ? 'Collapse panel' : 'Expand panel'}
          >
            {open ? '−' : '+'}
          </IconButton>
        </Stack>
        <Collapse in={open}>
          <Stack spacing={1.5}>
            <Divider />
            {fields.length > 0 && (
              <Stack spacing={1.5}>
                {fields.map((field) => (
                  <TextField
                    key={field.key}
                    label={field.label}
                    type="number"
                    size="small"
                    defaultValue={field.defaultValue}
                    helperText={field.helperText}
                    onChange={(e) => field.onChange(e.target.value)}
                    fullWidth
                  />
                ))}
              </Stack>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap">
              {actions.map((action) => (
                <Button
                  key={action.key}
                  variant={action.variant ?? 'contained'}
                  size="small"
                  onClick={action.onClick}
                >
                  {action.label}
                </Button>
              ))}
            </Stack>
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
};

export default ControlPanel;
