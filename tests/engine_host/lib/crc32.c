/*
 * crc32.c — copia bit-a-bit de _sfx_crc32 desde agemki_audio.c
 *
 * Por qué no incluimos directamente la del motor: agemki_audio.c arrastra
 * dependencias HW (mididrv.h, mpu.h, sb.h) que no compilan en host.
 * Aislamos solo el algoritmo, que es 100% portable (bit math sobre uint32).
 *
 * Coherencia con el motor: el test `drift` en runner.c compara byte-a-byte
 * esta función con la que vive en resources/engine/agemki_audio.c. Si
 * alguien edita la del motor, este test falla y forzamos sincronizar.
 *
 * Coherencia con el codegen: el test `crc_vs_js` en runner.c compara las
 * salidas con valores precalculados desde sfxGenerator.js (mismo polinomio
 * 0xEDB88320). Si difieren, el motor no encontraría chunks en el TOC.
 */
static unsigned long _sfx_crc32(const char* s) {
    static unsigned long tbl[256];
    static int tbl_rdy = 0;
    unsigned long c; int i, k;
    if (!tbl_rdy) {
        for (i = 0; i < 256; i++) {
            c = (unsigned long)i;
            for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320UL ^ (c >> 1)) : (c >> 1);
            tbl[i] = c;
        }
        tbl_rdy = 1;
    }
    c = 0xFFFFFFFFUL;
    while (*s) { c = tbl[(c ^ (unsigned char)*s++) & 0xFF] ^ (c >> 8); }
    return (c ^ 0xFFFFFFFFUL);
}

unsigned long ag_test_crc32(const char* s) {
    return _sfx_crc32(s);
}
