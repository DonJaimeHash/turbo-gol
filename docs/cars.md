# Cars: how to add a body

A car in Turbogol is a look, never physics. Every car, in every mode and every match, is a
`CarPreset.Standard` car: the same hitbox (120.5 x 86.7 x 38.7 uu), wheels, suspension and
handling. Ranked and counted matches run stock physics, so a car body can change nothing the
simulation sees. What a new car adds is a body geometry, a wheel style and a few livery numbers,
drawn with the material, meshes and pipelines every car already uses: no draw call, no pipeline,
no shader compile.

The default car is the dune runner (`dune`). Four more are reserved in the catalog with status
`'soon'`: `pampero`, `carpincho`, `condor` and `tero`. Each already has its module in
`src/render/cars/` exporting `null`; until it exports a body, the car draws the dune runner.

## Where things live

| file | owns |
|---|---|
| `src/game/cosmetics.ts` | the catalog: `CarId`, menu order, price in host points (one table), status, the locale keys. Pure data, no imports; the community nodes' bundle must never import it (tested) |
| `src/game/carSelection.ts` | the player's pick (`turbogol.car`), only a car the player is entitled to; `entitledCars()` is where the inventory will plug in; `previewCarsAllowed` gates the preview flags |
| `src/render/cars/types.ts` | the contract: `CarBodySpec`, `BodyKit`, `LiverySpec`, `WheelStyle`, `WheelPlacement`, `WheelAt` |
| `src/render/cars/kit.ts` | `CAR_KIND`, the stock surfaces, team colours, `BOOST_NOZZLE_*`, the tyre numbers the shader compiles, the budgets and ranges, `tag` / `tagBy` / `loft` / `section` / `tube` / `mergeParts`, `resolveWheels` (where the wheels are drawn), the kit a body builds with and `buildBody` (merge, containment guard, translate) |
| `src/render/cars/wheels.ts` | the shared wheel styles (`KNOBBY`, `SLICK`) and `buildWheel` |
| `src/render/cars/<id>.ts` | one module per catalog car: `dune.ts` (the dune runner), and `pampero.ts`, `carpincho.ts`, `condor.ts`, `tero.ts` waiting for their bodies |
| `src/render/cars/index.ts` | the registry (`carBody(id)`); it reads every car's module and never needs editing |
| `src/render/cars/cache.ts` | shared geometry, reference-counted |
| `src/render/Car.ts` | the shared material (the livery uniforms), flame, blob and `CarView` (`setBody`) |
| `src/game/Game.ts` | `rosterCars` (who drives what), `setCar`, the showroom camera |

Who drives what: offline and in training the player drives their own pick (`Game.localCar`), every
bot drives the default car, and online every car is the default car for now (the rosters do not
carry a car yet; that change stays out of `src/net/protocol.ts` and the other files the nodes bundle).
In previews the `#car` flag sets the offline roster's cars, bots included (see Verifying).

## Two frames

A body is built in the **build frame**: hitbox-centred uu, three's axes (+x forward, +y up, +z
right), inside `k.hl`, `k.hh`, `k.hw` (58.75, 17.83, 41.85 on Standard). `buildBody` then moves it
to the car origin, so **car-local = build + (`k.ox`, `k.oy`, `k.oz`)** = build + (13.88, 20.76, 0)
on Standard. The car origin sits at axle height, 17 uu over the floor at rest.

- Everything a body's `build(k)` writes, and everything the kit gives it (`k.nozzle`, `k.wheels`),
  is in the build frame.
- The livery (`LiverySpec`), the boost nozzles `BOOST_NOZZLE_*` and the effect attachment points
  are car-local.

The dune runner's numbers in both:

| | car-local | build frame |
|---|---|---|
| two-tone line `twoToneY` | 8.75 | -12.0 |
| chevrons x | 38..68 | 24.1..54.1 |
| panel seams x | 29, -31 | 15.1, -44.9 |
| grime y (dirty..clean) | 3..10 | -17.8..-10.8 |
| thruster exit plane (`k.nozzle.x`) | -44.1 (trails at `BOOST_NOZZLE_X` = -44.3) | -58.0 |
| thruster centre height (`k.nozzle.y`) | 19.75 (`BOOST_NOZZLE_Y`) | -1.0 |
| front wheel centre at rest (`k.wheels.front`) | x 51.25, y -3.25 | x 37.4, y -24.0 |
| floor | -17 | -37.8 |

A livery written in the build frame by mistake lands 13.9 uu back and 20.8 uu down: off the body,
silently. `tests/car-bodies.test.mjs` checks that each livery feature lands on the body's paint.

## The contract

