# Turbogol

**Un juego de fútbol con autos y física, rápido, que corre en el navegador.** Manejas, saltas,
vuelas con el boost y anotas goles en 1v1, 2v2 o 3v3, contra bots o contra otras personas online. Todo
lo que ves y escuchas (la cancha, los autos, la pelota, el estadio, el cielo, los sonidos) se genera
con código; la única excepción es un subconjunto de 6 KB de una fuente libre (Barlow Condensed,
licencia SIL Open Font License) para los títulos.

**Juégalo ya: [turbo-gol.com](https://turbo-gol.com)** · Comunidad: [Discord](https://discord.gg/sPyf787aHP) (en inglés)

[Read in English](README.md) · [Cómo contribuir](CONTRIBUTING.md) · [Arquitectura](ARCHITECTURE.md) · Licencia: [AGPL-3.0](LICENSE)

## Qué tiene

- **Física a 120 Hz en WebAssembly**, con la biblioteca abierta
  [RocketSim](https://github.com/ZealanL/RocketSim) (sobre Bullet) compilada con Emscripten.
- **Gráficos modernos**: three.js con WebGPU, materiales procedurales y bloom; cae a WebGL2 si hace falta.
- **Modos**: partidos contra bots (tres dificultades, IA de equipo), práctica libre y nueve packs de
  entrenamiento (definición, atajadas, aéreos).
- **Online**:
  - casual por P2P con rollback sobre WebRTC;
  - partidas en servidor con predicción;
  - varias playlists a la vez y elección de región;
  - salas personalizadas con lista pública, código y contraseña.
- **Cuentas y competitivo**: usuario y contraseña (Google / Discord opcionales). Competitivo da un
  rating por playlist, con partidas de clasificación, rangos, ranking y penalización por abandono.
  Los invitados pueden jugar todo menos competitivo.
- **Funciones experimentales** (jugadores con cuenta, Configuración > Experimental): la calidad
  gráfica Súper bajo y presets de física (gravedad, velocidad de la pelota y del auto, boost,
  saltos, choques...) para la práctica libre y las salas P2P. Nunca cuentan para el rango ni las
  estadísticas ([docs/experimental.md](docs/experimental.md), en inglés).
- **Controles**: teclado + mouse y control a la vez, todo reasignable.

## Probarlo

Necesitas Node.js 24+ y un navegador con WebGPU (o al menos WebGL2).

```sh
git clone --recurse-submodules https://github.com/DonJaimeHash/turbo-gol.git
cd turbo-gol
npm install
npm run dev        # http://localhost:5173
```

Para los modos online, inicia el backend local (no hace falta cuenta de Cloudflare):

```sh
cd server && npm install
cp .dev.vars.example .dev.vars   # pon cualquier texto largo y aleatorio en JWT_SECRET
npm run dev
```

## Contribuir

Reportes, ideas, código, traducciones ([agrega tu idioma](CONTRIBUTING.md#translating)) y pruebas son bienvenidos: empieza por
[CONTRIBUTING.md](CONTRIBUTING.md) (en inglés) y los issues `good first issue`. Mantengamos el juego
original: nada de nombres, arte, diseños ni medidas sacados de juegos comerciales.

## Licencia

Software libre bajo la [GNU AGPL v3.0 o posterior](LICENSE). Los componentes de terceros conservan
sus licencias: ver [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). El uso del nombre y el logo sigue
una [política corta](TRADEMARKS.md).

Turbogol es un proyecto independiente, sin relación con ninguna editorial de videojuegos.
