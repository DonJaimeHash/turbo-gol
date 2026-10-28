# Audio

All of the game's sound is synthesized in code. There are no sample files: the sound effects are
Web Audio graphs and the music is an AudioWorklet. This folder holds all of it.

```
src/audio/
  Audio.ts            the AudioContext, the mix and the API the game calls (play, update, setMusic, volumes)
  engine.ts           the car engine's model (rpm, gears, load); the engine layer turns it into sound
  sfx/
    sounds.ts         THE SOUND CATALOG: one entry per one-shot (ballHit, goal, jump, ...)
    kit.ts            the toolkit sounds are built with (voice, body, note, fm, noiseLayer, click, ...)
    layers.ts         continuous layers that follow the car every frame (engine, boost, wind)
    assets.ts         buffers and waves made once (noise, room impulse, clicks, goal crowd)
  music/
    tracks/           THE SONGS: one file per track, listed in tracks/index.ts
    track.ts          what a track is (Track, Section, Chord) and section()
    engine.ts         the music engine: the band of instruments plus the sequencer that plays a track
    dsp.ts            per-sample building blocks (filters, saw, reverb parts, PRNG)
    worklet.ts        the AudioWorklet processor that runs the engine on the audio thread
```

The game reaches audio only through `Audio` (`src/game/Game.ts` owns one). Everything else here is
internal to this folder.

## Sound effects

### Change how a sound sounds

Find its entry in `sfx/sounds.ts` and edit its `play` function. The comment above each entry says
what each layer is for. Every entry follows the same shape:

```ts
padPickup: sound({
  play(k, t, big: boolean) {
    const v = k.voice(0.45, 0.1);              // level, room send (0..1)
    k.click(v, t, 2400, 0.025);                // transient: centre Hz, peak
    k.note(v, t, 1174.66, 0.06, { ratios: [1, 3], amps: [1, 0.3], decays: [0.15, 0.1] });
  },
}),
```

- `k` is the kit (`sfx/kit.ts`). The comments on its methods document every option.
- `t` is the time "now" on the audio clock. Use `t + 0.08` to start a layer 80 ms later.
- Arguments after `t` are the sound's own, such as a hit's strength or the scoring team.

### Add a new sound

1. Add an entry to `SOUNDS` in `sfx/sounds.ts`. Give it a doc comment that says what it is.
2. Play it from the game with `audio.play('yourSound', ...args)`. TypeScript checks the name and
   the arguments against the entry.
3. If the sound can fire many times in a row, give it a `minInterval`. Collisions use one, so
   stacked contacts on one frame do not pile up.

The older `audio.playBallHit(...)`-style methods are one-line shortcuts to `play()` for the
events the game already fires.

### Add a continuous layer

Some sounds run all the time and follow the car, like the engine and the boost roar. Each one is a
class in `sfx/layers.ts` that implements `Layer`:

- `update(frame)` runs every frame.
- `silence(t)` fades the layer out on pause or a hidden tab.
- `reset()` forgets the car's state.
- `stop()` stops the sources on dispose.

Build the class in `Audio.buildGraph` and add it to `layers`. Use `Target` for each AudioParam you
move. It only sends a new value when the value really changes, so a steady state costs nothing.

### Rules of thumb

- Keep sounds full-spectrum. Combine a transient (`click`), a body (`body` or `note`) and air
  (`noiseLayer`) rather than one bare oscillator.
- Use `warm: true` or `wave: 'warm'` for anything under about 150 Hz, so phone and laptop speakers
  still render it.
- A sound of 10-30 nodes is fine. Nodes free themselves when their envelope ends.
- Add a little random detune (`0.95 + Math.random() * 0.1`) to anything that repeats.

## Music

### How it works

The music engine (`music/engine.ts`) is a fixed band of instruments:

- kick
- clap and snare
- hats
- bass
- pad
- lead
- arp
- risers, crash and boom

A **track** is plain data that tells the band what to play: tempo, chords, patterns and an
arrangement for each game mode. The game only says which mode it is in (`audio.setMusic(mode,
paused)`):

- `menu`
- `play`
- `tension`, for the last 30 s and overtime
- `off`

Mode changes land on the next bar. A goal (`playGoal`) plays the track's `goal` break and then its
`afterGoal` section. The lead melody is generated from the track's scale, motifs and cadences, one
8-bar phrase at a time, so it never loops identically.

### Add a new track

1. Copy `music/tracks/kickoff.ts` to `music/tracks/yourTrack.ts`. Give it a new `id` and `title`.
2. Change the data. Every field of `Track` and `Section` is documented in `music/track.ts`. In
   short:
   - **Tempo:** `bpm`.
   - **Harmony:** `progressions`, four chords each, one per bar. Each `Chord` has a bass root,
     three pad notes and its three pitch classes. Use `alter` to raise or lower a scale note over
     that chord, for example C to C# over A major.
   - **Lead:** `leadScale`, plus the rhythm `motifs` and `cadences` it is built from.
   - **Patterns:** `brokenKick`, `bassPattern` and `arpOrder`.
   - **Arrangement:** each `section({...})` turns instruments on and off for some bars. `forms`
     lists the sections each mode loops through.
3. List the track in `TRACKS` in `music/tracks/index.ts`. Set `DEFAULT_TRACK` to it if the game
   should play it.
4. Listen and test (see below).

Notes are MIDI numbers (60 = middle C, 69 = A4). Bars have 16 steps, which are 16th notes.

To change the instruments themselves, such as the kick's tone or the reverb, edit
`music/engine.ts`. That changes every track.

### Listen without the game

```bash
node scripts/render-music.mjs private/music/kickoff.wav --track=kickoff
```

This renders a scripted timeline to a WAV file (`private/` is gitignored) and prints the CPU share and levels. The timeline
goes menu → play → goal → pause → tension → goal → off. Other options:

- `--lite` renders the voicing that super low uses.
- `--seed=N` plays a different melody.
- `--rate=44100` changes the sample rate.

### Constraints of the music code

Everything under `music/` also runs in Node (for the render script and the tests) and on the
audio thread. So in that folder:

- **No Web Audio, no DOM:** only plain math.
- **No imports from outside `music/`.**
- **Only syntax Node can strip:** no `enum`, `namespace` or constructor parameter properties.
- **No allocation in `render()`:** make every buffer in the constructor.

## Tests

- `tests/music.test.mjs` checks every listed track. Its data must be well formed, and it must
  render finite, bounded audio that repeats for the same seed.
- `tests/engine-audio.test.mjs` covers the car engine's model.