These keep a new body at zero new pipelines (the reasons are in the code comments of `Car.ts` and
`kit.ts`; `tests/car-bodies.test.mjs` checks every registered body).

1. **One material.** A body draws with the shared car material (`acquireCarMaterial`), never its
   own, and adds no surface kind: every kind is evaluated on every car pixel, so a new kind costs
   every car. Looks come from `CAR_KIND` plus the per-vertex colour, metalness, roughness and
   emission: an amber lamp, a gold alloy or white trim are free.
2. **One vertex layout.** Exactly `position`, `normal`, `color`, `aMat`, float32, non-indexed, no
   uv. Build every part through the kit (`k.push`, `k.pushBy`, `k.box`, `k.fin`, `k.arch`,
   `k.wheelArch`): `tag` bakes the surface and drops what the material does not read. three keys
   its pipelines on the layout, so one attribute more or an index means a pipeline per body.
3. **The same meshes.** The body is one merged `Mesh` (never an `InstancedMesh`: the material
   picks the wheel graph for instanced meshes), with shadows cast and received; the wheels are the
   one `InstancedMesh` of 4 the view already has. No extra meshes: each would be a draw call, two
   more shadow draws on high and a warm-up hook.
4. **Inside the hitbox.** Design in the build frame inside `k.hl`, `k.hh`, `k.hw` (the hitbox
   minus 1.5 uu). `buildBody` squeezes a body that leaves it, which distorts it; the test requires
   no squeeze.
5. **Thrusters at the nozzles.** Twin thrusters centred on (`k.nozzle.y`, +-`k.nozzle.z`), with an
   `EXHAUST` housing whose exit plane is `k.nozzle.x` (all build frame; car-local that is
   `BOOST_NOZZLE_Y`, +-`BOOST_NOZZLE_Z` and about `BOOST_NOZZLE_X`): the flame's jets and the boost
   trails (`Effects.ts`) start there. `EXHAUST` is the two boost thrusters' kind only (the heat
   tint runs from their exit plane, and the test finds the thrusters by it): side pipes and stacks
   are `ALLOY`, `CHROME` or `DARK_METAL`.
6. **Clean, closed geometry.** Finite positions and unit normals: no coincident loft rings, no
   zero-area faces, no ring shrunk to a point and no lathe point on its axis (a zero normal is NaN
   in the shader: taper a nose or a fin tip to at least 0.3 uu). Every part is a closed solid: the
   car material is single sided, so a plane vanishes from behind (fins and wings are `k.fin` or a
   thin box). The part order is fixed (the order is the vertex order).
7. **Original design only.** No commercial game's car, name or logo. Team paint stays dominant on
   both teams: the teams separate by lightness for colour-blind players (`TEAM_PAINT`, the red is
   the darker), so look at the red version too (see Verifying).
8. **The fixed attachment points.** Some effects do not follow the body (car-local): the
   supersonic streaks leave from (-12, 8, +-44), the underglow is a 90 x 50 uu quad 1 uu under the
   hitbox, the blob shadow 70 x 60 uu. Keep the widest flank near |z| 40 around x -12 and y 8, or
   the streaks trail in the air beside a narrow body.

## Budgets

Triangles of one geometry (non-indexed, 52 bytes a vertex). A body (`budget`) or a wheel style
(`WheelStyle.budget`) declares its own, aiming for the target; a body or style above the target
says why in its module comment. The test fails when a geometry has more triangles than its declared
budget, and refuses a declared budget above the hard cap.

| | low detail (low, super low) | high detail (high, ultra) |
|---|---|---|
| body target | 2,000 | 3,500 |
| body hard cap | 2,400 | 4,200 |
| wheel target (one geometry, 4 instances) | 440 | 820 |
| wheel hard cap | 500 | 900 |
| the dune runner today | body 1,974, wheel 440 | body 3,478, wheel 820 |

Draw calls per car do not change: body + wheels, plus the flame while boosting and the blob when
the tier shows it (2 shadow draws per key light on high and ultra). A body costs about 0.3 MB
(low) / 0.55 MB (high) of vertex data per team in use: cars of the same body, team and detail share
one geometry (`cache.ts`), and so do their wheels, except on super low, where every car keeps its
own wheels (its wheels instance through vertex attributes, which three r186 disposes along with a
geometry: `CarView.ownWheels`).

## The kit

What `build(k)` gets, besides the frame numbers (`k.hl`, `k.hh`, `k.hw`, `k.ox`, `k.oy`, `k.oz`),
`k.hi` (spend segments on high detail, keep low near half) and the team surfaces (`k.paint`,
`k.glass`, `k.strip`):

