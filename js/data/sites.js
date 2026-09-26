// Launch sites (geodetic latitude/longitude in degrees, east positive).
//
// `corridors` are the launch azimuths (degrees clockwise from north) that
// range safety allows, so that spent stages and any failure come down over
// the sea rather than populated land or a neighbouring country. They are
// approximate public figures. `range` explains the constraint.
// `doglegAfterKm`: how far down the corridor a vehicle must fly before it may
// turn towards a forbidden heading (see ascent.js).

export const SITES = [
  {
    id: 'ksc', name: 'Kennedy Space Center, USA', short: 'KSC', lat: 28.6082, lon: -80.6041,
    corridors: [[35, 120], [150, 200]],
    range: 'east over the Atlantic, or south along the Florida coast through the polar corridor',
  },
  {
    id: 'vafb', name: 'Vandenberg SFB, USA', short: 'Vandenberg', lat: 34.632, lon: -120.611,
    corridors: [[147, 210]],
    range: 'south over the Pacific; heading east would fly over California',
  },
  {
    id: 'shar', name: 'Satish Dhawan (Sriharikota), India', short: 'Sriharikota', lat: 13.7199, lon: 80.2304,
    corridors: [[100, 140]],
    range: 'south-east over the Bay of Bengal; heading due south would fly over Sri Lanka',
    // Far enough that both the ground track and the impact point pass east of Sri Lanka.
    doglegAfterKm: 150,
  },
  {
    id: 'baikonur', name: 'Baikonur Cosmodrome, Kazakhstan', short: 'Baikonur', lat: 45.965, lon: 63.305,
    corridors: [[20, 65]],
    range: 'north-east over Kazakhstan and Russia, keeping drop zones out of China',
  },
  {
    id: 'kourou', name: 'Guiana Space Centre (Kourou)', short: 'Kourou', lat: 5.239, lon: -52.768,
    corridors: [[349, 360], [0, 93]],
    range: 'north or east over the Atlantic',
  },
  {
    id: 'wenchang', name: 'Wenchang, China', short: 'Wenchang', lat: 19.614, lon: 110.951,
    corridors: [[90, 175]],
    range: 'east and south-east over the South China Sea',
  },
  {
    id: 'tanegashima', name: 'Tanegashima, Japan', short: 'Tanegashima', lat: 30.4, lon: 130.97,
    corridors: [[85, 175]],
    range: 'east and south-east over the Pacific',
  },
  {
    id: 'mahia', name: 'Rocket Lab LC-1 (Mahia), New Zealand', short: 'Mahia', lat: -39.262, lon: 177.865,
    corridors: [[20, 200]],
    range: 'east and south over the Pacific',
  },
];
