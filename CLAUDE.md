# CLAUDE.md — AGEMKI v32
Editor aventuras SCUMM → DOS | Electron + C/Open Watcom | Target: 486DX2@66MHz, 8MB RAM, DOS4GW 32-bit

## Restricciones Críticas
| Parámetro | Valor | Impacto |
|-----------|-------|---------|
| CPU | 486DX2/66MHz (27 MIPS) | Tablas precomputadas, sin bucles complejos |
| RAM | 8MB (7.3MB extended) | DAT < 2MB; stack > malloc |
| Video | VGA 13h 320×200×256 | 64KB framebuffer, sprites ≤ 256×256 |
| Timer | ISR IRQ0 @ 18.2 Hz | **Chain interrupts, NUNCA reemplazar** |
| Audio | MPU-401 @ 0x330 | Cola circular 256B, flush ≤ 32B/frame |
| Charset | ISO-8859-1 | Compatible PC Spanish |

## Zonas y Archivos
| Zona/Archivo | Tech/Estado | Notas |
|---|---|---|
| `src/renderer/` | React 18 + Zustand | Editor UI |
| `src/main/` | Node.js | Codegen C + DAT |
| `resources/engine/` | C + asm Watcom | Motor: VGA, input, pathfind, inventory, verbos |
| `src/main/index.js` | Modificar | IPC handlers, build |
| `src/main/datGenerator.js` | Modificar | Generador DAT |
| `resources/engine/agemki_engine.c` | Modificar | Motor core |
| `resources/engine/mididrv.c` | Cuidado | API MIDI pública |
| `resources/engine/mpu.c` | **Congelado** | Driver HW MPU-401, NO tocar |
| `documentation/` | Solo lectura | No modificar |

## Pipeline
`game.json → codegen → C+DAT → wcc386 -bt=dos -6r -ox → wlink dos4gw → GAME.EXE → DOSBox-X (mpu401=intelligent)`
**Logs:** `build/build.log` | `build/watcom.log` | `build/ENGINE.LOG` | `build/AUDIO.LOG`

## Top 8 Pitfalls
1. **ISR chain roto** → `_chain_intr()` en timer.c
2. **Buffers inventario compartidos** → sprites corruptos al cambiar room
3. **DAT chunks sin ordenar** → binary search falla (ordenar lexicográficamente)
4. **AUDIO.DAT formato XMI** → sin sonido (usar MIDI Format 0/1)
5. **DOSBox sin `mpu401=intelligent`** → sin audio
6. **Bucles bloqueantes en scripts** → input congelado
7. **Sin DOS4GW** → no arranca
8. **PCX > 256×256** → memory overflow

## Convenciones
- **Prefijos:** `g_*` globals | `engine_*` API pública | `mdrv_*` MIDI driver | `mpu_*` HW
- **C:** Sin stdlib; Watcom pragmas + inline asm; no malloc en runtime
- **JS:** React hooks, Zustand, template strings para codegen
- **DAT:** Chunks ordenados por `(type, id_crc32)`, CRC32 obligatorio
- **Audio:** Solo vía `mididrv.c` API, nunca acceso directo a MPU
- `?` al inicio del mensaje → solo explicar, NO generar código
- `g_script_running=1` durante handler → bloquea input excepto ESC
- Pending action **ANTES** de `engine_walk_char_to_obj()`

## Formato DAT (AGMK)
```
HEADER(16B): "AGMK" | v0x0100 | num_chunks | data_offset | CRC32
CHUNK TABLE(N×16B): [type(4), id_crc32(4), offset(4), size(4)] × N — ORDENADO LEX
DATA AREA: chunks consecutivos
```
Tipos: `GLBL` `ROOM` `CHAR` `VERB` `SEQU` `DLNG` `PCX_` `FONT` `MIDI` `TEXT`

## Triggers (v32)
```c
engine_on_enter_room(room_id, fn)
engine_on_exit_room(room_id, fn)
engine_on_verb_object(verb_id, obj_id, fn)
engine_on_verb_inv(verb_id, inv_obj_id, fn)    // NUEVO v32
engine_on_usar_con(inv_obj_id, target_id, fn)  // NUEVO v32
```

## Compilación Watcom
```bash
wcc386 -bt=dos -6r -ox -w=3 archivo.c
wlink system dos4gw file { archivo.obj engine.obj ... } name GAME.exe
# Watcom: C:\WATCOM\BINW\wcc386.exe | -6r=registros(mejor) -ox=velocidad -w=3=warnings
```

