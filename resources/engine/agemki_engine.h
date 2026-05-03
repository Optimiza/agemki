/* ============================================================
 * agemki_engine.h ? AGEMKI Engine API v1
 * Motor base para juegos de aventura DOS generados por AGEMKI.
 * Compilar con Open Watcom C/C++ para DOS (modo protegido DPMI).
 *
 * Uso:
 *   #include "agemki_engine.h"
 *   ? en main.c (generado por el editor)
 *   ? en agemki_engine.c (implementaci?n)
 * ============================================================ */
#ifndef AGEMKI_ENGINE_H
#define AGEMKI_ENGINE_H

/* Tipos enteros portables sin stdint.h (Open Watcom DOS) */
#ifndef AGEMKI_INTTYPES_DEFINED
#define AGEMKI_INTTYPES_DEFINED
/* Tipos enteros de anchura fija — usar stdint.h si disponible */
#if defined(__WATCOMC__) || defined(_MSC_VER) || defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L
#  include <stdint.h>
#else
typedef unsigned char  uint8_t;
typedef unsigned short uint16_t;
typedef unsigned long  uint32_t;
typedef signed short   int16_t;
typedef signed long    int32_t;
#endif
#ifndef NULL
#define NULL 0
#endif
#endif
#include "agemki_dat.h"

/* ?? Constantes de pantalla ???????????????????????????????????????????????? */
#define AG_SCREEN_W     320
#define AG_SCREEN_H     200
#define AG_SCREEN_PIXELS (AG_SCREEN_W * AG_SCREEN_H)
/* Compatibilidad: SCREEN_W/H solo si Allegro no los define */
#ifndef SCREEN_W
#  define SCREEN_W AG_SCREEN_W
#  define SCREEN_H AG_SCREEN_H
#endif
#define SCREEN_PIXELS   AG_SCREEN_PIXELS
#define GAME_H          144   /* altura del ?rea de juego */
#define UI_Y            144   /* primera fila del ?rea de UI */
#define UI_H            56    /* altura del ?rea de UI (filas 144-199) */
#define VGA_SEG         0xA000  /* segmento de video VGA modo 13h */

/* ?? L?mites del motor ????????????????????????????????????????????????????? */
#define MAX_FLAGS       256     /* flags globales del juego */
#define MAX_VARS        64      /* variables locales de script */
#define MAX_CHARS       16      /* personajes en una room */
#define MAX_OBJECTS     32      /* objetos en una room */
#define MAX_EXITS       16      /* exits en una room */
#define MAX_ENTRIES     16      /* entry points en una room */
#define MAX_WALK_RECTS  64      /* rect?ngulos de walkmap */
#define MAX_VERB_HANDLERS 128   /* handlers verbo+objeto registrados */
#define MAX_TEXT_LEN    255     /* longitud m?xima de texto en pantalla */
#define MAX_INVENTORY   32      /* objetos en inventario del protagonista */
#define MAX_DIALOGUE_NODES 64   /* nodos en un di?logo */
#define MAX_DIALOGUE_OPTS  8    /* opciones por nodo de di?logo */
#define MAX_ANIM_FRAMES    16   /* frames por animaci?n */
#define MAX_ROOM_LIGHTS    8    /* fuentes de luz por room */

/* ?? Tipos base ???????????????????????????????????????????????????????????? */
typedef uint8_t       u8;
typedef uint16_t      u16;
typedef uint32_t      u32;
typedef signed char   s8;
typedef int16_t       s16;
typedef int32_t  s32;

/* ?? Tabla de rooms (generada en main.c) ??????????????????????????????????? */
typedef struct {
    const char* id;
    void (*load_fn)(void);
} RoomEntry;

/* — Nodo de diálogo (generado en main.c) ----------------------------------- */
typedef struct {
    const char* text_key;      /* localeKey para la opción */
    const char* condition;     /* condición como string serializado, "" = siempre */
    const char* next_node_id;  /* id del nodo siguiente, "" = fin */
    const char* char_filter;   /* "" = visible a todos; id de personaje = solo para ese protagonista */
    const char* text_key_once; /* texto alternativo que se muestra SOLO la primera vez; "" = sin alternativo */
    u8          once;          /* 1 = ocultar esta opción tras elegirla por primera vez */
} DialogueOption;

#define MAX_DIALOGUE_LINES 4   /* líneas simultáneas por nodo */

