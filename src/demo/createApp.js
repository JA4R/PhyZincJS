import './index.css';
import Zinc from "zincjs";
import { PhyZinc } from "../phyZinc.js"


const addSpheres = (phyZinc, radius, counts, dimension, position) => {
  const offset = [
    position[0] - dimension[0] / 2.0,
    position[1] - dimension[1] / 2.0,
  ]
  const increment = [
    dimension[0] / (counts[0] + 1),
    dimension[1] / (counts[1] + 1),
  ];
  for (let i = 0;  i < counts[0]; i++) {
    const x = offset[0] + increment[0] * ( i + 1 );
    for (let j = 0; j < counts[1]; j++) {
      const y = offset[1] + increment[1] * ( j + 1 );
      phyZinc.addSphere([x, y, position[2] + radius], radius, 16, 16);
    }
  }
}

export async function createApp() {
  const phyZinc = new PhyZinc();
  await phyZinc.initialise();
  console.log("Initialised rapier")
  const renderElt = document.getElementById('root');
  const renderer = new Zinc.Renderer(renderElt, window);
  Zinc.defaultMaterialColor = 0xFFFF9C;
  phyZinc.attach(renderer);
  phyZinc.startNewScene("test");
  phyZinc.setGravity(-98.1);
  const dimension = [2000, 2000];
  const position = [0, 0, -500];
  phyZinc.addFloor(position, /*dimenstion*/dimension);
  addSpheres(phyZinc, /*radius*/30, [10, 10], [700, 700], position);
  const metaURL = "/body_metadata.json"
  phyZinc.importZincMetadata(metaURL);
  return renderer;
}
