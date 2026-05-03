/*
 * runner.c — entrypoint de los tests del motor en host.
 *
 * Recibe el nombre del test como primer argumento y emite el resultado
 * por stdout (cada test define su propio formato). El test vitest del
 * lado JS invoca el binario y parsea el stdout.
 *
 * Compilación: tests/engine_host/build.mjs (clang -std=c89 -O0 -DAGEMKI_HOST_TEST).
 *
 * Tests disponibles:
 *   crc32 <string>          -> imprime CRC32(string) en hex 0xXXXXXXXX
 *   crc32_batch             -> lee strings de stdin (uno por línea), imprime hex por línea
 *   pcx_decode <pcx_file>   -> lee fichero PCX, decodifica, imprime "WxH SHA256(buffer)"
 *   astar <wm> <sx> <sy> <tx> <ty>
 *                           -> carga walkmap binario, calcula ruta A*, imprime N + waypoints
 *   astar_batch             -> lee casos "<wm> <sx> <sy> <tx> <ty>" de stdin (cachea último wm),
 *                              imprime una línea por caso con formato N|x1,y1|x2,y2|…
 *
 * Más tests se añaden en sub-etapas posteriores (Phase 3a sub-2.4+).
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "include/ag_test.h"

static int test_crc32(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr, "uso: runner crc32 <string>\n");
        return 2;
    }
    unsigned long h = ag_test_crc32(argv[2]);
    printf("0x%08lX\n", h & 0xFFFFFFFFUL);
    return 0;
}

static int test_crc32_batch(void) {
    char line[1024];
    while (fgets(line, sizeof(line), stdin)) {
        /* Quitar newline final */
        size_t n = strlen(line);
        while (n > 0 && (line[n-1] == '\n' || line[n-1] == '\r')) line[--n] = 0;
        unsigned long h = ag_test_crc32(line);
        printf("0x%08lX\n", h & 0xFFFFFFFFUL);
    }
    return 0;
}

/* Imprime el buffer decodificado en stdout en formato:
 *   <width> <height> <num_bytes>\n
 *   <hex de los N bytes>\n
 *
 * Por qué hex y no raw binarios: en Windows, stdout tiene LF→CRLF
 * translation por defecto, y un byte 0x0A en el buffer se convierte
 * a 0x0D 0x0A al salir, corrompiendo el SHA-256. El hex evita ese
 * issue completamente y funciona idéntico cross-platform.
 *
 * Coste: ~2x bytes en stdout (cada byte = 2 chars hex), pero los
 * fixtures son pequeños (32x16=512 hasta 144*16=2304 bytes), así
 * que es despreciable.
 */
static int test_pcx_decode(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr, "uso: runner pcx_decode <archivo.pcx>\n");
        return 2;
    }
    FILE* f = fopen(argv[2], "rb");
    if (!f) { fprintf(stderr, "no puedo abrir %s\n", argv[2]); return 3; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t* src = (uint8_t*)malloc(sz);
    if (!src) { fclose(f); return 4; }
    if ((long)fread(src, 1, sz, f) != sz) { free(src); fclose(f); return 5; }
    fclose(f);

    /* Buffer destino: como mucho 65535*65535 (overkill); conservador 1MB. */
    uint8_t* dst = (uint8_t*)malloc(1024 * 1024);
    if (!dst) { free(src); return 6; }
    uint16_t w = 0, h = 0;
    int ok = ag_test_pcx_decode(src, (uint32_t)sz, dst, &w, &h);
    free(src);
    if (!ok) { free(dst); fprintf(stderr, "decode failed\n"); return 7; }

    uint32_t bytes = (uint32_t)w * (uint32_t)h;
    fprintf(stdout, "%u %u %u\n", (unsigned)w, (unsigned)h, (unsigned)bytes);
    /* Emitir como hex (2 chars por byte). Evita LF→CRLF en Windows. */
    {
        uint32_t i;
        for (i = 0; i < bytes; i++) fprintf(stdout, "%02x", dst[i]);
        fputc('\n', stdout);
    }
    free(dst);
    return 0;
}

/* Carga un walkmap binario en los globals del subset A*.
 * Formato: bytes 0-1 = w (uint16 LE), 2-3 = h (uint16 LE), 4+ = w*h bytes.
 * Devuelve 0 si OK, código != 0 si error. */