typedef struct {
    const char* speaker_id;  /* "" = narrador */
    const char* text_key;
    const char* animation;   /* animación del actor al hablar, "" = ninguna */
    const char* direction;   /* orientación del actor, "" = sin cambio */
    const char* char_filter; /* "" = visible a todos; id de personaje = solo para ese protagonista */
} DialogueLine;

typedef struct {
    const char*     id;
    DialogueLine    lines[MAX_DIALOGUE_LINES];
    int             num_lines;
    DialogueOption  options[MAX_DIALOGUE_OPTS];
    int             num_options;
} DialogueNode;

/* ?? Rect y punto ?????????????????????????????????????????????????????????? */
typedef struct { s16 x, y, w, h; } Rect;
typedef struct { s16 x, y;       } Point;

/* ???????????????????????????????????????????????????????????????????????????
 * API DEL MOTOR
 * ??????????????????????????????????????????????????????????????????????????? */

/* ?? Sistema ??????????????????????????????????????????????????????????????? */

/* Inicializa el motor: VGA 13h, input, DAT, texto. */
void engine_init(const char* game_title);

/* Registra la tabla de rooms generada en main.c. */
void engine_set_room_table(const RoomEntry* rooms);

/* Bucle principal. Retorna cuando g_running=0 (quit o restart). */
void engine_loop(void);

/* Devuelve 1 si se pidio reiniciar la partida (y limpia el flag). */
int  engine_restart_requested(void);

/* Reinicia el estado del juego (inventario, flags, atributos, UI). */
void engine_reset_game(void);

/* Se?al de salida limpia (restaura modo texto, libera RAM). */
void engine_quit(void);

/* ?? DAT ??????????????????????????????????????????????????????????????????? */

/* Abre GRAPHICS.DAT, AUDIO.DAT y TEXT.DAT. Carga ?ndices en RAM. */
void engine_dat_open_all(void);

/* Carga un recurso gr?fico por id. El llamador debe liberar con engine_free(). */
void* engine_dat_load_gfx(const char* id, u32* out_size);

/* Carga un recurso de fuente por id (FONTS.DAT, fallback a GRAPHICS.DAT). */
void* engine_dat_load_font(const char* id, u32* out_size);

/* Carga un recurso de scripts/datos por id (SCRIPTS.DAT). */
void* engine_dat_load_scripts(const char* id, u32* out_size);

/* Carga un recurso de audio por id. El llamador debe liberar con engine_free(). */
void* engine_dat_load_audio(const char* id, u32* out_size);

/* Aplica una paleta VGA de 256 colores (768 bytes RGB 0-255).
 * Llamar desde main() antes del primer engine_flip(). */
void engine_set_palette(const u8* rgb256);

/* Obtiene un texto traducido por clave. Devuelve puntero a buffer interno (no liberar). */
const char* engine_text(const char* key);

/* ?? Fuentes bitmap (?14b) ????????????????????????????????????????????????? */
#define FONT_SMALL   0
#define FONT_MEDIUM  1
#define FONT_LARGE   2
#define FONT_COUNT   3

/* Carga fuente desde GRAPHICS.DAT. Llamar en engine_init o tras abrir DATs. */
void engine_font_load(u8 font_idx, const char* gfx_id);

/* Dibuja texto en el backbuf.
 * color_idx: ?ndice de paleta VGA (15=blanco, 14=amarillo?).
 * shadow: 1=sombra negra 1px abajo-derecha. */
void engine_draw_text(s16 x, s16 y, u8 font_idx, u8 color_idx, u8 shadow,
                      const char* txt);

/* Ancho en p?xeles de una cadena con la fuente indicada. */
s16 engine_text_width(u8 font_idx, const char* txt);

/* Libera un buffer cargado desde DAT. */
void engine_free(void* ptr);

/* ?? Gr?ficos ?????????????????????????????????????????????????????????????? */

/* Carga y muestra el PCX de fondo de la room actual. */
void engine_load_bg(const char* gfx_id);
void engine_set_room_no_save(int v);  /* 1 = deshabilitar guardado en esta sala */
/* Carga PCX 320x200 como fondo a pantalla completa. Activa modo fullscreen: sin UI, sin hover. */
void engine_load_bg_fullscreen(const char* gfx_id);
/* Desactiva modo fullscreen y restaura UI normal. */
void engine_exit_fullscreen(void);
void engine_set_cam_x(s16 px_x);
void engine_set_room_scroll(u16 scroll_w); /* 0=sin scroll, >320=activa follow */   /* scroll horizontal de camara */
void engine_set_scroll_halves(u16 half_w); /* scroll tipo Scumm Bar: pan a mitad izq/der */

