# De la comunidad al código: el bot

## El circuito

1. **Proponer.** Cualquiera abre una propuesta con el formulario `github/ISSUE_TEMPLATE/propuesta.yml`.
   Lleva la etiqueta `propuesta`.
2. **Votar.** La comunidad vota con 👍. Cada lunes, `github/workflows/top-requests.yml` ordena
   las propuestas por votos y marca las diez primeras con `top-10`. No usa IA, así que no cuesta
   nada.
3. **Aprobar.** Un mantenedor lee el top 10 y le pone `bot:implementar` a la que quiere.
4. **Implementar.** `github/workflows/community-bot.yml` despierta a Claude, que implementa la
   propuesta en una rama, corre las pruebas y el chequeo de tipos, y abre un PR.
5. **Revisar y mergear.** Una persona revisa el PR antes de mergear. Hoy las reglas de `main`
   exigen CI en verde pero 0 aprobaciones (leído el 15/10/2026): la revisión humana es que el
   mantenedor lo lea. Con un segundo mantenedor se puede exigir una aprobación.
6. **Publicar.** El merge no llega solo a los servidores. Un tag `node-vX.Y.Z` construye y firma
   la release (`github/workflows/node-release.yml`, una plantilla que todavía no corre: se activa
   en la etapa 1 de `PRODUCCION.md`), y un mantenedor mueve el canal a mano. Subir `stable` hace
   que cada nodo tome la versión nueva cuando reinicia; subir también `minimum` obliga a los que
   están corriendo a drenar sus partidas y actualizarse, pero solo cuando vuelven a conectarse: el
   plano de control compara un nodo con `minimum` cuando el nodo saluda
   (`control-plane/controlPlane.ts:405`), y el lanzador no mira el canal mientras el nodo corre.
   Un deploy del Worker los reconecta a todos; el aviso sin reconexión llega con
   `channelChanged()` (P5 de `PRODUCCION.md`). Hoy no hay un canal canary que funcione: el campo
   existe en el protocolo pero el lanzador no lo lee. Para probar una versión antes, se la instala
   a mano en una máquina del proyecto.

## Por qué nunca hay merge automático

Los nodos de la comunidad se actualizan solos. Un PR malo mergeado sin revisión llegaría a todos
los servidores del mundo en minutos. El bot puede escribir código; publicarlo siempre requiere a
una persona y a la clave de releases. Esa clave va a vivir en un entorno de CI con aprobación
manual; todavía no: la release 0.1.0 se firmó con una clave de desarrollo en la PC del mantenedor,
y el entorno es un paso pendiente de la etapa 1 (`PRODUCCION.md`). La clave firma el manifiesto de
cada versión y el lanzador; los instaladores no se firman, llegan por HTTPS.

## Seguridad

- **Quién lo dispara:** solo quien puede poner etiquetas, es decir, quien tiene acceso de
  escritura. La acción además rechaza a usuarios sin ese acceso y a otros bots.
- **El texto de la propuesta no es confiable.** Alguien puede escribir instrucciones escondidas en
  una propuesta. Por eso el bot corre con pocas herramientas, sin secretos de deploy en el
  entorno, con una instrucción de sistema que le prohíbe tocar workflows, claves y código de
  releases, y siempre detrás de una revisión humana.
- **CODEOWNERS** para las rutas sensibles: nodos, lanzador, verificador, scripts de releases y
  `.github/`. La plantilla está en `github/CODEOWNERS`. Solo funciona junto con una regla de
  protección de `main` que exija la revisión de los dueños del código, y esa regla necesita un
  segundo mantenedor: GitHub no deja aprobar un PR propio.
- **La acción del bot no es de GitHub.** Según las notas del proyecto, el repo solo permite
  acciones de GitHub desde el 15/10/2026: hay que permitir `anthropics/claude-code-action`,
  fijada por SHA.

## Costos

- Cada implementación consume tokens de la API y minutos de GitHub Actions.
- Topes en la plantilla: `--max-turns 40`, 45 minutos por corrida y una corrida a la vez.
- El ranking semanal no usa IA.
- Una autorización por etiqueta de un mantenedor hace que el gasto sea siempre una decisión
  humana.

## Votos de los anfitriones (idea pendiente)

Darles más peso en las propuestas a quienes ponen servidores encaja con la regla de las
recompensas, pero hoy la tienda solo tiene ítems del juego. Las reacciones de GitHub no se pueden
ponderar: haría falta una página de propuestas en el sitio que lea los issues y sume votos con
peso. Hasta entonces se usan los 👍.
