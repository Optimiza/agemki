/* ============================================================
 * agemki_engine.c - AGEMKI Engine v1 - Implementacion
 *
 * Compilar con Open Watcom (DOS protegido, modelo FLAT/386):
 *   wcc386 -bt=dos -ms agemki_engine.c
 *
 * Dependencias: agemki_engine.h, agemki_dat.h
 * No requiere libreria de runtime salvo <string.h>, <stdlib.h>, <stdio.h>
 * ============================================================ */

#include "agemki_engine.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <ctype.h>

/* -- Acceso a puertos DOS (Open Watcom) ------------------------------------ */
#include <i86.h>     /* inp(), outp(), int86(), REGS */
#include <dos.h>     /* _dos_getvect, _dos_setvect   */
#include <conio.h>   /* kbhit(), getch()              */
#include <bios.h>    /* _bios_keybrd()                */

/* -- Debug log -> ENGINE.LOG ----------------------------------------------- */
static FILE* g_dbg = NULL;
static void _dbg_open(void)  { g_dbg = fopen("ENGINE.LOG","w"); }
static void _dbg_close(void) { if(g_dbg){fclose(g_dbg);g_dbg=NULL;} }
#define DBG(...) do{ if(g_dbg){fprintf(g_dbg,__VA_ARGS__);fflush(g_dbg);} }while(0)

/* Centra texto de ancho tw sobre posicion de pantalla px.
 * Clamp: primero right (texto no sale por la derecha), luego left. */
#define _TEXT_OX(px,tw) ((s16)(((s16)(px)-(s16)((tw)/2)+(s16)((tw))>AG_SCREEN_W-2)?(s16)(AG_SCREEN_W-(s16)(tw)-2):(s16)((px)-(s16)((tw)/2)))<2?2:(s16)(((s16)(px)-(s16)((tw)/2)+(s16)((tw))>AG_SCREEN_W-2)?(s16)(AG_SCREEN_W-(s16)(tw)-2):(s16)((px)-(s16)((tw)/2))))
/* Versión más legible usada como inline: */
static s16 _text_ox(s16 px, s16 tw) {
    s16 ox = (s16)(px - tw/2);
    if (ox + tw > AG_SCREEN_W - 2) ox = (s16)(AG_SCREEN_W - tw - 2);
    if (ox < 2) ox = 2;
    return ox;
}
void engine_log_write(const char *msg) { DBG("%s", msg); }

/* ===========================================================================
 * S1 - ESTADO INTERNO
 * =========================================================================== */

/* -- Pantalla --------------------------------------------------------------- */
static u8  g_backbuf[AG_SCREEN_PIXELS];          /* back-buffer de renderizado */
static u8  g_bgbuf[AG_SCREEN_PIXELS];             /* fondo decodificado - se restaura cada frame */
static u8  g_pal_raw[768];                     /* paleta activa en formato RGB8 (0-255) */
static u8  g_seq_bg_tmp[AG_SCREEN_PIXELS];        /* buffer temporal para fondo en show_text */

/* Numero de pasadas de shade_lut a aplicar a cada pixel de sprite en _render_obj_item.
 * 0 = sin sombra (normal). Se fija antes de _render_scene_sorted_pass(1) en engine_flip. */
static u8 g_sprite_shade_passes = 0;

/* -- Iluminacion de room --------------------------------------------------- */
#define LM_W  80   /* resolucion lightmap = pantalla/4 */
#define LM_H  50
typedef struct {
    s16 x, y, radius;
    u8  intensity;   /* 0-100 */
    u16 cone_angle;  /* grados; 360=omnidireccional */
    s8  dir_x, dir_y;
    u8  flicker_amp; /* 0=sin parpadeo */
    u8  flicker_hz;  /* ciclos/s del parpadeo */
} RoomLight;
static u8        g_ambient_light    = 100;
static RoomLight g_room_lights[MAX_ROOM_LIGHTS];
static u8        g_room_light_count = 0;
static u8        g_lmap[LM_W * LM_H];
static u8        g_lmap_dirty       = 1;  /* 1 = necesita recalculo; 0 = valido */
static u8        g_shade_lut[256];
static u8        g_shade_lut_valid  = 0;
static u8        g_shade_passes_lut[256]; /* precomputed: nro de pasadas shade por valor de lmap */

/* Sprite run cache — debe declararse antes de los forward declarations que la usan */
typedef struct { u16 x; u16 len; } SprRun;
typedef struct {
    u16      w, h;
    u16*     row_nruns;
    u32*     row_run_off;
    u32*     row_pix_off;
    SprRun*  runs;
    u8*      pixels;
} SprCache;

/* Forward declarations de funciones estaticas */
static void _seq_draw_text_full(const char* txt, u8 font_idx, u8 color_fill, u8 bg_color_idx,
                                 const char* position, const char* align);
static void _room_predecode_all(void);
static void _apply_persisted_states(void);
void engine_set_object_state(const char* obj_id, const char* state_id); /* forward */
static int  _pcx_decode(const u8* src, u32 src_size, u8* dst, u16* out_w, u16* out_h, int apply_pal);
static SprCache* _spr_cache_build(const u8* dec, u16 w, u16 h);
static void _spr_cache_free(SprCache* sc);

/* Buffer estatico para decodificacion PCX.
 * Debe ser >= max(sprite_w * sprite_h). Objetos de escenario pueden ser tan
 * anchos como la room (hasta 1024px). Mismo techo que g_bg_full. */
#define AG_OBJ_PIX_MAX (1024u * 200u)
static u8 g_pcx_decode_buf[AG_OBJ_PIX_MAX];
static u8  g_bg_full[1024 * 200];             /* fondo completo (hasta 1024px ancho, scroll rooms) */
static u16 g_bg_full_w  = AG_SCREEN_W;           /* anchura real del PCX */
static u16 g_bg_full_h  = UI_Y;               /* altura real del PCX */
static s16 g_cam_x      = 0;                  /* scroll horizontal actual (px) */
static u16 g_room_scroll_w = 0;               /* ancho logico room (0 = sin scroll) */
static u16 g_grid_cell_w  = WALKMAP_CELL_SIZE; /* ancho celda grilla = WALKMAP_CELL_SIZE */
/* -- Scroll por mitades (tipo Scumm Bar) ------------------------------------- */
static u8  g_scroll_halves    = 0;    /* 1 = modo scroll-por-mitades activo */
static u16 g_scroll_half_w    = 320;  /* ancho de cada mitad (px) */
#define SCROLL_HALVES_TRIGGER  10     /* px desde el limite central que activa el pan */
#define SCROLL_HALVES_DURATION 2000   /* duracion del pan en ms */
static u8  g_cam_pan_active   = 0;    /* 1 = pan en curso */
static s16 g_cam_pan_src      = 0;    /* cam_x de inicio del pan */
static s16 g_cam_pan_dst      = 0;    /* cam_x objetivo del pan */
static u32 g_cam_pan_start_ms = 0;    /* ticks_ms cuando empezo el pan */
static u8  g_cam_pan_dir      = 0;    /* 0 = izq→der, 1 = der→izq */
static u8  g_scroll_recovering = 0;   /* 1 = personaje caminando a zona segura tras pan */
static u8* g_vga = (u8*)0xA0000;              /* puntero directo a VRAM */

/* -- DAT -------------------------------------------------------------------- */
static FILE*     g_gfx_f    = NULL;
static DatIndex* g_gfx_idx  = NULL;
static int       g_gfx_n    = 0;
static u32       g_gfx_data = 0;

static FILE*     g_fnt_f    = NULL;   /* FONTS.DAT: fuentes bitmap PCX */
static DatIndex* g_fnt_idx  = NULL;
static int       g_fnt_n    = 0;
static u32       g_fnt_data = 0;

static FILE*     g_scr_f    = NULL;   /* SCRIPTS.DAT: rooms, verbsets, chars... */
static DatIndex* g_scr_idx  = NULL;
static int       g_scr_n    = 0;
static u32       g_scr_data = 0;

static FILE*     g_audio_f    = NULL;
static DatIndex* g_audio_idx  = NULL;
static int       g_audio_n    = 0;
static u32       g_audio_data = 0;

static FILE*     g_text_f    = NULL;
static DatIndex* g_text_idx  = NULL;
static int       g_text_n    = 0;
static u32       g_text_data = 0;

/* Tabla de texto del idioma activo: clave -> valor */
typedef struct { char key[64]; char val[256]; } TextEntry;
#define MAX_TEXT_ENTRIES 512
static TextEntry g_texts[MAX_TEXT_ENTRIES];
static char g_active_lang[8] = "es";  /* codigo ISO del idioma activo */
static int  g_cfg_volume    = 100;   /* volumen usuario 0-100 */
static char g_cfg_audio[16] = "";    /* preferencia audio: "opl2"|"mpu401"|"" */
static int  g_cfg_sfx       = 1;    /* efectos SFX: 1=activados, 0=desactivados */
static int  g_cfg_sfx_vol   = 100;  /* volumen SFX usuario 0-100 */
static int  g_cfg_show_fps  = 0;    /* mostrar FPS arriba derecha: 1=si, 0=no */
static int       g_text_count = 0;

/* -- Rooms ------------------------------------------------------------------ */
static const RoomEntry* g_room_table = NULL;

typedef struct { char id[32]; s16 x, y; }         EntryPoint;
typedef struct { char id[32]; Rect tz;
                 char target_room[32];
                 char target_entry[32];
                 char name_key[48];
                 u8   enabled; }                  Exit;

static EntryPoint g_entries[MAX_ENTRIES];
static int        g_entry_count = 0;

static Exit       g_exits[MAX_EXITS];
static int        g_exit_count  = 0;

/* Tabla persistente de estados de salidas — sobrevive cambios de sala.
 * Clave: (room_id, exit_id). Sólo se añade entrada cuando el script
 * llama a engine_set_exit_enabled(), guardando el cambio explícito. */
#define MAX_EXIT_STATES 128
typedef struct { char room_id[32]; char exit_id[32]; u8 enabled; } ExitState;
static ExitState g_exit_states[MAX_EXIT_STATES];
static int       g_exit_state_count = 0;

/* Walkmap: bitmap 40x25, 1=pasable, 0=bloqueado */
/* Tamaño de celda del walkmap: 8 (defecto) o 4 (precisión doble, +270KB RAM).
 * Controlado desde GameParams → compilado como -dWALKMAP_CELL_SIZE=N */
#ifndef WALKMAP_CELL_SIZE
#  define WALKMAP_CELL_SIZE 8
#endif
#define WM_MAX_W (1600 / WALKMAP_CELL_SIZE)   /* max columnas */
#define WM_MAX_H (160  / WALKMAP_CELL_SIZE)   /* max filas    */
static u8  g_walkmap[WM_MAX_W * WM_MAX_H];
static int g_wm_w = (320 / WALKMAP_CELL_SIZE);   /* columnas activas de la room actual */
static int g_wm_h = (144 / WALKMAP_CELL_SIZE);   /* filas activas */

static char       g_cur_room[32]  = "";
static char       g_cur_entry[32] = "entry_default";

/* -- Personajes ------------------------------------------------------------- */

/* Indices de rol de animacion - coinciden con el orden de engine_place_char */
#define ANIM_IDLE       0   /* idle lateral (derecha/izquierda) */
#define ANIM_WALK_RIGHT 1
#define ANIM_WALK_LEFT  2
#define ANIM_WALK_UP    3
#define ANIM_WALK_DOWN  4
#define ANIM_IDLE_UP    5   /* idle tras caminar hacia arriba (fallback: ANIM_IDLE) */
#define ANIM_IDLE_DOWN  6   /* idle tras caminar hacia abajo  (fallback: ANIM_IDLE) */
#define ANIM_CUSTOM     7   /* slot dinamico: engine_set_anim_pcx() lo rellena */
#define ANIM_TALK       8   /* hablar mirando derecha */
#define ANIM_TALK_UP    9   /* hablar mirando arriba   (fallback: ANIM_TALK / ANIM_IDLE_UP) */
#define ANIM_TALK_DOWN 10   /* hablar mirando abajo    (fallback: ANIM_TALK / ANIM_IDLE_DOWN) */
#define ANIM_TALK_LEFT 11   /* hablar mirando izquierda (opcional; si vacío, ANIM_TALK se espeja) */
#define ANIM_GIVE      12   /* dar objeto (fallback: ANIM_TALK si vacío) */
#define ANIM_ROLES     13

/* Cambia la animacion activa y actualiza ms_per_frame cacheado (evita division en render) */
#define CHAR_SET_ANIM(c, role) do { \
    (c)->cur_anim = (u8)(role); \
    { u8 _fps = (c)->anims[(role)].fps; \
      (c)->ms_per_frame = _fps > 0 ? (u32)(1000 / _fps) : 125; } \
} while(0)

/* Datos de una animacion - resueltos en compile-time por el generador */
typedef struct {
    char id[32];       /* clave en GRAPHICS.DAT, ej: "spr_RODWALKR" o "spr_RODWALKR_FH" */
    u8   frames;       /* numero de frames en el spritesheet */
    u8   fps;          /* frames por segundo */
    u16  fw;           /* frame width en pixeles */
    u8   flip;         /* LEGACY — no se usa, el PCX ya viene pre-espejado */
} AnimDef;

typedef struct {
    char    id[32];
    s16     x, y;
    u8      visible;
    u8      cur_anim;  /* ANIM_IDLE | ANIM_WALK_RIGHT | ... */
    char    dir[8];    /* "left"|"right" — direccion lateral para espejo idle */
    u8      dir_left;  /* cache: 1 si dir=="left", evita strcmp en render */
    AnimDef anims[ANIM_ROLES];
    /* pathfinding */
    Point   path[64];
    int     path_len;
    int     path_cur;
    u8      walking;
    u8      speed;       /* velocidad actual del walk en curso */
    u8      base_speed;  /* velocidad base del personaje (se restaura al llegar) */
    u8      subtitle_color; /* color de subtítulo para diálogos */
    /* linterna del personaje */
    u8      has_light;      /* 1 si lleva una fuente de luz */
    s16     light_off_x;    /* offset desde el centro del sprite */
    s16     light_off_y;
    s16     light_radius;
    u8      light_intensity;
    u16     light_cone;     /* grados; 360=omni */
    u8      light_flicker_amp;
    u8      light_flicker_hz;
    /* sprite activo en RAM */
    u8*     pcx_buf;
    u32     pcx_size;
    char    pcx_loaded[32]; /* id del PCX actualmente en pcx_buf */
    u8*      dec_buf;        /* cache decode RLE: invalido cuando pcx_buf cambia */
    u16      dec_w, dec_h;
    SprCache* spr_cache;    /* runs opacas precomputadas para pct=100 (NULL=no disponible) */
    u32      ms_per_frame;  /* cache: 1000/fps, evita division en render */
    u8      frame_cur;
    u32     frame_timer;
    u32     move_timer;   /* ms del ultimo paso de movimiento */
    s16     target_x, target_y;  /* destino original del walk */
    char    face_pcx_id[32];    /* id del PCX de cara para selector de protagonistas */
} Char;

static Char g_chars[MAX_CHARS];
static int  g_char_count = 0;
static int  g_protagonist = 0;   /* indice en g_chars */

/* -- Party (protagonistas simultaneos) -------------------------------------- */
#define MAX_PARTY 8

typedef struct {
    char id[32];           /* id del personaje */
    char room_id[32];      /* ultima room donde se dejo al personaje */
    s16  x, y;             /* ultima posicion conocida */
    char dir[8];           /* ultima direccion ("left","right","up","down") */
    u8   cur_anim;         /* ultimo rol de animacion (ANIM_IDLE, etc.) */
    u8*  face_pcx_buf;     /* PCX de cara cargado en heap (puede ser NULL) */
    u32  face_pcx_size;
    char face_pcx_id[32];  /* id del PCX de cara (para recarga) */
    void (*place_fn)(s16, s16); /* funcion de colocacion generada (main.c) */
} PartySlot;

static PartySlot g_party[MAX_PARTY];
static int       g_party_count            = 0;
static int       g_party_popup_open       = 0;  /* 1 = popup selector de protagonista visible */
static int       g_suppress_prot_reinject = 0;  /* 1 = no reinjectar prot actual en change_room */
static char      g_prev_room[32]          = "";  /* room guardada por engine_enter_closeup */
static char      g_closeup_prot_id[32]    = "";  /* id del protagonista real al entrar closeup */
static char      g_active_prot_id[32]     = "";  /* id del protagonista antes del ultimo change_room */
/* Colores del popup de party (indices de paleta VGA, configurables via engine_set_party_popup_colors) */
static u8        g_popup_col_bg     = 1;   /* fondo del panel */
static u8        g_popup_col_border = 8;   /* borde del panel */
static u8        g_popup_col_active = 8;   /* celda del protagonista activo */
static u8        g_popup_col_hover  = 4;   /* celda en hover */

/* Colores del panel de opciones de dialogo (configurables via engine_set_dialogue_colors) */
static u8        g_dlg_col_bg  = 16;   /* fondo */
static u8        g_dlg_col_brd =  0;   /* borde */
static u8        g_dlg_col_txt = 15;   /* texto normal */
static u8        g_dlg_col_sel = 26;   /* fila en hover */

/* Colores del menu de juego / barra de verbos (configurables via engine_set_ui_colors) */
static u8        g_ui_col_bg      =  1;  /* fondo de la banda UI (56px inferiores) */
static u8        g_ui_col_action  = 15;  /* texto de la linea de accion */
static u8        g_ui_col_sel     = 14;  /* verbo seleccionado */
static u8        g_ui_col_inv_hov =  8;  /* fondo slot inventario en hover/seleccionado */

/* Colores del menu ESC/pausa (configurables via engine_set_menu_colors) */
static u8        g_menu_col_bg  = 16;  /* fondo panel y overlay dithered */
static u8        g_menu_col_btn = 20;  /* boton normal */
static u8        g_menu_col_sel = 26;  /* boton hover/seleccionado */
static u8        g_menu_col_brd =  0;  /* borde panel y botones */
static u8        g_menu_col_txt = 15;  /* texto de botones */
static u8        g_menu_col_act = 12;  /* item activo (idioma en uso, driver activo) */
static char      g_party_switch_pending[32] = ""; /* char_id a activar tras load_fn (cross-room switch) */

/* -- Objetos ---------------------------------------------------------------- */
#define MAX_OBJ_STATES 8

typedef struct {
    char id[32];
    char obj_id[32];
    s16  x, y;
    u8   visible;
    char state[32];
    u8*  pcx_buf;
    u32  pcx_size;
    /* Pickup */
    u8   pickable;          /* 1 = se puede coger con verbo pickup */
    u8   detectable;        /* 0 = invisible al cursor (sin hover, sin nombre, sin verbos) */
    u8   over_light;        /* 1 = se dibuja despues del lightmap (tapa la oscuridad) */
    u8   bg_layer;          /* 1 = se dibuja justo despues del fondo, antes de personajes */
    char inv_gfx_id[36];   /* gfx_id del icono en inventario */
    u8*  inv_pcx_buf;      /* icono cargado (puede ser NULL = usar pcx_buf) */
    u32  inv_pcx_size;
    /* Estados visuales */
    char state_gfx[MAX_OBJ_STATES][36]; /* gfx_id por estado */
    char state_key[MAX_OBJ_STATES][32]; /* nombre del estado */
    u8   state_frames[MAX_OBJ_STATES];  /* 0/1 = estatico, >1 = animado */
    u8   state_fps[MAX_OBJ_STATES];     /* fps de animacion por estado */
    u16  state_fw[MAX_OBJ_STATES];      /* frame width en px (0 = deducir del PCX) */
    int  state_count;
    /* Animacion del estado activo */
    u8   anim_frames;  /* copia del estado activo: 0/1=estatico, >1=animado */
    u8   anim_fps;
    u16  anim_fw;
    u8   anim_loop;    /* 1=loop infinito (defecto), 0=one-shot: para en ultimo frame */
    u8   frame_cur;
    u32  frame_timer;
    u32  ms_per_frame; /* cache: 1000/anim_fps, evita division en render */
    /* Cache de decode RLE: evita decodificar PCX cada frame */
    u8*       dec_buf;    /* indices raw decodificados (malloc al cargar, NULL=invalido) */
    u16       dec_w, dec_h;
    SprCache* spr_cache;  /* runs opacas precomputadas para pct=100 */
    /* Animacion ambiental periodica (tipo Scumm Bar) */
    char ambient_state[32]; /* estado a activar; "" = sin ambient              */
    char ambient_base[32];  /* estado base al que volver tras la animacion      */
    u32  ambient_min_ms;    /* intervalo minimo entre disparos (ms)             */
    u32  ambient_max_ms;    /* intervalo maximo entre disparos (ms)             */
    u32  ambient_next_ms;   /* g_ticks_ms en que debe dispararse; 0=desarmado  */
    u8   ambient_playing;   /* 1 = animacion ambient en curso                  */
    u8   ambient_base_loop; /* anim_loop del estado base: restaurar al terminar */
    u8   ambient_done;      /* 1 = idle entre disparos: congelar en frame 0    */
} Obj;

static Obj  g_objects[MAX_OBJECTS];
static int  g_obj_count = 0;
static int  g_over_light_count = 0; /* objetos con over_light=1 en la room actual */
static int  g_bg_layer_count   = 0; /* objetos con bg_layer=1 en la room actual */

/* Talk auto-response: timer para restaurar idle tras mostrar respuesta automática */
static u32  g_talk_restore_ms  = 0;
static u8   g_talk_idle_role   = ANIM_IDLE;

/* Tabla global obj_id → inv_gfx_id para engine_give_object en secuencias */
#define MAX_OBJ_GLOBAL 64
typedef struct { char obj_id[32]; char inv_gfx_id[36]; } ObjGfxEntry;
static ObjGfxEntry g_obj_gfx_table[MAX_OBJ_GLOBAL];
static int         g_obj_gfx_count = 0;

/* Tabla persistente de estados de objetos entre rooms.
 * Cuando engine_set_object_state cambia un estado, se guarda aqui.
 * engine_place_object_ex lo restaura al volver a la room. */
#define MAX_OBJ_STATE_PERSIST 64
typedef struct { char obj_id[32]; char state_key[32]; } ObjStatePersist;
static ObjStatePersist g_obj_state_persist[MAX_OBJ_STATE_PERSIST];
static int             g_obj_state_persist_count = 0;

static void _obj_state_persist_set(const char* obj_id, const char* state_key) {
    int i;
    for (i = 0; i < g_obj_state_persist_count; i++) {
        if (_str_eq(g_obj_state_persist[i].obj_id, obj_id)) {
            _strlcpy(g_obj_state_persist[i].state_key, state_key, 32);
            return;
        }
    }
    if (g_obj_state_persist_count < MAX_OBJ_STATE_PERSIST) {
        _strlcpy(g_obj_state_persist[g_obj_state_persist_count].obj_id,   obj_id,    32);
        _strlcpy(g_obj_state_persist[g_obj_state_persist_count].state_key, state_key, 32);
        g_obj_state_persist_count++;
    }
}

static const char* _obj_state_persist_get(const char* obj_id) {
    int i;
    for (i = 0; i < g_obj_state_persist_count; i++)
        if (_str_eq(g_obj_state_persist[i].obj_id, obj_id))
            return g_obj_state_persist[i].state_key;
    return NULL;
}

/* Aplica estados persistidos a todos los objetos ya registrados en la room actual.
 * Se llama ANTES de _room_predecode_all() para que el predecode use el PCX correcto. */
static void _apply_persisted_states(void) {
    int i;
    for (i = 0; i < g_obj_count; i++) {
        Obj* o = &g_objects[i];
        const char* st = _obj_state_persist_get(o->obj_id[0] ? o->obj_id : o->id);
        if (st && st[0] && !_str_eq(o->state, st))
            engine_set_object_state(o->id, st);
    }
}

/* -- Inventario ------------------------------------------------------------- */
typedef struct {
    char obj_id[32];        /* id del objeto */
    char char_owner[32];    /* id del personaje propietario; "" = cualquier protagonista */
    u8*  pcx_buf;           /* icono (puede ser NULL) */
    u32  pcx_size;
    int  owns_buf;          /* 1 = este slot tiene su propia copia del buffer */
} InvSlot;

static InvSlot g_inventory[MAX_INVENTORY];
static int      g_inv_count  = 0;
static int      g_inv_scroll = 0;   /* primer item visible */
static int      g_inv_hover  = -1;  /* slot bajo el cursor (indice visual filtrado) */
static char     g_selected_inv[32] = ""; /* objeto seleccionado en inv */

/* Numero de items visibles para el protagonista actual.
 * char_owner=="" es compatible con cualquier protagonista (comportamiento legacy). */
static int _inv_prot_count(void) {
    const char* pid = (g_char_count > 0) ? g_chars[g_protagonist].id : "";
    int i, n = 0;
    for (i = 0; i < g_inv_count; i++)
        if (!g_inventory[i].char_owner[0] || _str_eq(g_inventory[i].char_owner, pid))
            n++;
    return n;
}

/* Slot en el indice visual visual_idx para el protagonista actual (NULL=fuera de rango). */
static InvSlot* _inv_prot_slot(int visual_idx) {
    const char* pid = (g_char_count > 0) ? g_chars[g_protagonist].id : "";
    int i, n = 0;
    for (i = 0; i < g_inv_count; i++) {
        if (!g_inventory[i].char_owner[0] || _str_eq(g_inventory[i].char_owner, pid)) {
            if (n == visual_idx) return &g_inventory[i];
            n++;
        }
    }
    return NULL;
}

/* -- Party helpers ---------------------------------------------------------- */
/* Busca en g_party por id. Devuelve indice o -1 si no encontrado. */
static int _party_find(const char* id) {
    int i;
    for (i = 0; i < g_party_count; i++)
        if (_str_eq(g_party[i].id, id)) return i;
    return -1;
}

/* Guarda la posicion y room actuales de TODOS los miembros del party presentes
 * en la room actual. Llamar ANTES de _room_clear_state() en engine_change_room. */
static void _party_save_all(void) {
    int i, idx;
    if (g_party_count == 0 || !g_cur_room[0]) return;
    for (i = 0; i < g_char_count; i++) {
        idx = _party_find(g_chars[i].id);
        if (idx < 0) continue;
        _strlcpy(g_party[idx].room_id, g_cur_room, 32);
        g_party[idx].x        = g_chars[i].x;
        g_party[idx].y        = g_chars[i].y;
        _strlcpy(g_party[idx].dir, g_chars[i].dir, 8);
        g_party[idx].cur_anim = g_chars[i].cur_anim;
    }
}

/* -- Sprites de flechas de inventario (cargados en engine_dat_open_all) ---- */
typedef struct {
    u8*  buf;   /* buffer PCX, NULL si no hay sprite asignado */
    u32  size;
} ArrowSprite;

static ArrowSprite g_arrow_up       = { NULL, 0 };
static ArrowSprite g_arrow_up_hover = { NULL, 0 };
static ArrowSprite g_arrow_dn       = { NULL, 0 };
static ArrowSprite g_arrow_dn_hover = { NULL, 0 };
static ArrowSprite g_party_btn      = { NULL, 0 };
static ArrowSprite g_party_btn_hov  = { NULL, 0 };

/* -- Flags globales --------------------------------------------------------- */
typedef struct { char name[32]; int value; } Flag;
static Flag g_flags[MAX_FLAGS];
static int  g_flag_count = 0;

/* -- Flag watchers: scripts disparados cuando un flag cumple una condicion -- */
#define MAX_FLAG_WATCHERS 16
typedef struct {
    char flag[32];
    int  expect;          /* valor esperado: 1=is_true, 0=is_false, o entero numerico */
    void (*handler)(void);
    u8   fired;           /* 1=ya ejecutado; resetea si la condicion deja de cumplirse */
} FlagWatcher;
static FlagWatcher g_flag_watchers[MAX_FLAG_WATCHERS];
static int         g_flag_watcher_count = 0;

/* -- Atributos -------------------------------------------------------------- */
typedef struct { char target[32]; char attr[36]; int value; } Attr;
#define MAX_ATTRS 128
static Attr g_attrs[MAX_ATTRS];
static int  g_attr_count = 0;
static char g_death_attr[36] = "";  /* ID del atributo cuyo valor=0 mata al personaje */

/* -- Handlers de eventos ---------------------------------------------------- */
typedef struct {
    char verb_id[32];
    char obj_id[32];   /* obj1: objeto escena, inventario o "" */
    char obj2_id[32];  /* obj2: para "usar X con Y" (puede ser "") */
    int  is_inv;       /* 1 = obj_id es objeto de inventario */
    int  require_both_inv; /* 1 = ambos objetos deben estar en inventario */
    char char_id[32];  /* "" = genérico; no vacío = solo para este protagonista */
    void (*fn)(void);
} VerbHandler;

static VerbHandler g_verb_handlers[MAX_VERB_HANDLERS];
static int         g_verb_handler_count = 0;

/* Estado "usar con": primer objeto seleccionado esperando segundo */
static int  g_usar_con_mode = 0;       /* 1 = esperando segundo objeto */
static char g_usar_con_inv[32]  = "";  /* obj1 del inventario */
static char g_usar_con_verb[32] = "";  /* verbo que inicio el modo */
static char g_usar_con_base[64] = "";  /* "usar [X] con" fijo en action line */

/* Estado "dar": objeto inv seleccionado esperando personaje objetivo */
static int  g_dar_mode = 0;
static char g_dar_inv[32]  = "";   /* objeto del inventario a dar */
static char g_dar_verb[32] = "";   /* id del verbo dar activo */
static char g_dar_base[64] = "";   /* "Dar [X] a" fijo en action line */
static char g_dar_target[32] = ""; /* personaje objetivo (accesible via engine_get_dar_target) */

typedef struct { char obj_id[32]; void (*fn)(void); } ClickHandler;
#define MAX_CLICK_HANDLERS 64
static ClickHandler g_click_handlers[MAX_CLICK_HANDLERS];
static int          g_click_count = 0;

static void (*g_on_game_start)(void)   = NULL;
static void (*g_on_room_load)(void)    = NULL;
static void (*g_on_room_enter)(void)   = NULL;
static void (*g_on_room_exit)(void)    = NULL;

typedef struct { char seq_id[32]; void (*fn)(void); } SeqEndHandler;
#define MAX_SEQ_END 16
static SeqEndHandler g_seq_end_handlers[MAX_SEQ_END];
static int           g_seq_end_count = 0;

/* -- Control del bucle ------------------------------------------------------ */
static int g_running            = 0;
static int g_exit_blocked       = 0;
static char g_pending_exit_id[32] = ""; /* exit al que el jugador caminó explícitamente */
static int g_ui_hidden          = 0;  /* 1 = ocultar verbos+inventario durante secuencias */
static void (*g_pre_flip_fn)(void) = NULL; /* hook llamado justo antes de _vga_flip — para overlays sobre la escena */
static int g_bg_fullscreen      = 0;  /* 1 = fondo 320x200, sin UI, sin hover, sin exits */
static int g_restart_requested  = 0;  /* 1 = reiniciar partida desde el principio */

/* Estado de move_text no bloqueante (bloque paralelo) */
static int    g_mtext_active = 0;
static s16    g_mtext_cx = 0, g_mtext_cy = 0;
static s16    g_mtext_x1 = 0, g_mtext_y1 = 0;
static s16    g_mtext_speed = 0;
static u8     g_mtext_font = 0, g_mtext_color = 15;
static char   g_mtext_key[64] = "";
static u8     g_mtext_bg[AG_SCREEN_PIXELS]; /* buffer de fondo */
static u32    g_mtext_prev_tick = 0;

/* -- Verbset activo --------------------------------------------------------- */
static char g_verbset_id[32] = "";

/* -- Sistema de fuentes bitmap (S14b) --------------------------------------- *
 * 3 slots: FONT_SMALL(0)=8?8, FONT_MEDIUM(1)=8?16, FONT_LARGE(2)=16?16.     *
 * El PCX es una fila de FONT_N_GLYPHS (112) glifos.                          *
 * Indice 0=transparente, indice 1=color key (reasignado en runtime).         *
 * --------------------------------------------------------------------------- */
#define FONT_SMALL      0
#define FONT_MEDIUM     1
#define FONT_LARGE      2
#define FONT_COUNT      3
#define FONT_N_GLYPHS   144   /* ASCII 32-127 (96) + esp 96-111 (16) + cat/fr 112-143 (32) */
#define FONT_COLOR_KEY  1     /* indice sustituido por color_idx en runtime */

typedef struct {
    u8*  data;   /* pixeles decodificados del PCX (ancho_total ? gh bytes) */
    u16  gw;     /* ancho de un glifo en pixeles */
    u16  gh;     /* alto de un glifo en pixeles */
    u16  tw;     /* ancho total = gw * FONT_N_GLYPHS */
    u8   ok;     /* 1 si cargada */
} FontSlot;

static FontSlot g_fonts[FONT_COUNT];
static u8       g_action_font  = FONT_SMALL;
static u8       g_action_color = 15;   /* indice VGA para texto de accion */

/* -- Verbset cargado en RAM ------------------------------------------------- */
#define MAX_VERBS_IN_SET 16
typedef struct {
    char id[32];
    char label[32];
    u8   is_movement;
    u8   approach_obj;   /* 1 = personaje camina hasta objeto antes de ejecutar */
    u8   is_pickup;      /* 1 = recoger objeto y mandar al inventario            */
    u8   is_give;        /* 1 = verbo dar: seleccionar inv → esperar personaje  */
    u8   col;
    u8   row;
    u8   normal_color;   /* color del texto en estado normal (índice paleta)    */
    u8   hover_color;    /* color del texto cuando el cursor está encima        */
} VerbEntry;

static VerbEntry g_verbs[MAX_VERBS_IN_SET];
static int       g_verb_count  = 0;
static u8        g_verb_color  = 15;   /* textColor del verbset activo */

/* -- Texto en barra de accion ----------------------------------------------- */
static char g_action_text[MAX_TEXT_LEN+1] = "";
static u32  g_text_until_ms = 0;   /* 0 = permanente hasta clear */

/* -- Overlay de texto no bloqueante (SHOW_TEXT scripts / dialogos) ---------- */
#define MAX_OVERLAYS 4
typedef struct {
    char text[MAX_TEXT_LEN+1];
    u8   color;
    s16  x;          /* -1 = centrado en pantalla; >= 0 = left edge fijo */
    s16  y;
    s16  center_x;   /* >= 0 = centrar cada linea sobre este x de pantalla (char screen x); -1 = usar x */
    u32  until_ms;   /* 0 = permanente */
    u8   wait_click;
    u8   active;
} Overlay;
static Overlay g_overlays[MAX_OVERLAYS];
static u8   g_overlay_click_seen = 0;
static u8   g_script_running = 0;

/* -- Escalado de personajes por Y (perspectiva) ----------------------------- */
#define MAX_SCALE_ZONES 8
typedef struct {
    s16 y0, y1;      /* rango Y en pantalla */
    u8  type;        /* 0=fijo, 1=lineal */
    u8  pct0;        /* porcentaje en y0 (o fijo si type=0) */
    u8  pct1;        /* porcentaje en y1 (solo si type=1) */
} ScaleZone;
static ScaleZone g_scale_zones[MAX_SCALE_ZONES];
static int       g_scale_zone_count = 0;
static u8        g_scaling_enabled  = 0;
static u8        g_scale_lut[200];   /* pct de escala por Y pixel 0..199, reconstruido al cargar room */

void engine_clear_scale_zones(void) {
    g_scale_zone_count = 0; g_scaling_enabled = 0;
}

void engine_add_scale_zone(s16 y0, s16 y1, u8 type, u8 pct0, u8 pct1) {
    if (g_scale_zone_count >= MAX_SCALE_ZONES) return;
    g_scale_zones[g_scale_zone_count].y0   = y0;
    g_scale_zones[g_scale_zone_count].y1   = y1;
    g_scale_zones[g_scale_zone_count].type = type;
    g_scale_zones[g_scale_zone_count].pct0 = pct0;
    g_scale_zones[g_scale_zone_count].pct1 = pct1;
    g_scale_zone_count++;
    g_scaling_enabled = 1;
}

/* Devuelve el porcentaje de escala (1-100) para una Y dada */
static u8 _get_scale_pct(s16 y) {
    int i;
    if (!g_scaling_enabled || g_scale_zone_count == 0) return 100;
    for (i = 0; i < g_scale_zone_count; i++) {
        ScaleZone* z = &g_scale_zones[i];
        if (y >= z->y0 && y <= z->y1) {
            if (z->type == 0) return z->pct0;
            /* Lineal: interpolar entre pct0 y pct1 */
            if (z->y1 == z->y0) return z->pct0;
            { s32 range = z->y1 - z->y0;
              s32 rel   = y - z->y0;
              s32 pct   = (s32)z->pct0 + (((s32)z->pct1 - z->pct0) * rel) / range;
              if (pct < 1) pct = 1;
              if (pct > 100) pct = 100;
              return (u8)pct;
            }
        }
    }
    /* Fuera de zonas: usar la más cercana */
    return g_scale_zones[g_scale_zone_count-1].pct1 > 0
           ? g_scale_zones[g_scale_zone_count-1].pct1
           : g_scale_zones[g_scale_zone_count-1].pct0;
}

/* -- Timing ----------------------------------------------------------------- */
static volatile u32 g_ticks_ms = 0;   /* actualizado por la ISR del timer */

/* -- Input ------------------------------------------------------------------ */
typedef struct { s16 x, y; u8 buttons; } MouseState;
static MouseState g_mouse = {0,0,0};
static char       g_selected_verb[32] = "";
static char       g_hover_obj[32]     = "";

/* -- Pending action (approach + acción diferida) ---------------------------- */
#define PEND_NONE    0
#define PEND_HANDLER 1   /* ejecutar fn() al llegar */
#define PEND_PICKUP  2   /* pickup automático al llegar */
#define PEND_RESP    3   /* solo mostrar texto de respuesta al llegar */
#define PEND_DAR     4   /* dar objeto a personaje: walk + transferencia al llegar */
typedef struct {
    u8   type;
    char obj_id[32];
    char verb_id[32];
    void (*fn)(void);
} PendingAction;
static PendingAction g_pending = {0};

/* -- Timer línea de acción -------------------------------------------------- */
static u32 g_action_timer = 0;  /* ticks_ms hasta cuando mostrar el texto actual; 0=permanente */

/* ===========================================================================
 * S2 - UTILIDADES INTERNAS
 * =========================================================================== */

static void _strlcpy(char* dst, const char* src, int n) {
    strncpy(dst, src, n-1);
    dst[n-1] = '\0';
}

static int _str_eq(const char* a, const char* b) {
    return strcmp(a, b) == 0;
}

void engine_set_death_attr(const char* attr_id) {
    _strlcpy(g_death_attr, attr_id, 36);
}

int engine_get_attr(const char* target, const char* attr) {
    int i;
    for (i = 0; i < g_attr_count; i++)
        if (_str_eq(g_attrs[i].target, target) && _str_eq(g_attrs[i].attr, attr))
            return g_attrs[i].value;
    return 0;
}

void engine_register_obj_inv_gfx(const char* obj_id, const char* inv_gfx_id) {
    int i;
    if (!obj_id || !inv_gfx_id || !inv_gfx_id[0]) return;
    /* Actualizar si ya existe */
    for (i = 0; i < g_obj_gfx_count; i++) {
        if (_str_eq(g_obj_gfx_table[i].obj_id, obj_id)) {
            _strlcpy(g_obj_gfx_table[i].inv_gfx_id, inv_gfx_id, 36);
            return;
        }
    }
    if (g_obj_gfx_count >= MAX_OBJ_GLOBAL) return;
    _strlcpy(g_obj_gfx_table[g_obj_gfx_count].obj_id,     obj_id,     32);
    _strlcpy(g_obj_gfx_table[g_obj_gfx_count].inv_gfx_id, inv_gfx_id, 36);
    g_obj_gfx_count++;
}

/* Añade un overlay al primer slot libre. Devuelve el índice o -1 si lleno. */
static int _overlay_add(const char* txt, u8 color, s16 x, s16 y, u32 until_ms, u8 wait_click) {
    int i;
    for (i = 0; i < MAX_OVERLAYS; i++) {
        if (!g_overlays[i].active) {
            _strlcpy(g_overlays[i].text, txt, MAX_TEXT_LEN+1);
            g_overlays[i].color = color;
            g_overlays[i].x = x;
            g_overlays[i].y = y;
            g_overlays[i].center_x = -1;
            g_overlays[i].until_ms = until_ms;
            g_overlays[i].wait_click = wait_click;
            g_overlays[i].active = 1;
            return i;
        }
    }
    return -1;
}
/* Variante para hablar: centra cada línea sobre char_screen_x. */
static int _overlay_add_say(const char* txt, u8 color, s16 char_screen_x, s16 y, u32 until_ms) {
    int idx = _overlay_add(txt, color, -1, y, until_ms, 0);
    if (idx >= 0) g_overlays[idx].center_x = char_screen_x;
    return idx;
}

static void _overlay_clear_all(void) {
    int i; for (i = 0; i < MAX_OVERLAYS; i++) g_overlays[i].active = 0;
}

static int _overlays_active(void) {
    int i; for (i = 0; i < MAX_OVERLAYS; i++) if (g_overlays[i].active) return 1;
    return 0;
}

/* Busca un personaje por id. Devuelve NULL si no existe. */
static Char* _find_char(const char* id) {
    int i;
    for (i = 0; i < g_char_count; i++)
        if (_str_eq(g_chars[i].id, id)) return &g_chars[i];
    return NULL;
}

/* Busca un objeto por id. */
static Obj* _find_obj(const char* id) {
    int i;
    /* Primero buscar por inst_id exacto */
    for (i = 0; i < g_obj_count; i++)
        if (_str_eq(g_objects[i].id, id)) return &g_objects[i];
    /* Fallback: buscar por obj_id de biblioteca */
    for (i = 0; i < g_obj_count; i++)
        if (_str_eq(g_objects[i].obj_id, id)) return &g_objects[i];
    return NULL;
}

/* ===========================================================================
 * S3 - TIMER ISR (pit 18.2 Hz -> 1ms counter via divisor)
 * =========================================================================== */

static void (_interrupt _far *g_old_timer)(void) = NULL;

static void _interrupt _far _timer_isr(void) {
    g_ticks_ms += 55;   /* PIT canal 0 a 18.2Hz ? 55ms por tick */
    /* Encadenar al handler original */
    _chain_intr(g_old_timer);
}

static void _timer_install(void) {
    g_old_timer = _dos_getvect(0x08);
    _dos_setvect(0x08, _timer_isr);
}

static void _timer_remove(void) {
    if (g_old_timer) _dos_setvect(0x08, g_old_timer);
}

/* ===========================================================================
 * S4 - VGA MODO 13h
 * =========================================================================== */

static void _vga_set_mode13(void) {
    _asm { mov ax, 0x13 }
    _asm { int 0x10     }
}

static void _vga_set_text(void) {
    _asm { mov ax, 0x03 }
    _asm { int 0x10     }
}

/* Vuelca el back-buffer a VRAM con una copia de 64000 bytes */
static void _vga_flip(void) {
    memcpy(g_vga, g_backbuf, AG_SCREEN_PIXELS);
}

/* Aplica una paleta de 256 colores RGB (768 bytes, valores 0-255) a la VGA.
 * Convierte de 8 bits a 6 bits DAC internamente.
 * Llamar desde main() generado ANTES del primer engine_flip(). */
void engine_set_palette(const u8* rgb256) {
    int i;
    memcpy(g_pal_raw, rgb256, 768);  /* guardar copia para efectos de fade */
    g_shade_lut_valid = 0;
    outp(0x3C8, 0);
    for (i = 0; i < 256 * 3; i++)
        outp(0x3C9, rgb256[i] >> 2);
    /* Indice 0 siempre negro en la UI (fondo de la barra) */
    outp(0x3C8, 0);
    outp(0x3C9, 0); outp(0x3C9, 0); outp(0x3C9, 0);
}

/* ===========================================================================
 * S5 - PCX DECODER (modo 13h, 256 colores, RLE)
 * =========================================================================== */

/* Header PCX v5 (128 bytes) */
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
 * Devuelve ancho y alto. La paleta VGA se aplica directamente si apply_pal=1. */
static int _pcx_decode(const u8* src, u32 src_size,
                        u8* dst, u16* out_w, u16* out_h,
                        int apply_pal) {
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

    /* Aplicar paleta EGA de 256 colores (al final del fichero PCX) */
    if (apply_pal && src_size > 769 && src[src_size - 769] == 0x0C) {
        const u8* pal = src + src_size - 768;
        u16 i;
        outp(0x3C8, 0);
        for (i = 0; i < 256; i++) {
            outp(0x3C9, pal[i*3+0] >> 2);
            outp(0x3C9, pal[i*3+1] >> 2);
            outp(0x3C9, pal[i*3+2] >> 2);
        }
        /* Indice 0 siempre negro en la VGA - es transparencia en sprites
           y fondo de la barra de UI. La paleta del artista tiene magenta
           como placeholder pero en runtime se fuerza a negro. */
        outp(0x3C8, 0);
        outp(0x3C9, 0); outp(0x3C9, 0); outp(0x3C9, 0);
        /* Guardar copia raw para shade_lut de iluminacion */
        memcpy(g_pal_raw, pal, 768);
        g_pal_raw[0] = g_pal_raw[1] = g_pal_raw[2] = 0;
        g_shade_lut_valid = 0;
    }
    return 1;
}

/* ===========================================================================
 * S6 - RATON (INT 33h)
 * =========================================================================== */

static int g_mouse_ok = 0;

static void _mouse_init(void) {
    u16 res = 0;
    _asm { mov ax, 0x00 }
    _asm { int 0x33     }
    _asm { mov res, ax  }
    g_mouse_ok = (res == 0xFFFF);
}

static void _mouse_poll(void) {
    u16 btn = 0, mx = 0, my = 0;
    if (!g_mouse_ok) return;
    _asm { mov ax, 0x03 }
    _asm { int 0x33     }
    _asm { mov btn, bx  }
    _asm { mov mx,  cx  }
    _asm { mov my,  dx  }
    g_mouse.buttons = (u8)btn;
    g_mouse.x = (s16)(mx >> 1);
    g_mouse.y = (s16)my;
}

/* ===========================================================================
 * S7 - PATHFINDING A* (grilla 40?25 -> 320?8 ? 200?8)
 * =========================================================================== */

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

/* ===========================================================================
 * S8 - DAT
 * =========================================================================== */

static FILE* _dat_open_file(const char* path, DatIndex** out_idx,
                             int* out_n, u32* out_data_base) {
    DatHeader hdr;
    FILE* f = fopen(path, "rb");
    if (!f) { DBG("DAT open FAIL: %s\n", path); return NULL; }
    if (fread(&hdr, sizeof(hdr), 1, f) != 1) { fclose(f); DBG("DAT read hdr FAIL: %s\n",path); return NULL; }
    if (memcmp(hdr.magic, DAT_MAGIC_STR, 4) != 0) { fclose(f); DBG("DAT magic FAIL: %s\n",path); return NULL; }
    *out_n   = (int)hdr.num_blocks;
    *out_idx = (DatIndex*)malloc(hdr.num_blocks * sizeof(DatIndex));
    if (!*out_idx) { fclose(f); return NULL; }
    fseek(f, hdr.index_offset, SEEK_SET);
    fread(*out_idx, sizeof(DatIndex), hdr.num_blocks, f);
    *out_data_base = hdr.data_offset;
    DBG("DAT open OK: %s  blocks=%d\n", path, hdr.num_blocks);
    /* Volcar ids al LOG.TXT para diagnostico */
    { FILE* _lg = fopen("LOG.TXT","a");
      if (_lg) {
        int _i;
        fprintf(_lg, "=== %s (%d bloques) ===\n", path, hdr.num_blocks);
        for (_i = 0; _i < (int)hdr.num_blocks; _i++)
            fprintf(_lg, "  [%d] id='%s' type=%d\n", _i, (*out_idx)[_i].id, (*out_idx)[_i].res_type);
        fclose(_lg);
      }
    }
    return f;
}

void engine_dat_open_all(void) {
    g_gfx_f   = _dat_open_file(DAT_GRAPHICS,  &g_gfx_idx,   &g_gfx_n,   &g_gfx_data);
    g_fnt_f   = _dat_open_file("FONTS.DAT",   &g_fnt_idx,   &g_fnt_n,   &g_fnt_data);
    g_scr_f   = _dat_open_file("SCRIPTS.DAT", &g_scr_idx,   &g_scr_n,   &g_scr_data);
    g_audio_f = _dat_open_file(DAT_AUDIO,     &g_audio_idx,  &g_audio_n,  &g_audio_data);
    g_text_f  = _dat_open_file("TEXT.DAT",    &g_text_idx,   &g_text_n,   &g_text_data);
    /* Cargar sprites de flechas de inventario (opcionales — si no existen usa texto ^/v) */
    { u32 sz;
      g_arrow_up.buf       = (u8*)engine_dat_load_gfx("inv_arrow_up",        &sz); g_arrow_up.size       = sz;
      g_arrow_up_hover.buf = (u8*)engine_dat_load_gfx("inv_arrow_up_hover",  &sz); g_arrow_up_hover.size = sz;
      g_arrow_dn.buf       = (u8*)engine_dat_load_gfx("inv_arrow_down",      &sz); g_arrow_dn.size       = sz;
      g_arrow_dn_hover.buf = (u8*)engine_dat_load_gfx("inv_arrow_down_hover",&sz); g_arrow_dn_hover.size = sz;
      g_party_btn.buf      = (u8*)engine_dat_load_gfx("party_btn",           &sz); g_party_btn.size      = sz;
      g_party_btn_hov.buf  = (u8*)engine_dat_load_gfx("party_btn_hover",     &sz); g_party_btn_hov.size  = sz;
      DBG("arrow sprites: up=%p uhov=%p dn=%p dhov=%p\n",
          (void*)g_arrow_up.buf, (void*)g_arrow_up_hover.buf,
          (void*)g_arrow_dn.buf, (void*)g_arrow_dn_hover.buf);
    }
}

static void* _dat_load(FILE* f, DatIndex* idx, int n, u32 data_base,
                         const char* id, u32* out_size) {
    int i;
    for (i = 0; i < n; i++) {
        if (strncmp(idx[i].id, id, DAT_ID_LEN) == 0) {
            void* buf = malloc(idx[i].size);
            if (!buf) return NULL;
            fseek(f, (long)(data_base + idx[i].offset), SEEK_SET);
            fread(buf, 1, idx[i].size, f);
            if (out_size) *out_size = idx[i].size;
            return buf;
        }
    }
    return NULL;
}

void* engine_dat_load_gfx(const char* id, u32* out_size) {
    if (!g_gfx_f) return NULL;
    return _dat_load(g_gfx_f, g_gfx_idx, g_gfx_n, g_gfx_data, id, out_size);
}

void* engine_dat_load_audio(const char* id, u32* out_size) {
    if (!g_audio_f) return NULL;
    return _dat_load(g_audio_f, g_audio_idx, g_audio_n, g_audio_data, id, out_size);
}

void* engine_dat_load_scripts(const char* id, u32* out_size) {
    if (!g_scr_f) return NULL;
    return _dat_load(g_scr_f, g_scr_idx, g_scr_n, g_scr_data, id, out_size);
}

/* Carga un recurso de fuente por id (FONTS.DAT, fallback a GRAPHICS.DAT). */
void* engine_dat_load_font(const char* id, u32* out_size) {
    if (g_fnt_f) {
        void* p = _dat_load(g_fnt_f, g_fnt_idx, g_fnt_n, g_fnt_data, id, out_size);
        if (p) return p;
    }
    /* Fallback: buscar en GRAPHICS.DAT (compatible con versiones anteriores) */
    if (g_gfx_f) return _dat_load(g_gfx_f, g_gfx_idx, g_gfx_n, g_gfx_data, id, out_size);
    return NULL;
}

void engine_free(void* ptr) { free(ptr); }

/* -- Carga de textos del idioma activo -------------------------------------- */
static void _load_language_by_id(const char* lang_id) {
    u32 sz;
    u8* blob;
    u32 pos;
    u16 nkeys, vlen;
    u8  klen;
    int i;

    if (!g_text_f) return;
    g_text_count = 0;

    blob = (u8*)_dat_load(g_text_f, g_text_idx, g_text_n,
                          g_text_data, lang_id, &sz);
    if (!blob) return;

    pos = 0;
    memcpy(&nkeys, blob + pos, 2); pos += 2;

    for (i = 0; i < nkeys && g_text_count < MAX_TEXT_ENTRIES; i++) {
        klen = blob[pos++];
        if (pos + klen > sz) break;
        memcpy(g_texts[g_text_count].key, blob + pos, klen);
        g_texts[g_text_count].key[klen] = '\0';
        pos += klen;
        memcpy(&vlen, blob + pos, 2); pos += 2;
        if (pos + vlen > sz) break;
        { u16 copy = (u16)(vlen < 255 ? vlen : 255);
          char* _rp; char* _wp;
          memcpy(g_texts[g_text_count].val, blob + pos, copy);
          g_texts[g_text_count].val[copy] = '\0';
          /* Convertir secuencia literal \n (0x5C 0x6E) a newline (0x0A) en el val */
          _rp = g_texts[g_text_count].val; _wp = _rp;
          while (*_rp) {
              if (*_rp == '\\' && *(_rp+1) == 'n') { *_wp++ = '\n'; _rp += 2; }
              else { *_wp++ = *_rp++; }
          }
          *_wp = '\0'; }
        pos += vlen;
        g_text_count++;
    }
    free(blob);
}

const char* engine_text(const char* key) {
    int i;
    for (i = 0; i < g_text_count; i++)
        if (_str_eq(g_texts[i].key, key)) return g_texts[i].val;
    return key; /* fallback: devuelve la clave si no existe */
}

/* ===========================================================================
 * S9 - FLAGS Y ATRIBUTOS
 * =========================================================================== */

void engine_on_flag_change(const char* flag, const char* op, void (*handler)(void)) {
    FlagWatcher* w;
    int expect;
    if (g_flag_watcher_count >= MAX_FLAG_WATCHERS) return;
    if      (_str_eq(op, "is_false")) expect = 0;
    else if (_str_eq(op, "is_true"))  expect = 1;
    else { const char* _p = op; int _n = 0; int _neg = 0;
           if (*_p == '-') { _neg = 1; _p++; }
           while (*_p >= '0' && *_p <= '9') _n = _n*10 + (*_p++ - '0');
           expect = _neg ? -_n : _n; }
    w = &g_flag_watchers[g_flag_watcher_count++];
    _strlcpy(w->flag, flag ? flag : "", 32);
    w->expect  = expect;
    w->handler = handler;
    w->fired   = 0;
}

void engine_set_flag(const char* name, const char* value) {
    int i, v;
    v = (strcmp(value, "true") == 0)  ? 1 :
        (strcmp(value, "false") == 0) ? 0 : atoi(value);
    for (i = 0; i < g_flag_count; i++) {
        if (_str_eq(g_flags[i].name, name)) { g_flags[i].value = v; return; }
    }
    if (g_flag_count < MAX_FLAGS) {
        _strlcpy(g_flags[g_flag_count].name, name, 32);
        g_flags[g_flag_count].value = v;
        g_flag_count++;
    }
}

int engine_get_flag(const char* name) {
    int i;
    for (i = 0; i < g_flag_count; i++)
        if (_str_eq(g_flags[i].name, name)) return g_flags[i].value;
    return 0;
}

/* Evaluacion minima de condiciones serializadas como JSON string.
 * Soporta: { "type":"flag", "name":"x", "op":"eq", "value":"true" }
 * Implementacion simplificada: solo flag==value por ahora. */
/* Extrae el valor de una clave de string del JSON plano: {"key":"valor"} */
static int _json_str(const char* json, const char* key, char* out, int max) {
    char kbuf[40]; int klen;
    kbuf[0]='"'; _strlcpy(kbuf+1, key, 36); klen=(int)strlen(kbuf);
    kbuf[klen]='"'; kbuf[klen+1]=0;
    const char* p = strstr(json, kbuf);
    if (!p) return 0;
    p = strchr(p + klen + 1, '"'); if (!p) return 0; p++;
    const char* e = strchr(p, '"'); if (!e) return 0;
    int l = (int)(e-p); if (l >= max) l = max-1;
    memcpy(out, p, (u32)l); out[l] = 0;
    return 1;
}

int engine_eval_cond(const char* cond_json) {
    char type[32] = "", name[32] = "", val[32] = "";
    int i;
    if (!cond_json || !cond_json[0]) return 1;
    _json_str(cond_json, "type", type, 32);

    /* has_item: verdadero si CUALQUIER miembro del grupo lleva el objeto */
    if (_str_eq(type, "has_item")) {
        char item_id[32] = "";
        _json_str(cond_json, "itemId", item_id, 32);
        if (!item_id[0]) return 0;
        for (i = 0; i < g_inv_count; i++)
            if (_str_eq(g_inventory[i].obj_id, item_id)) return 1;
        return 0;
    }

    /* prot_has_item: verdadero solo si el protagonista activo lleva el objeto.
     * g_active_prot_id persiste a traves de cambios de sala. */
    if (_str_eq(type, "prot_has_item")) {
        char item_id[32] = "";
        const char* pid = g_active_prot_id[0] ? g_active_prot_id : "";
        _json_str(cond_json, "itemId", item_id, 32);
        if (!item_id[0] || !pid[0]) return 0;
        for (i = 0; i < g_inv_count; i++)
            if (_str_eq(g_inventory[i].obj_id, item_id) &&
                (!g_inventory[i].char_owner[0] || _str_eq(g_inventory[i].char_owner, pid)))
                return 1;
        return 0;
    }

    /* flag (por defecto): {"name":"flag","value":"true"} */
    _json_str(cond_json, "name",  name, 32);
    _json_str(cond_json, "value", val,  32);
    if (!name[0]) return 1;
    { int fv = engine_get_flag(name);
      int tv = (_str_eq(val,"true")) ? 1 : (_str_eq(val,"false")) ? 0 : atoi(val);
      return fv == tv;
    }
}

void engine_set_attr(const char* target, const char* attr, const char* value) {
    int i, v = atoi(value);
    for (i = 0; i < g_attr_count; i++) {
        if (_str_eq(g_attrs[i].target, target) && _str_eq(g_attrs[i].attr, attr)) {
            g_attrs[i].value = v;
            if (g_death_attr[0] && _str_eq(attr, g_death_attr) && v <= 0) g_running = 0;
            return;
        }
    }
    if (g_attr_count < MAX_ATTRS) {
        _strlcpy(g_attrs[g_attr_count].target, target, 32);
        _strlcpy(g_attrs[g_attr_count].attr,   attr,   36);
        g_attrs[g_attr_count].value = v;
        g_attr_count++;
        if (g_death_attr[0] && _str_eq(attr, g_death_attr) && v <= 0) g_running = 0;
    }
}

void engine_add_attr(const char* target, const char* attr, const char* amount) {
    int i, delta = atoi(amount);
    for (i = 0; i < g_attr_count; i++) {
        if (_str_eq(g_attrs[i].target, target) && _str_eq(g_attrs[i].attr, attr)) {
            g_attrs[i].value += delta;
            if (g_death_attr[0] && _str_eq(attr, g_death_attr) && g_attrs[i].value <= 0) g_running = 0;
            return;
        }
    }
    engine_set_attr(target, attr, amount);
}

/* ===========================================================================
 * S10 - ROOMS
 * =========================================================================== */

/* Construye la tabla de oscurecimiento (g_shade_lut) a partir de g_pal_raw.
 * Para cada indice de paleta busca el color mas cercano al 50% de brillo.
 * Coste: O(256*256) = 65536 comparaciones enteras. Llamar solo en cambio de room. */
static void _build_shade_lut(void) {
    int i, j, best, bestd, dist, dr, dg, db;
    u8 tr, tg, tb;
    for (i = 0; i < 256; i++) {
        tr = g_pal_raw[i*3]   >> 1;
        tg = g_pal_raw[i*3+1] >> 1;
        tb = g_pal_raw[i*3+2] >> 1;
        best = 0; bestd = 0x7FFFFFFF;
        for (j = 0; j < 256; j++) {
            dr = (int)g_pal_raw[j*3]   - (int)tr;
            dg = (int)g_pal_raw[j*3+1] - (int)tg;
            db = (int)g_pal_raw[j*3+2] - (int)tb;
            dist = dr*dr + dg*dg + db*db;
            if (dist < bestd) { bestd = dist; best = j; }
        }
        g_shade_lut[i] = (u8)best;
    }
    /* Precomputar tabla de pasadas de shade por valor de lightmap (0=sin shade, 1-3=pasadas) */
    for (i = 0; i < 256; i++)
        g_shade_passes_lut[i] = (u8)((i >= 230) ? 0 : (i >= 128) ? 1 : (i >= 64) ? 2 : 3);
    g_shade_lut_valid = 1;
}

/* Recalcula el lightmap 80x50 cada frame (necesario para parpadeo).
 * Cada celda = 0 (oscuro) .. 255 (pleno brillo).
 * Se llama desde engine_flip solo si g_ambient_light < 100.
 *
 * Cono: para cone_angle < 360 se verifica con producto escalar entero (sin trig).
 *   cos(half_angle) se aproxima usando tablas de 4 niveles (45/90/135/180).
 *   dir_x / dir_y estan en escala -64..64 (codegen usa *64). */
static void _lmap_one(int cx, int cy, int r2, int eff_int,
                      int half_cos_64, int dot_dir, int dir_x, int dir_y) {
    int lx, ly, dx, dy, dist2, contrib, lv, dot;
    int r2sq = r2 * r2;
    /* Precalcular escala: (255 * eff_int / 100) / r2sq
     * Se usa escala 16-bit fija: scale16 = (255 * eff_int / 100) * 65536 / r2sq
     * Dentro del bucle: contrib = (r2sq - dist2) * scale16 >> 16  (sin division) */
    long scale16;
    if (r2sq < 1) r2sq = 1;
    scale16 = ((long)255 * eff_int / 100) * 65536L / r2sq;
    /* Bounding box del circulo: evita iterar todo el grid 80x50 por cada fuente */
    { int ly_min = cy - r2; if (ly_min < 0) ly_min = 0;
      int ly_max = cy + r2 + 1; if (ly_max > LM_H) ly_max = LM_H;
      int lx_min = cx - r2; if (lx_min < 0) lx_min = 0;
      int lx_max = cx + r2 + 1; if (lx_max > LM_W) lx_max = LM_W;
    for (ly = ly_min; ly < ly_max; ly++) {
        dy = ly - cy;
        for (lx = lx_min; lx < lx_max; lx++) {
            dx = lx - cx;
            dist2 = dx*dx + dy*dy;
            if (dist2 >= r2sq) continue;
            if (half_cos_64 > -65 && dist2 > 0) {
                dot = dir_x * dx + dir_y * dy;
                if (dot < 0 && half_cos_64 >= 0) continue;
                if ((long)dot * dot * 4096L <
                    (long)half_cos_64 * half_cos_64 * dot_dir * dist2) continue;
            }
            contrib = (int)(((long)(r2sq - dist2) * scale16) >> 16);
            lv = (int)g_lmap[ly * LM_W + lx] + contrib;
            if (lv > 255) lv = 255;
            g_lmap[ly * LM_W + lx] = (u8)lv;
        }
    }
    } /* bounding box */
}

/* Devuelve cos(cone_angle/2) * 64, escalado a entero.
 * El chequeo en _lmap_one es: dot >= half_cos * |d| * |v|
 * Un valor mas alto = cono mas estrecho.
 *   cone=360 -> omni (-65 = siempre pasa)
 *   cone=180 -> semiesfera, half=90 -> cos(90)=0
 *   cone=120 -> half=60  -> cos(60)=0.5  -> 32
 *   cone= 90 -> half=45  -> cos(45)=0.707 -> 45
 *   cone= 60 -> half=30  -> cos(30)=0.866 -> 55
 *   cone< 60 -> mas estrecho -> 60 */
static int _half_cos_64(int cone_angle) {
    if (cone_angle >= 360) return -65;  /* omnidireccional: siempre en cono */
    if (cone_angle >= 180) return   0;  /* cos(90°)=0 */
    if (cone_angle >= 120) return  32;  /* cos(60°)=0.5  -> 32/64 */
    if (cone_angle >= 90)  return  45;  /* cos(45°)≈0.707 -> 45/64 */
    if (cone_angle >= 60)  return  55;  /* cos(30°)≈0.866 -> 55/64 */
    return 60;                          /* cono estrecho ~22° */
}

static void _lmap_compute(void) {
    int cx, cy, r2, eff_int, half_cos, dot_dir, dir_xi, dir_yi;
    int li, ci;
    u8  has_dynamic = 0; /* 1 si hay parpadeo o luz de personaje movil */
    const int base_lv = (int)g_ambient_light * 255 / 100;
    static const s8 wave4[4] = { 1, 0, -1, 0 };

    /* Determinar si el lightmap puede reutilizarse del frame anterior */
    for (li = 0; li < g_room_light_count && !has_dynamic; li++)
        if (g_room_lights[li].flicker_amp > 0 && g_room_lights[li].flicker_hz > 0)
            has_dynamic = 1;
    for (ci = 0; ci < g_char_count && !has_dynamic; ci++)
        if (g_chars[ci].has_light && g_chars[ci].visible)
            has_dynamic = 1; /* posicion del personaje puede cambiar cada frame */

    if (!has_dynamic && !g_lmap_dirty) return; /* lmap valido: reusar */
    g_lmap_dirty = 0;

    /* Rellenar con valor ambiente */
    memset(g_lmap, (u8)base_lv, LM_W * LM_H);

    /* Fuentes de luz de la room */
    for (li = 0; li < g_room_light_count; li++) {
        RoomLight* l = &g_room_lights[li];
        eff_int = (int)l->intensity;
        if (l->flicker_amp > 0 && l->flicker_hz > 0) {
            u32 step_ms = 1000u / ((u32)l->flicker_hz * 4u);
            u8  phase   = (u8)((g_ticks_ms / (step_ms > 0 ? step_ms : 1)) & 3);
            eff_int += (int)wave4[phase] * (int)l->flicker_amp;
            if (eff_int < 0)   eff_int = 0;
            if (eff_int > 100) eff_int = 100;
        }
        cx = l->x >> 2;
        cy = l->y >> 2;
        r2 = l->radius >> 2;
        if (r2 < 1) r2 = 1;
        half_cos = _half_cos_64((int)l->cone_angle);
        dir_xi   = (int)l->dir_x;
        dir_yi   = (int)l->dir_y;
        dot_dir  = dir_xi * dir_xi + dir_yi * dir_yi;
        if (dot_dir < 1) dot_dir = 1;
        _lmap_one(cx, cy, r2, eff_int, half_cos, dot_dir, dir_xi, dir_yi);
    }

    /* Luces de personajes (linterna/antorcha) */
    for (ci = 0; ci < g_char_count; ci++) {
        Char* c = &g_chars[ci];
        if (!c->has_light || !c->visible) continue;
        eff_int = (int)c->light_intensity;
        if (c->light_flicker_amp > 0 && c->light_flicker_hz > 0) {
            u32 step_ms = 1000u / ((u32)c->light_flicker_hz * 4u);
            u8  phase   = (u8)(((g_ticks_ms + (u32)ci * 137u) / (step_ms > 0 ? step_ms : 1)) & 3);
            eff_int += (int)wave4[phase] * (int)c->light_flicker_amp;
            if (eff_int < 0)   eff_int = 0;
            if (eff_int > 100) eff_int = 100;
        }
        cx = (c->x + (int)c->light_off_x) >> 2;
        cy = (c->y + (int)c->light_off_y) >> 2;
        r2 = (int)c->light_radius >> 2;
        if (r2 < 1) r2 = 1;
        half_cos = _half_cos_64((int)c->light_cone);
        /* Dirección del cono sigue la orientación del personaje */
        if (c->light_cone < 360) {
            dir_xi = c->dir_left ? -64 : 64;
            dir_yi = 0;
        } else {
            dir_xi = 64; dir_yi = 0;
        }
        dot_dir = dir_xi * dir_xi + dir_yi * dir_yi;
        if (dot_dir < 1) dot_dir = 1;
        _lmap_one(cx, cy, r2, eff_int, half_cos, dot_dir, dir_xi, dir_yi);
    }
}

static void _room_clear_state(void) {
    int i;
    /* Liberar PCX de personajes */
    for (i = 0; i < g_char_count; i++) {
        if (g_chars[i].pcx_buf)   { free(g_chars[i].pcx_buf);   g_chars[i].pcx_buf = NULL; }
        if (g_chars[i].dec_buf)   { free(g_chars[i].dec_buf);   g_chars[i].dec_buf = NULL; }
        _spr_cache_free(g_chars[i].spr_cache); g_chars[i].spr_cache = NULL;
    }
    /* Liberar PCX de objetos */
    for (i = 0; i < g_obj_count; i++) {
        if (g_objects[i].pcx_buf)     { free(g_objects[i].pcx_buf);     g_objects[i].pcx_buf = NULL; }
        if (g_objects[i].inv_pcx_buf) { free(g_objects[i].inv_pcx_buf); g_objects[i].inv_pcx_buf = NULL; }
        if (g_objects[i].dec_buf)     { free(g_objects[i].dec_buf);     g_objects[i].dec_buf = NULL; }
        _spr_cache_free(g_objects[i].spr_cache); g_objects[i].spr_cache = NULL;
    }
    g_char_count  = 0;
    g_obj_count         = 0;
    g_over_light_count  = 0;
    g_bg_layer_count    = 0;
    g_entry_count = 0;
    g_exit_count  = 0;
    g_pending_exit_id[0] = '\0'; /* limpiar exit pendiente al cambiar de room */
    g_pending.type = PEND_NONE; g_pending.fn = NULL; /* cancelar accion pendiente — pertenecia a la room anterior */
    g_dar_mode = 0; g_dar_inv[0] = '\0'; g_dar_base[0] = '\0'; /* cancelar dar pendiente */
    g_scroll_halves     = 0;    /* resetear modo scroll-por-mitades */
    g_cam_pan_active    = 0;
    g_scroll_recovering = 0;
    engine_walkmap_clear();
    g_on_room_load  = NULL;
    g_on_room_enter = NULL;
    g_on_room_exit  = NULL;
    g_room_light_count = 0;
    g_ambient_light    = 100;
    g_lmap_dirty       = 1;
}

static const RoomEntry* _find_room_entry(const char* room_id) {
    int i;
    if (!g_room_table) return NULL;
    for (i = 0; g_room_table[i].id != NULL; i++)
        if (_str_eq(g_room_table[i].id, room_id)) return &g_room_table[i];
    return NULL;
}

void engine_change_room(const char* room_id, const char* entry_id) {
    const RoomEntry* re;
    EntryPoint* ep = NULL;
    int i;
    /* Copiar entry_id a buffer local ANTES de _room_clear_state()+load_fn().
     * entry_id puede apuntar a g_exits[i].target_entry, que load_fn() sobreescribe
     * al registrar los exits de la nueva room en el mismo slot de memoria. */
    char entry_buf[64];
    _strlcpy(entry_buf, entry_id ? entry_id : "", sizeof(entry_buf));
    entry_id = entry_buf;

    /* Guardar datos del protagonista antes de limpiar la room */
    Char saved_prot;
    int  had_protagonist = 0;

    DBG("change_room: room=%s entry=%s chars=%d\n",
        room_id ? room_id : "(null)",
        entry_id,
        g_char_count);

    /* Disparar room_exit si hay handler y no esta bloqueado */
    if (g_on_room_exit) {
        g_exit_blocked = 0;
        g_on_room_exit();
        if (g_exit_blocked) return;
    }

    if (g_char_count > 0) {
        saved_prot     = g_chars[g_protagonist];
        saved_prot.pcx_buf   = NULL;
        saved_prot.pcx_size  = 0;
        saved_prot.pcx_loaded[0] = '\0';
        saved_prot.dec_buf   = NULL; /* dec_buf sera liberado por _room_clear_state — no heredar puntero muerto */
        saved_prot.dec_w     = 0;
        saved_prot.dec_h     = 0;
        had_protagonist = 1;
        _strlcpy(g_active_prot_id, g_chars[g_protagonist].id, 32);
        DBG("change_room: saved prot=%s x=%d y=%d\n", saved_prot.id, (int)saved_prot.x, (int)saved_prot.y);
    }

    /* Guardar posicion del protagonista actual en la tabla de party ANTES de limpiar */
    _party_save_all();
    g_party_popup_open = 0; /* cerrar popup al cambiar de room */

    _room_clear_state();
    _strlcpy(g_cur_room,  room_id,  sizeof(g_cur_room));
    _strlcpy(g_cur_entry, entry_id ? entry_id : "", sizeof(g_cur_entry));

    re = _find_room_entry(room_id);
    if (!re) { DBG("change_room: room NOT FOUND\n"); return; }

    /* Llamar a la funcion de carga de room (registra entries, exits, walkmaps, etc.) */
    re->load_fn();

    DBG("change_room: after load_fn entries=%d chars=%d\n", g_entry_count, g_char_count);
    for (i = 0; i < g_entry_count; i++)
        DBG("  entry[%d] id=%s x=%d y=%d\n", i, g_entries[i].id, (int)g_entries[i].x, (int)g_entries[i].y);

    /* Restaurar estados persistidos (p.ej. puertas abiertas) ANTES del predecode,
     * para que _room_predecode_all use el PCX del estado correcto. */
    _apply_persisted_states();
    /* Pre-decodificar todos los PCX de la room en RAM — el render no vuelve a hacer RLE */
    _room_predecode_all();

    /* Si la nueva room no coloco al protagonista, reinyectarlo */
    if (had_protagonist && !g_suppress_prot_reinject) {
        int prot_placed = 0; int j;
        for (i = 0; i < g_char_count; i++) {
            if (_str_eq(g_chars[i].id, saved_prot.id)) {
                prot_placed = 1; g_protagonist = i;
                _strlcpy(g_active_prot_id, g_chars[i].id, 32);
                DBG("change_room: prot_placed=1 idx=%d\n", i);
                /* Aunque la room ya coloco al protagonista, aplicar entry point
                 * si viene de un engine_change_room con entry_id explicito.
                 * La posicion en room.json es el spawn inicial, no el de llegada. */
                if (entry_id && entry_id[0]) {
                    for (j = 0; j < g_entry_count; j++) {
                        if (_str_eq(g_entries[j].id, entry_id)) { ep = &g_entries[j]; break; }
                    }
                    if (ep) {
                        DBG("change_room: prot_placed ep found x=%d y=%d\n", (int)ep->x, (int)ep->y);
                        g_chars[g_protagonist].x = ep->x;
                        g_chars[g_protagonist].y = ep->y;
                    } else {
                        DBG("change_room: prot_placed ep NOT found entry_id=%s\n", entry_id);
                    }
                }
                /* Actualizar room y posicion del protagonista en el party */
                { int _pfp = _party_find(g_chars[g_protagonist].id);
                  if (_pfp >= 0) {
                      _strlcpy(g_party[_pfp].room_id, g_cur_room, 32);
                      g_party[_pfp].x = g_chars[g_protagonist].x;
                      g_party[_pfp].y = g_chars[g_protagonist].y;
                  }
                }
                break;
            }
        }
        if (!prot_placed && g_char_count < MAX_CHARS) {
            DBG("change_room: prot_placed=0 reinject\n");
            u32 sz = 0;
            g_chars[g_char_count] = saved_prot;
            g_chars[g_char_count].visible = 1;
            g_chars[g_char_count].walking = 0;
            g_chars[g_char_count].path_len = 0;
            CHAR_SET_ANIM(&g_chars[g_char_count], ANIM_IDLE);
            if (saved_prot.anims[ANIM_IDLE].id[0]) {
                g_chars[g_char_count].pcx_buf = (u8*)engine_dat_load_gfx(saved_prot.anims[ANIM_IDLE].id, &sz);
                g_chars[g_char_count].pcx_size = sz;
                _strlcpy(g_chars[g_char_count].pcx_loaded, saved_prot.anims[ANIM_IDLE].id, 32);
            }
            g_protagonist = g_char_count;
            g_char_count++;
            /* Pre-decodificar PCX del protagonista reinyectado */
            { Char* _cp = &g_chars[g_protagonist];
              if (_cp->pcx_buf) {
                  u16 _w = 0, _h = 0;
                  _pcx_decode(_cp->pcx_buf, _cp->pcx_size, g_pcx_decode_buf, &_w, &_h, 0);
                  if (_w > 0 && _h > 0) {
                      _cp->dec_w = _w; _cp->dec_h = _h;
                      if (!_cp->dec_buf && (u32)_w * _h <= (u32)AG_SCREEN_PIXELS) {
                          _cp->dec_buf = (u8*)malloc((u32)_w * _h);
                          if (_cp->dec_buf) memcpy(_cp->dec_buf, g_pcx_decode_buf, (u32)_w * _h);
                      }
                  }
              }
            }
            /* Protagonista reinyectado (no estaba en esta room) — aplicar entry point.
             * Si entry_id no se especifico o no existe, usar el primer entry disponible. */
            { ep = NULL;
              if (entry_id && entry_id[0]) {
                  for (i = 0; i < g_entry_count; i++)
                      if (_str_eq(g_entries[i].id, entry_id)) { ep = &g_entries[i]; break; }
              }
              if (!ep && g_entry_count > 0) ep = &g_entries[0];
              DBG("change_room: reinject ep=%s entry_id=%s entries=%d\n",
                  ep ? ep->id : "(none)", entry_id ? entry_id : "", g_entry_count);
              if (ep) {
                  DBG("change_room: reinject final pos x=%d y=%d\n", (int)ep->x, (int)ep->y);
                  g_chars[g_protagonist].x = ep->x;
                  g_chars[g_protagonist].y = ep->y;
              }
            }
            /* Actualizar room y posicion del protagonista reinyectado en el party */
            { int _pfr = _party_find(g_chars[g_protagonist].id);
              if (_pfr >= 0) {
                  _strlcpy(g_party[_pfr].room_id, g_cur_room, 32);
                  g_party[_pfr].x = g_chars[g_protagonist].x;
                  g_party[_pfr].y = g_chars[g_protagonist].y;
              }
            }
        }
        /* Si la room ya lo coloco con engine_place_char, respeta su posicion/dir/anim */
        DBG("change_room: final prot pos x=%d y=%d\n",
            (int)g_chars[g_protagonist].x, (int)g_chars[g_protagonist].y);
    }

    /* Aplicar cambio de protagonista pendiente (cross-room party switch) */
    if (g_party_switch_pending[0]) {
        int _psw_i;
        int _psw_pidx = _party_find(g_party_switch_pending);
        int _psw_found = 0;
        /* Buscar el personaje en la room recien cargada */
        for (_psw_i = 0; _psw_i < g_char_count; _psw_i++) {
            if (_str_eq(g_chars[_psw_i].id, g_party_switch_pending)) {
                _psw_found = 1;
                g_protagonist = _psw_i;
                /* Restaurar ultima posicion guardada */
                if (_psw_pidx >= 0) {
                    g_chars[_psw_i].x = g_party[_psw_pidx].x;
                    g_chars[_psw_i].y = g_party[_psw_pidx].y;
                }
                g_inv_scroll = 0; g_inv_hover = -1;
                /* Actualizar room del nuevo protagonista en el party */
                if (_psw_pidx >= 0) {
                    _strlcpy(g_party[_psw_pidx].room_id, g_cur_room, 32);
                    g_party[_psw_pidx].x = g_chars[g_protagonist].x;
                    g_party[_psw_pidx].y = g_chars[g_protagonist].y;
                    /* Restaurar direccion y animacion guardadas */
                    if (g_party[_psw_pidx].dir[0])
                        engine_face_dir(g_party_switch_pending, g_party[_psw_pidx].dir);
                }
                DBG("change_room: party switch -> prot=%s x=%d y=%d\n",
                    g_chars[g_protagonist].id,
                    (int)g_chars[g_protagonist].x, (int)g_chars[g_protagonist].y);
                break;
            }
        }
        /* El personaje no fue colocado por load_fn — reinyectar via place_fn */
        if (!_psw_found && _psw_pidx >= 0 && g_party[_psw_pidx].place_fn &&
            g_char_count < MAX_CHARS) {
            s16 _ppx = g_party[_psw_pidx].x;
            s16 _ppy = g_party[_psw_pidx].y;
            /* Limpiar room_id temporalmente para que engine_place_char no filtre */
            g_party[_psw_pidx].room_id[0] = '\0';
            g_party[_psw_pidx].place_fn(_ppx, _ppy);
            /* Buscar el char recien colocado y hacerlo protagonista */
            for (_psw_i = 0; _psw_i < g_char_count; _psw_i++) {
                if (_str_eq(g_chars[_psw_i].id, g_party_switch_pending)) {
                    g_protagonist = _psw_i;
                    g_inv_scroll = 0; g_inv_hover = -1;
                    _strlcpy(g_party[_psw_pidx].room_id, g_cur_room, 32);
                    g_party[_psw_pidx].x = g_chars[g_protagonist].x;
                    g_party[_psw_pidx].y = g_chars[g_protagonist].y;
                    /* Pre-decodificar PCX del personaje reinyectado via place_fn */
                    { Char* _ppc = &g_chars[g_protagonist];
                      if (_ppc->pcx_buf) {
                          u16 _pw = 0, _ph = 0;
                          _pcx_decode(_ppc->pcx_buf, _ppc->pcx_size, g_pcx_decode_buf, &_pw, &_ph, 0);
                          if (_pw > 0 && _ph > 0) {
                              _ppc->dec_w = _pw; _ppc->dec_h = _ph;
                              if (!_ppc->dec_buf && (u32)_pw * _ph <= (u32)AG_SCREEN_PIXELS) {
                                  _ppc->dec_buf = (u8*)malloc((u32)_pw * _ph);
                                  if (_ppc->dec_buf) memcpy(_ppc->dec_buf, g_pcx_decode_buf, (u32)_pw * _ph);
                              }
                          }
                      }
                    }
                    /* Restaurar direccion y animacion guardadas */
                    if (g_party[_psw_pidx].dir[0])
                        engine_face_dir(g_party_switch_pending, g_party[_psw_pidx].dir);
                    { /* Restaurar animacion si no es idle (tabla de roles) */
                      static const char* _aroles[] = {
                          "idle","walk_right","walk_left","walk_up","walk_down",
                          "idle_up","idle_down","","talk","talk_up","talk_down","talk_left","give"
                      };
                      u8 _ca = g_party[_psw_pidx].cur_anim;
                      if (_ca != ANIM_IDLE && _ca < 13 && _aroles[_ca][0])
                          engine_set_anim(g_party_switch_pending, _aroles[_ca]);
                    }
                    DBG("change_room: party place_fn -> prot=%s x=%d y=%d dir=%s anim=%d\n",
                        g_chars[g_protagonist].id,
                        (int)g_chars[g_protagonist].x, (int)g_chars[g_protagonist].y,
                        g_party[_psw_pidx].dir, (int)g_party[_psw_pidx].cur_anim);
                    break;
                }
            }
        }
        g_party_switch_pending[0] = '\0';
    }

    /* Recolocar miembros del party que ya estaban en esta room y fueron borrados
     * por _room_clear_state al entrar otro personaje. Cada personaje es independiente
     * y debe aparecer en su ultima posicion guardada si su room_id coincide. */
    {
        int _rpi;
        for (_rpi = 0; _rpi < g_party_count; _rpi++) {
            if (!_str_eq(g_party[_rpi].room_id, g_cur_room)) continue;
            if (_find_char(g_party[_rpi].id)) continue; /* ya colocado */
            if (!g_party[_rpi].place_fn || g_char_count >= MAX_CHARS) continue;
            g_party[_rpi].place_fn((s16)g_party[_rpi].x, (s16)g_party[_rpi].y);
            { Char* _rpc = _find_char(g_party[_rpi].id);
              if (_rpc && _rpc->pcx_buf) {
                  u16 _rw = 0, _rh = 0;
                  _pcx_decode(_rpc->pcx_buf, _rpc->pcx_size, g_pcx_decode_buf, &_rw, &_rh, 0);
                  if (_rw > 0 && _rh > 0) {
                      _rpc->dec_w = _rw; _rpc->dec_h = _rh;
                      if (!_rpc->dec_buf && (u32)_rw * _rh <= (u32)AG_SCREEN_PIXELS) {
                          _rpc->dec_buf = (u8*)malloc((u32)_rw * _rh);
                          if (_rpc->dec_buf) memcpy(_rpc->dec_buf, g_pcx_decode_buf, (u32)_rw * _rh);
                      }
                  }
              }
            }
            DBG("change_room: reinstate %s at x=%d y=%d\n",
                g_party[_rpi].id, (int)g_party[_rpi].x, (int)g_party[_rpi].y);
        }
    }

    g_suppress_prot_reinject = 0;

    /* Ajustar camara instantaneamente al half correcto del protagonista.
     * engine_set_scroll_halves() se llama durante load_fn cuando g_char_count==0
     * y no puede posicionar la camara; lo corregimos aqui, una vez que el
     * protagonista ya esta colocado con su posicion real (party o reinject). */
    if (g_scroll_halves && g_char_count > 0) {
        s16 _snap = (g_chars[g_protagonist].x >= (s16)g_scroll_half_w) ? (s16)g_scroll_half_w : 0;
        if (_snap != g_cam_x) {
            g_cam_x = _snap;
            engine_set_cam_x(g_cam_x);
        }
        g_cam_pan_active = 0;
    }

    /* Disparar room_load */
    if (g_on_room_load) g_on_room_load();

    /* Disparar room_enter */
    if (g_on_room_enter) { DBG("change_room: firing on_room_enter\n"); g_on_room_enter(); }

    /* Flush: dibujar la nueva room una vez antes de continuar la secuencia.
     * Sin esto, engine_seq_show_text toma g_ticks_ms antes de que el fondo
     * se haya pintado y el timer puede expirar o el texto aparecer encima
     * del fondo antiguo. */
    engine_flip();
}

void engine_set_room_table(const RoomEntry* rooms) { g_room_table = rooms; }

void engine_enter_closeup(const char* room_id, int show_ui) {
    _strlcpy(g_prev_room, g_cur_room, sizeof(g_prev_room));
    if (g_char_count > 0)
        _strlcpy(g_closeup_prot_id, g_chars[g_protagonist].id, sizeof(g_closeup_prot_id));
    else
        g_closeup_prot_id[0] = '\0';
    g_suppress_prot_reinject = 1;
    if (show_ui) engine_show_ui(); else engine_hide_ui();
    engine_change_room(room_id, "");
}

void engine_exit_closeup(void) {
    char _ret[32];
    char _pid[32];
    int  _ei;
    if (!g_prev_room[0]) return;
    _strlcpy(_ret, g_prev_room, sizeof(_ret));
    _strlcpy(_pid, g_closeup_prot_id, sizeof(_pid));
    g_prev_room[0] = '\0';
    g_closeup_prot_id[0] = '\0';
    /* Protagonista no esta en esta room (closeup solo tiene NPCs): evitar que
     * g_chars[g_protagonist] stale se reinyecte como protagonista en prev_room.
     * El party reinstate loop lo colocara correctamente desde la tabla de party. */
    if (_pid[0] && !_find_char(_pid))
        g_suppress_prot_reinject = 1;
    engine_change_room(_ret, "");
    engine_show_ui();
    /* Actualizar g_protagonist al indice real tras el reinstate */
    if (_pid[0]) {
        for (_ei = 0; _ei < g_char_count; _ei++) {
            if (_str_eq(g_chars[_ei].id, _pid)) { g_protagonist = _ei; break; }
        }
    }
}

/* -- Iluminacion publica --------------------------------------------------- */

void engine_set_ambient_light(u8 pct) {
    int base_lv;
    g_ambient_light = (pct > 100) ? 100 : pct;
    g_lmap_dirty    = 1;
    /* Precomputar sprite_shade_passes para pass 1 (over_light) */
    base_lv = (int)g_ambient_light * 255 / 100;
    g_sprite_shade_passes = (u8)((base_lv < 64) ? 3 : (base_lv < 128) ? 2 : (base_lv < 230) ? 1 : 0);
}

void engine_char_set_light(const char* char_id,
                           s16 off_x, s16 off_y, s16 radius, u8 intensity,
                           u16 cone_angle, u8 flicker_amp, u8 flicker_hz) {
    Char* c = _find_char(char_id);
    if (!c) return;
    c->has_light       = 1;
    c->light_off_x     = off_x;
    c->light_off_y     = off_y;
    c->light_radius    = radius;
    c->light_intensity = (intensity > 100) ? 100 : intensity;
    c->light_cone      = cone_angle;
    c->light_flicker_amp = flicker_amp;
    c->light_flicker_hz  = flicker_hz;
}

void engine_add_room_light(s16 x, s16 y, s16 radius, u8 intensity,
                           u16 cone_angle, s8 dir_x, s8 dir_y,
                           u8 flicker_amp, u8 flicker_hz) {
    RoomLight* l;
    if (g_room_light_count >= MAX_ROOM_LIGHTS) return;
    l = &g_room_lights[g_room_light_count++];
    l->x          = x;
    l->y          = y;
    l->radius     = radius;
    l->intensity  = (intensity > 100) ? 100 : intensity;
    l->cone_angle = cone_angle;
    l->dir_x      = dir_x;
    l->dir_y      = dir_y;
    l->flicker_amp = flicker_amp;
    l->flicker_hz  = flicker_hz;
}

void engine_register_entry(const char* id, s16 x, s16 y) {
    if (g_entry_count >= MAX_ENTRIES) return;
    _strlcpy(g_entries[g_entry_count].id, id, 32);
    g_entries[g_entry_count].x = x;
    g_entries[g_entry_count].y = y;
    g_entry_count++;
}

/* initial_enabled: estado por defecto del exit en el diseño de la sala (0=bloqueado, 1=libre).
 * Si el script lo modificó en una visita anterior, el estado persistido tiene prioridad. */
void engine_register_exit(const char* id, s16 x, s16 y, s16 w, s16 h,
                           const char* target_room, const char* target_entry,
                           const char* name_key, u8 initial_enabled) {
    int _j;
    if (g_exit_count >= MAX_EXITS) return;
    _strlcpy(g_exits[g_exit_count].id,           id,           32);
    g_exits[g_exit_count].tz.x = x; g_exits[g_exit_count].tz.y = y;
    g_exits[g_exit_count].tz.w = w; g_exits[g_exit_count].tz.h = h;
    _strlcpy(g_exits[g_exit_count].target_room,  target_room,  32);
    _strlcpy(g_exits[g_exit_count].target_entry, target_entry, 32);
    _strlcpy(g_exits[g_exit_count].name_key,     name_key ? name_key : "", 48);
    /* Estado por defecto: el diseñado en el editor */
    g_exits[g_exit_count].enabled = initial_enabled;
    /* Si el script ya cambió este exit en una visita anterior, ese estado tiene prioridad */
    for (_j = 0; _j < g_exit_state_count; _j++) {
        if (_str_eq(g_exit_states[_j].room_id, g_cur_room) &&
            _str_eq(g_exit_states[_j].exit_id, id)) {
            g_exits[g_exit_count].enabled = g_exit_states[_j].enabled;
            break;
        }
    }
    g_exit_count++;
}

void engine_set_exit_enabled(const char* exit_id, u8 enabled) {
    int i;
    /* Actualizar array activo de la sala actual */
    for (i = 0; i < g_exit_count; i++)
        if (_str_eq(g_exits[i].id, exit_id)) { g_exits[i].enabled = enabled; break; }
    /* Persistir en tabla global para restaurar al volver a la sala */
    for (i = 0; i < g_exit_state_count; i++) {
        if (_str_eq(g_exit_states[i].room_id, g_cur_room) &&
            _str_eq(g_exit_states[i].exit_id, exit_id)) {
            g_exit_states[i].enabled = enabled;
            return;
        }
    }
    if (g_exit_state_count < MAX_EXIT_STATES) {
        _strlcpy(g_exit_states[g_exit_state_count].room_id, g_cur_room, 32);
        _strlcpy(g_exit_states[g_exit_state_count].exit_id, exit_id,    32);
        g_exit_states[g_exit_state_count].enabled = enabled;
        g_exit_state_count++;
    }
}

static Exit* _hit_exit(s16 mx, s16 my) {
    int i;
    for (i = 0; i < g_exit_count; i++) {
        Rect* tz;
        if (!g_exits[i].enabled) continue;
        tz = &g_exits[i].tz;
        if (mx >= tz->x && mx < tz->x + tz->w &&
            my >= tz->y && my < tz->y + tz->h)
            return &g_exits[i];
    }
    return NULL;
}

/* -- Walkmap ---------------------------------------------------------------- */
void engine_walkmap_clear(void) {
    memset(g_walkmap, 0, sizeof(g_walkmap));
    g_wm_w = (320 / WALKMAP_CELL_SIZE);
    g_wm_h = (144 / WALKMAP_CELL_SIZE);
}

/* Carga el walkmap desde un bitmap pre-rasterizado (generado en compile-time).
 * Establece las dimensiones reales de la grilla para esta room. */
void engine_walkmap_load_bitmap(const unsigned char* bm, int w, int h) {
    int gx, gy;
    g_wm_w = (w > WM_MAX_W) ? WM_MAX_W : w;
    g_wm_h = (h > WM_MAX_H) ? WM_MAX_H : h;
    for (gy = 0; gy < g_wm_h; gy++)
        for (gx = 0; gx < g_wm_w; gx++)
            g_walkmap[gy * g_wm_w + gx] = bm[gy * w + gx] ? 1 : 0;
}

/* Compat: rellenar celdas del rect en la bitmap */
void engine_walkmap_add_rect(s16 x, s16 y, s16 w, s16 h) {
    int gx, gy;
    for (gy = 0; gy < g_wm_h; gy++) {
        s16 py = (s16)(gy * WALKMAP_CELL_SIZE + WALKMAP_CELL_SIZE / 2);
        if (py < y || py >= y + h) continue;
        for (gx = 0; gx < g_wm_w; gx++) {
            s16 px = (s16)(gx * WALKMAP_CELL_SIZE + WALKMAP_CELL_SIZE / 2);
            if (px >= x && px < x + w) g_walkmap[gy * g_wm_w + gx] = 1;
        }
    }
}

void engine_set_walkmap(const char* id) { (void)id; }

void engine_walkmap_add_poly(int* pts, int n) {
    /* Aproximacion: bounding box del poligono como rect navegable */
    s16 mx, my, xx, xy; int i;
    if (n < 2) return;
    mx = (s16)pts[0]; my = (s16)pts[1]; xx = mx; xy = my;
    for (i = 1; i < n; i++) {
        s16 px = (s16)pts[i*2], py = (s16)pts[i*2+1];
        if (px < mx) mx = px; if (px > xx) xx = px;
        if (py < my) my = py; if (py > xy) xy = py;
    }
    engine_walkmap_add_rect(mx, my, (s16)(xx-mx), (s16)(xy-my));
}

/* ===========================================================================
 * S11 - PERSONAJES
 * =========================================================================== */

void engine_place_char(const char* char_id, s16 x, s16 y,
    const char* idle_pcx,   int idle_frames,   int idle_fps,   int idle_fw,
    const char* wr_pcx,     int wr_frames,     int wr_fps,     int wr_fw,
    const char* wl_pcx,     int wl_frames,     int wl_fps,     int wl_fw,     int wl_flip,
    const char* wu_pcx,     int wu_frames,     int wu_fps,     int wu_fw,
    const char* wd_pcx,     int wd_frames,     int wd_fps,     int wd_fw,
    const char* idu_pcx,    int idu_frames,    int idu_fps,    int idu_fw,
    const char* idd_pcx,    int idd_frames,    int idd_fps,    int idd_fw,
    int speed, int is_protagonist) {

    Char* c;
    u32 sz;
    if (g_char_count >= MAX_CHARS) return;

    /* Party filter: si el personaje ya tiene una room asignada en el party
     * y no coincide con la room actual, no colocar aqui (esta en otra room). */
    if (g_party_count > 0 && g_cur_room[0]) {
        int _pfc = _party_find(char_id);
        if (_pfc >= 0 && g_party[_pfc].room_id[0] != '\0' &&
            !_str_eq(g_party[_pfc].room_id, g_cur_room)) {
            DBG("engine_place_char: SKIP %s (party room=%s cur=%s)\n",
                char_id, g_party[_pfc].room_id, g_cur_room);
            return;
        }
    }

    c = &g_chars[g_char_count];
    memset(c, 0, sizeof(Char));
    _strlcpy(c->id, char_id, 32);
    c->x = x; c->y = y;
    c->visible  = 1;
    c->speed    = (u8)(speed > 0 ? speed : 2);
    c->base_speed = c->speed;
    _strlcpy(c->dir, "right", 8); c->dir_left = 0;

    /* idle (sprite base mirando derecha — se espejara en runtime si dir=="left") */
    _strlcpy(c->anims[ANIM_IDLE].id, idle_pcx, 32);
    c->anims[ANIM_IDLE].frames = (u8)idle_frames;
    c->anims[ANIM_IDLE].fps    = (u8)idle_fps;
    c->anims[ANIM_IDLE].fw     = (u16)idle_fw;
    c->anims[ANIM_IDLE].flip   = 0;
    /* walk_right */
    _strlcpy(c->anims[ANIM_WALK_RIGHT].id, wr_pcx, 32);
    c->anims[ANIM_WALK_RIGHT].frames = (u8)wr_frames;
    c->anims[ANIM_WALK_RIGHT].fps    = (u8)wr_fps;
    c->anims[ANIM_WALK_RIGHT].fw     = (u16)wr_fw;
    c->anims[ANIM_WALK_RIGHT].flip   = 0;
    /* walk_left */
    _strlcpy(c->anims[ANIM_WALK_LEFT].id, wl_pcx, 32);
    c->anims[ANIM_WALK_LEFT].frames  = (u8)wl_frames;
    c->anims[ANIM_WALK_LEFT].fps     = (u8)wl_fps;
    c->anims[ANIM_WALK_LEFT].fw      = (u16)wl_fw;
    c->anims[ANIM_WALK_LEFT].flip    = (u8)wl_flip;
    /* walk_up */
    _strlcpy(c->anims[ANIM_WALK_UP].id, wu_pcx, 32);
    c->anims[ANIM_WALK_UP].frames    = (u8)wu_frames;
    c->anims[ANIM_WALK_UP].fps       = (u8)wu_fps;
    c->anims[ANIM_WALK_UP].fw        = (u16)wu_fw;
    c->anims[ANIM_WALK_UP].flip      = 0;
    /* walk_down */
    _strlcpy(c->anims[ANIM_WALK_DOWN].id, wd_pcx, 32);
    c->anims[ANIM_WALK_DOWN].frames  = (u8)wd_frames;
    c->anims[ANIM_WALK_DOWN].fps     = (u8)wd_fps;
    c->anims[ANIM_WALK_DOWN].fw      = (u16)wd_fw;
    c->anims[ANIM_WALK_DOWN].flip    = 0;
    /* idle_up — fallback a idle si pcx vacio */
    _strlcpy(c->anims[ANIM_IDLE_UP].id, (idu_pcx && idu_pcx[0]) ? idu_pcx : "", 32);
    c->anims[ANIM_IDLE_UP].frames = (u8)idu_frames;
    c->anims[ANIM_IDLE_UP].fps    = (u8)idu_fps;
    c->anims[ANIM_IDLE_UP].fw     = (u16)idu_fw;
    c->anims[ANIM_IDLE_UP].flip   = 0;
    /* idle_down — fallback a idle si pcx vacio */
    _strlcpy(c->anims[ANIM_IDLE_DOWN].id, (idd_pcx && idd_pcx[0]) ? idd_pcx : "", 32);
    c->anims[ANIM_IDLE_DOWN].frames = (u8)idd_frames;
    c->anims[ANIM_IDLE_DOWN].fps    = (u8)idd_fps;
    c->anims[ANIM_IDLE_DOWN].fw     = (u16)idd_fw;
    c->anims[ANIM_IDLE_DOWN].flip   = 0;

    /* Inicializar cache de animacion */
    CHAR_SET_ANIM(c, ANIM_IDLE);
    c->dec_buf = NULL; c->dec_w = 0; c->dec_h = 0; c->spr_cache = NULL;

    /* Cargar PCX de idle en RAM */
    if (idle_pcx && idle_pcx[0]) {
        c->pcx_buf  = (u8*)engine_dat_load_gfx(idle_pcx, &sz);
        c->pcx_size = sz;
        _strlcpy(c->pcx_loaded, idle_pcx, 32);
        /* Pre-decodificar para que dec_w/dec_h sean válidos antes del primer render
         * y para que _hit_char pueda calcular el hitbox correcto. */
        if (c->pcx_buf) {
            u16 _dw=0,_dh=0;
            _pcx_decode(c->pcx_buf, sz, g_pcx_decode_buf, &_dw, &_dh, 0);
            if (_dw>0 && _dh>0) {
                c->dec_w=_dw; c->dec_h=_dh;
                if ((u32)_dw*_dh <= (u32)AG_SCREEN_PIXELS) {
                    c->dec_buf = (u8*)malloc((u32)_dw*_dh);
                    if (c->dec_buf) { memcpy(c->dec_buf, g_pcx_decode_buf, (u32)_dw*_dh); }
                }
            }
        }
        if (!c->pcx_buf) DBG("WARN: engine_place_char: PCX no encontrado en DAT: %s\n", idle_pcx);
    } else {
        DBG("WARN: engine_place_char: %s colocado sin PCX idle (cadena vacia)\n", char_id);
    }
    DBG("engine_place_char: id=%s x=%d y=%d idle=%s pcx_buf=%s protagonista=%d\n",
        char_id, (int)x, (int)y,
        (idle_pcx && idle_pcx[0]) ? idle_pcx : "(vacio)",
        c->pcx_buf ? "OK" : "NULL",
        is_protagonist);
    c->cur_anim  = ANIM_IDLE;
    c->frame_cur = 0;
    c->frame_timer = 0;

    /* Solo actualizar g_protagonist si no hay ninguno valido todavia.
     * Las llamadas de on_room_enter para miembros no-activos del party
     * no deben sobreescribir al protagonista ya fijado por reinject/party_switch. */
    if (is_protagonist && (g_char_count == 0 || g_protagonist >= g_char_count))
        g_protagonist = g_char_count;
    g_char_count++;
}

void engine_move_char(const char* char_id, s16 x, s16 y) {
    Char* c = _find_char(char_id);
    if (!c) return;
    c->x = x; c->y = y;
    c->walking = 0; c->path_len = 0;
}

/* Elimina un personaje de la room actual liberando su memoria.
 * Si es el protagonista, g_protagonist se reajusta al slot 0. */
void engine_remove_char(const char* char_id) {
    int i, found = -1;
    for (i = 0; i < g_char_count; i++) {
        if (_str_eq(g_chars[i].id, char_id)) { found = i; break; }
    }
    if (found < 0) return;
    if (g_chars[found].pcx_buf) { free(g_chars[found].pcx_buf); g_chars[found].pcx_buf = NULL; }
    if (g_chars[found].dec_buf) { free(g_chars[found].dec_buf); g_chars[found].dec_buf = NULL; }
    _spr_cache_free(g_chars[found].spr_cache); g_chars[found].spr_cache = NULL;
    /* Compactar array */
    for (i = found; i < g_char_count - 1; i++) g_chars[i] = g_chars[i + 1];
    g_char_count--;
    if (g_protagonist >= g_char_count && g_char_count > 0) g_protagonist = 0;
}

/* Selecciona el rol de animacion segun la direccion dominante del movimiento.
 * Si el personaje no tiene el PCX para ese rol (walk_left con flip=1 usa walk_right
 * pero con flip activo), el renderizador lo voltea en memoria. */
static void _char_select_walk_anim(Char* c, s16 tx, s16 ty) {
    s16 dx = tx - c->x, dy = ty - c->y;
    s16 adx = dx < 0 ? -dx : dx;
    s16 ady = dy < 0 ? -dy : dy;
    int role;
    if (adx == 0 && ady == 0) return; /* vector cero: personaje ya en destino, no cambiar anim */
    if (adx > (s16)(ady * 2)) {
        role = (tx > c->x) ? ANIM_WALK_RIGHT : ANIM_WALK_LEFT;
        _strlcpy(c->dir, (tx > c->x) ? "right" : "left", 8); c->dir_left = (tx <= c->x) ? 1 : 0;
    } else {
        role = (ty > c->y) ? ANIM_WALK_DOWN : ANIM_WALK_UP;
        /* NO tocar c->dir lateral para que el espejo idle sea correcto */
    }
    if (c->cur_anim == role) return;
    CHAR_SET_ANIM(c, role);
    c->frame_cur = 0;
    c->frame_timer = 0;
    {
        const AnimDef* ad = &c->anims[role];
        const char* pcx_id = ad->id;
        if (pcx_id[0] && strcmp(pcx_id, c->pcx_loaded) != 0) {
            if (c->pcx_buf) { free(c->pcx_buf); c->pcx_buf = NULL; }
            if (c->dec_buf) { free(c->dec_buf); c->dec_buf = NULL; c->dec_w = 0; c->dec_h = 0; } _spr_cache_free(c->spr_cache); c->spr_cache = NULL;
            { u32 sz;
              c->pcx_buf = (u8*)engine_dat_load_gfx(pcx_id, &sz);
              c->pcx_size = sz;
              _strlcpy(c->pcx_loaded, pcx_id, 32);
              if (c->pcx_buf) {
                  u16 _dw=0,_dh=0;
                  _pcx_decode(c->pcx_buf,sz,g_pcx_decode_buf,&_dw,&_dh,0);
                  if (_dw>0&&_dh>0) {
                      c->dec_w=_dw; c->dec_h=_dh;
                      if ((u32)_dw*_dh<=(u32)AG_SCREEN_PIXELS) {
                          c->dec_buf=(u8*)malloc((u32)_dw*_dh);
                          if(c->dec_buf){memcpy(c->dec_buf,g_pcx_decode_buf,(u32)_dw*_dh);}
                      }
                  }
              }
            }
        }
    }
}

void engine_walk_char(const char* char_id, s16 x, s16 y, u8 speed) {
    Char* c = _find_char(char_id);
    if (!c) return;
    c->target_x = x; c->target_y = y;
    c->path_len = engine_astar(c->x, c->y, x, y, c->path, 64);
    c->path_cur = 0;

    /* Destino no alcanzable: buscar la celda caminable mas cercana al destino */
    if (c->path_len == 0) {
        int gtx = x / WALKMAP_CELL_SIZE, gty = y / WALKMAP_CELL_SIZE;
        if (gtx < 0) gtx = 0; if (gtx >= g_wm_w) gtx = g_wm_w-1;
        if (gty < 0) gty = 0; if (gty >= g_wm_h) gty = g_wm_h-1;
        /* BFS radio creciente hasta encontrar una celda walkable */
        { int radius, found = 0, bx2 = x, by2 = y;
          for (radius = 1; radius <= g_wm_w && !found; radius++) {
              int dr;
              for (dr = -radius; dr <= radius && !found; dr++) {
                  int dc;
                  for (dc = -radius; dc <= radius && !found; dc++) {
                      int nr, nc;
                      if (dr != -radius && dr != radius && dc != -radius && dc != radius) continue;
                      nr = gty + dr; nc = gtx + dc;
                      if (nr < 0 || nr >= g_wm_h || nc < 0 || nc >= g_wm_w) continue;
                      if (!_walk_passable(nc, nr)) continue;
                      { s16 cx2 = (s16)(nc * WALKMAP_CELL_SIZE + WALKMAP_CELL_SIZE / 2);
                        s16 cy2 = (s16)(nr * WALKMAP_CELL_SIZE + WALKMAP_CELL_SIZE / 2);
                        Point _tp[64];
                        if (engine_astar(c->x, c->y, cx2, cy2, _tp, 64) > 0) {
                            bx2 = cx2; by2 = cy2; found = 1;
                        }
                      }
                  }
              }
          }
          if (found) {
              c->target_x = (s16)bx2; c->target_y = (s16)by2;
              c->path_len = engine_astar(c->x, c->y, (s16)bx2, (s16)by2, c->path, 64);
          }
        }
    }

    c->walking  = (c->path_len > 0);
    if (speed > 0) c->speed = speed;
    else c->speed = c->base_speed ? c->base_speed : 2;
    c->move_timer = g_ticks_ms;
    if (c->walking) {
        _char_select_walk_anim(c, c->target_x, c->target_y);
    } else {
        /* Destino no alcanzable en absoluto: volver a idle */
        if (c->cur_anim != ANIM_IDLE) {
            c->cur_anim    = ANIM_IDLE;
            c->frame_cur   = 0;
            c->frame_timer = g_ticks_ms;
            if (c->anims[ANIM_IDLE].id[0] &&
                strcmp(c->anims[ANIM_IDLE].id, c->pcx_loaded) != 0) {
                u32 sz;
                if (c->pcx_buf) { free(c->pcx_buf); c->pcx_buf = NULL; }
                c->pcx_buf = (u8*)engine_dat_load_gfx(c->anims[ANIM_IDLE].id, &sz);
                c->pcx_size = sz;
                _strlcpy(c->pcx_loaded, c->anims[ANIM_IDLE].id, 32);
            }
        }
    }
}

/* Movimiento lineal directo sin pathfinding — ignora walkmap.
 * Para animaciones de salida de sala o posiciones fuera del area jugable. */
void engine_walk_char_direct(const char* char_id, s16 x, s16 y, u8 speed) {
    Char* c = _find_char(char_id);
    if (!c) return;
    c->target_x = x; c->target_y = y;
    /* Path de un solo punto: el destino */
    c->path[0].x = x; c->path[0].y = y;
    c->path_len = 1;
    c->path_cur = 0;
    c->walking  = 1;
    if (speed > 0) c->speed = speed;
    else c->speed = c->base_speed ? c->base_speed : 2;
    c->move_timer = g_ticks_ms;
    _char_select_walk_anim(c, x, y);
}

void engine_walk_char_to_obj(const char* char_id, const char* obj_id, u8 speed) {
    Obj* o = _find_obj(obj_id);
    if (!o) return;
    engine_walk_char(char_id, o->x, o->y, speed);
}

void engine_wait_walk(const char* char_id) {
    Char* c = _find_char(char_id);
    if (!c) return;
    /* Espera bloqueante: deja que engine_process_input mueva al personaje
     * con su sistema de tiempo real. Asi la animacion se ve correctamente. */
    while (c->walking && g_running) {
        if (!engine_process_input()) break;
        engine_flip();
    }
}

/* Configura espejo H/V para una animacion de un personaje.
 * Llamar tras engine_add_char() para cada anim que necesite flip. */
void engine_set_anim(const char* char_id, const char* anim_name) {
    Char* c = _find_char(char_id);
    int _role;
    if (!c) return;
    if      (_str_eq(anim_name, "idle"))       { CHAR_SET_ANIM(c, ANIM_IDLE); c->dir_left = 0; _strlcpy(c->dir, "right", 8); }
    else if (_str_eq(anim_name, "walk_right")) CHAR_SET_ANIM(c, ANIM_WALK_RIGHT);
    else if (_str_eq(anim_name, "walk_left"))  { CHAR_SET_ANIM(c, ANIM_WALK_LEFT); c->dir_left = 1; _strlcpy(c->dir, "left", 8); }
    else if (_str_eq(anim_name, "walk_up"))    CHAR_SET_ANIM(c, ANIM_WALK_UP);
    else if (_str_eq(anim_name, "walk_down"))  CHAR_SET_ANIM(c, ANIM_WALK_DOWN);
    else if (_str_eq(anim_name, "idle_up"))    { CHAR_SET_ANIM(c, c->anims[ANIM_IDLE_UP].id[0]   ? ANIM_IDLE_UP   : ANIM_IDLE); c->dir_left = 0; }
    else if (_str_eq(anim_name, "idle_down"))  { CHAR_SET_ANIM(c, c->anims[ANIM_IDLE_DOWN].id[0] ? ANIM_IDLE_DOWN : ANIM_IDLE); c->dir_left = 0; }
    else if (_str_eq(anim_name, "talk"))       { CHAR_SET_ANIM(c, c->anims[ANIM_TALK].id[0]      ? ANIM_TALK      : ANIM_IDLE); }
    else if (_str_eq(anim_name, "talk_left"))  { CHAR_SET_ANIM(c, c->anims[ANIM_TALK_LEFT].id[0] ? ANIM_TALK_LEFT : (c->anims[ANIM_TALK].id[0] ? ANIM_TALK : ANIM_IDLE)); c->dir_left = 1; _strlcpy(c->dir, "left", 8); }
    else if (_str_eq(anim_name, "talk_up"))    { CHAR_SET_ANIM(c, c->anims[ANIM_TALK_UP].id[0]   ? ANIM_TALK_UP   : (c->anims[ANIM_TALK].id[0] ? ANIM_TALK : ANIM_IDLE)); }
    else if (_str_eq(anim_name, "talk_down"))  { CHAR_SET_ANIM(c, c->anims[ANIM_TALK_DOWN].id[0] ? ANIM_TALK_DOWN : (c->anims[ANIM_TALK].id[0] ? ANIM_TALK : ANIM_IDLE)); }
    else if (_str_eq(anim_name, "give"))       { CHAR_SET_ANIM(c, c->anims[ANIM_GIVE].id[0]      ? ANIM_GIVE      : (c->anims[ANIM_TALK].id[0] ? ANIM_TALK : ANIM_IDLE)); }
    else {
        int _found = 0;
        for (_role = 0; _role < ANIM_CUSTOM; _role++) { /* no buscar en ANIM_CUSTOM */
            if (_str_eq(c->anims[_role].id, anim_name)) {
                CHAR_SET_ANIM(c, _role);
                _found = 1;
                break;
            }
        }
        if (!_found) {
            /* Ultimo recurso: cargar anim_name como PCX directo (ANIM_CUSTOM).
             * Util para animaciones de dialogo no mapeadas a rol. fw=0=ancho completo. */
            engine_set_anim_pcx(char_id, anim_name, 1, 8, 0);
            return; /* engine_set_anim_pcx ya resetea frame_cur */
        }
    }
    c->frame_cur = 0; c->frame_timer = 0;
    /* Recargar PCX si el slot activo tiene un sprite distinto al actual.
     * Imprescindible: el render usa c->pcx_buf directamente sin auto-reload. */
    { const char* _pid = c->anims[c->cur_anim].id;
      if (_pid[0] && !_str_eq(_pid, c->pcx_loaded)) {
          u32 _sz;
          if (c->pcx_buf) { free(c->pcx_buf); c->pcx_buf = NULL; }
          if (c->dec_buf) { free(c->dec_buf); c->dec_buf = NULL; c->dec_w = 0; c->dec_h = 0; }
          _spr_cache_free(c->spr_cache); c->spr_cache = NULL;
          c->pcx_buf = (u8*)engine_dat_load_gfx(_pid, &_sz);
          c->pcx_size = _sz;
          _strlcpy(c->pcx_loaded, _pid, 32);
          /* Pre-decodificar para que dec_w sea valido antes del primer render.
           * Sin esto, fw=0 cae al fallback pcx_size>128?32:16 → overflow. */
          if (c->pcx_buf) {
              u16 _dw = 0, _dh = 0;
              _pcx_decode(c->pcx_buf, _sz, g_pcx_decode_buf, &_dw, &_dh, 0);
              if (_dw > 0 && _dh > 0) {
                  c->dec_w = _dw; c->dec_h = _dh;
                  if ((u32)_dw * _dh <= (u32)AG_SCREEN_PIXELS) {
                      c->dec_buf = (u8*)malloc((u32)_dw * _dh);
                      if (c->dec_buf) memcpy(c->dec_buf, g_pcx_decode_buf, (u32)_dw * _dh);
                  }
              }
          }
      }
    }
}

/* Carga un PCX arbitrario en el slot ANIM_CUSTOM y lo activa.
 * Permite reproducir animaciones que no estan mapeadas a ningun rol. */
void engine_set_anim_pcx(const char* char_id, const char* pcx_id, int frames, int fps, int fw) {
    Char* c = _find_char(char_id);
    u8* new_buf = NULL;
    u32 new_sz  = 0;
    if (!c || !pcx_id || !pcx_id[0]) return;
    /* Rellenar slot ANIM_CUSTOM */
    _strlcpy(c->anims[ANIM_CUSTOM].id, pcx_id, 32);
    c->anims[ANIM_CUSTOM].frames = (u8)(frames > 0 ? frames : 1);
    c->anims[ANIM_CUSTOM].fps    = (u8)(fps > 0 ? fps : 8);
    c->anims[ANIM_CUSTOM].fw     = (u16)fw;
    c->anims[ANIM_CUSTOM].flip   = 0;
    /* Cargar PCX si no esta ya en el buffer */
    if (!_str_eq(pcx_id, c->pcx_loaded)) {
        new_buf = (u8*)engine_dat_load_gfx(pcx_id, &new_sz);
        if (new_buf) {
            if (c->pcx_buf) free(c->pcx_buf);
            if (c->dec_buf) { free(c->dec_buf); c->dec_buf = NULL; c->dec_w = 0; c->dec_h = 0; }
            _spr_cache_free(c->spr_cache); c->spr_cache = NULL;
            c->pcx_buf  = new_buf;
            c->pcx_size = new_sz;
            _strlcpy(c->pcx_loaded, pcx_id, 32);
            /* Pre-decodificar para que dec_w este disponible antes del primer render.
             * Imprescindible cuando fw=0: el render lo calcula como dec_w/frames. */
            { u16 _dw = 0, _dh = 0;
              _pcx_decode(new_buf, new_sz, g_pcx_decode_buf, &_dw, &_dh, 0);
              if (_dw > 0 && _dh > 0) {
                  c->dec_w = _dw; c->dec_h = _dh;
                  if ((u32)_dw * _dh <= (u32)AG_SCREEN_PIXELS) {
                      c->dec_buf = (u8*)malloc((u32)_dw * _dh);
                      if (c->dec_buf) memcpy(c->dec_buf, g_pcx_decode_buf, (u32)_dw * _dh);
                  }
              }
            }
        }
    }
    CHAR_SET_ANIM(c, ANIM_CUSTOM);
    c->frame_cur   = 0;
    c->frame_timer = 0;
}

void engine_play_anim(const char* char_id, const char* anim_name) {
    engine_set_anim(char_id, anim_name); /* simplificado: sin volver a la anterior */
}

void engine_face_dir(const char* char_id, const char* direction) {
    Char* c = _find_char(char_id);
    const char* pcx_id;
    u32 sz;
    if (!c) return;
    if (_str_eq(direction, "left")) {
        _strlcpy(c->dir, "left", 8); c->dir_left = 1;
        CHAR_SET_ANIM(c, ANIM_IDLE);
    } else if (_str_eq(direction, "right")) {
        _strlcpy(c->dir, "right", 8); c->dir_left = 0;
        CHAR_SET_ANIM(c, ANIM_IDLE);
    } else if (_str_eq(direction, "up") || _str_eq(direction, "back")) {
        _strlcpy(c->dir, "right", 8); c->dir_left = 0;
        CHAR_SET_ANIM(c, ANIM_IDLE_UP);
    } else if (_str_eq(direction, "down") || _str_eq(direction, "front")) {
        _strlcpy(c->dir, "right", 8); c->dir_left = 0;
        CHAR_SET_ANIM(c, ANIM_IDLE_DOWN);
    }
    /* Si el PCX del nuevo anim no esta cargado, cargarlo */
    pcx_id = c->anims[c->cur_anim].id;
    if (!pcx_id[0]) { CHAR_SET_ANIM(c, ANIM_IDLE); pcx_id = c->anims[ANIM_IDLE].id; }
    if (pcx_id[0] && !_str_eq(pcx_id, c->pcx_loaded)) {
        u8* new_buf = NULL;
        u32 new_sz  = 0;
        new_buf = (u8*)engine_dat_load_gfx(pcx_id, &new_sz);
        if (new_buf) {
            if (c->pcx_buf) free(c->pcx_buf);
            if (c->dec_buf) { free(c->dec_buf); c->dec_buf = NULL; c->dec_w = 0; c->dec_h = 0; } _spr_cache_free(c->spr_cache); c->spr_cache = NULL;
            c->pcx_buf  = new_buf;
            c->pcx_size = new_sz;
            _strlcpy(c->pcx_loaded, pcx_id, 32);
        } else {
            DBG("WARN: engine_face_dir: PCX no encontrado: %s, usando idle\n", pcx_id);
            CHAR_SET_ANIM(c, ANIM_IDLE);
        }
    }
    c->frame_cur = 0; c->frame_timer = 0;
}

void engine_set_char_subtitle_color(const char* char_id, u8 color) {
    Char* c = _find_char(char_id);
    if (c) c->subtitle_color = color;
}

void engine_set_char_visible(const char* char_id, int visible) {
    Char* c = _find_char(char_id);
    if (c) c->visible = (u8)visible;
}

/* Devuelve 1 si el personaje esta actualmente en g_chars (en la room actual). */
int engine_char_in_room(const char* char_id) {
    return _find_char(char_id) != NULL;
}

void engine_change_protagonist(const char* char_id) {
    int i;
    for (i = 0; i < g_char_count; i++) {
        if (_str_eq(g_chars[i].id, char_id)) {
            g_protagonist = i;
            g_inv_scroll  = 0;  /* reset vista de inventario al cambiar de personaje */
            g_inv_hover   = -1;
            return;
        }
    }
}

/* ===========================================================================
 * S11b - PARTY SYSTEM (protagonistas simultaneos)
 * =========================================================================== */

/* Configura los colores del popup selector de protagonistas.
 * bg=fondo panel, border=borde, active=celda activa, hover=celda hover.
 * Los valores son indices de paleta VGA (0-255). */
void engine_set_party_btn_sprite(const char* pcx_id, const char* pcx_hover_id) {
    u32 sz;
    if (g_party_btn.buf)     { free(g_party_btn.buf);     g_party_btn.buf    = NULL; g_party_btn.size    = 0; }
    if (g_party_btn_hov.buf) { free(g_party_btn_hov.buf); g_party_btn_hov.buf= NULL; g_party_btn_hov.size= 0; }
    if (pcx_id && pcx_id[0]) {
        g_party_btn.buf  = (u8*)engine_dat_load_gfx(pcx_id, &sz); g_party_btn.size  = sz; }
    if (pcx_hover_id && pcx_hover_id[0]) {
        g_party_btn_hov.buf = (u8*)engine_dat_load_gfx(pcx_hover_id, &sz); g_party_btn_hov.size = sz; }
}

void engine_set_ui_colors(u8 bg, u8 action, u8 sel, u8 inv_hov) {
    g_ui_col_bg      = bg;
    g_ui_col_action  = action;
    g_ui_col_sel     = sel;
    g_ui_col_inv_hov = inv_hov;
}

void engine_set_menu_colors(u8 bg, u8 btn, u8 sel, u8 brd, u8 txt, u8 act) {
    g_menu_col_bg  = bg;
    g_menu_col_btn = btn;
    g_menu_col_sel = sel;
    g_menu_col_brd = brd;
    g_menu_col_txt = txt;
    g_menu_col_act = act;
}

void engine_set_party_popup_colors(u8 bg, u8 border, u8 active, u8 hover) {
    g_popup_col_bg     = bg;
    g_popup_col_border = border;
    g_popup_col_active = active;
    g_popup_col_hover  = hover;
}

void engine_set_dialogue_colors(u8 bg, u8 brd, u8 txt, u8 sel) {
    g_dlg_col_bg  = bg;
    g_dlg_col_brd = brd;
    g_dlg_col_txt = txt;
    g_dlg_col_sel = sel;
}

/* Añade un personaje al grupo de protagonistas.
 * place_fn: funcion generada en main.c que llama a engine_place_char con todos
 * los parametros de animacion del personaje. Se usa para reinyectarlo si la
 * room no lo coloca en su load_fn. */
void engine_party_add(const char* char_id, void (*place_fn)(s16, s16)) {
    Char* c;
    int idx;
    if (g_party_count >= MAX_PARTY) return;
    if (_party_find(char_id) >= 0) return; /* ya en el grupo */
    idx = g_party_count++;
    memset(&g_party[idx], 0, sizeof(PartySlot));
    _strlcpy(g_party[idx].id, char_id, 32);
    _strlcpy(g_party[idx].room_id, g_cur_room, 32);
    g_party[idx].place_fn = place_fn;
    c = _find_char(char_id);
    if (c) { g_party[idx].x = c->x; g_party[idx].y = c->y; }
}

/* Elimina un personaje del grupo de protagonistas. */
void engine_party_remove(const char* char_id) {
    int i = _party_find(char_id);
    if (i < 0) return;
    if (g_party[i].face_pcx_buf) { free(g_party[i].face_pcx_buf); g_party[i].face_pcx_buf = NULL; }
    /* Desplazar slots para mantener array compacto */
    for (; i < g_party_count - 1; i++) g_party[i] = g_party[i+1];
    g_party_count--;
    if (g_party_count <= 1) g_party_popup_open = 0;
}

/* Asigna el PCX de cara a un miembro del grupo (carga en RAM). */
void engine_set_char_face_sprite(const char* char_id, const char* face_pcx_id) {
    int idx = _party_find(char_id);
    u32 sz = 0;
    void* buf;
    if (idx < 0) return;
    if (g_party[idx].face_pcx_buf) {
        free(g_party[idx].face_pcx_buf);
        g_party[idx].face_pcx_buf = NULL;
        g_party[idx].face_pcx_size = 0;
    }
    _strlcpy(g_party[idx].face_pcx_id, face_pcx_id ? face_pcx_id : "", 32);
    if (face_pcx_id && face_pcx_id[0]) {
        buf = engine_dat_load_gfx(face_pcx_id, &sz);
        if (buf) { g_party[idx].face_pcx_buf = (u8*)buf; g_party[idx].face_pcx_size = sz; }
    }
}

/* Cambia el protagonista activo.
 * Si el personaje esta en la room actual: cambio instantaneo.
 * Si esta en otra room: cambia de room y activa ese personaje. */
void engine_switch_protagonist(const char* char_id) {
    int i, pidx;
    if (g_char_count == 0) return;
    /* 1. Buscar en la room actual */
    for (i = 0; i < g_char_count; i++) {
        if (_str_eq(g_chars[i].id, char_id)) {
            _party_save_all();
            g_protagonist = i;
            g_inv_scroll  = 0;
            g_inv_hover   = -1;
            g_party_popup_open = 0;
            return;
        }
    }
    /* 2. El personaje esta en otra room — ir a su room */
    pidx = _party_find(char_id);
    if (pidx < 0 || !g_party[pidx].room_id[0]) return;
    g_suppress_prot_reinject = 1;
    _strlcpy(g_party_switch_pending, char_id, 32);
    engine_change_room(g_party[pidx].room_id, "");
    /* g_party_popup_open ya fue limpiado por engine_change_room */
}

/* ===========================================================================
 * S12 - OBJETOS
 * =========================================================================== */

void engine_place_object(const char* inst_id, const char* obj_id, const char* gfx_id_param, s16 x, s16 y) {
    engine_place_object_ex(inst_id, obj_id, gfx_id_param, x, y, 0, "");
}

void engine_place_object_ex(const char* inst_id, const char* obj_id,
                             const char* gfx_id_param, s16 x, s16 y,
                             u8 pickable, const char* inv_gfx_id) {
    Obj* o;
    char gfx_id[36];
    u32 sz;
    int _ii;
    if (g_obj_count >= MAX_OBJECTS) return;
    o = &g_objects[g_obj_count];
    memset(o, 0, sizeof(Obj));
    _strlcpy(o->id,     inst_id, 32);
    _strlcpy(o->obj_id, obj_id,  32);
    o->x = x; o->y = y;
    o->pickable    = pickable;
    o->detectable  = 1;
    o->anim_frames  = 1;
    o->anim_fps     = 0;
    o->anim_fw      = 0;
    o->anim_loop    = 1;
    o->frame_cur    = 0;
    o->frame_timer  = 0;
    o->ms_per_frame = 125;
    /* Si el objeto ya está en el inventario, colocarlo invisible */
    o->visible = 1;
    for (_ii = 0; _ii < g_inv_count; _ii++) {
        if (_str_eq(g_inventory[_ii].obj_id, obj_id)) {
            o->visible = 0;
            break;
        }
    }
    /* GFX principal (escena) */
    snprintf(gfx_id, sizeof(gfx_id), "%.35s", gfx_id_param[0] ? gfx_id_param : obj_id);
    o->pcx_buf  = (u8*)engine_dat_load_gfx(gfx_id, &sz);
    o->pcx_size = sz;
    o->dec_buf  = NULL; o->dec_w = 0; o->dec_h = 0; o->spr_cache = NULL; /* cache invalido */
    /* GFX inventario */
    if (pickable && inv_gfx_id && inv_gfx_id[0]) {
        _strlcpy(o->inv_gfx_id, inv_gfx_id, 36);
        o->inv_pcx_buf  = (u8*)engine_dat_load_gfx(inv_gfx_id, &sz);
        o->inv_pcx_size = sz;
    }
    g_obj_count++;
}

void engine_move_object(const char* obj_id, s16 x, s16 y) {
    Obj* o = _find_obj(obj_id); if (o) { o->x = x; o->y = y; }
}
void engine_set_object_state(const char* obj_id, const char* state_id) {
    Obj* o = _find_obj(obj_id);
    u32 sz;
    int i;
    if (!o) return;
    _strlcpy(o->state, state_id, 32);
    /* Persistir el estado para restaurarlo al volver a la room */
    _obj_state_persist_set(o->obj_id[0] ? o->obj_id : obj_id, state_id);
    for (i = 0; i < o->state_count; i++) {
        if (_str_eq(o->state_key[i], state_id)) {
            if (o->pcx_buf) { engine_free(o->pcx_buf); o->pcx_buf = NULL; }
            if (o->dec_buf) { free(o->dec_buf); o->dec_buf = NULL; o->dec_w = 0; o->dec_h = 0; } _spr_cache_free(o->spr_cache); o->spr_cache = NULL;
            o->pcx_buf     = (u8*)engine_dat_load_gfx(o->state_gfx[i], &sz);
            o->pcx_size    = sz;
            o->anim_frames  = o->state_frames[i];
            o->anim_fps     = o->state_fps[i];
            o->anim_fw      = o->state_fw[i];
            /* anim_loop no se resetea: conserva el valor que tenia el objeto */
            o->frame_cur    = 0;
            o->frame_timer  = 0;
            o->ms_per_frame = o->anim_fps > 0 ? (u32)(1000 / o->anim_fps) : 125;
            /* over_light=1: bakear shade en el nuevo dec_buf igual que en _room_predecode_all */
            if (o->pcx_buf && o->over_light &&
                g_room_light_count > 0 && g_ambient_light < 100 && g_shade_lut_valid) {
                u16 _w, _h;
                _pcx_decode(o->pcx_buf, o->pcx_size, g_pcx_decode_buf, &_w, &_h, 0);
                if ((u32)_w * _h <= AG_OBJ_PIX_MAX) {
                    o->dec_buf = (u8*)malloc((u32)_w * _h);
                    if (o->dec_buf) {
                        u32 _pi, _npx = (u32)_w * _h;
                        u8  _p, _bp = g_sprite_shade_passes;
                        memcpy(o->dec_buf, g_pcx_decode_buf, _npx);
                        o->dec_w = _w; o->dec_h = _h;
                        for (_pi = 0; _pi < _npx; _pi++) {
                            _p = o->dec_buf[_pi]; if (_p == 0) continue;
                            if (_bp >= 1) _p = g_shade_lut[_p];
                            if (_bp >= 2) _p = g_shade_lut[_p];
                            if (_bp >= 3) _p = g_shade_lut[_p];
                            o->dec_buf[_pi] = _p ? _p : 1;
                        }
                        o->spr_cache = _spr_cache_build(o->dec_buf, _w, _h);
                    }
                }
            }
            return;
        }
    }
}
void engine_set_object_visible(const char* obj_id, int visible) {
    Obj* o = _find_obj(obj_id); if (o) o->visible = (u8)visible;
}
/* loop=1: animacion en bucle (defecto). loop=0: one-shot, para en el ultimo frame. */
void engine_set_object_anim_loop(const char* obj_id, int loop) {
    Obj* o = _find_obj(obj_id); if (o) o->anim_loop = (u8)(loop ? 1 : 0);
}
/* Resetea la animacion al frame 0 (util para relanzar one-shots). */
void engine_reset_object_anim(const char* obj_id) {
    Obj* o = _find_obj(obj_id);
    if (o) { o->frame_cur = 0; o->frame_timer = g_ticks_ms; }
}

/* LCG minimo para intervalos ambient — sin stdlib, sin malloc. */
static u32 g_rng_state = 0x12345678u;
static u32 _rng_next(void) {
    g_rng_state = g_rng_state * 1664525u + 1013904223u; /* Numerical Recipes LCG */
    return g_rng_state;
}
/* Retorna valor en [min_ms, max_ms]. Si max<=min devuelve min. */
static u32 _ambient_rand_ms(u32 min_ms, u32 max_ms) {
    u32 range = (max_ms > min_ms) ? (max_ms - min_ms) : 0u;
    return min_ms + (range > 0u ? (_rng_next() % range) : 0u);
}

/* Configura la animacion ambiental periodica de un objeto.
 * ambient_state_key: nombre del estado a activar periodicamente.
 * min_ms / max_ms:   rango aleatorio del intervalo entre disparos.
 * El estado ambient debe tener anim_loop=0 (one-shot) en el editor.
 * Tras completar la animacion el objeto vuelve automaticamente al estado base. */
void engine_set_object_ambient(const char* obj_id, const char* ambient_state_key,
                                u32 min_ms, u32 max_ms) {
    Obj* o = _find_obj(obj_id);
    if (!o || !ambient_state_key || !ambient_state_key[0]) return;
    _strlcpy(o->ambient_state, ambient_state_key, 32);
    _strlcpy(o->ambient_base,  o->state,          32); /* estado actual = base */
    o->ambient_min_ms   = min_ms;
    o->ambient_max_ms   = max_ms > min_ms ? max_ms : min_ms + 1000u;
    o->ambient_playing  = 0;
    o->ambient_done     = 1; /* arrancar congelado en frame 0; se libera al primer disparo */
    o->frame_cur        = 0;
    /* Sembrar primer disparo con offset basado en puntero para desincronizar objetos */
    g_rng_state ^= (u32)(size_t)o;
    o->ambient_next_ms  = g_ticks_ms + _ambient_rand_ms(min_ms, o->ambient_max_ms);
}
/* Bloquea la secuencia hasta que la animacion one-shot del objeto llegue al ultimo frame.
 * Solo tiene sentido con anim_loop=0; si el objeto hace loop retorna inmediatamente. */
void engine_seq_wait_object_anim(const char* obj_id) {
    Obj* o = _find_obj(obj_id);
    u8 last;
    if (!o || o->anim_loop || o->anim_frames <= 1) return;
    /* Resetear al frame 0 para que siempre reproduzca la animacion completa */
    o->frame_cur   = 0;
    o->frame_timer = g_ticks_ms;
    last = (u8)(o->anim_frames - 1);
    while (g_running && o->frame_cur < last) {
        engine_flip();
        if (kbhit()) { int k = getch(); if (k == 27) break; }
    }
}
void engine_set_object_detectable(const char* obj_id, int detectable) {
    Obj* o = _find_obj(obj_id); if (o) o->detectable = (u8)detectable;
}
void engine_set_object_over_light(const char* obj_id, int over_light) {
    Obj* o = _find_obj(obj_id);
    if (!o) return;
    if (!o->over_light && over_light) g_over_light_count++;
    else if (o->over_light && !over_light && g_over_light_count > 0) g_over_light_count--;
    o->over_light = (u8)(over_light ? 1 : 0);
}
void engine_set_object_bg_layer(const char* obj_id, int bg_layer) {
    Obj* o = _find_obj(obj_id);
    if (!o) return;
    if (!o->bg_layer && bg_layer) g_bg_layer_count++;
    else if (o->bg_layer && !bg_layer && g_bg_layer_count > 0) g_bg_layer_count--;
    o->bg_layer = (u8)(bg_layer ? 1 : 0);
}

/* Añade un estado visual estático a un objeto. */
void engine_add_object_state(const char* obj_id, const char* state_id, const char* gfx_id) {
    Obj* o = _find_obj(obj_id);
    if (!o || o->state_count >= MAX_OBJ_STATES) return;
    _strlcpy(o->state_key[o->state_count], state_id, 32);
    _strlcpy(o->state_gfx[o->state_count], gfx_id,  36);
    o->state_frames[o->state_count] = 1;
    o->state_fps[o->state_count]    = 0;
    o->state_fw[o->state_count]     = 0;
    /* Si aun no hay estado activo explicito, este primer estado es el activo */
    if (o->state[0] == '\0') {
        _strlcpy(o->state, state_id, 32);
        o->anim_frames = 1;
        o->anim_fps    = 0;
        o->anim_fw     = 0;
        o->frame_cur   = 0;
        o->frame_timer = 0;
    }
    o->state_count++;
}

/* Añade un estado visual animado a un objeto.
 * frames: numero de frames en el spritesheet horizontal.
 * fps: velocidad de animacion (1-30).
 * fw: ancho de cada frame en px (0 = PCX_width / frames). */
void engine_add_object_state_anim(const char* obj_id, const char* state_id, const char* gfx_id,
                                   u8 frames, u8 fps, u16 fw) {
    Obj* o = _find_obj(obj_id);
    if (!o || o->state_count >= MAX_OBJ_STATES) return;
    _strlcpy(o->state_key[o->state_count], state_id, 32);
    _strlcpy(o->state_gfx[o->state_count], gfx_id,  36);
    o->state_frames[o->state_count] = frames > 1 ? frames : 1;
    o->state_fps[o->state_count]    = fps;
    o->state_fw[o->state_count]     = fw;
    /* Si aun no hay estado activo explicito, aplicar los parametros de animacion */
    if (o->state[0] == '\0') {
        _strlcpy(o->state, state_id, 32);
        o->anim_frames  = frames > 1 ? frames : 1;
        o->anim_fps     = fps;
        o->anim_fw      = fw;
        o->ms_per_frame = fps > 0 ? (u32)(1000 / fps) : 125;
        o->frame_cur    = 0;
        o->frame_timer  = 0;
    }
    o->state_count++;
}

void engine_give_object(const char* obj_id, const char* char_id) {
    Obj* o;
    InvSlot* slot;
    if (g_inv_count >= MAX_INVENTORY) return;
    { int _i;
      for (_i = 0; _i < g_inv_count; _i++)
          if (_str_eq(g_inventory[_i].obj_id, obj_id)) return;
    }
    slot = &g_inventory[g_inv_count];
    memset(slot, 0, sizeof(InvSlot));
    _strlcpy(slot->obj_id,     obj_id,  32);
    _strlcpy(slot->char_owner, char_id ? char_id : "", 32);
    DBG("give_object: obj_id='%s'\n", obj_id);
    /* Buscar objeto ANTES de ocultarlo para tener acceso al PCX */
    o = _find_obj(obj_id);
    DBG("give_object: find='%s' inv_gfx='%s' inv_pcx=%p pcx=%p\n",
        o ? o->id : "(null)",
        o ? o->inv_gfx_id : "(null)",
        (void*)(o ? o->inv_pcx_buf : NULL),
        (void*)(o ? o->pcx_buf : NULL));
    /* Ocultar TODAS las instancias del objeto en todas las rooms (objeto único) */
    { int _oi;
      for (_oi = 0; _oi < g_obj_count; _oi++)
          if (_str_eq(g_objects[_oi].obj_id, obj_id))
              g_objects[_oi].visible = 0;
    }
    if (o && o->inv_pcx_buf) {
        if (o->inv_pcx_buf && o->inv_pcx_size > 0) {
            slot->pcx_buf = (u8*)malloc(o->inv_pcx_size);
            if (slot->pcx_buf) { memcpy(slot->pcx_buf, o->inv_pcx_buf, o->inv_pcx_size); slot->pcx_size = o->inv_pcx_size; slot->owns_buf = 1; }
        }
        DBG("give_object: -> inv_pcx_buf OK\n");
    } else if (o && o->inv_gfx_id[0]) {
        u32 sz = 0;
        u8* buf = (u8*)engine_dat_load_gfx(o->inv_gfx_id, &sz);
        DBG("give_object: -> load inv_gfx='%s' buf=%p\n", o->inv_gfx_id, (void*)buf);
        if (buf) { o->inv_pcx_buf = buf; o->inv_pcx_size = sz;
            slot->pcx_buf = (u8*)malloc(sz); if (slot->pcx_buf) { memcpy(slot->pcx_buf, buf, sz); slot->pcx_size = sz; slot->owns_buf = 1; } }
    } else if (o && o->pcx_buf) {
        if (o->pcx_buf && o->pcx_size > 0) {
            slot->pcx_buf = (u8*)malloc(o->pcx_size);
            if (slot->pcx_buf) { memcpy(slot->pcx_buf, o->pcx_buf, o->pcx_size); slot->pcx_size = o->pcx_size; slot->owns_buf = 1; }
        }
        DBG("give_object: -> pcx_buf OK\n");
    } else {
        int _gi;
        DBG("give_object: -> global table (%d entries)\n", g_obj_gfx_count);
        for (_gi = 0; _gi < g_obj_gfx_count; _gi++) {
            DBG("give_object: table[%d] obj='%s' gfx='%s'\n",
                _gi, g_obj_gfx_table[_gi].obj_id, g_obj_gfx_table[_gi].inv_gfx_id);
            if (_str_eq(g_obj_gfx_table[_gi].obj_id, obj_id) &&
                g_obj_gfx_table[_gi].inv_gfx_id[0]) {
                u32 sz = 0;
                u8* buf = (u8*)engine_dat_load_gfx(g_obj_gfx_table[_gi].inv_gfx_id, &sz);
                DBG("give_object: -> global load gfx='%s' buf=%p\n",
                    g_obj_gfx_table[_gi].inv_gfx_id, (void*)buf);
                if (buf) { slot->pcx_buf = buf; slot->pcx_size = sz; }
                break;
            }
        }
    }
    DBG("give_object: slot pcx_buf=%p\n", (void*)slot->pcx_buf);
    g_inv_count++;
}
void engine_remove_object(const char* obj_id, const char* char_id) {
    int i; (void)char_id;
    for (i = 0; i < g_inv_count; i++) {
        if (_str_eq(g_inventory[i].obj_id, obj_id)) {
            if (g_inventory[i].owns_buf && g_inventory[i].pcx_buf)
                { free(g_inventory[i].pcx_buf); g_inventory[i].pcx_buf = NULL; }
            --g_inv_count;
            if (i < g_inv_count)
                memcpy(&g_inventory[i], &g_inventory[g_inv_count], sizeof(InvSlot));
            return;
        }
    }
}
void engine_drop_object(const char* obj_id, const char* room_id, s16 x, s16 y) {
    engine_remove_object(obj_id, "");
    if (_str_eq(room_id, g_cur_room)) engine_place_object(obj_id, obj_id, obj_id, x, y);
}

/* ===========================================================================
 * S13 - RENDERIZADO
 * =========================================================================== */

/* Construye un SprCache desde un buffer de indices raw (dec_buf).
 * Itera una vez el decode para contar runs, luego otra para rellenarlas. */
static SprCache* _spr_cache_build(const u8* dec, u16 w, u16 h) {
    SprCache* sc;
    u32 nruns = 0, npix = 0;
    u32 r, p, ri, pi;
    u16 row, x;

    /* Pasada 1: contar runs y pixels opacos */
    for (row = 0; row < h; row++) {
        const u8* src = dec + (u32)row * w;
        u8 in_run = 0;
        for (x = 0; x < w; x++) {
            if (src[x]) { if (!in_run) { nruns++; in_run = 1; } npix++; }
            else          { in_run = 0; }
        }
    }

    sc = (SprCache*)malloc(sizeof(SprCache));
    if (!sc) return NULL;
    sc->w = w; sc->h = h;
    sc->row_nruns   = (u16*)   malloc((u32)h * sizeof(u16));
    sc->row_run_off = (u32*)   malloc((u32)h * sizeof(u32));
    sc->row_pix_off = (u32*)   malloc((u32)h * sizeof(u32));
    sc->runs        = nruns ? (SprRun*)malloc(nruns * sizeof(SprRun)) : NULL;
    sc->pixels      = npix  ? (u8*)   malloc(npix)                   : NULL;

    if (!sc->row_nruns || !sc->row_run_off || !sc->row_pix_off ||
        (nruns && !sc->runs) || (npix && !sc->pixels)) {
        if (sc->row_nruns)   free(sc->row_nruns);
        if (sc->row_run_off) free(sc->row_run_off);
        if (sc->row_pix_off) free(sc->row_pix_off);
        if (sc->runs)        free(sc->runs);
        if (sc->pixels)      free(sc->pixels);
        free(sc); return NULL;
    }

    /* Pasada 2: rellenar */
    r = 0; p = 0;
    for (row = 0; row < h; row++) {
        const u8* src = dec + (u32)row * w;
        u8 in_run = 0;
        u16 rn = 0;
        sc->row_run_off[row] = r;
        sc->row_pix_off[row] = p;
        for (x = 0; x < w; x++) {
            if (src[x]) {
                if (!in_run) { sc->runs[r].x = x; sc->runs[r].len = 0; r++; rn++; in_run = 1; }
                sc->runs[r-1].len++;
                sc->pixels[p++] = src[x];
            } else { in_run = 0; }
        }
        sc->row_nruns[row] = rn;
    }
    return sc;
}

static void _spr_cache_free(SprCache* sc) {
    if (!sc) return;
    if (sc->row_nruns)   free(sc->row_nruns);
    if (sc->row_run_off) free(sc->row_run_off);
    if (sc->row_pix_off) free(sc->row_pix_off);
    if (sc->runs)        free(sc->runs);
    if (sc->pixels)      free(sc->pixels);
    free(sc);
}

/* Renderiza un sprite desde su SprCache al backbuf.
 * base_x/base_y: posicion en pantalla (anclado por los pies como _draw_sprite_raw).
 * frame_x/fw: ventana de frame dentro del spritesheet. */
static void _spr_cache_render(const SprCache* sc, s16 base_x, s16 base_y,
                               u16 frame_x, u16 fw, s16 max_vy) {
    u16 row, r;
    s16 vy;
    u32 ri, pi, pix_off;
    s16 clip_l_frame, clip_l_scr, clip_r, final_len, vx0;
    u16 rx, rlen, rx_end;
    u16 frame_end = (u16)(frame_x + fw);

    for (row = 0; row < sc->h; row++) {
        vy = (s16)(base_y - (s16)sc->h + (s16)row);
        if (vy < 0 || vy >= max_vy) continue;
        ri = sc->row_run_off[row];
        pi = sc->row_pix_off[row];
        for (r = 0; r < sc->row_nruns[row]; r++, ri++) {
            rx     = sc->runs[ri].x;
            rlen   = sc->runs[ri].len;
            rx_end = (u16)(rx + rlen);
            /* Saltar runs fuera de la ventana de frame */
            if (rx_end <= frame_x || rx >= frame_end) { pi += rlen; continue; }
            /* Clip al frame — guardar en variable separada para no perderlo al clipear pantalla */
            clip_l_frame = (rx < frame_x)     ? (s16)(frame_x - rx)     : 0;
            clip_r       = (rx_end > frame_end) ? (s16)(rx_end - frame_end) : 0;
            rlen   = (u16)(rlen - clip_l_frame - clip_r);
            pix_off = pi + (u32)clip_l_frame;
            /* Posicion en pantalla */
            vx0 = (s16)(base_x - (s16)(fw >> 1) + (s16)(rx - frame_x) + clip_l_frame);
            /* Clip a pantalla */
            if (vx0 < 0) { clip_l_scr = (s16)(-vx0); rlen -= clip_l_scr; pix_off += clip_l_scr; vx0 = 0; }
            if ((s16)(vx0 + rlen) > AG_SCREEN_W) { clip_r = (s16)(vx0+rlen-AG_SCREEN_W); rlen -= clip_r; }
            final_len = (s16)rlen;
            if (final_len > 0)
                memcpy(g_backbuf + (u32)vy * AG_SCREEN_W + vx0,
                       sc->pixels + pix_off,
                       (u32)final_len);
            pi += sc->runs[ri].len; /* avanzar por la run original sin clipear */
        }
    }
}

#define _SHADE_PX(px) do { \
    if (g_sprite_shade_passes > 0) px = g_shade_lut[px]; \
    if (g_sprite_shade_passes > 1) px = g_shade_lut[px]; \
    if (g_sprite_shade_passes > 2) px = g_shade_lut[px]; \
} while(0)

/* Version con shade (para pass 1 over_light con iluminacion) */
static void _spr_cache_render_shaded(const SprCache* sc, s16 base_x, s16 base_y,
                                      u16 frame_x, u16 fw, s16 max_vy) {
    u16 row, r, k;
    s16 vy;
    u32 ri, pi, pix_off;
    s16 clip_l, clip_r, final_len, vx0;
    u16 rx, rlen, rx_end;
    u16 frame_end = (u16)(frame_x + fw);
    u8  px;

    for (row = 0; row < sc->h; row++) {
        vy = (s16)(base_y - (s16)sc->h + (s16)row);
        if (vy < 0 || vy >= max_vy) continue;
        ri = sc->row_run_off[row];
        pi = sc->row_pix_off[row];
        for (r = 0; r < sc->row_nruns[row]; r++, ri++) {
            rx     = sc->runs[ri].x;
            rlen   = sc->runs[ri].len;
            rx_end = (u16)(rx + rlen);
            if (rx_end <= frame_x || rx >= frame_end) { pi += rlen; continue; }
            clip_l = (rx < frame_x)     ? (s16)(frame_x - rx)     : 0;
            clip_r = (rx_end > frame_end) ? (s16)(rx_end - frame_end) : 0;
            rlen   = (u16)(rlen - clip_l - clip_r);
            vx0    = (s16)(base_x - (s16)(fw >> 1) + (s16)(rx - frame_x) + clip_l);
            pix_off = pi + (u32)clip_l;
            if (vx0 < 0) { u16 sl = (u16)(-vx0); if (sl >= rlen) { pi += sc->runs[ri].len; continue; } pix_off += sl; rlen -= sl; vx0 = 0; }
            if ((s16)(vx0 + rlen) > AG_SCREEN_W) { u16 sr = (u16)(vx0+rlen-AG_SCREEN_W); if (sr >= rlen) { pi += sc->runs[ri].len; continue; } rlen -= sr; }
            final_len = (s16)rlen;
            for (k = 0; k < (u16)final_len; k++) {
                px = sc->pixels[pix_off + k];
                _SHADE_PX(px);
                g_backbuf[(u32)vy * AG_SCREEN_W + vx0 + k] = px;
            }
            pi += sc->runs[ri].len;
        }
    }
}

/* Decodifica y cachea todos los PCX de personajes y objetos de la room actual.
 * Se llama una sola vez al cargar la room — el render nunca vuelve a decodificar RLE. */
static void _room_predecode_all(void) {
    int i;
    u16 w, h;

    for (i = 0; i < g_char_count; i++) {
        Char* c = &g_chars[i];
        if (!c->pcx_buf || c->dec_buf) continue;
        _pcx_decode(c->pcx_buf, c->pcx_size, g_pcx_decode_buf, &w, &h, 0);
        if ((u32)w * h <= (u32)AG_SCREEN_PIXELS) {
            c->dec_buf = (u8*)malloc((u32)w * h);
            if (c->dec_buf) {
                memcpy(c->dec_buf, g_pcx_decode_buf, (u32)w * h);
                c->dec_w = w; c->dec_h = h;
                c->spr_cache = _spr_cache_build(c->dec_buf, w, h);
            }
        }
        DBG("predecode char[%d]=%s: %dx%d\n", i, c->id, w, h);
    }

    { u8 bake_passes = (g_room_light_count > 0 && g_ambient_light < 100 && g_shade_lut_valid)
                       ? g_sprite_shade_passes : 0;
      for (i = 0; i < g_obj_count; i++) {
        Obj* o = &g_objects[i];
        if (!o->pcx_buf || o->dec_buf) continue;
        _pcx_decode(o->pcx_buf, o->pcx_size, g_pcx_decode_buf, &w, &h, 0);
        if ((u32)w * h <= AG_OBJ_PIX_MAX) {
            o->dec_buf = (u8*)malloc((u32)w * h);
            if (o->dec_buf) {
                memcpy(o->dec_buf, g_pcx_decode_buf, (u32)w * h);
                o->dec_w = w; o->dec_h = h;
                /* over_light=1: se dibuja DESPUES del lightmap, que no lo toca.
                 * Bakear shade ambiente ahora. Clampar a 1 para no crear huecos. */
                if (bake_passes > 0 && o->over_light) {
                    u32 _pi, _npx = (u32)w * h;
                    for (_pi = 0; _pi < _npx; _pi++) {
                        u8 _p = o->dec_buf[_pi];
                        if (_p == 0) continue;
                        if (bake_passes >= 1) _p = g_shade_lut[_p];
                        if (bake_passes >= 2) _p = g_shade_lut[_p];
                        if (bake_passes >= 3) _p = g_shade_lut[_p];
                        o->dec_buf[_pi] = _p ? _p : 1;
                    }
                }
                o->spr_cache = _spr_cache_build(o->dec_buf, w, h);
            }
        }
        DBG("predecode obj[%d]=%s: %dx%d bake=%d\n", i, o->id, w, h, (int)(bake_passes && o->over_light));
      }
    }

    /* Reconstruir tabla de escala por Y — invalida tras engine_add_scale_zone */
    { int _sy;
      for (_sy = 0; _sy < 200; _sy++)
          g_scale_lut[_sy] = _get_scale_pct((s16)_sy);
    }
}

void engine_load_bg(const char* gfx_id) {
    u32 sz;
    u8* pcx;
    u16 w, h;
    int r;
    if (!gfx_id || !gfx_id[0]) {
        memset(g_bgbuf, 0, AG_SCREEN_PIXELS); memset(g_backbuf, 0, AG_SCREEN_PIXELS);
        g_bg_full_w = AG_SCREEN_W; g_bg_full_h = UI_Y; g_cam_x = 0; g_room_scroll_w = 0; return;
    }
    pcx = (u8*)engine_dat_load_gfx(gfx_id, &sz);
    if (!pcx) {
        memset(g_bgbuf, 0, AG_SCREEN_PIXELS); memset(g_backbuf, 0, AG_SCREEN_PIXELS);
        g_bg_full_w = AG_SCREEN_W; g_bg_full_h = UI_Y; g_cam_x = 0; g_room_scroll_w = 0; return;
    }
    /* Decodificar fondo completo (hasta 1024px ancho) en g_bg_full */
    _pcx_decode(pcx, sz, g_bg_full, &w, &h, 1 /* aplicar paleta VGA */);
    free(pcx);
    /* La paleta acaba de cambiar — reconstruir shade_lut para iluminacion */
    if (!g_shade_lut_valid) _build_shade_lut();
    g_bg_full_w = (w  > 1024) ? 1024 : w;
    g_bg_full_h = (h  > UI_Y) ? UI_Y : h;
    g_cam_x     = 0;
    g_room_scroll_w = 0;
    g_grid_cell_w   = WALKMAP_CELL_SIZE;
    /* Blit viewport inicial al g_bgbuf */
    for (r = 0; r < g_bg_full_h; r++)
        memcpy(g_bgbuf + r * AG_SCREEN_W, g_bg_full + r * g_bg_full_w, AG_SCREEN_W);
    /* Zona UI: rellenar con indice 1 */
    for (r = UI_Y; r < AG_SCREEN_H; r++)
        memset(g_bgbuf + r * AG_SCREEN_W, 1, AG_SCREEN_W);
    memcpy(g_backbuf, g_bgbuf, AG_SCREEN_PIXELS);
}

/* Carga un PCX de 320x200 como fondo a pantalla completa.
 * Activa g_bg_fullscreen=1: sin UI, sin hover, sin exits, sin cursor de verbo. */
void engine_load_bg_fullscreen(const char* gfx_id) {
    u32 sz; u8* pcx; u16 w, h; int r;
    g_bg_fullscreen = 1;
    g_ui_hidden     = 1;
    if (!gfx_id || !gfx_id[0]) {
        memset(g_bgbuf, 0, AG_SCREEN_PIXELS); memset(g_backbuf, 0, AG_SCREEN_PIXELS);
        g_bg_full_w = AG_SCREEN_W; g_bg_full_h = AG_SCREEN_H; g_cam_x = 0; g_room_scroll_w = 0; return;
    }
    pcx = (u8*)engine_dat_load_gfx(gfx_id, &sz);
    if (!pcx) {
        memset(g_bgbuf, 0, AG_SCREEN_PIXELS); memset(g_backbuf, 0, AG_SCREEN_PIXELS);
        g_bg_full_w = AG_SCREEN_W; g_bg_full_h = AG_SCREEN_H; g_cam_x = 0; g_room_scroll_w = 0; return;
    }
    _pcx_decode(pcx, sz, g_bg_full, &w, &h, 1);
    free(pcx);
    if (!g_shade_lut_valid) _build_shade_lut();
    g_bg_full_w = (w > 1024) ? 1024 : w;
    g_bg_full_h = (h > AG_SCREEN_H) ? AG_SCREEN_H : h;
    g_cam_x = 0; g_room_scroll_w = 0; g_grid_cell_w = WALKMAP_CELL_SIZE;
    /* Blitear todos los 200px — sin zona UI */
    for (r = 0; r < (int)g_bg_full_h; r++)
        memcpy(g_bgbuf + r * AG_SCREEN_W, g_bg_full + r * g_bg_full_w, AG_SCREEN_W);
    /* Rellenar filas no cubiertas por el PCX (si h < 200) */
    for (r = (int)g_bg_full_h; r < AG_SCREEN_H; r++)
        memset(g_bgbuf + r * AG_SCREEN_W, 0, AG_SCREEN_W);
    memcpy(g_backbuf, g_bgbuf, AG_SCREEN_PIXELS);
}

/* Desactiva el modo fullscreen y vuelve al modo normal (UI visible). */
void engine_exit_fullscreen(void) {
    g_bg_fullscreen = 0;
    g_ui_hidden     = 0;
}

/* Mueve la camara al pixel px_x del fondo y actualiza g_bgbuf. */
void engine_set_cam_x(s16 px_x) {
    int r;
    s16 max_cam = (s16)(g_bg_full_w > AG_SCREEN_W ? g_bg_full_w - AG_SCREEN_W : 0);
    if (px_x < 0) px_x = 0;
    if (px_x > max_cam) px_x = max_cam;
    g_cam_x = px_x;
    for (r = 0; r < g_bg_full_h; r++)
        memcpy(g_bgbuf + r * AG_SCREEN_W,
               g_bg_full + r * g_bg_full_w + g_cam_x, AG_SCREEN_W);
    for (r = UI_Y; r < AG_SCREEN_H; r++)
        memset(g_bgbuf + r * AG_SCREEN_W, 1, AG_SCREEN_W);
}

/* Define el ancho logico de la room para el camera follow.
 * scroll_w = 0 desactiva el follow; > AG_SCREEN_W lo activa. */
void engine_set_room_scroll(u16 scroll_w) {
    g_room_scroll_w = scroll_w;
    g_grid_cell_w = WALKMAP_CELL_SIZE;
}

/* Activa el modo scroll-por-mitades para esta room.
 * half_w: ancho de cada mitad en px (normalmente 320 para un PCX de 640px). */
void engine_set_scroll_halves(u16 half_w) {
    g_scroll_halves    = 1;
    g_scroll_half_w    = half_w;
    g_room_scroll_w    = (u16)(half_w * 2);  /* ancho total = 2 mitades */
    g_grid_cell_w      = WALKMAP_CELL_SIZE;
    g_cam_pan_active    = 0;
    g_scroll_recovering = 0;
    /* Posicionar camara en la mitad donde esta el protagonista.
     * Si aun no hay personaje (carga aun en curso), arranca en izquierda. */
    if (g_char_count > 0) {
        g_cam_x = (g_chars[g_protagonist].x >= (s16)half_w) ? (s16)half_w : 0;
        engine_set_cam_x(g_cam_x);
    }
}

/* Actualiza camara: modelo SCUMM.
 * El personaje se mueve en coordenadas mundiales (0..room_w).
 * La camara sigue al personaje cuando su posicion en pantalla
 * (char.x - cam_x) sale de la zona segura [MARGIN, AG_SCREEN_W-MARGIN]. */
static void _camera_follow(void) {
    s16 char_screen_x, new_cam, max_cam;
    if (g_scroll_halves) return;  /* modo halves: la camara la gestiona _update_scroll_pan */
    if (g_room_scroll_w <= AG_SCREEN_W) return;
    if (g_char_count == 0) return;
    max_cam = (s16)(g_bg_full_w > AG_SCREEN_W ? g_bg_full_w - AG_SCREEN_W : 0);
    if (max_cam <= 0) return;

    char_screen_x = (s16)(g_chars[g_protagonist].x - g_cam_x);
    new_cam = g_cam_x;

    /* Si el personaje sale de los margenes, mover camara exactamente lo necesario */
#define CAM_MARGIN 80
    if (char_screen_x < CAM_MARGIN)
        new_cam = (s16)(g_chars[g_protagonist].x - CAM_MARGIN);
    else if (char_screen_x > AG_SCREEN_W - CAM_MARGIN)
        new_cam = (s16)(g_chars[g_protagonist].x - (AG_SCREEN_W - CAM_MARGIN));
#undef CAM_MARGIN

    if (new_cam < 0) new_cam = 0;
    if (new_cam > max_cam) new_cam = max_cam;
    if (new_cam != g_cam_x)
        engine_set_cam_x(new_cam);
}

/* Avanza el pan de camara por mitades.
 * Llama a engine_set_cam_x para mantener g_bgbuf sincronizado.
 * Devuelve 1 si el pan sigue activo, 0 si acabo este frame. */
static int _update_scroll_pan(void) {
    u32 elapsed;
    s32 delta, new_cam;
    if (!g_cam_pan_active) return 0;

    elapsed = g_ticks_ms - g_cam_pan_start_ms;
    if (elapsed >= SCROLL_HALVES_DURATION) {
        /* Pan completado: fijar camara en destino exacto */
        engine_set_cam_x(g_cam_pan_dst);
        g_cam_x        = g_cam_pan_dst;
        g_cam_pan_active = 0;

        /* Anti-bucle: caminar con animacion hasta la zona segura.
         * El personaje estaba parado en la zona de trigger (congelado durante el pan);
         * ahora lo movemos animado hasta boundary +/- TRIGGER*2 para que no
         * vuelva a disparar el pan inmediatamente. */
        if (g_char_count > 0) {
            Char* _pc = &g_chars[g_protagonist];
            s16 _safe = (s16)(SCROLL_HALVES_TRIGGER * 2);  /* 20px mas alla del trigger */
            s16 _dst_x, _dst_y;
            _dst_y = _pc->y;  /* misma y, solo desplazamiento horizontal */
            if (g_cam_pan_dir == 0) {
                /* Fue izq->der: caminar hacia la derecha hasta boundary + safe */
                _dst_x = (s16)(g_scroll_half_w + _safe);
            } else {
                /* Fue der->izq: caminar hacia la izquierda hasta boundary - safe */
                _dst_x = (s16)(g_scroll_half_w - _safe);
            }
            /* Solo iniciar si todavia esta en zona peligrosa */
            if (g_cam_pan_dir == 0 && _pc->x < (s16)(g_scroll_half_w + _safe)) {
                engine_walk_char_direct(_pc->id, _dst_x, _dst_y, 0);
                g_scroll_recovering = 1;
            } else if (g_cam_pan_dir == 1 && _pc->x > (s16)(g_scroll_half_w - _safe)) {
                engine_walk_char_direct(_pc->id, _dst_x, _dst_y, 0);
                g_scroll_recovering = 1;
            }
        }
        return 0;
    }

    /* Lerp lineal: cam = src + (dst-src)*elapsed/duration — todo entero */
    delta   = (s32)(g_cam_pan_dst - g_cam_pan_src);
    new_cam = (s32)g_cam_pan_src + delta * (s32)elapsed / (s32)SCROLL_HALVES_DURATION;
    engine_set_cam_x((s16)new_cam);
    return 1;
}

/* Detecta si el protagonista entra en la zona de trigger central y lanza el pan.
 * Solo actua si no hay pan en curso, si el modo halves esta activo
 * y si la camara ya esta posicionada en alguna de las dos mitades. */
static void _check_scroll_halves(void) {
    s16 px;
    s16 boundary;
    if (!g_scroll_halves || g_cam_pan_active || g_char_count == 0) return;
    /* Esperar a que el personaje termine el walk de recuperacion post-pan */
    if (g_scroll_recovering) {
        if (!g_chars[g_protagonist].walking) g_scroll_recovering = 0;
        return;
    }
    /* No lanzar si hay script corriendo */
    if (g_script_running) return;

    px       = g_chars[g_protagonist].x;
    boundary = (s16)g_scroll_half_w;

    if (g_cam_x == 0) {
        /* Mostrando mitad izquierda: trigger si el protagonista cruza hacia la derecha */
        if (px >= boundary - (s16)SCROLL_HALVES_TRIGGER) {
            g_cam_pan_active   = 1;
            g_cam_pan_src      = 0;
            g_cam_pan_dst      = (s16)g_scroll_half_w;
            g_cam_pan_start_ms = g_ticks_ms;
            g_cam_pan_dir      = 0;
            /* Parar caminata del protagonista en su posicion actual */
            g_chars[g_protagonist].path_len = 0;
            g_chars[g_protagonist].path_cur = 0;
        }
    } else if (g_cam_x == (s16)g_scroll_half_w) {
        /* Mostrando mitad derecha: trigger si el protagonista cruza hacia la izquierda */
        if (px <= boundary + (s16)SCROLL_HALVES_TRIGGER) {
            g_cam_pan_active   = 1;
            g_cam_pan_src      = (s16)g_scroll_half_w;
            g_cam_pan_dst      = 0;
            g_cam_pan_start_ms = g_ticks_ms;
            g_cam_pan_dir      = 1;
            g_chars[g_protagonist].path_len = 0;
            g_chars[g_protagonist].path_cur = 0;
        }
    }
}

static void _draw_sprite_raw(u8* pcx, u32 pcx_sz, s16 dx, s16 dy,
                              u16 frame_x, u16 frame_w) {
    u16 sw, sh;
    s16 x, y;
    if (!pcx) return;
    _pcx_decode(pcx, pcx_sz, g_pcx_decode_buf, &sw, &sh, 0 /* no paleta */);
    for (y = 0; y < (s16)sh; y++) {
        s16 vy = dy - (s16)sh + y; /* anclado por los pies */
        if (vy < 0 || vy >= AG_SCREEN_H) continue;
        for (x = 0; x < (s16)frame_w; x++) {
            s16 vx = dx - (s16)(frame_w/2) + x;
            if (vx < 0 || vx >= AG_SCREEN_W) continue;
            u8 px = g_pcx_decode_buf[y * sw + frame_x + x];
            if (px != 0) /* indice 0 = transparencia */
                g_backbuf[vy * AG_SCREEN_W + vx] = px;
        }
    }
}

void engine_draw_sprite(const char* gfx_id, s16 x, s16 y, u16 frame_x, u16 frame_w) {
    u32 sz;
    u8* pcx = (u8*)engine_dat_load_gfx(gfx_id, &sz);
    if (!pcx) return;
    _draw_sprite_raw(pcx, sz, x, y, frame_x, frame_w);
    free(pcx);
}

/* Voltea horizontalmente una fila de pixeles (in-place, para flip de walk_left). */
static void _hflip_row(u8* row, int w) {
    int a = 0, b = w - 1;
    while (a < b) { u8 t = row[a]; row[a++] = row[b]; row[b--] = t; }
}

static void _render_char_item(int i) {
    Char* c = &g_chars[i];
    const AnimDef* ad = &c->anims[c->cur_anim];
    /* Invalidar dec_buf si el PCX cargado no corresponde al slot activo */
    if (c->dec_buf && ad->id[0] && !_str_eq(ad->id, c->pcx_loaded)) {
        free(c->dec_buf); c->dec_buf = NULL; c->dec_w = 0; c->dec_h = 0;
    }

    s16 sx  = (s16)(c->x - g_cam_x);
    u8  pct = ((u16)c->y < 200u) ? g_scale_lut[(u8)c->y] : _get_scale_pct(c->y);
    u8* pixels;
    u16 sw, sh;

    /* 1. Obtener pixeles: cache o decodificar ahora */
    if (c->dec_buf) {
        pixels = c->dec_buf; sw = c->dec_w; sh = c->dec_h;
    } else {
        _pcx_decode(c->pcx_buf, c->pcx_size, g_pcx_decode_buf, &sw, &sh, 0);
        pixels = g_pcx_decode_buf;
        /* Guardar dimensiones siempre — hitbox no depende del cache de pixeles */
        c->dec_w = sw; c->dec_h = sh;
        if ((u32)sw * sh <= (u32)AG_SCREEN_PIXELS) {
            c->dec_buf = (u8*)malloc((u32)sw * sh);
            if (c->dec_buf) {
                memcpy(c->dec_buf, g_pcx_decode_buf, (u32)sw * sh);
                pixels = c->dec_buf;
            }
        }
    }

    /* 2. Calcular fw DESPUES de tener sw: evita que un fw stale desborde sw.
     *    Prioridad: campo explicito del slot → sw/frames → sw entero */
    u16 fw;
    { u8 _nf = ad->frames > 0 ? ad->frames : 1;
      if (c->frame_cur >= _nf) c->frame_cur = 0;
      if (ad->fw > 0) {
          fw = ad->fw;
      } else if (sw > 0 && _nf > 1) {
          fw = (u16)(sw / _nf);
          if (fw == 0) fw = sw;
      } else {
          fw = sw > 0 ? sw : 16;
      }
      /* Clamp absoluto: frame_x+fw nunca puede superar sw */
      if (sw > 0 && fw > sw) fw = sw;
    }
    u16 frame_x = (u16)(c->frame_cur * fw);
    if (sw > 0 && frame_x + fw > sw) fw = (u16)(sw - frame_x); /* clamp final */

    /* Limite vertical: en modo normal no pintar sobre la UI */
    { s16 max_vy = g_bg_fullscreen ? (s16)AG_SCREEN_H : (s16)UI_Y;

    if (pct >= 100 && !(c->dir_left && (c->cur_anim == ANIM_IDLE || (c->cur_anim == ANIM_TALK && !c->anims[ANIM_TALK_LEFT].id[0]) || c->cur_anim == ANIM_GIVE))) {
        /* Path directo sin escala: usar spr_cache si disponible */
        if (c->spr_cache) {
            _spr_cache_render(c->spr_cache, sx, c->y, frame_x, fw, max_vy);
        } else {
            s16 x, y;
            for (y = 0; y < (s16)sh; y++) {
                s16 vy = c->y - (s16)sh + y;
                if (vy < 0 || vy >= max_vy) continue;
                for (x = 0; x < (s16)fw; x++) {
                    s16 vx = sx - (s16)(fw/2) + x;
                    if (vx < 0 || vx >= AG_SCREEN_W) continue;
                    u8 px = pixels[y * sw + frame_x + x];
                    if (px) g_backbuf[vy * AG_SCREEN_W + vx] = px;
                }
            }
        }
    } else {
        /* Path escalado con punto fijo — sin division por pixel */
        u32 step_x = ((u32)fw << 16) / ((fw * pct / 100) > 0 ? (fw * pct / 100) : 1);
        u32 step_y = ((u32)sh << 16) / ((sh * pct / 100) > 0 ? (sh * pct / 100) : 1);
        u16 dw = (u16)((u32)fw * pct / 100); if (dw < 1) dw = 1;
        u16 dh = (u16)((u32)sh * pct / 100); if (dh < 1) dh = 1;
        s16 bx = (s16)(sx - (s16)(dw / 2));
        s16 by = (s16)(c->y - (s16)dh);
        u8  flip = (c->dir_left && (c->cur_anim == ANIM_IDLE || (c->cur_anim == ANIM_TALK && !c->anims[ANIM_TALK_LEFT].id[0]) || c->cur_anim == ANIM_GIVE));
        u32 fy16 = 0;
        u16 y;
        for (y = 0; y < dh; y++, fy16 += step_y) {
            s16 vy = (s16)(by + y);
            if (vy < 0 || vy >= max_vy) continue;
            u16 src_y = (u16)(fy16 >> 16); if (src_y >= sh) src_y = sh - 1;
            u32 fx16 = 0;
            u16 x;
            for (x = 0; x < dw; x++, fx16 += step_x) {
                s16 vx = (s16)(bx + x);
                if (vx < 0 || vx >= AG_SCREEN_W) continue;
                u16 src_x = (u16)(fx16 >> 16); if (src_x >= fw) src_x = fw - 1;
                if (flip) src_x = fw - 1 - src_x;
                u8 px = pixels[src_y * sw + frame_x + src_x];
                if (px) g_backbuf[vy * AG_SCREEN_W + vx] = px;
            }
        }
    }
    }

    /* Avanzar frame segun FPS (usa cache ms_per_frame).
     * Durante el pan de scroll-por-mitades los personajes quedan congelados. */
    if (!g_cam_pan_active) {
        u8 nframes = ad->frames > 0 ? ad->frames : 1;
        if (g_ticks_ms - c->frame_timer >= c->ms_per_frame) {
            c->frame_cur = (u8)((c->frame_cur + 1) % nframes);
            c->frame_timer = g_ticks_ms;
        }
        if (c->frame_cur >= nframes) c->frame_cur = 0;
    }
}

static void _render_obj_item(int i) {
    Obj* o = &g_objects[i];
    u16 w, h;
    s16 sx  = (s16)(o->x - g_cam_x);
    u8  animated = (o->anim_frames > 1);
    u16 fw = 0;
    u16 frame_x = 0;
    u8* pixels;
    s16 max_vy = g_bg_fullscreen ? (s16)AG_SCREEN_H : (s16)UI_Y;

    /* Usar cache de decode si disponible; decodificar y cachear si no */
    if (o->dec_buf) {
        pixels = o->dec_buf; w = o->dec_w; h = o->dec_h;
    } else {
        _pcx_decode(o->pcx_buf, o->pcx_size, g_pcx_decode_buf, &w, &h, 0);
        pixels = g_pcx_decode_buf;
        /* Cachear si cabe en presupuesto de sprite (hasta 1024px ancho) */
        if ((u32)w * h <= AG_OBJ_PIX_MAX) {
            o->dec_buf = (u8*)malloc((u32)w * h);
            if (o->dec_buf) {
                memcpy(o->dec_buf, g_pcx_decode_buf, (u32)w * h);
                o->dec_w = w; o->dec_h = h;
                pixels = o->dec_buf;
            }
        }
    }
    w = o->dec_w ? o->dec_w : w;
    h = o->dec_h ? o->dec_h : h;

    if (animated) {
        fw      = o->anim_fw > 0 ? o->anim_fw : (u16)(w / o->anim_frames);
        if (fw < 1) fw = 1;
        frame_x = (u16)(o->frame_cur * fw);
    } else {
        fw      = w;
        frame_x = 0;
    }

    /* Objetos no escalan con zonas de profundidad — siempre tamaño real */
    if (o->spr_cache) {
        _spr_cache_render(o->spr_cache, sx, o->y, frame_x, fw, max_vy);
    } else {
        s16 x, y;
        for (y = 0; y < (s16)h; y++) {
            s16 vy = o->y - (s16)h + y;
            if (vy < 0 || vy >= max_vy) continue;
            for (x = 0; x < (s16)fw; x++) {
                s16 vx = sx + x - (s16)(fw / 2);
                if (vx < 0 || vx >= AG_SCREEN_W) continue;
                u8 px = pixels[y * w + frame_x + x];
                if (px) g_backbuf[vy * AG_SCREEN_W + vx] = px;
            }
        }
    }

    /* Avanzar frame si es animado.
     * ambient_done=1: objeto en idle entre disparos ambient — congelar en frame 0. */
    if (animated && !o->ambient_done) {
        if (g_ticks_ms - o->frame_timer >= o->ms_per_frame) {
            u8 prev = o->frame_cur;
            u8 next = (u8)(o->frame_cur + 1);
            if (next >= o->anim_frames) {
                if (o->anim_loop) next = 0;          /* loop: volver al frame 0 */
                else              next = (u8)(o->anim_frames - 1); /* one-shot: congelar en ultimo */
            }
            o->frame_cur = next;
            /* Solo actualizar frame_timer si el frame realmente avanzó.
             * Si está congelado en el último frame (one-shot), no resetear el timer
             * para que _update_ambient_anims pueda detectar el fin correctamente. */
            if (next != prev)
                o->frame_timer = g_ticks_ms;
        }
    }
}

/* Renderiza personajes + objetos ordenados por Y (painter's algorithm).
 * Entidades con Y menor (mas arriba en pantalla) se dibujan primero (detras).
 * Usa insertion sort: n <= MAX_CHARS+MAX_OBJECTS=48, optimo para pocos elementos. */
/* pass 0 = objetos con over_light==0 + todos los chars
 * pass 1 = objetos con over_light==1 (encima del lightmap) */

/* Registra la animación de hablar de un personaje (slot ANIM_TALK). */
void engine_set_char_talk_anim(const char* char_id, const char* pcx, int frames, int fps, int fw) {
    Char* c = _find_char(char_id); if (!c) return;
    _strlcpy(c->anims[ANIM_TALK].id, pcx, 32);
    c->anims[ANIM_TALK].frames = (u8)(frames > 0 ? frames : 1);
    c->anims[ANIM_TALK].fps    = (u8)(fps > 0 ? fps : 8);
    c->anims[ANIM_TALK].fw     = (u16)(fw > 0 ? fw : 0);
    c->anims[ANIM_TALK].flip   = 0;
}
void engine_set_char_talk_anim_up(const char* char_id, const char* pcx, int frames, int fps, int fw) {
    Char* c = _find_char(char_id); if (!c) return;
    _strlcpy(c->anims[ANIM_TALK_UP].id, pcx, 32);
    c->anims[ANIM_TALK_UP].frames = (u8)(frames > 0 ? frames : 1);
    c->anims[ANIM_TALK_UP].fps    = (u8)(fps > 0 ? fps : 8);
    c->anims[ANIM_TALK_UP].fw     = (u16)(fw > 0 ? fw : 0);
    c->anims[ANIM_TALK_UP].flip   = 0;
}
void engine_set_char_talk_anim_down(const char* char_id, const char* pcx, int frames, int fps, int fw) {
    Char* c = _find_char(char_id); if (!c) return;
    _strlcpy(c->anims[ANIM_TALK_DOWN].id, pcx, 32);
    c->anims[ANIM_TALK_DOWN].frames = (u8)(frames > 0 ? frames : 1);
    c->anims[ANIM_TALK_DOWN].fps    = (u8)(fps > 0 ? fps : 8);
    c->anims[ANIM_TALK_DOWN].fw     = (u16)(fw > 0 ? fw : 0);
    c->anims[ANIM_TALK_DOWN].flip   = 0;
}
void engine_set_char_talk_anim_left(const char* char_id, const char* pcx, int frames, int fps, int fw) {
    Char* c = _find_char(char_id); if (!c) return;
    _strlcpy(c->anims[ANIM_TALK_LEFT].id, pcx, 32);
    c->anims[ANIM_TALK_LEFT].frames = (u8)(frames > 0 ? frames : 1);
    c->anims[ANIM_TALK_LEFT].fps    = (u8)(fps > 0 ? fps : 8);
    c->anims[ANIM_TALK_LEFT].fw     = (u16)(fw > 0 ? fw : 0);
    c->anims[ANIM_TALK_LEFT].flip   = 0;
}

void engine_set_char_give_anim(const char* char_id, const char* pcx, int frames, int fps, int fw) {
    Char* c = _find_char(char_id); if (!c) return;
    _strlcpy(c->anims[ANIM_GIVE].id, pcx, 32);
    c->anims[ANIM_GIVE].frames = (u8)(frames > 0 ? frames : 1);
    c->anims[ANIM_GIVE].fps    = (u8)(fps > 0 ? fps : 8);
    c->anims[ANIM_GIVE].fw     = (u16)(fw > 0 ? fw : 0);
    c->anims[ANIM_GIVE].flip   = 0;
}

/* Activa animación de hablar del protagonista según dirección actual y programa
 * restauración al idle tras duration_ms. Sin efecto si no hay talk anim definida. */
static void _protagonist_talk_start(u32 duration_ms) {
    int talk_role, idle_role;
    Char* c;
    u32 sz2;
    if (!g_char_count) return;
    c = &g_chars[g_protagonist];
    /* Idle de restauración según última dirección (walk O idle direccional) */
    if      ((c->cur_anim == ANIM_WALK_UP   || c->cur_anim == ANIM_IDLE_UP)   && c->anims[ANIM_IDLE_UP].id[0])   idle_role = ANIM_IDLE_UP;
    else if ((c->cur_anim == ANIM_WALK_DOWN || c->cur_anim == ANIM_IDLE_DOWN) && c->anims[ANIM_IDLE_DOWN].id[0]) idle_role = ANIM_IDLE_DOWN;
    else idle_role = ANIM_IDLE;
    /* Seleccionar talk role según dirección */
    if (c->cur_anim == ANIM_WALK_UP || c->cur_anim == ANIM_IDLE_UP) {
        talk_role = c->anims[ANIM_TALK_UP].id[0]   ? ANIM_TALK_UP   :
                    c->anims[ANIM_IDLE_UP].id[0]    ? ANIM_IDLE_UP   : ANIM_IDLE;
    } else if (c->cur_anim == ANIM_WALK_DOWN || c->cur_anim == ANIM_IDLE_DOWN) {
        talk_role = c->anims[ANIM_TALK_DOWN].id[0]  ? ANIM_TALK_DOWN :
                    c->anims[ANIM_IDLE_DOWN].id[0]  ? ANIM_IDLE_DOWN : ANIM_IDLE;
    } else {
        /* Lateral: usar TALK_LEFT si existe y dir_left, si no TALK (renderer lo espeja) */
        if (c->dir_left && c->anims[ANIM_TALK_LEFT].id[0])
            talk_role = ANIM_TALK_LEFT;
        else
            talk_role = c->anims[ANIM_TALK].id[0] ? ANIM_TALK : ANIM_IDLE;
    }
    DBG("talk_start: cur_anim=%d talk_role=%d pcx='%s' talk='%s' talk_up='%s'\n",
        (int)c->cur_anim, talk_role,
        c->anims[talk_role].id,
        c->anims[ANIM_TALK].id,
        c->anims[ANIM_TALK_UP].id);
    if (!c->anims[talk_role].id[0]) return; /* sin PCX: no cambiar */
    CHAR_SET_ANIM(c, talk_role);
    c->frame_cur = 0; c->frame_timer = g_ticks_ms;
    if (strcmp(c->anims[talk_role].id, c->pcx_loaded) != 0) {
        if (c->pcx_buf) { free(c->pcx_buf); c->pcx_buf = NULL; }
        if (c->dec_buf) { free(c->dec_buf); c->dec_buf = NULL; c->dec_w = 0; c->dec_h = 0; }
        _spr_cache_free(c->spr_cache); c->spr_cache = NULL;
        c->pcx_buf = (u8*)engine_dat_load_gfx(c->anims[talk_role].id, &sz2);
        c->pcx_size = sz2;
        _strlcpy(c->pcx_loaded, c->anims[talk_role].id, 32);
    }
    g_talk_restore_ms = g_ticks_ms + duration_ms;
    g_talk_idle_role  = (u8)idle_role;
}

/* Restaura idle del protagonista cuando expira el timer de hablar. */
static void _talk_restore_check(void) {
    Char* c;
    u32 sz3;
    if (!g_talk_restore_ms || g_ticks_ms < g_talk_restore_ms) return;
    g_talk_restore_ms = 0;
    if (!g_char_count) return;
    c = &g_chars[g_protagonist];
    if (c->walking) return; /* si está caminando, el walk completion lo restaurará */
    CHAR_SET_ANIM(c, g_talk_idle_role);
    c->frame_cur = 0; c->frame_timer = g_ticks_ms;
    if (c->anims[g_talk_idle_role].id[0] &&
        strcmp(c->anims[g_talk_idle_role].id, c->pcx_loaded) != 0) {
        if (c->pcx_buf) { free(c->pcx_buf); c->pcx_buf = NULL; }
        if (c->dec_buf) { free(c->dec_buf); c->dec_buf = NULL; c->dec_w = 0; c->dec_h = 0; }
        _spr_cache_free(c->spr_cache); c->spr_cache = NULL;
        c->pcx_buf = (u8*)engine_dat_load_gfx(c->anims[g_talk_idle_role].id, &sz3);
        c->pcx_size = sz3;
        _strlcpy(c->pcx_loaded, c->anims[g_talk_idle_role].id, 32);
    }
}

/* Reproduce la animación dar del protagonista (1 ciclo) y programa vuelta a idle. */
static void _protagonist_give_start(void) {
    Char* c; int give_role, idle_role; u32 gsz; u16 _dw,_dh;
    if (!g_char_count) return;
    c = &g_chars[g_protagonist];
    give_role = c->anims[ANIM_GIVE].id[0] ? ANIM_GIVE :
                (c->anims[ANIM_TALK].id[0] ? ANIM_TALK : -1);
    if (give_role < 0) return;
    /* Idle de restauración */
    if ((c->cur_anim==ANIM_WALK_UP||c->cur_anim==ANIM_IDLE_UP) && c->anims[ANIM_IDLE_UP].id[0])
        idle_role = ANIM_IDLE_UP;
    else if ((c->cur_anim==ANIM_WALK_DOWN||c->cur_anim==ANIM_IDLE_DOWN) && c->anims[ANIM_IDLE_DOWN].id[0])
        idle_role = ANIM_IDLE_DOWN;
    else idle_role = ANIM_IDLE;
    CHAR_SET_ANIM(c, give_role);
    c->frame_cur = 0; c->frame_timer = g_ticks_ms;
    if (strcmp(c->anims[give_role].id, c->pcx_loaded) != 0) {
        if (c->pcx_buf) { free(c->pcx_buf); c->pcx_buf = NULL; }
        if (c->dec_buf) { free(c->dec_buf); c->dec_buf = NULL; c->dec_w = 0; c->dec_h = 0; }
        _spr_cache_free(c->spr_cache); c->spr_cache = NULL;
        c->pcx_buf = (u8*)engine_dat_load_gfx(c->anims[give_role].id, &gsz);
        c->pcx_size = gsz;
        _strlcpy(c->pcx_loaded, c->anims[give_role].id, 32);
        if (c->pcx_buf) {
            _dw=0; _dh=0;
            _pcx_decode(c->pcx_buf,gsz,g_pcx_decode_buf,&_dw,&_dh,0);
            if (_dw>0&&_dh>0&&(u32)_dw*_dh<=(u32)AG_SCREEN_PIXELS) {
                c->dec_buf=(u8*)malloc((u32)_dw*_dh);
                if(c->dec_buf){memcpy(c->dec_buf,g_pcx_decode_buf,(u32)_dw*_dh);c->dec_w=_dw;c->dec_h=_dh;}
            }
        }
    }
    { int _gf = c->anims[give_role].frames > 0 ? c->anims[give_role].frames : 1;
      int _gp = c->anims[give_role].fps    > 0 ? c->anims[give_role].fps    : 8;
      g_talk_restore_ms = g_ticks_ms + (u32)(_gf * 1000 / _gp) + 100u;
    }
    g_talk_idle_role = (u8)idle_role;
}

/* Dibuja en orden de registro los objetos con bg_layer=1 (antes de personajes). */
static void _render_bg_layer_objects(void) {
    int i;
    if (!g_bg_layer_count) return;
    for (i = 0; i < g_obj_count; i++) {
        if (!g_objects[i].visible || !g_objects[i].pcx_buf) continue;
        if (!g_objects[i].bg_layer) continue;
        _render_obj_item(i);
    }
}

static void _render_scene_sorted_pass(int pass) {
    typedef struct { s16 y; u8 type; u8 idx; } SortItem; /* type: 0=obj 1=char */
    static SortItem items[MAX_CHARS + MAX_OBJECTS];
    int n = 0, i, j;
    for (i = 0; i < g_obj_count; i++) {
        if (!g_objects[i].visible || !g_objects[i].pcx_buf) continue;
        if (g_objects[i].bg_layer) continue;          /* ya renderizado en _render_bg_layer_objects */
        if ((int)g_objects[i].over_light != pass) continue;
        items[n].y = g_objects[i].y; items[n].type = 0; items[n].idx = (u8)i; n++;
    }
    if (pass == 0) {
        for (i = 0; i < g_char_count; i++) {
            if (!g_chars[i].visible) { DBG("render skip char[%d]=%s: invisible\n", i, g_chars[i].id); continue; }
            if (!g_chars[i].pcx_buf) { DBG("render skip char[%d]=%s: pcx_buf=NULL anim=%d\n", i, g_chars[i].id, g_chars[i].cur_anim); continue; }
            items[n].y = g_chars[i].y; items[n].type = 1; items[n].idx = (u8)i; n++;
        }
    }
    /* Insertion sort por Y */
    for (i = 1; i < n; i++) {
        SortItem tmp = items[i]; j = i - 1;
        while (j >= 0 && items[j].y > tmp.y) { items[j+1] = items[j]; j--; }
        items[j+1] = tmp;
    }
    for (i = 0; i < n; i++) {
        if (items[i].type == 0) _render_obj_item(items[i].idx);
        else                    _render_char_item(items[i].idx);
    }
}

static void _render_scene_sorted(void) {
    _render_scene_sorted_pass(0);
    if (g_over_light_count > 0)
        _render_scene_sorted_pass(1); /* over_light encima: solo si hay algun objeto con ese flag */
}

void engine_render_chars(void) {
    int i;
    for (i = 0; i < g_char_count; i++) {
        if (!g_chars[i].visible || !g_chars[i].pcx_buf) continue;
        _render_char_item(i);
    }
}

void engine_render_objects(void) {
    int i;
    for (i = 0; i < g_obj_count; i++) {
        if (!g_objects[i].visible || !g_objects[i].pcx_buf) continue;
        _render_obj_item(i);
    }
}

/* ===========================================================================
 * S14b - FUENTES BITMAP
 * =========================================================================== */

/* Mapeo de char -> indice de glifo.
 * Posicion 0 = ASCII 32 (' '). Los espanoles estan en posiciones 96-111. */
static int _char_to_glyph(unsigned char c) {
    if (c >= 32 && c <= 127) return (int)(c - 32);
    switch (c) {
        /* cp850 español */
        case 0xA0: return 96;  case 0x82: return 97;
        case 0xA1: return 98;  case 0xA2: return 99;
        case 0xA3: return 100; case 0x81: return 101;
        case 0xA4: return 102; case 0xB5: return 103;
        case 0x90: return 104; case 0xD6: return 105;
        case 0xE0: return 106; case 0xE9: return 107;
        case 0x9A: return 108; case 0xA5: return 109;
        case 0xA8: return 110; case 0xAD: return 111;
        /* cp850 catalán / francés — graves */
        case 0x85: return 112; /* à */  case 0x8A: return 113; /* è */
        case 0x8D: return 114; /* ì */  case 0x95: return 115; /* ò */
        case 0x97: return 116; /* ù */
        /* cp850 circumflex */
        case 0x83: return 117; /* â */  case 0x88: return 118; /* ê */
        case 0x8C: return 119; /* î */  case 0x93: return 120; /* ô */
        case 0x96: return 121; /* û */
        /* cp850 dieresis i, cedilla, ligatures */
        case 0x8B: return 122; /* ï */  case 0x87: return 123; /* ç */
        /* majúsculas */
        case 0x8E: return 126; /* À */  case 0xD4: return 127; /* È */
        case 0xDE: return 128; /* Ì */  case 0xE3: return 129; /* Ò */
        case 0xEB: return 130; /* Ù */
        case 0xB6: return 131; /* Â */  case 0xD2: return 132; /* Ê */
        case 0xD7: return 133; /* Î */  case 0xE2: return 134; /* Ô */
        case 0xEA: return 135; /* Û */
        case 0xD8: return 136; /* Ï */  case 0x80: return 137; /* Ç */
        /* punt volat catalán, guillemets */
        case 0xFA: return 141; /* · */
        case 0xAE: return 142; /* « */  case 0xAF: return 143; /* » */
        default:   return 0;
    }
}

/* Carga una fuente desde GRAPHICS.DAT.
 * El PCX tiene FONT_N_GLYPHS glifos en una sola fila horizontal. */
void engine_font_load(u8 font_idx, const char* gfx_id) {
    u8*      pcx = NULL;
    u32      sz  = 0;
    u16      w = 0, h = 0;
    FontSlot* f;
    char     path[24];
    FILE*    fp;
    size_t   id_len;

    if (font_idx >= FONT_COUNT) return;
    f = &g_fonts[font_idx];
    if (f->data) { free(f->data); f->data = NULL; f->ok = 0; }

    /* 1) Fichero PCX suelto en el mismo directorio */
    id_len = strlen(gfx_id);
    if (id_len < 20) {
        memcpy(path, gfx_id, id_len);
        memcpy(path + id_len, ".PCX", 5);
        fp = fopen(path, "rb");
        if (fp) {
            fseek(fp, 0, SEEK_END);
            sz = (u32)ftell(fp);
            fseek(fp, 0, SEEK_SET);
            pcx = (u8*)malloc(sz ? sz : 1);
            if (pcx) fread(pcx, 1, sz, fp);
            fclose(fp);
            DBG("font_load file '%s' sz=%lu\n", path, (unsigned long)sz);
        }
    }

    /* 2) FONTS.DAT */
    if (!pcx) {
        pcx = (u8*)engine_dat_load_font(gfx_id, &sz);
        if (pcx) DBG("font_load FONTS.DAT '%s' sz=%lu\n", gfx_id, (unsigned long)sz);
    }

    if (!pcx) { DBG("font_load FAIL: '%s'\n", gfx_id); return; }

    _pcx_decode(pcx, sz, g_pcx_decode_buf, &w, &h, 0);
    free(pcx);
    if (!w || !h) { DBG("font_load decode FAIL w=%d h=%d\n",(int)w,(int)h); return; }
    f->data = (u8*)malloc((u32)w * h);
    if (!f->data) return;
    memcpy(f->data, g_pcx_decode_buf, (u32)w * h);
    f->tw  = w;
    f->gw  = w / FONT_N_GLYPHS;
    f->gh  = h;
    f->ok  = 1;
    DBG("font_load OK: idx=%d gw=%d gh=%d tw=%d\n",(int)font_idx,(int)f->gw,(int)f->gh,(int)f->tw);
}

static void _fonts_free(void) {
    u8 i;
    for (i = 0; i < FONT_COUNT; i++) {
        if (g_fonts[i].data) { free(g_fonts[i].data); g_fonts[i].data = NULL; }
        g_fonts[i].ok = 0;
    }
}

s16 engine_text_width(u8 font_idx, const char* txt) {
    const FontSlot* f;
    s16 w = 0, max_w = 0;
    const char* p;
    if (font_idx >= FONT_COUNT) return 0;
    f = &g_fonts[font_idx];
    for (p = txt; ; p++) {
        if (*p == '\0' || *p == '\n') {
            if (w > max_w) max_w = w;
            if (!*p) break;
            w = 0;
        } else {
            w += f->ok ? (s16)f->gw : 6;
        }
    }
    return max_w;
}

/* Dibuja txt en g_backbuf con la fuente, color e indicador de sombra dados.
 * color_idx : indice de paleta VGA (15=blanco, 14=amarillo?).
 * shadow    : 1 = sombra negra 1px abajo-derecha. */
void engine_draw_text(s16 x, s16 y, u8 font_idx, u8 color_idx, u8 shadow,
                      const char* txt) {
    const FontSlot* f;
    s16 cx = x;
    const char* p;
    if (font_idx >= FONT_COUNT) return;
    f = &g_fonts[font_idx];
    if (!f->ok || !f->data) return;
    for (p = txt; *p; p++) {
        int   gi  = _char_to_glyph((unsigned char)*p);
        u16   gx0 = (u16)(gi * f->gw);
        s16   px, py;
        for (py = 0; py < (s16)f->gh; py++) {
            for (px = 0; px < (s16)f->gw; px++) {
                u8 idx = f->data[(u32)py * f->tw + gx0 + px];
                if (idx == 0) continue; /* transparente */
                if (shadow) {
                    s16 sx = cx + px + 1, sy = y + py + 1;
                    if (sx >= 0 && sx < AG_SCREEN_W && sy >= 0 && sy < AG_SCREEN_H)
                        g_backbuf[sy * AG_SCREEN_W + sx] = 0; /* negro */
                }
                {
                    s16 dx = cx + px, dy = y + py;
                    if (dx >= 0 && dx < AG_SCREEN_W && dy >= 0 && dy < AG_SCREEN_H)
                        g_backbuf[dy * AG_SCREEN_W + dx] =
                            (idx == FONT_COLOR_KEY) ? color_idx : idx;
                }
            }
        }
        cx += (s16)f->gw;
    }
}

/* Texto centrado en el rango horizontal [x0, x1) */
static void _draw_text_centered(s16 x0, s16 x1, s16 y,
                                  u8 font_idx, u8 color_idx, u8 shadow,
                                  const char* txt) {
    s16 tw = engine_text_width(font_idx, txt);
    s16 xc = x0 + (x1 - x0 - tw) / 2;
    if (xc < x0) xc = x0;
    engine_draw_text(xc, y, font_idx, color_idx, shadow, txt);
}

/* Texto con reborde exterior de 1px: dibuja el texto en color_border en los
 * 8 offsets cardinales/diagonales y luego el texto en color_fill encima. */
static void _draw_text_outlined(s16 x, s16 y, u8 font_idx,
                                  u8 color_fill, u8 color_border,
                                  const char* txt) {
    static const s16 ox[8] = {-1, 0, 1,-1, 1,-1, 0, 1};
    static const s16 oy[8] = {-1,-1,-1, 0, 0, 1, 1, 1};
    int k;
    for (k = 0; k < 8; k++)
        engine_draw_text((s16)(x+ox[k]), (s16)(y+oy[k]), font_idx, color_border, 0, txt);
    engine_draw_text(x, y, font_idx, color_fill, 0, txt);
}

/* Texto con reborde centrado en [x0,x1) */
static void _draw_text_outlined_centered(s16 x0, s16 x1, s16 y, u8 font_idx,
                                           u8 color_fill, u8 color_border,
                                           const char* txt) {
    s16 tw = engine_text_width(font_idx, txt);
    s16 xc = x0 + (x1 - x0 - tw) / 2;
    if (xc < x0) xc = x0;
    _draw_text_outlined(xc, y, font_idx, color_fill, color_border, txt);
}

/* ===========================================================================
 * S14c - VERBSET UI (barra inferior 56px, filas 144-199)
 * ===========================================================================
 *
 * Layout (320?56):
 *
 *   x:  0 -------------------- 192 ------- 320
 *       ?  Verbos (3 col ? 3 fil)?Inventario?
 *       ?  celda 64?18 px        ? (128?56) ?
 *   y: 144 --------------------------------199
 *
 * Texto de accion: linea superior de la UI (y = UI_Y + 2), centrado en 320px.
 * El verbo bajo el cursor se resalta con sombra + color diferente.
 */

/* -- Layout de la zona de verbos ---------------------------------------------
 * UI: filas 144-199 (56px total, indice 1 = negro)
 *
 * Distribucion horizontal (320px):
 *   0..149   Verbos  : 3 cols x 50px = 150px
 *   150..169 Flechas : columna de scroll inventario (20px)
 *   170..319 Inventario: 4 cols x 37px = 148px en 150px
 *
 * Grid verbos 3 cols x 3 filas:
 *   col ancho = 150/3 = 50px
 *   fila alto = 56/3 = 18px  (3x18=54, 2px de relleno abajo)
 *
 * Fuente small: glifo 8x8px
 * Texto de accion: superpuesto sobre el escenario (y = UI_Y - 16)
 * Verbos de movimiento (isMovement=1): no se dibujan en el grid.
 * --------------------------------------------------------------------------- */
#define VERB_AREA_W    150   /* px desde izquierda para verbos (3x50) */
#define VERB_COLS      3
#define VERB_ROWS      3
#define VERB_CELL_W    50    /* VERB_AREA_W / VERB_COLS */
#define VERB_CELL_H    15    /* (UI_H(56) - ACTION_LINE_H(11)) / VERB_ROWS(3) */
#define VERB_FONT      FONT_SMALL    /* glifo 8x8 */
#define VERB_FONT_H    8     /* altura del glifo de VERB_FONT */
#define VERB_PAD_Y     3     /* (VERB_CELL_H(15) - VERB_FONT_H(8)) / 2 */

/* -- Linea de accion integrada en la UI -------------------------------------- */
#define ACTION_LINE_H  11   /* 1px pad + 8px fuente + 2px pad: banda superior UI */

/* -- Layout de flechas de scroll e inventario -------------------------------- */
#define ARROW_X      150   /* inicio columna flechas scroll (junto a verbos) */
#define ARROW_W       20   /* ancho columna flechas */
#define INV_X        170   /* inicio area inventario (ARROW_X + ARROW_W) */
#define INV_Y_START  (UI_Y + ACTION_LINE_H)   /* verbos e inv arrancan bajo la linea accion */
#define INV_H        (UI_H - ACTION_LINE_H)   /* 45px disponibles para verbos e inv */
#define INV_W        150   /* 320 - INV_X */
#define INV_COLS       4
#define INV_ROWS       2
#define INV_SLOT_W    37   /* 4x37=148 en 150px; icono real 36px -> 1px gap */
#define INV_SLOT_H    22   /* 2x22+1gap=45 en INV_H(45)px */

/* -- Party button y popup (entre las flechas de inventario) ----------------- */
#define PARTY_BTN_W   ACTION_LINE_H              /* ancho area boton = alto action line */
#define PARTY_BTN_X  (ACTION_LINE_H / 2)         /* centro x en action line */
#define PARTY_BTN_Y  (UI_Y + ACTION_LINE_H / 2)  /* centro y en action line */
#define PARTY_BTN_R    4                          /* radio fallback circulo */
/* Popup grid: 4 col x max 2 filas, celdas cuadradas, sin nombres */
#define POPUP_COLS     4                              /* columnas del grid */
#define POPUP_CELL    28                              /* tamaño celda (px) */
#define POPUP_FACE    24                              /* cara dentro celda (px) */
#define POPUP_FACE_PAD  ((POPUP_CELL - POPUP_FACE) / 2)  /* = 2 */
#define POPUP_GRID_W  (POPUP_COLS * POPUP_CELL)       /* = 112 */
#define POPUP_BG_PAD   3                              /* padding fondo panel */
#define POPUP_X0      ((AG_SCREEN_W - POPUP_GRID_W) / 2)  /* = 104 */

/* Lee el bloque VERBSET desde SCRIPTS.DAT y rellena g_verbs[].
 * Formato DAT (serializeVerbset):
 *   str8  id        (uint8 len + bytes)
 *   str8  name
 *   uint8 numVerbs
 *   per verbo: str8 verbId, str8 label, uint8 isMovement, uint8 approachObj, uint8 sx, uint8 sy
 */
static void _load_verbset_from_dat(const char* vs_id) {
    u8*  data;
    u32  sz;
    u8*  p;
    u8   nv, i, len;
    g_verb_count = 0;
    DBG("load_verbset: id='%s'\n", vs_id ? vs_id : "NULL");
    data = (u8*)engine_dat_load_scripts(vs_id, &sz);
    if (!data) { DBG("  -> dat_load_scripts FAIL (scr_f=%p)\n",(void*)g_scr_f); return; }
    DBG("  -> loaded %lu bytes\n", (unsigned long)sz);
    p = data;
    /* saltar id */
    if (p + 1 > data + sz) { free(data); return; }
    len = *p++; p += len;
    /* saltar name */
    if (p + 1 > data + sz) { free(data); return; }
    len = *p++; p += len;
    /* numVerbs */
    if (p + 1 > data + sz) { free(data); return; }
    nv = *p++;
    DBG("  -> numVerbs=%d\n", (int)nv);
    for (i = 0; i < nv && g_verb_count < MAX_VERBS_IN_SET; i++) {
        VerbEntry* ve = &g_verbs[g_verb_count];
        if (p + 1 > data + sz) break;
        len = *p++; if (len > 31) len = 31;
        memcpy(ve->id, p, len); ve->id[len] = '\0'; p += len;
        if (p + 1 > data + sz) break;
        len = *p++; if (len > 31) len = 31;
        memcpy(ve->label, p, len); ve->label[len] = '\0'; p += len;
        if (p + 5 > data + sz) break;
        ve->is_movement  = *p++;
        ve->approach_obj = *p++;
        ve->is_pickup    = *p++;
        ve->col          = *p++;
        ve->row          = *p++;
        /* Colores configurables (normal y hover). Si no existen en el DAT, usar defaults */
        if (p + 2 <= data + sz) {
            ve->normal_color = *p++;
            ve->hover_color  = *p++;
        } else {
            ve->normal_color = 15; /* blanco por defecto */
            ve->hover_color  = 15;
        }
        ve->is_give = 0; /* establecido via engine_set_give_verb() desde codegen */
        DBG("  verb[%d]: id='%s' label='%s' mv=%d approach=%d col=%d row=%d nc=%d hc=%d\n",
            (int)g_verb_count, ve->id, ve->label,
            (int)ve->is_movement, (int)ve->approach_obj,
            (int)ve->col, (int)ve->row,
            (int)ve->normal_color, (int)ve->hover_color);
        g_verb_count++;
    }
    free(data);
}

void engine_render_verbset(void) {
    int i, vi, r;

    /* Fondo de zona UI */
    for (r = UI_Y; r < AG_SCREEN_H; r++)
        memset(g_backbuf + r * AG_SCREEN_W, g_ui_col_bg, AG_SCREEN_W);

    if (g_verb_count == 0 || !g_fonts[VERB_FONT].ok) return;

    /* Frase de accion: integrada en la banda superior de la UI (y = UI_Y + 1). */
    if (g_action_text[0]) {
        _draw_text_outlined_centered(0, AG_SCREEN_W,
            (s16)(UI_Y + 1),
            VERB_FONT, g_ui_col_action, 1, g_action_text);
    }

    /* Grid 3x3: texto centrado en su celda, hover resaltado */
    vi = 0;
    for (i = 0; i < g_verb_count && vi < VERB_COLS * VERB_ROWS; i++) {
        const VerbEntry* ve = &g_verbs[i];
        s16 col, row, cx0, cy0, ty, tw, tx;
        u8  color;
        int hover;
        if (ve->is_movement) continue;

        col  = (s16)(vi % VERB_COLS);
        row  = (s16)(vi / VERB_COLS);
        vi++;

        cx0  = (s16)(col * VERB_CELL_W);
        cy0  = (s16)(INV_Y_START + row * VERB_CELL_H);
        ty   = (s16)(cy0 + (VERB_CELL_H - VERB_FONT_H) / 2); /* centrado vertical */

        /* Hover: raton encima de la celda */
        hover = (g_mouse.y >= cy0 && g_mouse.y < cy0 + VERB_CELL_H &&
                 g_mouse.x >= cx0 && g_mouse.x < cx0 + VERB_CELL_W);

        /* Color: amarillo si seleccionado, hover_color si hover, normal_color si no.
         * No se dibuja fondo de hover — solo cambia el color del texto. */
        if (_str_eq(ve->id, g_selected_verb)) color = g_ui_col_sel;    /* verbo seleccionado */
        else if (hover)                        color = ve->hover_color;
        else                                   color = ve->normal_color;

        /* Centrar texto horizontalmente en la celda */
        tw = engine_text_width(VERB_FONT, ve->label);
        tx = (s16)(cx0 + (VERB_CELL_W - tw) / 2);
        if (tx < cx0) tx = cx0;
        engine_draw_text(tx, ty, VERB_FONT, color, 0, ve->label);
    }

    /* ── Flechas de scroll + Inventario ── */
    {
        int col, row;
        for (row = 0; row < INV_ROWS; row++) {
            for (col = 0; col < INV_COLS; col++) {
                int visual_idx = g_inv_scroll + row * INV_COLS + col;
                InvSlot* slot  = _inv_prot_slot(visual_idx);
                s16 sx = (s16)(INV_X + col * INV_SLOT_W);
                s16 sy = (s16)(INV_Y_START + row * INV_SLOT_H);
                if (!slot) continue;
                /* Highlight hover o seleccionado: relleno completo del slot */
                if (visual_idx == g_inv_hover || _str_eq(slot->obj_id, g_selected_inv)) {
                    s16 fx, fy;
                    for (fy = sy; fy < sy+INV_SLOT_H && fy < AG_SCREEN_H; fy++)
                        for (fx = sx; fx < sx+INV_SLOT_W && fx < AG_SCREEN_W; fx++)
                            g_backbuf[fy*AG_SCREEN_W+fx] = g_ui_col_inv_hov;
                }
                /* Icono PCX centrado */
                if (slot->pcx_buf) {
                    u16 iw, ih;
                    _pcx_decode(slot->pcx_buf, slot->pcx_size,
                                g_pcx_decode_buf, &iw, &ih, 0);
                    { s16 ix, iy;
                      u16 dw = (iw > (u16)INV_SLOT_W) ? (u16)INV_SLOT_W : iw;
                      u16 dh = (ih > (u16)INV_SLOT_H) ? (u16)INV_SLOT_H : ih;
                      s16 ox = (s16)(sx + (INV_SLOT_W - dw) / 2);
                      s16 oy = (s16)(sy + (INV_SLOT_H - dh) / 2);
                      for (iy = 0; iy < (s16)dh; iy++) {
                          s16 vy = (s16)(oy + iy);
                          s16 sy_src = (s16)(((u32)iy * ih) / dh);
                          if (vy < 0 || vy >= AG_SCREEN_H) continue;
                          for (ix = 0; ix < (s16)dw; ix++) {
                              s16 vx = (s16)(ox + ix);
                              s16 sx_src = (s16)(((u32)ix * iw) / dw);
                              if (vx < 0 || vx >= AG_SCREEN_W) continue;
                              { u8 px = g_pcx_decode_buf[sy_src * iw + sx_src];
                                if (px) g_backbuf[vy * AG_SCREEN_W + vx] = px; }
                          }
                      }
                    }
                } else {
                    /* Sin icono: nombre abreviado */
                    const char* oi = slot->obj_id;
                    char nk[52]; const char* nm;
                    s16 ty = (s16)(sy + (INV_SLOT_H - 7) / 2);
                    snprintf(nk, sizeof(nk), "obj.%.43s.name", oi);
                    nm = engine_text(nk);
                    if (_str_eq(nm, nk)) nm = oi;
                    engine_draw_text((s16)(sx+2), ty, VERB_FONT, 15, 0, nm);
                }
            }
        }
        /* Flechas de scroll en columna central (ARROW_X..ARROW_X+ARROW_W).
         * Si hay sprite asignado lo dibuja centrado en la celda; si no, usa texto ^/v.
         * Detecta hover comprobando si el cursor está en la columna de flechas. */
        { int visible = INV_COLS * INV_ROWS;
          s16 ax = (s16)(ARROW_X + (ARROW_W - VERB_FONT_H) / 2); /* centrar glifo de texto */
          /* Hover de fila 0 (arriba) y fila 1 (abajo) */
          int hover_up = (g_mouse.x >= ARROW_X && g_mouse.x < ARROW_X + ARROW_W &&
                          g_mouse.y >= INV_Y_START && g_mouse.y < INV_Y_START + INV_SLOT_H);
          int hover_dn = (g_mouse.x >= ARROW_X && g_mouse.x < ARROW_X + ARROW_W &&
                          g_mouse.y >= INV_Y_START + INV_SLOT_H && g_mouse.y < INV_Y_START + INV_H);

          if (g_inv_scroll > 0) {
              /* Seleccionar sprite: hover_up → upHover, normal → up, fallback → NULL */
              ArrowSprite* asp = (hover_up && g_arrow_up_hover.buf) ? &g_arrow_up_hover
                               : (g_arrow_up.buf)                   ? &g_arrow_up
                               : NULL;
              if (asp) {
                  /* Dibujar sprite centrado en la celda de flecha */
                  u16 iw, ih; s16 ix, iy;
                  _pcx_decode(asp->buf, asp->size, g_pcx_decode_buf, &iw, &ih, 0);
                  { u16 dw = (iw > (u16)ARROW_W) ? (u16)ARROW_W : iw;
                    u16 dh = (ih > (u16)INV_SLOT_H) ? (u16)INV_SLOT_H : ih;
                    s16 ox = (s16)(ARROW_X + (ARROW_W   - dw) / 2);
                    s16 oy = (s16)(INV_Y_START + (INV_SLOT_H - dh) / 2);
                    for (iy = 0; iy < (s16)dh; iy++) {
                        s16 vy = (s16)(oy + iy); s16 sy_src = (s16)(((u32)iy * ih) / dh);
                        if (vy < 0 || vy >= AG_SCREEN_H) continue;
                        for (ix = 0; ix < (s16)dw; ix++) {
                            s16 vx = (s16)(ox + ix); s16 sx_src = (s16)(((u32)ix * iw) / dw);
                            if (vx < 0 || vx >= AG_SCREEN_W) continue;
                            { u8 px = g_pcx_decode_buf[sy_src * iw + sx_src];
                              if (px) g_backbuf[vy * AG_SCREEN_W + vx] = px; }
                        }
                    }
                  }
              } else {
                  /* Sin sprite: fondo gris + texto */
                  { int _ar;
                    for (_ar = INV_Y_START; _ar < INV_Y_START + INV_SLOT_H && _ar < AG_SCREEN_H; _ar++)
                        memset(g_backbuf + _ar * AG_SCREEN_W + ARROW_X + 1, 8, ARROW_W - 2);
                  }
                  engine_draw_text(ax, (s16)(INV_Y_START + (INV_SLOT_H - VERB_FONT_H) / 2),
                                   VERB_FONT, 15, 0, "^");
              }
          }
          /* (boton de party movido a action line — ver bloque independiente abajo) */
          if (g_inv_scroll + visible < _inv_prot_count()) {
              ArrowSprite* asp = (hover_dn && g_arrow_dn_hover.buf) ? &g_arrow_dn_hover
                               : (g_arrow_dn.buf)                   ? &g_arrow_dn
                               : NULL;
              if (asp) {
                  u16 iw, ih; s16 ix, iy;
                  _pcx_decode(asp->buf, asp->size, g_pcx_decode_buf, &iw, &ih, 0);
                  { u16 dw = (iw > (u16)ARROW_W) ? (u16)ARROW_W : iw;
                    u16 dh = (ih > (u16)INV_SLOT_H) ? (u16)INV_SLOT_H : ih;
                    s16 ox2 = (s16)(ARROW_X + (ARROW_W   - dw) / 2);
                    s16 oy2 = (s16)(INV_Y_START + INV_SLOT_H + (INV_SLOT_H - dh) / 2);
                    for (iy = 0; iy < (s16)dh; iy++) {
                        s16 vy = (s16)(oy2 + iy); s16 sy_src = (s16)(((u32)iy * ih) / dh);
                        if (vy < 0 || vy >= AG_SCREEN_H) continue;
                        for (ix = 0; ix < (s16)dw; ix++) {
                            s16 vx = (s16)(ox2 + ix); s16 sx_src = (s16)(((u32)ix * iw) / dw);
                            if (vx < 0 || vx >= AG_SCREEN_W) continue;
                            { u8 px = g_pcx_decode_buf[sy_src * iw + sx_src];
                              if (px) g_backbuf[vy * AG_SCREEN_W + vx] = px; }
                        }
                    }
                  }
              } else {
                  { int _ar;
                    for (_ar = INV_Y_START + INV_SLOT_H; _ar < INV_Y_START + INV_H && _ar < AG_SCREEN_H; _ar++)
                        memset(g_backbuf + _ar * AG_SCREEN_W + ARROW_X + 1, 8, ARROW_W - 2);
                  }
                  engine_draw_text(ax, (s16)(INV_Y_START + INV_SLOT_H + (INV_SLOT_H - VERB_FONT_H) / 2),
                                   VERB_FONT, 15, 0, "v");
              }
          }
        }
    }

    /* Boton de cambio de protagonista: extremo izquierdo de la action line */
    if (g_party_count > 1) {
        int _hbtn = (g_mouse.x >= 0 && g_mouse.x < PARTY_BTN_W &&
                     g_mouse.y >= UI_Y && g_mouse.y < UI_Y + ACTION_LINE_H);
        ArrowSprite* _bsp = (_hbtn && g_party_btn_hov.buf) ? &g_party_btn_hov
                          : (g_party_btn.buf)               ? &g_party_btn
                          : NULL;
        if (_bsp) {
            u16 _biw, _bih; s16 _bix, _biy;
            _pcx_decode(_bsp->buf, _bsp->size, g_pcx_decode_buf, &_biw, &_bih, 0);
            { u16 _bdw = (_biw > (u16)PARTY_BTN_W) ? (u16)PARTY_BTN_W : _biw;
              u16 _bdh = (_bih > (u16)ACTION_LINE_H) ? (u16)ACTION_LINE_H : _bih;
              s16 _box = (s16)((PARTY_BTN_W - _bdw) / 2);
              s16 _boy = (s16)(UI_Y + (ACTION_LINE_H - _bdh) / 2);
              for (_biy = 0; _biy < (s16)_bdh; _biy++) {
                  s16 _bvy = (s16)(_boy + _biy);
                  s16 _bsy = (s16)(((u32)_biy * _bih) / _bdh);
                  if (_bvy < 0 || _bvy >= AG_SCREEN_H) continue;
                  for (_bix = 0; _bix < (s16)_bdw; _bix++) {
                      s16 _bvx = (s16)(_box + _bix);
                      s16 _bsx = (s16)(((u32)_bix * _biw) / _bdw);
                      if (_bvx < 0 || _bvx >= AG_SCREEN_W) continue;
                      { u8 _bpx = g_pcx_decode_buf[_bsy * _biw + _bsx];
                        if (_bpx) g_backbuf[_bvy * AG_SCREEN_W + _bvx] = _bpx; }
                  }
              }
            }
        } else {
            u8 _bcol = (g_party_popup_open || _hbtn) ? 15 : 7;
            { int _bpy, _bpx;
              for (_bpy = PARTY_BTN_Y - PARTY_BTN_R; _bpy <= PARTY_BTN_Y + PARTY_BTN_R; _bpy++) {
                  if (_bpy < UI_Y || _bpy >= AG_SCREEN_H) continue;
                  for (_bpx = PARTY_BTN_X - PARTY_BTN_R; _bpx <= PARTY_BTN_X + PARTY_BTN_R; _bpx++) {
                      if (_bpx < 0 || _bpx >= AG_SCREEN_W) continue;
                      { int _bdx = _bpx - PARTY_BTN_X, _bdy = _bpy - PARTY_BTN_Y;
                        if (_bdx*_bdx + _bdy*_bdy <= PARTY_BTN_R*PARTY_BTN_R)
                            g_backbuf[_bpy * AG_SCREEN_W + _bpx] = _bcol;
                      }
                  }
              }
            }
        }
    }

    /* Popup selector de protagonista: grid 4 col x max 2 filas, solo caras */
    if (g_party_popup_open && g_party_count > 1) {
        int _pi;
        int _rows = (g_party_count + POPUP_COLS - 1) / POPUP_COLS;
        s16 _grid_h = (s16)(_rows * POPUP_CELL);
        s16 _py0    = (s16)(UI_Y - POPUP_BG_PAD - _grid_h);
        /* Fondo del panel */
        { int _pr, _pc;
          int _bg0 = (int)_py0 - POPUP_BG_PAD;
          int _bg1 = UI_Y;
          int _bgx0 = POPUP_X0 - POPUP_BG_PAD;
          int _bgx1 = POPUP_X0 + POPUP_GRID_W + POPUP_BG_PAD;
          for (_pr = _bg0; _pr < _bg1; _pr++) {
              if (_pr < 0 || _pr >= AG_SCREEN_H) continue;
              for (_pc = _bgx0; _pc < _bgx1; _pc++) {
                  if (_pc < 0 || _pc >= AG_SCREEN_W) continue;
                  g_backbuf[_pr * AG_SCREEN_W + _pc] = g_popup_col_bg;
              }
          }
          /* Borde */
          for (_pr = _bg0; _pr < _bg1; _pr++) {
              if (_pr < 0 || _pr >= AG_SCREEN_H) continue;
              if (_bgx0 >= 0)             g_backbuf[_pr * AG_SCREEN_W + _bgx0]   = g_popup_col_border;
              if (_bgx1 < AG_SCREEN_W)    g_backbuf[_pr * AG_SCREEN_W + _bgx1-1] = g_popup_col_border;
          }
          for (_pc = _bgx0; _pc < _bgx1; _pc++) {
              if (_pc < 0 || _pc >= AG_SCREEN_W) continue;
              if (_bg0 >= 0 && _bg0 < AG_SCREEN_H) g_backbuf[_bg0 * AG_SCREEN_W + _pc] = g_popup_col_border;
              if (_bg1-1 >= 0 && _bg1-1 < AG_SCREEN_H) g_backbuf[(_bg1-1) * AG_SCREEN_W + _pc] = g_popup_col_border;
          }
        }
        /* Celdas del grid */
        for (_pi = 0; _pi < g_party_count; _pi++) {
            int _col = _pi % POPUP_COLS;
            int _row = _pi / POPUP_COLS;
            s16 _cx  = (s16)(POPUP_X0 + _col * POPUP_CELL);
            s16 _cy  = (s16)(_py0     + _row * POPUP_CELL);
            int _is_cur = (g_char_count > 0) &&
                          _str_eq(g_party[_pi].id, g_chars[g_protagonist].id);
            int _hover  = (g_mouse.x >= (int)_cx && g_mouse.x < (int)_cx + POPUP_CELL &&
                           g_mouse.y >= (int)_cy && g_mouse.y < (int)_cy + POPUP_CELL);
            /* Fondo celda: activo=gris oscuro, hover=azul */
            if (_is_cur || _hover) {
                int _r3, _c3;
                for (_r3 = (int)_cy; _r3 < (int)_cy + POPUP_CELL; _r3++) {
                    if (_r3 < 0 || _r3 >= AG_SCREEN_H) continue;
                    for (_c3 = (int)_cx; _c3 < (int)_cx + POPUP_CELL; _c3++) {
                        if (_c3 < 0 || _c3 >= AG_SCREEN_W) continue;
                        g_backbuf[_r3 * AG_SCREEN_W + _c3] = _is_cur ? g_popup_col_active : g_popup_col_hover;
                    }
                }
            }
            /* Cara escalada a POPUP_FACE x POPUP_FACE */
            if (g_party[_pi].face_pcx_buf) {
                u16 _fw2, _fh2; s16 _fix, _fiy;
                _pcx_decode(g_party[_pi].face_pcx_buf, g_party[_pi].face_pcx_size,
                            g_pcx_decode_buf, &_fw2, &_fh2, 0);
                for (_fiy = 0; _fiy < (s16)POPUP_FACE; _fiy++) {
                    s16 _fvy = (s16)(_cy + POPUP_FACE_PAD + _fiy);
                    if (_fvy < 0 || _fvy >= AG_SCREEN_H) continue;
                    for (_fix = 0; _fix < (s16)POPUP_FACE; _fix++) {
                        s16 _fvx = (s16)(_cx + POPUP_FACE_PAD + _fix);
                        if (_fvx < 0 || _fvx >= AG_SCREEN_W) continue;
                        { s16 _fsx = (s16)(((u32)_fix * _fw2) / POPUP_FACE);
                          s16 _fsy = (s16)(((u32)_fiy * _fh2) / POPUP_FACE);
                          u8 _fpx  = g_pcx_decode_buf[_fsy * _fw2 + _fsx];
                          if (_fpx) g_backbuf[_fvy * AG_SCREEN_W + _fvx] = _fpx;
                        }
                    }
                }
            }
        }
    }
}

/* Coge un objeto: muestra frase, protagonista camina hasta él,
 * lo oculta de la sala y lo añade al inventario con su icono.  */
void engine_pickup_object(const char* obj_id, const char* verb_id) {
    char phrase_key[64];
    char name_key[52];
    const char* phrase;
    const char* name;
    Obj* o = _find_obj(obj_id);
    /* Usar obj_id real del objeto para buscar locale (no el inst id) */
    const char* real_id = (o && o->obj_id[0]) ? o->obj_id : obj_id;

    /* 0. Nombre del objeto — buscar primero por real_id, luego inst id */
    snprintf(name_key, sizeof(name_key), "obj.%.43s.name", real_id);
    name = engine_text(name_key);
    if (_str_eq(name, name_key)) {
        snprintf(name_key, sizeof(name_key), "obj.%.43s.name", obj_id);
        name = engine_text(name_key);
        if (_str_eq(name, name_key)) name = real_id;
    }

    /* 1. Frase de acción */
    snprintf(phrase_key, sizeof(phrase_key), "obj.%.28s.verb.%.20s", real_id, verb_id);
    phrase = engine_text(phrase_key);
    if (_str_eq(phrase, phrase_key))
        snprintf(g_action_text, sizeof(g_action_text), "%s %s", verb_id, name);
    else
        _strlcpy(g_action_text, phrase, sizeof(g_action_text));

    /* 2. Protagonista camina hasta el objeto */
    if (g_char_count > 0 && o) {
        engine_walk_char_to_obj(g_chars[g_protagonist].id, obj_id, 0);
        engine_wait_walk(g_chars[g_protagonist].id);
        if (o->x < g_chars[g_protagonist].x)
            engine_face_dir(g_chars[g_protagonist].id, "left");
        else
            engine_face_dir(g_chars[g_protagonist].id, "right");
    }

    /* 3. Ocultar de la sala */
    if (o) o->visible = 0;

    /* 4. Añadir al inventario */
    engine_give_object(obj_id, g_char_count > 0 ? g_chars[g_protagonist].id : "");

    /* 5. Breve pausa mostrando la frase (~600ms) */
    { u32 _t = g_ticks_ms;
      while (g_ticks_ms - _t < 600) engine_flip();
    }
    g_action_text[0] = '\0';
}

/* Dibuja cursor cruceta (3x3 sin centro, color 15=blanco con borde 1=negro). */
static void _draw_cursor(void) {
    s16 cx = g_mouse.x, cy = g_mouse.y;
    /* 4 brazos de 3px: arriba, abajo, izquierda, derecha */
    static const s16 dx[12] = { 0, 0, 0,  0, 0, 0, -3,-2,-1,  1, 2, 3};
    static const s16 dy[12] = {-3,-2,-1,  1, 2, 3,  0, 0, 0,  0, 0, 0};
    int k;
    /* Borde negro: offsets +/-1 alrededor de cada pixel del brazo */
    for (k = 0; k < 12; k++) {
        s16 px = (s16)(cx+dx[k]), py = (s16)(cy+dy[k]);
        s16 bx, by;
        for (bx = -1; bx <= 1; bx++) for (by = -1; by <= 1; by++) {
            s16 fx = (s16)(px+bx), fy = (s16)(py+by);
            if (fx >= 0 && fx < AG_SCREEN_W && fy >= 0 && fy < AG_SCREEN_H)
                g_backbuf[fy*AG_SCREEN_W+fx] = 1; /* negro */
        }
    }
    /* Pixeles blancos del brazo encima */
    for (k = 0; k < 12; k++) {
        s16 px = (s16)(cx+dx[k]), py = (s16)(cy+dy[k]);
        if (px >= 0 && px < AG_SCREEN_W && py >= 0 && py < AG_SCREEN_H)
            g_backbuf[py*AG_SCREEN_W+px] = 15; /* blanco */
    }
}

/* Actualiza timers de animacion ambiental para todos los objetos de la room.
 * Llamar al inicio de engine_flip, antes de renderizar. */
static void _update_ambient_anims(void) {
    int i;
    for (i = 0; i < g_obj_count; i++) {
        Obj* o = &g_objects[i];
        if (!o->ambient_max_ms || !o->ambient_state[0]) continue;

        if (o->ambient_playing) {
            /* Detectar fin de one-shot: ultimo frame mostrado durante un ciclo completo */
            if (!o->anim_loop && o->anim_frames > 1 &&
                o->frame_cur >= o->anim_frames - 1 &&
                g_ticks_ms - o->frame_timer >= o->ms_per_frame) {
                /* Restaurar estado base y congelar en frame 0 hasta el siguiente disparo */
                engine_set_object_state(o->id, o->ambient_base);
                o->anim_loop       = o->ambient_base_loop;
                o->frame_cur       = 0;
                o->frame_timer     = g_ticks_ms;
                o->ambient_done    = 1; /* idle: no avanzar frames hasta el proximo disparo */
                o->ambient_playing = 0;
                o->ambient_next_ms = g_ticks_ms +
                    _ambient_rand_ms(o->ambient_min_ms, o->ambient_max_ms);
            }
        } else {
            /* Disparar si el timer vencio */
            if (o->ambient_next_ms && g_ticks_ms >= o->ambient_next_ms) {
                _strlcpy(o->ambient_base, o->state, 32); /* guardar estado actual */
                o->ambient_base_loop = o->anim_loop;     /* guardar loop del estado base */
                o->ambient_done    = 0; /* permitir avance de frames durante la animacion */
                engine_set_object_state(o->id, o->ambient_state);
                o->anim_loop       = 0; /* one-shot */
                o->frame_cur       = 0;
                o->frame_timer     = g_ticks_ms;
                o->ambient_playing = 1;
            }
        }
    }
}

void engine_flip(void) {
    /* Animaciones ambientales: actualizar antes de renderizar */
    _update_ambient_anims();
    /* Scroll por mitades: avanzar pan (actualiza g_cam_x/g_bgbuf) antes de renderizar */
    if (g_scroll_halves) {
        _update_scroll_pan();
        _check_scroll_halves();
    }
    _camera_follow();
    memcpy(g_backbuf, g_bgbuf, AG_SCREEN_PIXELS);
    /* Capa fondo: objetos bg_layer=1 se dibujan justo encima del fondo,
     * antes de personajes y objetos normales (ej: suelos, muelles, plataformas). */
    _render_bg_layer_objects();

    if (g_ambient_light < 100 && g_shade_lut_valid && g_room_light_count > 0) {
        int x, y;
        u8* p;
        /* Pasada 0: chars + objetos sin over_light ni bg_layer */
        _render_scene_sorted_pass(0);
        engine_audio_update(); /* flush tras render pass 0 — evita starve MPU en rooms con lightmap */
        /* Lightmap sobre todo lo anterior */
        _lmap_compute();
        /* Aplicar shade por celdas 4x4: 4000 lecturas de lmap en vez de 64000.
         * UI_Y/4 = 12 filas de celdas (UI_Y=152 → 38); LM_W=80 columnas. */
        { int cy2, cx2, py2, px2;
          for (cy2 = 0; cy2 < LM_H; cy2++) {
            int row_end = cy2 * 4 + 4; if (row_end > UI_Y) row_end = UI_Y;
            for (cx2 = 0; cx2 < LM_W; cx2++) {
                u8 lv = g_lmap[cy2 * LM_W + cx2];
                u8 np = g_shade_passes_lut[lv]; /* 0=sin shade, 1..3=pasadas */
                if (np == 0) continue;
                for (py2 = cy2 * 4; py2 < row_end; py2++) {
                    u8* row = g_backbuf + py2 * AG_SCREEN_W + cx2 * 4;
                    row[0]=g_shade_lut[row[0]]; row[1]=g_shade_lut[row[1]]; row[2]=g_shade_lut[row[2]]; row[3]=g_shade_lut[row[3]];
                    if (np > 1) { row[0]=g_shade_lut[row[0]]; row[1]=g_shade_lut[row[1]]; row[2]=g_shade_lut[row[2]]; row[3]=g_shade_lut[row[3]]; }
                    if (np > 2) { row[0]=g_shade_lut[row[0]]; row[1]=g_shade_lut[row[1]]; row[2]=g_shade_lut[row[2]]; row[3]=g_shade_lut[row[3]]; }
                }
            }
          }
        }
        engine_audio_update(); /* flush tras lightmap + shade — la parte mas costosa del frame */
        /* Pasada 1: objetos over_light encima (solo si existen) */
        if (g_over_light_count > 0)
            _render_scene_sorted_pass(1);
        g_sprite_shade_passes = 0;
    } else {
        /* Sin iluminacion: render normal en una sola pasada */
        _render_scene_sorted();
    }

    if (!g_bg_fullscreen) {
        /* UI normal: verbset, overlays de texto, cursor */
        if (!g_ui_hidden) engine_render_verbset();
        { int _oi;
          for (_oi = 0; _oi < MAX_OVERLAYS; _oi++) {
              Overlay* ov = &g_overlays[_oi];
              if (!ov->active) continue;
              if (!ov->wait_click && ov->until_ms && g_ticks_ms >= ov->until_ms) {
                  ov->active = 0; continue;
              }
              if (g_overlay_click_seen) { ov->active = 0; continue; }
              /* Renderizar texto con soporte de saltos de linea (\n) */
              { const char* _tp = ov->text; s16 _ly = ov->y;
                for (;;) {
                    char _ln[MAX_TEXT_LEN+1]; int _ll; const char* _te = _tp;
                    while (*_te && *_te != '\n') _te++;
                    _ll = (int)(_te - _tp); if (_ll > MAX_TEXT_LEN) _ll = MAX_TEXT_LEN;
                    memcpy(_ln, _tp, (u32)_ll); _ln[_ll] = '\0';
                    { s16 tw = engine_text_width(VERB_FONT, _ln); s16 ox;
                      if (ov->center_x >= 0) {
                          /* Centrar esta linea sobre la posicion X del personaje */
                          ox = _text_ox(ov->center_x, tw);
                      } else if (ov->x < 0) {
                          ox = (s16)((AG_SCREEN_W - tw) / 2);
                          if (ox < 2) ox = 2;
                      } else {
                          ox = ov->x;
                      }
                      engine_draw_text((s16)(ox+1), (s16)(_ly+1), VERB_FONT, 0, 0, _ln);
                      engine_draw_text(ox, _ly, VERB_FONT, ov->color, 0, _ln);
                    }
                    if (!*_te) break;
                    _tp = _te + 1; _ly += (s16)(VERB_FONT_H + 2);
                }
              }
          }
        }
        if (g_overlay_click_seen) g_overlay_click_seen = 0;
        _draw_cursor();
    } else {
        if (g_overlay_click_seen) g_overlay_click_seen = 0;
    }

    /* FPS — contador por ventana de 1 segundo usando g_ticks_ms */
    if (g_cfg_show_fps) {
        static u32 s_fps_frames = 0;
        static u32 s_fps_last   = 0;
        static u32 s_fps_val    = 0;
        char fps_buf[8];
        s16  fx, fy;
        s_fps_frames++;
        if (g_ticks_ms - s_fps_last >= 1000) {
            s_fps_val    = s_fps_frames;
            s_fps_frames = 0;
            s_fps_last   = g_ticks_ms;
        }
        fps_buf[0] = (char)('0' + (s_fps_val / 10) % 10);
        fps_buf[1] = (char)('0' + s_fps_val % 10);
        fps_buf[2] = '\0';
        if (s_fps_val >= 100) {
            fps_buf[0] = (char)('0' + (s_fps_val / 100) % 10);
            fps_buf[1] = (char)('0' + (s_fps_val / 10)  % 10);
            fps_buf[2] = (char)('0' + s_fps_val          % 10);
            fps_buf[3] = '\0';
        }
        fx = (s16)(AG_SCREEN_W - (s16)engine_text_width(FONT_SMALL, fps_buf) - 3);
        fy = 2;
        engine_draw_text((s16)(fx+1), (s16)(fy+1), FONT_SMALL, 0,  0, fps_buf); /* sombra */
        engine_draw_text(fx,          fy,           FONT_SMALL, 14, 0, fps_buf); /* amarillo */
    }

    engine_audio_update();
    if (g_pre_flip_fn) g_pre_flip_fn();
    _vga_flip();
}

void engine_clear(u8 color_idx) {
    memset(g_backbuf, color_idx, AG_SCREEN_PIXELS);
}


/* ===========================================================================
 * S14 - TEXTO
 * =========================================================================== */

void engine_set_language(const char* lang_code) {
    char lang_id[40];
    int i;
    if (!lang_code || !lang_code[0]) return;
    /* Construir id "lang_XX" y cargar */
    _strlcpy(lang_id, "lang_", sizeof(lang_id));
    _strlcpy(lang_id + 5, lang_code, sizeof(lang_id) - 5);
    _load_language_by_id(lang_id);
    _strlcpy(g_active_lang, lang_code, sizeof(g_active_lang));
    /* Actualizar labels de verbos con el nuevo idioma */
    for (i = 0; i < g_verb_count; i++) {
        char key[40];
        const char* lbl;
        _strlcpy(key, "verb.", sizeof(key));
        _strlcpy(key + 5, g_verbs[i].id, sizeof(key) - 5);
        lbl = engine_text(key);
        if (!_str_eq(lbl, key))
            _strlcpy(g_verbs[i].label, lbl, sizeof(g_verbs[i].label));
    }
}

void engine_seq_call(void (*seq_fn)(void)) {
    /* Llama a una secuencia como subfunción y continúa tras ella.
     * El stack de llamadas C gestiona el retorno automáticamente. */
    if (seq_fn) seq_fn();
}

/* ===========================================================================
 * S15 - FUNCIONES DE SECUENCIA
 * =========================================================================== */

/* --- play_rooms: entra en modo interactivo, suspende la secuencia ---------- */
/* g_seq_resume: 0=no hay secuencia pendiente, 1=esperando resume             */
static int    g_seq_resume_requested = 0;
static char   g_seq_resume_flag[32]  = "";
static char   g_seq_resume_value[32] = "";

void engine_play_rooms(const char* flag, const char* value) {
    /* Salir de modo fullscreen si venimos de una room a 320x200 */
    g_bg_fullscreen = 0;
    _strlcpy(g_seq_resume_flag,  flag  ? flag  : "", sizeof(g_seq_resume_flag));
    _strlcpy(g_seq_resume_value, value ? value : "", sizeof(g_seq_resume_value));
    g_seq_resume_requested = 0;
    /* Ejecutar el loop interactivo hasta que se solicite resume */
    while (g_running && !g_seq_resume_requested) {
        /* Flag watchers: fuera de engine_process_input para evitar recursion
         * cuando el handler llama a funciones bloqueantes como engine_wait_walk */
        { int _wi;
          for (_wi = 0; _wi < g_flag_watcher_count; _wi++) {
              FlagWatcher* _w = &g_flag_watchers[_wi];
              int _fv = engine_get_flag(_w->flag);
              if (!_w->fired && _fv == _w->expect) {
                  _w->fired = 1;
                  DBG("flag_watcher FIRE: flag=%s fv=%d expect=%d\n", _w->flag, _fv, _w->expect);
                  if (_w->handler) _w->handler();
              } else if (_w->fired && _fv != _w->expect) {
                  _w->fired = 0;
              }
          }
        }
        /* Comprobar flag de condicion si se definio */
        if (g_seq_resume_flag[0]) {
            int _fv = engine_get_flag(g_seq_resume_flag);
            int _tv;
            if      (g_seq_resume_value[0] == '\0')             _tv = 1;
            else if (_str_eq(g_seq_resume_value, "true"))        _tv = 1;
            else if (_str_eq(g_seq_resume_value, "false"))       _tv = 0;
            else { const char* _p = g_seq_resume_value; int _n = 0; while (*_p >= '0' && *_p <= '9') _n = _n*10 + (*_p++ - '0'); _tv = _n; }
            if (_fv == _tv) break;
        }
        if (!engine_process_input()) break;
        engine_flip();
    }
    g_seq_resume_requested = 0;
}

void engine_resume_sequence(void) {
    g_seq_resume_requested = 1;
}

void engine_hide_ui(void) { g_ui_hidden = 1; }
void engine_show_ui(void) { g_ui_hidden = 0; }

/* --- solid_color: pantalla de un color durante duration_ms ----------------- */
void engine_seq_solid_color(u8 color_idx, u32 duration_ms) {
    u32 until = g_ticks_ms + duration_ms;
    memset(g_backbuf, color_idx, AG_SCREEN_PIXELS);
    _vga_flip();
    while (g_ticks_ms < until) {
        if (kbhit()) { int k = getch(); if (k==27) break; }
    }
}

/* --- color_fade: fundido unificado con efecto paleta o dissolve ------------
 * from_color: 0-255 = color inicio, 255 = usar pantalla actual
 * to_color:   0-254 = color destino, 255 = revelar pantalla siguiente
 * effect:     0 = paleta (fade suave), 1 = dissolve (pixels aleatorios)
 * -------------------------------------------------------------------------*/
void engine_seq_color_fade(u8 from_color, u8 to_color, u32 duration_ms) {
    u32 steps = duration_ms / 16 + 1;
    u32 i;
    int pi;
    static u8 screen_buf[AG_SCREEN_PIXELS];
    u8 from_screen = (from_color == 255);
    u8 dst_r, dst_g, dst_b;
    u8 src_r = 0, src_g = 0, src_b = 0;

    /* Snapshot del fondo actual ANTES de cualquier modificacion */
    memcpy(screen_buf, g_bgbuf, AG_SCREEN_PIXELS);

    /* Color destino (siempre un indice de paleta) */
    dst_r = (u8)(g_pal_raw[to_color*3+0] >> 2);
    dst_g = (u8)(g_pal_raw[to_color*3+1] >> 2);
    dst_b = (u8)(g_pal_raw[to_color*3+2] >> 2);

    if (!from_screen) {
        /* fromColor es un indice de paleta: arrancar con pantalla de ese color */
        src_r = (u8)(g_pal_raw[from_color*3+0] >> 2);
        src_g = (u8)(g_pal_raw[from_color*3+1] >> 2);
        src_b = (u8)(g_pal_raw[from_color*3+2] >> 2);
        memset(g_backbuf, from_color, AG_SCREEN_PIXELS);
        _vga_flip();
    }
    /* from_screen: la pantalla ya muestra el fondo actual, la paleta hace el efecto */

    for (i = 0; i <= steps && g_running; i++) {
        u8 pal[768];
        u32 t = i * 64 / steps;
        for (pi = 0; pi < 256; pi++) {
            u8 cr = (u8)(g_pal_raw[pi*3+0] >> 2);
            u8 cg = (u8)(g_pal_raw[pi*3+1] >> 2);
            u8 cb = (u8)(g_pal_raw[pi*3+2] >> 2);
            if (from_screen) {
                /* Paleta actual degradandose hacia el color destino */
                pal[pi*3+0] = (u8)(cr + (int)(dst_r - cr) * (int)t / 64);
                pal[pi*3+1] = (u8)(cg + (int)(dst_g - cg) * (int)t / 64);
                pal[pi*3+2] = (u8)(cb + (int)(dst_b - cb) * (int)t / 64);
            } else {
                /* Color origen uniforme aclarando hacia la paleta actual */
                pal[pi*3+0] = (u8)(src_r + (int)(cr - src_r) * (int)t / 64);
                pal[pi*3+1] = (u8)(src_g + (int)(cg - src_g) * (int)t / 64);
                pal[pi*3+2] = (u8)(src_b + (int)(cb - src_b) * (int)t / 64);
            }
        }
        outp(0x3C8, 0);
        for (pi = 0; pi < 768; pi++) outp(0x3C9, pal[pi]);
        engine_wait_ms(16);
        if (kbhit()) { int k = getch(); if (k==27) break; }
    }

    /* Restaurar paleta original */
    outp(0x3C8, 0);
    for (pi = 0; pi < 768; pi++) outp(0x3C9, g_pal_raw[pi] >> 2);

    /* Dejar backbuf y bgbuf en el color destino */
    memset(g_backbuf, to_color, AG_SCREEN_PIXELS);
    memset(g_bgbuf,   to_color, AG_SCREEN_PIXELS);
    _vga_flip();
}
/* --- fade_to_color: fundido del fondo actual a un color -------------------- */
void engine_seq_fade_to_color(u8 color_idx, u32 duration_ms) {
    u8 target_r = (u8)(g_pal_raw[color_idx*3+0] >> 2);
    u8 target_g = (u8)(g_pal_raw[color_idx*3+1] >> 2);
    u8 target_b = (u8)(g_pal_raw[color_idx*3+2] >> 2);
    u32 steps = duration_ms / 16 + 1;
    u32 i;
    for (i = 0; i <= steps && g_running; i++) {
        u8 pal[768];
        int pi;
        u32 t = i * 64 / steps;  /* 0..64 */
        for (pi = 0; pi < 256; pi++) {
            u8 sr = (u8)(g_pal_raw[pi*3+0] >> 2);
            u8 sg = (u8)(g_pal_raw[pi*3+1] >> 2);
            u8 sb = (u8)(g_pal_raw[pi*3+2] >> 2);
            pal[pi*3+0] = (u8)(sr + (int)(target_r - sr) * (int)t / 64);
            pal[pi*3+1] = (u8)(sg + (int)(target_g - sg) * (int)t / 64);
            pal[pi*3+2] = (u8)(sb + (int)(target_b - sb) * (int)t / 64);
        }
        outp(0x3C8, 0);
        for (pi = 0; pi < 768; pi++) outp(0x3C9, pal[pi]);
        engine_wait_ms(16);
    }
    /* Dejar paleta en color destino */
    memset(g_backbuf, color_idx, AG_SCREEN_PIXELS);
    _vga_flip();
}

/* --- fade_from_color: fundido desde un color al fondo actual --------------- */
void engine_seq_fade_from_color(u8 color_idx, u32 duration_ms) {
    u8 src_r = (u8)(g_pal_raw[color_idx*3+0] >> 2);
    u8 src_g = (u8)(g_pal_raw[color_idx*3+1] >> 2);
    u8 src_b = (u8)(g_pal_raw[color_idx*3+2] >> 2);
    u32 steps = duration_ms / 16 + 1;
    u32 i;
    memset(g_backbuf, color_idx, AG_SCREEN_PIXELS);
    _vga_flip();
    for (i = 0; i <= steps && g_running; i++) {
        u8 pal[768];
        int pi;
        u32 t = i * 64 / steps;
        for (pi = 0; pi < 256; pi++) {
            u8 dr = (u8)(g_pal_raw[pi*3+0] >> 2);
            u8 dg = (u8)(g_pal_raw[pi*3+1] >> 2);
            u8 db = (u8)(g_pal_raw[pi*3+2] >> 2);
            pal[pi*3+0] = (u8)(src_r + (int)(dr - src_r) * (int)t / 64);
            pal[pi*3+1] = (u8)(src_g + (int)(dg - src_g) * (int)t / 64);
            pal[pi*3+2] = (u8)(src_b + (int)(db - src_b) * (int)t / 64);
        }
        outp(0x3C8, 0);
        for (pi = 0; pi < 768; pi++) outp(0x3C9, pal[pi]);
        engine_wait_ms(16);
    }
    /* Restaurar paleta original */
    outp(0x3C8, 0);
    { int pi; for (pi = 0; pi < 768; pi++) outp(0x3C9, g_pal_raw[pi] >> 2); }
}

/* --- show_pcx: PCX 320x200 pantalla completa durante duration_ms ----------- */
void engine_seq_show_pcx(const char* gfx_id, u32 duration_ms) {
    u32 sz = 0;
    void* pcx = engine_dat_load_gfx(gfx_id, &sz);
    u32 until;
    if (!pcx) return;
    engine_load_bg(gfx_id);
    free(pcx);
    memcpy(g_backbuf, g_bgbuf, AG_SCREEN_PIXELS);
    _vga_flip();
    until = g_ticks_ms + duration_ms;
    while (g_ticks_ms < until) {
        if (kbhit()) { int k = getch(); if (k==27) break; }
    }
}

/* --- show_bg: carga un fondo PCX y opcionalmente espera -------------------- */
void engine_seq_show_bg(const char* gfx_id, u32 duration_ms, u8 show_ui) {
    u32 until;
    if (show_ui) {
        /* Mostrar UI: PCX en zona de escenario (144px), UI encima */
        engine_load_bg(gfx_id);
        memcpy(g_backbuf, g_bgbuf, AG_SCREEN_PIXELS);
        engine_render_verbset();
    } else {
        /* Ocultar UI: decodificar PCX completo (hasta 200px) sobre backbuf */
        u32 sz;
        u8* pcx = (u8*)engine_dat_load_gfx(gfx_id, &sz);
        if (pcx) {
            u16 w, h;
            int r;
            static u8 full_buf[AG_SCREEN_PIXELS];
            _pcx_decode(pcx, sz, full_buf, &w, &h, 1);
            free(pcx);
            /* Blit filas completas hasta 200px en backbuf Y bgbuf */
            for (r = 0; r < AG_SCREEN_H && r < (int)h; r++) {
                const u8* src = full_buf + r * (w > AG_SCREEN_W ? AG_SCREEN_W : w);
                memcpy(g_backbuf + r * AG_SCREEN_W, src, AG_SCREEN_W);
                memcpy(g_bgbuf   + r * AG_SCREEN_W, src, AG_SCREEN_W);
            }
        }
    }
    _vga_flip();
    if (duration_ms == 0) return;
    until = g_ticks_ms + duration_ms;
    while (g_ticks_ms < until && g_running) {
        if (kbhit()) { int k = getch(); if (k==27) break; }
    }
}

/* --- walk_char_nb: version no bloqueante de walk_char ---------------------- */
void engine_walk_char_nb(const char* char_id, s16 x, s16 y, u8 speed) {
    engine_walk_char(char_id, x, y, speed);
    /* No bloqueante: solo inicia el camino, no espera */
}

/* --- wait_all_chars: espera a que todos los personajes terminen de caminar -- */
void engine_wait_all_chars(void) {
    int any_walking;
    do {
        int i;
        any_walking = 0;
        for (i = 0; i < g_char_count; i++)
            if (g_chars[i].walking) { any_walking = 1; break; }
        if (any_walking) {
            if (!engine_process_input()) break;
            engine_flip();
        }
    } while (any_walking && g_running);
}

/* --- set_anim_seq: cambia animacion de un personaje durante duration_ms ---- */
void engine_seq_set_anim(const char* char_id, const char* anim_name,
                         u8 fps_override, u8 loop, u32 duration_ms) {
    Char* c = _find_char(char_id);
    u32 until;
    u8 frames;
    u32 anim_duration_ms;
    if (!c) return;
    engine_set_anim(char_id, anim_name);
    if (fps_override > 0)
        c->anims[c->cur_anim].fps = fps_override;

    if (duration_ms == 0 && !loop) {
        /* Sin duracion ni loop: calcular duración de un ciclo completo */
        frames = c->anims[c->cur_anim].frames;
        if (frames == 0) frames = 1;
        anim_duration_ms = frames * 1000u /
                           (c->anims[c->cur_anim].fps > 0 ? c->anims[c->cur_anim].fps : 8);
        until = g_ticks_ms + anim_duration_ms;
    } else if (duration_ms > 0) {
        until = g_ticks_ms + duration_ms;
    } else {
        return; /* loop sin duracion: no bloquea */
    }

    while (g_ticks_ms < until && g_running) {
        engine_flip();
        if (kbhit()) { int k = getch(); if (k==27) break; }
    }
    engine_set_anim(char_id, "idle");
}

/* --- face_dir_seq: orienta personaje (wrapper para uso en secuencias) ------ */
void engine_seq_face_dir(const char* char_id, const char* dir) {
    engine_face_dir(char_id, dir);
    engine_flip(); /* renderizar un frame para que el cambio sea visible */
}

/* --- set_char_visible_seq: visibilidad personaje en secuencia -------------- */
void engine_seq_set_char_visible(const char* char_id, int visible) {
    engine_set_char_visible(char_id, visible);
}

void engine_show_text(const char* locale_key) {
    const char* txt = engine_text(locale_key);
    if (txt && txt[0] && txt != locale_key)
        _overlay_add(txt, 15, -1, 30, g_ticks_ms + 2000, 0);
}

void engine_show_text_ex(const char* locale_key, u8 color, u32 duration_ms) {
    const char* txt = engine_text(locale_key);
    if (!txt || !txt[0] || txt == locale_key) return;
    DBG("show_text_ex: key='%s' color=%d dur=%u\n", locale_key, (int)color, (unsigned)duration_ms);
    if (duration_ms == 0) {
        _overlay_add(txt, color, -1, 30, 0, 1);
        /* Bloqueante: esperar click con animaciones corriendo */
        g_overlay_click_seen = 0;
        while (g_running && !g_overlay_click_seen) {
            engine_flip();
            if (!engine_process_input()) break;
        }
        _overlay_clear_all();
        g_overlay_click_seen = 0;
    } else {
        _overlay_add(txt, color, -1, 30, g_ticks_ms + duration_ms, 0);
        /* Bloqueante: esperar a que expire con animaciones corriendo */
        u32 until = g_ticks_ms + duration_ms;
        while (g_running && g_ticks_ms < until) {
            engine_flip();
            if (!engine_process_input()) break;
            /* Click adelanta */
            if (g_overlay_click_seen) break;
        }
        _overlay_clear_all();
        g_overlay_click_seen = 0;
    }
}

/* Word-wrap: inserta \n en src → dst para que ningun segmento supere 'cols' chars.
 * No usa malloc; reemplaza espacios entre palabras por \n cuando es necesario.
 * Si una palabra es mas larga que cols se parte forzosamente. */
static void _word_wrap(const char* src, char* dst, int max_dst, int cols) {
    int col = 0, di = 0;
    const char* p = src;
    while (*p && di < max_dst - 1) {
        if (*p == '\n') { dst[di++] = '\n'; col = 0; p++; continue; }
        if (*p == ' ') {
            /* look-ahead: longitud de la proxima palabra */
            const char* nw = p + 1; int wl = 0;
            while (nw[wl] && nw[wl] != ' ' && nw[wl] != '\n') wl++;
            if (col + 1 + wl > cols) { dst[di++] = '\n'; col = 0; p++; }
            else                      { dst[di++] = ' ';  col++;   p++; }
            continue;
        }
        dst[di++] = *p++; col++;
        if (col >= cols && *p && *p != ' ' && *p != '\n' && di < max_dst - 1)
            { dst[di++] = '\n'; col = 0; }
    }
    dst[di] = 0;
}

/* Muestra texto con animacion de hablar del protagonista (bloqueante, click-to-advance).
 * char_id ignorado: siempre usa el protagonista activo (g_protagonist).
 * text_key: clave de locale (ej: "obj.ID.verb.ID"). Soporta \n para multilinea.
 * La animacion de hablar se selecciona segun la direccion actual del protagonista. */
void engine_say(const char* char_id, const char* text_key) {
    const char* txt;
    char _wb[MAX_TEXT_LEN+1];
    s16 char_sx = (s16)(AG_SCREEN_W / 2); s16 oy = 30;
    u32 duration_ms, until;
    int len, nlines; const char* p;
    (void)char_id; /* siempre usa el protagonista activo */
    txt = engine_text(text_key);
    if (!txt || !txt[0] || txt == text_key) return;
    /* Word-wrap: 38 cols para FONT_SMALL 8px (304px usables de 320) */
    _word_wrap(txt, _wb, MAX_TEXT_LEN+1, 38);
    txt = _wb;
    /* Contar chars y lineas */
    len = 0; nlines = 1;
    for (p = txt; *p; p++) { if (*p == '\n') nlines++; len++; }
    /* Posicion Y encima del protagonista; X = screen x para centrar por linea */
    if (g_char_count > 0) {
        Char* pr = &g_chars[g_protagonist];
        char_sx = (s16)(pr->x - (s16)g_cam_x);
        oy = (s16)(pr->y / 2);
        /* Subir bloque para que la ultima linea quede en oy */
        oy -= (s16)((nlines - 1) * (VERB_FONT_H + 2));
        if (oy < 4) oy = 4;
    }
    /* Duracion: ~60ms/caracter + 1200ms base, maximo 6s */
    duration_ms = (u32)(len * 60 + 1200);
    if (duration_ms > 6000) duration_ms = 6000;
    /* Iniciar animacion de hablar */
    _protagonist_talk_start(duration_ms);
    /* Mostrar overlay con centrado por linea sobre el personaje */
    _overlay_add_say(txt, 15, char_sx, oy, g_ticks_ms + duration_ms);
    /* Bucle bloqueante: esperar click o fin de duracion */
    g_overlay_click_seen = 0;
    until = g_ticks_ms + duration_ms;
    while (g_running && g_ticks_ms < until) {
        engine_flip();
        if (!engine_process_input()) break;
        if (g_overlay_click_seen) break;
    }
    _overlay_clear_all();
    g_overlay_click_seen = 0;
    /* Forzar restauracion de idle inmediatamente */
    g_talk_restore_ms = g_ticks_ms;
    _talk_restore_check();
}

/* engine_say_anim: como engine_say pero reproduce un rol de animacion especifico
 * en lugar de seleccionarlo por posicion. Tras el texto restaura el idle correcto:
 *   talk_up / walk_up / idle_up  → idle_up (o idle si no existe)
 *   talk_down / walk_down / idle_down → idle_down (o idle si no existe)
 *   cualquier otro              → idle (conserva dir_left actual)
 * anim_role: nombre de rol ("talk","talk_up","walk_left","idle_down", etc.) */
void engine_say_anim(const char* char_id, const char* text_key, const char* anim_role) {
    const char* txt;
    char _wb[MAX_TEXT_LEN+1];
    s16 char_sx = (s16)(AG_SCREEN_W / 2); s16 oy = 30;
    u32 duration_ms, until;
    int len, nlines; const char* p;
    u8 restore_role = ANIM_IDLE;
    (void)char_id;
    txt = engine_text(text_key);
    if (!txt || !txt[0] || txt == text_key) return;
    if (!anim_role || !anim_role[0]) { engine_say(char_id, text_key); return; }
    _word_wrap(txt, _wb, MAX_TEXT_LEN+1, 38);
    txt = _wb;
    len = 0; nlines = 1;
    for (p = txt; *p; p++) { if (*p == '\n') nlines++; len++; }
    if (g_char_count > 0) {
        Char* pr = &g_chars[g_protagonist];
        char_sx = (s16)(pr->x - (s16)g_cam_x);
        oy = (s16)(pr->y / 2);
        oy -= (s16)((nlines - 1) * (VERB_FONT_H + 2));
        if (oy < 4) oy = 4;
        /* Calcular restore idle segun el rol pedido */
        if (_str_eq(anim_role,"talk_up")   || _str_eq(anim_role,"walk_up")   || _str_eq(anim_role,"idle_up")) {
            restore_role = pr->anims[ANIM_IDLE_UP].id[0] ? ANIM_IDLE_UP : ANIM_IDLE;
        } else if (_str_eq(anim_role,"talk_down") || _str_eq(anim_role,"walk_down") || _str_eq(anim_role,"idle_down")) {
            restore_role = pr->anims[ANIM_IDLE_DOWN].id[0] ? ANIM_IDLE_DOWN : ANIM_IDLE;
        } else {
            restore_role = ANIM_IDLE;
        }
        /* Reproducir el rol pedido */
        engine_set_anim(pr->id, anim_role);
    }
    duration_ms = (u32)(len * 60 + 1200);
    if (duration_ms > 6000) duration_ms = 6000;
    g_talk_restore_ms = g_ticks_ms + duration_ms;
    g_talk_idle_role  = restore_role;
    _overlay_add_say(txt, 15, char_sx, oy, g_ticks_ms + duration_ms);
    g_overlay_click_seen = 0;
    until = g_ticks_ms + duration_ms;
    while (g_running && g_ticks_ms < until) {
        engine_flip();
        if (!engine_process_input()) break;
        if (g_overlay_click_seen) break;
    }
    _overlay_clear_all();
    g_overlay_click_seen = 0;
    g_talk_restore_ms = g_ticks_ms;
    _talk_restore_check();
}

void engine_seq_show_text(const char* locale_key, const char* font,
                          u8 color_idx, u8 bg_color_idx, u8 has_bg_color,
                          const char* bg_pcx_id,
                          const char* position, const char* align,
                          const char* effect, u16 typewriter_speed,
                          u32 duration_ms) {
    const char* txt = engine_text(locale_key);
    u32 until = 0;  /* se calcula justo antes del loop, tras efectos */
    u8 font_idx = FONT_SMALL;
    u8 bg_loaded = 0;
    u8 eff_bg;   /* 0xFF = sin fondo; otro = indice paleta para memset pantalla */
    const char* pos_str;
    const char* aln_str;

    pos_str = position ? position : "bottom";
    aln_str = align    ? align    : "center";
    eff_bg  = has_bg_color ? bg_color_idx : 0xFF;

    /* Resolver fuente: acepta "small"/"medium"/"large" y variantes "_solid"/"_shadow" */
    if (font) {
        if (font[0]=='m') font_idx = FONT_MEDIUM;
        else if (font[0]=='l') font_idx = FONT_LARGE;
        else font_idx = FONT_SMALL;
    }

    /* Cargar PCX de fondo temporal si se especifica */
    if (bg_pcx_id && bg_pcx_id[0]) {
        void* pcx = engine_dat_load_gfx(bg_pcx_id, NULL);
        if (pcx) {
            free(pcx);
            engine_load_bg(bg_pcx_id);
            memcpy(g_seq_bg_tmp, g_bgbuf, AG_SCREEN_PIXELS);
            bg_loaded = 1;
        }
    }

    /* Efecto fade-in */
    if (_str_eq(effect, "fade")) {
        int step;
        for (step = 0; step <= 8; step++) {
            u8 pal[768];
            int pi;
            u8* base_src = bg_loaded ? g_seq_bg_tmp : g_bgbuf;
            for (pi = 0; pi < 256; pi++) {
                pal[pi*3+0] = (u8)(g_pal_raw[pi*3+0] * step / 8);
                pal[pi*3+1] = (u8)(g_pal_raw[pi*3+1] * step / 8);
                pal[pi*3+2] = (u8)(g_pal_raw[pi*3+2] * step / 8);
            }
            outp(0x3C8, 0);
            for (pi = 0; pi < 768; pi++) outp(0x3C9, pal[pi]>>2);
            memcpy(g_backbuf, base_src, AG_SCREEN_PIXELS);
            _seq_draw_text_full(txt, font_idx, color_idx, eff_bg, pos_str, aln_str);
            _vga_flip();
            engine_wait_ms(50);
        }
        outp(0x3C8, 0);
        { int pi; for (pi = 0; pi < 768; pi++) outp(0x3C9, g_pal_raw[pi]>>2); }
    }

    /* Efecto typewriter */
    if (_str_eq(effect, "typewriter") && typewriter_speed > 0) {
        int total_chars = 0, shown = 0, i;
        u32 ms_per_char;
        char tw_buf[MAX_TEXT_LEN+1];
        const char* p;
        u8* base_src;

        for (p = txt; *p; p++) total_chars++;
        ms_per_char = typewriter_speed ? (1000u / typewriter_speed) : 50;
        base_src = bg_loaded ? g_seq_bg_tmp : g_bgbuf;

        while (shown <= total_chars) {
            for (i = 0; i < shown && i < MAX_TEXT_LEN; i++) tw_buf[i] = txt[i];
            tw_buf[shown < MAX_TEXT_LEN ? shown : MAX_TEXT_LEN] = '\0';
            memcpy(g_backbuf, base_src, AG_SCREEN_PIXELS);
            _seq_draw_text_full(tw_buf, font_idx, color_idx, eff_bg, pos_str, aln_str);
            _vga_flip();
            if (shown >= total_chars) break;
            engine_wait_ms(ms_per_char);
            shown++;
            if (kbhit()) { int k = getch(); if (k==27) shown = total_chars; }
        }
    }

    /* Loop principal — until se calcula en el primer frame para que el timer
     * arranque exactamente cuando el texto aparece en pantalla, no antes */
    {
        u8* base_src = bg_loaded ? g_seq_bg_tmp : g_bgbuf;
        int first_frame = 1;
        while (1) {
            memcpy(g_backbuf, base_src, AG_SCREEN_PIXELS);
            _seq_draw_text_full(txt, font_idx, color_idx, eff_bg, pos_str, aln_str);
            _vga_flip();
            if (first_frame) {
                until = duration_ms ? g_ticks_ms + duration_ms : 0;
                first_frame = 0;
            }
            if (duration_ms == 0) {
                if (kbhit()) { int k = getch(); if (k==27) break; }
            } else {
                if (until && g_ticks_ms >= until) break;
            }
        }
    }

    if (bg_loaded)
        memcpy(g_bgbuf, g_seq_bg_tmp, AG_SCREEN_PIXELS);
}

void engine_seq_scroll_text(const char* locale_key, const char* color,
                             const char* align, s16 speed,
                             s16 y_start, s16 y_end, s16 x_center, s16 angle) {
    (void)locale_key; (void)color; (void)align; (void)speed;
    (void)y_start; (void)y_end; (void)x_center; (void)angle;
}

void engine_seq_scroll_text_ex(const char* locale_key, u8 color_idx,
                                const char* align, s16 speed) {
    (void)locale_key; (void)color_idx; (void)align; (void)speed;
}

/* --- move_text: mueve texto de (x0,y0) a (x1,y1) a velocidad pixels/seg ----
 * bg_type: -1=pantalla actual, 0=color solido, 1=PCX de fondo
 * blocking: 1=esperar al destino, 0=lanzar y volver (para bloque paralelo)
 * --------------------------------------------------------------------------*/
void engine_seq_move_text(const char* locale_key, u8 font_idx, u8 color_idx,
                           s16 x0, s16 y0, s16 x1, s16 y1, s16 speed,
                           int bg_type, u8 bg_color, const char* bg_pcx_id,
                           u8 blocking) {
    const char* txt = engine_text(locale_key);
    s16 cx, cy;
    u32 prev_tick;
    /* Para movimiento diagonal: acumuladores en punto fijo (x256) */
    s32 fx, fy;   /* posicion en punto fijo */
    s32 vx, vy;   /* velocidad por tick en punto fijo */
    s16 total_dist, line_h;
    static u8 bg_buf[AG_SCREEN_PIXELS];
    static u8 pcx_tmp[AG_SCREEN_PIXELS];
    u8* bg_ptr = NULL;
    (void)blocking;

    /* Preparar fondo */
    DBG("move_text: bg_type=%d bg_pcx_id='%s'\n", bg_type, bg_pcx_id ? bg_pcx_id : "(null)");
    if (bg_type == 1 && bg_pcx_id && bg_pcx_id[0]) {
        u32 sz; u8* pcx = (u8*)engine_dat_load_gfx(bg_pcx_id, &sz);
        DBG("move_text: pcx load '%s' -> buf=%p sz=%u\n", bg_pcx_id, (void*)pcx, (unsigned)sz);
        if (pcx) {
            u16 w, h; int r;
            _pcx_decode(pcx, sz, pcx_tmp, &w, &h, 1);
            free(pcx);
            DBG("move_text: pcx decoded w=%u h=%u\n", (unsigned)w, (unsigned)h);
            for (r = 0; r < AG_SCREEN_H && r < (int)h; r++)
                memcpy(bg_buf + r*AG_SCREEN_W, pcx_tmp + r*AG_SCREEN_W, AG_SCREEN_W);
            for (r = (int)h; r < AG_SCREEN_H; r++)
                memset(bg_buf + r*AG_SCREEN_W, 1, AG_SCREEN_W);
            bg_ptr = bg_buf;
        }
    }

    if (!txt || !txt[0] || txt == locale_key) return;
    if (speed <= 0) speed = 60;

    line_h = (s16)(g_fonts[font_idx < FONT_COUNT ? font_idx : 0].gh + 1);

    /* Calcular vector de velocidad proporcional a la distancia */
    {
        s16 ddx = (s16)(x1 - x0), ddy = (s16)(y1 - y0);
        s16 adx = ddx < 0 ? -ddx : ddx;
        s16 ady = ddy < 0 ? -ddy : ddy;
        /* distancia diagonal: max(|dx|,|dy|) para mantener velocidad constante */
        total_dist = adx > ady ? adx : ady;
        if (total_dist == 0) total_dist = 1;
        /* velocidad en x e y proporcional: vx = speed * dx / dist */
        vx = (s32)speed * (s32)ddx * 256 / (s32)total_dist;
        vy = (s32)speed * (s32)ddy * (s32)256 / (s32)total_dist;
    }

    fx = (s32)x0 * 256;
    fy = (s32)y0 * 256;
    cx = x0; cy = y0;
    prev_tick = g_ticks_ms;

    for (;;) {
        u32 now     = g_ticks_ms;
        u32 elapsed = now - prev_tick;
        const char* p;
        s16 lx, ly;

        /* Dibujar fondo: PCX si hay, color solido si no */
        if (bg_ptr) {
            memcpy(g_backbuf, bg_ptr, AG_SCREEN_PIXELS);
        } else {
            memset(g_backbuf, bg_color, AG_SCREEN_PIXELS);
        }
        lx = cx; ly = cy;
        p  = txt;
        while (*p) {
            /* Extraer una linea hasta \n o fin */
            char line[128];
            int  li = 0;
            while (*p && *p != '\n' && *p != '\r' && li < 127)
                line[li++] = *p++;
            line[li] = '\0';
            if (*p == '\r') p++;
            if (*p == '\n') p++;
            if (li > 0) engine_draw_text(lx, ly, font_idx, color_idx, 0, line);
            ly = (s16)(ly + line_h);
        }
        _vga_flip();

        /* Comprobar llegada al destino */
        {
            s16 adx = (s16)(x1 - cx); if (adx < 0) adx = -adx;
            s16 ady = (s16)(y1 - cy); if (ady < 0) ady = -ady;
            if (adx <= 1 && ady <= 1) break;
        }

        if (elapsed == 0) continue;
        prev_tick = now;

        /* Avanzar posicion en punto fijo */
        fx += vx * (s32)elapsed / 1000;
        fy += vy * (s32)elapsed / 1000;
        cx = (s16)(fx / 256);
        cy = (s16)(fy / 256);

        /* Snap si pasamos el destino */
        {
            s16 ox = (s16)(x1 - x0), oy = (s16)(y1 - y0);
            s16 nx = (s16)(cx - x0), ny = (s16)(cy - y0);
            /* comprobar si hemos cruzado el destino */
            if ((ox >= 0 ? nx >= ox : nx <= ox) &&
                (oy >= 0 ? ny >= oy : ny <= oy)) {
                cx = x1; cy = y1; fx = (s32)x1*256; fy = (s32)y1*256;
            }
        }

        if (!g_running) break;
        if (kbhit()) { int k = getch(); if (k==27) break; }
    }
}


void engine_seq_move_text_nb(const char* locale_key, u8 font_idx, u8 color_idx,
                              s16 x0, s16 y0, s16 x1, s16 y1, s16 speed,
                              int bg_type, u8 bg_color, const char* bg_pcx_id) {
    /* Modo no bloqueante desactivado — llamar bloqueante */
    engine_seq_move_text(locale_key, font_idx, color_idx,
                         x0, y0, x1, y1, speed,
                         bg_type, bg_color, bg_pcx_id, 1);
}


void engine_clear_text(void) {
    g_action_text[0] = '\0';
    g_text_until_ms  = 0;
}

/* ===========================================================================
 * S15 - AUDIO
 * Implementación real en agemki_audio.c (AIL V2.14).
 * Las funciones play/stop/volume/tempo se definen allí.
 * Compilar y enlazar agemki_audio.c junto a este fichero.
 * =========================================================================== */
#include "agemki_audio.h"

#define MENU_COL_BG  g_menu_col_bg
#define MENU_COL_BTN g_menu_col_btn
#define MENU_COL_SEL g_menu_col_sel
#define MENU_COL_BRD g_menu_col_brd
#define MENU_COL_TXT g_menu_col_txt
#define MENU_COL_ACT g_menu_col_act

/* ===========================================================================
 * S16 - DIALOGOS
 * =========================================================================== */

/* Panel de opciones: lineas precalculadas con word-wrap y scroll.
 * DLG_LINE_H: pixels por linea | DLG_VIS: lineas visibles | DLG_COLS: chars/linea */
#define DLG_LINE_H   10
#define DLG_VIS      5            /* floor(UI_H(56) / DLG_LINE_H(10)) = 5 */
#define DLG_COLS     35           /* (320-20)/8 = 37; dejar margen para scroll */
#define DLG_MAX_TOT  (MAX_DIALOGUE_OPTS * 4)

typedef struct { int opt_idx; char text[40]; } DlgLine;

static int                    _dlg_panel_active = 0;
static const DialogueNode*    _dlg_panel_node   = NULL;
static int                    _dlg_panel_cval[MAX_DIALOGUE_OPTS];
static int                    _dlg_panel_cnv    = 0;
/* hov: -1=nada  >=0=opt_idx  -2=scroll_up  -3=scroll_dn */
static int                    _dlg_panel_hov    = -1;
static DlgLine                _dlg_lines[DLG_MAX_TOT];
static int                    _dlg_total_lines  = 0;
static int                    _dlg_scroll       = 0;

/* Precalcula lineas con word-wrap para todas las opciones visibles */
static void _dlg_build_lines(void) {
    int i; char wb[MAX_TEXT_LEN+1];
    _dlg_total_lines = 0;
    for (i = 0; i < _dlg_panel_cnv; i++) {
        const char* raw = engine_text(_dlg_panel_node->options[_dlg_panel_cval[i]].text_key);
        const char* p; int li = 0;
        _word_wrap(raw, wb, MAX_TEXT_LEN+1, DLG_COLS);
        p = wb;
        while (*p && _dlg_total_lines < DLG_MAX_TOT && li < 4) {
            DlgLine* dl = &_dlg_lines[_dlg_total_lines++];
            int tl = 0;
            dl->opt_idx = i;
            while (*p && *p != '\n' && tl < 39) dl->text[tl++] = *p++;
            dl->text[tl] = '\0';
            if (*p == '\n') p++;
            li++;
        }
    }
}

static void _dlg_panel_draw(void) {
    int _j, _vis;
    if (!_dlg_panel_active || !_dlg_panel_node) return;
    _vis = _dlg_total_lines - _dlg_scroll;
    if (_vis > DLG_VIS) _vis = DLG_VIS;
    _fill_rect(0, (s16)UI_Y, (s16)AG_SCREEN_W, (s16)UI_H, g_dlg_col_bg);
    _draw_rect_border(0, (s16)UI_Y, (s16)AG_SCREEN_W, (s16)UI_H, g_dlg_col_brd);
    for (_j = 0; _j < _vis; _j++) {
        int _li = _dlg_scroll + _j;
        s16 _ry = (s16)(UI_Y + _j * DLG_LINE_H);
        if (_dlg_lines[_li].opt_idx == _dlg_panel_hov)
            _fill_rect(1, _ry, (s16)(AG_SCREEN_W - 14), (s16)DLG_LINE_H, g_dlg_col_sel);
        engine_draw_text((s16)7, (s16)(_ry+2), VERB_FONT, 0,              0, _dlg_lines[_li].text);
        engine_draw_text((s16)6, (s16)(_ry+1), VERB_FONT, g_dlg_col_txt,  0, _dlg_lines[_li].text);
    }
    /* Indicadores de scroll en la columna derecha */
    if (_dlg_scroll > 0)
        engine_draw_text((s16)(AG_SCREEN_W-10), (s16)(UI_Y+1),
                         VERB_FONT, g_dlg_col_txt, 0, "^");
    if (_dlg_scroll + DLG_VIS < _dlg_total_lines)
        engine_draw_text((s16)(AG_SCREEN_W-10), (s16)(UI_Y+(_vis-1)*DLG_LINE_H+1),
                         VERB_FONT, g_dlg_col_txt, 0, "v");
}

void engine_run_dialogue(const DialogueNode* nodes, int n, const char* start_id) {
    const DialogueNode* cur = NULL;
    int i;
    for (i = 0; i < n; i++)
        if (_str_eq(nodes[i].id, start_id)) { cur = &nodes[i]; break; }

    DBG("run_dialogue: start=\'%s\' found=%d n=%d\n", start_id, cur!=NULL, n);
    do { _mouse_poll(); } while (g_mouse.buttons);
    g_script_running = 1;

    while (cur && g_running) {
        int li;
        /* Aplicar animacion y direccion + mostrar globos para todas las lineas */
        _overlay_clear_all();
        g_overlay_click_seen = 0;

        for (li = 0; li < cur->num_lines; li++) {
            const DialogueLine* ln = &cur->lines[li];
            /* Saltar línea si char_filter no coincide con el protagonista activo */
            if (ln->char_filter && ln->char_filter[0]) {
                const char* _pid = (g_char_count > 0) ? g_chars[g_protagonist].id : "";
                if (!_str_eq(ln->char_filter, _pid)) continue;
            }
            const char* txt = engine_text(ln->text_key);
            DBG("dlg line %d: speaker=\'%s\' txt=\'%s\'\n", li, ln->speaker_id, txt ? txt : "(null)");

            /* Animacion y orientacion.
             * Formato animation: "rol" o "pcxid|frames|fps|fw" (animacion personalizada) */
            if (ln->speaker_id[0]) {
                if (ln->animation && ln->animation[0]) {
                    const char* _pipe = ln->animation;
                    while (*_pipe && *_pipe != '|') _pipe++;
                    if (*_pipe == '|') {
                        /* Formato pcxid|frames|fps|fw */
                        char _pid[32]; int _fr=1, _fp=8, _fw=0;
                        int _plen = (int)(_pipe - ln->animation);
                        if (_plen > 31) _plen = 31;
                        memcpy(_pid, ln->animation, (u32)_plen); _pid[_plen] = '\0';
                        { const char* _p = _pipe + 1;
                          _fr = 0; while (*_p>='0'&&*_p<='9') _fr=_fr*10+(*_p++)-'0'; if (*_p=='|') _p++;
                          _fp = 0; while (*_p>='0'&&*_p<='9') _fp=_fp*10+(*_p++)-'0'; if (*_p=='|') _p++;
                          _fw = 0; while (*_p>='0'&&*_p<='9') _fw=_fw*10+(*_p++)-'0';
                        }
                        engine_set_anim_pcx(ln->speaker_id, _pid, _fr, _fp, _fw);
                    } else {
                        engine_seq_set_anim(ln->speaker_id, ln->animation, 0, 1, 0);
                    }
                }
                /* direction = animacion final: se aplica DESPUES del wait, no aqui */
            }

            if (!txt || !txt[0] || txt == ln->text_key) continue;

            /* Word-wrap antes de renderizar */
            { static char _dlg_wb[MAX_TEXT_LEN+1];
              _word_wrap(txt, _dlg_wb, MAX_TEXT_LEN+1, 38);
              txt = _dlg_wb; }

            /* Calcular posicion X base y color */
            s16 ox = -1, oy = 10;
            u8 sc = 15;
            if (ln->speaker_id[0]) {
                int ci;
                for (ci = 0; ci < g_char_count; ci++) {
                    if (_str_eq(g_chars[ci].id, ln->speaker_id)) {
                        /* X: base en el centro del personaje (se ajusta por linea) */
                        ox = g_chars[ci].x;
                        /* Y: mitad entre la cabeza del sprite y y=0 (John Carmack style).
                         * char_top = pie - altura_renderizada; oy = char_top / 2 */
                        { s16 char_h = (g_chars[ci].dec_h > 0) ? (s16)g_chars[ci].dec_h : 40;
                          u8 pct = ((u16)g_chars[ci].y < 200u) ? g_scale_lut[(u8)g_chars[ci].y] : 100;
                          if (pct > 0 && pct < 100)
                              char_h = (s16)((u32)char_h * pct / 100);
                          { s16 char_top = (s16)(g_chars[ci].y - char_h);
                            if (char_top < 0) char_top = 0;
                            oy = (s16)(char_top / 2);
                          }
                        }
                        if (oy < 4) oy = 4;
                        sc = g_chars[ci].subtitle_color ? g_chars[ci].subtitle_color : 15;
                        break;
                    }
                }
            }
            /* Renderizar texto con soporte de saltos de linea \n */
            { const char* _p = txt;
              s16 _ly = oy;
              char _lb[MAX_TEXT_LEN + 1];
              while (_p && *_p) {
                  const char* _nl = _p;
                  int _ll = 0;
                  while (*_nl && *_nl != '\n' && _ll < MAX_TEXT_LEN) { _nl++; _ll++; }
                  if (_ll > 0) {
                      memcpy(_lb, _p, (u32)_ll); _lb[_ll] = '\0';
                      { s16 _tw = engine_text_width(VERB_FONT, _lb);
                        s16 _lox = (ox < 0)
                            ? (s16)((AG_SCREEN_W - _tw) / 2)
                            : (s16)(ox - _tw / 2);
                        if (_lox < 2) _lox = 2;
                        if (_lox + _tw > AG_SCREEN_W - 2) _lox = (s16)(AG_SCREEN_W - _tw - 2);
                        _overlay_add(_lb, sc, _lox, _ly, g_ticks_ms + 3000, 1);
                      }
                      _ly += (s16)(VERB_FONT_H + 2);
                  }
                  if (*_nl == '\n') _p = _nl + 1;
                  else break;
              }
            }
        }

        if (cur->num_lines == 0) {
            /* Nodo sin lineas (action/branch) — procesar y continuar */
        } else {
            /* Esperar a que el jugador avance (con animaciones corriendo) */
            u32 t0 = g_ticks_ms;
            while (g_running && _overlays_active()) {
                if (g_ticks_ms - t0 > 5000) break;
                engine_flip();
                if (!engine_process_input()) break;
            }
            _overlay_clear_all();
            g_overlay_click_seen = 0;
            /* Aplicar animacion final de cada linea (campo direction reutilizado) */
            { int _fli;
              for (_fli = 0; _fli < cur->num_lines; _fli++) {
                  const DialogueLine* _fl = &cur->lines[_fli];
                  if (!_fl->speaker_id[0] || !_fl->direction || !_fl->direction[0]) continue;
                  { const char* _fp2 = _fl->direction;
                    while (*_fp2 && *_fp2 != '|') _fp2++;
                    if (*_fp2 == '|') {
                        char _pid2[32]; int _fr2=1, _fp3=8, _fw2=0;
                        int _pl2 = (int)(_fp2 - _fl->direction);
                        if (_pl2 > 31) _pl2 = 31;
                        memcpy(_pid2, _fl->direction, (u32)_pl2); _pid2[_pl2] = '\0';
                        { const char* _p2 = _fp2 + 1;
                          _fr2=0; while(*_p2>='0'&&*_p2<='9') _fr2=_fr2*10+(*_p2++)-'0'; if(*_p2=='|')_p2++;
                          _fp3=0; while(*_p2>='0'&&*_p2<='9') _fp3=_fp3*10+(*_p2++)-'0'; if(*_p2=='|')_p2++;
                          _fw2=0; while(*_p2>='0'&&*_p2<='9') _fw2=_fw2*10+(*_p2++)-'0';
                        }
                        engine_set_anim_pcx(_fl->speaker_id, _pid2, _fr2, _fp3, _fw2);
                    } else {
                        engine_set_anim(_fl->speaker_id, _fl->direction);
                    }
                  }
              }
            }
        }

        if (cur->num_options == 0) break;

        /* Nodo lineal (1 opcion sin texto): avanzar automaticamente */
        if (cur->num_options == 1 && (!cur->options[0].text_key || !cur->options[0].text_key[0])) {
            const char* next = cur->options[0].next_node_id;
            if (!next || !next[0]) break;
            cur = NULL;
            for (i = 0; i < n; i++)
                if (_str_eq(nodes[i].id, next)) { cur = &nodes[i]; break; }
            continue;
        }

        /* Varias opciones: panel de seleccion via pre-flip hook — dibuja sobre backbuf
         * ANTES de _vga_flip para evitar el double-write que causaba parpadeo. */
        {
            int _cnv = 0, _chosen = -1;

            /* Filtrar opciones por condicion y char_filter */
            { const char* _opid = (g_char_count > 0) ? g_chars[g_protagonist].id : "";
            for (i = 0; i < cur->num_options; i++) {
                if (!cur->options[i].text_key || !cur->options[i].text_key[0]) continue;
                if (cur->options[i].char_filter && cur->options[i].char_filter[0] &&
                    !_str_eq(cur->options[i].char_filter, _opid)) continue;
                if (!cur->options[i].condition[0] ||
                    engine_eval_cond(cur->options[i].condition))
                    _dlg_panel_cval[_cnv++] = i;
            }
            }
            _dlg_panel_cnv    = _cnv;
            _dlg_panel_node   = cur;
            _dlg_panel_hov    = -1;
            _dlg_scroll       = 0;
            _dlg_panel_active = 1;
            _dlg_build_lines();
            g_pre_flip_fn     = _dlg_panel_draw;

            while (g_running && _chosen < 0 && _cnv > 0) {
                int _vis = _dlg_total_lines - _dlg_scroll;
                if (_vis > DLG_VIS) _vis = DLG_VIS;

                /* Hover: distingue opcion, scroll-up (-2) y scroll-dn (-3) */
                if ((int)g_mouse.y >= UI_Y && (int)g_mouse.y < UI_Y + UI_H) {
                    int _hi  = ((int)g_mouse.y - UI_Y) / DLG_LINE_H;
                    int _li  = _dlg_scroll + _hi;
                    int _mx  = (int)g_mouse.x;
                    if (_hi >= 0 && _hi < _vis && _li < _dlg_total_lines) {
                        /* Zona scroll (derecha 14px) en primera/ultima fila visible */
                        if (_mx >= AG_SCREEN_W - 14 && _hi == 0 && _dlg_scroll > 0)
                            _dlg_panel_hov = -2;
                        else if (_mx >= AG_SCREEN_W - 14 && _hi == _vis - 1 &&
                                 _dlg_scroll + DLG_VIS < _dlg_total_lines)
                            _dlg_panel_hov = -3;
                        else
                            _dlg_panel_hov = _dlg_lines[_li].opt_idx;
                    } else {
                        _dlg_panel_hov = -1;
                    }
                } else {
                    _dlg_panel_hov = -1;
                }

                engine_flip();
                if (!engine_process_input()) break;

                if (g_mouse.buttons & 1) {
                    if (_dlg_panel_hov >= 0) {
                        _chosen = _dlg_panel_cval[_dlg_panel_hov];
                        while (g_mouse.buttons) _mouse_poll();
                    } else if (_dlg_panel_hov == -2) {
                        if (_dlg_scroll > 0) _dlg_scroll--;
                        while (g_mouse.buttons) _mouse_poll();
                    } else if (_dlg_panel_hov == -3) {
                        if (_dlg_scroll + DLG_VIS < _dlg_total_lines) _dlg_scroll++;
                        while (g_mouse.buttons) _mouse_poll();
                    }
                }
            }

            g_pre_flip_fn     = NULL;
            _dlg_panel_active = 0;
            _dlg_panel_node   = NULL;

            if (_cnv == 0 || _chosen < 0) break;
            { const char* _nx = cur->options[_chosen].next_node_id;
              if (!_nx || !_nx[0]) break;
              cur = NULL;
              for (i = 0; i < n; i++)
                  if (_str_eq(nodes[i].id, _nx)) { cur = &nodes[i]; break; }
            }
        }
    }
    _overlay_clear_all();
    engine_clear_text();
    /* Consumir botones pendientes: evita que el click que disparo el dialogo
     * se procese como accion de movimiento al volver al game loop */
    do { _mouse_poll(); } while (g_mouse.buttons);
    g_script_running = 0;
    DBG("run_dialogue: fin\n");
}

/* ===========================================================================
 * S17 - HANDLERS DE EVENTOS
 * =========================================================================== */

/* Helper interno: busca handler verbo+obj con prioridad char-específico > genérico.
 * is_inv: 0=escena, 1=inventario. Ignora obj2_id (usar_con usa _find_usar_con_handler). */
static int _find_verb_handler(const char* verb_id, const char* obj_id, int is_inv) {
    int i, generic = -1;
    const char* pid = (g_char_count > 0) ? g_chars[g_protagonist].id : "";
    for (i = 0; i < g_verb_handler_count; i++) {
        VerbHandler* h = &g_verb_handlers[i];
        if (!h->fn) continue;
        if (!_str_eq(h->verb_id, verb_id)) continue;
        if (!_str_eq(h->obj_id,  obj_id))  continue;
        if (h->is_inv != is_inv) continue;
        if (h->char_id[0]) {
            if (_str_eq(h->char_id, pid)) return i; /* char match exacto — máxima prioridad */
        } else {
            if (generic < 0) generic = i; /* primer genérico */
        }
    }
    return generic;
}

void engine_on_verb_object(const char* verb_id, const char* obj_id,
                           void (*handler)(void)) {
    if (g_verb_handler_count >= MAX_VERB_HANDLERS) return;
    if (!verb_id || !verb_id[0] || !obj_id || !obj_id[0]) return;
    _strlcpy(g_verb_handlers[g_verb_handler_count].verb_id, verb_id, 32);
    _strlcpy(g_verb_handlers[g_verb_handler_count].obj_id,  obj_id,  32);
    g_verb_handlers[g_verb_handler_count].obj2_id[0] = '\0';
    g_verb_handlers[g_verb_handler_count].is_inv = 0;
    g_verb_handlers[g_verb_handler_count].char_id[0] = '\0';
    g_verb_handlers[g_verb_handler_count].fn = handler;
    DBG("on_verb_object[%d]: verb='%s' obj='%s' fn=%s\n",
        g_verb_handler_count, verb_id, obj_id, handler ? "custom" : "NULL(pickup)");
    g_verb_handler_count++;
}

void engine_on_verb_object_char(const char* verb_id, const char* obj_id,
                                const char* char_id, void (*handler)(void)) {
    if (g_verb_handler_count >= MAX_VERB_HANDLERS) return;
    if (!verb_id || !verb_id[0] || !obj_id || !obj_id[0]) return;
    _strlcpy(g_verb_handlers[g_verb_handler_count].verb_id, verb_id, 32);
    _strlcpy(g_verb_handlers[g_verb_handler_count].obj_id,  obj_id,  32);
    g_verb_handlers[g_verb_handler_count].obj2_id[0] = '\0';
    g_verb_handlers[g_verb_handler_count].is_inv = 0;
    _strlcpy(g_verb_handlers[g_verb_handler_count].char_id, char_id ? char_id : "", 32);
    g_verb_handlers[g_verb_handler_count].fn = handler;
    g_verb_handler_count++;
}

/* Verbo + objeto inventario */
void engine_on_verb_inv(const char* verb_id, const char* inv_obj_id,
                        void (*handler)(void)) {
    if (g_verb_handler_count >= MAX_VERB_HANDLERS) return;
    if (!verb_id || !verb_id[0] || !inv_obj_id || !inv_obj_id[0]) return;
    _strlcpy(g_verb_handlers[g_verb_handler_count].verb_id, verb_id, 32);
    _strlcpy(g_verb_handlers[g_verb_handler_count].obj_id,  inv_obj_id, 32);
    g_verb_handlers[g_verb_handler_count].obj2_id[0] = '\0';
    g_verb_handlers[g_verb_handler_count].is_inv = 1;
    g_verb_handlers[g_verb_handler_count].char_id[0] = '\0';
    g_verb_handlers[g_verb_handler_count].fn = handler;
    DBG("on_verb_inv[%d]: verb='%s' inv='%s'\n",
        g_verb_handler_count, verb_id, inv_obj_id);
    g_verb_handler_count++;
}

void engine_on_verb_inv_char(const char* verb_id, const char* inv_obj_id,
                             const char* char_id, void (*handler)(void)) {
    if (g_verb_handler_count >= MAX_VERB_HANDLERS) return;
    if (!verb_id || !verb_id[0] || !inv_obj_id || !inv_obj_id[0]) return;
    _strlcpy(g_verb_handlers[g_verb_handler_count].verb_id, verb_id, 32);
    _strlcpy(g_verb_handlers[g_verb_handler_count].obj_id,  inv_obj_id, 32);
    g_verb_handlers[g_verb_handler_count].obj2_id[0] = '\0';
    g_verb_handlers[g_verb_handler_count].is_inv = 1;
    _strlcpy(g_verb_handlers[g_verb_handler_count].char_id, char_id ? char_id : "", 32);
    g_verb_handlers[g_verb_handler_count].fn = handler;
    g_verb_handler_count++;
}

/* Usar objeto inventario CON otro objeto (inv, escena o personaje). */
void engine_on_usar_con(const char* inv_obj_id, const char* target_id,
                        void (*handler)(void), int require_both_inv) {
    if (g_verb_handler_count >= MAX_VERB_HANDLERS) return;
    if (!inv_obj_id || !inv_obj_id[0]) return;
    _strlcpy(g_verb_handlers[g_verb_handler_count].verb_id, "usar_con", 32);
    _strlcpy(g_verb_handlers[g_verb_handler_count].obj_id,  inv_obj_id, 32);
    _strlcpy(g_verb_handlers[g_verb_handler_count].obj2_id, target_id ? target_id : "", 32);
    g_verb_handlers[g_verb_handler_count].is_inv = 1;
    g_verb_handlers[g_verb_handler_count].require_both_inv = require_both_inv ? 1 : 0;
    g_verb_handlers[g_verb_handler_count].char_id[0] = '\0';
    g_verb_handlers[g_verb_handler_count].fn = handler;
    g_verb_handler_count++;
}

void engine_on_usar_con_char(const char* inv_obj_id, const char* target_id,
                             const char* char_id, void (*handler)(void), int require_both_inv) {
    if (g_verb_handler_count >= MAX_VERB_HANDLERS) return;
    if (!inv_obj_id || !inv_obj_id[0]) return;
    _strlcpy(g_verb_handlers[g_verb_handler_count].verb_id, "usar_con", 32);
    _strlcpy(g_verb_handlers[g_verb_handler_count].obj_id,  inv_obj_id, 32);
    _strlcpy(g_verb_handlers[g_verb_handler_count].obj2_id, target_id ? target_id : "", 32);
    g_verb_handlers[g_verb_handler_count].is_inv = 1;
    g_verb_handlers[g_verb_handler_count].require_both_inv = require_both_inv ? 1 : 0;
    _strlcpy(g_verb_handlers[g_verb_handler_count].char_id, char_id ? char_id : "", 32);
    g_verb_handlers[g_verb_handler_count].fn = handler;
    g_verb_handler_count++;
}

const char* engine_get_dar_target(void) { return g_dar_target; }

void engine_set_give_verb(const char* verb_id) {
    int i;
    for (i = 0; i < g_verb_count; i++)
        if (_str_eq(g_verbs[i].id, verb_id)) { g_verbs[i].is_give = 1; return; }
}

void engine_on_object_click(const char* obj_id, void (*handler)(void)) {
    if (g_click_count >= MAX_CLICK_HANDLERS) return;
    _strlcpy(g_click_handlers[g_click_count].obj_id, obj_id, 32);
    g_click_handlers[g_click_count].fn = handler;
    g_click_count++;
}

void engine_on_game_start(void (*handler)(void))  { g_on_game_start  = handler; }
void engine_on_room_load(void (*handler)(void))   { g_on_room_load   = handler; }
void engine_on_room_enter(void (*handler)(void))  { g_on_room_enter  = handler; }
void engine_on_room_exit(void (*handler)(void))   { g_on_room_exit   = handler; }
void engine_block_exit(void)                      { g_exit_blocked   = 1; }
const char* engine_get_cur_entry(void)            { return g_cur_entry; }
int engine_cur_entry_is(const char* id)           { return _str_eq(g_cur_entry, id); }

void engine_on_sequence_end(const char* seq_id, void (*handler)(void)) {
    if (g_seq_end_count >= MAX_SEQ_END) return;
    _strlcpy(g_seq_end_handlers[g_seq_end_count].seq_id, seq_id, 32);
    g_seq_end_handlers[g_seq_end_count].fn = handler;
    g_seq_end_count++;
}

void engine_set_verbset(const char* verbset_id) {
    DBG("engine_set_verbset: '%s'\n", verbset_id ? verbset_id : "NULL");
    _strlcpy(g_verbset_id, verbset_id, 32);
    _load_verbset_from_dat(verbset_id);
    /* Restablecer accion a verbo de movimiento */
    { int _vi;
      _strlcpy(g_action_text, "Walk", sizeof(g_action_text));
      for (_vi = 0; _vi < g_verb_count; _vi++)
          if (g_verbs[_vi].is_movement) {
              _strlcpy(g_action_text, g_verbs[_vi].label, sizeof(g_action_text));
              break;
          }
      g_selected_verb[0] = '\0';
    }
}

/* ===========================================================================
 * S18 - INPUT
 * =========================================================================== */

/* Devuelve el id del objeto bajo el cursor del raton, "" si ninguno. */
static const char* _hit_object(s16 mx, s16 my) {
    int i;
    for (i = 0; i < g_obj_count; i++) {
        Obj* o = &g_objects[i];
        s16 fw, fh;
        if (!o->visible || !o->detectable) continue;
        /* Usar dimensiones reales del sprite si están cacheadas; fallback conservador */
        if (o->dec_w > 0 && o->dec_h > 0) {
            u16 full_fw = (o->anim_frames > 1 && o->anim_fw > 0)
                          ? o->anim_fw
                          : (o->anim_frames > 1 ? (u16)(o->dec_w / o->anim_frames) : o->dec_w);
            fw = (s16)(full_fw / 2);
            fh = (s16)o->dec_h;
        } else {
            fw = 12; fh = 24; /* fallback hasta primer render */
        }
        if (mx >= o->x - fw && mx <= o->x + fw &&
            my >= o->y - fh  && my <= o->y)
            return o->obj_id;
    }
    return "";
}

/* Devuelve el id del primer personaje no-protagonista bajo el cursor (excluyendo al protagonista). */
static const char* _hit_char(s16 mx, s16 my) {
    int i;
    for (i = 0; i < g_char_count; i++) {
        Char* c = &g_chars[i];
        s16 hw, hh;
        if (i == g_protagonist || !c->visible) continue;
        /* Escala igual que _render_char_item */
        u8 _pct = ((u16)c->y < 200u) ? g_scale_lut[(u8)c->y] : (u8)_get_scale_pct(c->y);
        if (_pct < 10) _pct = 100; /* sin zonas definidas → 1:1 */
        if (c->dec_w > 0 && c->dec_h > 0) {
            u16 _af = c->anims[c->cur_anim].frames > 1 ? c->anims[c->cur_anim].frames : 1;
            hw = (s16)((u32)(c->dec_w / _af) * _pct / 100 / 2);
            hh = (s16)((u32)c->dec_h      * _pct / 100);
        } else {
            /* Fallback: usar fw del slot de animación actual o 32px */
            u16 _fw = c->anims[c->cur_anim].fw > 0 ? c->anims[c->cur_anim].fw : 32u;
            hw = (s16)((u32)_fw * _pct / 100 / 2);
            hh = (s16)((u32)(_fw * 2u) * _pct / 100);
        }
        if (hw < 6)  hw = 6;
        if (hh < 12) hh = 12;
        if (mx >= c->x - hw && mx <= c->x + hw &&
            my >= c->y - hh  && my <= c->y)
            return c->id;
    }
    return "";
}

/* Comprueba si el protagonista ha llegado al exit al que caminó explícitamente.
 * Solo actúa si el jugador usó "Ir a" + click en salida (g_pending_exit_id). */
static void _check_exits(void) {
    int i;
    if (!g_char_count || !g_pending_exit_id[0]) return;
    s16 px = g_chars[g_protagonist].x;
    s16 py = g_chars[g_protagonist].y;
    /* Tolerancia = ancho de una celda + margen vertical de media celda.
     * El pathfinder solo llega al centro de celda, que puede quedar hasta
     * g_grid_cell_w/2 px fuera del borde del trigger zone. */
    s16 tol_x = (s16)(g_grid_cell_w);
    s16 tol_y = 0;
    for (i = 0; i < g_exit_count; i++) {
        Rect* tz = &g_exits[i].tz;
        if (!_str_eq(g_exits[i].id, g_pending_exit_id)) continue;
        if (px >= tz->x - tol_x && px <= tz->x + tz->w + tol_x &&
            py >= tz->y - tol_y && py <= tz->y + tz->h + tol_y) {
            g_pending_exit_id[0] = '\0';
            engine_change_room(g_exits[i].target_room, g_exits[i].target_entry);
            return;
        }
    }
}

/* ===========================================================================
 * S_MENU - MENÚ IN-GAME (ESC)
 * Overlay azul (paleta 16-31), 4 opciones: Continuar / Nueva partida /
 * Configuración de sonido / Salir
 * =========================================================================== */

/* Dibuja un rectángulo relleno en el backbuffer */
static void _fill_rect(s16 x, s16 y, s16 w, s16 h, u8 col) {
    s16 row, cx;
    for (row = y; row < y + h; row++) {
        if (row < 0 || row >= AG_SCREEN_H) continue;
        for (cx = x; cx < x + w; cx++) {
            if (cx < 0 || cx >= AG_SCREEN_W) continue;
            g_backbuf[row * AG_SCREEN_W + cx] = col;
        }
    }
}

/* Dibuja borde de un rectángulo (1px) */
static void _draw_rect_border(s16 x, s16 y, s16 w, s16 h, u8 col) {
    s16 i;
    for (i = x; i < x + w; i++) {
        if (i >= 0 && i < AG_SCREEN_W) {
            if (y >= 0 && y < AG_SCREEN_H)         g_backbuf[y * AG_SCREEN_W + i] = col;
            if (y+h-1 >= 0 && y+h-1 < AG_SCREEN_H) g_backbuf[(y+h-1)*AG_SCREEN_W + i] = col;
        }
    }
    for (i = y; i < y + h; i++) {
        if (i >= 0 && i < AG_SCREEN_H) {
            if (x >= 0 && x < AG_SCREEN_W)         g_backbuf[i * AG_SCREEN_W + x] = col;
            if (x+w-1 >= 0 && x+w-1 < AG_SCREEN_W) g_backbuf[i*AG_SCREEN_W + x+w-1] = col;
        }
    }
}

#define MENU_ITEMS    6

/* Claves de locale para el menú */
static const char* g_menu_keys[MENU_ITEMS] = {
    "menu.continuar",
    "menu.nueva_partida",
    "menu.guardar_partida",
    "menu.restaurar_partida",
    "menu.configuracion",
    "menu.salir"
};

/* Fallbacks por si el locale no tiene la clave */
static const char* g_menu_fallbacks[MENU_ITEMS] = {
    "Continuar",
    "Nueva partida",
    "Guardar partida",
    "Restaurar partida",
    "Configuracion",
    "Salir a DOS"
};

static const char* _menu_label(int i) {
    const char* t = engine_text(g_menu_keys[i]);
    if (!t || !t[0] || t == g_menu_keys[i]) return g_menu_fallbacks[i];
    return t;
}

#define MENU_BTN_MAXW  180  /* ancho máximo de botón */
#define MENU_BTN_MINW   80  /* ancho mínimo */
#define MENU_BTN_PAD    10  /* padding horizontal */

static void _menu_draw(int sel) {
    int i;
    s16 ox, oy, ow, oh, btn_w, bx;
    s16 bh = 16, bpad = 3;

    /* Calcular ancho del botón más ancho (máx 22 chars visible) */
    btn_w = MENU_BTN_MINW;
    for (i = 0; i < MENU_ITEMS; i++) {
        s16 tw = engine_text_width(FONT_SMALL, _menu_label(i)) + MENU_BTN_PAD * 2;
        if (tw > btn_w) btn_w = tw;
    }
    if (btn_w > MENU_BTN_MAXW) btn_w = MENU_BTN_MAXW;

    ow = (s16)(btn_w + 20);           /* panel = botón + margen */
    oh = (s16)(22 + MENU_ITEMS * (bh + bpad) + 6);
    ox = (s16)((AG_SCREEN_W - ow) / 2);
    oy = (s16)((UI_Y - oh) / 2);      /* centrar en la zona de juego */

    /* Overlay dithered */
    for (i = 0; i < AG_SCREEN_PIXELS; i++) {
        if (((i % AG_SCREEN_W) + (i / AG_SCREEN_W)) & 1)
            g_backbuf[i] = MENU_COL_BG;
    }

    /* Panel */
    _fill_rect(ox, oy, ow, oh, MENU_COL_BG);
    _draw_rect_border(ox, oy, ow, oh, MENU_COL_BRD);
    _draw_rect_border((s16)(ox+1), (s16)(oy+1), (s16)(ow-2), (s16)(oh-2), (u8)(MENU_COL_BG+4));

    /* Título */
    _draw_text_centered(ox, (s16)(ox+ow), (s16)(oy+6), FONT_SMALL, MENU_COL_TXT, 0,
                        engine_text("menu.titulo") && engine_text("menu.titulo") != (const char*)"menu.titulo"
                        ? engine_text("menu.titulo") : "MENU");

    /* Botones */
    for (i = 0; i < MENU_ITEMS; i++) {
        s16 bx2 = (s16)(ox + (ow - btn_w) / 2);
        bx = (s16)(oy + 22 + i * (bh + bpad));
        {
            u8 btn_col = (i == sel) ? MENU_COL_SEL : MENU_COL_BTN;
            _fill_rect(bx2, bx, btn_w, bh, btn_col);
            _draw_rect_border(bx2, bx, btn_w, bh, MENU_COL_BRD);
            _draw_text_centered(bx2, (s16)(bx2 + btn_w),
                                (s16)(bx + bh/2 - 3),
                                FONT_SMALL, MENU_COL_TXT, 0,
                                _menu_label(i));
        }
    }
    _vga_flip();
}

/* Devuelve: 0=continuar, 1=nueva partida, 2=sonido, 3=salir */
static int _menu_run(void) {
    int sel = 0;
    int confirmed = 0;
    static u8 saved[AG_SCREEN_PIXELS];
    memcpy(saved, g_backbuf, AG_SCREEN_PIXELS);

    _menu_draw(sel);

    while (1) {
        int k;
        _mouse_poll();
        {
            /* Recalcular geometría igual que _menu_draw */
            s16 btn_w = MENU_BTN_MINW;
            s16 bh = 16, bpad = 3, ow, oh, ox, oy, i;
            for (i = 0; i < MENU_ITEMS; i++) {
                s16 tw = (s16)(engine_text_width(FONT_SMALL, _menu_label(i)) + MENU_BTN_PAD * 2);
                if (tw > btn_w) btn_w = tw;
            }
            if (btn_w > MENU_BTN_MAXW) btn_w = MENU_BTN_MAXW;
            ow = (s16)(btn_w + 20);
            oh = (s16)(22 + MENU_ITEMS * (bh + bpad) + 6);
            ox = (s16)((AG_SCREEN_W - ow) / 2);
            oy = (s16)((UI_Y - oh) / 2);

            for (i = 0; i < MENU_ITEMS; i++) {
                s16 bx2 = (s16)(ox + (ow - btn_w) / 2);
                s16 by  = (s16)(oy + 22 + i * (bh + bpad));
                if (g_mouse.x >= bx2 && g_mouse.x < bx2 + btn_w &&
                    g_mouse.y >= by  && g_mouse.y < by + bh) {
                    if (sel != i) { sel = i; _menu_draw(sel); }
                    if (g_mouse.buttons & 1) { confirmed = 1; }
                }
            }
        }
        if (confirmed) break;

        if (!kbhit()) continue;
        k = getch();
        if (k == 27) {
            memcpy(g_backbuf, saved, AG_SCREEN_PIXELS);
            return 0;
        }
        if (k == 0 || k == 0xE0) {
            k = getch();
            if (k == 72) { sel = (sel - 1 + MENU_ITEMS) % MENU_ITEMS; _menu_draw(sel); }
            else if (k == 80) { sel = (sel + 1) % MENU_ITEMS; _menu_draw(sel); }
            continue;
        }
        if (k == 13) break;
    }
    memcpy(g_backbuf, saved, AG_SCREEN_PIXELS);
    return sel;
}

/* ===========================================================================
 * CONFIG.CFG — lectura y escritura de configuracion persistente
 * Formato: una clave=valor por linea, texto plano ASCII.
 * Ejemplo:
 *   language=es
 *   volume=100
 *   audio=opl2
 * =========================================================================== */

#define CONFIG_FILE   "CONFIG.CFG"
#define CFG_LANG_KEY  "language"
#define CFG_VOL_KEY   "volume"
#define CFG_AUDIO_KEY "audio"
#define CFG_SFX_KEY     "sfx"
#define CFG_SFX_VOL_KEY "sfx_vol"
#define CFG_FPS_KEY     "show_fps"
#define CFG_MAX_LINE    64

/* Lee el valor de una clave de CONFIG.CFG en out (max out_size bytes).
 * Devuelve 1 si la encontro, 0 si no. */
static int _config_read_val(const char* key, char* out, int out_size) {
    FILE* f;
    char  line[CFG_MAX_LINE];
    int   key_len = (int)strlen(key);
    if (!out || out_size < 2) return 0;
    out[0] = '\0';
    f = fopen(CONFIG_FILE, "r");
    if (!f) return 0;
    while (fgets(line, sizeof(line), f)) {
        int len = (int)strlen(line);
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r'))
            line[--len] = '\0';
        if (strncmp(line, key, key_len) == 0 && line[key_len] == '=') {
            const char* val = line + key_len + 1;
            int vlen = (int)strlen(val);
            if (vlen > 0 && vlen < out_size) {
                _strlcpy(out, val, out_size);
                fclose(f);
                return 1;
            }
        }
    }
    fclose(f);
    return 0;
}

static int _config_read_lang(char* out_lang, int out_size) {
    return _config_read_val(CFG_LANG_KEY, out_lang, out_size);
}

static int _config_read_int(const char* key, int def_val) {
    char buf[16];
    if (!_config_read_val(key, buf, sizeof(buf))) return def_val;
    return atoi(buf);
}

/* Escribe CONFIG.CFG con todos los valores de configuracion actuales. */
static void _config_write_all(void) {
    FILE* f = fopen(CONFIG_FILE, "w");
    if (!f) return;
    fprintf(f, "%s=%s\n", CFG_LANG_KEY, g_active_lang);
    fprintf(f, "%s=%d\n", CFG_VOL_KEY,  g_cfg_volume);
    fprintf(f, "%s=%d\n", CFG_SFX_KEY,     g_cfg_sfx);
    fprintf(f, "%s=%d\n", CFG_SFX_VOL_KEY, g_cfg_sfx_vol);
    fprintf(f, "%s=%d\n", CFG_FPS_KEY,     g_cfg_show_fps);
    if (g_cfg_audio[0])
        fprintf(f, "%s=%s\n", CFG_AUDIO_KEY, g_cfg_audio);
    fclose(f);
    DBG("CONFIG.CFG: language=%s volume=%d sfx=%d audio=%s\n",
        g_active_lang, g_cfg_volume, g_cfg_sfx, g_cfg_audio);
}

/* ===========================================================================
 * S_CONFIG — pantalla de Configuracion con submenus:
 *   Audio / Volumen / Idioma
 * =========================================================================== */

#include "mididrv.h"
#include "opl2.h"
#include "opl3.h"
#include "mpu.h"

#define CFG_MAX_LANGS   16
#define CFG_LANG_LEN     8

static int _locale_id_to_code(const char* res_id, char* out, int out_size) {
    if (strncmp(res_id, "lang_", 5) != 0) return 0;
    _strlcpy(out, res_id + 5, out_size);
    return out[0] != '\0';
}

static int _config_list_langs(char langs[CFG_MAX_LANGS][CFG_LANG_LEN]) {
    int i, count = 0;
    if (!g_text_idx) return 0;
    for (i = 0; i < g_text_n && count < CFG_MAX_LANGS; i++) {
        if (g_text_idx[i].res_type == RES_LOCALE) {
            char code[CFG_LANG_LEN];
            if (_locale_id_to_code(g_text_idx[i].id, code, sizeof(code)))
                _strlcpy(langs[count++], code, CFG_LANG_LEN);
        }
    }
    return count;
}

static const char* _cfg_label(const char* key, const char* fallback) {
    const char* t = engine_text(key);
    if (!t || !t[0] || t == key) return fallback;
    return t;
}

/* ---- helpers de dibujo reutilizados en subscreens ---- */
static void _cfg_draw_panel(s16 ox, s16 oy, s16 ow, s16 oh, const char* title) {
    int j;
    for (j = 0; j < AG_SCREEN_PIXELS; j++)
        if (((j % AG_SCREEN_W) + (j / AG_SCREEN_W)) & 1)
            g_backbuf[j] = MENU_COL_BG;
    _fill_rect(ox, oy, ow, oh, MENU_COL_BG);
    _draw_rect_border(ox, oy, ow, oh, MENU_COL_BRD);
    _draw_rect_border((s16)(ox+1),(s16)(oy+1),(s16)(ow-2),(s16)(oh-2),(u8)(MENU_COL_BG+4));
    _draw_text_centered(ox, (s16)(ox+ow), (s16)(oy+6), FONT_SMALL, MENU_COL_TXT, 0, title);
}

/* ---- Subpantalla: Idioma -------------------------------------------- */
/* ---- Subpantalla: Idioma -------------------------------------------
 * Muestra la lista de idiomas disponibles en TEXT.DAT.
 * El idioma actualmente activo se muestra en rojo/rosa (MENU_COL_ACT),
 * igual que el driver de audio activo.
 * Click en un idioma solo mueve el cursor (azul); NO cambia el idioma.
 * Solo el boton Aceptar (o Enter) aplica y guarda el cambio.
 * ESC cancela sin guardar. */
static void _config_lang_run(void) {
    char langs[CFG_MAX_LANGS][CFG_LANG_LEN];
    int  nlang, sel, active_idx, i, confirmed;
    static u8 saved_lang[AG_SCREEN_PIXELS];
    s16 btn_w, bh = 14, bpad = 3, abh = 13, ow, oh, ox, oy;
    const char* title  = _cfg_label("menu.config.titulo.idioma", "Idioma");
    const char* lbl_ok = _cfg_label("menu.aceptar", "Aceptar");

    nlang = _config_list_langs(langs);
    if (nlang == 0) return;  /* sin idiomas en DAT — nada que mostrar */

    /* Buscar indice del idioma actualmente activo (se mostrara en rojo/rosa) */
    active_idx = 0;
    for (i = 0; i < nlang; i++)
        if (strncmp(langs[i], g_active_lang, CFG_LANG_LEN) == 0) { active_idx = i; break; }

    /* Cursor inicial = idioma activo */
    sel = active_idx;

    memcpy(saved_lang, g_backbuf, AG_SCREEN_PIXELS);
    confirmed = 0;

    /* Calcular geometria del panel */
    btn_w = MENU_BTN_MINW;
    for (i = 0; i < nlang; i++) {
        s16 tw = (s16)(engine_text_width(FONT_SMALL, langs[i]) + MENU_BTN_PAD*2);
        if (tw > btn_w) btn_w = tw;
    }
    { s16 tw2 = (s16)(engine_text_width(FONT_SMALL, title) + 20);
      if (tw2 > btn_w) btn_w = tw2; }
    { s16 tw2 = (s16)(engine_text_width(FONT_SMALL, lbl_ok) + MENU_BTN_PAD*2);
      if (tw2 > btn_w) btn_w = tw2; }
    if (btn_w > MENU_BTN_MAXW) btn_w = MENU_BTN_MAXW;
    if (btn_w < MENU_BTN_MINW) btn_w = MENU_BTN_MINW;
    ow = (s16)(btn_w + 40);
    oh = (s16)(22 + nlang * (bh + bpad) + 6 + abh + 8);
    ox = (s16)((AG_SCREEN_W - ow) / 2);
    oy = (s16)((UI_Y - oh) / 2);

    while (1) {
        s16 bx2  = (s16)(ox + (ow - btn_w) / 2);
        s16 ok_y = (s16)(oy + 22 + nlang * (bh + bpad) + 4);

        _cfg_draw_panel(ox, oy, ow, oh, title);

        /* Botones de idioma:
         *   activo   → rojo/rosa (MENU_COL_ACT), igual que el driver de audio
         *   cursor   → azul (MENU_COL_SEL)
         *   resto    → gris normal (MENU_COL_BTN) */
        for (i = 0; i < nlang; i++) {
            s16 by  = (s16)(oy + 20 + i * (bh + bpad));
            u8  col;
            if (i == active_idx) col = MENU_COL_ACT;   /* idioma actualmente en uso */
            else if (i == sel)   col = MENU_COL_SEL;   /* cursor del usuario */
            else                 col = MENU_COL_BTN;
            _fill_rect(bx2, by, btn_w, bh, col);
            _draw_rect_border(bx2, by, btn_w, bh, MENU_COL_BRD);
            _draw_text_centered(bx2, (s16)(bx2+btn_w), (s16)(by+bh/2-3),
                                FONT_SMALL, MENU_COL_TXT, 0, langs[i]);
        }

        /* Boton Aceptar */
        _fill_rect(bx2, ok_y, btn_w, abh, MENU_COL_BTN);
        _draw_rect_border(bx2, ok_y, btn_w, abh, MENU_COL_BRD);
        _draw_text_centered(bx2, (s16)(bx2+btn_w), (s16)(ok_y+abh/2-3),
                            FONT_SMALL, MENU_COL_TXT, 0, lbl_ok);
        _vga_flip();

        /* Input raton: click en idioma = mover cursor SIN aplicar cambio */
        _mouse_poll();
        for (i = 0; i < nlang; i++) {
            s16 by = (s16)(oy + 20 + i * (bh + bpad));
            if (g_mouse.x >= bx2 && g_mouse.x < bx2+btn_w &&
                g_mouse.y >= by  && g_mouse.y < by+bh) {
                if (g_mouse.buttons & 1) {
                    sel = i;  /* solo mover cursor, NO confirmar todavia */
                    do { _mouse_poll(); } while (g_mouse.buttons);
                }
                break;
            }
        }
        /* Click en Aceptar = confirmar y guardar */
        if (g_mouse.x >= bx2 && g_mouse.x < bx2+btn_w &&
            g_mouse.y >= ok_y && g_mouse.y < ok_y+abh &&
            (g_mouse.buttons & 1)) {
            confirmed = 1;
            do { _mouse_poll(); } while (g_mouse.buttons);
        }
        if (confirmed) break;

        /* Input teclado */
        if (!kbhit()) continue;
        { int k = getch();
          if (k == 27) { memcpy(g_backbuf, saved_lang, AG_SCREEN_PIXELS); return; }
          if (k == 0 || k == 0xE0) {
              k = getch();
              if (k == 72) sel = (sel-1+nlang)%nlang;   /* flecha arriba */
              else if (k == 80) sel = (sel+1)%nlang;     /* flecha abajo  */
          } else if (k == 13) { confirmed = 1; break; }  /* Enter = Aceptar */
        }
    }
    /* Solo aplicar si el usuario confirmo con Aceptar o Enter */
    if (confirmed) {
        engine_set_language(langs[sel]);
        _config_write_all();
        DBG("Language changed to: %s\n", langs[sel]);
    }
    memcpy(g_backbuf, saved_lang, AG_SCREEN_PIXELS);
}

/* ---- Subpantalla: Volumen -------------------------------------------
 * Barra de 0 a 100 con botones [-] y [+] que cambian de 5 en 5.
 * Flechas izquierda/derecha tambien cambian de 5 en 5.
 * El volumen se aplica en tiempo real; Aceptar (o Enter) guarda.
 * ESC cancela sin guardar. */
static void _config_volume_run(void) {
    static u8 saved_vol[AG_SCREEN_PIXELS];
    /* Copias locales — se guardan solo al Aceptar */
    int vol_mus = g_cfg_volume;
    int vol_sfx = g_cfg_sfx_vol;
    int orig_mus = g_cfg_volume;
    int orig_sfx = g_cfg_sfx_vol;
    int sel  = 0;   /* fila activa teclado: 0=musica 1=efectos */
    int done = 0;
    /* Dimensiones */
    s16 bar_w = 100, bar_h = 8, btn_sz = 14, abh = 13;
    s16 ow = 220, oh = 116, ox, oy;
    const char* title     = _cfg_label("menu.config.titulo.volumen", "Volumen");
    const char* lbl_mus   = _cfg_label("menu.config.vol.musica",    "Musica");
    const char* lbl_sfx   = _cfg_label("menu.config.vol.efectos",   "Efectos");
    const char* lbl_ok    = _cfg_label("menu.aceptar",              "Aceptar");

    memcpy(saved_vol, g_backbuf, AG_SCREEN_PIXELS);
    do { _mouse_poll(); } while (g_mouse.buttons);
    while (kbhit()) getch();

    ox = (s16)((AG_SCREEN_W - ow) / 2);
    oy = (s16)((UI_Y - oh) / 2);

    while (!done) {
        /* Fila musica: etiqueta + barra + botones */
        s16 lbl_x   = (s16)(ox + 10);
        s16 bar_x   = (s16)(ox + (ow - bar_w) / 2);
        s16 bx_dec  = (s16)(bar_x - btn_sz - 3);
        s16 bx_inc  = (s16)(bar_x + bar_w + 3);
        s16 row1_y  = (s16)(oy + 26);  /* fila musica */
        s16 row2_y  = (s16)(oy + 62);  /* fila efectos */
        s16 ok_x    = (s16)(ox + (ow - 60) / 2);
        s16 ok_y    = (s16)(oy + oh - abh - 8);
        char str[8];

        _cfg_draw_panel(ox, oy, ow, oh, title);

        /* ── Fila Musica ── */
        engine_draw_text(lbl_x, (s16)(row1_y - 9), FONT_SMALL,
                         sel==0 ? MENU_COL_SEL : MENU_COL_TXT, 0, lbl_mus);
        { s16 fill = (s16)(vol_mus * bar_w / 100);
          _fill_rect(bar_x,               row1_y, fill,              bar_h, MENU_COL_SEL);
          _fill_rect((s16)(bar_x+fill),   row1_y, (s16)(bar_w-fill), bar_h, MENU_COL_BTN); }
        _draw_rect_border(bar_x, row1_y, bar_w, bar_h, MENU_COL_BRD);
        { s16 bty = (s16)(row1_y + bar_h/2 - btn_sz/2);
          _fill_rect(bx_dec, bty, btn_sz, btn_sz, MENU_COL_BTN);
          _draw_rect_border(bx_dec, bty, btn_sz, btn_sz, MENU_COL_BRD);
          _draw_text_centered(bx_dec,(s16)(bx_dec+btn_sz),(s16)(bty+btn_sz/2-3),FONT_SMALL,MENU_COL_TXT,0,"-");
          _fill_rect(bx_inc, bty, btn_sz, btn_sz, MENU_COL_BTN);
          _draw_rect_border(bx_inc, bty, btn_sz, btn_sz, MENU_COL_BRD);
          _draw_text_centered(bx_inc,(s16)(bx_inc+btn_sz),(s16)(bty+btn_sz/2-3),FONT_SMALL,MENU_COL_TXT,0,"+"); }
        sprintf(str, "%d", vol_mus);
        _draw_text_centered(ox,(s16)(ox+ow),(s16)(row1_y+bar_h+3),FONT_SMALL,MENU_COL_TXT,0,str);

        /* ── Fila Efectos ── */
        engine_draw_text(lbl_x, (s16)(row2_y - 9), FONT_SMALL,
                         sel==1 ? MENU_COL_SEL : MENU_COL_TXT, 0, lbl_sfx);
        { s16 fill = (s16)(vol_sfx * bar_w / 100);
          _fill_rect(bar_x,               row2_y, fill,              bar_h, MENU_COL_SEL);
          _fill_rect((s16)(bar_x+fill),   row2_y, (s16)(bar_w-fill), bar_h, MENU_COL_BTN); }
        _draw_rect_border(bar_x, row2_y, bar_w, bar_h, MENU_COL_BRD);
        { s16 bty = (s16)(row2_y + bar_h/2 - btn_sz/2);
          _fill_rect(bx_dec, bty, btn_sz, btn_sz, MENU_COL_BTN);
          _draw_rect_border(bx_dec, bty, btn_sz, btn_sz, MENU_COL_BRD);
          _draw_text_centered(bx_dec,(s16)(bx_dec+btn_sz),(s16)(bty+btn_sz/2-3),FONT_SMALL,MENU_COL_TXT,0,"-");
          _fill_rect(bx_inc, bty, btn_sz, btn_sz, MENU_COL_BTN);
          _draw_rect_border(bx_inc, bty, btn_sz, btn_sz, MENU_COL_BRD);
          _draw_text_centered(bx_inc,(s16)(bx_inc+btn_sz),(s16)(bty+btn_sz/2-3),FONT_SMALL,MENU_COL_TXT,0,"+"); }
        sprintf(str, "%d", vol_sfx);
        _draw_text_centered(ox,(s16)(ox+ow),(s16)(row2_y+bar_h+3),FONT_SMALL,MENU_COL_TXT,0,str);

        /* ── Boton Aceptar ── */
        _fill_rect(ok_x, ok_y, 60, abh, MENU_COL_BTN);
        _draw_rect_border(ok_x, ok_y, 60, abh, MENU_COL_BRD);
        _draw_text_centered(ok_x,(s16)(ok_x+60),(s16)(ok_y+abh/2-3),FONT_SMALL,MENU_COL_TXT,0,lbl_ok);

        _vga_flip();

        /* ── Input raton ── */
        _mouse_poll();
        if (g_mouse.buttons & 1) {
            /* Fila musica */
            { s16 bty = (s16)(row1_y + bar_h/2 - btn_sz/2);
              if (g_mouse.y >= (s16)(row1_y-9) && g_mouse.y < (s16)(row1_y+bar_h+14)) sel = 0;
              if (g_mouse.x >= bx_dec && g_mouse.x < bx_dec+btn_sz &&
                  g_mouse.y >= bty    && g_mouse.y < bty+btn_sz) {
                  if (vol_mus >= 5) vol_mus -= 5; else vol_mus = 0;
                  engine_set_music_volume((unsigned)(vol_mus*127/100));
                  do { _mouse_poll(); } while (g_mouse.buttons); }
              else if (g_mouse.x >= bx_inc && g_mouse.x < bx_inc+btn_sz &&
                       g_mouse.y >= bty    && g_mouse.y < bty+btn_sz) {
                  if (vol_mus <= 95) vol_mus += 5; else vol_mus = 100;
                  engine_set_music_volume((unsigned)(vol_mus*127/100));
                  do { _mouse_poll(); } while (g_mouse.buttons); }
            }
            /* Fila efectos */
            { s16 bty = (s16)(row2_y + bar_h/2 - btn_sz/2);
              if (g_mouse.y >= (s16)(row2_y-9) && g_mouse.y < (s16)(row2_y+bar_h+14)) sel = 1;
              if (g_mouse.x >= bx_dec && g_mouse.x < bx_dec+btn_sz &&
                  g_mouse.y >= bty    && g_mouse.y < bty+btn_sz) {
                  if (vol_sfx >= 5) vol_sfx -= 5; else vol_sfx = 0;
                  engine_set_sfx_volume((unsigned)(vol_sfx*127/100));
                  do { _mouse_poll(); } while (g_mouse.buttons); }
              else if (g_mouse.x >= bx_inc && g_mouse.x < bx_inc+btn_sz &&
                       g_mouse.y >= bty    && g_mouse.y < bty+btn_sz) {
                  if (vol_sfx <= 95) vol_sfx += 5; else vol_sfx = 100;
                  engine_set_sfx_volume((unsigned)(vol_sfx*127/100));
                  do { _mouse_poll(); } while (g_mouse.buttons); }
            }
            /* Boton Aceptar */
            if (g_mouse.x >= ok_x && g_mouse.x < ok_x+60 &&
                g_mouse.y >= ok_y && g_mouse.y < ok_y+abh) {
                done = 1; do { _mouse_poll(); } while (g_mouse.buttons); }
        }
        if (done) break;

        /* ── Input teclado ── */
        if (!kbhit()) continue;
        { int k = getch();
          if (k == 27) {
              /* ESC: cancelar sin guardar — restaurar valores originales */
              engine_set_music_volume((unsigned)(orig_mus * 127 / 100));
              engine_set_sfx_volume((unsigned)(orig_sfx  * 127 / 100));
              memcpy(g_backbuf, saved_vol, AG_SCREEN_PIXELS);
              return;
          }
          if (k == 9)  { sel = 1 - sel; continue; }  /* Tab cambia fila activa */
          if (k == 13) { done = 1; break; }
          if (k == 0 || k == 0xE0) {
              k = getch();
              if (sel == 0) {
                  if (k == 75) { if (vol_mus>=5) vol_mus-=5; else vol_mus=0;
                                 engine_set_music_volume((unsigned)(vol_mus*127/100)); }
                  if (k == 77) { if (vol_mus<=95) vol_mus+=5; else vol_mus=100;
                                 engine_set_music_volume((unsigned)(vol_mus*127/100)); }
              } else {
                  if (k == 75) { if (vol_sfx>=5) vol_sfx-=5; else vol_sfx=0;
                                 engine_set_sfx_volume((unsigned)(vol_sfx*127/100)); }
                  if (k == 77) { if (vol_sfx<=95) vol_sfx+=5; else vol_sfx=100;
                                 engine_set_sfx_volume((unsigned)(vol_sfx*127/100)); }
              }
          }
        }
    }
    /* Guardar ambos volúmenes en CONFIG.CFG */
    g_cfg_volume  = vol_mus;
    g_cfg_sfx_vol = vol_sfx;
    engine_set_music_volume((unsigned)(vol_mus * 127 / 100));
    engine_set_sfx_volume((unsigned)(vol_sfx  * 127 / 100));
    _config_write_all();
    memcpy(g_backbuf, saved_vol, AG_SCREEN_PIXELS);
}

/* ---- Subpantalla: Audio ---------------------------------------------
 * Muestra los drivers de audio disponibles.
 * El driver actualmente en uso aparece resaltado en rojo/rosa (MENU_COL_ACT).
 * Los incompatibles (no detectados) aparecen ensombrecidos y no son seleccionables.
 * El cursor (sel) permite elegir el driver preferido para la proxima ejecucion.
 * Aceptar guarda la preferencia en CONFIG.CFG. */
/* Orden: OPL3 primero (mejor calidad: 18 canales estereo), luego OPL2, luego MPU-401 */
#define CFGAUDIO_COUNT  3
static const char* g_cfgaudio_ids[CFGAUDIO_COUNT]    = {"opl3",              "opl2",             "mpu401"};
static const char* g_cfgaudio_labels[CFGAUDIO_COUNT] = {"OPL3 (SB16/OPL3)", "OPL2 (AdLib/SB)", "MPU-401 (Roland)"};

/* Devuelve el indice en g_cfgaudio_ids del driver de audio actualmente activo.
 * Usa mdrv_hw_type() que no requiere re-detectar hardware. */
static int _cfgaudio_active_idx(void) {
    int hw = mdrv_hw_type();
    if (hw == MDRV_HW_OPL3)   return 0;
    if (hw == MDRV_HW_OPL2)   return 1;
    if (hw == MDRV_HW_MPU401) return 2;
    return -1;
}

static void _config_audio_run(void) {
    static u8 saved_aud[AG_SCREEN_PIXELS];
    int compat[CFGAUDIO_COUNT];  /* 1 si el driver es compatible con el hardware */
    int active_hw;               /* indice del driver actualmente en uso */
    int sel, i, done = 0;
    s16 btn_w = MENU_BTN_MINW, bh = 14, bpad = 3, abh = 13, ow, oh, ox, oy;
    const char* title  = _cfg_label("menu.config.titulo.audio", "Audio");
    const char* lbl_ok = _cfg_label("menu.aceptar", "Aceptar");

    /* Detectar que drivers son compatibles con el hardware presente */
    compat[0] = opl3_detect();   /* OPL3: test banco0 + banco1 (YMF262) */
    compat[1] = opl2_detect();   /* OPL2: test de timer del chip YM3812  */
    compat[2] = mpu_detect();    /* MPU-401: test de puerto 0x330        */

    /* Driver activo = el que inicio mdrv_install() al arrancar */
    active_hw = _cfgaudio_active_idx();

    /* Cursor inicial: driver activo, o primero compatible si no hay activo */
    sel = active_hw;
    if (sel < 0) { for (i = 0; i < CFGAUDIO_COUNT; i++) if (compat[i]) { sel = i; break; } }
    if (sel < 0) sel = 0;

    /* Calcular geometria del panel */
    for (i = 0; i < CFGAUDIO_COUNT; i++) {
        s16 tw = (s16)(engine_text_width(FONT_SMALL, g_cfgaudio_labels[i]) + MENU_BTN_PAD*2);
        if (tw > btn_w) btn_w = tw;
    }
    { s16 tw = (s16)(engine_text_width(FONT_SMALL, title) + 20);
      if (tw > btn_w) btn_w = tw; }
    { s16 tw = (s16)(engine_text_width(FONT_SMALL, lbl_ok) + MENU_BTN_PAD*2);
      if (tw > btn_w) btn_w = tw; }
    if (btn_w > MENU_BTN_MAXW) btn_w = MENU_BTN_MAXW;
    if (btn_w < MENU_BTN_MINW) btn_w = MENU_BTN_MINW;
    ow = (s16)(btn_w + 40);
    /* Altura: titulo + botones de driver + separacion + boton Aceptar */
    oh = (s16)(22 + CFGAUDIO_COUNT * (bh + bpad) + 6 + abh + 8);
    ox = (s16)((AG_SCREEN_W - ow) / 2);
    oy = (s16)((UI_Y - oh) / 2);

    memcpy(saved_aud, g_backbuf, AG_SCREEN_PIXELS);
    do { _mouse_poll(); } while (g_mouse.buttons);
    while (kbhit()) getch();

    while (!done) {
        s16 bx2  = (s16)(ox + (ow - btn_w) / 2);
        s16 ok_y = (s16)(oy + 22 + CFGAUDIO_COUNT * (bh + bpad) + 4);

        _cfg_draw_panel(ox, oy, ow, oh, title);

        /* Botones de driver */
        for (i = 0; i < CFGAUDIO_COUNT; i++) {
            s16 by = (s16)(oy + 20 + i * (bh + bpad));
            u8 btn_col, txt_col;
            if (!compat[i]) {
                /* Driver incompatible: ensombrecido, no seleccionable */
                btn_col = MENU_COL_BG;
                txt_col = (u8)(MENU_COL_BG + 3);
            } else if (i == active_hw) {
                /* Driver actualmente en uso: rojo/rosa para distinguirlo */
                btn_col = MENU_COL_ACT;
                txt_col = MENU_COL_TXT;
            } else if (i == sel) {
                /* Cursor sobre driver compatible no activo: azul */
                btn_col = MENU_COL_SEL;
                txt_col = MENU_COL_TXT;
            } else {
                btn_col = MENU_COL_BTN;
                txt_col = MENU_COL_TXT;
            }
            _fill_rect(bx2, by, btn_w, bh, btn_col);
            _draw_rect_border(bx2, by, btn_w, bh, MENU_COL_BRD);
            _draw_text_centered(bx2, (s16)(bx2+btn_w), (s16)(by+bh/2-3),
                                FONT_SMALL, txt_col, 0, g_cfgaudio_labels[i]);
        }

        /* Boton Aceptar */
        _fill_rect(bx2, ok_y, btn_w, abh, MENU_COL_BTN);
        _draw_rect_border(bx2, ok_y, btn_w, abh, MENU_COL_BRD);
        _draw_text_centered(bx2, (s16)(bx2+btn_w), (s16)(ok_y+abh/2-3),
                            FONT_SMALL, MENU_COL_TXT, 0, lbl_ok);
        _vga_flip();

        /* Input raton: seleccionar driver compatible o Aceptar */
        _mouse_poll();
        if (g_mouse.buttons & 1) {
            for (i = 0; i < CFGAUDIO_COUNT; i++) {
                s16 by = (s16)(oy + 20 + i * (bh + bpad));
                if (compat[i] &&
                    g_mouse.x >= bx2 && g_mouse.x < bx2+btn_w &&
                    g_mouse.y >= by  && g_mouse.y < by+bh) {
                    sel = i;
                    do { _mouse_poll(); } while (g_mouse.buttons);
                    break;
                }
            }
            if (g_mouse.x >= bx2 && g_mouse.x < bx2+btn_w &&
                g_mouse.y >= ok_y && g_mouse.y < ok_y+abh) {
                done = 1;
                do { _mouse_poll(); } while (g_mouse.buttons);
            }
        }
        if (done) break;

        /* Input teclado */
        if (!kbhit()) continue;
        { int k = getch();
          if (k == 27) { memcpy(g_backbuf, saved_aud, AG_SCREEN_PIXELS); return; }
          if (k == 13) { done = 1; break; }  /* Enter = Aceptar */
          if (k == 0 || k == 0xE0) {
              k = getch();
              if (k == 72 || k == 80) {
                  /* Flechas: saltar drivers incompatibles */
                  int d  = (k == 72) ? -1 : 1;
                  int ns = (sel + d + CFGAUDIO_COUNT) % CFGAUDIO_COUNT;
                  while (!compat[ns] && ns != sel)
                      ns = (ns + d + CFGAUDIO_COUNT) % CFGAUDIO_COUNT;
                  sel = ns;
              }
          }
        }
    }
    /* Guardar preferencia de audio en estado global y CONFIG.CFG */
    _strlcpy(g_cfg_audio, g_cfgaudio_ids[sel], sizeof(g_cfg_audio));
    _config_write_all();
    DBG("Audio pref saved: %s\n", g_cfg_audio);
    /* Aplicar cambio de driver en la sesion actual sin necesidad de reiniciar */
    engine_audio_set_pref(g_cfg_audio);
    engine_audio_reinit();
    memcpy(g_backbuf, saved_aud, AG_SCREEN_PIXELS);
}


/* ---- Subpanel SFX: activar/desactivar efectos de sonido ------------ */
static void _config_sfx_run(void) {
    static u8 saved_sfx[AG_SCREEN_PIXELS];
    /* 0 = Activados, 1 = Desactivados — cursor inicial segun g_cfg_sfx */
    int sel = g_cfg_sfx ? 0 : 1;
    int done = 0;
    s16 btn_w = MENU_BTN_MINW, bh = 16, bpad = 4, ow, oh, ox, oy;
    const char* title   = _cfg_label("menu.config.sfx.titulo",  "Efectos de sonido");
    const char* lbl_on  = _cfg_label("menu.config.sfx.on",  "Activados");
    const char* lbl_off = _cfg_label("menu.config.sfx.off", "Desactivados");
    const char* lbls[2];
    int i;
    lbls[0] = lbl_on; lbls[1] = lbl_off;

    { s16 tw; int j;
      for (j = 0; j < 2; j++) {
          tw = (s16)(engine_text_width(FONT_SMALL, lbls[j]) + MENU_BTN_PAD*2);
          if (tw > btn_w) btn_w = tw;
      }
      tw = (s16)(engine_text_width(FONT_SMALL, title) + 20);
      if (tw > btn_w) btn_w = tw;
    }
    if (btn_w > MENU_BTN_MAXW) btn_w = MENU_BTN_MAXW;
    if (btn_w < MENU_BTN_MINW) btn_w = MENU_BTN_MINW;
    ow = (s16)(btn_w + 40);
    oh = (s16)(22 + 2 * (bh + bpad) + 10);
    ox = (s16)((AG_SCREEN_W - ow) / 2);
    oy = (s16)((UI_Y - oh) / 2);

    memcpy(saved_sfx, g_backbuf, AG_SCREEN_PIXELS);
    do { _mouse_poll(); } while (g_mouse.buttons);
    while (kbhit()) getch();

    while (!done) {
        _cfg_draw_panel(ox, oy, ow, oh, title);
        { s16 bx2 = (s16)(ox + (ow - btn_w) / 2);
          for (i = 0; i < 2; i++) {
              s16 by = (s16)(oy + 20 + i * (bh + bpad));
              u8 col = (i == sel) ? MENU_COL_SEL : MENU_COL_BTN;
              _fill_rect(bx2, by, btn_w, bh, col);
              _draw_rect_border(bx2, by, btn_w, bh, MENU_COL_BRD);
              _draw_text_centered(bx2, (s16)(bx2+btn_w), (s16)(by+bh/2-3),
                                  FONT_SMALL, MENU_COL_TXT, 0, lbls[i]);
          }
        }
        _vga_flip();

        _mouse_poll();
        { s16 bx2 = (s16)(ox + (ow - btn_w) / 2);
          for (i = 0; i < 2; i++) {
              s16 by = (s16)(oy + 20 + i * (bh + bpad));
              if (g_mouse.x >= bx2 && g_mouse.x < bx2+btn_w &&
                  g_mouse.y >= by  && g_mouse.y < by+bh) {
                  sel = i;
                  if (g_mouse.buttons & 1) {
                      do { _mouse_poll(); } while (g_mouse.buttons);
                      done = 1; break;
                  }
              }
          }
        }
        if (done) break;
        if (!kbhit()) continue;
        { int k = getch();
          if (k == 27) { memcpy(g_backbuf, saved_sfx, AG_SCREEN_PIXELS); return; }
          if (k == 0 || k == 0xE0) {
              k = getch();
              if (k == 72) sel = (sel+1)%2;
              else if (k == 80) sel = (sel+1)%2;
          } else if (k == 13) { done = 1; break; }
        }
    }
    /* sel 0=Activados 1=Desactivados */
    g_cfg_sfx = (sel == 0) ? 1 : 0;
    engine_audio_set_sfx_pref(g_cfg_sfx);
    _config_write_all();
    DBG("SFX pref saved: %d\n", g_cfg_sfx);
    memcpy(g_backbuf, saved_sfx, AG_SCREEN_PIXELS);
}

/* ---- Toggle FPS ---------------------------------------------------- */
static void _config_fps_run(void) {
    static u8 saved_fps[AG_SCREEN_PIXELS];
    int sel = g_cfg_show_fps ? 0 : 1;
    int done = 0;
    s16 btn_w = MENU_BTN_MINW, bh = 16, bpad = 4, ow, oh, ox, oy;
    const char* title   = _cfg_label("menu.config.fps.titulo", "Mostrar FPS");
    const char* lbl_on  = _cfg_label("menu.config.fps.on",  "Activado");
    const char* lbl_off = _cfg_label("menu.config.fps.off", "Desactivado");
    const char* lbls[2];
    int i;
    lbls[0] = lbl_on; lbls[1] = lbl_off;

    { s16 tw; int j;
      for (j = 0; j < 2; j++) {
          tw = (s16)(engine_text_width(FONT_SMALL, lbls[j]) + MENU_BTN_PAD*2);
          if (tw > btn_w) btn_w = tw;
      }
      tw = (s16)(engine_text_width(FONT_SMALL, title) + 20);
      if (tw > btn_w) btn_w = tw;
    }
    if (btn_w > MENU_BTN_MAXW) btn_w = MENU_BTN_MAXW;
    if (btn_w < MENU_BTN_MINW) btn_w = MENU_BTN_MINW;
    ow = (s16)(btn_w + 40);
    oh = (s16)(22 + 2 * (bh + bpad) + 10);
    ox = (s16)((AG_SCREEN_W - ow) / 2);
    oy = (s16)((UI_Y - oh) / 2);

    memcpy(saved_fps, g_backbuf, AG_SCREEN_PIXELS);
    do { _mouse_poll(); } while (g_mouse.buttons);
    while (kbhit()) getch();

    while (!done) {
        _cfg_draw_panel(ox, oy, ow, oh, title);
        { s16 bx2 = (s16)(ox + (ow - btn_w) / 2);
          for (i = 0; i < 2; i++) {
              s16 by = (s16)(oy + 20 + i * (bh + bpad));
              u8 col = (i == sel) ? MENU_COL_SEL : MENU_COL_BTN;
              _fill_rect(bx2, by, btn_w, bh, col);
              _draw_rect_border(bx2, by, btn_w, bh, MENU_COL_BRD);
              _draw_text_centered(bx2, (s16)(bx2+btn_w), (s16)(by+bh/2-3),
                                  FONT_SMALL, MENU_COL_TXT, 0, lbls[i]);
          }
        }
        _vga_flip();

        _mouse_poll();
        { s16 bx2 = (s16)(ox + (ow - btn_w) / 2);
          for (i = 0; i < 2; i++) {
              s16 by = (s16)(oy + 20 + i * (bh + bpad));
              if (g_mouse.x >= bx2 && g_mouse.x < bx2+btn_w &&
                  g_mouse.y >= by  && g_mouse.y < by+bh) {
                  sel = i;
                  if (g_mouse.buttons & 1) {
                      do { _mouse_poll(); } while (g_mouse.buttons);
                      done = 1; break;
                  }
              }
          }
        }
        if (done) break;
        if (!kbhit()) continue;
        { int k = getch();
          if (k == 27) { memcpy(g_backbuf, saved_fps, AG_SCREEN_PIXELS); return; }
          if (k == 0 || k == 0xE0) {
              k = getch();
              if (k == 72 || k == 80) sel = (sel+1)%2;
          } else if (k == 13) { done = 1; break; }
        }
    }
    g_cfg_show_fps = (sel == 0) ? 1 : 0;
    _config_write_all();
    DBG("show_fps saved: %d\n", g_cfg_show_fps);
    memcpy(g_backbuf, saved_fps, AG_SCREEN_PIXELS);
}

/* ---- Menu principal de Configuracion -------------------------------- */
#define CFGMENU_ITEMS  5
static void _config_run(void) {
    static u8 saved_cfg[AG_SCREEN_PIXELS];
    static const char* _cfgkeys[CFGMENU_ITEMS]  = {
        "menu.config.audio", "menu.config.volumen",
        "menu.config.idioma", "menu.config.sfx", "menu.config.fps"
    };
    static const char* _cfgfalls[CFGMENU_ITEMS] = {
        "Audio", "Volumen", "Idioma", "Efectos", "FPS"
    };
    int sel = 0, done = 0, i;
    const char* title = _cfg_label("menu.config.titulo", "Configuracion");
    s16 btn_w = MENU_BTN_MINW, bh = 16, bpad = 4, ow, oh, ox, oy;

    for (i = 0; i < CFGMENU_ITEMS; i++) {
        s16 tw = (s16)(engine_text_width(FONT_SMALL,
                       _cfg_label(_cfgkeys[i], _cfgfalls[i])) + MENU_BTN_PAD*2);
        if (tw > btn_w) btn_w = tw;
    }
    { s16 tw = (s16)(engine_text_width(FONT_SMALL, title) + 20);
      if (tw > btn_w) btn_w = tw; }
    if (btn_w > MENU_BTN_MAXW) btn_w = MENU_BTN_MAXW;
    if (btn_w < MENU_BTN_MINW) btn_w = MENU_BTN_MINW;
    ow = (s16)(btn_w + 40);
    oh = (s16)(22 + CFGMENU_ITEMS * (bh + bpad) + 10);
    ox = (s16)((AG_SCREEN_W - ow) / 2);
    oy = (s16)((UI_Y - oh) / 2);

    memcpy(saved_cfg, g_backbuf, AG_SCREEN_PIXELS);
    do { _mouse_poll(); } while (g_mouse.buttons);
    while (kbhit()) getch();

    while (!done) {
        _cfg_draw_panel(ox, oy, ow, oh, title);
        { s16 bx2 = (s16)(ox + (ow - btn_w) / 2);
          for (i = 0; i < CFGMENU_ITEMS; i++) {
              s16 by = (s16)(oy + 20 + i * (bh + bpad));
              u8 col = (i == sel) ? MENU_COL_SEL : MENU_COL_BTN;
              _fill_rect(bx2, by, btn_w, bh, col);
              _draw_rect_border(bx2, by, btn_w, bh, MENU_COL_BRD);
              _draw_text_centered(bx2, (s16)(bx2+btn_w), (s16)(by+bh/2-3),
                                  FONT_SMALL, MENU_COL_TXT, 0,
                                  _cfg_label(_cfgkeys[i], _cfgfalls[i]));
          }
        }
        _vga_flip();

        _mouse_poll();
        { s16 bx2 = (s16)(ox + (ow - btn_w) / 2);
          for (i = 0; i < CFGMENU_ITEMS; i++) {
              s16 by = (s16)(oy + 20 + i * (bh + bpad));
              if (g_mouse.x >= bx2 && g_mouse.x < bx2+btn_w &&
                  g_mouse.y >= by  && g_mouse.y < by+bh) {
                  if (sel != i) { sel = i; }
                  if (g_mouse.buttons & 1) {
                      do { _mouse_poll(); } while (g_mouse.buttons);
                      done = 1; break;
                  }
              }
          }
        }
        if (done) break;
        if (!kbhit()) continue;
        { int k = getch();
          if (k == 27) { memcpy(g_backbuf, saved_cfg, AG_SCREEN_PIXELS); return; }
          if (k == 0 || k == 0xE0) {
              k = getch();
              if (k == 72) sel = (sel-1+CFGMENU_ITEMS)%CFGMENU_ITEMS;
              else if (k == 80) sel = (sel+1)%CFGMENU_ITEMS;
          } else if (k == 13) { done = 1; break; }
        }
    }
    memcpy(g_backbuf, saved_cfg, AG_SCREEN_PIXELS);
    if (done) {
        switch (sel) {
        case 0: _config_audio_run();  break;
        case 1: _config_volume_run(); break;
        case 2: _config_lang_run();   break;
        case 3: _config_sfx_run();    break;
        case 4: _config_fps_run();    break;
        }
    }
}

/* ===========================================================================
 * Dialogo de confirmacion generico (Si / No)
 * Devuelve 1 si el usuario elige Si, 0 si elige No o pulsa ESC.
 * =========================================================================== */
static int _confirm_run(const char* msg_key, const char* msg_fallback) {
    static u8 saved[AG_SCREEN_PIXELS];
    const char* msg;
    const char* lbl_yes;
    const char* lbl_no;
    s16 ow, oh, ox, oy;
    s16 btn_w, btn_h, btn_y, gap;
    s16 bx_yes, bx_no;
    int sel = 1; /* 0=Si, 1=No — por defecto No */
    int done = 0, confirmed = 0;

    msg = engine_text(msg_key);
    if (!msg || !msg[0] || _str_eq(msg, msg_key)) msg = msg_fallback;
    lbl_yes = engine_text("sys.yes"); if (_str_eq(lbl_yes, "sys.yes")) lbl_yes = "Si";
    lbl_no  = engine_text("sys.no");  if (_str_eq(lbl_no,  "sys.no"))  lbl_no  = "No";

    memcpy(saved, g_backbuf, AG_SCREEN_PIXELS);

    ow = 210; oh = 56;
    ox = (s16)((AG_SCREEN_W - ow) / 2);
    oy = (s16)((AG_SCREEN_H - oh) / 2);
    btn_w = 46; btn_h = 13; gap = 14;
    btn_y = (s16)(oy + oh - btn_h - 8);
    bx_yes = (s16)(ox + ow/2 - gap/2 - btn_w);
    bx_no  = (s16)(ox + ow/2 + gap/2);

    /* Vaciar input pendiente del menu anterior para evitar pass-through */
    do { _mouse_poll(); } while (g_mouse.buttons);
    while (kbhit()) getch();

    while (!done) {
        int k;
        /* Panel */
        _fill_rect(ox, oy, ow, oh, MENU_COL_BG);
        _draw_rect_border(ox, oy, ow, oh, MENU_COL_BRD);
        _draw_rect_border((s16)(ox+1), (s16)(oy+1), (s16)(ow-2), (s16)(oh-2), (u8)(MENU_COL_BG+4));
        /* Mensaje */
        _draw_text_centered(ox, (s16)(ox+ow), (s16)(oy+14),
                            FONT_SMALL, MENU_COL_TXT, 0, msg);
        /* Boton Si */
        _fill_rect(bx_yes, btn_y, btn_w, btn_h, (sel==0) ? MENU_COL_SEL : MENU_COL_BTN);
        _draw_rect_border(bx_yes, btn_y, btn_w, btn_h, MENU_COL_BRD);
        _draw_text_centered(bx_yes, (s16)(bx_yes+btn_w), (s16)(btn_y+btn_h/2-3),
                            FONT_SMALL, MENU_COL_TXT, 0, lbl_yes);
        /* Boton No */
        _fill_rect(bx_no, btn_y, btn_w, btn_h, (sel==1) ? MENU_COL_SEL : MENU_COL_BTN);
        _draw_rect_border(bx_no, btn_y, btn_w, btn_h, MENU_COL_BRD);
        _draw_text_centered(bx_no, (s16)(bx_no+btn_w), (s16)(btn_y+btn_h/2-3),
                            FONT_SMALL, MENU_COL_TXT, 0, lbl_no);
        _vga_flip();

        /* Input raton */
        _mouse_poll();
        if (g_mouse.y >= btn_y && g_mouse.y < btn_y + btn_h) {
            if      (g_mouse.x >= bx_yes && g_mouse.x < bx_yes + btn_w) sel = 0;
            else if (g_mouse.x >= bx_no  && g_mouse.x < bx_no  + btn_w) sel = 1;
        }
        if (g_mouse.buttons & 1) {
            /* Esperar a que se suelte antes de confirmar */
            do { _mouse_poll(); } while (g_mouse.buttons);
            confirmed = (sel == 0); done = 1;
        }

        /* Input teclado */
        while (kbhit()) {
            k = getch();
            if (k == 0 || k == 0xE0) {
                k = getch();
                if (k == 75 || k == 77) sel = 1 - sel; /* flechas izq/der */
            } else if (k == 13) { confirmed = (sel == 0); done = 1; }
              else if (k == 27) { confirmed = 0; done = 1; }
        }
    }
    memcpy(g_backbuf, saved, AG_SCREEN_PIXELS);
    return confirmed;
}

static void _menu_handle_result(int result) {
    switch (result) {
    case 0: /* Continuar */ break;
    case 1: /* Nueva partida — confirmacion + restart */
        if (_confirm_run("sys.new_game_confirm",
                         "Empezar nueva partida? Se perdera el progreso.")) {
            g_restart_requested = 1;
            g_running = 0;
        }
        break;
    case 2: /* Guardar partida — TODO */ break;
    case 3: /* Restaurar partida — TODO */ break;
    case 4: /* Configuracion */ _config_run(); break;
    case 5: /* Salir a DOS */
        g_running = 0;
        break;
    }
}

/* Comprueba si obj_id esta en el inventario del protagonista actual. */
static int _inv_contains(const char* obj_id) {
    int i;
    if (!obj_id || !obj_id[0]) return 0;
    { const char* pid = (g_char_count > 0) ? g_chars[g_protagonist].id : "";
      for (i = 0; i < g_inv_count; i++) {
          if (!_str_eq(g_inventory[i].obj_id, obj_id)) continue;
          if (!g_inventory[i].char_owner[0] || _str_eq(g_inventory[i].char_owner, pid))
              return 1;
      }
    }
    return 0;
}

/* Muestra el overlay de "no ambos en inventario" encima del protagonista. */
static void _show_no_inv_overlay(void) {
    const char* _fb = engine_text("sys.usar_con.no_inv");
    if (_str_eq(_fb, "sys.usar_con.no_inv")) _fb = "";
    if (_fb && _fb[0]) {
        s16 ox = -1, oy = 30;
        if (g_char_count > 0) {
            Char* _pr = &g_chars[g_protagonist];
            s16 tw = engine_text_width(VERB_FONT, _fb);
            ox = _text_ox((s16)(_pr->x - (s16)g_cam_x), tw);
            oy = (s16)(_pr->y / 2); if (oy < 4) oy = 4;
        }
        _protagonist_talk_start(2000);
        _overlay_add(_fb, 15, ox, oy, g_ticks_ms + 2000, 0);
    }
}

/* Busca handler usar_con con soporte recíproco y prioridad char-específico > genérico.
 * Normal:    obj_id==inv_obj  && (obj2_id==target || obj2_id=="")
 * Recíproco: obj_id==target   && obj2_id==inv_obj  (match exacto)
 * Devuelve índice o -1. */
static int _find_usar_con_handler(const char* inv_obj, const char* target) {
    int i, generic = -1;
    const char* pid = (g_char_count > 0) ? g_chars[g_protagonist].id : "";
    for (i = 0; i < g_verb_handler_count; i++) {
        VerbHandler* h = &g_verb_handlers[i];
        if (!_str_eq(h->verb_id,"usar_con")) continue;
        if (!h->fn) continue;
        int match = (_str_eq(h->obj_id, inv_obj) &&
                     (_str_eq(h->obj2_id, target) || h->obj2_id[0]=='\0')) ||
                    (_str_eq(h->obj_id, target) && _str_eq(h->obj2_id, inv_obj));
        if (!match) continue;
        if (h->char_id[0]) {
            if (_str_eq(h->char_id, pid)) return i;
        } else {
            if (generic < 0) generic = i;
        }
    }
    return generic;
}

static void _reset_verb_action(void) {
    int _vi;
    g_selected_verb[0] = '\0';
    _strlcpy(g_action_text, "Walk", sizeof(g_action_text));
    for (_vi = 0; _vi < g_verb_count; _vi++)
        if (g_verbs[_vi].is_movement) {
            _strlcpy(g_action_text, g_verbs[_vi].label, sizeof(g_action_text));
            break;
        }
}

int engine_process_input(void) {
    static u8 prev_buttons = 0;
    static u8 kb_buttons   = 0;
    static u8 prev_kb      = 0;
    int i;
    #define KB_SPEED 4

    /* 1. Procesar buffer teclado ANTES del poll del raton */
    prev_kb    = kb_buttons;
    kb_buttons = 0;
    { s16 kb_dx = 0, kb_dy = 0;
      while (kbhit()) {
          int k = getch();
          if (k == 0 || k == 0xE0) {
              int sc = getch();
              if (sc == 59) { /* F1 — menu in-game */
                  _menu_handle_result(_menu_run());
                  if (!g_running) return 0;
              } else if (!g_script_running) {
                  switch (sc) {
                      case 72: kb_dy -= KB_SPEED; break; /* Arriba    */
                      case 80: kb_dy += KB_SPEED; break; /* Abajo     */
                      case 75: kb_dx -= KB_SPEED; break; /* Izquierda */
                      case 77: kb_dx += KB_SPEED; break; /* Derecha   */
                  }
              }
          } else if (k == 27) {
              _menu_handle_result(_menu_run());
              if (!g_running) return 0;
          } else if ((k == 13 || k == 32) && !g_script_running) {
              kb_buttons |= 1;
          }
      }

      /* 2. Poll raton */
      _mouse_poll();

      /* 3. Aplicar delta teclado encima de la posicion del raton
            y sincronizar cursor hardware INT 33h AX=04h */
      if (kb_dx || kb_dy) {
          u16 _nx, _ny;
          g_mouse.x += kb_dx;
          g_mouse.y += kb_dy;
          if (g_mouse.x < 0)            g_mouse.x = 0;
          if (g_mouse.x >= AG_SCREEN_W) g_mouse.x = AG_SCREEN_W - 1;
          if (g_mouse.y < 0)            g_mouse.y = 0;
          if (g_mouse.y >= AG_SCREEN_H) g_mouse.y = AG_SCREEN_H - 1;
          _nx = (u16)(g_mouse.x * 2);
          _ny = (u16)(g_mouse.y);
          if (g_mouse_ok) {
              _asm { mov ax, 0x04 }
              _asm { mov cx, _nx  }
              _asm { mov dx, _ny  }
              _asm { int 0x33     }
          }
      }
    }

    /* 4. Ctrl via INT 16h AH=02h bit 2 */
    { u8 kb_shift = 0;
      _asm { mov ah, 0x02 }
      _asm { int 0x16     }
      _asm { mov kb_shift, al }
      if (kb_shift & 0x04) kb_buttons |= 2;
    }

    /* Limitar cursor a pantalla */
    if (g_mouse.x < 0)            g_mouse.x = 0;
    if (g_mouse.x >= AG_SCREEN_W) g_mouse.x = AG_SCREEN_W - 1;
    if (g_mouse.y < 0)            g_mouse.y = 0;
    if (g_mouse.y >= AG_SCREEN_H) g_mouse.y = AG_SCREEN_H - 1;

    if ((kb_buttons & 1) && !(prev_kb & 1)) g_mouse.buttons |= 1;
    if ((kb_buttons & 2) && !(prev_kb & 2)) g_mouse.buttons |= 2;


    /* En modo fullscreen no hay UI ni hover — saltar todo el bloque de interaccion */
    if (g_bg_fullscreen) goto _input_done;
    /* Durante el pan de scroll-por-mitades bloquear toda interaccion */
    if (g_cam_pan_active) goto _input_done;

    /* Hover inventario: actualizar slot destacado (solo en area de slots, no en flechas) */
    if (g_mouse.y >= INV_Y_START && g_mouse.x >= INV_X) {
        int ic = (g_mouse.x - INV_X) / INV_SLOT_W;
        int ir = (g_mouse.y - INV_Y_START) / INV_SLOT_H;
        if (ic >= 0 && ic < INV_COLS && ir >= 0 && ir < INV_ROWS)
            g_inv_hover = g_inv_scroll + ir * INV_COLS + ic;
        else
            g_inv_hover = -1;
    } else {
        g_inv_hover = -1;
    }

    /* Hover sobre objetos de escena, personajes y salidas: actualizar barra de accion */
    if (!g_action_timer) {
        s16 wx = (s16)(g_mouse.x + g_cam_x);
        const char* hover      = (g_mouse.y < UI_Y) ? _hit_object(wx, g_mouse.y) : "";
        const char* hover_char = (g_mouse.y < UI_Y && !hover[0]) ? _hit_char(wx, g_mouse.y) : "";
        Exit* hover_exit       = (g_mouse.y < UI_Y && !hover[0] && !hover_char[0]) ? _hit_exit(wx, g_mouse.y) : NULL;

    /* Modo dar: mostrar "Dar [X] a [personaje]" al hover sobre personaje */
    if (g_dar_mode) {
        if (hover_char[0]) {
            char _dc_nk[52]; const char* _dc_nm;
            snprintf(_dc_nk, sizeof(_dc_nk), "char.%.39s.name", hover_char);
            _dc_nm = engine_text(_dc_nk);
            if (_str_eq(_dc_nm, _dc_nk)) _dc_nm = hover_char;
            { char _act[80]; snprintf(_act, sizeof(_act), "%s %s", g_dar_base, _dc_nm);
              _strlcpy(g_action_text, _act, sizeof(g_action_text)); }
        } else {
            _strlcpy(g_action_text, g_dar_base, sizeof(g_action_text));
        }
        goto _hover_block_end;
    }

    /* Modo usar_con: mostrar "usar X con Y" al hover, o solo base si no hay objetivo */
    if (g_usar_con_mode) {
        const char* _uc_nm = NULL;
        char _uc_nk[52];
        if (hover[0] || hover_char[0] || hover_exit) {
            if (hover_exit) {
                _uc_nm = engine_text(hover_exit->name_key);
                if (_str_eq(_uc_nm, hover_exit->name_key)) _uc_nm = hover_exit->id;
            } else {
                const char* _tgt = hover[0] ? hover : hover_char;
                snprintf(_uc_nk, sizeof(_uc_nk), "obj.%.39s.name", _tgt);
                _uc_nm = engine_text(_uc_nk); if (_uc_nm == _uc_nk) _uc_nm = _tgt;
            }
        } else if (g_inv_hover >= 0) { InvSlot* _ivs = _inv_prot_slot(g_inv_hover); if (_ivs) {
            /* Y = objeto de inventario */
            const char* _itgt = _ivs->obj_id;
            snprintf(_uc_nk, sizeof(_uc_nk), "obj.%.39s.name", _itgt);
            _uc_nm = engine_text(_uc_nk); if (_uc_nm == _uc_nk) _uc_nm = _itgt;
        } } /* end _ivs / g_inv_hover block */
        if (_uc_nm) {
            char _act[80];
            snprintf(_act, sizeof(_act), "%s %s", g_usar_con_base, _uc_nm);
            _strlcpy(g_action_text, _act, sizeof(g_action_text));
        } else {
            _strlcpy(g_action_text, g_usar_con_base, sizeof(g_action_text));
        }
        goto _hover_block_end;
    }

    if (1) { /* bloque hover normal */
        if (hover[0] || hover_exit) {
            char name_key[48]; char obj_name_key[48];
            const char* verb_label = ""; const char* obj_name;
            int _vi;
            Obj* _ho = hover[0] ? _find_obj(hover) : NULL;
            if (g_selected_verb[0]) {
                for (_vi = 0; _vi < g_verb_count; _vi++)
                    if (_str_eq(g_verbs[_vi].id, g_selected_verb))
                        { verb_label = g_verbs[_vi].label; break; }
            }
            if (!verb_label[0]) {
                for (_vi = 0; _vi < g_verb_count; _vi++)
                    if (g_verbs[_vi].is_movement)
                        { verb_label = g_verbs[_vi].label; break; }
            }
            if (!verb_label[0]) verb_label = "Walk";
            if (hover_exit) {
                obj_name = engine_text(hover_exit->name_key);
                if (_str_eq(obj_name, hover_exit->name_key)) obj_name = hover_exit->id;
                _strlcpy(g_hover_obj, hover_exit->id, 32);
            } else if (_ho && _ho->obj_id[0]) {
                snprintf(obj_name_key, sizeof(obj_name_key), "obj.%.39s.name", _ho->obj_id);
                obj_name = engine_text(obj_name_key);
                if (_str_eq(obj_name, obj_name_key)) {
                    snprintf(name_key, sizeof(name_key), "obj.%.39s.name", hover);
                    obj_name = engine_text(name_key);
                    if (_str_eq(obj_name, name_key)) obj_name = _ho->obj_id[0] ? _ho->obj_id : hover;
                }
                _strlcpy(g_hover_obj, hover, 32);
            } else {
                snprintf(name_key, sizeof(name_key), "obj.%.39s.name", hover);
                obj_name = engine_text(name_key);
                if (_str_eq(obj_name, name_key)) obj_name = hover;
                _strlcpy(g_hover_obj, hover, 32);
            }
            snprintf(g_action_text, sizeof(g_action_text), "%s %s", verb_label, obj_name);
        } else if (hover_char[0]) {
            /* Hover sobre personaje no-protagonista */
            char char_nk[48]; const char* char_name; const char* verb_label = ""; int _vi;
            snprintf(char_nk, sizeof(char_nk), "char.%.39s.name", hover_char);
            char_name = engine_text(char_nk);
            if (_str_eq(char_name, char_nk)) char_name = hover_char;
            if (g_selected_verb[0]) {
                for (_vi = 0; _vi < g_verb_count; _vi++)
                    if (_str_eq(g_verbs[_vi].id, g_selected_verb))
                        { verb_label = g_verbs[_vi].label; break; }
            }
            if (!verb_label[0]) {
                for (_vi = 0; _vi < g_verb_count; _vi++)
                    if (g_verbs[_vi].is_movement)
                        { verb_label = g_verbs[_vi].label; break; }
            }
            if (!verb_label[0]) verb_label = "Walk";
            snprintf(g_action_text, sizeof(g_action_text), "%s %s", verb_label, char_name);
            _strlcpy(g_hover_obj, hover_char, 32);
        } else if (!hover[0] && g_mouse.y >= INV_Y_START && g_inv_hover >= 0
                   && !g_usar_con_mode && !g_dar_mode) {
            /* Hover sobre objeto de inventario */
            InvSlot* _his = _inv_prot_slot(g_inv_hover);
            if (_his) { const char* inv_id = _his->obj_id;
            char inv_name_key[48]; const char* inv_name;
            const char* verb_label = ""; int _vi;
            snprintf(inv_name_key, sizeof(inv_name_key), "obj.%.39s.name", inv_id);
            inv_name = engine_text(inv_name_key);
            if (_str_eq(inv_name, inv_name_key)) inv_name = inv_id;
            _strlcpy(g_hover_obj, inv_id, 32); /* marcar hover para que la rama de limpieza pueda resetear */
            if (g_selected_verb[0]) {
                for (_vi=0;_vi<g_verb_count;_vi++)
                    if (_str_eq(g_verbs[_vi].id, g_selected_verb))
                        { verb_label = g_verbs[_vi].label; break; }
            }
            if (!verb_label[0]) {
                /* Sin verbo activo: usar verbo de movimiento por defecto */
                for (_vi=0;_vi<g_verb_count;_vi++)
                    if (g_verbs[_vi].is_movement)
                        { verb_label = g_verbs[_vi].label; break; }
            }
            if (verb_label[0])
                snprintf(g_action_text, sizeof(g_action_text), "%s %s", verb_label, inv_name);
            else
                _strlcpy(g_action_text, inv_name, sizeof(g_action_text));
            } /* end _his block */
        } else if (!hover[0]) {
            /* Sin objeto bajo cursor */
            if (g_hover_obj[0]) {
                int _vi;
                g_hover_obj[0] = '\0';
                if (g_selected_verb[0]) {
                    for (_vi = 0; _vi < g_verb_count; _vi++)
                        if (_str_eq(g_verbs[_vi].id, g_selected_verb)) {
                            _strlcpy(g_action_text, g_verbs[_vi].label, sizeof(g_action_text));
                            goto _hover_done;
                        }
                }
                _strlcpy(g_action_text, "Walk", sizeof(g_action_text));
                for (_vi = 0; _vi < g_verb_count; _vi++)
                    if (g_verbs[_vi].is_movement) {
                        _strlcpy(g_action_text, g_verbs[_vi].label, sizeof(g_action_text));
                        break;
                    }
                _hover_done:;
            } else if (g_hover_obj[0] == '\0' && g_selected_verb[0]) {
                /* Verbo seleccionado sin objeto: mostrar solo el verbo */
                int _vi;
                for (_vi = 0; _vi < g_verb_count; _vi++)
                    if (_str_eq(g_verbs[_vi].id, g_selected_verb)) {
                        _strlcpy(g_action_text, g_verbs[_vi].label, sizeof(g_action_text));
                        break;
                    }
            }
        }
    } /* fin bloque hover normal */
    _hover_block_end:;
    }

    /* Click derecho: reset a verbo de movimiento */
    if ((g_mouse.buttons & 2) && !(prev_buttons & 2) && !g_script_running) {
    /* Cancelar modo usar_con/dar si activo, sino restablecer verbo */
    g_usar_con_mode = 0; g_usar_con_inv[0] = '\0'; g_usar_con_base[0] = '\0';
    g_dar_mode = 0; g_dar_inv[0] = '\0'; g_dar_base[0] = '\0';
    if (g_pending.type == PEND_DAR) { g_pending.type = PEND_NONE; }
    g_pending_exit_id[0] = '\0';
    { int _vi;
      _strlcpy(g_action_text, "Walk", sizeof(g_action_text));
      for (_vi = 0; _vi < g_verb_count; _vi++)
          if (g_verbs[_vi].is_movement) {
              _strlcpy(g_action_text, g_verbs[_vi].label, sizeof(g_action_text));
              break;
          }
      g_selected_verb[0] = '\0';
    }
    }

    /* Click izquierdo durante overlay de diálogo: avanzar */
    if ((g_mouse.buttons & 1) && !(prev_buttons & 1) && _overlays_active())
        g_overlay_click_seen = 1;

    /* Click izquierdo */
    if ((g_mouse.buttons & 1) && !(prev_buttons & 1) && !g_script_running) {

        /* -- Popup de party (grid de caras, zona de juego) -- */
        if (g_party_popup_open && g_party_count > 1 && g_mouse.y < UI_Y) {
            int _pp_rows = (g_party_count + POPUP_COLS - 1) / POPUP_COLS;
            s16 _pp_y0   = (s16)(UI_Y - POPUP_BG_PAD - _pp_rows * POPUP_CELL);
            if (g_mouse.x >= POPUP_X0 && g_mouse.x < POPUP_X0 + POPUP_GRID_W &&
                g_mouse.y >= (int)_pp_y0 && g_mouse.y < (int)_pp_y0 + _pp_rows * POPUP_CELL) {
                int _pp_col = (g_mouse.x - POPUP_X0) / POPUP_CELL;
                int _pp_row = (g_mouse.y - (int)_pp_y0) / POPUP_CELL;
                int _pp_i   = _pp_row * POPUP_COLS + _pp_col;
                if (_pp_i >= 0 && _pp_i < g_party_count)
                    engine_switch_protagonist(g_party[_pp_i].id);
                else
                    g_party_popup_open = 0;
            } else {
                g_party_popup_open = 0; /* click fuera del grid: cerrar */
            }
            prev_buttons = g_mouse.buttons;
            return 1;
        }

        /* Click en zona UI */
        if (g_mouse.y >= UI_Y) {
            /* -- Boton de party (action line izquierda) -- */
            if (g_party_count > 1 &&
                g_mouse.x >= 0 && g_mouse.x < PARTY_BTN_W &&
                g_mouse.y >= UI_Y && g_mouse.y < UI_Y + ACTION_LINE_H) {
                g_party_popup_open = !g_party_popup_open;
                prev_buttons = g_mouse.buttons;
                return 1;
            }
            /* -- Flechas de scroll (ARROW_X..ARROW_X+ARROW_W) -- */
            if (g_mouse.x >= ARROW_X && g_mouse.x < ARROW_X + ARROW_W) {
                if (g_mouse.y < INV_Y_START + INV_SLOT_H && g_inv_scroll > 0)
                    g_inv_scroll -= INV_COLS;
                else if (g_mouse.y >= INV_Y_START + INV_SLOT_H &&
                         g_inv_scroll + INV_COLS * INV_ROWS < _inv_prot_count())
                    g_inv_scroll += INV_COLS;
                prev_buttons = g_mouse.buttons;
                return 1;
            }
            /* -- Inventario (x >= INV_X) -- */
            if (g_mouse.x >= INV_X) {
                int ic = (g_mouse.x - INV_X) / INV_SLOT_W;
                int ir = (g_mouse.y - INV_Y_START) / INV_SLOT_H;
                if (ic >= 0 && ic < INV_COLS && ir >= 0 && ir < INV_ROWS) {
                    int idx = g_inv_scroll + ir * 4 + ic;
                    { InvSlot* _cslot = _inv_prot_slot(idx);
                    if (_cslot) {
                        const char* clicked_inv = _cslot->obj_id;
                        if (g_usar_con_mode) {
                            /* Modo "usar X con": segundo objeto = inv (con soporte recíproco) */
                            int _hi = _find_usar_con_handler(g_usar_con_inv, clicked_inv);
                            if (_hi >= 0) {
                                if (g_verb_handlers[_hi].require_both_inv && !_inv_contains(clicked_inv)) {
                                    _show_no_inv_overlay();
                                } else {
                                    g_verb_handlers[_hi].fn();
                                }
                                g_usar_con_mode=0; g_usar_con_inv[0]='\0'; g_usar_con_base[0]='\0';
                                _reset_verb_action();
                            } else {
                                const char* _fb=engine_text("sys.usar_con.no_result");
                                if(_str_eq(_fb,"sys.usar_con.no_result"))_fb="";
                                if(_fb&&_fb[0]){s16 ox=-1,oy=30;if(g_char_count>0){Char*_pr=&g_chars[g_protagonist];s16 tw=engine_text_width(VERB_FONT,_fb);ox=_text_ox((s16)(_pr->x-(s16)g_cam_x),tw);oy=(s16)(_pr->y/2);if(oy<4)oy=4;}_protagonist_talk_start(2000);_overlay_add(_fb,15,ox,oy,g_ticks_ms+2000,0);}
                                g_usar_con_mode=0; g_usar_con_inv[0]='\0'; g_usar_con_base[0]='\0';
                                _reset_verb_action();
                            }
                        } else if (g_selected_verb[0]) {
                            /* Verbo seleccionado + click en inventario */
                            int _verb_approach=0; int _verb_is_give=0; int _vi2;
                            const char* _vlbl = g_selected_verb;
                            for(_vi2=0;_vi2<g_verb_count;_vi2++)
                                if(_str_eq(g_verbs[_vi2].id,g_selected_verb))
                                    {_verb_approach=g_verbs[_vi2].approach_obj; _verb_is_give=g_verbs[_vi2].is_give; _vlbl=g_verbs[_vi2].label; break;}
                            if (_verb_is_give) {
                                /* Verbo dar: entrar en modo dar esperando personaje */
                                char _onk[52]; const char* _onm;
                                snprintf(_onk,sizeof(_onk),"obj.%.39s.name",clicked_inv);
                                _onm=engine_text(_onk); if(_onm==_onk)_onm=clicked_inv;
                                snprintf(g_dar_base,sizeof(g_dar_base),"%s %s a",_vlbl,_onm);
                                g_dar_mode=1;
                                _strlcpy(g_dar_inv,  clicked_inv,       32);
                                _strlcpy(g_dar_verb, g_selected_verb,   32);
                                _strlcpy(g_action_text, g_dar_base, sizeof(g_action_text));
                            } else if (_verb_approach) {
                                /* Verbo "usar" (approach_obj=1): siempre entrar en modo usar_con */
                                char _onk[52]; const char* _onm;
                                snprintf(_onk,sizeof(_onk),"obj.%.39s.name",clicked_inv);
                                _onm=engine_text(_onk); if(_onm==_onk)_onm=clicked_inv;
                                snprintf(g_usar_con_base,sizeof(g_usar_con_base),"%s %s con",_vlbl,_onm);
                                g_usar_con_mode=1;
                                _strlcpy(g_usar_con_inv,clicked_inv,32);
                                _strlcpy(g_usar_con_verb,g_selected_verb,32);
                                _strlcpy(g_action_text,g_usar_con_base,sizeof(g_action_text));
                            } else {
                                /* Verbo no-usar: handler directo o respuesta texto */
                                int _hi; int _found=0;
                                _hi = _find_verb_handler(g_selected_verb, clicked_inv, 1);
                                if (_hi >= 0) { g_verb_handlers[_hi].fn(); _reset_verb_action(); _found=1; }
                                if (!_found) {
                                    char _rk[96]; const char* _resp;
                                    snprintf(_rk,sizeof(_rk),"obj.%s.inv_verb.%s",clicked_inv,g_selected_verb);
                                    _resp=engine_text(_rk);
                                    if(_resp==_rk){snprintf(_rk,sizeof(_rk),"obj.%s.verb.%s",clicked_inv,g_selected_verb);_resp=engine_text(_rk);}
                                    if(_resp==_rk&&g_verbset_id[0]){snprintf(_rk,sizeof(_rk),"verb.%s.%s.default",g_verbset_id,g_selected_verb);_resp=engine_text(_rk);}
                                    if(_resp!=_rk&&_resp&&_resp[0]){
                                        s16 ox=-1,oy=30;
                                        if(g_char_count>0){Char*_pr=&g_chars[g_protagonist];s16 tw=engine_text_width(VERB_FONT,_resp);ox=_pr->x-tw/2-(s16)g_cam_x;if(ox+tw>AG_SCREEN_W-2)ox=(s16)(AG_SCREEN_W-tw-2);if(ox<2)ox=2;oy=(s16)(_pr->y/2);if(oy<4)oy=4;}
                                        _protagonist_talk_start(2000);
                                        _overlay_add(_resp,15,ox,oy,g_ticks_ms+2000,0);
                                    }
                                    _reset_verb_action();
                                }
                            }
                        } else {
                            /* Sin verbo: comprobar si el obj tiene handler usar_con -> modo "usar X con" */
                            { int _hcon; int _has_usar_con = 0;
                              for(_hcon=0;_hcon<g_verb_handler_count;_hcon++)
                                  if(_str_eq(g_verb_handlers[_hcon].verb_id,"usar_con")&&
                                     _str_eq(g_verb_handlers[_hcon].obj_id,clicked_inv))
                                      {_has_usar_con=1;break;}
                              if (_has_usar_con) {
                                  const char* _uvlbl = "Usar"; int _vk;
                                  for(_vk=0;_vk<g_verb_count;_vk++)
                                      if(g_verbs[_vk].approach_obj && !g_verbs[_vk].is_movement)
                                          {_uvlbl=g_verbs[_vk].label;break;}
                                  char _nk[52]; const char* _nm;
                                  snprintf(_nk,sizeof(_nk),"obj.%.39s.name",clicked_inv);
                                  _nm=engine_text(_nk);
                                  if(_nm==_nk)_nm=clicked_inv;
                                  snprintf(g_usar_con_base,sizeof(g_usar_con_base),"%s %s con",_uvlbl,_nm);
                                  g_usar_con_mode=1;
                                  _strlcpy(g_usar_con_inv,clicked_inv,32);
                                  g_usar_con_verb[0]='\0';
                                  _strlcpy(g_action_text,g_usar_con_base,sizeof(g_action_text));
                                  goto _inv_click_done;
                              }
                            }
                            /* Sin handler usar_con: usar verbo de movimiento por defecto */
                            int _vi; const char* _defverb = "";
                            for(_vi=0;_vi<g_verb_count;_vi++)
                                if(g_verbs[_vi].is_movement){_defverb=g_verbs[_vi].id;break;}
                            if (_defverb[0]) {
                                /* Buscar handler para verbo por defecto + inv */
                                int _hi; int _found=0;
                                _hi = _find_verb_handler(_defverb, clicked_inv, 1);
                                if (_hi >= 0) { g_verb_handlers[_hi].fn(); _found=1; }
                                if (!_found) {
                                    /* Mostrar respuesta de texto */
                                    char _rk[96]; const char* _resp=NULL;
                                    snprintf(_rk,sizeof(_rk),"obj.%s.inv_verb.%s",clicked_inv,_defverb);
                                    _resp=engine_text(_rk);
                                    if(_resp==_rk){
                                        snprintf(_rk,sizeof(_rk),"obj.%s.verb.%s",clicked_inv,_defverb);
                                        _resp=engine_text(_rk);
                                    }
                                    if(_resp!=_rk&&_resp&&_resp[0]){
                                        s16 ox=-1,oy=30;
                                        if(g_char_count>0){
                                            Char*_pr=&g_chars[g_protagonist];
                                            s16 tw=engine_text_width(VERB_FONT,_resp);
                                            ox=_pr->x-tw/2-(s16)g_cam_x;
                                            if(ox<2)ox=2;
                                            if(ox+tw>AG_SCREEN_W-2)ox=(s16)(AG_SCREEN_W-tw-2);
                                            oy=(s16)(_pr->y/2);if(oy<4)oy=4;
                                        }
                                        _protagonist_talk_start(2000);
                                        _overlay_add(_resp,15,ox,oy,g_ticks_ms+2000,0);
                                    }
                                }
                            } else {
                                /* Sin verbo de movimiento: seleccionar/deseleccionar */
                                if (_str_eq(g_selected_inv, clicked_inv))
                                    g_selected_inv[0] = '\0';
                                else
                                    _strlcpy(g_selected_inv, clicked_inv, 32);
                            }
                        }
                        _inv_click_done:;
                    } } /* end _cslot / idx block */
                }
                prev_buttons = g_mouse.buttons;
                return 1;
            }
            /* -- Verbos (x < ARROW_X) -- */
            { int _vc = 0, _vi2;
              for (_vi2 = 0; _vi2 < g_verb_count; _vi2++) {
                int _col, _row;
                if (g_verbs[_vi2].is_movement) continue;
                _col = _vc % VERB_COLS;
                _row = _vc / VERB_COLS;
                _vc++;
                if (g_mouse.x >= _col * VERB_CELL_W &&
                    g_mouse.x <  _col * VERB_CELL_W + VERB_CELL_W &&
                    g_mouse.x <  ARROW_X &&
                    g_mouse.y >= INV_Y_START + _row * VERB_CELL_H &&
                    g_mouse.y <  INV_Y_START + _row * VERB_CELL_H + VERB_CELL_H) {
                    _strlcpy(g_selected_verb, g_verbs[_vi2].id, 32);
                    _strlcpy(g_action_text, g_verbs[_vi2].label, sizeof(g_action_text));
                    g_usar_con_mode = 0; g_usar_con_inv[0] = '\0';
                    g_dar_mode = 0; g_dar_inv[0] = '\0'; g_dar_base[0] = '\0';
                    if (g_pending.type == PEND_DAR) { g_pending.type = PEND_NONE; }
                    break;
                }
              }
            }
            prev_buttons = g_mouse.buttons;
            return 1;
        }
        /* Convertir click de pantalla a coordenadas mundo */
        { s16 wx = (s16)(g_mouse.x + g_cam_x);
          s16 wy = g_mouse.y;
          int _mv_exit_prio; int _vi2; const char* _av2; const char* obj; const char* obj_char;
          /* Si el verbo activo es movimiento y hay una salida bajo el cursor,
           * ignorar objetos solapados — la salida tiene prioridad. */
          _mv_exit_prio = 0;
          _av2 = g_selected_verb[0] ? g_selected_verb : "";
          if (!_av2[0])
              for (_vi2=0;_vi2<g_verb_count;_vi2++)
                  if(g_verbs[_vi2].is_movement){_av2=g_verbs[_vi2].id;break;}
          for (_vi2=0;_vi2<g_verb_count;_vi2++)
              if(_str_eq(g_verbs[_vi2].id,_av2)&&g_verbs[_vi2].is_movement){_mv_exit_prio=1;break;}
          if (_mv_exit_prio && !_hit_exit(wx,wy)) _mv_exit_prio = 0;
          obj      = _mv_exit_prio ? "" : _hit_object(wx, wy);
          obj_char = (!obj[0]) ? _hit_char(wx, wy) : "";
          DBG("click world: wx=%d wy=%d obj='%s' char='%s' selected_verb='%s'\n",
              (int)wx, (int)wy, obj, obj_char, g_selected_verb);
        /* Si estamos en modo usar_con: despachar segundo objeto (escena, personaje o exit) */
        if (g_usar_con_mode && !g_script_running) {
            const char* _tgt = obj[0] ? obj : obj_char;
            if (_tgt[0]) {
                int _hi = _find_usar_con_handler(g_usar_con_inv, _tgt);
                if (_hi >= 0) {
                    if (g_verb_handlers[_hi].require_both_inv && !_inv_contains(_tgt)) {
                        _show_no_inv_overlay();
                    } else {
                        g_verb_handlers[_hi].fn();
                    }
                    g_usar_con_mode=0; g_usar_con_inv[0]='\0'; g_usar_con_base[0]='\0';
                    _reset_verb_action();
                } else {
                    /* Sin script: mostrar sys.usar_con.no_result */
                    const char* _fb = engine_text("sys.usar_con.no_result");
                    if (_str_eq(_fb,"sys.usar_con.no_result")) _fb = "No puedo usar eso as\xed.";
                    if (_fb && _fb[0]) {
                        s16 ox=-1,oy=30;
                        if(g_char_count>0){Char*_pr=&g_chars[g_protagonist];s16 tw=engine_text_width(VERB_FONT,_fb);ox=_text_ox((s16)(_pr->x-(s16)g_cam_x),tw);oy=(s16)(_pr->y/2);if(oy<4)oy=4;}
                        _protagonist_talk_start(2000);
                        _overlay_add(_fb,15,ox,oy,g_ticks_ms+2000,0);
                    }
                    g_usar_con_mode=0; g_usar_con_inv[0]='\0'; g_usar_con_base[0]='\0';
                    _reset_verb_action();
                }
                goto _usar_con_done;
            }
            /* Click en zona vacía: cancelar modo */
            g_usar_con_mode=0; g_usar_con_inv[0]='\0'; g_usar_con_base[0]='\0';
            _reset_verb_action();
            _usar_con_done:;
        } else
        if (g_dar_mode && !g_script_running) {
            /* Modo dar: caminar primero hacia el objetivo, luego despachar */
            if (obj_char[0]) {
                Char* _dtc = _find_char(obj_char);
                if (_dtc && g_char_count > 0) {
                    /* Registrar acción pendiente y caminar al objetivo */
                    _strlcpy(g_pending.obj_id,  obj_char,   sizeof(g_pending.obj_id));
                    _strlcpy(g_pending.verb_id, g_dar_verb, sizeof(g_pending.verb_id));
                    g_pending.fn   = NULL;
                    g_pending.type = PEND_DAR;
                    /* Calcular posición de llegada: a distancia "brazo extendido" del objetivo.
                     * Usamos el ancho de frame del protagonista como contacto visual correcto. */
                    { Char* _gpr = &g_chars[g_protagonist];
                      u16 _af = (_gpr->anims[_gpr->cur_anim].frames > 0) ? _gpr->anims[_gpr->cur_anim].frames : 1u;
                      s16 _hw = (_gpr->dec_w > 0) ? (s16)(_gpr->dec_w / _af / 2) : 16;
                      /* Añadir mitad del ancho del frame de dar: el brazo extendido llega al objetivo */
                      { u16 _gaf = (_gpr->anims[ANIM_GIVE].frames > 0) ? _gpr->anims[ANIM_GIVE].frames : 1u;
                        u16 _gfw = (_gpr->anims[ANIM_GIVE].fw > 0) ? _gpr->anims[ANIM_GIVE].fw :
                                   (_gpr->dec_w > 0 ? (u16)(_gpr->dec_w / _gaf) : 32u);
                        _hw = (s16)(_hw + _gfw / 2);
                      }
                      s16 _wx = (_dtc->x >= _gpr->x) ? (s16)(_dtc->x - _hw) : (s16)(_dtc->x + _hw);
                      engine_walk_char(_gpr->id, _wx, _dtc->y, 0);
                    }
                }
                /* dar_mode permanece activo hasta que PEND_DAR se despache */
            } else {
                /* Click en objeto o vacío: cancelar dar */
                g_dar_mode=0; g_dar_inv[0]='\0'; g_dar_base[0]='\0';
                g_pending.type = PEND_NONE;
                _reset_verb_action();
            }
        } else
        if (obj[0] && !g_script_running) {
            /* Determinar verbo efectivo (seleccionado o movimiento por defecto) */
            { int _vai;
              const char* _apv = g_selected_verb;
              int _approach = 0;
              if (!g_selected_verb[0]) {
                  for (_vai=0;_vai<g_verb_count;_vai++)
                      if (g_verbs[_vai].is_movement) { _apv = g_verbs[_vai].id; break; }
              }
              for (_vai=0;_vai<g_verb_count;_vai++)
                  if (_str_eq(g_verbs[_vai].id, _apv)) { _approach = g_verbs[_vai].approach_obj; break; }

              if (_approach && g_char_count > 0) {
                  /* Calcular pending ANTES de iniciar el walk */
                  g_pending.type = PEND_NONE;
                  _strlcpy(g_pending.obj_id,  obj,             sizeof(g_pending.obj_id));
                  _strlcpy(g_pending.verb_id, g_selected_verb, sizeof(g_pending.verb_id));
                  g_pending.fn = NULL;
                  { int _hi; int _is_pv = 0;
                    { int _pvi;
                      for (_pvi=0;_pvi<g_verb_count;_pvi++)
                          if (_str_eq(g_verbs[_pvi].id, g_selected_verb) && g_verbs[_pvi].is_pickup)
                              { _is_pv = 1; break; }
                    }
                    { int _hi2;
                      DBG("approach: buscando handler verb='%s' obj='%s' en %d handlers\n", g_selected_verb, obj, g_verb_handler_count);
                      _hi2 = _find_verb_handler(g_selected_verb, obj, 0);
                      if (_hi2 >= 0) {
                          g_pending.type = PEND_HANDLER;
                          g_pending.fn   = g_verb_handlers[_hi2].fn;
                          _is_pv = 0;
                          DBG("  -> PEND_HANDLER encontrado\n");
                      }
                    }
                    if (_is_pv) {
                        /* Verbo pickup: solo coger si el objeto es pickable */
                        { Obj* _pvo = _find_obj(obj);
                          if (_pvo && _pvo->pickable) g_pending.type = PEND_PICKUP;
                          else g_pending.type = PEND_RESP;
                        }
                    } else if (g_pending.type == PEND_NONE) {
                        { int _hf = _find_verb_handler(g_selected_verb, obj, 0);
                          if (_hf >= 0) {
                              if (g_verb_handlers[_hf].fn == NULL) {
                                  Obj* _pvo2 = _find_obj(obj);
                                  g_pending.type = (_pvo2 && _pvo2->pickable) ? PEND_PICKUP : PEND_RESP;
                              } else {
                                  g_pending.type = PEND_HANDLER;
                                  g_pending.fn   = g_verb_handlers[_hf].fn;
                              }
                          }
                        }
                        if (g_pending.type == PEND_NONE && g_selected_verb[0])
                            g_pending.type = PEND_RESP;
                    }
                  }
                  /* Iniciar walk DESPUES de registrar el pending.
                   * Intentar A* directo al centro del objeto. Si no es walkable,
                   * interpolar linealmente protagonista→objeto y usar el ultimo
                   * punto alcanzable (garantiza ir en la direccion correcta). */
                  { Obj* _wobj = _find_obj(obj);
                    Char* _wpr  = &g_chars[g_protagonist];
                    /* Buscar celda walkable mas cercana al objeto priorizando
                     * la columna x del objeto (dc=0), luego expandir lateralmente.
                     * Esto garantiza que el protagonista llega a la x central del
                     * objeto aunque este fuera del walkmap (pared, decorado alto). */
                    { s16 _bx = _wpr->x, _by = _wpr->y;
                      int _found_near = 0;
                      if (_wobj) {
                          int _ocx = _wobj->x / g_grid_cell_w;
                          int _ocy = _wobj->y / WALKMAP_CELL_SIZE;
                          int _dc;
                          if (_ocx < 0) _ocx = 0;
                          if (_ocx >= g_wm_w) _ocx = g_wm_w - 1;
                          if (_ocy < 0) _ocy = 0;
                          if (_ocy >= g_wm_h) _ocy = g_wm_h - 1;
                          /* dc=0: misma columna x. dc=1: col+1 y col-1. dc=2: col+2 y col-2... */
                          for (_dc = 0; _dc <= 32 && !_found_near; _dc++) {
                              int _sign;
                              for (_sign = 0; _sign <= 1 && !_found_near; _sign++) {
                                  int _nc = _ocx + (_sign ? -_dc : _dc);
                                  int _dr;
                                  if (_nc < 0 || _nc >= g_wm_w) continue;
                                  for (_dr = 0; _dr <= 32 && !_found_near; _dr++) {
                                      int _s2;
                                      for (_s2 = 0; _s2 <= 1 && !_found_near; _s2++) {
                                          int _nr = _ocy + (_s2 ? -_dr : _dr);
                                          Point _tp[64];
                                          if (_dr == 0 && _s2 == 1) continue;
                                          if (_nr < 0 || _nr >= g_wm_h) continue;
                                          if (!_walk_passable(_nc, _nr)) continue;
                                          { s16 _cx2 = (s16)(_nc * g_grid_cell_w + g_grid_cell_w / 2);
                                            s16 _cy2 = (s16)(_nr * WALKMAP_CELL_SIZE + WALKMAP_CELL_SIZE / 2);
                                            if (engine_astar(_wpr->x, _wpr->y,
                                                             _cx2, _cy2, _tp, 64) > 0) {
                                                _bx = _cx2; _by = _cy2;
                                                _found_near = 1;
                                            }
                                          }
                                      }
                                  }
                                  if (_dc == 0) break; /* dc=0: una sola pasada */
                              }
                          }
                      }
                      if (_found_near) {
                          engine_walk_char(_wpr->id, _bx, _by, 0);
                          DBG("approach_walk: obj=%s ox=%d oy=%d -> bx=%d by=%d\n",
                              obj,(int)(_wobj?_wobj->x:0),(int)(_wobj?_wobj->y:0),(int)_bx,(int)_by);
                      } else {
                          /* Inalcanzable: mostrar cannot_reach y cancelar */
                          const char* _sk = (g_pending.type == PEND_PICKUP)
                                            ? "sys.cannot_pickup" : "sys.cannot_reach";
                          { const char* _r2 = engine_text(_sk);
                            if (_r2 && _r2[0] && _r2 != _sk) {
                                s16 _ox2, _oy2 = 30;
                                s16 _tw2 = engine_text_width(VERB_FONT, _r2);
                                _ox2 = _text_ox((s16)(_wpr->x - (s16)g_cam_x), _tw2);
                                _oy2 = (s16)(_wpr->y/2); if (_oy2 < 4) _oy2 = 4;
                                _protagonist_talk_start(2000);
                                _overlay_add(_r2, 15, _ox2, _oy2, g_ticks_ms+2000, 0);
                            }
                          }
                          g_pending.type = PEND_NONE;
                          g_pending.fn   = NULL;
                      }
                    }
                  }
                  /* Resetear verbo seleccionado — se ejecutará la pending al llegar */
                  { int _vi; _strlcpy(g_action_text,"Walk",sizeof(g_action_text));
                    for(_vi=0;_vi<g_verb_count;_vi++) if(g_verbs[_vi].is_movement){_strlcpy(g_action_text,g_verbs[_vi].label,sizeof(g_action_text));break;}
                    g_selected_verb[0]='\0'; }
              } else {
                  /* Sin approach: ejecutar acción inmediatamente */
                  int _executed = 0;
                  { int _hi; int _is_pv2 = 0;
                    { int _pvi2;
                      for (_pvi2=0;_pvi2<g_verb_count;_pvi2++)
                          if (_str_eq(g_verbs[_pvi2].id, g_selected_verb) && g_verbs[_pvi2].is_pickup)
                              { _is_pv2 = 1; break; }
                    }
                    /* Handler manual tiene prioridad sobre auto-pickup */
                    { int _hi2 = _find_verb_handler(g_selected_verb, obj, 0);
                      if (_hi2 >= 0 && g_verb_handlers[_hi2].fn != NULL) {
                          g_verb_handlers[_hi2].fn();
                          _executed = 1; _is_pv2 = 0;
                      }
                    }
                    if (_is_pv2 && !_executed) {
                        Obj* _po = _find_obj(obj);
                        if (_po && _po->pickable) {
                            _po->visible = 0;
                            engine_give_object(obj, g_char_count>0 ? g_chars[g_protagonist].id : "");
                            _executed = 1;
                        }
                    } else if (!_executed) {
                        int _hf = _find_verb_handler(g_selected_verb, obj, 0);
                        if (_hf >= 0) {
                            DBG("  handler match (no approach): verb='%s' obj='%s'\n", g_selected_verb, obj);
                            if (g_verb_handlers[_hf].fn == NULL) {
                                Obj* _po = _find_obj(obj);
                                if (_po && _po->pickable) {
                                    _po->visible = 0;
                                    engine_give_object(obj, g_char_count>0 ? g_chars[g_protagonist].id : "");
                                }
                            } else {
                                void (*_fn)(void) = g_verb_handlers[_hf].fn;
                                g_selected_verb[0] = '\0';
                                do { _mouse_poll(); } while (g_mouse.buttons);
                                g_script_running = 1;
                                _fn();
                                do { _mouse_poll(); } while (g_mouse.buttons);
                                g_script_running = 0;
                            }
                            _executed = 1;
                        }
                    }
                  }
                  if (!_executed) {
                      /* click simple */
                      int _ci; int _has_resp = 0;
                      for (_ci=0;_ci<g_click_count;_ci++)
                          if (_str_eq(g_click_handlers[_ci].obj_id, obj)) { g_click_handlers[_ci].fn(); break; }
                      /* Texto de respuesta no bloqueante */
                      if (g_selected_verb[0]) {
                          char _rk[96];
                          snprintf(_rk, sizeof(_rk), "obj.%s.verb.%s", obj, g_selected_verb);
                          { const char* _resp = engine_text(_rk);
                            if (_resp && _resp[0] && _resp != _rk) {
                                s16 _ox=-1,_oy=30;
                                if(g_char_count>0){s16 _tw=engine_text_width(VERB_FONT,_resp);_ox=_text_ox((s16)(g_chars[g_protagonist].x-(s16)g_cam_x),_tw);_oy=(s16)(g_chars[g_protagonist].y/2);if(_oy<4)_oy=4;}
                                _protagonist_talk_start(2000);
                                _overlay_add(_resp,15,_ox,_oy,g_ticks_ms+2000,0);
                                _has_resp = 1;
                            }
                          }
                      }
                      if (!_has_resp) {
                          if (g_selected_verb[0]) {
                              /* Verbo sin respuesta ni handler: sys.cannot_use */
                              const char* _cu = engine_text("sys.cannot_use");
                              if (!_str_eq(_cu, "sys.cannot_use") && _cu[0]) {
                                  s16 _ox=-1,_oy=30;
                                  if(g_char_count>0){s16 _tw=engine_text_width(VERB_FONT,_cu);_ox=_text_ox((s16)(g_chars[g_protagonist].x-(s16)g_cam_x),_tw);_oy=(s16)(g_chars[g_protagonist].y/2);if(_oy<4)_oy=4;}
                                  _protagonist_talk_start(2000);
                                  _overlay_add(_cu,15,_ox,_oy,g_ticks_ms+2000,0);
                                  _has_resp = 1;
                              }
                          }
                          if (!_has_resp) {
                              /* Sin respuesta en absoluto: resetear accion */
                              int _vi; _strlcpy(g_action_text,"Walk",sizeof(g_action_text));
                              for(_vi=0;_vi<g_verb_count;_vi++) if(g_verbs[_vi].is_movement){_strlcpy(g_action_text,g_verbs[_vi].label,sizeof(g_action_text));break;}
                          }
                      }
                  } else {
                      /* Handler ejecutado: solo resetear verbo seleccionado.
                       * NO tocar g_action_text — el script puede haber llamado
                       * engine_show_text() y queremos que se vea. */
                  }
                  g_selected_verb[0]='\0';
              }
            }
        } else if (obj_char[0] && !g_script_running) {
            /* Click sobre personaje no-protagonista: acercarse y disparar handler */
            Char* _tgt_c = _find_char(obj_char);
            Char* _wpr   = g_char_count > 0 ? &g_chars[g_protagonist] : NULL;
            if (_tgt_c && _wpr) {
                /* Punto de acercamiento: lateral al personaje segun posicion relativa */
                s16 _apx = (s16)(_wpr->x <= _tgt_c->x ? _tgt_c->x - 24 : _tgt_c->x + 24);
                s16 _apy = _tgt_c->y;
                /* Buscar handler (verb, char_id) — reutiliza la tabla de obj handlers */
                const char* _eff_verb = g_selected_verb[0] ? g_selected_verb : "";
                int _vai;
                if (!_eff_verb[0]) {
                    for (_vai = 0; _vai < g_verb_count; _vai++)
                        if (g_verbs[_vai].is_movement) { _eff_verb = g_verbs[_vai].id; break; }
                }
                /* Registrar pending */
                g_pending.type = PEND_NONE; g_pending.fn = NULL;
                { int _chi = _find_verb_handler(g_selected_verb, obj_char, 0);
                  if (_chi >= 0 && g_verb_handlers[_chi].fn) {
                      g_pending.type = PEND_HANDLER;
                      g_pending.fn   = g_verb_handlers[_chi].fn;
                      _strlcpy(g_pending.obj_id,  obj_char,        sizeof(g_pending.obj_id));
                      _strlcpy(g_pending.verb_id, g_selected_verb, sizeof(g_pending.verb_id));
                  }
                  if (g_pending.type == PEND_NONE && g_selected_verb[0]) {
                      /* Sin handler registrado: respuesta de texto al llegar */
                      g_pending.type = PEND_RESP;
                      _strlcpy(g_pending.obj_id,  obj_char,        sizeof(g_pending.obj_id));
                      _strlcpy(g_pending.verb_id, g_selected_verb, sizeof(g_pending.verb_id));
                      g_pending.fn = NULL;
                  }
                }
                /* Iniciar walk */
                { Point _cpath[64];
                  int _cok = engine_astar(_wpr->x, _wpr->y, _apx, _apy, _cpath, 64);
                  if (_cok > 0) {
                      engine_walk_char(_wpr->id, _apx, _apy, 0);
                  } else {
                      /* Sin ruta: acercarse lo maximo posible */
                      s16 _cdx = (s16)(_apx - _wpr->x), _cdy = (s16)(_apy - _wpr->y);
                      int _cs = (_cdx<0?-_cdx:_cdx) > (_cdy<0?-_cdy:_cdy)
                                ? (_cdx<0?-_cdx:_cdx) : (_cdy<0?-_cdy:_cdy);
                      s16 _bx = _wpr->x, _by = _wpr->y;
                      if (_cs > 0) {
                          int _si;
                          for (_si = _cs; _si > 0; _si--) {
                              s16 _tx = (s16)(_wpr->x + _cdx * _si / _cs);
                              s16 _ty = (s16)(_wpr->y + _cdy * _si / _cs);
                              Point _tp[64];
                              if (engine_astar(_wpr->x, _wpr->y, _tx, _ty, _tp, 64) > 0)
                                  { _bx = _tx; _by = _ty; break; }
                          }
                      }
                      engine_walk_char(_wpr->id, _bx, _by, 0);
                  }
                }
                g_selected_verb[0] = '\0';
                { int _vi; _strlcpy(g_action_text,"Walk",sizeof(g_action_text));
                  for(_vi=0;_vi<g_verb_count;_vi++) if(g_verbs[_vi].is_movement){_strlcpy(g_action_text,g_verbs[_vi].label,sizeof(g_action_text));break;}
                }
            }
        } else {
            /* Sin objeto: comprobar si hay salida bajo el cursor */
            Exit* clicked_exit = _hit_exit(wx, wy);
            if (clicked_exit) {
                int _is_mv = 0; int _vi;
                /* Determinar si el verbo activo es movimiento */
                const char* _eff_verb = g_selected_verb[0] ? g_selected_verb : "";
                if (!_eff_verb[0]) {
                    for (_vi = 0; _vi < g_verb_count; _vi++)
                        if (g_verbs[_vi].is_movement) { _eff_verb = g_verbs[_vi].id; break; }
                }
                for (_vi = 0; _vi < g_verb_count; _vi++)
                    if (_str_eq(g_verbs[_vi].id, _eff_verb) && g_verbs[_vi].is_movement)
                        { _is_mv = 1; break; }

                if (_is_mv && g_char_count > 0) {
                    /* Verbo movimiento: caminar hacia el centro de la zona de salida */
                    _strlcpy(g_pending_exit_id, clicked_exit->id, 32);
                    s16 ex_cx = (s16)(clicked_exit->tz.x + clicked_exit->tz.w / 2);
                    s16 ex_cy = (s16)(clicked_exit->tz.y + clicked_exit->tz.h / 2);
                    Char* _pr = &g_chars[g_protagonist];
                    Point _path[64];
                    int _plen = engine_astar(_pr->x, _pr->y, ex_cx, ex_cy, _path, 64);
                    if (_plen > 0) {
                        /* Hay camino: walk normal, _check_exits lo completa */
                        engine_walk_char(_pr->id, ex_cx, ex_cy, 0);
                    } else {
                        /* Sin camino: acercarse lo máximo posible en línea recta */
                        /* Buscar punto más cercano al centro de la salida en el walkmap */
                        s16 bx = _pr->x, by = _pr->y;
                        s16 dx = (s16)(ex_cx - _pr->x), dy = (s16)(ex_cy - _pr->y);
                        int steps = (dx < 0 ? -dx : dx) > (dy < 0 ? -dy : dy)
                                    ? (dx < 0 ? -dx : dx) : (dy < 0 ? -dy : dy);
                        if (steps > 0) {
                            int si;
                            for (si = steps; si > 0; si--) {
                                s16 tx = (s16)(_pr->x + dx * si / steps);
                                s16 ty = (s16)(_pr->y + dy * si / steps);
                                Point _tp[64];
                                if (engine_astar(_pr->x, _pr->y, tx, ty, _tp, 64) > 0) {
                                    bx = tx; by = ty; break;
                                }
                            }
                        }
                        engine_walk_char(_pr->id, bx, by, 0);
                        /* Registrar pending para mostrar "no puedo llegar" al llegar */
                        g_pending.type = PEND_RESP;
                        _strlcpy(g_pending.obj_id,  "sys.cannot_reach", sizeof(g_pending.obj_id));
                        _strlcpy(g_pending.verb_id, "", sizeof(g_pending.verb_id));
                        g_pending.fn = NULL;
                    }
                    g_selected_verb[0] = '\0';
                } else if (g_selected_verb[0]) {
                    /* Verbo no-movimiento sobre salida: buscar respuesta */
                    char _rk[96];
                    snprintf(_rk, sizeof(_rk), "exit.%.28s.verb.%.28s",
                             clicked_exit->id, g_selected_verb);
                    { const char* _resp = engine_text(_rk);
                      if (_resp && _resp[0] && _resp != _rk) {
                          s16 _ox=-1,_oy=30;
                          if(g_char_count>0){s16 _tw=engine_text_width(VERB_FONT,_resp);_ox=g_chars[g_protagonist].x-_tw/2-(s16)g_cam_x;if(_ox+_tw>AG_SCREEN_W-2)_ox=(s16)(AG_SCREEN_W-_tw-2);if(_ox<2)_ox=2;_oy=(s16)(g_chars[g_protagonist].y/2);if(_oy<4)_oy=4;}
                          _protagonist_talk_start(2000);
                          _overlay_add(_resp,15,_ox,_oy,g_ticks_ms+2000,0);
                      }
                    }
                    g_selected_verb[0] = '\0';
                }
            } else {
                /* Click en suelo: caminar solo si no hay accion pendiente en curso.
                 * Si hay pending (approach a objeto/exit), ignorar el click — cancelar
                 * solo es posible con click derecho o ESC. */
                if (g_pending.type == PEND_NONE) {
                    if (g_char_count > 0)
                        engine_walk_char(g_chars[g_protagonist].id, wx, wy, 0);
                }
            }
        }
        } /* end world coords block */
    }
    prev_buttons = g_mouse.buttons;
    /* Limpiar botones simulados por teclado para que sean eventos de un solo frame */
    g_mouse.buttons &= ~kb_buttons;
    for (i = 0; i < g_char_count; i++) {
        Char* c = &g_chars[i];
        if (!c->walking) continue;

        /* Calcular pixeles a mover este tick segun tiempo transcurrido */
        {
            u32 px_per_sec = c->speed ? (u32)c->speed * 20u : 60u;
            /* Escalar velocidad según perspectiva */
            if (g_scaling_enabled) {
                u8 spct = _get_scale_pct(c->y);
                px_per_sec = px_per_sec * spct / 100;
                if (px_per_sec < 4) px_per_sec = 4;
            }
            u32 elapsed = g_ticks_ms - c->move_timer;
            u32 step;
            /* Acumular hasta que hay al menos 1px a mover */
            if (elapsed == 0) continue;
            step = (px_per_sec * elapsed) / 1000;
            if (step == 0) continue;   /* aun no toca mover */
            c->move_timer = g_ticks_ms;

            while (step > 0 && c->path_cur < c->path_len) {
                Point* wp = &c->path[c->path_cur];
                int dx = wp->x - c->x, dy = wp->y - c->y;
                int dist2 = dx*dx + dy*dy;
                int mv = (int)step;
                if (dist2 <= mv*mv) {
                    c->x = wp->x; c->y = wp->y;
                    c->path_cur++;
                    /* Reducir step por la distancia recorrida */
                    { int d = (int)(dx*dx + dy*dy);
                      int sq = 1;
                      while (sq*sq < d) sq++;
                      step = step > (u32)sq ? step - (u32)sq : 0; }
                } else {
                    /* Normalizar direccion * step */
                    if (dx >  mv) dx =  mv;
                    if (dx < -mv) dx = -mv;
                    if (dy >  mv) dy =  mv;
                    if (dy < -mv) dy = -mv;
                    c->x += (s16)dx; c->y += (s16)dy;
                    step = 0;
                }
                /* Actualizar anim segun el siguiente waypoint.
                 * Si el path esta consumido no tocar cur_anim: walk-complete
                 * usara el ultimo rol valido para seleccionar idle. */
                if (c->path_cur < c->path_len)
                    _char_select_walk_anim(c, c->path[c->path_cur].x, c->path[c->path_cur].y);
            }
        }
        if (c->path_cur >= c->path_len) {
            DBG("walk_complete: i=%d pcur=%d plen=%d x=%d y=%d tx=%d ty=%d\n",
                i,(int)c->path_cur,(int)c->path_len,(int)c->x,(int)c->y,(int)c->target_x,(int)c->target_y);
            /* Snap al destino */
            { int sdx = c->target_x - c->x, sdy = c->target_y - c->y;
              if (sdx < 0) sdx = -sdx; if (sdy < 0) sdy = -sdy;
              if (sdx <= 4 && sdy <= 4) { c->x = c->target_x; c->y = c->target_y; }
            }
            c->walking    = 0;
            c->frame_cur  = 0;
            c->frame_timer = g_ticks_ms;
            c->speed = c->base_speed ? c->base_speed : 2;
            /* Seleccionar idle segun cur_anim (ultimo rol de walk activo).
             * cur_anim es fiable porque el guard de vector-cero en
             * _char_select_walk_anim impide que se sobreescriba en el ultimo step. */
            { int idle_role = ANIM_IDLE;
              if (c->cur_anim == ANIM_WALK_UP && c->anims[ANIM_IDLE_UP].id[0])
                  idle_role = ANIM_IDLE_UP;
              else if (c->cur_anim == ANIM_WALK_DOWN && c->anims[ANIM_IDLE_DOWN].id[0])
                  idle_role = ANIM_IDLE_DOWN;
              CHAR_SET_ANIM(c, idle_role);
              if (c->anims[idle_role].id[0] &&
                  strcmp(c->anims[idle_role].id, c->pcx_loaded) != 0) {
                  u32 sz2;
                  if (c->pcx_buf) { free(c->pcx_buf); c->pcx_buf = NULL; }
                  if (c->dec_buf) { free(c->dec_buf); c->dec_buf = NULL; c->dec_w = 0; c->dec_h = 0; } _spr_cache_free(c->spr_cache); c->spr_cache = NULL;
                  c->pcx_buf = (u8*)engine_dat_load_gfx(c->anims[idle_role].id, &sz2);
                  c->pcx_size = sz2;
                  _strlcpy(c->pcx_loaded, c->anims[idle_role].id, 32);
                  if (c->pcx_buf) {
                      u16 _dw2=0,_dh2=0;
                      _pcx_decode(c->pcx_buf,sz2,g_pcx_decode_buf,&_dw2,&_dh2,0);
                      if (_dw2>0&&_dh2>0) {
                          c->dec_w=_dw2; c->dec_h=_dh2;
                          if ((u32)_dw2*_dh2<=(u32)AG_SCREEN_PIXELS) {
                              c->dec_buf=(u8*)malloc((u32)_dw2*_dh2);
                              if(c->dec_buf) memcpy(c->dec_buf,g_pcx_decode_buf,(u32)_dw2*_dh2);
                          }
                      }
                  }
              }
            }
            /* Ejecutar acción pendiente si este personaje es el protagonista */
            if (i == g_protagonist && g_pending.type != PEND_NONE) {
                DBG("pending ejecutando: type=%d fn=%p obj='%s'\n",
                    g_pending.type, (void*)g_pending.fn, g_pending.obj_id);
                switch (g_pending.type) {
                case PEND_PICKUP: {
                    Obj* _po;
                    g_pending.type = PEND_NONE;   /* reset antes de ejecutar, igual que PEND_HANDLER */
                    _po = _find_obj(g_pending.obj_id);
                    if (!_po) {
                        /* Objeto ya no existe en escena (cambio de room u otro motivo) */
                        break;
                    }
                    _po->visible = 0;
                    engine_give_object(g_pending.obj_id,
                        g_char_count > 0 ? g_chars[g_protagonist].id : "");
                    /* Texto de respuesta del verbo coger si existe */
                    { char _rk[96];
                      snprintf(_rk, sizeof(_rk), "obj.%s.verb.%s",
                               g_pending.obj_id, g_pending.verb_id);
                      { const char* _resp = engine_text(_rk);
                        if (_resp && _resp[0] && _resp != _rk) {
                            s16 _ox=-1,_oy=30;
                            if(g_char_count>0){s16 _tw=engine_text_width(VERB_FONT,_resp);_ox=g_chars[g_protagonist].x-_tw/2-(s16)g_cam_x;if(_ox+_tw>AG_SCREEN_W-2)_ox=(s16)(AG_SCREEN_W-_tw-2);if(_ox<2)_ox=2;_oy=(s16)(g_chars[g_protagonist].y/2);if(_oy<4)_oy=4;}
                            _protagonist_talk_start(2000);
                            _overlay_add(_resp,15,_ox,_oy,g_ticks_ms+2000,0);
                        }
                      }
                    }
                    break;
                }
                case PEND_HANDLER: {
                    void (*fn)(void) = g_pending.fn;
                    /* Encarar al objeto antes de ejecutar el handler */
                    { Obj* _fobj = _find_obj(g_pending.obj_id);
                      if (_fobj && g_char_count > 0) {
                          Char* _fpr = &g_chars[g_protagonist];
                          int _fdx = (int)(_fobj->x - _fpr->x);
                          int _fdy = (int)(_fobj->y - _fpr->y);
                          int _adx = _fdx < 0 ? -_fdx : _fdx;
                          int _ady = _fdy < 0 ? -_fdy : _fdy;
                          const char* _fdir;
                          if (_ady > _adx) _fdir = (_fdy < 0) ? "up" : "down";
                          else             _fdir = (_fdx >= 0)  ? "right" : "left";
                          engine_face_dir(_fpr->id, _fdir);
                      }
                    }
                    g_pending.type = PEND_NONE;
                    g_pending.fn   = NULL;
                    g_selected_verb[0] = '\0';
                    do { _mouse_poll(); } while (g_mouse.buttons);
                    g_script_running = 1;
                    if (fn) fn();
                    do { _mouse_poll(); } while (g_mouse.buttons);
                    g_script_running = 0;
                    break;
                }
                case PEND_RESP: {
                    const char* _resp = NULL;
                    /* Si obj_id empieza por "sys." es una clave directa */
                    if (g_pending.obj_id[0] == 's' && g_pending.obj_id[1] == 'y' &&
                        g_pending.obj_id[2] == 's' && g_pending.obj_id[3] == '.') {
                        _resp = engine_text(g_pending.obj_id);
                        if (_resp == g_pending.obj_id) _resp = NULL;
                    } else {
                        char _rk[96];
                        snprintf(_rk, sizeof(_rk), "obj.%s.verb.%s",
                                 g_pending.obj_id, g_pending.verb_id);
                        _resp = engine_text(_rk);
                        if (_resp == _rk) {
                            /* Fallback: clave de personaje char.ID.verb.VERB */
                            snprintf(_rk, sizeof(_rk), "char.%s.verb.%s",
                                     g_pending.obj_id, g_pending.verb_id);
                            _resp = engine_text(_rk);
                            if (_resp == _rk) _resp = NULL;
                        }
                        if (!_resp && g_verbset_id[0] && g_pending.verb_id[0]) {
                            snprintf(_rk, sizeof(_rk), "verb.%s.%s.default",
                                     g_verbset_id, g_pending.verb_id);
                            _resp = engine_text(_rk);
                            if (_resp == _rk) _resp = NULL;
                        }
                    }
                    if (_resp && _resp[0]) {
                        /* Mostrar sobre el protagonista como globo de diálogo */
                        s16 ox = -1, oy = 30;
                        if (g_char_count > 0) {
                            Char* _pr = &g_chars[g_protagonist];
                            s16 tw = engine_text_width(VERB_FONT, _resp);
                            ox = _text_ox((s16)(_pr->x - (s16)g_cam_x), tw);
                            oy = (s16)(_pr->y / 2);
                            if (oy < 4) oy = 4;
                        }
                        _protagonist_talk_start(2000);
                        _overlay_add(_resp, 15, ox, oy, g_ticks_ms + 2000, 0);
                    }
                    break;
                }
                case PEND_DAR: {
                    /* Ejecutar dar al llegar junto al objetivo */
                    const char* _tgt = g_pending.obj_id;
                    g_pending.type = PEND_NONE;
                    /* Encarar al objetivo */
                    { Char* _dtgt = _find_char(_tgt);
                      if (_dtgt && g_char_count > 0) {
                          Char* _dpr = &g_chars[g_protagonist];
                          int _fdx = (int)(_dtgt->x - _dpr->x);
                          int _fdy = (int)(_dtgt->y - _dpr->y);
                          int _adx = _fdx<0 ? -_fdx : _fdx;
                          int _ady = _fdy<0 ? -_fdy : _fdy;
                          const char* _fdir = (_ady>_adx) ? ((_fdy<0)?"up":"down") : ((_fdx>=0)?"right":"left");
                          engine_face_dir(g_chars[g_protagonist].id, _fdir);
                      }
                    }
                    if (_party_find(_tgt) >= 0) {
                        /* Miembro del party: cambiar char_owner */
                        int _si;
                        for (_si=0; _si<g_inv_count; _si++)
                            if (_str_eq(g_inventory[_si].obj_id, g_dar_inv))
                                { _strlcpy(g_inventory[_si].char_owner, _tgt, 32); break; }
                        _protagonist_give_start();
                    } else {
                        /* NPC: buscar handler engine_on_verb_inv (con prioridad char-específico) */
                        int _dhi; int _dfound=0;
                        _dhi = _find_verb_handler(g_dar_verb, g_dar_inv, 1);
                        if (_dhi >= 0 && g_verb_handlers[_dhi].fn) {
                            _strlcpy(g_dar_target, _tgt, 32);
                            do { _mouse_poll(); } while (g_mouse.buttons);
                            g_script_running=1; g_verb_handlers[_dhi].fn(); g_script_running=0;
                            do { _mouse_poll(); } while (g_mouse.buttons);
                            _dfound=1;
                        }
                        if (!_dfound) {
                            char _rk[96]; const char* _resp=NULL;
                            if (g_verbset_id[0] && g_dar_verb[0]) {
                                snprintf(_rk,sizeof(_rk),"verb.%s.%s.default",g_verbset_id,g_dar_verb);
                                _resp=engine_text(_rk); if(_resp==_rk)_resp=NULL;
                            }
                            if (_resp && _resp[0]) {
                                s16 ox=-1,oy=30;
                                if(g_char_count>0){Char*_pr=&g_chars[g_protagonist];s16 tw=engine_text_width(VERB_FONT,_resp);ox=_text_ox((s16)(_pr->x-(s16)g_cam_x),tw);oy=(s16)(_pr->y/2);if(oy<4)oy=4;}
                                _protagonist_talk_start(2000);
                                _overlay_add(_resp,15,ox,oy,g_ticks_ms+2000,0);
                            }
                        }
                    }
                    g_dar_mode=0; g_dar_inv[0]='\0'; g_dar_base[0]='\0';
                    _reset_verb_action();
                    break;
                }
                default: break;
                }
                g_pending.type = PEND_NONE;
            }
        }
    }
    /* Restaurar idle tras animación de hablar automático */
    _talk_restore_check();
    /* Timer línea de acción: resetear al verbo de movimiento si expiró */
    if (g_action_timer && g_ticks_ms >= g_action_timer) {
        g_action_timer = 0;
        { int _vi; _strlcpy(g_action_text, "Walk", sizeof(g_action_text));
          for (_vi=0; _vi<g_verb_count; _vi++)
              if (g_verbs[_vi].is_movement) { _strlcpy(g_action_text, g_verbs[_vi].label, sizeof(g_action_text)); break; }
        }
    }

    if (!g_bg_fullscreen) _check_exits();

    _input_done:;
    return 1;
}

/* ===========================================================================
 * S19 - TIMING
 * =========================================================================== */

u32 engine_ticks(void) { return g_ticks_ms; }

void engine_wait_ms(u32 ms) {
    u32 until = g_ticks_ms + ms;
    while (g_ticks_ms < until) {
        engine_flip(); /* mantener pantalla viva durante espera */
    }
}

/* ===========================================================================
 * S14b - TEXTO EN SECUENCIA
 * =========================================================================== */

/* Dibuja texto de secuencia en pantalla completa.
 * bg_color_idx : 0xFF = sin fondo; cualquier otro = memset pantalla entera con ese color.
 * position : "top"/"center"/"bottom"  align : "left"/"center"/"right" */
static void _seq_draw_text_full(const char* txt, u8 font_idx,
                                 u8 color_fill, u8 bg_color_idx,
                                 const char* position, const char* align) {
    const FontSlot* f;
    const char* p;
    const char* q;
    s16 line_h, total_lines, start_y, x, y;
    int n_lines = 1;

    if (font_idx >= FONT_COUNT) font_idx = FONT_SMALL;
    f = &g_fonts[font_idx];
    if (!f->ok) return;

    /* Rellenar pantalla entera con color de fondo si se especifica */
    if (bg_color_idx != 0xFF)
        memset(g_backbuf, bg_color_idx, AG_SCREEN_PIXELS);

    /* Contar lineas */
    for (q = txt; *q; q++) if (*q == '\n') n_lines++;
    line_h      = (s16)(f->gh + 2);
    total_lines = (s16)n_lines;

    /* Posicion vertical */
    if (_str_eq(position, "top"))
        start_y = 8;
    else if (_str_eq(position, "center"))
        start_y = (s16)((AG_SCREEN_H - total_lines * line_h) / 2);
    else /* bottom */
        start_y = (s16)(AG_SCREEN_H - total_lines * line_h - 8);

    /* Dibujar linea a linea */
    p = txt;
    y = start_y;
    while (1) {
        char line_buf[MAX_TEXT_LEN+1];
        int len = 0;
        while (*p && *p != '\n' && len < MAX_TEXT_LEN)
            line_buf[len++] = *p++;
        line_buf[len] = '\0';
        if (*p == '\n') p++;

        { s16 tw = engine_text_width(font_idx, line_buf);
          if (_str_eq(align, "left"))       x = 8;
          else if (_str_eq(align, "right")) x = (s16)(AG_SCREEN_W - tw - 8);
          else                              x = (s16)((AG_SCREEN_W - tw) / 2);
        }
        engine_draw_text(x, y, font_idx, color_fill, 0, line_buf);

        y = (s16)(y + line_h);
        if (!*p) break;
    }
}

/* ===========================================================================
 * S20 - INIT, LOOP Y SHUTDOWN
 * =========================================================================== */

void engine_init(const char* game_title) {
    (void)game_title;
    _dbg_open();
    DBG("=== engine_init: %s ===\n", game_title ? game_title : "");
    DBG("=== BUILD: %s %s ===\n", __DATE__, __TIME__);
    memset(g_chars,   0, sizeof(g_chars));
    memset(g_objects, 0, sizeof(g_objects));
    memset(g_flags,   0, sizeof(g_flags));
    memset(g_attrs,   0, sizeof(g_attrs));
    memset(g_fonts,   0, sizeof(g_fonts));
    g_running = 1;

    _timer_install();
    _vga_set_mode13();
    _mouse_init();
    engine_dat_open_all();
    /* Cargar idioma: leer CONFIG.CFG, fallback a "es" */
    { char cfg_lang[CFG_LANG_LEN];
      if (_config_read_lang(cfg_lang, sizeof(cfg_lang))) {
          char lang_id[40];
          _strlcpy(lang_id, "lang_", sizeof(lang_id));
          _strlcpy(lang_id + 5, cfg_lang, sizeof(lang_id) - 5);
          _load_language_by_id(lang_id);
          _strlcpy(g_active_lang, cfg_lang, sizeof(g_active_lang));
          DBG("Language from CONFIG.CFG: %s\n", cfg_lang);
      } else {
          _load_language_by_id("lang_es");
          _strlcpy(g_active_lang, "es", sizeof(g_active_lang));
          DBG("Language default: es\n");
      }
    }
    /* Cargar volumen y preferencia de audio desde CONFIG.CFG */
    { int v = _config_read_int(CFG_VOL_KEY, 100);
      if (v < 0) v = 0; if (v > 100) v = 100;
      g_cfg_volume = v;
      DBG("Volume from CONFIG.CFG: %d\n", g_cfg_volume);
    }
    { char cfg_aud[16];
      if (_config_read_val(CFG_AUDIO_KEY, cfg_aud, sizeof(cfg_aud)))
          _strlcpy(g_cfg_audio, cfg_aud, sizeof(g_cfg_audio));
      DBG("Audio pref from CONFIG.CFG: %s\n", g_cfg_audio);
      /* Propagar preferencia al sistema de audio ANTES de que el juego
       * llame a engine_audio_init() para que mdrv_install() la respete */
      engine_audio_set_pref(g_cfg_audio);
    }
    /* Cargar preferencia SFX y volumen SFX desde CONFIG.CFG */
    { int sfx_val = _config_read_int(CFG_SFX_KEY, 1);
      g_cfg_sfx = (sfx_val != 0) ? 1 : 0;
      DBG("SFX pref from CONFIG.CFG: %d\n", g_cfg_sfx);
      engine_audio_set_sfx_pref(g_cfg_sfx);
    }
    { int v = _config_read_int(CFG_SFX_VOL_KEY, 100);
      if (v < 0) v = 0; if (v > 100) v = 100;
      g_cfg_sfx_vol = v;
      DBG("SFX vol from CONFIG.CFG: %d\n", g_cfg_sfx_vol);
      engine_set_sfx_volume((unsigned)(g_cfg_sfx_vol * 127 / 100));
    }
    { int v = _config_read_int(CFG_FPS_KEY, 0);
      g_cfg_show_fps = (v != 0) ? 1 : 0;
      DBG("show_fps from CONFIG.CFG: %d\n", g_cfg_show_fps);
    }

    /* Cargar fuentes bitmap desde FONTS.DAT */
    engine_font_load(FONT_SMALL,  "small");
    engine_font_load(FONT_MEDIUM, "medium");
    engine_font_load(FONT_LARGE,  "large");
    DBG("fonts loaded: small.ok=%d medium.ok=%d large.ok=%d\n",
        g_fonts[0].ok, g_fonts[1].ok, g_fonts[2].ok);


    if (g_on_game_start) g_on_game_start();
}

void engine_loop(void) {
    while (g_running) {
        engine_audio_update(); /* procesar MIDI pendiente */
        if (!engine_process_input()) break;
        engine_flip();
    }
    if (!g_restart_requested) engine_quit();
}

int engine_restart_requested(void) {
    int r = g_restart_requested;
    g_restart_requested = 0;
    return r;
}

void engine_reset_game(void) {
    int i;
    /* Inventario */
    for (i = 0; i < g_inv_count; i++) {
        if (g_inventory[i].owns_buf && g_inventory[i].pcx_buf)
            free(g_inventory[i].pcx_buf);
    }
    g_inv_count      = 0;
    g_inv_scroll     = 0;
    g_inv_hover      = -1;
    g_selected_inv[0]= '\0';
    /* Party */
    { int _pi;
      for (_pi = 0; _pi < g_party_count; _pi++)
          if (g_party[_pi].face_pcx_buf) {
              free(g_party[_pi].face_pcx_buf);
              g_party[_pi].face_pcx_buf = NULL;
          }
    }
    g_party_count            = 0;
    g_party_popup_open       = 0;
    g_suppress_prot_reinject = 0;
    g_party_switch_pending[0]= '\0';
    /* Estados persistentes de objetos */
    g_obj_state_persist_count = 0;
    /* Flags y atributos */
    g_flag_count = 0;
    g_attr_count = 0;
    /* Estado UI */
    g_selected_verb[0] = '\0';
    g_action_text[0]   = '\0';
    g_script_running   = 0;
    g_ui_hidden        = 0;
    /* Reactivar bucle */
    g_running           = 1;
    g_restart_requested = 0;
}

void engine_quit(void) {
    int i;
    g_running = 0;
    /* Liberar PCX de personajes y objetos */
    for (i = 0; i < g_char_count; i++)
        if (g_chars[i].pcx_buf) free(g_chars[i].pcx_buf);
    for (i = 0; i < g_obj_count; i++) {
        if (g_objects[i].pcx_buf)     free(g_objects[i].pcx_buf);
        if (g_objects[i].inv_pcx_buf) free(g_objects[i].inv_pcx_buf);
    }
    /* Liberar buffers propios del inventario */
    { int _i; for (_i=0;_i<g_inv_count;_i++)
        if (g_inventory[_i].owns_buf && g_inventory[_i].pcx_buf)
            { free(g_inventory[_i].pcx_buf); g_inventory[_i].pcx_buf=NULL; } }
    /* Liberar caras del grupo de protagonistas */
    { int _pi; for (_pi=0;_pi<g_party_count;_pi++)
        if (g_party[_pi].face_pcx_buf)
            { free(g_party[_pi].face_pcx_buf); g_party[_pi].face_pcx_buf=NULL; } }
    /* Liberar fuentes */
    _fonts_free();
    /* Cerrar DAT */
    if (g_gfx_f)   { free(g_gfx_idx);   fclose(g_gfx_f);   }
    if (g_fnt_f)   { free(g_fnt_idx);   fclose(g_fnt_f);   }
    if (g_scr_f)   { free(g_scr_idx);   fclose(g_scr_f);   }
    if (g_audio_f) { free(g_audio_idx);  fclose(g_audio_f); }
    if (g_text_f)  { free(g_text_idx);   fclose(g_text_f);  }
    /* Apagar audio ANTES de restaurar el timer — Allegro necesita
     * su timer activo para desengancharse limpiamente */
    engine_audio_shutdown();
    _timer_remove();
    _vga_set_text();
    _dbg_close();
}