/* Dibuja un sprite PCX en (x,y). frame_x = offset horizontal en el spritesheet. */
void engine_draw_sprite(const char* gfx_id, s16 x, s16 y, u16 frame_x, u16 frame_w);

/* Vuelca el back-buffer a VGA. Llamado autom?ticamente por engine_loop(). */
void engine_flip(void);

/* Borra el back-buffer con el color de ?ndice dado. */
void engine_clear(u8 color_idx);

/* ?? Texto en pantalla ????????????????????????????????????????????????????? */

/* Muestra texto (clave de locale) durante ms milisegundos. */
/* position: "bottom" | "top" | "center"  align: "left"|"center"|"right"|"justify" */
void engine_set_language(const char* lang_code); /* ej: "es", "en", "ca", "fr" */
void engine_show_text(const char* locale_key);
void engine_show_text_ex(const char* locale_key, u8 color, u32 duration_ms);
/* Hablar bloqueante con animacion de hablar segun direccion del protagonista.
 * char_id puede ser NULL (usa protagonista activo). Soporta \n en el texto. */
void engine_say(const char* char_id, const char* text_key);
/* Como engine_say pero reproduce un rol de animacion especifico en lugar del automatico. */
void engine_say_anim(const char* char_id, const char* text_key, const char* anim_role);

/* Escalado de personajes por perspectiva */
void engine_clear_scale_zones(void);
void engine_add_scale_zone(s16 y0, s16 y1, u8 type, u8 pct0, u8 pct1);
void engine_seq_show_text(const char* locale_key, const char* font,
                          u8 color_idx, u8 bg_color_idx, u8 has_bg_color,
                          const char* bg_pcx_id,
                          const char* position, const char* align,
                          const char* effect, u16 typewriter_speed,
                          u32 duration_ms);

/* Texto con scroll vertical (efecto Star Wars). */
void engine_seq_scroll_text(const char* locale_key, const char* color,
                            const char* align, s16 speed,
                            s16 y_start, s16 y_end, s16 x_center, s16 angle);
void engine_seq_scroll_text_ex(const char* locale_key, u8 color_idx,
                                const char* align, s16 speed);
void engine_seq_move_text(const char* locale_key, u8 font_idx, u8 color_idx,
                           s16 x0, s16 y0, s16 x1, s16 y1, s16 speed,
                           int bg_type, u8 bg_color, const char* bg_pcx_id,
                           u8 blocking);
void engine_seq_move_text_nb(const char* locale_key, u8 font_idx, u8 color_idx,
                              s16 x0, s16 y0, s16 x1, s16 y1, s16 speed,
                              int bg_type, u8 bg_color, const char* bg_pcx_id);

/* --- Nuevas funciones de secuencia ---------------------------------------- */
void engine_play_rooms(const char* flag, const char* value);
void engine_resume_sequence(void);
void engine_hide_ui(void);
void engine_show_ui(void);
void engine_seq_solid_color(u8 color_idx, u32 duration_ms);
void engine_seq_fade_to_color(u8 color_idx, u32 duration_ms);
void engine_seq_fade_from_color(u8 color_idx, u32 duration_ms);
void engine_seq_color_fade(u8 from_color, u8 to_color, u32 duration_ms);
void engine_seq_show_pcx(const char* gfx_id, u32 duration_ms);
void engine_seq_show_bg(const char* gfx_id, u32 duration_ms, u8 show_ui);
void engine_walk_char_nb(const char* char_id, s16 x, s16 y, u8 speed);
void engine_wait_all_chars(void);
void engine_seq_set_anim(const char* char_id, const char* anim_name,
                         u8 fps_override, u8 loop, u32 duration_ms);
void engine_seq_face_dir(const char* char_id, const char* dir);
void engine_seq_set_char_visible(const char* char_id, int visible);

/* Borra el texto de la barra de acci?n. */
void engine_clear_text(void);

/* ?? Rooms ????????????????????????????????????????????????????????????????? */

