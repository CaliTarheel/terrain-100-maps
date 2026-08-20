# Terrain / 100

**Live site:** <https://terrain-100-maps.srider.chatgpt.site/>

**Public source:** <https://github.com/CaliTarheel/terrain-100-maps>

Terrain / 100 classifies a real-world location into a measured 100-meter tactical
hex map inspired by the terrain vocabulary of GMT's *MBT*. It combines a map
navigator, elevation sampling, terrain controls, and PNG/JSON export. Board
layouts range from 1 × 1 through 4 × 4, with one continuous footprint and
visible seams between printable boards.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

Run `npm test` for a production build and attribution checks.

## Data and trademarks

Map data comes from OpenFreeMap, OpenMapTiles, and OpenStreetMap contributors;
elevation comes from SRTM via OpenTopoData. This is an independent derived-map
prototype, is not affiliated with GMT Games, and serves no GMT map art or source
files.

## License and attribution

Copyright © 2026 Stephen G. Rider. The code is available under the MIT License.
If you reuse or customize it, keep the copyright and license notice and credit
Stephen G. Rider. Contact: <rider.sg@gmail.com>.
