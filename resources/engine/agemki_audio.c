/*
 * agemki_audio.c — Audio via mididrv (MPU-401/OPL) + SFX via Sound Blaster
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern void* engine_dat_load_audio(const char* id, unsigned long* out_size);

#include "agemki_audio.h"
#include "mididrv.h"
#include "mpu.h"
#include "timer.h"
#include "opl_patches.h"
#include "sb.h"
extern unsigned long mpu_get_bytes_sent(void);

static int      g_audio_ok   = 0;
static unsigned g_music_vol  = 127;
static FILE*    g_log        = NULL;
/* Preferencia de driver convertida a constante MDRV_HW_*.
 * Se establece con engine_audio_set_pref() antes de engine_audio_init(). */
static int      g_audio_pref = MDRV_HW_NONE;
/* ID del MIDI actualmente en reproduccion (para engine_play_midi_cont) */
static char     g_cur_midi_id[36] = "";

/* ------------------------------------------------------------------ */
/* SFX — Sound Blaster PCM                                             */
/* ------------------------------------------------------------------ */

#define SFX_FILE     "SFX.DAT"
#define SFX_MAX      64

typedef struct { unsigned long crc; unsigned long offset; unsigned long size; } SfxToc;

static SfxToc  g_sfx_toc[SFX_MAX];
static int     g_sfx_count = 0;
static FILE*   g_sfx_f     = NULL;
static int      g_sfx_ok    = 0;   /* 1 tras sb_init() + SFX.DAT OK */
static int      g_sfx_pref  = 1;   /* preferencia usuario: 1=activado */
static unsigned g_sfx_vol   = 127; /* volumen SFX 0-127 (127 = máximo) */

static unsigned long _sfx_read_u32le(FILE* f) {
    unsigned char b[4];
    if (fread(b, 1, 4, f) != 4) return 0;
    return (unsigned long)b[0] | ((unsigned long)b[1]<<8)
         | ((unsigned long)b[2]<<16) | ((unsigned long)b[3]<<24);
}

static unsigned short _sfx_read_u16le(FILE* f) {
    unsigned char b[2];
    if (fread(b, 1, 2, f) != 2) return 0;
    return (unsigned short)((unsigned short)b[0] | ((unsigned short)b[1]<<8));
}

/* CRC32 (mismo polinomio que sfxGenerator.js para coherencia) */
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

/* Carga TOC de SFX.DAT en g_sfx_toc. Devuelve 1 si OK. */
static int _sfx_open(void) {
    char magic[4]; int i; unsigned short num; unsigned short ver;
    if (g_sfx_f) { fclose(g_sfx_f); g_sfx_f = NULL; }
    g_sfx_f = fopen(SFX_FILE, "rb");
    if (!g_sfx_f) return 0;
    if (fread(magic, 1, 4, g_sfx_f) != 4 ||
        magic[0]!='S' || magic[1]!='F' || magic[2]!='X' || magic[3]!='D') {
        fclose(g_sfx_f); g_sfx_f = NULL; return 0;
    }
    num = _sfx_read_u16le(g_sfx_f);
    ver = _sfx_read_u16le(g_sfx_f);
    (void)ver;
    if (num > SFX_MAX) num = (unsigned short)SFX_MAX;
    g_sfx_count = (int)num;
    for (i = 0; i < g_sfx_count; i++) {
        g_sfx_toc[i].crc    = _sfx_read_u32le(g_sfx_f);
        g_sfx_toc[i].offset = _sfx_read_u32le(g_sfx_f);
        g_sfx_toc[i].size   = _sfx_read_u32le(g_sfx_f);
    }
    return 1;
}

/* Busqueda binaria en TOC por CRC32. Devuelve indice o -1. */
static int _sfx_find(unsigned long crc) {
    int lo = 0, hi = g_sfx_count - 1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        if      (g_sfx_toc[mid].crc == crc) return mid;
        else if (g_sfx_toc[mid].crc  < crc) lo = mid + 1;
        else                                 hi = mid - 1;
    }
    return -1;
}

static void _alog(const char* msg) {
    if (!g_log) g_log = fopen("AUDIO.LOG", "w");
    if (g_log) { fputs(msg, g_log); fputc('\n', g_log); fflush(g_log); }
}