/* Cambia a otra room entrando por entry_id. Libera recursos de la room actual. */
void engine_change_room(const char* room_id, const char* entry_id);
/* Entra en una room de primer plano (closeup): guarda room anterior, suprime reinyección del protagonista.
 * show_ui: 1 = mantener UI de verbos (puzzles/tienda), 0 = ocultarla (diálogos/cutscenes). */
void engine_enter_closeup(const char* room_id, int show_ui);
/* Sale del closeup y regresa a la room guardada por engine_enter_closeup. */
void engine_exit_closeup(void);

/* Registra un entry point en la room actual (llamado desde room_*() generado). */
void engine_register_entry(const char* id, s16 x, s16 y);

/* Iluminacion de room (llamar desde room_*() generado, antes o despues de engine_load_bg). */
void engine_set_ambient_light(u8 pct);   /* 0=oscuro, 100=normal (defecto) */
void engine_add_room_light(s16 x, s16 y, s16 radius, u8 intensity,
                           u16 cone_angle, s8 dir_x, s8 dir_y,
                           u8 flicker_amp, u8 flicker_hz);
/* Asigna una linterna/antorcha a un personaje. La luz sigue su posicion y orientacion. */
void engine_char_set_light(const char* char_id,
                           s16 off_x, s16 off_y, s16 radius, u8 intensity,
                           u16 cone_angle, u8 flicker_amp, u8 flicker_hz);

/* Registra un exit en la room actual.
 * initial_enabled: 1=libre (defecto), 0=bloqueado en diseño.
 * Si el script lo cambió en visitas anteriores, ese estado tiene prioridad. */
void engine_register_exit(const char* id, s16 x, s16 y, s16 w, s16 h,
                          const char* target_room, const char* target_entry,
                          const char* name_key, u8 initial_enabled);
/* Activa (1) o desactiva (0) un exit. Un exit desactivado no es clickable ni transitable. */
void engine_set_exit_enabled(const char* exit_id, u8 enabled);

/* ?? Walkmap ??????????????????????????????????????????????????????????????? */

/* Limpia la walkmap de la room actual. */
void engine_walkmap_clear(void);
void engine_walkmap_load_bitmap(const unsigned char* bm, int w, int h);

/* A?ade un rect?ngulo navegable. */
void engine_walkmap_add_rect(s16 x, s16 y, s16 w, s16 h);

/* A?ade un pol?gono navegable (pts = array de pares x,y, n = n?mero de puntos). */
void engine_walkmap_add_poly(int* pts, int n);

/* Cambia qu? walkmap est? activo (para puzzles). */
void engine_set_walkmap(const char* walkmap_id);

/* ?? Personajes ???????????????????????????????????????????????????????????? */

/* Coloca un personaje en (x,y) con todos sus datos de animaci?n hardcodeados.
 * Los par?metros se generan por el compilador desde las constantes #define de main.c
 * ? cero b?squeda de strings en runtime. */
void engine_place_char(const char* char_id, s16 x, s16 y,
    /* idle */        const char* idle_pcx,  int idle_frames,  int idle_fps,  int idle_fw,
    /* walk_right */  const char* wr_pcx,    int wr_frames,    int wr_fps,    int wr_fw,
    /* walk_left */   const char* wl_pcx,    int wl_frames,    int wl_fps,    int wl_fw,  int wl_flip,
    /* walk_up */     const char* wu_pcx,    int wu_frames,    int wu_fps,    int wu_fw,
    /* walk_down */   const char* wd_pcx,    int wd_frames,    int wd_fps,    int wd_fw,
    /* idle_up */     const char* idu_pcx,   int idu_frames,   int idu_fps,   int idu_fw,
    /* idle_down */   const char* idd_pcx,   int idd_frames,   int idd_fps,   int idd_fw,
    /* misc */        int speed,             int is_protagonist);

/* Teleporta un personaje a (x,y) sin animaci?n. */
void engine_move_char(const char* char_id, s16 x, s16 y);
void engine_remove_char(const char* char_id);

/* Desplaza un personaje a (x,y) con pathfinding A* y animaci?n de caminar. */
/* speed: 0=velocidad por defecto del personaje, 1-10=velocidad manual. */
void engine_walk_char(const char* char_id, s16 x, s16 y, u8 speed);

