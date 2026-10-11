export type DemoToggle = {
  key: string;
  label: string;
  defaultChecked: boolean;
  apply: (phyZinc: any, checked: boolean) => void;
};

// Lets a running demo notify the UI.
export type DemoEvents = {
  // Fades out the demo's hint, e.g. once the user has done what it says.
  dismissHint: () => void;
};

export type Demo = {
  key: string;
  label: string;
  start: (mount: HTMLElement, gravity: number, events: DemoEvents) => Promise<any>;
  toggles?: DemoToggle[];
  // Message shown at the bottom of the scene until the demo dismisses it.
  hint?: string;
};

export const DEMOS: Demo[];