static void _alogf(const char* fmt, const char* s, int n) {
    char buf[128];
    if (!g_log) g_log = fopen("AUDIO.LOG", "w");
    if (g_log) {
        if (s) sprintf(buf, fmt, s, n);
        else   sprintf(buf, fmt, n);
        fputs(buf, g_log); fputc('\n', g_log); fflush(g_log);
    }
}

void engine_audio_set_sfx_pref(int enabled) {
    g_sfx_pref = enabled ? 1 : 0;
    _alog(enabled ? "sfx_pref: activado" : "sfx_pref: desactivado");
}

void engine_set_sfx_volume(unsigned vol) {
    g_sfx_vol = (vol > 127) ? 127 : vol;
    _alogf("sfx_vol: %d", 0, (int)g_sfx_vol);
}

/* Establece la preferencia de driver de audio antes de engine_audio_init().
 * pref: "opl2", "mpu401" o NULL/"" para auto-detectar.
 * Llamar desde engine_init() despues de cargar CONFIG.CFG. */
void engine_audio_set_pref(const char* pref) {
    if (!pref || !pref[0])          { g_audio_pref = MDRV_HW_NONE;   return; }
    if (strcmp(pref, "opl3")   == 0)  g_audio_pref = MDRV_HW_OPL3;
    else if (strcmp(pref, "opl2")   == 0) g_audio_pref = MDRV_HW_OPL2;
    else if (strcmp(pref, "mpu401") == 0) g_audio_pref = MDRV_HW_MPU401;
    else g_audio_pref = MDRV_HW_NONE;   /* desconocido -> auto-detectar */
}

void engine_audio_init(const char* drv_dll, const char* patches_ad,
                       unsigned music_vol, unsigned sfx_vol) {
    int hw = MDRV_HW_NONE;
    int err;
    (void)drv_dll; (void)patches_ad; (void)sfx_vol;

    /* Aplicar preferencia de driver guardada en CONFIG.CFG (si la hay) */
    if (g_audio_pref != MDRV_HW_NONE) {
        mdrv_set_hw_pref(g_audio_pref);
        _alogf("audio_pref aplicada: hw=%d", 0, g_audio_pref);
    }

    _alog("=== engine_audio_init called ===");
    g_music_vol = music_vol ? music_vol : 127;

    err = mdrv_install(&hw);
    _alogf("mdrv_install: err=%d", 0, err);
    _alogf("hw_type: %d", 0, hw);

    if (err != MDRV_OK) {
        _alog("ERROR: mdrv_install fallo");
        return;
    }
    g_audio_ok = 1;
    _alog("audio_init OK");

    /* Cargar banco de instrumentos GM (GENMIDI.OP2) para drivers OPL.
     * patches_ad: ruta al fichero (normalmente "GENMIDI.OP2").
     * Solo util para OPL2/OPL3; MPU-401 usa el sintetizador externo. */
    if (hw == MDRV_HW_OPL2 || hw == MDRV_HW_OPL3) {
        /* Intentar cargar banco desde la ruta pasada como parametro */
        if (patches_ad && patches_ad[0] && !g_genmidi_loaded)
            opl_patches_load(patches_ad);
        /* Fallback: buscar GENMIDI.OP2 en el directorio actual */
        if (!g_genmidi_loaded)
            opl_patches_load("GENMIDI.OP2");
        _alogf("genmidi_loaded: %d", 0, g_genmidi_loaded);
    }

    /* Sound Blaster — SFX PCM. Solo si la preferencia esta activada. */
    if (g_sfx_pref) {
        if (sb_detect()) {
            _alogf("SB detectado: port=0x%x", 0, (int)g_sb_port);
            if (sb_init() == 0) {
                if (_sfx_open()) {
                    g_sfx_ok = 1;
                    _alogf("SFX.DAT OK: %d efectos", 0, g_sfx_count);
                } else {
                    _alog("SFX.DAT no encontrado — SFX silenciosos");
                    sb_shutdown();
                }
            } else {
                _alog("sb_init fallo — SFX silenciosos");
            }
        } else {
            _alog("Sound Blaster no detectado — SFX silenciosos");
        }
    } else {
        _alog("SFX desactivados por preferencia de usuario");
    }
}

