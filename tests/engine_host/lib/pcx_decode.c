/*
 * pcx_decode.c — copia portable del decoder PCX RLE del motor.
 *
 * Origen: resources/engine/agemki_engine.c, líneas 976-1056.
 * Copiado: PcxHeader struct (976-991) + sección RLE de _pcx_decode
 * (995-1034 + return 1).
 *
 * NO incluido: la sección de aplicación de paleta VGA (1035-1054), porque
 * usa `outp(0x3C8/0x3C9)` (registro DAC de VGA), `g_pal_raw` y
 * `g_shade_lut_valid` (globals del motor). Esa parte solo se ejecuta en
 * runtime real con apply_pal=1; nuestro test pasa siempre apply_pal=0.
 *
 * Drift detection: el test `engine-host-pcx.test.js` extrae la sección
 * RLE del motor y la compara byte-a-byte con esta copia.
 *
 * Typedefs: el motor usa `u8/u16/u32` mapeados a `<stdint.h>`. En host
 * clang con AGEMKI_HOST_TEST, los mismos typedefs en `ag_test.h`.
 */
#include <stdint.h>
#include <string.h>

typedef uint8_t  u8;
typedef uint16_t u16;
typedef uint32_t u32;

/* Header PCX v5 (128 bytes) — copia exacta del motor */
#pragma pack(push,1)
typedef struct {
    u8  manufacturer;  /* 0x0A = ZSoft */
    u8  version;
    u8  encoding;      /* 1 = RLE */
    u8  bpp;           /* bits por plano */
    u16 xmin, ymin, xmax, ymax;
    u16 hdpi, vdpi;
    u8  palette[48];
    u8  reserved;
    u8  nplanes;
    u16 bytes_per_line;
    u16 palette_type;
    u8  pad[58];
} PcxHeader;
#pragma pack(pop)

/* Decodifica un PCX a un buffer de destino (debe ser w*h bytes).
 * Devuelve ancho y alto. La paleta VGA NO se aplica en host (apply_pal
 * skipped — solo presente para drift test del motor real). */
int ag_test_pcx_decode(const u8* src, u32 src_size,
                       u8* dst, u16* out_w, u16* out_h) {
    const PcxHeader* hdr = (const PcxHeader*)src;
    u16 w, h, bpl;
    u32 rle_pos, dst_pos, row, col;
    u8  b, count;

    if (hdr->manufacturer != 0x0A) return 0;
    w   = hdr->xmax - hdr->xmin + 1;
    h   = hdr->ymax - hdr->ymin + 1;
    bpl = hdr->bytes_per_line;
    *out_w = w;
    *out_h = h;

    /* Decodificar RLE con stride = w real (puede ser > AG_SCREEN_W para fuentes) */
    rle_pos = 128;
    dst_pos = 0;
    for (row = 0; row < h; row++) {
        u32 row_start = dst_pos;
        col = 0;
        while (col < bpl) {
            if (rle_pos >= src_size) break;
            b = src[rle_pos++];
            if ((b & 0xC0) == 0xC0) {
                count = b & 0x3F;
                if (rle_pos >= src_size) break;
                b = src[rle_pos++];
            } else {
                count = 1;
            }
            while (count-- && col < bpl) {
                if (col < w) dst[dst_pos++] = b;
                col++;
            }
        }
        /* Stride = w real (bpl puede incluir padding de 1 byte en PCX) */
        dst_pos = row_start + w;
    }

    return 1;
}
