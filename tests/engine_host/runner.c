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
 *   crc32 <string>     -> imprime CRC32(string) en hex 0xXXXXXXXX
 *   crc32_batch        -> lee strings de stdin (uno por línea), imprime hex por línea
 *
 * Más tests se añaden en sub-etapas posteriores (Phase 3a sub-2.2+).
 */
#include <stdio.h>
#include <string.h>
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

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "uso: runner <test> [args...]\n");
        fprintf(stderr, "tests: crc32, crc32_batch\n");
        return 2;
    }
    const char* test = argv[1];
    if (strcmp(test, "crc32")        == 0) return test_crc32(argc, argv);
    if (strcmp(test, "crc32_batch")  == 0) return test_crc32_batch();
    fprintf(stderr, "test desconocido: %s\n", test);
    return 2;
}