void engine_play_midi(const char* midi_id) {
    engine_play_midi_loop(midi_id, 0);
}

/* Reproduce MIDI con control de bucle.
 * loop=1: el MIDI se repetira al terminar (musica de room).
 * loop=0: se reproduce una sola vez (secuencias, cutscenes). */
void engine_play_midi_loop(const char* midi_id, int loop) {
    unsigned long sz = 0;
    void* buf;
    int err;

    _alogf("engine_play_midi_loop: '%s'", midi_id, 0);
    _alogf("  loop=%d", 0, loop);
    if (!g_audio_ok) { _alog("  SKIP: audio_ok=0"); return; }

    engine_stop_midi();
    { int _i = 0; while (midi_id[_i] && _i < 35) { g_cur_midi_id[_i] = midi_id[_i]; _i++; } g_cur_midi_id[_i] = '\0'; }

    buf = engine_dat_load_audio(midi_id, &sz);
    if (!buf) {
        _alogf("  ERROR: '%s' no encontrado en DAT", midi_id, 0);
        return;
    }
    _alogf("  DAT load OK: sz=%d", 0, (int)sz);

    /* Detectar formato */
    { unsigned char* b = (unsigned char*)buf;
      if (sz >= 4 && b[0]=='M'&&b[1]=='T'&&b[2]=='h'&&b[3]=='d')
          _alog("  formato: MIDI (MThd)");
      else if (sz >= 4 && b[0]=='F'&&b[1]=='O'&&b[2]=='R'&&b[3]=='M')
          _alog("  formato: XMI (FORM)");
      else
          _alog("  formato: DESCONOCIDO");
    }

    err = mdrv_load_mid((const unsigned char*)buf, sz);
    free(buf);
    _alogf("  mdrv_load_mid: %d", 0, err);
    if (err != MDRV_OK) { _alog("  ERROR: load fallo"); return; }

    mdrv_set_loop(loop);
    mdrv_set_volume((unsigned char)g_music_vol);
    mdrv_play();
    _alogf("  mdrv_play OK, state=%d", 0, mdrv_state());
}

void engine_stop_midi(void) {
    _alog("engine_stop_midi");
    g_cur_midi_id[0] = '\0';
    if (!g_audio_ok) return;
    mdrv_stop();
}

/* Reproduce midi_id solo si no es el que ya está sonando. Util para rooms
 * compartidas que no deben reiniciar la música al entrar. */
void engine_play_midi_cont(const char* midi_id, int loop) {
    int _eq = 1; int _i = 0;
    while (midi_id[_i] || g_cur_midi_id[_i]) {
        if (midi_id[_i] != g_cur_midi_id[_i]) { _eq = 0; break; }
        _i++;
    }
    if (_eq && mdrv_state() == 1) {
        _alogf("engine_play_midi_cont: '%s' ya suena, continuar", midi_id, 0);
        return;
    }
    engine_play_midi_loop(midi_id, loop);
}

void engine_pause_midi(void) {
    _alog("engine_pause_midi");
    if (!g_audio_ok) return;
    mdrv_pause();
}

void engine_resume_midi(void) {
    _alog("engine_resume_midi");
    if (!g_audio_ok) return;
    mdrv_play();
}

void engine_set_music_volume(unsigned vol) {
    g_music_vol = vol > 127 ? 127 : vol;
    _alogf("engine_set_music_volume: %d", 0, (int)g_music_vol);
    if (!g_audio_ok) return;
    mdrv_set_volume((unsigned char)g_music_vol);
}

void engine_fade_music(unsigned ms) {
    _alogf("engine_fade_music: ms=%d", 0, (int)ms);
    if (!g_audio_ok) return;
    mdrv_stop();
}

int engine_midi_playing(void) {
    int s = (!g_audio_ok) ? 0 : (mdrv_state() == MDRV_STATE_PLAYING);
    return s;
}

