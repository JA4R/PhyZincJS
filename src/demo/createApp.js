import './index.css';
import Zinc from "zincjs";
import { PhyZinc } from "../phyZinc.js"

export async function createApp() {
  const phyZinc = new PhyZinc();
  console.log("Initialise rapier")
  await phyZinc.initialise();
  console.log("here")
  const renderElt = document.getElementById('root');
  const renderer = new Zinc.Renderer(renderElt, window);
  phyZinc.attach(renderer);
  Zinc.defaultMaterialColor = 0xFFFF9C;
  const metaURL = "/body_metadata.json"
  phyZinc.importZincMetadata("test", metaURL);
  return renderer;
}
