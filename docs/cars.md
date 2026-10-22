# Cars: how to add a body

A car in Turbogol is a look, never physics. Every car, in every mode and every match, is a
`CarPreset.Standard` car: the same hitbox (120.5 x 86.7 x 38.7 uu), wheels, suspension and
handling. Ranked and counted matches run stock physics, so a car body can change nothing the
simulation sees. What a new car adds is a body geometry, a wheel style and a few livery numbers,
drawn with the material, meshes and pipelines every car already uses: no draw call, no pipeline,
no shader compile.

The default car is the dune runner (`dune`). Four more are reserved in the catalog with status
`'soon'`: `pampero`, `carpincho`, `condor` and `tero`. Until a car has a body it draws the dune
runner.

## Where things live

| file | owns |
|---|---|
| `src/game/cosmetics.ts` | the catalog: `CarId`, menu order, price in host points (one table), status, the locale keys. Pure data, no imports; the community nodes' bundle must never import it (tested) |
| `src/game/carSelection.ts` | the player's pick (`turbogol.car`), only a car the player is entitled to; `entitledCars()` is where the inventory will plug in; `previewCarsAllowed` gates the preview flags |
| `src/render/cars/types.ts` | the contract: `CarBodySpec`, `BodyKit`, `LiverySpec`, `WheelStyle`, `WheelPlacement` |
| `src/render/cars/kit.ts` | `CAR_KIND`, the stock surfaces, team colours, `BOOST_NOZZLE_*`, the tyre numbers the shader compiles, the budgets, `tag` / `loft` / `section` / `tube` / `mergeParts`, the kit a body builds with (`push`, `box`, `arch`) and `buildBody` (merge, containment guard, translate) |
| `src/render/cars/wheels.ts` | wheel styles (`KNOBBY`, `SLICK`) and `buildWheel` |
| `src/render/cars/dune.ts` | the dune runner |
| `src/render/cars/index.ts` | the registry (`BODIES`, `carBody(id)`) |
| `src/render/cars/cache.ts` | shared geometry, reference-counted |
| `src/render/Car.ts` | the shared material (the livery uniforms), flame, blob and `CarView` (`setBody`) |
| `src/game/Game.ts` | `rosterCars` (who drives what), `setCar`, the showroom camera |

Who drives what: offline and in training the player drives their own pick (`Game.localCar`), every
bot drives the default car, and online every car is the default car for now (the rosters do not
carry a car yet; that change stays out of `src/net/protocol.ts` and the other files the nodes bundle).

## The contract

These keep a new body at zero new pipelines (the reasons are in the code comments of `Car.ts` and
`kit.ts`; `tests/car-bodies.test.mjs` checks every registered body).

1. **One material.** A body draws with the shared car material (`acquireCarMaterial`), never its
   own, and adds no surface kind: every kind is evaluated on every car pixel, so a new kind costs
   every car. Looks come from `CAR_KIND` plus the per-vertex colour, metalness, roughness and
   emission: an amber lamp, a gold alloy or white trim are free.
2. **One vertex layout.** Exactly `position`, `normal`, `color`, `aMat`, float32, non-indexed, no
   uv. Build every part through the kit (`k.push`, `k.box`, `k.arch`): `tag` bakes the surface and
   drops what the material does not read. three keys its pipelines on the layout, so one attribute
   more or an index means a pipeline per body.
3. **The same meshes.** The body is one merged `Mesh` (never an `InstancedMesh`: the material
   picks the wheel graph for instanced meshes), with shadows cast and received; the wheels are the
   one `InstancedMesh` of 4 the view already has. No extra meshes: each would be a draw call, two
   more shadow draws on high and a warm-up hook.
4. **Inside the hitbox.** Design in hitbox-centred coordinates inside `k.hl`, `k.hh`, `k.hw` (the
   hitbox minus 1.5 uu). `buildBody` squeezes a body that leaves it, which distorts it; the test
   requires no squeeze.
5. **Thrusters at the nozzles.** Twin thrusters centred on `y = BOOST_NOZZLE_Y`,
   `z = +-BOOST_NOZZLE_Z`, with an `EXHAUST` housing whose exit plane is at `x = -k.hl + 0.75`
   (car-local `BOOST_NOZZLE_X`): the flame's jets and the boost trails (`Effects.ts`) start there.
6. **Clean geometry.** Finite positions, unit normals (no coincident loft rings, no zero-area
   faces: a zero normal is NaN in the shader), and a fixed part order (the order is the vertex
   order).
7. **Original design only.** No commercial game's car, name or logo. Team paint stays dominant:
   the teams separate by lightness for colour-blind players (`TEAM_PAINT`).

## Budgets

Triangles of one geometry (non-indexed, 52 bytes a vertex). A body declares its own `budget` at or
below the target; the test fails above the declared budget and refuses a budget above the cap.

