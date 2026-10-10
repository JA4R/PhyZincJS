export type DemoToggle = {
  key: string;
  label: string;
  defaultChecked: boolean;
  apply: (phyZinc: any, checked: boolean) => void;
};

export type Demo = {
  key: string;
  label: string;
  start: (mount: HTMLElement, gravity: number) => Promise<any>;
  toggles?: DemoToggle[];
};

export const DEMOS: Demo[];
