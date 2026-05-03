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

unsigned long ag_test_crc32(const char* s);

#endif
