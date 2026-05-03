/*
 * astar.c — copia portable del pathfinding A* del motor.
 *
 * Origen: resources/engine/agemki_engine.c, líneas 1085-1214.
 * Copia byte-exact de:
 *   - typedef ANode (línea 1091)
 *   - static int _walk_passable(int gx, int gy)        (1097)
 *   - static void _snap_walkable(int* gx, int* gy)     (1104)
 *   - static int _heuristic(int ax, int ay, int bx, int by) (1118)
 *   - int engine_astar(...)                            (1124-1214)
 *
 * Globals replicados (statics propios de este módulo, igual que en el
 * motor): g_walkmap, g_wm_w, g_wm_h, g_grid_cell_w, g_astar_nodes,
 * g_astar_open, g_astar_open_n.
 *
 * El A* usa heurística Manhattan (lower bound) con multiplicador *10
 * para enteros. Costos: 10 (ortogonal) / 14 (diagonal). Tie-breaking:
 * por f mínimo, primer ocurrencia gana — comportamiento idéntico al
 * motor.
 *
 * `ag_test_walkmap_load` y `ag_test_astar` son wrappers de exposición
 * para el runner. El cuerpo de las 4 funciones del motor se mantiene
 * verbatim (drift test las compara byte-a-byte).
 */
#include <stdint.h>
#include <string.h>

typedef uint8_t  u8;
typedef uint16_t u16;
typedef int16_t  s16;
typedef uint32_t u32;

typedef struct { s16 x, y; } Point;

/* Constantes — replicadas del motor. WALKMAP_CELL_SIZE configurable
 * desde el build (en motor real con `-dWALKMAP_CELL_SIZE=N`). En host
 * fijamos a 8 (default del motor). */
#ifndef WALKMAP_CELL_SIZE
#  define WALKMAP_CELL_SIZE 8
#endif
#define WM_MAX_W (1600 / WALKMAP_CELL_SIZE)   /* max columnas */
#define WM_MAX_H (160  / WALKMAP_CELL_SIZE)   /* max filas    */

static u8  g_walkmap[WM_MAX_W * WM_MAX_H];
static int g_wm_w = (320 / WALKMAP_CELL_SIZE);   /* columnas activas de la room actual */
static int g_wm_h = (144 / WALKMAP_CELL_SIZE);   /* filas activas */
static u16 g_grid_cell_w  = WALKMAP_CELL_SIZE;

#define GRID_SZ (WM_MAX_W * WM_MAX_H)   /* 4000 nodos max */

typedef struct { s16 x, y; int g, f; int parent; u8 open, closed; } ANode;
static ANode g_astar_nodes[GRID_SZ];
/* Cola abierta simple (lista, no heap - suficiente para 40?25) */
static int g_astar_open[GRID_SZ];
static int g_astar_open_n;

static int _walk_passable(int gx, int gy) {
    if (gx < 0 || gx >= g_wm_w || gy < 0 || gy >= g_wm_h) return 0;
    return g_walkmap[gy * g_wm_w + gx] != 0;
}

/* Desplaza (gx,gy) a la celda caminable mas cercana (radio maximo 4 celdas).
 * Evita que A* falle cuando start o target caen justo en celda no caminable. */
static void _snap_walkable(int* gx, int* gy) {
    int r, dx, dy, nx, ny;
    if (_walk_passable(*gx, *gy)) return;
    for (r = 1; r <= 4; r++) {
        for (dy = -r; dy <= r; dy++) {
            for (dx = -r; dx <= r; dx++) {
                if (dx < -r || dx > r) continue;
                nx = *gx + dx; ny = *gy + dy;
                if (_walk_passable(nx, ny)) { *gx = nx; *gy = ny; return; }
            }
        }
    }
}

static int _heuristic(int ax, int ay, int bx, int by) {
    int dx = ax - bx; if (dx < 0) dx = -dx;
    int dy = ay - by; if (dy < 0) dy = -dy;
    return dx + dy;
}

