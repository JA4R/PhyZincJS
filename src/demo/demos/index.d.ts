export type Demo = {
  key: string;
  label: string;
  start: (mount: HTMLElement, gravity: number) => Promise<any>;
};

export const DEMOS: Demo[];
