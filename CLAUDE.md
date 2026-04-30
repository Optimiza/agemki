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