int engine_astar(s16 sx, s16 sy, s16 tx, s16 ty, Point* path, int max_path) {
    int i, best, bidx, n, nx, ny, ng, idx, nidx;
    int dx[] = {1,-1,0,0, 1,-1, 1,-1};
    int dy[] = {0, 0,1,-1, 1,-1,-1, 1};
    int cost[] = {10,10,10,10,14,14,14,14};

    /* Convertir coordenadas mundo a grilla usando celda dinamica */
    int gsx = sx / g_grid_cell_w, gsy = sy / WALKMAP_CELL_SIZE;
    int gtx = tx / g_grid_cell_w, gty = ty / WALKMAP_CELL_SIZE;

    if (gsx < 0) gsx = 0; if (gsx >= g_wm_w) gsx = g_wm_w-1;
    if (gsy < 0) gsy = 0; if (gsy >= g_wm_h) gsy = g_wm_h-1;
    if (gtx < 0) gtx = 0; if (gtx >= g_wm_w) gtx = g_wm_w-1;
    if (gty < 0) gty = 0; if (gty >= g_wm_h) gty = g_wm_h-1;

    /* Ajustar start/target a celda caminable mas cercana si caen en zona bloqueada */
    _snap_walkable(&gsx, &gsy);
    _snap_walkable(&gtx, &gty);

    /* Inicializar nodos */
    memset(g_astar_nodes, 0, sizeof(g_astar_nodes));
    g_astar_open_n = 0;

    idx = gsy * g_wm_w + gsx;
    g_astar_nodes[idx].x = gsx; g_astar_nodes[idx].y = gsy;
    g_astar_nodes[idx].g = 0;
    g_astar_nodes[idx].f = _heuristic(gsx, gsy, gtx, gty);
    g_astar_nodes[idx].parent = -1;
    g_astar_nodes[idx].open = 1;
    g_astar_open[g_astar_open_n++] = idx;

    while (g_astar_open_n > 0) {
        /* Nodo con menor f */
        best = g_astar_nodes[g_astar_open[0]].f;
        bidx = 0;
        for (i = 1; i < g_astar_open_n; i++) {
            if (g_astar_nodes[g_astar_open[i]].f < best) {
                best = g_astar_nodes[g_astar_open[i]].f;
                bidx = i;
            }
        }
        idx = g_astar_open[bidx];
        /* Quitar de open */
        g_astar_open[bidx] = g_astar_open[--g_astar_open_n];
        g_astar_nodes[idx].open   = 0;
        g_astar_nodes[idx].closed = 1;

        if (g_astar_nodes[idx].x == gtx && g_astar_nodes[idx].y == gty) {
            /* Reconstruir ruta */
            n = 0;
            i = idx;
            while (i >= 0 && n < max_path) {
                path[n].x = (s16)(g_astar_nodes[i].x * g_grid_cell_w + g_grid_cell_w / 2);
                path[n].y = (s16)(g_astar_nodes[i].y * WALKMAP_CELL_SIZE + WALKMAP_CELL_SIZE / 2);
                n++;
                i = g_astar_nodes[i].parent;
            }
            /* Invertir */
            for (i = 0; i < n/2; i++) {
                Point tmp = path[i]; path[i] = path[n-1-i]; path[n-1-i] = tmp;
            }
            return n;
        }

        /* Expandir vecinos */
        for (i = 0; i < 8; i++) {
            nx = g_astar_nodes[idx].x + dx[i];
            ny = g_astar_nodes[idx].y + dy[i];
            if (nx < 0 || nx >= g_wm_w || ny < 0 || ny >= g_wm_h) continue;
            if (!_walk_passable(nx, ny)) continue;
            nidx = ny * g_wm_w + nx;
            if (g_astar_nodes[nidx].closed) continue;
            ng = g_astar_nodes[idx].g + cost[i];
            if (!g_astar_nodes[nidx].open) {
                g_astar_nodes[nidx].x = (s16)nx;
                g_astar_nodes[nidx].y = (s16)ny;
                g_astar_nodes[nidx].g = ng;
                g_astar_nodes[nidx].f = ng + _heuristic(nx, ny, gtx, gty) * 10;
                g_astar_nodes[nidx].parent = idx;
                g_astar_nodes[nidx].open = 1;
                if (g_astar_open_n < GRID_SZ)
                    g_astar_open[g_astar_open_n++] = nidx;
            } else if (ng < g_astar_nodes[nidx].g) {
                g_astar_nodes[nidx].g = ng;
                g_astar_nodes[nidx].f = ng + _heuristic(nx, ny, gtx, gty) * 10;
                g_astar_nodes[nidx].parent = idx;
            }
        }
    }
    return 0; /* sin ruta */
}

/* ── Wrappers de exposición para el runner ─────────────────────────────── */

/**
 * Carga un walkmap en los globals. Llamar antes de ag_test_astar.
 * @param w  ancho en celdas (max WM_MAX_W = 200)
 * @param h  alto en celdas  (max WM_MAX_H = 20)
 * @param bm bitmap w*h bytes (1 = walkable, 0 = block)
 */
void ag_test_walkmap_load(int w, int h, const u8* bm) {
    int gx, gy;
    g_wm_w = (w > WM_MAX_W) ? WM_MAX_W : w;
    g_wm_h = (h > WM_MAX_H) ? WM_MAX_H : h;
    memset(g_walkmap, 0, sizeof(g_walkmap));
    for (gy = 0; gy < g_wm_h; gy++)
        for (gx = 0; gx < g_wm_w; gx++)
            g_walkmap[gy * g_wm_w + gx] = bm[gy * w + gx] ? 1 : 0;
}

int ag_test_astar(s16 sx, s16 sy, s16 tx, s16 ty, Point* path, int max_path) {
    return engine_astar(sx, sy, tx, ty, path, max_path);
}
