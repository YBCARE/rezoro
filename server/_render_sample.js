'use strict';
const fs = require('fs');
const path = require('path');
const { generatePrintCard } = require('./fancard-print');

const SP = process.argv[2];                                  // scratchpad dir
const img = name => fs.readFileSync(path.join(SP, name));    // → Buffer

const samples = [
  { tier: 'gold',   celebName: 'Leonardo DiCaprio', celebImageSrc: img('leo.jpg'),     fanName: 'Fabian Yusuf',   country: 'Nigeria',        ref: 'RZ-260723-A4F91C', edition: '017 / 500' },
  { tier: 'silver', celebName: 'Zendaya',           celebImageSrc: img('zendaya.jpg'), fanName: 'Amara Okafor',   country: 'United Kingdom', ref: 'RZ-260723-B7C22D', edition: '042 / 500' },
  { tier: 'bronze', celebName: 'Pedro Pascal',      celebImageSrc: img('pedro.jpg'),   fanName: 'Diego Martinez', country: 'Spain',          ref: 'RZ-260723-C1E88A', edition: '103 / 500' },
];

(async () => {
  for (const s of samples) {
    const buf = await generatePrintCard(s);
    fs.writeFileSync(path.join(SP, `card-${s.tier}.png`), buf);
    console.log(s.tier, buf.length, 'bytes');
  }
})().catch(e => { console.error(e); process.exit(1); });
