import fs from 'fs';
import path from 'path';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const svgPath = path.resolve('mic.svg');
const svg = fs.readFileSync(svgPath, 'utf8');

const sizes = [16, 32, 48, 64, 128, 256];
const pngBuffers = [];

for (const size of sizes) {
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: size,
    },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();
  pngBuffers.push(pngBuffer);
}

const icoBuffer = await pngToIco(pngBuffers);
const outputPath = path.resolve('Yimly.ico');
fs.writeFileSync(outputPath, icoBuffer);
console.log(`Successfully generated multi-resolution icon at ${outputPath} (${sizes.join(', ')} px)`);