static int load_walkmap(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "no puedo abrir %s\n", path); return 3; }
    uint8_t hdr[4];
    if (fread(hdr, 1, 4, f) != 4) { fclose(f); fprintf(stderr, "header corto\n"); return 4; }
    int w = hdr[0] | (hdr[1] << 8);
    int h = hdr[2] | (hdr[3] << 8);
    if (w <= 0 || h <= 0 || w > 4096 || h > 4096) {
        fclose(f); fprintf(stderr, "dimensiones invalidas %dx%d\n", w, h); return 4;
    }
    size_t total = (size_t)w * (size_t)h;
    uint8_t* bm = (uint8_t*)malloc(total);
    if (!bm) { fclose(f); return 5; }
    if (fread(bm, 1, total, f) != total) { free(bm); fclose(f); fprintf(stderr, "datos cortos\n"); return 6; }
    fclose(f);
    ag_test_walkmap_load(w, h, bm);
    free(bm);
    return 0;
}

/* Imprime ruta en formato "N|x1,y1|x2,y2|…|xN,yN\n".
 * Una sola línea para que astar_batch no se mezcle entre casos. */
static void print_path(int n, const AgTestPoint* path) {
    int i;
    printf("%d", n);
    for (i = 0; i < n; i++) printf("|%d,%d", (int)path[i].x, (int)path[i].y);
    fputc('\n', stdout);
}

static int test_astar(int argc, char** argv) {
    if (argc < 7) {
        fprintf(stderr, "uso: runner astar <walkmap_file> <sx> <sy> <tx> <ty>\n");
        return 2;
    }
    int rc = load_walkmap(argv[2]);
    if (rc != 0) return rc;
    int16_t sx = (int16_t)atoi(argv[3]);
    int16_t sy = (int16_t)atoi(argv[4]);
    int16_t tx = (int16_t)atoi(argv[5]);
    int16_t ty = (int16_t)atoi(argv[6]);
    AgTestPoint pts[4096];   /* cota holgada: WM_MAX_W*WM_MAX_H = 4000 */
    int n = ag_test_astar(sx, sy, tx, ty, pts, (int)(sizeof(pts)/sizeof(pts[0])));
    print_path(n, pts);
    return 0;
}

/* Lee casos "<walkmap_path> <sx> <sy> <tx> <ty>" desde stdin y emite una
 * línea por caso. Cachea el último walkmap_path para evitar relectura
 * cuando varios casos comparten mapa (típico: 10 casos por mapa). */
static int test_astar_batch(void) {
    char line[1024];
    char prev_wm[512];
    prev_wm[0] = 0;
    while (fgets(line, sizeof(line), stdin)) {
        size_t n = strlen(line);
        while (n > 0 && (line[n-1] == '\n' || line[n-1] == '\r')) line[--n] = 0;
        if (n == 0) continue;
        char path[512];
        int sx, sy, tx, ty;
        if (sscanf(line, "%511s %d %d %d %d", path, &sx, &sy, &tx, &ty) != 5) {
            fprintf(stderr, "linea malformada: %s\n", line);
            return 2;
        }
        if (strcmp(path, prev_wm) != 0) {
            int rc = load_walkmap(path);
            if (rc != 0) return rc;
            strncpy(prev_wm, path, sizeof(prev_wm) - 1);
            prev_wm[sizeof(prev_wm) - 1] = 0;
        }
        AgTestPoint pts[4096];
        int len = ag_test_astar((int16_t)sx, (int16_t)sy, (int16_t)tx, (int16_t)ty,
                                pts, (int)(sizeof(pts)/sizeof(pts[0])));
        print_path(len, pts);
    }
    return 0;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "uso: runner <test> [args...]\n");
        fprintf(stderr, "tests: crc32, crc32_batch, pcx_decode, astar, astar_batch\n");
        return 2;
    }
    const char* test = argv[1];
    if (strcmp(test, "crc32")        == 0) return test_crc32(argc, argv);
    if (strcmp(test, "crc32_batch")  == 0) return test_crc32_batch();
    if (strcmp(test, "pcx_decode")   == 0) return test_pcx_decode(argc, argv);
    if (strcmp(test, "astar")        == 0) return test_astar(argc, argv);
    if (strcmp(test, "astar_batch")  == 0) return test_astar_batch();
    fprintf(stderr, "test desconocido: %s\n", test);
    return 2;
}
