import Zinc from "zincjs";
import { PhyZinc } from "../phyZinc.js"


const addSpheres = (phyZinc, radius, counts, area, position) => {
  const offset = [
    position[0] - area[0] / 2.0,
    position[1] - area[1] / 2.0,
  ]
  const increment = [
    area[0] / (counts[0] + 1),
    area[1] / (counts[1] + 1),
  ];
  for (let i = 0;  i < counts[0]; i++) {
    const x = offset[0] + increment[0] * ( i + 1 );
    for (let j = 0; j < counts[1]; j++) {
      const y = offset[1] + increment[1] * ( j + 1 );
      phyZinc.addSphere([x, y, position[2] + radius], radius, 16, 16);
    }
  }
}

const addBoxes = (phyZinc, dimension, counts, area, position) => {
  const offset = [
    position[0] - area[0] / 2.0,
    position[1] - area[1] / 2.0,
  ]
  const increment = [
    area[0] / (counts[0] + 1),
    area[1] / (counts[1] + 1),
  ];
  for (let i = 0;  i < counts[0]; i++) {
    const x = offset[0] + increment[0] * ( i + 1 );
    for (let j = 0; j < counts[1]; j++) {
      const y = offset[1] + increment[1] * ( j + 1 );
      phyZinc.addBox([x, y, position[2]], dimension);
    }
  }
}

export async function startScene(mount) {
  const phyZinc = new PhyZinc();
  await phyZinc.initialise();
  console.log("Initialised rapier")
  const renderer = new Zinc.Renderer(mount, window);
  Zinc.defaultMaterialColor = 0xFFFF9C;
  phyZinc.attach(renderer);
  phyZinc.startNewScene("test");
  phyZinc.setGravity(-9810);
  const dimension = [2000, 2000];
  const position = [0, 0, -500];
  phyZinc.addFloor(position, /*dimenstion*/dimension);
  addSpheres(phyZinc, /*radius*/30, [5, 5], [500, 500], position);
  addBoxes(phyZinc, [60, 60, 60], [5, 5], [450, 450], [0, 0, -250]);
  const metaURL = "/body_metadata.json"
  phyZinc.importZincMetadata(metaURL);
  return renderer;
}