void engine_audio_update(void) {
    static unsigned long s_update_count = 0;
    static unsigned long s_last_log = 0;
    if (g_sfx_ok) sb_update();
    if (!g_audio_ok) return;
    s_update_count++;
    mdrv_process();
    mpu_flush();
    /* Log cada 500 llamadas */
    if (s_update_count - s_last_log >= 500) {
        s_last_log = s_update_count;
        { char buf[128];
          sprintf(buf, "update=%lu state=%d irqs=%lu mpu_bytes=%lu",
              s_update_count, mdrv_state(),
              timer_get_irq_count(), mpu_get_bytes_sent());
          _alog(buf); }
    }
}

void engine_play_sfx(const char* sfx_id) {
    unsigned long crc; int idx; unsigned long sz;
    unsigned char* pcm;

    if (!g_sfx_ok || !sfx_id || !sfx_id[0]) return;
    crc = _sfx_crc32(sfx_id);
    idx = _sfx_find(crc);
    if (idx < 0) {
        _alogf("engine_play_sfx: '%s' no encontrado", sfx_id, 0);
        return;
    }
    sz  = g_sfx_toc[idx].size;
    if (sz == 0) return;
    pcm = (unsigned char*)malloc((unsigned)sz);
    if (!pcm) return;
    if (fseek(g_sfx_f, (long)g_sfx_toc[idx].offset, SEEK_SET) != 0 ||
        fread(pcm, 1, (unsigned)sz, g_sfx_f) != (unsigned)sz) {
        free(pcm); return;
    }
    /* Aplicar volumen SFX escalando las muestras PCM en el buffer temporal.
     * PCM 8-bit unsigned: 128 = silencio. Convertimos a signed, escalamos y
     * volvemos a unsigned. Solo si el volumen no es máximo (evita trabajo extra). */
    if (g_sfx_vol < 127) {
        unsigned long i;
        int vol_i = (int)g_sfx_vol;
        for (i = 0; i < sz; i++) {
            int s = ((int)pcm[i] - 128) * vol_i / 127;
            pcm[i] = (unsigned char)(s + 128);
        }
    }
    sb_play_pcm(pcm, sz, 11025);
    free(pcm);
}

void engine_stop_sfx(const char* sfx_id) {
    (void)sfx_id;
    if (g_sfx_ok) sb_stop();
}

/* Reinicia el driver de audio con la preferencia actual (g_audio_pref).
 * Llamar desde _config_audio_run() tras engine_audio_set_pref().
 * Si habia MIDI reproduciendose lo reanuda; si estaba en pausa lo rebobina. */
void engine_audio_reinit(void) {
    int hw = MDRV_HW_NONE;
    int prev_state = MDRV_STATE_STOPPED;
    _alog("engine_audio_reinit");
    if (g_audio_ok) {
        prev_state = mdrv_state();
        engine_stop_midi();
        mdrv_remove();
        g_audio_ok = 0;
    }
    if (g_audio_pref != MDRV_HW_NONE)
        mdrv_set_hw_pref(g_audio_pref);
    if (mdrv_install(&hw) != MDRV_OK) {
        _alog("engine_audio_reinit: mdrv_install fallo");
        return;
    }
    g_audio_ok = 1;
    timer_reset_pending();
    _alogf("engine_audio_reinit: hw=%d", 0, hw);
    if (hw == MDRV_HW_OPL2 || hw == MDRV_HW_OPL3) {
        if (!g_genmidi_loaded)
            opl_patches_load("GENMIDI.OP2");
    }
    if (prev_state == MDRV_STATE_PLAYING) {
        mdrv_set_volume((unsigned char)g_music_vol);
        mdrv_replay();
    } else if (prev_state == MDRV_STATE_PAUSED) {
        mdrv_set_volume((unsigned char)g_music_vol);
        mdrv_rewind();
        timer_reset_pending();
    }
}

void engine_audio_shutdown(void) {
    _alog("engine_audio_shutdown");
    if (g_sfx_ok) {
        sb_stop();
        sb_shutdown();
        g_sfx_ok = 0;
    }
    if (g_sfx_f) { fclose(g_sfx_f); g_sfx_f = NULL; }
    if (!g_audio_ok) return;
    engine_stop_midi();
    mdrv_remove();
    g_audio_ok = 0;
    if (g_log) { fclose(g_log); g_log = NULL; }
}