| | low detail (low, super low) | high detail (high, ultra) |
|---|---|---|
| body target | 2,000 | 3,500 |
| body hard cap | 2,400 | 4,200 |
| wheel (one geometry, 4 instances) | 440 | 820 |
| the dune runner today | body 1,974, wheel 440 | body 3,478, wheel 820 |

Draw calls per car do not change: body + wheels, plus the flame while boosting and the blob when
the tier shows it (2 shadow draws per key light on high and ultra). A body costs about 0.3 MB
(low) / 0.55 MB (high) of vertex data per team in use: cars of the same body, team and detail share
one geometry (`cache.ts`).

## The livery (`LiverySpec`)

The material paints a livery on the body's `PAINT` surfaces from numbers the body declares, in
car-local uu (the car origin at axle height, x forward, y up). They reach the shader as four
per-object uniforms read from the body mesh (`Car.ts` `packLivery`, `liveryUniforms`): one
material, one shader and one pipeline for every body.

| field | dune runner | what it does | off |
|---|---|---|---|
| `twoToneY` | 8.75 | team paint above, gloss carbon below | `null`: paint all over |
| `pinstripe` | 0.45 | half width of the lime stripe on the two-tone line | `0` |
| `chevrons` | x 38..68, half width 12, period 11 | white chevrons on up-facing paint (normal y > 0.35) | `null` |
| `seams` | x 29 and -31, \|z\| < 18.5 | two panel grooves across the top | `null` |
| `grime` | y0 10, y1 3, amount 0.55 | dirt film: full below y1, none above y0 | `amount: 0` |
| `ao` | y0 2, y1 14 | underbody darkening below y1 | (keep one) |
| `heat` | x `BOOST_NOZZLE_X`, length 7 | `EXHAUST` heat tint from the exit plane forward | (the housings need it) |

Parts that should not get the livery use another kind: `ALLOY`, `TRIM`, `CARBON`, or the plain
`CHROME` / `DARK_METAL`.

## Wheel styles (`WheelStyle`)

The tyre is compiled into the shader and stays: unit radius, rim at 0.66, carcass at 0.93, width
18 uu, 16 knobs on high and 12 on low. A style chooses:

- `tyre`: `'knobby'` (the knob blocks to radius 1) or `'slick'` (a smooth tread at 0.975, below
  the radius where the shader paints knob sipes, with chamfered shoulders);
- `spokes`, `spokeWidth`, `dish` (depth as a fraction of the width), `rim` (colour, dark metal
  kind), `bolts` (beadlock bolts per face, high detail only), `hub` (`'team'` or a colour).

A body places its wheels with `wheels.visual` (visual radius over the physics radius, 1.1 on the
dune runner) and `wheels.outer` (the outer tyre face's distance from the centre line): instance
matrix values only. The contact point stays on the floor for either tyre. Styles are listed in
`WHEEL_STYLES`; one id, one geometry.

## Adding a car

1. Write `src/render/cars/<id>.ts` exporting a `CarBodySpec` with the catalog id: `build(k)`
   pushes the parts through the kit (`k.hi` picks the segment counts), plus `wheels`, `livery`
   and `budget`. `dune.ts` is the worked example.
2. Add it to `BODIES` in `src/render/cars/index.ts`.
3. In `src/game/cosmetics.ts`, move its status to `'available'`; its name and description are
   already in `src/locales/en.ts` and `es.ts` (`car.<id>`, `car.<id>Desc`; neutral Spanish, tú).
4. `npm test`: `tests/car-bodies.test.mjs` runs the contract on the new body at both details and
   both teams. Do not touch the dune runner's pins.
5. Look at it on every tier (below) and measure that nothing grew.

No other file changes: no material, no shader, no node release.

## Verifying

Preview flags, on the dev server (`npm run dev`) or a build made with `VITE_PREVIEW_CARS=1`
(production builds ignore them):

- `#car=<id>`: the player's car offline and in training is `<id>`, owned or not.
- `#showroom=<yaw>[,<pitch>]`: the showroom camera at boot, menus and HUD hidden, the sim held.
  Yaw in degrees round the car (0 the nose, 90 the right side, 180 the tail), pitch the height
  angle (12 by default, up to 89). A bare `#showroom` orbits slowly.

The four reference angles, on each tier (high and ultra by default on a desktop, Performance from
Settings > Graphics or `__game.setQuality('low')`, super low with `#superlow`):

| view | flag |
|---|---|
| front three-quarter | `#car=<id>&showroom=35` |
| side | `#car=<id>&showroom=90,8` |
| rear three-quarter | `#car=<id>&showroom=145` |
| top | `#car=<id>&showroom=0,85` |

`#diag` shows the pipelines (and the linked programs on WebGL2): with the new car on the roster
they must match the dune runner's, in a 1v1 and a 3v3, on every tier, and stay flat when the car is
switched (`__game.setCar`, or `__game.cars[0].setBody('<id>')` in the console). Then the usual:
`#webgl2`, `#compat`, `#lowgpu`, `#nancheck`, and `npm run typecheck` and `npm test`.