/* Desplaza un personaje junto a un objeto (el motor calcula la posici?n). */
void engine_walk_char_to_obj(const char* char_id, const char* obj_id, u8 speed);
void engine_walk_char_direct(const char* char_id, s16 x, s16 y, u8 speed);

/* Bloquea hasta que el personaje llega a su destino (para secuencias). */
void engine_wait_walk(const char* char_id);

/* Cambia la animaci?n activa de un personaje (permanente hasta el siguiente). */
void engine_set_anim(const char* char_id, const char* anim_name);
void engine_set_anim_pcx(const char* char_id, const char* pcx_id, int frames, int fps, int fw);
/* Registra la animaci?n de hablar del personaje (se activa en respuestas autom?ticas). */
void engine_set_char_talk_anim(const char* char_id, const char* pcx, int frames, int fps, int fw);
void engine_set_char_talk_anim_left(const char* char_id, const char* pcx, int frames, int fps, int fw);
void engine_set_char_talk_anim_up(const char* char_id, const char* pcx, int frames, int fps, int fw);
void engine_set_char_talk_anim_down(const char* char_id, const char* pcx, int frames, int fps, int fw);
void engine_set_char_give_anim(const char* char_id, const char* pcx, int frames, int fps, int fw);

/* Reproduce una animaci?n una vez y vuelve a la anterior. */
void engine_play_anim(const char* char_id, const char* anim_name);

/* Orienta el personaje en una direcci?n: "left"|"right"|"up"|"down". */
void engine_face_dir(const char* char_id, const char* direction);
void engine_set_char_subtitle_color(const char* char_id, u8 color);

/* Muestra u oculta un personaje. */
void engine_set_char_visible(const char* char_id, int visible);

/* Cambia el protagonista activo. */
void engine_change_protagonist(const char* char_id);

/* -- Party (protagonistas simultaneos) ------------------------------------- */
/* Añade un personaje al grupo de protagonistas.
 * place_fn: funcion generada en main.c para reinyectarlo si la room no lo coloca. */
void engine_party_add(const char* char_id, void (*place_fn)(s16, s16));
/* Elimina un personaje del grupo. */
void engine_party_remove(const char* char_id);
/* Asigna el PCX de cara a un miembro del grupo (carga en RAM). */
void engine_set_char_face_sprite(const char* char_id, const char* face_pcx_id);
/* Cambia al protagonista indicado; si está en otra room, hace cambio de room. */
void engine_switch_protagonist(const char* char_id);
/* Devuelve 1 si el personaje esta en la room actual. */
int  engine_char_in_room(const char* char_id);
/* Configura los colores del popup selector de protagonistas (indices paleta VGA). */
void engine_set_party_btn_sprite(const char* pcx_id, const char* pcx_hover_id);
/* Colores del menú de juego (barra de verbos + inventario). */
void engine_set_ui_colors(u8 bg, u8 action, u8 sel, u8 inv_hov);
/* Colores del menú de pausa (ESC): fondo, botón normal, botón hover, borde, texto, item activo. */
void engine_set_menu_colors(u8 bg, u8 btn, u8 sel, u8 brd, u8 txt, u8 act);
void engine_set_party_popup_colors(u8 bg, u8 border, u8 active, u8 hover);
void engine_set_dialogue_colors(u8 bg, u8 brd, u8 txt, u8 sel);

/* ?? Objetos ??????????????????????????????????????????????????????????????? */

/* Coloca una instancia de objeto en la room actual. */
void engine_place_object(const char* inst_id, const char* obj_id, const char* gfx_id, s16 x, s16 y);
void engine_register_obj_inv_gfx(const char* obj_id, const char* inv_gfx_id);

/* Versión extendida: pickable=1 si se puede coger, inv_gfx_id=icono de inventario (puede ser ""). */
void engine_place_object_ex(const char* inst_id, const char* obj_id, const char* gfx_id, s16 x, s16 y,
                             u8 pickable, const char* inv_gfx_id);

/* Registra un estado visual estático para un objeto. */
void engine_add_object_state(const char* obj_id, const char* state_id, const char* gfx_id);

/* Registra un estado visual animado. El spritesheet es horizontal: frames×fw px de ancho.
 * fw=0: el motor calcula fw = PCX_width / frames. */
void engine_add_object_state_anim(const char* obj_id, const char* state_id, const char* gfx_id,
                                   u8 frames, u8 fps, u16 fw);