## Documentación
- `documentation/FETCH-SYSTEM.md` — Q&A rápido (audio, MIDI, DAT, compilar)
- `documentation/CONTEXT7-AGEMKI.md` — Arquitectura completa
- `documentation/AUDIO-GUIDE.md` — OPL2/OPL3/AWE32 multi-tarjeta (v33+)
- `src/main/dat/AGEMKI_DAT_SPEC.md` — Formato DAT binario detallado
- `documentation/legacy/agemki-doc-v32.txt` — Doc maestra histórica
- `documentation/legacy/open-watcom-guide.pdf` — Manual compilador Watcom

## MCP (`mcp-servers/watcom-context/`)
`fetch_watcom_documentation` | `context7_agemki` | `fetch_c90s_best_practices`

## Checklist Código C
- [ ] Compatible `wcc386 -bt=dos` · Respeta 8MB · Chain ISR (no reemplazar) · I/O no bloqueante · Prefijos `g_*`/`engine_*` · Comentarios explican hw

---

## Workflow TDD (obligatorio antes de commitear cambios importantes)

Hay una suite de tests en `tests/` y goldens del codegen en `goldens/`.
El hook `.claude/hooks/run-tests-on-edit.sh` corre los tests del área
editada en cada `Edit/Write` automáticamente — es la **primera red de
seguridad** mientras editas.

Como trabajas solo en `main` sin PRs, la segunda red es manual:
ejecutar `npm test` antes de commitear cambios importantes. Esa es la
última oportunidad para mantener `main` verde.

### Flujo de trabajo

1. **Antes de tocar codegen JS o motor C:** `npm test` debe pasar.
2. Reproduce el bug o documenta el cambio con un test que falle (en
   `tests/unit/stores/` para stores, `tests/golden/` para codegen).
3. Implementa hasta que pase.
4. **Si el cambio modifica salida determinística** (`.DAT`, `agemki_dat.h`,
   `main.c`):
   - Ejecuta `/golden-update` (skill) y revisa `git diff --stat goldens/`
     antes de stagear.
   - Cada cambio en `goldens/` requiere mensaje de commit con el porqué
     explícito (no el qué — el diff lo dice solo).
5. **Antes de commitear:** `npm test` final. Mantén `main` verde.

### Comandos rápidos

```bash
npm test                  # corre toda la suite en ~7s
npm run test:watch        # vitest en modo watch
npm run goldens:update    # regenera goldens y muestra diff
node tests/fixtures/builder.mjs   # regenera los fixtures binarios
```

### Pre-commit hook opcional (recomendado)

Si quieres que git bloquee commits con tests rojos sin tener que acordarte
manualmente, instala un hook local (no se commitea, vive en `.git/hooks/`).

**macOS / Linux**:
```bash
cat > .git/hooks/pre-commit <<'EOF'
#!/bin/sh
npm test --silent
EOF
chmod +x .git/hooks/pre-commit
```

**Windows (Git for Windows + PowerShell)**:
```powershell
@"
#!/bin/sh
npm test --silent
"@ | Set-Content -Encoding ASCII -NoNewline .git/hooks/pre-commit
```

Git for Windows interpreta el shebang con su bash interno, no hace falta
ningún `chmod`. Saltable con `git commit --no-verify` cuando quieras
commitear WIP a medias, en cualquier OS.

### Convención de idioma (mandatorio en repo)

Todo lo que entra al repo va en **español**: docs, READMEs, comentarios
in-source y mensajes de commit. Excepciones: identificadores de código y
nombres de comandos shell (pueden quedar en inglés). Detalle en
`tests/README.md` (sección "Convención de idioma").

### Mensajes de commit como única narrativa

Trabajando solo sin PRs, el `git log` es la única documentación
posterior del porqué de cada cambio. Cuida los mensajes: una línea
resumen + cuerpo con la motivación (no el qué — el diff lo dice solo).

### Bugs documentados

Cualquier hallazgo durante el trabajo se anota en `tests/FINDINGS.md`
con severidad, reproducción, impacto y fix sugerido. Es donde mirar
si tropiezas con algo raro en el codegen o el build.

### Skills de Claude Code disponibles

- **`/tdd-feature`** — pídeselo al agente cuando quieras añadir una
  feature nueva en JS (serializador del codegen, acción de store,
  handler IPC o helper puro). El skill aplica TDD estricto: escribe
  tests primero, los ejecuta para confirmar rojo, implementa lo mínimo
  para que pasen, propone commit message. Detalle en
  [`.claude/skills/tdd-feature/SKILL.md`](.claude/skills/tdd-feature/SKILL.md).
- **`/golden-update`** — invocable cuando un cambio en codegen JS altera
  los bytes generados intencionalmente. Regenera goldens, muestra el
  diff y espera tu confirmación antes de stagear. Nunca auto-commitea.
  Detalle en [`.claude/skills/golden-update/SKILL.md`](.claude/skills/golden-update/SKILL.md).
