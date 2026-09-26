# breakthrough-1.0

**Breakthrough** is a browser-based space launch and orbit simulator. You can:

- **Simulate launches** of six rockets (Falcon 9, LVM3, PSLV-XL, Soyuz-2.1b, Saturn V, Electron) from eight real launch sites. Thrust, drag, mass flow and staging are integrated step by step, with live telemetry: altitude, speed, g-load, dynamic pressure, stage and propellant.
- **Follow travel paths**: the flown trail, the predicted orbit, a ground track, and multi-burn missions:
  - circular LEO / ISS / sun-synchronous / polar orbits,
  - GTO → geostationary (Hohmann transfer plus plane change),
  - trans-lunar injection (Lambert-targeted) → lunar orbit insertion.
- **See where you are relative to celestial bodies**: altitude, lat/lon, sunlight or eclipse, and distances to the Moon, Sun and all eight planets (with light-time). There are Earth, Moon, Earth–Moon and Solar-system views.
- **Share the sky with other objects**: 1,100+ satellites (stations, GNSS, GEO, Earth observation, science, Starlink/OneWeb/Iridium) and up to 20,000 debris objects, with nearest-object tracking and conjunction alerts.

![Simulator showing a Falcon 9 mission on station in geostationary orbit](assets/screenshot.png)

## Run it

It is a static site with no build step and no npm install. Browsers block JavaScript modules on `file://` pages, so serve the folder with any static web server:

```bash
python3 -m http.server 8000      # or: npm start
# then open http://localhost:8000
```

To deploy, push the folder to any static host (GitHub Pages, Netlify, Vercel, S3). three.js is included in `vendor/`, so the site works offline and needs no CDN.

### Controls

| Action | How |
| --- | --- |
| Rotate / zoom | drag / scroll wheel or pinch |
| Select an object | click it, or use the search box |
| Pause / resume | **Space** or ❚❚ |
| Time warp | **+** / **−** or « » (capped at 50× during powered flight) |
| Skip a long coast | **N** or *Next event ⏭* |

### Preset missions via URL

`simulator.html` accepts `vehicle`, `site`, `target`, `payload`, `alt`, `inc` and `time`, for example:

```
simulator.html?vehicle=saturnv&site=ksc&target=moon&payload=45000
simulator.html?vehicle=pslv&site=shar&target=sso&payload=1750&time=2026-12-01T06:00:00Z
```

- Vehicle ids: `falcon9 lvm3 pslv soyuz saturnv electron`
- Site ids: `ksc vafb shar baikonur kourou wenchang tanegashima mahia`
- Target ids: `leo iss sso polar geo moon`

## Project structure

```
index.html              landing page
simulator.html          the simulator
css/                    base tokens, landing page and simulator styles
js/core/                physics (no DOM, runs in Node too)
  constants.js            physical constants
  time.js                 Julian date, sidereal time, ECI <-> lat/lon
  ephemeris.js            Sun, Moon and planet positions
  orbits.js               Kepler & universal-variable propagation, elements
  lambert.js              Lambert solver (used for lunar transfers)
  ascent.js               powered-ascent simulation and guidance
  mission.js              mission timeline, burns, patched conics
  population.js           batch propagation of catalogue objects
js/data/                vehicles, launch sites, satellite catalogue, debris, coastlines
js/view/                three.js scenes, labels, ground-track map, textures
js/main.js              simulator app (UI wiring and render loop)
js/hero.js              landing-page animation
tests/                  physics tests (node --test)
vendor/three/           three.js r170 (MIT)
```

## How the physics works

- **Ascent**: the rocket flies in the inertial plane that yields the requested inclination, starting with the eastward velocity of Earth's rotation. RK4 integration at 0.1 s covers gravity, altitude-dependent thrust and Isp, drag in an exponential atmosphere, throttling to a 4.5 g limit, and staging. Guidance: vertical rise → pitch kick → gravity turn → closed-loop steering above 40 km, which solves for a linear radial-acceleration profile that reaches the insertion radius with zero vertical speed. Targets above 250 km are reached with a 200 km-perigee transfer ellipse and a circularisation burn at apogee.
- **Coasting**: exact two-body conics (universal-variable propagation), so any time warp is error-free. Burns are impulsive.
- **GEO**: GTO injection at an equator crossing, then an apogee burn that circularises and removes the inclination.
- **Moon**: the parking orbit is aligned with the Moon's expected position. The code scans the next 1.5 orbits and several flight times for the cheapest Lambert arc. At the Moon's sphere of influence it switches to Moon-centred motion, trims the approach for a 100 km periselene, and brakes into a circular lunar orbit.
- **Satellites and debris**: Keplerian orbits with J2 secular drift of the node and perigee, so sun-synchronous orbits stay sun-synchronous.
- **Ephemerides**: Astronomical Almanac low-precision Sun and Moon series, and JPL's approximate Keplerian elements for the planets (1800–2050).

Typical results match real missions: Falcon 9 GTO injection ≈ 2.45 km/s, GEO apogee burn ≈ 1.84 km/s, Saturn V TLI ≈ 3.1–3.2 km/s, LOI ≈ 0.8 km/s.

## Accuracy and data

This is an educational tool, not an operational one.

- Vehicle figures approximate published data.
- Satellites use representative orbits: correct altitude, inclination and shape, and real longitudes for GEO spacecraft, but not live TLE data.
- Debris is synthetic, matching the real population's altitude and inclination structure (Fengyun-1C, Iridium–Cosmos and Cosmos 1408 clouds, GTO rocket bodies, the GEO belt).

## Tests

```bash
npm test   # Node 18+, no dependencies
```

The tests cover element conversions, propagation, Lambert targeting, sun-synchronous inclination, the ephemerides, GEO station-keeping, and end-to-end LEO, SSO, GEO and lunar missions (including an overloaded rocket that must fail).

## Credits

- [three.js](https://threejs.org) (MIT), vendored in `vendor/three/`.
- Coastlines from [Natural Earth](https://www.naturalearthdata.com) (public domain) via `world-atlas`.
