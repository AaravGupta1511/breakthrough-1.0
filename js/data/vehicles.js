import { G0 } from '../core/constants.js';

// Launch vehicles, approximated from public figures. Each vehicle is a list of
// burn phases fired in sequence; `dry` is the mass dropped when a phase ends
// (a spent stage or a set of boosters). Masses in kg, thrust in N, Isp in s.
// Boosters that fire alongside a core stage are folded into a combined
// first phase, so the core's remaining propellant becomes the next phase.

export const VEHICLES = [
  {
    id: 'falcon9',
    name: 'Falcon 9 Block 5',
    operator: 'SpaceX · USA',
    diameter: 3.66,
    fairing: 1900,
    payloadLEO: 22800,
    defaultPayload: 15000,
    upperStageCanRestart: true,
    phases: [
      { name: 'Stage 1 (9× Merlin 1D)', sep: 'MECO & stage separation', dry: 25600, prop: 395700, thrustSL: 7607e3, thrustVac: 8227e3, ispSL: 282, ispVac: 311 },
      { name: 'Stage 2 (Merlin Vacuum)', sep: 'SECO', dry: 3900, prop: 92670, thrustSL: 0, thrustVac: 981e3, ispSL: 0, ispVac: 348 },
    ],
  },
  {
    id: 'falconheavy',
    name: 'Falcon Heavy (expendable)',
    operator: 'SpaceX · USA',
    diameter: 3.66,
    fairing: 1900,
    payloadLEO: 63800,
    defaultPayload: 25000,
    upperStageCanRestart: true,
    phases: [
      // Side boosters at full thrust, centre core throttled to ~60 %.
      { name: '2 side boosters + centre core (27 Merlins)', sep: 'Side booster separation', dry: 51200, prop: 1029000, thrustSL: 19778e3, thrustVac: 21390e3, ispSL: 282, ispVac: 311 },
      { name: 'Centre core', sep: 'Centre core MECO & separation', dry: 28000, prop: 157700, thrustSL: 7607e3, thrustVac: 8227e3, ispSL: 282, ispVac: 311 },
      { name: 'Stage 2 (Merlin Vacuum)', sep: 'SECO', dry: 4000, prop: 92670, thrustSL: 0, thrustVac: 981e3, ispSL: 0, ispVac: 348 },
    ],
  },
  {
    id: 'sls',
    name: 'SLS Block 1',
    operator: 'NASA · USA',
    diameter: 8.4,
    fairing: 6000,
    payloadLEO: 95000,
    defaultPayload: 27000,
    upperStageCanRestart: true,
    phases: [
      // Two five-segment boosters burning alongside the core's RS-25s.
      // Average (not peak) booster thrust, consistent with 1,515 t burned in ~126 s.
      { name: '2 solid boosters + core (4× RS-25)', sep: 'Booster separation', dry: 198000, prop: 1515000, thrustSL: 34000e3, thrustVac: 37600e3, ispSL: 288, ispVac: 319 },
      // RS-25s cannot restart: the core is dropped at cutoff and the ICPS does the departure burns.
      { name: 'Core stage (4× RS-25)', sep: 'Core stage MECO & separation', dry: 85000, prop: 728000, thrustSL: 7440e3, thrustVac: 9116e3, ispSL: 366, ispVac: 452, restartable: false },
      { name: 'ICPS (RL10)', sep: 'ICPS cutoff', dry: 3500, prop: 27200, thrustSL: 0, thrustVac: 110e3, ispSL: 0, ispVac: 465 },
    ],
  },
  {
    id: 'lvm3',
    name: 'LVM3 (GSLV Mk III)',
    operator: 'ISRO · India',
    diameter: 5.0,
    fairing: 3000,
    payloadLEO: 10000,
    defaultPayload: 4000,
    upperStageCanRestart: false,
    phases: [
      { name: '2× S200 solid boosters', sep: 'S200 burnout & separation', dry: 63000, prop: 409000, thrustSL: 9000e3, thrustVac: 10300e3, ispSL: 250, ispVac: 274, solid: true },
      { name: 'L110 core (2× Vikas)', sep: 'L110 cutoff & separation', dry: 9800, prop: 116000, thrustSL: 0, thrustVac: 1598e3, ispSL: 0, ispVac: 293 },
      { name: 'C25 cryogenic upper stage', sep: 'C25 cutoff', dry: 5200, prop: 28000, thrustSL: 0, thrustVac: 200e3, ispSL: 0, ispVac: 442 },
    ],
  },
  {
    id: 'pslv',
    name: 'PSLV-XL',
    operator: 'ISRO · India',
    diameter: 2.8,
    fairing: 1150,
    payloadLEO: 3800,
    defaultPayload: 1750,
    upperStageCanRestart: true,
    phases: [
      // Average thrust consistent with the burn times (~50 s strap-ons, ~110 s PS1).
      { name: 'PS1 + 6× PSOM-XL strap-ons', sep: 'Strap-on separation', dry: 15000, prop: 136000, thrustSL: 6400e3, thrustVac: 7090e3, ispSL: 240, ispVac: 266, solid: true },
      { name: 'PS1 solid core', sep: 'PS1 separation', dry: 30200, prop: 76000, thrustSL: 3050e3, thrustVac: 3460e3, ispSL: 237, ispVac: 269, solid: true },
      { name: 'PS2 (Vikas)', sep: 'PS2 separation', dry: 5300, prop: 42000, thrustSL: 0, thrustVac: 800e3, ispSL: 0, ispVac: 293 },
      { name: 'PS3 solid', sep: 'PS3 separation', dry: 1100, prop: 7600, thrustSL: 0, thrustVac: 240e3, ispSL: 0, ispVac: 295, solid: true },
      { name: 'PS4 (2× liquid engines)', sep: 'PS4 cutoff', dry: 900, prop: 2500, thrustSL: 0, thrustVac: 14.6e3, ispSL: 0, ispVac: 308 },
    ],
  },
  {
    id: 'soyuz',
    name: 'Soyuz-2.1b',
    operator: 'Roscosmos · Russia',
    diameter: 2.95,
    fairing: 3000,
    payloadLEO: 8200,
    defaultPayload: 7100,
    upperStageCanRestart: false,
    phases: [
      { name: 'Core + 4 boosters (RD-107A/108A)', sep: 'Booster separation (Korolev cross)', dry: 15200, prop: 194000, thrustSL: 4144e3, thrustVac: 5074e3, ispSL: 260, ispVac: 319 },
      { name: 'Core stage (Block A)', sep: 'Core separation', dry: 6500, prop: 52800, thrustSL: 792e3, thrustVac: 990e3, ispSL: 255, ispVac: 319 },
      { name: 'Block I (RD-0124)', sep: 'Block I cutoff', dry: 2400, prop: 25300, thrustSL: 0, thrustVac: 294e3, ispSL: 0, ispVac: 359 },
    ],
  },
  {
    id: 'saturnv',
    name: 'Saturn V',
    operator: 'NASA · USA (1967–73)',
    diameter: 10.1,
    fairing: 4000,
    payloadLEO: 140000,
    defaultPayload: 45000,
    upperStageCanRestart: true,
    phases: [
      { name: 'S-IC (5× F-1)', sep: 'S-IC cutoff & separation', dry: 130000, prop: 2160000, thrustSL: 34020e3, thrustVac: 38700e3, ispSL: 263, ispVac: 304 },
      { name: 'S-II (5× J-2)', sep: 'S-II separation', dry: 36000, prop: 444000, thrustSL: 0, thrustVac: 5141e3, ispSL: 0, ispVac: 421 },
      { name: 'S-IVB (J-2)', sep: 'S-IVB cutoff', dry: 10000, prop: 109000, thrustSL: 0, thrustVac: 1033e3, ispSL: 0, ispVac: 421 },
    ],
  },
  {
    id: 'electron',
    name: 'Electron',
    operator: 'Rocket Lab · NZ/USA',
    diameter: 1.2,
    fairing: 50,
    payloadLEO: 300,
    defaultPayload: 200,
    upperStageCanRestart: false,
    phases: [
      { name: 'Stage 1 (9× Rutherford)', sep: 'MECO & stage separation', dry: 950, prop: 9250, thrustSL: 192e3, thrustVac: 224e3, ispSL: 285, ispVac: 311 },
      { name: 'Stage 2 (Rutherford Vacuum)', sep: 'SECO', dry: 250, prop: 2150, thrustSL: 0, thrustVac: 25.8e3, ispSL: 0, ispVac: 343 },
    ],
  },
];

// Ideal (vacuum) delta-v of the whole vehicle with a given payload, m/s.
export function vehicleDeltaV(vehicle, payload) {
  let mass = payload + vehicle.fairing + vehicle.phases.reduce((s, p) => s + p.dry + p.prop, 0);
  let dv = 0;
  vehicle.phases.forEach((p, idx) => {
    const m0 = mass;
    const m1 = mass - p.prop;
    dv += p.ispVac * G0 * Math.log(m0 / m1);
    mass = m1 - p.dry;
    if (idx === 0) mass -= vehicle.fairing; // fairing goes early in the 2nd phase
  });
  return dv;
}

export const liftoffMass = (vehicle, payload) =>
  payload + vehicle.fairing + vehicle.phases.reduce((s, p) => s + p.dry + p.prop, 0);
