/*
 * ag_test.h — header compartido del runner host de tests del motor.
 *
 * Cada lib/ test C expone una o más funciones públicas con prefijo
 * `ag_test_` que el runner.c puede invocar. El runner las llama según el
 * argumento de línea de comandos (ej: `runner crc32 hello`) y emite el
 * resultado por stdout en formato simple (decimal, hex, hash, etc.) que
 * el test vitest del lado JS valida.
 */
#ifndef AG_TEST_H
#define AG_TEST_H

#include <stdint.h>

unsigned long ag_test_crc32(const char* s);

/**
 * Decodifica un buffer PCX a `dst` (debe tener al menos w*h bytes).
 * Devuelve 1 si OK, 0 si magic mal o input invalido.
 * out_w/out_h reciben las dimensiones del PCX.
 *
 * Nota: NO aplica la paleta VGA (a diferencia del motor real con
 * apply_pal=1). Para tests deterministas que validen solo el RLE.
 */
int ag_test_pcx_decode(const uint8_t* src, uint32_t src_size,
                       uint8_t* dst, uint16_t* out_w, uint16_t* out_h);

/**
 * Pathfinding A* (subset portable del motor).
 * Coordenadas en píxeles mundo (no celdas). El subset convierte
 * internamente con WALKMAP_CELL_SIZE=8.
 * Devuelve la longitud de la ruta (nº de waypoints) o 0 si no hay.
 */
typedef struct { int16_t x, y; } AgTestPoint;

void ag_test_walkmap_load(int w, int h, const uint8_t* bm);
int  ag_test_astar(int16_t sx, int16_t sy, int16_t tx, int16_t ty,
                   AgTestPoint* path, int max_path);

#endif
