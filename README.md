# AGEMKI — Achus Game Engine Mark I

Editor visual de aventuras gráficas estilo SCUMM para DOS.  
Stack: **Electron + React 18 + Zustand** (editor) · **C + Open Watcom** (motor DOS) · Target: **486DX2@66MHz, 8 MB RAM, DOS4GW**

---

## Requisitos

| Herramienta | Versión mínima | Notas |
|---|---|---|
| Node.js | 22 LTS | (24 también soportado) |
| npm | 10+ | incluido con Node |
| [Open Watcom](https://github.com/open-watcom/open-watcom-v2/releases/tag/Current-build) | 2.0 | solo para compilar el motor DOS |
| [DOSBox-X](https://dosbox-x.com/) | cualquier reciente | `mpu401=intelligent` para audio MIDI |

> El editor (Electron) no requiere Watcom. Solo es necesario para generar el `.EXE` del juego.

**Plataformas**: editor y suite de tests funcionan idénticos en **Windows 11** y **macOS** (verificado en CI con matrix `[macos-latest, windows-latest] x Node [22, 24]`). Detalle en [`tests/README.md`](tests/README.md#cross-platform-macos-y-windows).

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

Requiere Open Watcom v2 instalado.

**Windows** (entorno principal): Open Watcom nativo en `C:\WATCOM\`. El panel Build del editor lo invoca directamente.

**macOS**: Open Watcom v2 (la misma versión) ejecutado dentro de DOSBox-X. Produce binarios DOS bit-equivalentes a los de Windows. Útil para verificar y regenerar artefactos sin necesidad de Windows. *(Esta vía se monta como pipeline automatizada en una fase posterior — ver `.claude/plans/`.)*

```bash
# Desde el panel Build del editor (recomendado, funciona igual en mac y win)
# O manualmente:

wcc386 -bt=dos -3 -mf -ox -za99 -w3 -wcd=202 -wcd=102 -dWALKMAP_CELL_SIZE=8 resources/engine/agemki_engine.c
wcc386 -bt=dos -3 -mf -ox -za99 -w3 -wcd=202 -wcd=102 -dWALKMAP_CELL_SIZE=8 resources/engine/mididrv.c
wcc386 -bt=dos -3 -mf -ox -za99 -w3 -wcd=202 -wcd=102 -dWALKMAP_CELL_SIZE=8 resources/engine/timer.c
# ... resto de módulos

wlink system dos4g file { agemki_engine.obj mididrv.obj timer.obj ... } name game/GAME.EXE
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

---

## Estructura del proyecto

```
agemki/
├── src/
│   ├── main/           # proceso principal Electron (codegen C + DAT)
│   └── renderer/       # UI React (editor visual)
├── resources/
│   └── engine/         # motor C para DOS (wcc386)
├── tests/              # suite de tests (vitest, 219 tests JS, ~7s)
├── goldens/            # outputs binarios esperados del codegen (entran al repo)
└── game/               # salida: GAME.EXE + GAME.DAT (generados, no en git)
```

## Tests

```bash
npm test                  # corre los 219 tests JS, ~7s
npm run test:watch        # vitest en modo watch
npm run goldens:update    # regenera goldens tras cambios intencionales
```

Detalle completo (técnica, layout, troubleshooting, cómo añadir tests, workflow TDD para Claude Code) en [`tests/README.md`](tests/README.md).

---