/* Mueve un objeto en la room actual. */
void engine_move_object(const char* obj_id, s16 x, s16 y);

/* Cambia el estado visual de un objeto. */
void engine_set_object_state(const char* obj_id, const char* state_id);

/* Muestra u oculta un objeto. */
void engine_set_object_visible(const char* obj_id, int visible);
/* loop=1: animacion en bucle infinito (defecto). loop=0: one-shot, para en el ultimo frame. */
void engine_set_object_anim_loop(const char* obj_id, int loop);
/* Resetea la animacion al frame 0 (para relanzar one-shots). */
void engine_reset_object_anim(const char* obj_id);
/* Configura animacion ambiental periodica (tipo Scumm Bar).
 * ambient_state_key: estado a activar; debe tener frames>1 y anim_loop=0 en el editor.
 * El objeto vuelve automaticamente al estado base tras completar la animacion. */
void engine_set_object_ambient(const char* obj_id, const char* ambient_state_key,
                                unsigned int min_ms, unsigned int max_ms);
/* Bloquea la secuencia hasta que la animacion one-shot del objeto llegue al ultimo frame. */
void engine_seq_wait_object_anim(const char* obj_id);

/* Activa o desactiva la detección por cursor. 0 = se dibuja pero sin hover, nombre ni verbos. */
void engine_set_object_detectable(const char* obj_id, int detectable);
/* 1 = el objeto se dibuja DESPUES del lightmap (tapa la oscuridad; usar para primer plano). */
void engine_set_object_over_light(const char* obj_id, int over_light);
/* 1 = el objeto se dibuja justo encima del fondo, antes de personajes (suelos, plataformas). */
void engine_set_object_bg_layer(const char* obj_id, int bg_layer);

/* Añade un objeto al inventario del protagonista (con icono si el objeto tiene inv_gfx). */
void engine_give_object(const char* obj_id, const char* char_id);

/* Flujo completo de pickup: mostrar frase, caminar, ocultar objeto, añadir al inventario. */
void engine_pickup_object(const char* obj_id, const char* verb_id);

/* Quita un objeto del inventario. */
void engine_remove_object(const char* obj_id, const char* char_id);

/* Suelta un objeto en una posici?n del mundo. */
void engine_drop_object(const char* obj_id, const char* room_id, s16 x, s16 y);

/* ?? Flags y atributos ????????????????????????????????????????????????????? */

/* Establece un flag global (value = "true"/"false"/n?mero como string). */
void engine_set_flag(const char* name, const char* value);

/* Lee un flag global. Devuelve 0 si no existe o es false. */
int  engine_get_flag(const char* name);

/* Eval?a una condici?n serializada como JSON string. Devuelve 0/1. */
int  engine_eval_cond(const char* cond_json);

/* Establece un atributo num?rico de personaje u objeto. */
void engine_set_attr(const char* target, const char* attr, const char* value);

/* Suma a un atributo (puede ser negativo). */
void engine_add_attr(const char* target, const char* attr, const char* amount);
int  engine_get_attr(const char* target, const char* attr);
void engine_set_death_attr(const char* attr_id);

/* ?? Verbset ??????????????????????????????????????????????????????????????? */

/* Cambia el conjunto de verbos activo. */
void engine_set_verbset(const char* verbset_id);

/* ?? Handlers de eventos (registrados en register_verb_handlers) ??????????? */

/* Registra un handler para verbo+objeto. */
void engine_on_verb_object(const char* verb_id, const char* obj_id,
                           void (*handler)(void));
/* Variante con filtro de protagonista: solo se activa si char_id es el protagonista activo. */
void engine_on_verb_object_char(const char* verb_id, const char* obj_id,
                                const char* char_id, void (*handler)(void));

/* Registra un handler para clic simple en objeto. */
void engine_on_verb_inv(const char* verb_id, const char* inv_obj_id,
                        void (*handler)(void));
/* Variante con filtro de protagonista. */
void engine_on_verb_inv_char(const char* verb_id, const char* inv_obj_id,
                             const char* char_id, void (*handler)(void));
/* require_both_inv=1: el script solo ejecuta si el target tambien esta en inv. */
void engine_on_usar_con(const char* inv_obj_id, const char* target_id,
                        void (*handler)(void), int require_both_inv);