- `k.push(g, surface)`: any three geometry, one surface.
- `k.pushBy(g, pick)`: one surface per triangle, `pick(x, y, z, nx, ny, nz)` from the triangle's
  centre and face normal (build frame): a window band or a painted panel inside one loft. The kind
  never changes inside a triangle, so a band follows the part's edges: put a loft ring where it
  should start.
- `k.box(surface, sx, sy, sz, x, y, z)`: an axis-aligned box.
- `k.fin(surface, profile, thickness, plane, at)`: a polygon extruded into a closed slab, `'xy'`
  for a vertical fin across z, `'xz'` for a wing across y, centred on `at`.
- `k.arch(wx, rv, opts)`: the dune runner's arch (its knobby tyre, its band 20..`hw` - 0.25).
- `k.wheelArch(k.wheels.front, opts)`: an arch over the body's own wheels, wherever its
  `WheelPlacement` puts them (any `outer`, width, size or tyre), its band from 1 uu inside the
  tyre to 2.6 uu past it.
- `k.wheels.front` / `.back` (`WheelAt`): x, centre height at rest, outer radius and the tyre's
  inner and outer |z|, from the same `resolveWheels` CarView draws the wheels with: fenders,
  mudflaps and pods follow them.
- `k.nozzle`: the thrusters' exit plane x, centre height and z.
- `loft(rings, seg, n)` with `section(x, w, y0, y1, zc)` rings; a ring can carry its own exponent
  `n` (a crease sharpening along the part) and `hvNeg`, a different half height on its -v side (a
  flat floor under a round top). `tube(a, b, r, seg)` is a cylinder between two points.

## The livery (`LiverySpec`)

The material paints a livery on the body's `PAINT` surfaces from numbers the body declares, in
car-local uu (see Two frames). They reach the shader as five per-object uniforms read from the body
mesh (`Car.ts` `packLivery`, `liveryUniforms`): one material, one shader and one pipeline for
every body.

| field | dune runner | what it does | off |
|---|---|---|---|
| `twoToneY` | 8.75 | team paint above, gloss carbon below | `null`: paint all over |
| `pinstripe` | 0.45 | half width of the accent stripe on the two-tone line | `0` |
| `accent` | `BRAND_LIME` | the pinstripe's colour (sRGB hex) | |
| `chevrons` | x 38..68, half width 12, period 11 | chevrons on up-facing paint (normal y > 0.35) | `null` |
| `chevronTint` | 0 | the chevrons' colour, white (0) to the accent (1) | |
| `seams` | x 29 and -31, \|z\| < 18.5 | two panel grooves across the top | `null` |
| `grime` | y0 10, y1 3, amount 0.55 | dirt film: full below y1, none above y0 | `amount: 0` |
| `ao` | y0 2, y1 14 | underbody darkening below y1 | (keep one) |
| `heat` | x `BOOST_NOZZLE_X`, length 7 | `EXHAUST` heat tint from the exit plane forward | (the housings need it) |

Its limits, and the way round each:

- Seams are planes at a constant x, drawn only on up-facing paint (normal y from about 0.25)
  above the two-tone line. One seam: give its x twice. Door or hatch lines on the sides: thin
  `TRIM` or `DARK_METAL` boxes.
- The two-tone line is horizontal, and the band below it is always gloss carbon. A matte or
  differently coloured panel is a part of its own: a `TRIM` or `PAINT` surface with its own colour
  (`k.pushBy` can paint it inside a loft).
- The accent colours the pinstripe and, through `chevronTint`, the chevrons; everything else on
  the paint is the team colour.

Parts that should not get the livery use another kind: `ALLOY`, `TRIM`, `CARBON`, or the plain
`CHROME` / `DARK_METAL`.

## Wheels

The tyre is compiled into the shader and stays: unit radius, rim at 0.66, carcass at 0.93, width
18 uu, 16 knobs on high and 12 on low. A style (`WheelStyle`, plain vertex data) chooses:

- `tyre`: `'knobby'` (the knob blocks to radius 1) or `'slick'` (a smooth tread at 0.975, below
  the radius where the shader paints knob sipes, with chamfered shoulders);
- `spokes`, `spokeWidth`, `rim` (colour) and `rimFinish` (`{ metal, rough }`: dark anodised 0.75 /
  0.34, chrome 1 / 0.16), `dish` (depth as a fraction of the width) and `dishColor`;
