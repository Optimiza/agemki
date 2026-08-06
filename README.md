# AGEMKI — Achus Game Engine Mark I

Editor visual de aventuras gráficas estilo SCUMM para DOS.  
Stack: **Electron + React 18 + Zustand** (editor) · **C + Open Watcom** (motor DOS) · Target: **486DX2@66MHz, 8 MB RAM, DOS4GW**

---

## Requisitos

| Herramienta | Versión mínima | Notas |
|---|---|---|
| Node.js | 18 LTS | |
| npm | 9+ | incluido con Node |
| [Open Watcom](https://github.com/open-watcom/open-watcom-v2/releases/tag/Current-build) | 2.0 | solo para compilar el motor DOS |
| [DOSBox-X](https://dosbox-x.com/) | cualquier reciente | `mpu401=intelligent` para audio MIDI |

> El editor (Electron) no requiere Watcom. Solo es necesario para generar el `.EXE` del juego.

---

## Instalación

```bash
# 1. Clonar el repositorio
git clone https://github.com/TU_USUARIO/agemki.git
cd agemki

# 2. Instalar dependencias del editor
npm install
```

---

## Ejecución

### Editor (modo desarrollo)

```bash
npm run dev
```

Abre la ventana de Electron con hot-reload.

### Editor (build de producción)

```bash
npm run build      # compila React + main
npm run dist       # genera instalador (NSIS en Windows, DMG en Mac, AppImage en Linux)
```

El instalador queda en `dist/`.

---

## Compilar el motor DOS

Requiere Open Watcom instalado en `C:\WATCOM\`.

```bash
# Desde el panel Build del editor (recomendado)
# O manualmente:

wcc386 -bt=dos -6r -ox -w=3 resources/engine/agemki_engine.c
wcc386 -bt=dos -6r -ox -w=3 resources/engine/mididrv.c
wcc386 -bt=dos -6r -ox -w=3 resources/engine/timer.c
# ... resto de módulos

wlink system dos4gw file { agemki_engine.obj mididrv.obj timer.obj ... } name game/GAME.EXE
```

Los logs de compilación se generan en `build/build.log` y `build/watcom.log`.

---

## Ejecutar el juego en DOSBox-X

```ini
# dosbox-x.conf
[sblaster]
sbtype=sb16

[midi]
mpu401=intelligent
mididevice=default
```

```bash
dosbox-x -conf dosbox-x.conf game/GAME.EXE
```

Desde el editor no hace falta: el botón **▶ Play** (`F7`, *Build + Run*) compila
y lanza DOSBox-X con el `.EXE` recién generado.

---

## Jugar a través de un stream remoto (Moonlight y similares)

El ▶ Play lanza DOSBox-X tal cual: ventana normal, que es lo que se quiere
sentado delante de la máquina. A través de un stream remoto el puntero se va de
sitio, porque el stream manda posiciones **absolutas** mientras DOSBox-X está
integrando deltas relativos, y dentro de una ventana esos dos sistemas de
coordenadas no coinciden nunca.

Para esos casos hay un interruptor opcional, apagado por defecto:

```bash
DOSBOX_REMOTO=1 npm run dev     # o exportarlo antes de arrancar el editor
```

La tabla de verdad es explícita: la apagan `0`, `false`, `no`, `off`, la cadena
vacía o no definirla (sin distinguir mayúsculas ni espacios sobrantes), y
cualquier otro valor la enciende. Con la variable encendida, el ▶ Play añade
**dos** ajustes al lanzamiento de DOSBox-X, y ojo a la sección porque **no
comparten**:

| Ajuste | Por qué |
|---|---|
| `sdl fullscreen=true` | ataca la causa de raíz: a pantalla completa ya no hay rectángulo de ventana dentro de un escritorio, así que no queda desajuste entre las posiciones absolutas del stream y los deltas relativos de DOSBox-X. Su propia guía del ratón lo dice: el modo relativo "works well in fullscreen" y solo deriva "when running in a window" |
| `render aspect=true` | **no es cosmético.** Medido en el conf de referencia del 2026.07.02, `aspect` vale `false`, y entonces la imagen "is simply scaled to full window/fullscreen size, possibly resulting in disproportional image" (manual): la pantalla completa **estiraría** un 320×200 en vez de dejarlo 4:3 con bandas negras |

Antes eran tres ajustes de `[sdl]` (`mouse_emulation=never`, `maximize=true`,
`usesystemcursor=true`) y ninguno tocaba el origen del desajuste, que es la
ventana.

Está **apagado por defecto** porque ocupar la pantalla entera es justo lo
contrario de lo que se quiere en local: taparía el editor.

Detalles que ahorran un rato de depuración:

- Los dos van con `-set`, que **gana al `.conf`** configurado en Preferencias,
  así que no hay que editar ningún fichero de configuración.
- Es un interruptor y no una variable con los flags dentro **a propósito**:
  `-set "sdl fullscreen=true"` es un solo token que contiene un espacio, y
  ninguna shell restaura ese entrecomillado al expandir una variable. Si llega
  partido en tres tokens, DOSBox-X lo ignora **en silencio**, sin error y con
  código de salida 0, que es el peor resultado posible.
- La lee el proceso principal de Electron, o sea que tiene que estar en el
  entorno con el que arranca **el editor**. Abierto desde el Finder o el Dock no
  hereda lo que exportaste en una terminal: para esa sesión, arranca el editor
  desde la terminal.
- El log de Build dice el modo **siempre**, en los dos casos (`modo REMOTO
  (DOSBOX_REMOTO activo): …` / `modo LOCAL (DOSBOX_REMOTO apagado: …)`), y lo
  dice leyendo los flags que realmente se lanzan, no la variable. Con una sola
  de las dos líneas, un log no distinguiría "corrió en local" de "la variable no
  llegó al proceso".

---

## Estructura del proyecto

```
agemki/
├── src/
│   ├── main/           # proceso principal Electron (codegen C + DAT)
│   └── renderer/       # UI React (editor visual)
├── resources/
│   └── engine/         # motor C para DOS (wcc386)
└── game/               # salida: GAME.EXE + GAME.DAT (generados, no en git)
```

---