/* Variante con filtro de protagonista. */
void engine_on_usar_con_char(const char* inv_obj_id, const char* target_id,
                             const char* char_id, void (*handler)(void), int require_both_inv);
void engine_on_object_click(const char* obj_id, void (*handler)(void));
/* Devuelve el id del personaje objetivo del último verbo dar ejecutado. */
const char* engine_get_dar_target(void);
/* Marca un verbo del verbset activo como verbo "dar" (seleccionar inv → esperar personaje). */
void engine_set_give_verb(const char* verb_id);

/* Registra el script de inicio de partida. */
void engine_on_game_start(void (*handler)(void));

/* Registra un handler para cuando acaba una secuencia. */
void engine_on_sequence_end(const char* seq_id, void (*handler)(void));

/* Registra callbacks de room (llamados desde room_*() generado). */
void engine_on_room_load(void (*handler)(void));
void engine_on_room_enter(void (*handler)(void));
void engine_on_room_exit(void (*handler)(void));
const char* engine_get_cur_entry(void);    /* ID de la entrada usada al llegar a la room actual */
int engine_cur_entry_is(const char* id);   /* 1 si la entrada actual coincide con id */

/* Registra un script que se dispara cuando un flag cumple una condicion.
 * op: "is_true" | "is_false" | valor numerico como string.
 * Global y persistente. One-shot: se resetea si la condicion deja de cumplirse. */
void engine_on_flag_change(const char* flag, const char* op, void (*handler)(void));

/* Cancela la salida de la room (solo v?lido en handlers room_exit). */
void engine_block_exit(void);

/* ── Audio ─────────────────────────────────────────────────── */
/* Funciones de audio — declaradas en agemki_audio.h */
#include "agemki_audio.h"

/* ── Diálogos ─────────────────────────────────────────────────────────────── */

/* Ejecuta un árbol de diálogo. Bloqueante hasta que el jugador llega a un nodo fin. */
void engine_run_dialogue(const DialogueNode* nodes, int n, const char* start_node_id);

/* ── Pantalla de Protección ─────────────────────────────────────────────── */
#define PROT_TEXT      0
#define PROT_DIGITS    1
#define PROT_ALPHANUM  2

#define PROT_IMG_NONE   0
#define PROT_IMG_HALVES 1
#define PROT_IMG_SINGLE 2
#define PROT_IMG_TWO    3

#define PROT_BG_BLACK  0
#define PROT_BG_COLOR  1
#define PROT_BG_PCX    2

#define PROT_FAIL_SAME  0
#define PROT_FAIL_NEW   1
#define PROT_FAIL_QUIT  2

typedef struct {
    const char* question;
    const char* pcx_a;
    const char* pcx_b;
    const char* pcx_bg;
    u32  answer_crc;
    u8   input_mode;
    u8   img_mode;
    u8   bg_mode;
    u8   bg_color;
    u8   fail_action;
    u8   max_tries;
} ProtEntry;

/* Pantalla de protección anticopia. Bloqueante hasta que el jugador acierta. */
void engine_protection_screen(const ProtEntry* entries, int count);

/* ?? Timing ???????????????????????????????????????????????????????????????? */

/* Pausa la ejecuci?n ms milisegundos. */
void engine_wait_ms(u32 ms);
/* Escribe una linea en ENGINE.LOG (uso interno de agemki_audio.c) */
void engine_log_write(const char *msg);

/* Devuelve el tiempo en ms desde engine_init(). */
u32  engine_ticks(void);

/* ?? Utilidades internas (para engine_loop) ???????????????????????????????? */

/* Dibuja todos los personajes de la room actual en el back-buffer. */
void engine_render_chars(void);

/* Dibuja todos los objetos de la room actual en el back-buffer. */
void engine_render_objects(void);

/* Dibuja la barra de verbos activa. */
void engine_render_verbset(void);

/* Procesa el input del frame actual. Devuelve 0 si se debe salir. */
int  engine_process_input(void);

/* Ejecuta pathfinding A* desde (sx,sy) hasta (tx,ty) sobre la walkmap actual.
 * Rellena path[] con los waypoints. Devuelve el n?mero de puntos (0=sin ruta). */
int  engine_astar(s16 sx, s16 sy, s16 tx, s16 ty, Point* path, int max_path);

#endif /* AGEMKI_ENGINE_H */