- `bead` (the beadlock ring's colour, or `null` for none, which also drops the bolts), `bolts`
  (per face, high detail only), `hub` (`'team'` or a colour), and its `budget`.

A new style can live in the body's own module: the test collects every style the bodies use. One
id is one object (the geometry cache keys on it); `KNOBBY` stays the dune runner's, pinned.

A body places its wheels with `wheels` (`WheelPlacement`, instance-matrix values only, no shader or
geometry cost), checked against the ranges in `kit.ts`:

| field | range | dune runner | what it does |
|---|---|---|---|
| `visual` | 0.8..1.3 (`WHEEL_VISUAL_RANGE`) | 1.1 | visual radius over the physics radius |
| `outer` | 18..40.85 (`wheelOuterMax`) | 39 | the outer tyre face's distance from the centre line |
| `width` | 0.8..1.4 (`WHEEL_WIDTH_RANGE`) | 1 | tyre width over 18 uu |
| `rear` | the same | none | the rear axle's own `visual`, `outer`, `width` |

The contact point stays on the floor for either tyre. A wide tyre moves in to keep its outer face
at `outer`. `resolveWheels` turns the placement into what CarView draws and what `k.wheels` tells
the body, from one place.

## Adding a car

Each step touches the car's own lines only, so the four bodies can be built on parallel branches
and merge cleanly:

1. Fill `src/render/cars/<id>.ts`: replace its `null` with a `CarBodySpec` of the catalog id.
   `build(k)` pushes the parts through the kit, plus `wheels`, `livery` and `budget`. `dune.ts` is
   the worked example; a new wheel style goes in the same module (or in `wheels.ts`, one line).
2. In the same commit, in `src/game/cosmetics.ts`, change that car's status word in `CAR_STATUS`
   from `'soon'` to `'available'` (its line only: the blank lines between the cars keep the edits
   apart). The test requires a status of `'available'` exactly when the car has a body.
3. Its name and description are already in `src/locales/en.ts` and `es.ts` (`car.<id>`,
   `car.<id>Desc`; neutral Spanish, tú). Rewriting the description to fit the body touches its
   own two lines.
4. `npm test`: `tests/car-bodies.test.mjs` runs the contract on the new body at both details and
   both teams, its livery placement and its wheels; `tests/cosmetics.test.mjs` checks the status.
   Do not touch the dune runner's pins.
5. Look at it on every tier and both teams (below) and measure that nothing grew.

No other file changes: not the registry, no material, no shader, no node release.

## Verifying

Preview flags, on the dev server (`npm run dev`) or a build made with `VITE_PREVIEW_CARS=1`
(production builds ignore them):

- `#car=<id>[,<id>...]`: the offline roster's cars in roster order, owned or not: the player's
  first, then the bots'. `#car=<id>` is the player alone (the bots keep the dune runner: a mixed
  roster); `#car=<id>,<id>` in a 1v1 is both cars; an empty entry (`#car=,<id>`) keeps that slot's
  own car. The roster order is the player, their team mates, then the red team: in a 1v1 (the
  boot mode) entry 1 is the red bot, in a 3v3 entry 3 is the first red one.
- `#showroom=<yaw>[,<pitch>[,<slot>]]`: the showroom camera at boot, menus and HUD hidden, the sim
  held. Yaw in degrees round the car (0 the nose, 90 the right side, 180 the tail), pitch the
  height angle (12 by default, up to 89), slot the roster entry framed (the player by default). A
  bare `#showroom` orbits the player's car slowly.

The reference angles, on each tier (high and ultra by default on a desktop, Performance from
Settings > Graphics or `__game.setQuality('low')`, super low with `#superlow`):

| view | blue (the player) | red (the 1v1 bot) |
|---|---|---|
| front three-quarter | `#car=<id>&showroom=35` | `#car=<id>,<id>&showroom=35,12,1` |
| side | `#car=<id>&showroom=90,8` | `#car=<id>,<id>&showroom=90,8,1` |
| rear three-quarter | `#car=<id>&showroom=145` | `#car=<id>,<id>&showroom=145,12,1` |
| top (nose up) | `#car=<id>&showroom=180,85` | `#car=<id>,<id>&showroom=180,85,1` |

`#diag` shows the pipelines (and the linked programs on WebGL2). With the new car on a mixed
roster (`#car=<id>`: the bots keep the dune runner) they must match a dune-only roster's, in a 1v1
and a 3v3 (`__game.setMode('3v3')` in the console), on every tier, and stay flat when a car is
switched: `__game.cars[__game.playerIndex].setBody('<id>')` (or `'dune'`), then
`__game.cars[__game.playerIndex].bodyId` to confirm. (`__game.setCar` only takes a car the player
is entitled to, the dune runner for now, and under `#car` keeps the previewed one.) Compare the
draws only for the same view (free play, or a showroom angle): in the menu's orbit the count moves
with what the camera frames. Then the usual: `#webgl2`, `#compat`, `#lowgpu`, `#nancheck`, and
`npm run typecheck` and `npm test`.
